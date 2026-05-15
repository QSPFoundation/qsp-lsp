/**
 * Embedded `exec:` link scanner.
 *
 * QSP games render strings as HTML when `usehtml=1`.  Links of the
 * form `<a href="exec:CODE">…</a>` cause `CODE` to run as QSP at click
 * time, in the player's current call frame — so they behave like
 * deferred `act` bodies: scope-isolating, with no inbound local
 * propagation from the host string's location.
 *
 * For each renderable string in the tree we:
 *   1. Regex-extract `<a href="exec:BODY">` anchor bodies.
 *   2. Decode the host string's doubled-quote escapes.
 *   3. Sub-parse each BODY as QSP source via `parseFn` (wrapped in a
 *      throw-away `# __exec__ … ---` location header/footer).
 *   4. Run the standard {@link walkLocationBody} extractor on the
 *      sub-tree's synthetic location_block, into a fresh
 *      {@link LocationSymbols}.
 *   5. Merge the resulting variables, labels, refs, action defs, and
 *      warnings into the host `LocationSymbols`, rewriting every
 *      `SymbolLocation` to point at the host string node and grafting
 *      sub-scope locals into a fresh isolated scope of the host.
 *
 * Because step 4 uses the same extractor that runs on top-level
 * location bodies, the embedded code gets:
 *   • full variable tracking (definitions, reads, type prefixes),
 *   • location refs (`gs`, `gt`, `func`, `desc`, `@`, `@@`, …),
 *   • object refs / definitions (`addobj`, `delobj`, `modobj`, `obj`),
 *   • action refs / definitions (`act`, `delact`),
 *   • label / jump tracking,
 *   • all the lint warnings (prefix mismatch, arg-count, deprecation),
 * and every existing diagnostic pass (unused-vars, unresolved refs,
 * etc.) fires on it automatically because the symbols land in the
 * host's `LocationSymbols`.
 *
 * Positions for every merged entry are collapsed to the host string's
 * source span — precise enough for find-references and diagnostic
 * squiggles without the complexity of a per-character offset map from
 * the decoded body back to source coordinates.
 *
 * Strings in identifier positions (location names, file paths, var
 * names, etc.) are skipped — they never reach the HTML renderer.
 */

import type Parser from 'web-tree-sitter';
import type { DocumentSymbols } from './symbolTable';
import { hasStructuralErrors } from './extractErrors';
import { LocationSymbols } from './locationSymbols';
import type { SymbolLocation } from './symbolTypes';
import { walkLocationBody } from './symbolWalker';
import { nodeLoc } from './walkHelpers';

// ── Skip table: strings that never reach the HTML renderer ────────────

/** Calls where ALL string args are identifiers/paths/images. */
const SKIP_ALL_ARGS = new Set<string>([
  'modobj', 'mod obj',
  'addobj', 'add obj',
  'delobj', 'del obj',
  'resetobj',
  'delact', 'del act',
]);

/** Call names whose first string arg is a location/path/var identifier. */
const SKIP_ARG0 = new Set<string>([
  // Location refs
  'goto', 'gt', 'xgoto', 'xgt', 'gosub', 'gs', 'jump',
  // Path refs
  'play', 'close', 'view', 'opengame', 'savegame', 'openqst',
  'inclib', 'addqst',
  // Variable-name refs
  'setvar', 'killvar', 'sortarr', 'scanstr', 'unpackarr', 'menu',
  // Dynamic-code arg (handled by the dynamic-block pass)
  'dynamic',
]);

/** Function names whose first arg is a location/var-name identifier. */
const SKIP_ARG0_FN = new Set<string>([
  // Location-ref functions
  'func', 'desc', 'loc', 'isplay',
  // Variable-name functions
  'arrsize', 'arrtype', 'arritem', 'arrpack', 'arrpos', 'arrcomp',
  // Dynamic-code arg
  'dyneval',
]);

/** Calls where both arg0 AND arg1 are var-name identifiers. */
const SKIP_ARG0_AND_ARG1 = new Set<string>(['copyarr']);

/** Regex-pattern arg index by function name. */
const REGEX_PATTERN_ARG: ReadonlyMap<string, number> = new Map([
  ['strcomp', 1], ['strfind', 1], ['strpos', 1], ['arrcomp', 1], ['scanstr', 2],
]);

// ── HTML anchor scanning ─────────────────────────────────────────────

