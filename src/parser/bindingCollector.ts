/**
 * Variable-binding collection and deferred-block resolution pass.
 *
 * Pre-scans a location_block for every assignment (`x = …`, `local x = …`,
 * `setvar 'x', …`, etc.) and populates `LocationSymbols.variableBindings`
 * with a `VariableBinding` entry for each.  In parallel, resolves every
 * `dynamic <var>` / `dyneval(<var>, …)` call site to the set of visible
 * target code-blocks, applying the ambiguity rule.
 */


import type Parser from 'web-tree-sitter';
import type { VariableBinding, SymbolLocation, TypePrefix, CompoundOp, BindingValue } from './symbolTypes';
import type { LocationSymbols } from './locationSymbols';
import { type QspSymbol } from './symbolTypes';
import { isBindingVisibleFrom, findScopeAncestor, findIsolationAncestor } from './scopeUtils';
import {
  SIDE_EFFECT_WRITE_STMTS,
  VAR_DEF_STMT_NAMES,
} from './lookupTables';
import {
  DYNAMIC_STMT_NAMES,
  DYNAMIC_FUNC_NAMES,
  CONTAINER_NODE_TYPES,
  readVarRef,
  nodeLoc,
  getFirstArgNode,
  findDirectString,
  hasInterpolation,
  collapseNewlines,
  countCallArgs,
} from './walkHelpers';
import { lookupArgConstraints, lookupFunctionReturnType } from './builtins';
import { parseVarStringArg } from './variableBindings';
import { isTupleTypedRhs, tupleLiteralOf, subtreeReferencesVariable } from './variableUtils';

/**
 * Internal binding info with parse-tree metadata for the retag pass
 * and virtual-inlining fixpoint.  Stripped before publishing to
 * `variableBindings`.
 */
type BindingInfo = VariableBinding & {
  stmtNode: Parser.SyntaxNode;
  blockNode?: Parser.SyntaxNode;
  fromSideEffect?: boolean;
  /**
   * The assignment statement's *initial* enclosing scope — set once at
   * binding-creation and never mutated.  `scopeNodeId` may later be
   * overwritten by the retag pass to point at a local declaration's
   * scope; `initialScopeNodeId` always reflects where the statement
   * actually sits in the parse tree.  Used by per-call-site multi-local
   * resolution to tell sequential same-scope writes from cross-branch
   * bindings.
   */
  initialScopeNodeId: number;
};

const MAX_BINDING_SNIPPET = 80;
function rhsSnippet(node: Parser.SyntaxNode): string {
  const raw = node.text;
  if (!raw) return '';
  const collapsed = collapseNewlines(raw);
  if (!collapsed) return '';
  if (collapsed.length <= MAX_BINDING_SNIPPET) return collapsed;
  return collapsed.slice(0, MAX_BINDING_SNIPPET - 1) + '…';
}

// ── Main entry point ─────────────────────────────────────────────────

