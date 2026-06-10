/**
 * Shared infrastructure for sub-parsing QSP source fragments that
 * live INSIDE other syntactic forms — currently used by:
 *   • `embeddedExec.ts` — `<a href="exec:CODE">` HTML link bodies.
 *   • `embeddedInterpolation.ts` — `<<…>>` interpolation bodies whose
 *     inline parse is corrupted by doubled-quote escapes.
 *
 * Both passes share the same shape:
 *   1. Locate a fragment of QSP source embedded inside a host string
 *      (or interpolation).
 *   2. Decode the host's doubled-quote escapes via {@link decodeDoubledQuotes}.
 *   3. Wrap the fragment so it parses as a top-level location body and
 *      sub-parse it.
 *   4. Run the standard {@link walkLocationBody} extractor on the
 *      sub-tree's synthetic location_block.
 *   5. Project every sub-tree position back to source coordinates via
 *      a {@link LocTranslator} and merge the results into the host's
 *      `LocationSymbols` via {@link mergeIntoHost}.
 *
 * This module owns the position-translation + merge machinery; the
 * caller modules own the scanning/wrapping logic specific to their
 * embedding form.
 */

import type Parser from 'web-tree-sitter';
import { extractErrors } from './extractErrors';
import { LocationSymbols } from './locationSymbols';
import { makeOffsetProjector, bodyLineStarts } from './embeddedReparse';
import type { SymbolLocation, VariableBinding } from './symbolTypes';

// ── Position translation ─────────────────────────────────────────────

/** Translator: sub-tree position → source `SymbolLocation`. */
export type LocTranslator = (subRef: SymbolLocation) => SymbolLocation;

/**
 * Build a position translator for a single sub-parsed body.  Returns
 * a closure that maps a sub-tree `SymbolLocation` to a source
 * `SymbolLocation`.
 *
 * Parameters:
 *   • `hostNode`         — AST node whose `startPosition` anchors the
 *                          host inner text.
 *   • `decodedInner`     — the FULL decoded host *inner* text (for
 *                          interpolations this equals the body; for
 *                          exec it is the whole decoded string, of
 *                          which the body is a `decodedBodyStart`
 *                          slice).
 *   • `decodedBodyStart` — offset of the body within `decodedInner`.
 *                          0 when the caller passes just the body.
 *   • `bodyLen`          — decoded length of the body.
 *   • `extra`            — `decoded → raw` shift map (indexes
 *                          `decodedInner`).
 *   • `hostLoc`          — full host-node loc, used as a defensive
 *                          fallback for sub positions outside the body
 *                          (e.g. the synthetic `_r_=(` wrapper bytes).
 *   • `hostPrefixLen`    — bytes between `hostNode.startPosition` and
 *                          the FIRST character of the host *inner*
 *                          text (1 for `'…'` / `"…"`, 2 for `<<…>>`).
 *   • `subBodyCol`       — column in the WRAPPED sub-tree where the
 *                          body begins on its FIRST row (0 for exec
 *                          wrappers; `'_r_=('.length` for the
 *                          interpolation wrapper).  Continuation rows
 *                          always start at column 0.
 *
 * Multi-line bodies (and multi-line host strings) are projected
 * precisely: newlines are never part of a doubled-quote escape, so the
 * decoded newline count drives the source row and the column resets per
 * line.  See {@link makeOffsetProjector}.
 */
