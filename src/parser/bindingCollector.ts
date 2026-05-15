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
import type { VariableBinding, SymbolLocation, TypePrefix, CompoundOp } from './symbolTypes';
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
  getNthArgNode,
  findDirectString,
  hasInterpolation,
  collapseNewlines,
  countCallArgs,
} from './walkHelpers';
import { lookupArgConstraints, lookupFunctionReturnType } from './builtins';
import { parseVarStringArg } from './variableBindings';

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
function rhsSnippet(node: Parser.SyntaxNode): string | undefined {
  const raw = node.text;
  if (!raw) return undefined;
  const collapsed = collapseNewlines(raw);
  if (!collapsed) return undefined;
  if (collapsed.length <= MAX_BINDING_SNIPPET) return collapsed;
  return collapsed.slice(0, MAX_BINDING_SNIPPET - 1) + '…';
}

/**
 * Extract the inner index expression(s) from an `array_index` node
 * (e.g. `[test]` → `'test'`, `[1, 2]` → `'1, 2'`, `[]` → `''`).
 * Line breaks are collapsed to single spaces (spaces/tabs preserved
 * verbatim) and the result is capped at `MAX_INDEX_SNIPPET` (50)
 * chars.  Always returns a string (possibly empty) for present-but-
 * empty `[]`.
 */