export function collectVariableBindings(
  locBlock: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
  callSiteTargets: Map<number, Parser.SyntaxNode[]>,
  untrackedByNodeId: Map<number, { varName: string; reason: 'multiple-assignments' | 'complex-expression'; loc: SymbolLocation }>,
  /**
   * Seed for the descent-time "in a deferred-execution frame" flag.
   * `true` when this entire `locBlock` is itself a deferred-frame
   * body (synthetic exec-body sub-walker); `false` for normal
   * location walks, where the flag flips on lexically descending
   * into an `act_block`/`act_inline`.
   */
  inDeferredExecution = false,
): void {
  const bindingsByName = new Map<string, BindingInfo[]>();
  const pushBinding = (name: string, info: BindingInfo): void => {
    let arr = bindingsByName.get(name);
    if (!arr) { arr = []; bindingsByName.set(name, arr); }
    arr.push(info);
  };

  type CallSite = {
    stmtNode: Parser.SyntaxNode;
    varLower: string;
    varName: string;
    callLoc: SymbolLocation;
    kind: 'dynamic' | 'dyneval';
    argCount: number;
    /**
     * True iff this call site lexically resides in a deferred-
     * execution frame — either inside an `act_block`/`act_inline`
     * (tracked by descent), or inside the entire body when the
     * collector is invoked with `inDeferredExecution=true` (exec-
     * body sub-walker).  Both run at click time in a fresh frame:
     * the unresolved-bucket routing sends them to
     * {@link LocationSymbols.deferredDynamicVarCalls} so the
     * propagated-locals channel — which models caller-frame
     * dataflow that cannot reach click-time code — does not
     * touch them.
     */
    inDeferred: boolean;
  };
  const callSites: CallSite[] = [];

  const isConsumed = (_id: number): boolean => false;

  const cursor = locBlock.walk();

  // ── record(): convert an assignment pair into a BindingInfo ────
  //
  // Always records `stmtText` (the source line) so hover renders the
  // user's actual code.  The `value` field only carries chain-following
  // metadata (`var-ref` edges, `code-block` dispatch targets); literal
  // numbers / strings / tuples / opaque exprs all collapse to
  // `{kind:'expr'}` since their rendering comes from `stmtText`.
  const record = (
    stmtNode: Parser.SyntaxNode,
    lhs: Parser.SyntaxNode,
    rhs: Parser.SyntaxNode,
    isLocal: boolean,
    compoundOp: CompoundOp | undefined,
    stmtTextOverride?: string,
  ) => {
    const isCompound = compoundOp !== undefined;
    if (lhs.type !== 'variable_ref' && lhs.type !== 'ml_variable_ref') return;
    const lhsRef = readVarRef(lhs);
    if (!lhsRef) return;
    const baseName = lhsRef.name.toLowerCase();
    const writePrefix = ((lhsRef.prefix || '#') as TypePrefix);
    const isIndexedWrite = !!lhs.childForFieldName('index');

    const scopeAnc = findScopeAncestor(stmtNode, locBlock, isConsumed);
    const isolAnc = findIsolationAncestor(stmtNode, locBlock, isConsumed);
    const scopeNodeId = scopeAnc ? scopeAnc.id : 0;
    const isolationAncestorId = isolAnc ? isolAnc.id : 0;

    const inferRhsTypePrefix = (node: Parser.SyntaxNode): TypePrefix | undefined => {
      if (node.type === 'number_literal') {
        return Number.isFinite(Number(node.text)) ? '#' : undefined;
      }
      if (node.type === 'variable_ref' || node.type === 'ml_variable_ref') {
        const ref = readVarRef(node);
        return ref ? ((ref.prefix || '#') as TypePrefix) : undefined;
      }
      if (node.type === 'single_quoted_string' || node.type === 'double_quoted_string'
          || node.type === 'string') return '$';
      // Code blocks are string-typed: `dynamic`/`dyneval` consume them
      // as strings, and `$x = {…}` is the canonical storage form.
      if (node.type === 'code_block') return '$';
      if (node.type === 'bracket_tuple' || node.type === 'tuple') return '%';
      if (node.type === 'na_func_call' || node.type === 'ext_func_call' || node.type === 'ml_func_call') {
        const funcName = (node.childForFieldName('name')?.text ?? '').toLowerCase();
        const fixedReturn = funcName ? lookupFunctionReturnType(funcName) : undefined;
        if (fixedReturn !== undefined) return fixedReturn;
        const callSitePrefix = node.childForFieldName('prefix')?.text as TypePrefix | undefined;
        if (callSitePrefix) return callSitePrefix;
      }
      return undefined;
    };

    // Determine the chain-following value.  Indexed writes and compound
    // ops never establish chain edges; the slot/operator semantics are
    // opaque for propagation purposes.
    let value: BindingValue = { kind: 'expr' };
    let blockNode: Parser.SyntaxNode | undefined;
    if (!isIndexedWrite && !isCompound) {
      if (rhs.type === 'code_block') {
        value = { kind: 'code-block', blockRange: nodeLoc(rhs, docUri) };
        blockNode = rhs;
      } else if ((rhs.type === 'variable_ref' || rhs.type === 'ml_variable_ref')
                 && !rhs.childForFieldName('index')) {
        const rhsRef = readVarRef(rhs);
        if (rhsRef) value = { kind: 'var-ref', varBaseName: rhsRef.name.toLowerCase() };
      } else if (rhs.type === 'na_func_call' || rhs.type === 'ext_func_call' || rhs.type === 'ml_func_call') {
        // Bare function call (no parens, no args): treat as var-ref to
        // the function name so dispatch resolution chains through it.
        // Detect via single-pass scan looking for `paren_args` (which
        // disqualifies) and any non-meta children.
        let hasParen = false;
        let allMeta = true;
        let fnNode: Parser.SyntaxNode | undefined;
        const cc = rhs.childCount;
        for (let i = 0; i < cc; i++) {
          const c = rhs.child(i);
          if (!c) continue;
          if (c.type === 'paren_args') { hasParen = true; break; }
          if (!c.isNamed) continue;
          if (c.type === 'function_name') { fnNode = c; continue; }
          if (c.type === 'type_prefix') continue;
          allMeta = false;
        }
        if (!hasParen && allMeta && fnNode && !fnNode.isMissing) {
          const fnText = fnNode.text.trim();
          if (fnText) {
            const fnLower = fnText.toLowerCase();
            const fixedReturn = lookupFunctionReturnType(fnLower);
            const argInfo = fixedReturn !== undefined ? lookupArgConstraints(fnLower) : undefined;
            // Zero-arg-only built-ins (`rand`, `iif`, …) stay opaque.
            if (!(argInfo !== undefined && argInfo.maxArgs === 0)) {
              value = { kind: 'var-ref', varBaseName: fnLower };
            }
          }
        }
      }
    }

    const info: BindingInfo = {
      value,
      stmtLoc: nodeLoc(stmtNode, docUri),
      stmtText: stmtTextOverride ?? rhsSnippet(stmtNode),
      isLocal, scopeNodeId, isolationAncestorId,
      writePrefix, isValueBearing: true,
      compoundOp,
      rhsTypePrefix: inferRhsTypePrefix(rhs),
      stmtNode, blockNode,
      initialScopeNodeId: scopeNodeId,
    };
    pushBinding(baseName, info);
  };

  const recordDeclarationOnly = (stmtNode: Parser.SyntaxNode, lhs: Parser.SyntaxNode, stmtText: string) => {
    if (lhs.type !== 'variable_ref' && lhs.type !== 'ml_variable_ref') return;
    if (lhs.childForFieldName('index')) return;
    const lhsRef = readVarRef(lhs);
    if (!lhsRef) return;
    const baseName = lhsRef.name.toLowerCase();
    const writePrefix = ((lhsRef.prefix || '#') as TypePrefix);

    const scopeAnc = findScopeAncestor(stmtNode, locBlock, isConsumed);
    const isolAnc = findIsolationAncestor(stmtNode, locBlock, isConsumed);
    const info: BindingInfo = {
      value: { kind: 'expr' },
      stmtLoc: nodeLoc(stmtNode, docUri),
      stmtText,
      isLocal: true, writePrefix, isValueBearing: false,
      scopeNodeId: scopeAnc ? scopeAnc.id : 0,
      isolationAncestorId: isolAnc ? isolAnc.id : 0,
      stmtNode,
      initialScopeNodeId: scopeAnc ? scopeAnc.id : 0,
    };
    pushBinding(baseName, info);
  };

  /**
   * Record an LHS whose RHS slot can't be tied to a single expression:
   *   • opaque unpacks      (`a, b = %f`)
   *   • known tail-slice    (`a, %t = 1, 2, 3` → `%t` collects 2, 3)
   *   • non-`%` tail-slice  (`a, b = 1, 2, 3` → `b` receives the tuple
   *                          `(2, 3)`, triggering the type-mismatch pass)
   *
   * Always opaque (`kind:'expr'`); the `stmtText` is the full statement
   * so hover shows the whole assignment.  Indexed LHS (`a[i], b = %f`)
   * are honoured.  When the caller can statically prove the RHS forms a
   * tuple value (≥2 known elements, or any tail length into a `%`-LHS),
   * pass `rhsTypePrefix='%'` so `typeMismatch` can compare against the
   * LHS prefix; otherwise leave it `undefined` (truly opaque).
   */
  const recordUnpacked = (
    stmtNode: Parser.SyntaxNode,
    lhs: Parser.SyntaxNode,
    stmtText: string,
    isLocal: boolean,
    rhsTypePrefix?: TypePrefix,
    compoundOp?: CompoundOp,
  ) => {
    if (lhs.type !== 'variable_ref' && lhs.type !== 'ml_variable_ref') return;
    const lhsRef = readVarRef(lhs);
    if (!lhsRef) return;
    const baseName = lhsRef.name.toLowerCase();
    const writePrefix = ((lhsRef.prefix || '#') as TypePrefix);

    const scopeAnc = findScopeAncestor(stmtNode, locBlock, isConsumed);
    const isolAnc = findIsolationAncestor(stmtNode, locBlock, isConsumed);
    const info: BindingInfo = {
      value: { kind: 'expr' },
      stmtLoc: nodeLoc(stmtNode, docUri),
      stmtText,
      isLocal,
      scopeNodeId: scopeAnc ? scopeAnc.id : 0,
      isolationAncestorId: isolAnc ? isolAnc.id : 0,
      writePrefix, isValueBearing: true,
      compoundOp,
      rhsTypePrefix,
      stmtNode,
      initialScopeNodeId: scopeAnc ? scopeAnc.id : 0,
    };
    pushBinding(baseName, info);
  };

  const noteCallSite = (node: Parser.SyntaxNode, inDeferred: boolean) => {
    if (!CONTAINER_NODE_TYPES.has(node.type)) return;
    const nameNode = node.childForFieldName('name');
    const stmtName = nameNode?.text.toLowerCase() ?? '';
    if (!DYNAMIC_STMT_NAMES.has(stmtName) && !DYNAMIC_FUNC_NAMES.has(stmtName)) return;
    const firstArg = getFirstArgNode(node);
    const callLoc: SymbolLocation = nodeLoc(node, docUri);
    if (!firstArg) return;
    if (firstArg.type === 'code_block') return;
    if (firstArg.type === 'single_quoted_string' || firstArg.type === 'double_quoted_string'
        || firstArg.type === 'string') return;
    if (firstArg.type !== 'variable_ref' && firstArg.type !== 'ml_variable_ref') {
      untrackedByNodeId.set(node.id, {
        varName: firstArg.text.trim(), reason: 'complex-expression', loc: callLoc,
      });
      return;
    }
    if (firstArg.childForFieldName('index')) {
      untrackedByNodeId.set(node.id, {
        varName: firstArg.text.trim(), reason: 'complex-expression', loc: callLoc,
      });
      return;
    }
    const vRef = readVarRef(firstArg);
    if (!vRef) return;
    const varName = vRef.prefix + vRef.name;
    const kind: 'dynamic' | 'dyneval' = DYNAMIC_FUNC_NAMES.has(stmtName) ? 'dyneval' : 'dynamic';
    const argCount = Math.max(0, countCallArgs(node) - 1);
    callSites.push({
      stmtNode: node, varLower: vRef.name.toLowerCase(), varName, callLoc, kind, argCount, inDeferred,
    });
  };

  const noteSideEffectWrite = (node: Parser.SyntaxNode) => {
    if (!CONTAINER_NODE_TYPES.has(node.type)) return;
    const nameNode = node.childForFieldName('name');
    const stmtName = nameNode?.text.toLowerCase() ?? '';
    if (!SIDE_EFFECT_WRITE_STMTS.has(stmtName)) return;
    // Only treat the name arg as static when arg #0 is *itself* a
    // string literal (or a `string` wrapper directly containing one).
    // Anything else — concatenations like `'q' & '_suf'`, function
    // calls like `$iif(…)`, or variable holders like `$nm` — is a
    // dynamic name that we cannot statically attribute to a binding.
    const firstArg = getFirstArgNode(node);
    const nameStringNode = firstArg ? findDirectString(firstArg) : null;
    if (!nameStringNode) return;
    const rawText = nameStringNode.text;
    const inner = rawText.length >= 2 &&
      (rawText[0] === "'" || rawText[0] === '"' || rawText[0] === '{')
      ? rawText.slice(1, -1) : rawText;
    if (hasInterpolation(nameStringNode)) return;
    const parsed = parseVarStringArg(inner);
    if (!parsed) return;
    const sidePrefix = parsed.prefix;
    const baseName = parsed.base.toLowerCase();
    if (baseName === '') return;

    const scopeAnc = findScopeAncestor(node, locBlock, isConsumed);
    const isolAnc = findIsolationAncestor(node, locBlock, isConsumed);
    const stmtLoc: SymbolLocation = nodeLoc(node, docUri);
    const info: BindingInfo = {
      value: { kind: 'expr' },
      stmtLoc,
      stmtText: rhsSnippet(node),
      isLocal: false, writePrefix: sidePrefix,
      isValueBearing: VAR_DEF_STMT_NAMES.has(stmtName),
      scopeNodeId: scopeAnc ? scopeAnc.id : 0,
      isolationAncestorId: isolAnc ? isolAnc.id : 0,
      stmtNode: node, fromSideEffect: true,
      initialScopeNodeId: scopeAnc ? scopeAnc.id : 0,
    };
    pushBinding(baseName, info);
  };

  // ── Tree walk ──────────────────────────────────────────────────
  // `inDeferred` tracks lexical containment in a deferred-execution
  // frame during descent so call sites can be tagged at creation
  // time — strictly cheaper than a per-call-site parent walk would
  // be.  Seeded from `inDeferredExecution` (true when the entire
  // location body is itself a deferred frame, e.g. an exec-body
  // sub-walker invocation); flips on descending into `act_block` /
  // `act_inline`.
  const visit = (inDeferred: boolean) => {
    const n = cursor.currentNode;
    if (n.type === 'assignment_statement' || n.type === 'local_statement') {
      const isLocalStmt = n.type === 'local_statement';
      const total = n.namedChildCount;
      // Single pass: locate variable_list, collect post-list RHS nodes,
      // and capture the (at most one) assignment_operator's compound op.
      // Caches each child wrapper exactly once to avoid the multi-pass
      // re-wrapping cost of repeated `namedChild(i)` calls.
      let varListNode: Parser.SyntaxNode | null = null;
      let compoundOp: CompoundOp | undefined;
      const rhsArr: Parser.SyntaxNode[] = [];
      for (let i = 0; i < total; i++) {
        const c = n.namedChild(i);
        if (!c) continue;
        if (varListNode === null) {
          if (c.type === 'variable_list') varListNode = c;
          continue;
        }
        if (c.type === 'assignment_operator') {
          if (!isLocalStmt && c.text !== '=') compoundOp = c.text as CompoundOp;
          continue;
        }
        rhsArr.push(c);
      }
      if (varListNode) {
        // Collect var refs from the variable_list.  The grammar
        // guarantees only variable_ref children, but we filter to
        // stay robust against parse-error recoveries.
        const vlc = varListNode.namedChildCount;
        const vars: Parser.SyntaxNode[] = [];
        for (let i = 0; i < vlc; i++) {
          const v = varListNode.namedChild(i);
          if (v && (v.type === 'variable_ref' || v.type === 'ml_variable_ref')) vars.push(v);
        }
        // ── Multi-LHS assignment semantics ────────────────────────
        //
        // QSP packs all RHS values into a single tuple, then assigns
        // element-wise onto the LHS list — with one twist: the LAST
        // LHS greedily absorbs the entire RHS tail.
        //
        //   `a, b = 1, 2`         → a=1, b=2          (tail len 1, scalar)
        //   `a, b = 1, 2, 3`      → a=1, b=(2,3)      (tail len 2 → tuple)
        //   `a, %t = 1, 2, 3`     → a=1, %t=(2,3)     (same; %-LHS happy)
        //   `a, %t = 1, 2`        → a=1, %t=[2]       (singleton wraps)
        //   `a, %t = 1`           → a=1, %t empty     (no tail → unassigned)
        //   `a, b, c = 1, 2`      → a=1, b=2, c empty (head short → unassigned)
        //   `a, b = ()` / `= []`  → both unassigned   (empty tuple literal)
        //   `a = 1, 2, 3`         → a=(1,2,3)         (single LHS absorbs all)
        //
        // For non-`%` LHS receiving a tail of ≥2 elements, the binding
        // is recorded with `rhsTypePrefix='%'` so `typeMismatch` flags
        // "assignment of a tuple value to a $/# variable".
        //
        // RHS shapes treated as element lists:
        //   • comma list: `1, 2, 3` → 3 elems
        //   • literal tuple: `[1, 2, 3]` / `(1, 2, 3)` → expanded to 3
        //   • opaque %-typed: `%f`, `arrpack(…)` → element count unknown
        //     → falls back to every LHS getting an opaque, type-suppressed
        //     binding (no element-wise type checking possible).
        //
        // Compound ops never unpack — they go through plain element-wise
        // zip with no tail synthesis (the grammar normally only allows a
        // single LHS anyway; parse-error recoveries pass through harmlessly).
        const stmtText = rhsSnippet(n);

        let elems: Parser.SyntaxNode[] = rhsArr;
        let opaqueUnpack = false;
        if (!compoundOp && rhsArr.length === 1 && vars.length > 1
            && isTupleTypedRhs(rhsArr[0])) {
          const lit = tupleLiteralOf(rhsArr[0]);
          if (lit) {
            const cnt = lit.namedChildCount;
            elems = [];
            for (let i = 0; i < cnt; i++) {
              const c = lit.namedChild(i);
              if (c) elems.push(c);
            }
          } else {
            opaqueUnpack = true;
          }
        }

        // Self-reference detector for plain-`=` assignments.  Returns
        // `'other'` when `lhs` is a non-local variable whose base name
        // appears in any of `rhsList`'s subtrees — semantically a
        // read-then-write of the same slot (`hp = hp + 5`,
        // `hp = hp, 5`, `a, b = a, 1` → `a = a`).  Locals are excluded:
        // `local x = x` keeps its chain-edge var-ref binding.  Indexed
        // LHS (`arr[0] = arr[0] + 1`) is currently out of scope —
        // `record` collapses indexed writes to opaque `{kind:'expr'}`
        // regardless of `compoundOp`.
        const detectSelfRef = (
          lhs: Parser.SyntaxNode,
          rhsList: readonly Parser.SyntaxNode[],
        ): CompoundOp | undefined => {
          if (isLocalStmt) return undefined;
          const lhsName = readVarRef(lhs)?.name.toLowerCase();
          if (!lhsName) return undefined;
          for (const e of rhsList) {
            if (subtreeReferencesVariable(e, lhsName)) return 'other';
          }
          return undefined;
        };

        if (compoundOp) {
          // Compound op (`+=`, etc.) — element-wise zip, no tail.
          const n2 = Math.min(vars.length, elems.length);
          for (let i = 0; i < n2; i++) {
            record(n, vars[i], elems[i], isLocalStmt, compoundOp, stmtText);
          }
        } else if (opaqueUnpack) {
          // Opaque %-typed single RHS: element count unknown — every
          // LHS gets an opaque binding, no rhsTypePrefix.
          for (let i = 0; i < vars.length; i++) {
            recordUnpacked(n, vars[i], stmtText, isLocalStmt);
          }
        } else if (vars.length === 1 && elems.length >= 1) {
          // Single LHS absorbs the entire RHS.  Self-referential plain-
          // `=` (`hp = hp + 5`, `hp = hp, 5`, `$s = ucase($s)`) is
          // tagged compound op `'other'` so static analysis treats it
          // the same as `hp += …`: not a definition, not a proper read,
          // but still value-bearing at runtime for hover.
          //
          // Bare `local x` (elems.length === 0) is intentionally NOT
          // handled here — it falls through to the tail-absorption
          // branch so `recordDeclarationOnly` preserves the non-value-
          // bearing semantics.
          const opForThis = detectSelfRef(vars[0], elems);
          if (elems.length === 1) {
            // Single RHS expression — preserve `inferRhsTypePrefix`
            // handling (var-ref chain edges, tuple-literal `%`, …).
            record(n, vars[0], elems[0], isLocalStmt, opForThis, stmtText);
          } else {
            // Multi-RHS tuple (`hp = hp, 5`) — opaque from a chain-
            // following standpoint.  When not self-referential, tag
            // with `rhsTypePrefix='%'` so `typeMismatch` flags
            // scalar←tuple; when self-referential, suppress that tag
            // (read-then-write semantics dominate, mirroring how
            // `hp += …` doesn't carry a tuple type either).
            recordUnpacked(n, vars[0], stmtText, isLocalStmt,
                           opForThis ? undefined : '%', opForThis);
          }
        } else if (vars.length > 0) {
          // Multi-LHS tail-absorption (`a, b = 1, 2, 3` → b = (2,3)).
          // Per-element self-ref detection: `a, b = a, 1` records
          // `a = a` as compound `'other'` and `b = 1` as a normal
          // definition.  Swaps (`a, b = b, a`) are not self-ref under
          // positional zip and remain definitions.
          const lastIdx = vars.length - 1;
          for (let i = 0; i < lastIdx; i++) {
            if (i < elems.length) {
              record(n, vars[i], elems[i], isLocalStmt,
                     detectSelfRef(vars[i], [elems[i]]), stmtText);
            } else if (isLocalStmt) {
              recordDeclarationOnly(n, vars[i], stmtText);
            }
          }
          const lastV = vars[lastIdx];
          const lastPrefix = lastV.childForFieldName('prefix')?.text;
          const tailLen = elems.length - lastIdx;
          if (tailLen <= 0) {
            // Empty tail — `c` in `a, b, c = 1, 2`, or any LHS when RHS
            // is `()` / `[]`.  Locally surfaces as declaration-only so
            // `uninitializedVariables` can flag reads; non-local writes
            // produce no binding entry (current behaviour preserved).
            if (isLocalStmt) recordDeclarationOnly(n, lastV, stmtText);
          } else if (tailLen === 1 && lastPrefix !== '%') {
            // Singleton tail into a scalar LHS — plain element zip.
            record(n, lastV, elems[lastIdx], isLocalStmt,
                   detectSelfRef(lastV, [elems[lastIdx]]), stmtText);
          } else {
            // ≥2-element tail OR any tail into a `%` LHS — the RHS
            // value is a tuple.  Self-ref against any tail element
            // (`a, b = 1, b, 2`) is still read-then-write of `b`,
            // so tag `'other'` and drop the tuple type tag (mirroring
            // the single-LHS multi-RHS case).
            const opForLast = detectSelfRef(lastV, elems.slice(lastIdx));
            recordUnpacked(n, lastV, stmtText, isLocalStmt,
                           opForLast ? undefined : '%', opForLast);
          }
        }
      }
    }
    noteCallSite(n, inDeferred);
    noteSideEffectWrite(n);
    if (cursor.gotoFirstChild()) {
      const childInDeferred = inDeferred || n.type === 'act_block' || n.type === 'act_inline';
      do { visit(childInDeferred); } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  };
  if (cursor.gotoFirstChild()) {
    do { visit(inDeferredExecution); } while (cursor.gotoNextSibling());
    cursor.gotoParent();
  }
  cursor.delete();

  // ── Retag pass: non-local binds → local scope ──────────────────
  const retagPass = () => {
    for (const bindings of bindingsByName.values()) {
      let anyNonLocal = false, anyLocalDecl = false;
      for (const b of bindings) {
        if (!b.isLocal) anyNonLocal = true;
        else if (!b.fromSideEffect) anyLocalDecl = true;
        if (anyNonLocal && anyLocalDecl) break;
      }
      if (!anyNonLocal || !anyLocalDecl) continue;

      for (const b of bindings) {
        if (b.isLocal) continue;
        for (const cand of bindings) {
          if (cand === b) continue;
          if (!cand.isLocal || cand.fromSideEffect) continue;
          if (cand.stmtNode.startIndex > b.stmtNode.startIndex) continue;
          if (!isBindingVisibleFrom(
            b.stmtNode, locBlock,
            cand.scopeNodeId, cand.isolationAncestorId,
            /*bindIsLocal*/ true, isConsumed,
          )) continue;
          b.isLocal = true;
          b.scopeNodeId = cand.scopeNodeId;
          b.isolationAncestorId = cand.isolationAncestorId;
          break;
        }
      }
    }
  };
  retagPass();

  // ── Per-call-site resolution ───────────────────────────────────
  for (const cs of callSites) {
    const visited = new Set<string>([cs.varLower]);
    const queue: string[] = [cs.varLower];
    const blocks: Array<{ block: Parser.SyntaxNode; isLocal: boolean; initialScopeNodeId: number }> = [];

    while (queue.length > 0) {
      const name = queue.shift()!;
      const bindings = bindingsByName.get(name);
      if (!bindings) continue;
      for (const b of bindings) {
        if (!isBindingVisibleFrom(
          cs.stmtNode, locBlock,
          b.scopeNodeId, b.isolationAncestorId, b.isLocal, isConsumed,
        )) continue;
        if (b.value.kind === 'code-block' && b.blockNode) {
          blocks.push({ block: b.blockNode, isLocal: b.isLocal, initialScopeNodeId: b.initialScopeNodeId });
        } else if (b.value.kind === 'var-ref') {
          const next = b.value.varBaseName;
          if (!visited.has(next)) { visited.add(next); queue.push(next); }
        }
      }
    }

    if (blocks.length === 0) {
      // Var-mediated calls in a deferred-execution frame run at
      // click-time in a fresh frame — see {@link LocationSymbols.
      // deferredDynamicVarCalls} for the full rationale.  Route them
      // there so the aggregator's cross-loc pass treats them with
      // global-only lookup, bypassing the propagated-locals channel
      // (which models frame-mediated dataflow that cannot reach
      // click-time code).  `cs.inDeferred` is set during descent
      // for `act_block`/`act_inline` ancestors, or seeded for the
      // whole body when the collector runs as an exec-body sub-
      // walker.
      const bucket = cs.inDeferred
        ? locSymbols.deferredDynamicVarCalls
        : locSymbols.unresolvedDynamicVarCalls;
      bucket.push({
        loc: cs.callLoc,
        varName: cs.varName,
        varBaseName: cs.varLower,
        kind: cs.kind,
        argCount: cs.argCount,
      });
      continue;
    }
    if (blocks.length === 1) {
      callSiteTargets.set(cs.stmtNode.id, [blocks[0].block]);
      continue;
    }
    const seen = new Set<number>();
    const uniq: typeof blocks = [];
    for (const e of blocks) {
      if (seen.has(e.block.id)) continue;
      seen.add(e.block.id);
      uniq.push(e);
    }
    if (uniq.length === 1) {
      callSiteTargets.set(cs.stmtNode.id, [uniq[0].block]);
      continue;
    }
    // Local shadows global.  By QSP frame semantics, once a `local
    // $x` declaration is in scope at the call site, every read of
    // `$x` refers to the frame-local — any prior or concurrent
    // global binding for `$x` is invisible.  When mixed candidates
    // reach this point (the retag pass converted post-decl globals
    // to locals; only pre-decl or otherwise-unreachable globals
    // remain), drop the non-locals so dispatch resolves to the
    // local(s).  After this filter `uniq` is either fully local or
    // fully non-local.
    const hasLocal = uniq.some(e => e.isLocal);
    const hasGlobal = uniq.some(e => !e.isLocal);
    let allLocal = hasLocal && !hasGlobal;
    if (hasLocal && hasGlobal) {
      const localsOnly = uniq.filter(e => e.isLocal);
      if (localsOnly.length === 1) {
        callSiteTargets.set(cs.stmtNode.id, [localsOnly[0].block]);
        continue;
      }
      uniq.length = 0;
      for (const e of localsOnly) uniq.push(e);
      allLocal = true;
    }
    if (allLocal) {
      // Multiple distinct local code-block writes.  Two cases:
      //
      //   • Same initial scope — sequential writes to one local symbol
      //     (e.g. `local $c = {…}` then `$c = {…}`).  Runtime uses
      //     last-write-wins; there is no call-path ambiguity.  Track
      //     all blocks (so each body is still analysed); emit no
      //     diagnostic.
      //
      //   • Different initial scopes — bindings live in distinct
      //     branches (e.g. if/else).  The runtime target genuinely
      //     depends on which branch ran: emit `multiple-local-bindings`.
      //
      // We use each binding's `initialScopeNodeId` (cached at creation
      // time, never mutated by the retag pass) — the local
      // declaration's own scope, copied by retag into `scopeNodeId`,
      // would conflate sequential writes with cross-branch ones.
      const firstScope = uniq[0].initialScopeNodeId;
      const sameScope = uniq.every(e => e.initialScopeNodeId === firstScope);
      callSiteTargets.set(cs.stmtNode.id, uniq.map(e => e.block));
      if (!sameScope) {
        locSymbols.untrackedDynamicVarCalls.push({
          loc: cs.callLoc, varName: cs.varName,
          reason: 'multiple-local-bindings',
        });
      }
    } else {
      // ≥2 distinct global assignments — the runtime target depends
      // on which assignment last executed.  Track every candidate so
      // per-target diagnostics (`missingResultInFunctionCall`,
      // `extraArgsToTargetWithoutArgs`) can apply universal-
      // quantification logic, AND emit the `multiple-assignments`
      // info so the user knows the dispatch wasn't statically uniqued.
      callSiteTargets.set(cs.stmtNode.id, uniq.map(e => e.block));
      locSymbols.untrackedDynamicVarCalls.push({
        loc: cs.callLoc, varName: cs.varName,
        reason: 'multiple-assignments',
      });
    }
  }

  // ── Capture code-block body writes ─────────────────────────────
  {
    for (const bindings of bindingsByName.values()) {
      for (const cb of bindings) {
        if (cb.value.kind !== 'code-block' || !cb.blockNode) continue;
        const blockId = cb.blockNode.id;
        const writes: Array<{ varBaseName: string; binding: VariableBinding }> = [];
        for (const [otherName, otherBindings] of bindingsByName) {
          for (const ob of otherBindings) {
            if (ob === cb) continue;
            let p: Parser.SyntaxNode | null = ob.stmtNode.parent;
            let inside = false;
            while (p) {
              if (p.id === blockId) { inside = true; break; }
              if (p.id === locBlock.id) break;
              p = p.parent;
            }
            if (!inside) continue;
            writes.push({ varBaseName: otherName, binding: { value: ob.value, stmtLoc: ob.stmtLoc, stmtText: ob.stmtText, isLocal: ob.isLocal, writePrefix: ob.writePrefix, isValueBearing: ob.isValueBearing, compoundOp: ob.compoundOp, scopeNodeId: ob.scopeNodeId, isolationAncestorId: ob.isolationAncestorId } });
          }
        }
        if (writes.length > 0) cb.value = { ...cb.value, bodyWrites: writes };
      }
    }
  }

  // ── Virtual inlining fixpoint ──────────────────────────────────
  {
    const deferredIds = new Set<number>();
    for (const targets of callSiteTargets.values()) {
      for (const t of targets) deferredIds.add(t.id);
    }

    if (deferredIds.size > 0) {
      type CSInfo = { stmtNode: Parser.SyntaxNode; scopeNodeId: number; isolationAncestorId: number };
      const blockCallSites = new Map<number, CSInfo[]>();
      for (const cs of callSites) {
        const targets = callSiteTargets.get(cs.stmtNode.id);
        if (!targets || targets.length === 0) continue;
        const scopeAnc = findScopeAncestor(cs.stmtNode, locBlock, isConsumed);
        const isolAnc = findIsolationAncestor(cs.stmtNode, locBlock, isConsumed);
        const info: CSInfo = { stmtNode: cs.stmtNode, scopeNodeId: scopeAnc ? scopeAnc.id : 0, isolationAncestorId: isolAnc ? isolAnc.id : 0 };
        for (const t of targets) {
          let arr = blockCallSites.get(t.id);
          if (!arr) { arr = []; blockCallSites.set(t.id, arr); }
          arr.push(info);
        }
      }

      const findEnclosingDeferred = (node: Parser.SyntaxNode): Parser.SyntaxNode | null => {
        let a: Parser.SyntaxNode | null = node.parent;
        while (a && a.id !== locBlock.id) {
          if (a.type === 'code_block' && deferredIds.has(a.id)) return a;
          a = a.parent;
        }
        return null;
      };

      let changed = true, guard = 0;
      while (changed && guard++ < 16) {
        changed = false;
        for (const [name, bindings] of bindingsByName) {
          const toAdd: BindingInfo[] = [];
          const toRemove = new Set<BindingInfo>();
          for (const b of bindings) {
            const enclosing = findEnclosingDeferred(b.stmtNode);
            if (!enclosing) continue;
            const css = blockCallSites.get(enclosing.id);
            if (!css || css.length === 0) continue;
            toRemove.add(b);
            for (const cs of css) {
              toAdd.push({ ...b, stmtNode: cs.stmtNode, scopeNodeId: cs.scopeNodeId, isolationAncestorId: cs.isolationAncestorId });
            }
          }
          if (toRemove.size > 0 || toAdd.length > 0) {
            bindingsByName.set(name, bindings.filter(b => !toRemove.has(b)).concat(toAdd));
            changed = true;
          }
        }
      }
    }
  }

  // Second retag pass.
  retagPass();

  // ── Commit to persistent store ─────────────────────────────────
  for (const [key, bindings] of bindingsByName) {
    const published: VariableBinding[] = bindings.map(b => ({
      value: b.value, stmtLoc: b.stmtLoc, stmtText: b.stmtText, isLocal: b.isLocal,
      writePrefix: b.writePrefix, isValueBearing: b.isValueBearing,
      compoundOp: b.compoundOp, scopeNodeId: b.scopeNodeId,
      isolationAncestorId: b.isolationAncestorId, rhsTypePrefix: b.rhsTypePrefix,
    }));
    locSymbols.variableBindings.set(key, published);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Deferred-block bookkeeping
// ──────────────────────────────────────────────────────────────────────

/**
 * Walk the call-site → resolved-targets map produced by the
 * binding-collection pass and derive the deferred-block bookkeeping:
 *
 *   • `deferredCodeBlocks` — set of block node ids the main walker
 *     must skip.
 *   • `blockInboundLocals` — pre-seeded entries for every target block.
 *   • `blockCallers` — for topological deferred-walk order, each
 *     target block records its enclosing deferred-block callers.
 */
export function collectDeferredBlocks(
  callSiteTargets: Map<number, Parser.SyntaxNode[]>,
  callSiteNodes: Map<number, Parser.SyntaxNode>,
  deferredCodeBlocks: Set<number>,
  blockInboundLocals: Map<number, { node: Parser.SyntaxNode; locals: Map<string, QspSymbol> }>,
  blockCallers: Map<number, Set<number>>,
): void {
  if (callSiteTargets.size === 0) return;

  const deferredIds = new Set<number>();
  for (const targets of callSiteTargets.values()) {
    for (const t of targets) deferredIds.add(t.id);
  }

  const findEnclosingDeferred = (node: Parser.SyntaxNode): number => {
    let p: Parser.SyntaxNode | null = node.parent;
    while (p) {
      if (p.type === 'code_block' && deferredIds.has(p.id)) return p.id;
      p = p.parent;
    }
    return 0;
  };

  for (const [stmtId, targets] of callSiteTargets) {
    const stmtNode = callSiteNodes.get(stmtId);
    if (!stmtNode) continue;
    const callerId = findEnclosingDeferred(stmtNode);
    for (const blockNode of targets) {
      deferredCodeBlocks.add(blockNode.id);
      if (!blockInboundLocals.has(blockNode.id)) {
        blockInboundLocals.set(blockNode.id, { node: blockNode, locals: new Map() });
      }
      let callers = blockCallers.get(blockNode.id);
      if (!callers) { callers = new Set(); blockCallers.set(blockNode.id, callers); }
      callers.add(callerId);
    }
  }
}