export function makeTranslator(
  hostNode: Parser.SyntaxNode,
  decodedInner: string,
  decodedBodyStart: number,
  bodyLen: number,
  extra: Int32Array | null,
  hostLoc: SymbolLocation,
  hostPrefixLen: number,
  subBodyCol: number,
): LocTranslator {
  const hostStart = hostNode.startPosition;
  const project = makeOffsetProjector(
    decodedInner, extra, hostStart.row, hostStart.column + hostPrefixLen,
  );
  const lineStarts = bodyLineStarts(decodedInner, decodedBodyStart, bodyLen);
  const bodyEnd = decodedBodyStart + bodyLen;

  // Map a wrapped sub-tree position to a decoded-inner offset, or `-1`
  // when it falls outside the body (wrapper scaffolding / bad row).
  const toDecodedOffset = (subRow: number, subCol: number): number => {
    const bodyLine = subRow - 1;
    if (bodyLine < 0 || bodyLine >= lineStarts.length) return -1;
    const col = subCol - (bodyLine === 0 ? subBodyCol : 0);
    if (col < 0) return -1;
    const d = decodedBodyStart + lineStarts[bodyLine] + col;
    return d > bodyEnd ? -1 : d;
  };

  return (subRef) => {
    const dStart = toDecodedOffset(subRef.line, subRef.column);
    const dEnd = toDecodedOffset(subRef.endLine, subRef.endColumn);
    if (dStart < 0 || dEnd < 0) {
      return mergeRefMetadata(subRef, hostLoc);
    }
    const s = project(dStart);
    const e = project(dEnd);
    const out: SymbolLocation = {
      uri: hostLoc.uri,
      line: s.row,
      column: s.column,
      endLine: e.row,
      endColumn: e.column,
    };
    return mergeRefMetadata(subRef, out);
  };
}

/** Copy ref-level metadata (callType / argCount / isDefinition /
 *  isProperUsage / argsConsumer / argsIndex) from `subRef` onto
 *  `target`.  Scope-related fields (`scopeId`, `localsInScope`) are
 *  deliberately NOT propagated — `mergeIntoHost` re-pins scope via
 *  `host.addVariable(..., scopeOverride)` and `localsInScope` is
 *  rebuilt per host context. */
function mergeRefMetadata(
  subRef: SymbolLocation,
  target: SymbolLocation,
): SymbolLocation {
  const out: SymbolLocation = { ...target };
  if (subRef.callType) out.callType = subRef.callType;
  if (subRef.callText) out.callText = subRef.callText;
  if (subRef.argCount !== undefined) out.argCount = subRef.argCount;
  if (subRef.isDefinition) out.isDefinition = subRef.isDefinition;
  if (subRef.isProperUsage) out.isProperUsage = subRef.isProperUsage;
  if (subRef.argsConsumer) out.argsConsumer = subRef.argsConsumer;
  if (subRef.argsIndex !== undefined) out.argsIndex = subRef.argsIndex;
  return out;
}

// ── Doubled-quote decoding ───────────────────────────────────────────

// `decodeDoubledQuotes` lives in the dependency-free `embeddedReparse`
// leaf so `extractErrors` can share it without a circular import.
// Re-exported here so existing importers (`embeddedExec`,
// `embeddedInterpolation`) keep their import sites unchanged.
export { decodeDoubledQuotes } from './embeddedReparse';

// ── Error forwarding ─────────────────────────────────────────────────

/**
 * Translate every {@link SyntaxError} in the sub-tree back into host
 * source coordinates and push it onto `hostSyms.embeddedExecErrors`.
 *
 * Sub-tree positions are in the wrapped body's coordinate space —
 * every wrapper used by callers in this module prefixes the body
 * with a single header line (`# __exec__\n` or `# __intp__\n_r_=(`)
 * so the body always starts at row 1.  We only translate errors
 * that land inside the body proper (row >= 1).  Errors outside that
 * range (e.g. from the synthetic wrapper) are dropped.
 */