/** Cheap case-insensitive probe for `exec:` substring. */
const EXEC_PROBE_RE = /exec:/i;

/**
 * Match `<a ...href="exec:CODE"...>` (or single-quoted attribute).
 * `(?:[^>]*?\s)?` requires whitespace before `href` so that custom
 * attributes like `data-href` aren't misidentified.
 */
const EXEC_LINK_RE =
  /<a\s(?:[^>]*?\s)?href\s*=\s*(["'])\s*exec:([\s\S]*?)\1[^>]*>/gi;

/** Wrap an exec body so it parses as the body of a location. */
const WRAPPER_PREFIX = '# __exec__\n';
const WRAPPER_SUFFIX = '\n---\n';

/** Synthetic location name used for the throw-away sub-extraction. */
const SUB_LOC_NAME = '__exec__';

// ── Classifier ────────────────────────────────────────────────────────

/**
 * Returns true when `s` sits in a position where its text is never
 * HTML-rendered — e.g. as an action/object name, a location-ref
 * argument, a file path, or an array subscript.
 */
export function isIdentifierStringContext(s: Parser.SyntaxNode): boolean {
  let owner: Parser.SyntaxNode | null = s.parent;
  if (owner && owner.type === 'string') owner = owner.parent;
  if (!owner) return false;

  const argHolder = owner;
  if (owner.type === 'paren_args') owner = owner.parent;
  if (!owner) return false;

  if (argHolder.type === 'array_index' || owner.type === 'array_index') return true;

  if (owner.type === 'act_block' || owner.type === 'act_inline'
      || owner.type === 'act_statement') {
    return true;
  }

  const nameLower = getCallNameLower(owner);
  if (!nameLower) return false;

  if (SKIP_ALL_ARGS.has(nameLower)) return true;

  const argIdx = positionalArgIndex(argHolder, s);
  if (argIdx < 0) return false;

  if (argIdx === 0) {
    if (SKIP_ARG0.has(nameLower)) return true;
    if (SKIP_ARG0_FN.has(nameLower)) return true;
    if (SKIP_ARG0_AND_ARG1.has(nameLower)) return true;
  }
  if (argIdx === 1 && SKIP_ARG0_AND_ARG1.has(nameLower)) return true;

  if (REGEX_PATTERN_ARG.get(nameLower) === argIdx) return true;

  return false;
}

function getCallNameLower(owner: Parser.SyntaxNode): string | null {
  switch (owner.type) {
    case 'statement':
    case 'na_func_call':
    case 'ext_func_call':
    case 'ml_func_call':
    case 'user_call_statement':
    case 'user_func_call':
    case 'ml_user_func_call': {
      const n = owner.childForFieldName('name');
      return n ? n.text.toLowerCase() : null;
    }
    default:
      return null;
  }
}

function positionalArgIndex(
  argHolder: Parser.SyntaxNode,
  target: Parser.SyntaxNode,
): number {
  if (argHolder.type === 'paren_args') {
    const n = argHolder.namedChildCount;
    for (let i = 0; i < n; i++) {
      const c = argHolder.namedChild(i);
      if (c && (c.id === target.id || c.id === target.parent?.id)) return i;
    }
    return -1;
  }

  const n = argHolder.namedChildCount;
  let argIdx = 0;
  for (let i = 0; i < n; i++) {
    const c = argHolder.namedChild(i);
    if (!c) continue;
    if (isHeaderField(c.type)) continue;
    if (c.id === target.id || c.id === target.parent?.id) return argIdx;
    argIdx++;
  }
  return -1;
}

function isHeaderField(type: string): boolean {
  return type === 'statement_name' || type === 'function_name'
      || type === 'type_prefix' || type === 'user_name';
}

// ── Public entry point ────────────────────────────────────────────────

/**
 * Scan every renderable string literal in `tree` for embedded `exec:`
 * hyperlinks and merge their fully-extracted symbols into the matching
 * host `LocationSymbols`.
 *
 * `parseFn` is used to sub-parse each link body as QSP source.  When
 * omitted, the pass is a no-op.
 *
 * Locations listed in `reusedLocations` are skipped because their
 * embedded refs were already extracted and shifted by `extractSymbols`.
 */
export function extractEmbeddedExec(
  tree: Parser.Tree,
  docUri: string,
  symbols: DocumentSymbols,
  parseFn?: (text: string) => Parser.Tree | null,
  reusedLocations?: ReadonlySet<string>,
): void {
  if (!parseFn) return;

  const root = tree.rootNode;
  const rootCount = root.namedChildCount;
  for (let i = 0; i < rootCount; i++) {
    const locBlock = root.namedChild(i);
    if (!locBlock || locBlock.type !== 'location_block') continue;

    const header = findNamedChildOfType(locBlock, 'location_header');
    if (!header) continue;
    const nameNode = findNamedChildOfType(header, 'location_name');
    if (!nameNode) continue;

    const locName = nameNode.text.trim();
    if (reusedLocations?.has(locName.toLowerCase())) continue;

    const locSymbols = symbols.getLocation(locName);
    if (!locSymbols) continue;

    processLocation(locBlock, locSymbols, docUri, parseFn);
  }
}

function processLocation(
  locBlock: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
  parseFn: (text: string) => Parser.Tree | null,
): void {
  const cursor = locBlock.walk();
  try {
    visit(cursor);
  } finally {
    cursor.delete();
  }

  function visit(c: Parser.TreeCursor): void {
    const n = c.currentNode;
    if (n.type === 'single_quoted_string' || n.type === 'double_quoted_string') {
      processString(n, locSymbols, docUri, parseFn);
      return; // don't descend into string content
    }
    if (c.gotoFirstChild()) {
      do { visit(c); } while (c.gotoNextSibling());
      c.gotoParent();
    }
  }
}

function processString(
  s: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
  parseFn: (text: string) => Parser.Tree | null,
): void {
  const raw = s.text;
  if (raw.length < 2 || !EXEC_PROBE_RE.test(raw)) return;
  if (isIdentifierStringContext(s)) return;

  const hostQuote = raw[0];
  if (hostQuote !== "'" && hostQuote !== '"') return;

  // Decode the host string's doubled-quote escapes once.  We don't map
  // positions back to source: every merged ref/var uses the host
  // string's span, which is precise enough for LSP find-references
  // and diagnostics.
  const decoded = unescapeStringBody(raw, hostQuote);
  const hostLoc = nodeLoc(s, docUri);

  EXEC_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXEC_LINK_RE.exec(decoded)) !== null) {
    const body = m[2];
    if (body) subParseAndMerge(body, hostLoc, locSymbols, docUri, parseFn);
  }
}