const MAX_INDEX_SNIPPET = 50;
function indexSnippet(indexNode: Parser.SyntaxNode): string {
  const raw = indexNode.text;
  // Strip surrounding brackets and collapse line breaks.
  const inner = collapseNewlines(raw.replace(/^\[|\]$/g, ''));
  if (inner.length <= MAX_INDEX_SNIPPET) return inner;
  return inner.slice(0, MAX_INDEX_SNIPPET - 1) + '…';
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
  const record = (
    stmtNode: Parser.SyntaxNode,
    lhs: Parser.SyntaxNode,
    rhs: Parser.SyntaxNode,
    isLocal: boolean,
    compoundOp: CompoundOp | undefined,
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

    const stmtLoc: SymbolLocation = nodeLoc(stmtNode, docUri);

    const push = (value: VariableBinding['value'], blockNode?: Parser.SyntaxNode, rhsTypePrefix?: TypePrefix) => {
      const info: BindingInfo = {
        value, stmtLoc, isLocal, scopeNodeId, isolationAncestorId,
        writePrefix, isValueBearing: true,
        writeOp: compoundOp, stmtNode, blockNode, rhsTypePrefix,
        initialScopeNodeId: scopeNodeId,
      };
      pushBinding(baseName, info);
    };

    const inferRhsTypePrefix = (node: Parser.SyntaxNode): TypePrefix | undefined => {
      if (node.type === 'number_literal') {
        return Number.isFinite(Number(node.text)) ? '#' : undefined;
      }
      // Variable-ref RHS (indexed or plain): the prefix written at the
      // call site determines the type lens through which the read
      // happens, so it's the value's effective type at this assignment.
      if (node.type === 'variable_ref' || node.type === 'ml_variable_ref') {
        const ref = readVarRef(node);
        return ref ? ((ref.prefix || '#') as TypePrefix) : undefined;
      }
      let strNode: Parser.SyntaxNode | null = null;
      if (node.type === 'single_quoted_string' || node.type === 'double_quoted_string') {
        strNode = node;
      } else if (node.type === 'string') {
        const child = node.namedChild(0);
        if (child && (child.type === 'single_quoted_string' || child.type === 'double_quoted_string')) strNode = child;
      }
      if (strNode) return '$';
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

    if (isIndexedWrite) {
      const indexNode = lhs.childForFieldName('index');
      // Indexed writes record `rhsTypePrefix` so the type-mismatch
      // diagnostic catches `$arr[i] = #x`-style errors; the binding
      // value itself stays opaque (we don't propagate slot values).
      const info: BindingInfo = {
        value: { kind: 'other', text: rhsSnippet(rhs) },
        stmtLoc, isLocal, scopeNodeId, isolationAncestorId,
        writePrefix, isValueBearing: true, stmtNode,
        initialScopeNodeId: scopeNodeId,
        indexText: indexNode ? indexSnippet(indexNode) : undefined,
        rhsTypePrefix: inferRhsTypePrefix(rhs),
        writeOp: compoundOp,
      };
      pushBinding(baseName, info);
      return;
    }

    if (isCompound) {
      push({ kind: 'other', text: rhsSnippet(rhs) }, undefined, inferRhsTypePrefix(rhs));
      return;
    }

    if (rhs.type === 'code_block') {
      // Code blocks are stringly-typed at the type-checker level
      // (`dynamic`/`dyneval` consume them as strings, and `$x = {…}`
      // is the canonical pattern for storing deferred code).  Tag
      // them with `$` so `i = {x+1}` / `%t = {…}` get flagged.
      push({ kind: 'code-block', blockRange: nodeLoc(rhs, docUri) }, rhs, '$');
      return;
    }

    if (rhs.type === 'number_literal') {
      const n = Number(rhs.text);
      push(
        Number.isFinite(n) ? { kind: 'number', value: n } : { kind: 'other', text: rhsSnippet(rhs) },
        undefined, Number.isFinite(n) ? '#' : undefined,
      );
      return;
    }

    if ((rhs.type === 'variable_ref' || rhs.type === 'ml_variable_ref') && !rhs.childForFieldName('index')) {
      const rhsRef = readVarRef(rhs);
      if (rhsRef) {
        const rp = ((rhsRef.prefix || '#') as TypePrefix);
        push(
          { kind: 'var-ref', varBaseName: rhsRef.name.toLowerCase(), readPrefix: rp },
          undefined, rp,
        );
      } else {
        push({ kind: 'other', text: rhsSnippet(rhs) });
      }
      return;
    }

    if (rhs.type === 'na_func_call' || rhs.type === 'ext_func_call' || rhs.type === 'ml_func_call') {
      // Detect the "bare function call without parens and without args"
      // pattern (`x = func` rather than `x = func(...)`) in a single
      // pass: scan all children once, looking for paren_args (which
      // disqualifies) and capturing function_name / type_prefix; reject
      // if any other named child is present.
      let hasParen = false;
      let allMeta = true;
      let fnNode: Parser.SyntaxNode | undefined;
      let fnPrefixNode: Parser.SyntaxNode | undefined;
      const cc = rhs.childCount;
      for (let i = 0; i < cc; i++) {
        const c = rhs.child(i);
        if (!c) continue;
        if (c.type === 'paren_args') { hasParen = true; break; }
        if (!c.isNamed) continue;
        if (c.type === 'function_name') { fnNode = c; continue; }
        if (c.type === 'type_prefix') { fnPrefixNode = c; continue; }
        allMeta = false;
      }
      if (!hasParen && allMeta) {
        const fnPrefix = ((fnPrefixNode?.text || '#') as TypePrefix);
        if (fnNode && !fnNode.isMissing) {
          const fnText = fnNode.text.trim();
          if (fnText) {
            const fnLower = fnText.toLowerCase();
            const fixedReturn = lookupFunctionReturnType(fnLower);
            const argInfo = fixedReturn !== undefined ? lookupArgConstraints(fnLower) : undefined;
            const isZeroArgOnly = argInfo !== undefined && argInfo.maxArgs === 0;
            if (isZeroArgOnly) {
              push({ kind: 'other', text: fnLower }, undefined, fixedReturn);
            } else {
              push(
                { kind: 'var-ref', varBaseName: fnLower, readPrefix: fnPrefix },
                undefined, fixedReturn !== undefined ? fixedReturn : fnPrefix,
              );
            }
          } else {
            push({ kind: 'other', text: rhsSnippet(rhs) });
          }
        } else {
          push({ kind: 'other', text: rhsSnippet(rhs) });
        }
        return;
      }
    }

    let strNode: Parser.SyntaxNode | null = null;
    if (rhs.type === 'single_quoted_string' || rhs.type === 'double_quoted_string') {
      strNode = rhs;
    } else if (rhs.type === 'string') {
      const child = rhs.namedChild(0);
      if (child && (child.type === 'single_quoted_string' || child.type === 'double_quoted_string')) {
        strNode = child;
      }
    }
    if (strNode && !hasInterpolation(strNode)) {
      const text = strNode.text;
      push({ kind: 'string', value: text.length >= 2 ? text.slice(1, -1) : text }, undefined, '$');
    } else if (strNode) {
      push({ kind: 'other', text: rhsSnippet(rhs) }, undefined, '$');
    } else {
      // Catch-all: defer to the shared inference so indexed reads
      // (`b[0]`), tuples, and function calls all contribute a prefix.
      push({ kind: 'other', text: rhsSnippet(rhs) }, undefined, inferRhsTypePrefix(rhs));
    }
  };

  const recordDeclarationOnly = (stmtNode: Parser.SyntaxNode, lhs: Parser.SyntaxNode) => {
    if (lhs.type !== 'variable_ref' && lhs.type !== 'ml_variable_ref') return;
    if (lhs.childForFieldName('index')) return;
    const lhsRef = readVarRef(lhs);
    if (!lhsRef) return;
    const baseName = lhsRef.name.toLowerCase();
    const writePrefix = ((lhsRef.prefix || '#') as TypePrefix);

    const scopeAnc = findScopeAncestor(stmtNode, locBlock, isConsumed);
    const isolAnc = findIsolationAncestor(stmtNode, locBlock, isConsumed);
    const stmtLoc: SymbolLocation = nodeLoc(stmtNode, docUri);
    const info: BindingInfo = {
      value: { kind: 'other' },
      stmtLoc, isLocal: true, writePrefix, isValueBearing: false,
      scopeNodeId: scopeAnc ? scopeAnc.id : 0,
      isolationAncestorId: isolAnc ? isolAnc.id : 0,
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

    // `setvar 'name', value, index` — capture the third positional arg
    // text as the index slot being written, mirroring how direct
    // indexed assignment (`name[index] = value`) records `indexText`.
    let indexText: string | undefined;
    let valueText: string | undefined;
    if (stmtName === 'setvar') {
      const idxNode = getNthArgNode(node, 2);
      if (idxNode) {
        const raw = collapseNewlines(idxNode.text);
        if (raw) indexText = raw.length <= MAX_INDEX_SNIPPET
          ? raw
          : raw.slice(0, MAX_INDEX_SNIPPET - 1) + '…';
      }
      // Capture arg #1 (the value) so hovers can render
      // `#name[idx] = value *(set by setvar)*`, mirroring how plain
      // assignments display their RHS.
      const valNode = getNthArgNode(node, 1);
      if (valNode) valueText = rhsSnippet(valNode);
    }

    const scopeAnc = findScopeAncestor(node, locBlock, isConsumed);
    const isolAnc = findIsolationAncestor(node, locBlock, isConsumed);
    const stmtLoc: SymbolLocation = nodeLoc(node, docUri);
    const info: BindingInfo = {
      value: { kind: 'other', text: valueText },
      stmtLoc, isLocal: false, writePrefix: sidePrefix,
      isValueBearing: VAR_DEF_STMT_NAMES.has(stmtName),
      writeOp: VAR_DEF_STMT_NAMES.has(stmtName) ? stmtName : undefined,
      scopeNodeId: scopeAnc ? scopeAnc.id : 0,
      isolationAncestorId: isolAnc ? isolAnc.id : 0,
      stmtNode: node, fromSideEffect: true,
      initialScopeNodeId: scopeAnc ? scopeAnc.id : 0,
      indexText,
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
        // Collect var refs from the variable_list without an intermediate Array.
        const vlc = varListNode.namedChildCount;
        const vars: Parser.SyntaxNode[] = [];
        for (let i = 0; i < vlc; i++) {
          const v = varListNode.namedChild(i);
          if (v && (v.type === 'variable_ref' || v.type === 'ml_variable_ref')) vars.push(v);
        }
        const n2 = Math.min(vars.length, rhsArr.length);
        for (let i = 0; i < n2; i++) record(n, vars[i], rhsArr[i], isLocalStmt, compoundOp);
        if (isLocalStmt && vars.length > n2) {
          for (let i = n2; i < vars.length; i++) recordDeclarationOnly(n, vars[i]);
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
            writes.push({ varBaseName: otherName, binding: { value: ob.value, stmtLoc: ob.stmtLoc, isLocal: ob.isLocal, writePrefix: ob.writePrefix, isValueBearing: ob.isValueBearing, writeOp: ob.writeOp, scopeNodeId: ob.scopeNodeId, isolationAncestorId: ob.isolationAncestorId } });
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
      value: b.value, stmtLoc: b.stmtLoc, isLocal: b.isLocal,
      writePrefix: b.writePrefix, isValueBearing: b.isValueBearing,
      writeOp: b.writeOp, scopeNodeId: b.scopeNodeId,
      isolationAncestorId: b.isolationAncestorId, rhsTypePrefix: b.rhsTypePrefix,
      indexText: b.indexText,
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