export function collectEmbeddedErrors(
  subTree: Parser.Tree,
  translate: LocTranslator,
  hostLoc: SymbolLocation,
  hostSyms: LocationSymbols,
): void {
  const errs = extractErrors(subTree);
  if (errs.length === 0) return;
  // Body rows in the wrapped tree start at 1 (after the synthetic
  // wrapper's header line).  Drop errors that land in the wrapper.
  for (const e of errs) {
    if (e.startRow < 1) continue;
    const m = translate({
      uri: hostLoc.uri,
      line: e.startRow,
      column: e.startCol,
      endLine: e.endRow,
      endColumn: e.endCol,
    });
    hostSyms.embeddedExecErrors.push({
      startRow: m.line,
      startCol: m.column,
      endRow: m.endLine,
      endCol: m.endColumn,
      message: e.message,
      inCodeBlock: e.inCodeBlock,
      inInterpolation: e.inInterpolation,
    });
  }
}

// ── Merge sub-extracted LocationSymbols into the host ────────────────

/**
 * For every named sub-symbol, invoke `add(sym, ref)` on each of its
 * references.  Pure — kept at module scope so `mergeIntoHost` doesn't
 * pay a per-call closure allocation.
 */
function forwardRefs<S extends { name: string; references: readonly SymbolLocation[] }>(
  syms: Iterable<S>,
  add: (sym: S, subRef: SymbolLocation) => void,
): void {
  for (const sym of syms) for (const subRef of sym.references) add(sym, subRef);
}

/**
 * Graft everything walkLocationBody produced for the embedded body
 * into the host's LocationSymbols.  Every position passes through
 * `translate(subRef)` so diagnostics anchor on precise sub-statements
 * inside the host string.  By default locals are placed in a fresh
 * isolated scope so they neither shadow nor inherit from the host's
 * locals (correct semantics for `exec:` bodies — they run in a fresh
 * call frame); callers that want refs to resolve against the host's
 * lexical scope chain (the interpolation pass) pass `varScopeOverride`.
 */