/** Strip outer quotes and collapse doubled-quote escapes (`''`→`'` or `""`→`"`). */
function unescapeStringBody(raw: string, quote: string): string {
  const inner = raw.slice(1, -1);
  return inner.includes(quote + quote)
    ? inner.split(quote + quote).join(quote)
    : inner;
}

function subParseAndMerge(
  body: string,
  hostLoc: SymbolLocation,
  hostSyms: LocationSymbols,
  docUri: string,
  parseFn: (text: string) => Parser.Tree | null,
): void {
  const wrapped = WRAPPER_PREFIX + body + WRAPPER_SUFFIX;
  const subTree = parseFn(wrapped);
  if (!subTree) return;
  try {
    const subLocBlock = findNamedChildOfType(subTree.rootNode, 'location_block');
    if (!subLocBlock) return;

    // Skip bodies that fail to parse cleanly: a partial parse would
    // emit garbage refs / variables.  The user simply gets no
    // exec-body diagnostics for that link until they fix the syntax.
    if (hasStructuralErrors(subLocBlock)) return;

    // Run the standard extractor against the wrapped body so the
    // embedded code gets the same symbol tracking that top-level
    // location bodies receive.
    const subSyms = new LocationSymbols(SUB_LOC_NAME);
    walkLocationBody(subLocBlock, subSyms, docUri, /*inDeferredExecution*/ true);

    mergeIntoHost(subSyms, hostSyms, hostLoc);
  } finally {
    subTree.delete();
  }
}

// ── Merge sub-extracted LocationSymbols into the host ────────────────

/**
 * Graft everything walkLocationBody produced for the exec body into
 * the host's LocationSymbols.  Every position is collapsed to the
 * host string's span; locals are placed in a fresh isolated scope so
 * they neither shadow nor inherit from the host's locals.
 */
function mergeIntoHost(
  sub: LocationSymbols,
  host: LocationSymbols,
  hostLoc: SymbolLocation,
): void {
  const execScope = allocateExecScope(host);

  // ── Variables ──
  //
  // Replay every reference through host.addVariable so that all the
  // bookkeeping (ownedVariables, localNames, prefixes, hasValueDefinition)
  // happens uniformly.  Locals are pinned to `execScope`; non-locals
  // share host's top scope (they ARE the same globals at runtime).
  for (const sym of sub.ownedVariables) {
    const prefixes: string[] = sym.prefixes && sym.prefixes.size > 0
      ? [...sym.prefixes] : [''];
    let prefixIdx = 0;
    for (const subRef of sym.references) {
      const isDef = subRef.isDefinition === true;
      const loc: SymbolLocation = { ...hostLoc };
      if (isDef) loc.isDefinition = true;
      // Rotate prefixes across refs so host.addVariable accumulates
      // every prefix the sub-symbol observed.  Lossy at the per-ref
      // level (we don't know which ref used which prefix), but the
      // diagnostic that cares — `mixedVariablePrefixes` — operates on
      // the aggregate Set, which is preserved.
      const prefix = prefixes[prefixIdx % prefixes.length];
      prefixIdx++;
      host.addVariable(
        sym.name,
        loc,
        sym.isLocal,
        isDef,
        prefix,
        sym.isLocal ? execScope : 0,
        sym.hasValueDefinition,
      );
    }
  }

  // ── Location refs (gs/gt/func/desc/@/@@/jump-loc) ──
  for (const [, sym] of sub.locationRefs) {
    for (const subRef of sym.references) {
      const loc: SymbolLocation = { ...hostLoc };
      if (subRef.callType) loc.callType = subRef.callType;
      if (subRef.callText) loc.callText = subRef.callText;
      if (subRef.argCount !== undefined) loc.argCount = subRef.argCount;
      host.addLocationRef(sym.name, loc);
    }
  }

  // ── Object refs (addobj/delobj/modobj/resetobj/obj) ──
  //
  // `sym.definition` (if any) points at the SymbolLocation instance
  // inside `sym.references` that was the addobj/modobj site.  Identity
  // comparison lets us tag the right ref as a def in the host.
  for (const [, sym] of sub.objectRefs) {
    const defLoc = sym.definition;
    for (const subRef of sym.references) {
      const isDef = defLoc !== undefined && subRef === defLoc;
      host.addObjectRef(sym.name, { ...hostLoc }, isDef);
    }
  }

  // ── Action refs (delact) ──
  for (const [, sym] of sub.actionRefs) {
    for (let i = 0; i < sym.references.length; i++) {
      host.addActionRef(sym.name, { ...hostLoc });
    }
  }

  // ── Action defs (act blocks declared inside an exec body) ──
  for (const action of sub.actions) {
    host.addAction(action.name, { ...hostLoc });
  }

  // ── Labels & label-refs (confined to the exec body's own ns) ──
  //
  // Use the exec scope id as the namespace key.  All sub-namespaces
  // collapse into one — acceptable since (a) exec bodies are short,
  // (b) the diagnostics-relevant case is unresolved-jump within the
  // body, which the collapsed bucket still detects when neither side
  // declares the label.
  for (const lbl of sub.allLabelSymbols()) {
    for (let i = 0; i < lbl.references.length; i++) {
      host.addLabel(lbl.name, { ...hostLoc }, execScope);
    }
  }
  for (const lblRef of sub.allLabelRefSymbols()) {
    for (let i = 0; i < lblRef.references.length; i++) {
      host.addLabelRef(lblRef.name, { ...hostLoc }, execScope);
    }
  }

  // ── Lint warnings ──
  for (const w of sub.prefixWarnings) {
    host.prefixWarnings.push({ ...w, loc: { ...hostLoc } });
  }
  for (const w of sub.argCountWarnings) {
    host.argCountWarnings.push({ ...w, loc: { ...hostLoc } });
  }
  for (const w of sub.deprecationWarnings) {
    host.deprecationWarnings.push({ ...w, loc: { ...hostLoc } });
  }

  // ── Dynamic / dyneval call sites (powers checkMissingResult* and
  // checkExtraArgsToTargetWithoutArgs for blocks inside an exec body).
  //
  // We do NOT propagate `dynamicCodeBlocks`: that map is keyed by
  // tree-sitter node id and is consumed only inside `walkLocationBody`
  // (to decide a code_block's variable-scope isolation).  The sub-walk
  // already consumed its own entries before we got here, and the
  // sub-tree's nodes are about to be freed by `subTree.delete()`.
  for (const d of sub.resolvedDynamicBlocks) {
    host.resolvedDynamicBlocks.push({
      kind: d.kind,
      callLoc: { ...hostLoc },
      // Use a single hostLoc for every block target; the diagnostic
      // only uses these to test `isInsideRange` against args refs,
      // and those refs were also rewritten to hostLoc above — so they
      // still register as "inside" the block.
      blockLocs: d.blockLocs.map(() => ({ ...hostLoc })),
      argCount: d.argCount,
    });
  }
  for (const d of sub.dynamicVarCalls) {
    host.dynamicVarCalls.push({
      loc: { ...hostLoc },
      varName: d.varName,
      varBaseName: d.varBaseName,
      localNames: [...d.localNames],
    });
  }
  for (const d of sub.untrackedDynamicVarCalls) {
    host.untrackedDynamicVarCalls.push({ ...d, loc: { ...hostLoc } });
  }

  // ── Deferred-frame dynamic var calls ──
  //
  // The sub-walker was invoked with `inDeferredExecution=true`, so
  // every var-mediated call whose first arg failed intra-body
  // resolution has already been routed to `sub.deferredDynamicVarCalls`
  // (this includes act-inside-exec — an `act` block nested in an
  // exec body — whose dispatches are themselves deferred and were
  // previously dropped at merge time).  Forward the bucket verbatim.
  //
  // `sub.unresolvedDynamicVarCalls` stays empty in this mode and
  // requires no handling.
  for (const d of sub.deferredDynamicVarCalls) {
    host.deferredDynamicVarCalls.push({ ...d, loc: { ...hostLoc } });
  }

  // ── Variable bindings (writes that target globals) ──
  //
  // `$code = { … }` inside an exec body assigns to the global at
  // runtime (the exec frame sees the same globals as the host), so
  // cross-location dispatch must see those bindings.  Local bindings
  // are dropped — exec body locals live in the player's call frame
  // for that click and don't survive outside it.
  //
  // Positions are collapsed to hostLoc (lossy but find-references and
  // diagnostics on globals only need a single anchor inside the host
  // string).  `scopeNodeId` / `isolationAncestorId` are sub-tree node
  // ids that no longer match any node in the host's tree; this is
  // harmless because the consumers (`aggregation.findCodeBlockDefs`,
  // hover) iterate bindings by base name, not by node id.
  for (const [key, bindings] of sub.variableBindings) {
    const globals = bindings.filter(b => !b.isLocal);
    if (globals.length === 0) continue;
    const rewritten = globals.map(b => rewriteBindingToHostLoc(b, hostLoc));
    const existing = host.variableBindings.get(key);
    if (existing) existing.push(...rewritten);
    else host.variableBindings.set(key, rewritten);
  }
}