export function mergeIntoHost(
  sub: LocationSymbols,
  host: LocationSymbols,
  translate: LocTranslator,
  allocScope: () => number,
  /**
   * Optional set of variable base names to drop during the variable
   * merge.  Used by the interpolation pass to filter out the synthetic
   * `_r_` LHS that the assignment-style wrapper adds.
   */
  skipVarNames?: ReadonlySet<string>,
  /**
   * Optional override for the scope assigned to every variable ref
   * merged from `sub`.  When provided:
   *   • replaces `execScope`  for refs the sub-walker marked LOCAL
   *   • replaces `0` (top)   for refs the sub-walker marked NON-LOCAL
   * Used by the interpolation pass so refs inside `<<f(''a'', $local)>>`
   * resolve against the HOST's scope chain (act / loop / if locals),
   * matching the inline-parse path for non-doubled-quote interpolations.
   *
   * `undefined` keeps the default exec semantics: locals → execScope,
   * non-locals → location top (scope 0).
   */
  varScopeOverride?: number,
): void {
  const execScope = allocScope();
  const localVarScope = varScopeOverride ?? execScope;
  const nonLocalVarScope = varScopeOverride ?? 0;

  // ── Variables ──
  //
  // Replay every reference through host.addVariable so that all the
  // bookkeeping (ownedVariables, localNames, prefixes, hasValueDefinition)
  // happens uniformly.  Locals are pinned to `localVarScope`; non-locals
  // pinned to `nonLocalVarScope` (see param doc above).
  for (const sym of sub.ownedVariables) {
    if (skipVarNames?.has(sym.name)) continue;
    const prefixes: string[] = sym.prefixes && sym.prefixes.size > 0
      ? [...sym.prefixes] : [''];
    let prefixIdx = 0;
    for (const subRef of sym.references) {
      const isDef = subRef.isDefinition === true;
      const loc = translate(subRef);
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
        sym.isLocal ? localVarScope : nonLocalVarScope,
        sym.hasValueDefinition,
      );
    }
  }

  // ── Location refs (gs/gt/func/desc/@/@@/jump-loc) ──
  //
  // The next five passes share a shape — walk every named symbol,
  // re-emit each `SymbolLocation` via the host's add* method — handled
  // by the module-scope {@link forwardRefs} helper.  Per-kind
  // variation (isDef tagging, label namespace) stays explicit in the
  // call-site lambda.
  forwardRefs(sub.locationRefs.values(), (sym, r) => host.addLocationRef(sym.name, translate(r)));

  // ── Object refs (addobj/delobj/modobj/resetobj/obj) ──
  //
  // `sym.definition` (if any) points at the SymbolLocation instance
  // inside `sym.references` that was the addobj/modobj site.  Identity
  // comparison lets us tag the right ref as a def in the host.
  forwardRefs(sub.objectRefs.values(), (sym, r) =>
    host.addObjectRef(sym.name, translate(r), sym.definition !== undefined && r === sym.definition),
  );

  // ── Action refs (delact) ──
  forwardRefs(sub.actionRefs.values(), (sym, r) => host.addActionRef(sym.name, translate(r)));

  // ── Action defs (act blocks declared inside an embedded body) ──
  for (const action of sub.actions) {
    host.addAction(action.name, translate(action.definition!));
  }

  // ── Labels & label-refs (confined to the embedded body's own ns) ──
  //
  // Use the freshly-allocated scope id as the namespace key.  All
  // sub-namespaces collapse into one — acceptable since (a) embedded
  // bodies are short, (b) the diagnostics-relevant case is
  // unresolved-jump within the body, which the collapsed bucket
  // still detects when neither side declares the label.
  forwardRefs(sub.allLabelSymbols(),    (sym, r) => host.addLabel(sym.name, translate(r), execScope));
  forwardRefs(sub.allLabelRefSymbols(), (sym, r) => host.addLabelRef(sym.name, translate(r), execScope));

  // ── Lint warnings & diagnostic locations ──
  //
  // Every entry that carries a single `loc: SymbolLocation` (prefix /
  // arg-count / deprecation warnings) is translated through the same
  // projection.  `unreachableLabels` is a plain SymbolLocation[] so it
  // gets the bare translate() call.  Keeping these merges together
  // makes it obvious which diagnostic-bearing fields are forwarded
  // from the sub-walk; new ones added to LocationSymbols should be
  // wired in here as well.
  const mergeWithLoc = <T extends { loc: SymbolLocation }>(
    src: readonly T[], dst: T[],
  ): void => {
    for (const w of src) dst.push({ ...w, loc: translate(w.loc) });
  };
  mergeWithLoc(sub.prefixWarnings,      host.prefixWarnings);
  mergeWithLoc(sub.argCountWarnings,    host.argCountWarnings);
  mergeWithLoc(sub.deprecationWarnings, host.deprecationWarnings);
  for (const loc of sub.unreachableLabels) {
    host.unreachableLabels.push(translate(loc));
  }

  // ── Dynamic / dyneval call sites (powers checkMissingResult* and
  // checkExtraArgsToTargetWithoutArgs for blocks inside an embedded
  // body).
  //
  // We do NOT propagate `dynamicCodeBlocks`: that map is keyed by
  // tree-sitter node id and is consumed only inside `walkLocationBody`
  // (to decide a code_block's variable-scope isolation).  The sub-walk
  // already consumed its own entries before we got here, and the
  // sub-tree's nodes are about to be freed by `subTree.delete()`.
  //
  // Every `loc`/`callLoc`/`blockLocs` goes through `translate()` so
  // diagnostics and hovers anchor on the precise sub-statement inside
  // the host string rather than the full string span.  Multi-line
  // bodies/hosts fall back to the host span via the translator itself.
  for (const d of sub.resolvedDynamicBlocks) {
    host.resolvedDynamicBlocks.push({
      kind: d.kind,
      callLoc: translate(d.callLoc),
      blockLocs: d.blockLocs.map(translate),
      argCount: d.argCount,
    });
  }
  for (const d of sub.dynamicVarCalls) {
    host.dynamicVarCalls.push({
      loc: translate(d.loc),
      varName: d.varName,
      varBaseName: d.varBaseName,
      localNames: [...d.localNames],
    });
  }
  mergeWithLoc(sub.untrackedDynamicVarCalls, host.untrackedDynamicVarCalls);

  // ── Deferred-frame dynamic var calls ──
  //
  // The exec-body sub-walker is invoked with `inDeferredExecution=true`,
  // so every var-mediated call whose first arg failed intra-body
  // resolution has already been routed to `sub.deferredDynamicVarCalls`
  // (this includes act-inside-exec — an `act` block nested in an
  // embedded body — whose dispatches are themselves deferred and were
  // previously dropped at merge time).  Forward the bucket verbatim.
  // For the interpolation pass the sub-walker runs without that flag
  // and this bucket is empty — the loop is then a no-op.
  //
  // `sub.unresolvedDynamicVarCalls` stays empty in deferred mode and
  // requires no handling.
  mergeWithLoc(sub.deferredDynamicVarCalls, host.deferredDynamicVarCalls);

  // ── Variable bindings (writes that target globals) ──
  //
  // `$code = { … }` inside an embedded body assigns to the global at
  // runtime (the embedded frame sees the same globals as the host),
  // so cross-location dispatch must see those bindings.  Local
  // bindings are dropped — embedded-body locals don't survive outside
  // the embedded execution context.
  //
  // Sub-tree positions are projected through `translate()` so
  // single-line bodies get precise per-statement ranges (e.g. the
  // type-mismatch diagnostic underlines just the offending `$x = 34`
  // rather than the whole host string).  Multi-line bodies/hosts fall
  // back to the host span via the translator's own fallback.
  // `scopeNodeId` / `isolationAncestorId` are sub-tree node ids that
  // no longer match any node in the host's tree; this is harmless
  // because the consumers (`aggregation.findCodeBlockDefs`, hover)
  // iterate bindings by base name, not by node id.
  for (const [key, bindings] of sub.variableBindings) {
    if (skipVarNames?.has(key)) continue;
    const globals = bindings.filter(b => !b.isLocal);
    if (globals.length === 0) continue;
    const rewritten = globals.map(b => rewriteBindingLoc(b, translate));
    const existing = host.variableBindings.get(key);
    if (existing) existing.push(...rewritten);
    else host.variableBindings.set(key, rewritten);
  }
}