/**
 * Re-anchor a {@link VariableBinding} to `hostLoc`, recursively for
 * code-block bodyWrites.  Sub-tree positions are discarded — the
 * binding is reported as occurring at the host string's span.
 */
function rewriteBindingToHostLoc(
  b: import('./symbolTypes').VariableBinding,
  hostLoc: SymbolLocation,
): import('./symbolTypes').VariableBinding {
  const rewritten: import('./symbolTypes').VariableBinding = {
    ...b,
    stmtLoc: { ...hostLoc },
  };
  if (b.value.kind === 'code-block') {
    rewritten.value = {
      kind: 'code-block',
      blockRange: { ...hostLoc },
      bodyWrites: b.value.bodyWrites
        ? b.value.bodyWrites.map(w => ({
            varBaseName: w.varBaseName,
            binding: rewriteBindingToHostLoc(w.binding, hostLoc),
          }))
        : undefined,
    };
  }
  return rewritten;
}

/**
 * Reserve a fresh isolated scope inside `host`'s scope tree to hold
 * the exec body's locals.  Marked isolated so the body's `local x`
 * neither inherits from nor leaks into the host's enclosing scopes.
 */
function allocateExecScope(host: LocationSymbols): number {
  let nextId = 1;
  for (const s of host.scopeParent.keys()) {
    if (s >= nextId) nextId = s + 1;
  }
  host.scopeParent.set(nextId, 0);
  host.isolatedScopes.add(nextId);
  return nextId;
}

function findNamedChildOfType(
  node: Parser.SyntaxNode,
  type: string,
): Parser.SyntaxNode | null {
  const n = node.namedChildCount;
  for (let i = 0; i < n; i++) {
    const c = node.namedChild(i);
    if (c && c.type === type) return c;
  }
  return null;
}