/**
 * Re-anchor a {@link VariableBinding} from sub-tree coordinates to
 * source coordinates via `translate`, recursively for code-block
 * `bodyWrites`.  Multi-line bodies fall back to the host string's
 * span (handled inside the translator itself).
 */
function rewriteBindingLoc(
  b: VariableBinding,
  translate: LocTranslator,
): VariableBinding {
  const rewritten: VariableBinding = {
    ...b,
    stmtLoc: translate(b.stmtLoc),
  };
  if (b.value.kind === 'code-block') {
    rewritten.value = {
      kind: 'code-block',
      blockRange: translate(b.value.blockRange),
      bodyWrites: b.value.bodyWrites
        ? b.value.bodyWrites.map(w => ({
            varBaseName: w.varBaseName,
            binding: rewriteBindingLoc(w.binding, translate),
          }))
        : undefined,
    };
  }
  return rewritten;
}

// ── Misc helpers ─────────────────────────────────────────────────────

/**
 * Per-host scope allocator factory.  Computes the next-free scope id
 * ONCE per host location, then bumps a local counter — avoiding the
 * quadratic cost of scanning `scopeParent.keys()` on every embedded
 * sub-parse.
 */
export function makeScopeAllocator(host: LocationSymbols): () => number {
  let maxScope = 0;
  for (const s of host.scopeParent.keys()) {
    if (s > maxScope) maxScope = s;
  }
  return () => {
    const id = ++maxScope;
    host.scopeParent.set(id, 0);
    host.isolatedScopes.add(id);
    return id;
  };
}

/** Return the first named child of `node` with the given type, or `null`. */
export function findNamedChildOfType(
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
