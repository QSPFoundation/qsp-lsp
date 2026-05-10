/**
 * Variable-tracking subsystem — public API.
 *
 * This module is the ONLY surface downstream consumers (hover,
 * completion, definition, references, diagnostics, refactorings)
 * should use to ask questions about variables:
 *
 *   • "What was assigned to `foo` at this line?"            → bindings
 *   • "What can `foo` be at this cursor?"                   → values
 *   • "Across the whole project, what globals match `x`?"   → values
 *   • "Through which gs/func/@/@@ chain does this local
 *     get mutated?"                                          → cross-call
 *
 * Storage / extraction internals live in `symbolTable.ts` (per-document
 * data classes) and `extractSymbols.ts` (AST walker).  Both are *consumed*
 * here but never re-exposed; consumers should import from this module.
 *
 * ── Subsystem boundary with the call graph ─────────────────────────
 *
 * The cross-call answers ("a write inside callee K mutates caller-local
 * L"; "the self-shadow `local x = x` reads upstream `x`") need data
 * computed by the **propagation subsystem** in `server/aggregation.ts`.
 *
 * To keep the parser layer free of any reverse dependency on the
 * server layer, the resolver consumes that data through the
 * structural interface `VarResolverCallGraph` declared below.  Any
 * caller that has an aggregates object — currently only
 * `SymbolAggregates`, but tests or future tooling are equally valid —
 * satisfies the interface without further plumbing.
 *
 * ── Data model in one paragraph ────────────────────────────────────
 *
 * In modern QSP a variable has a single underlying value regardless of
 * which type prefix is used to read or write it (`$x`, `#x`, `%x`,
 * and `x` all denote the same variable; the prefix is a type-coercion
 * lens, not a slot selector).  Bindings are therefore stored under
 * the lowercased BASE name with no prefix.  The literal prefix used
 * at each write site is preserved on `VariableBinding.writePrefix`
 * for diagnostics that care about prefix consistency.
 *
 * ── Public surface ─────────────────────────────────────────────────
 *
 * Per-binding (one entry per write):
 *   resolveBindingsAt(locSyms, locBlock, atNode, baseName, opts)
 *   resolvePossibleValuesInDocument(docSyms, baseName)
 *   resolvePossibleValuesAcrossProject(docs, baseName)
 *   collectUnresolvedChainTails(locSyms, locBlock, atNode, base, opts)
 *
 * Cross-call merging (a caller-local seen through gs/func/@/@@):
 *   getMergedLocalBindings(callGraph, sym, ownLocSyms, ownUri)
 *
 * Composite "values at cursor" (the entry point hover/completion use):
 *   getPossibleValuesAtCursor(docSyms, callGraph, tree, line, col, base, opts)
 *
 * String-arg helpers (used by extractors, not consumers):
 *   parseVarStringArg(raw)              — strip $/#/% and [index]
 *   splitVarKey(key)                    — defensive prefix strip
 */
import type Parser from 'web-tree-sitter';
import {
  type LocationSymbols,
  type DocumentSymbols,
  type VariableBinding,
  type QspSymbol,
  type TypePrefix,
} from './symbolTable';
import { isBindingVisibleFrom } from './scopeUtils';

// ----------------------------------------------------------------------
// Call-graph contract — boundary with the propagation subsystem
// ----------------------------------------------------------------------

/**
 * The minimal call-graph view this resolver consumes.
 *
 * It is intentionally NOT the full `SymbolAggregates` type from the
 * server layer: the resolver is a parser-level concern and must not
 * depend on server modules.  Any caller that has built a propagation
 * index (currently `server/aggregation.ts`'s `SymbolAggregates`, but
 * potentially also tests or future tooling) satisfies this interface
 * structurally — no explicit `implements`, no import flip required.
 *
 * The two fields are exactly the bridge points where the propagation
 * subsystem (call graph, gs/func/@/@@ flow) feeds the resolver:
 *
 *   • `externalLocalBindings` — writes inside callees that QSP's
 *     gs-call semantics route back onto a caller-local symbol.
 *   • `propagationCallers`    — reverse call-graph index, used by the
 *     self-shadow path (`local x = x` reading the caller's `x`).
 *
 * Every other field on `SymbolAggregates` is diagnostics-only and the
 * resolver neither sees nor needs it.
 */
export interface VarResolverCallGraph {
  externalLocalBindings: ReadonlyMap<QspSymbol, ReadonlyArray<{
    binding: VariableBinding;
    sourceLoc: string;
    sourceUri: string;
    varNameLower: string;
  }>>;
  propagationCallers: ReadonlyMap<string, ReadonlySet<string>>;
}

// ----------------------------------------------------------------------
// Key helpers
// ----------------------------------------------------------------------

export type { TypePrefix };

/**
 * Decompose a key that may still carry a leading type-prefix
 * (`$`/`#`/`%`).  Internal callers always pass clean (base) keys, but
 * external/test callers may pass a prefixed form; this is the
 * defensive normaliser.
 */
export function splitVarKey(key: string): { prefix: TypePrefix; base: string } {
  if (key.length > 0) {
    const c = key.charAt(0);
    if (c === '$' || c === '#' || c === '%') {
      return { prefix: c as TypePrefix, base: key.slice(1) };
    }
  }
  return { prefix: '#', base: key };
}

/**
 * Parse a variable name as it appears inside a string-arg position
 * (e.g. `killvar 'x'`, `setvar '$score', 100`, `arrsize('#arr[0]')`).
 *
 * Strips an optional leading type-prefix (`$`/`#`/`%`) and an optional
 * `[index]` suffix, returning the bare base name plus the literal
 * prefix the user wrote.  This is the single canonical entry point for
 * extractor sites that need to record a variable reference whose name
 * lives in source-text rather than as a `variable_ref` AST node.
 *
 * Returns `null` for empty input or names that reduce to an empty
 * base after stripping (callers should skip such entries).
 */
export function parseVarStringArg(
  raw: string,
): { prefix: TypePrefix; base: string } | null {
  if (!raw) return null;
  const bracketIdx = raw.indexOf('[');
  let s = (bracketIdx >= 0 ? raw.slice(0, bracketIdx) : raw).trim();
  if (!s) return null;
  let prefix: TypePrefix = '#';
  const c = s.charCodeAt(0);
  if (c === 0x24 /* $ */ || c === 0x23 /* # */ || c === 0x25 /* % */) {
    prefix = s[0] as TypePrefix;
    s = s.slice(1);
    if (!s) return null;
  }
  return { prefix, base: s };
}

// ----------------------------------------------------------------------
// Resolver: bindings visible at a specific AST position
// ----------------------------------------------------------------------

/** Walk up from a node to its enclosing `location_block` ancestor. */
export function findLocationBlock(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let a: Parser.SyntaxNode | null = node;
  while (a && a.type !== 'location_block') a = a.parent;
  return a;
}

export interface ResolveOptions {
  /** Follow `{kind:'var-ref'}` edges transitively.  Default: true. */
  followChain?: boolean;
  /** Predicate identifying code_blocks that should not count as scopes. */
  isConsumed?: (nodeId: number) => boolean;
}

/**
 * Walk var-ref chains from `canonicalKey` using the same visibility
 * rules as `resolveBindingsAt`, and return every key that was visited
 * through a var-ref edge but produced no visible terminal (non-var-ref)
 * binding in `locSyms`.  The starting key itself is NEVER reported - it
 * is handled by the normal document/project pass of the caller.
 *
 * Typical use: a var-ref chain stops mid-way at a key whose sole writes
 * live in OTHER locations.  Those keys are "unresolved tails"; callers
 * can re-query the document/project index for each to surface the
 * terminal as a 'document'-origin value.
 */
export function collectUnresolvedChainTails(
  locSyms: LocationSymbols,
  locBlock: Parser.SyntaxNode,
  atNode: Parser.SyntaxNode,
  canonicalKey: string,
  options: ResolveOptions = {},
): string[] {
  const followChain = options.followChain ?? true;
  if (!followChain) return [];
  const isConsumed = options.isConsumed ?? (() => false);

  const visited = new Set<string>([canonicalKey]);
  const queue: string[] = [canonicalKey];
  const tails: string[] = [];

  while (queue.length > 0) {
    const key = queue.shift()!;
    const bindings = locSyms.variableBindings.get(key);
    let hasVisibleTerminal = false;
    if (bindings) {
      for (const b of bindings) {
        if (!isBindingVisibleFrom(
          atNode, locBlock,
          b.scopeNodeId, b.isolationAncestorId, b.isLocal, isConsumed,
        )) continue;
        if (b.value.kind === 'var-ref') {
          const next = b.value.varBaseName;
          if (!visited.has(next)) { visited.add(next); queue.push(next); }
          continue;
        }
        hasVisibleTerminal = true;
      }
    }
    // Tail = a key we reached via chain that has no visible terminal
    // in this location.  Skip the starting key; the caller's document
    // pass already looks it up directly.
    if (!hasVisibleTerminal && key !== canonicalKey) tails.push(key);
  }
  return tails;
}

/**
 * All bindings of `canonicalKey` visible from `atNode`, with `var-ref`
 * chains followed to their terminal (non-var-ref) values.
 *
 * - Globals are always visible (flat namespace).
 * - Locals are visible only when `atNode` is inside their scope-island
 *   (no intervening isolating ancestor).
 * - Var-ref cycles terminate cleanly.
 * - Duplicate terminal bindings (same `stmtLoc`) are deduped.
 */
export function resolveBindingsAt(
  locSyms: LocationSymbols,
  locBlock: Parser.SyntaxNode,
  atNode: Parser.SyntaxNode,
  canonicalKey: string,
  options: ResolveOptions = {},
): VariableBinding[] {
  const followChain = options.followChain ?? true;
  const isConsumed = options.isConsumed ?? (() => false);

  const out: VariableBinding[] = [];
  const seenStmt = new Set<string>();
  const visited = new Set<string>([canonicalKey]);
  const queue: string[] = [canonicalKey];

  while (queue.length > 0) {
    const key = queue.shift()!;
    const bindings = locSyms.variableBindings.get(key);
    if (!bindings) continue;
    for (const b of bindings) {
      if (!isBindingVisibleFrom(
        atNode, locBlock,
        b.scopeNodeId, b.isolationAncestorId, b.isLocal, isConsumed,
      )) continue;
      if (followChain && b.value.kind === 'var-ref') {
        const next = b.value.varBaseName;
        if (!visited.has(next)) { visited.add(next); queue.push(next); }
        continue;
      }
      const stmtKey = `${b.stmtLoc.line}:${b.stmtLoc.column}`;
      if (seenStmt.has(stmtKey)) continue;
      seenStmt.add(stmtKey);
      out.push(b);
    }
  }
  return out;
}

// ----------------------------------------------------------------------
// Resolver: document / project-wide possible values
// ----------------------------------------------------------------------

export interface PossibleValueEntry {
  /** Document URI where the binding was recorded. */
  uri: string;
  /** Location name (original case) containing the binding. */
  locationName: string;
  /** The binding itself. */
  binding: VariableBinding;
}

/**
 * Union of every NON-LOCAL (global-scope) binding of `canonicalKey`
 * in a single document.  Follows `var-ref` chains intra-document.
 *
 * Cross-location chain resolution is intra-document only: since the
 * document-wide `globalBindings` index is flat, a var-ref to `$y` is
 * followed by re-querying the same index, not by re-anchoring to any
 * specific call site.  Consumers that need call-site-accurate
 * resolution should combine this with `resolveBindingsAt` at the site.
 */
export function resolvePossibleValuesInDocument(
  docSyms: DocumentSymbols,
  canonicalKey: string,
): PossibleValueEntry[] {
  // Be tolerant of callers that pass a still-prefixed key (e.g.
  // `'$foo'`).  Bindings are now base-keyed, so strip the prefix.
  const base = splitVarKey(canonicalKey).base;
  const out: PossibleValueEntry[] = [];
  const seen = new Set<string>();
  const visited = new Set<string>([base]);
  const queue: string[] = [base];

  while (queue.length > 0) {
    const key = queue.shift()!;
    const entries = docSyms.globalBindings.get(key);
    if (!entries) continue;
    for (const e of entries) {
      if (e.binding.value.kind === 'var-ref') {
        const next = e.binding.value.varBaseName;
        if (!visited.has(next)) { visited.add(next); queue.push(next); }
        continue;
      }
      const k = `${e.locationName}\0${e.binding.stmtLoc.line}:${e.binding.stmtLoc.column}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ uri: docSyms.uri, locationName: e.locationName, binding: e.binding });
    }
  }
  return out;
}

/**
 * Project-wide union of non-local bindings of `canonicalKey` across
 * every document.  Accepts any iterable of `DocumentSymbols` so that
 * both single-file and project-wide callers share one implementation.
 */
export function resolvePossibleValuesAcrossProject(
  docs: Iterable<DocumentSymbols>,
  canonicalKey: string,
): PossibleValueEntry[] {
  const out: PossibleValueEntry[] = [];
  for (const doc of docs) {
    for (const e of resolvePossibleValuesInDocument(doc, canonicalKey)) out.push(e);
  }
  return out;
}

// ----------------------------------------------------------------------
// Resolver: caller-local merged with cross-call mutations
// ----------------------------------------------------------------------

export interface MergedLocalBinding {
  /** The binding. */
  binding: VariableBinding;
  /** Location name (original case) where the binding was recorded. */
  locationName: string;
  /** Document URI where the binding was recorded. */
  uri: string;
  /**
   * `true` when the binding comes from a callee via gs/gosub/func/@/@@;
   * the caller's local is mutated through the propagation call-graph.
   */
  fromCall: boolean;
}

/**
 * Every statically-known value a caller-local `sym` may hold,
 * including mutations performed by gs / gosub / func / @ / @@ callees.
 *
 * The merged list is deduped by `(uri, locationName, stmtLoc)` and
 * returned in source order - own-location bindings first, then
 * cross-call.
 *
 * `agg` must be the aggregates produced by `buildPropagatedLocals` for
 * the project containing `sym`'s owning document.
 */
export function getMergedLocalBindings(
  agg: VarResolverCallGraph,
  sym: QspSymbol,
  ownLocSyms: LocationSymbols,
  ownUri: string,
): MergedLocalBinding[] {
  const out: MergedLocalBinding[] = [];
  const seen = new Set<string>();
  const push = (m: MergedLocalBinding) => {
    const k = `${m.uri}\0${m.locationName}\0${m.binding.stmtLoc.line}:${m.binding.stmtLoc.column}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(m);
  };

  // 1) Sym's own bindings in its owning location.  Bindings are
  //    keyed by base name; one bucket holds writes through every
  //    prefix variant.
  {
    const bindings = ownLocSyms.variableBindings.get(sym.nameLower);
    if (bindings) {
      for (const b of bindings) {
        // A local sym wants local bindings; a global sym wants global ones.
        if (b.isLocal !== sym.isLocal) continue;
        push({
          binding: b,
          locationName: ownLocSyms.locationName,
          uri: ownUri,
          fromCall: false,
        });
      }
    }
  }

  // 2) Cross-call mutations routed back through the call graph.
  const ext = agg.externalLocalBindings.get(sym);
  if (ext) {
    for (const e of ext) {
      push({
        binding: e.binding,
        locationName: e.sourceLoc,
        uri: e.sourceUri,
        fromCall: true,
      });
    }
  }

  return out;
}

// ----------------------------------------------------------------------
// Composite resolver: possible values at a cursor position
// ----------------------------------------------------------------------

/**
 * A single possible value for a variable at the query position.
 *
 * This is the unified view returned by `getPossibleValuesAtCursor`,
 * merging results from the three lower-level resolvers:
 *
 *   - `resolveBindingsAt`                 — scope-visible bindings in the
 *                                           own location (locals + globals).
 *   - `resolvePossibleValuesInDocument`   — non-local bindings elsewhere
 *                                           in the document / project.
 *   - `externalLocalBindings`             — cross-call writes flowing back
 *                                           to caller-locals.
 */
export interface CursorValueEntry {
  /** The binding itself. */
  binding: VariableBinding;
  /** Where the binding was recorded. */
  locationName: string;
  /** URI of the document containing the binding. */
  uri: string;
  /**
   * - 'scope'     — visible in the query's own scope (locals + own-loc globals).
   * - 'document'  — non-local binding from elsewhere in the document/project.
   * - 'cross-call'— mutation routed back through gs/func/@/@@ call graph.
   */
  origin: 'scope' | 'document' | 'cross-call';
}

/** Options controlling which resolvers contribute. */
export interface CursorValueOptions {
  /** Include non-local bindings from elsewhere in the doc.  Default: true. */
  includeDocumentGlobals?: boolean;
  /** Also scan this project-wide iterable of `DocumentSymbols`.  Default: none. */
  projectDocs?: Iterable<DocumentSymbols>;
  /** Follow `var-ref` chains.  Default: true. */
  followChain?: boolean;
  /** Predicate for code_blocks that should NOT count as scopes. Default: none. */
  isConsumed?: (nodeId: number) => boolean;
  /**
   * Enable hover-only enrichment paths:
   *   • 2a+ self-shadow caller-propagation (`local x = x`)
   *   • 2b deferred code_block fallback
   *   • 3b chain-tail bridge for cross-location var-ref globals
   * Set `true` for hover / completion where all reachable values must be
   * shown.  Leave unset (default `false`) for diagnostic callers that
   * only inspect `isValueBearing` or binding identity — skipping these
   * paths avoids the extra resolver work per symbol.
   */
  hoverMode?: boolean;
}

/**
 * All statically-known possible values for the variable name at
 * `(line, column)` in a parsed QSP document.
 *
 * Behavior:
 *   - Finds the location_block enclosing the cursor.  If outside any
 *     location, returns [] (no scope context).
 *   - Resolves `canonicalKey` against visibility rules at the cursor
 *     (scope islands + isolation anchors + var-ref chains).
 *   - Adds non-local bindings from the full document (optionally
 *     project) as 'document' entries.
 *   - For each LOCAL scope-visible symbol whose lowered name matches,
 *     adds `externalLocalBindings` entries as 'cross-call' values.
 *
 * Dedup key: `(uri, locationName, stmtLine, stmtColumn)`.
 *
 * Use this for hover, completion tooltips, and any "what can this be?"
 * query.  For flow-sensitive answers (definite-assignment, last-write-
 * wins) a separate CFG-based pass would be needed.
 */
export function getPossibleValuesAtCursor(
  docSyms: DocumentSymbols,
  agg: VarResolverCallGraph,
  tree: Parser.Tree,
  line: number,
  column: number,
  canonicalKey: string,
  options: CursorValueOptions = {},
): CursorValueEntry[] {
  if (!canonicalKey) return [];
  const {
    includeDocumentGlobals = true,
    projectDocs,
    followChain = true,
    isConsumed = () => false,
    hoverMode = false,
  } = options;

  // Normalise to lowercase and strip any legacy type-prefix
  // (`$`/`#`/`%`) so the lookup matches the base-keyed storage.
  const key = splitVarKey(canonicalKey.toLowerCase()).base;

  const atNode = tree.rootNode.descendantForPosition({ row: line, column });
  if (!atNode) return [];

  const locBlock = findLocationBlock(atNode);
  if (!locBlock) return [];

  // Find the LocationSymbols owning the enclosing location_block.
  // The header holds the `location_name` node (no tree-sitter field;
  // walk the named children instead).  Match case-insensitively.
  const header = locBlock.namedChildren.find(c => c?.type === 'location_header');
  if (!header) return [];
  const nameNode = header.namedChildren.find(c => c?.type === 'location_name');
  if (!nameNode) return [];
  const locKey = nameNode.text.trim().toLowerCase();
  const ownLocSyms = docSyms.locations.get(locKey);
  if (!ownLocSyms) return [];

  const out: CursorValueEntry[] = [];
  const seen = new Set<string>();
  const push = (e: CursorValueEntry) => {
    const k = `${e.uri}\0${e.locationName}\0${e.binding.stmtLoc.line}:${e.binding.stmtLoc.column}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(e);
  };

  // 1. Scope-visible bindings in the own location (locals + globals).
  const scoped = resolveBindingsAt(
    ownLocSyms, locBlock, atNode, key,
    { followChain, isConsumed },
  );
  for (const b of scoped) {
    push({
      binding: b,
      locationName: ownLocSyms.locationName,
      uri: docSyms.uri,
      origin: 'scope',
    });
  }

  // 2. Cross-call mutations flowing back to a caller-local visible here.
  //    Run BEFORE the document pass so writes that route through the
  //    call-graph to THIS local get tagged `cross-call` (more specific)
  //    rather than the generic `document` origin a later dedup would
  //    otherwise give them.
  //
  //    `externalLocalBindings` is keyed by `QspSymbol`, which collapses
  //    type prefixes (every prefix shares one symbol) just like the
  //    base-keyed binding store.  Surface every entry routed to this
  //    symbol; per-prefix filtering is no longer applicable since the
  //    runtime treats all prefixes as one variable.
  const base = key;
  const sym = base
    ? ownLocSyms.findVariableAtPosition(base, line, column)
    : undefined;
  if (sym?.isLocal) {
    const ext = agg.externalLocalBindings.get(sym);
    if (ext) {
      for (const e of ext) {
        push({
          binding: e.binding,
          locationName: e.sourceLoc,
          uri: e.sourceUri,
          origin: 'cross-call',
        });
      }
    }
  }

  // 2a+. Self-shadow caller-propagation.
  //
  //     For `local x = x` (or `$a = $a`, …) the RHS reads the
  //     enclosing/outer `x` — which, when this location is reached via
  //     gs/gosub/func/@/@@, is the caller's propagated local.  Step 3
  //     below already picks up document-wide globals via the var-ref
  //     edge, but caller-propagated LOCALS live in the caller's
  //     variables map and are not in `globalBindings`.  Moreover,
  //     `buildPropagatedLocals` does NOT record propagation into a
  //     location that shadows the name with `local` (the callee's
  //     `local x` terminates the flow), so we cannot use
  //     `agg.propagatedLocals` here — we walk the reverse call graph
  //     (`agg.propagationCallers`) and resolve each caller's same-named
  //     local at its call-site scope directly.
  //
  //     Fires only when the own-loc bindings contain a SCOPE-VISIBLE
  //     self-referring var-ref edge for `key`.  Absent that edge the
  //     statement wasn't a self-shadow and we shouldn't inject writes.
  //
  //     `hasSelfShadow` is also consulted by step 3 below to decide
  //     whether the local shadows outer globals: a true self-shadow
  //     (`local x = x`) must NOT shadow them, because the RHS reads
  //     the outer value.
  let hasSelfShadow = false;
  if (sym?.isLocal) {
    const ownBindings = ownLocSyms.variableBindings.get(key);
    if (ownBindings) {
      for (const b of ownBindings) {
        if (b.value.kind !== 'var-ref') continue;
        if (b.value.varBaseName !== key) continue;
        if (!isBindingVisibleFrom(
          atNode, locBlock,
          b.scopeNodeId, b.isolationAncestorId, b.isLocal, isConsumed,
        )) continue;
        hasSelfShadow = true;
        break;
      }
    }
  }
  if (hoverMode && sym?.isLocal && hasSelfShadow && agg.propagationCallers.size > 0) {
    const targetKey = ownLocSyms.locationName.toLowerCase();
    const callerLocs = agg.propagationCallers.get(targetKey);
    if (callerLocs && callerLocs.size > 0) {
      // Resolve a location-name key to its owning LocationSymbols/uri
      // by searching the own document first, then any project docs.
      const findLoc = (locName: string): { loc: LocationSymbols; uri: string } | undefined => {
        const k = locName.toLowerCase();
        const own = docSyms.locations.get(k);
        if (own) return { loc: own, uri: docSyms.uri };
        if (projectDocs) {
          for (const d of projectDocs) {
            const l = d.locations.get(k);
            if (l) return { loc: l, uri: d.uri };
          }
        }
        return undefined;
      };
      for (const callerLoc of callerLocs) {
        const info = findLoc(callerLoc);
        if (!info) continue;
        // Find every call in this caller that reaches our target.
        const refEntry = info.loc.locationRefs.get(targetKey);
        if (!refEntry) continue;
        for (const r of refEntry.references) {
          const scopeIdAtCall = r.localsInScope?.get(base);
          if (scopeIdAtCall === undefined) continue;
          const callerSymKey = `local\0${scopeIdAtCall}\0${base}`;
          const callerSym = info.loc.variables.get(callerSymKey);
          if (!callerSym) continue;
          // Surface every terminal (non var-ref) local binding the
          // caller sym resolves to — both its own writes and any
          // cross-call mutations already attached to it.
          const merged = getMergedLocalBindings(agg, callerSym, info.loc, info.uri);
          for (const m of merged) {
            if (m.binding.value.kind === 'var-ref') continue;
            push({
              binding: m.binding,
              locationName: m.locationName,
              uri: m.uri,
              origin: 'cross-call',
            });
          }
        }
      }
    }
  }

  // 2b. Symbol-based fallback for caller-local symbols propagated into
  //     a deferred code_block (the block is held in a local $code /
  //     $c and invoked via `dynamic $code` or `dyneval($c, …)`).  The
  //     deferred walker injects the caller's `QspSymbol` into a
  //     synthetic scope, but the binding's `scopeNodeId` still refers
  //     to the caller's AST scope — which `isBindingVisibleFrom`
  //     (step 1) blocks from inside the isolating code_block.
  //
  //     When `findVariableAtPosition` resolves to a local symbol whose
  //     definition lives elsewhere than at our cursor's AST scope, the
  //     scope-pass has genuinely missed the bindings that semantically
  //     apply here.  Recover them by anchoring on the symbol's
  //     definition site: all LOCAL bindings sharing that scopeNodeId
  //     belong to this symbol and are possible values at the cursor.
  //
  //     Non-local bindings are NOT added here — `isBindingVisibleFrom`
  //     already surfaces non-locals unconditionally in the scope pass.
  //
  //     Skipped unless hoverMode — diagnostics never render the
  //     fallback bindings directly.
  if (hoverMode && sym?.isLocal && sym.definition) {
    const defLine = sym.definition.line;
    const defCol = sym.definition.column;
    let anchor: number | undefined;
    {
      const bindings = ownLocSyms.variableBindings.get(sym.nameLower);
      if (bindings) {
        for (const b of bindings) {
          if (!b.isLocal) continue;
          if (b.stmtLoc.line !== defLine) continue;
          if (b.stmtLoc.column > defCol) continue;
          if (b.stmtLoc.endLine < defLine) continue;
          if (b.stmtLoc.endLine === defLine && b.stmtLoc.endColumn < defCol) continue;
          anchor = b.scopeNodeId;
          break;
        }
      }
    }
    if (anchor !== undefined) {
      const bindings = ownLocSyms.variableBindings.get(sym.nameLower);
      if (bindings) {
        for (const b of bindings) {
          if (!b.isLocal) continue;
          if (b.scopeNodeId !== anchor) continue;
          // Skip bare var-ref edges — they are not terminal values
          // and `resolveBindingsAt` (step 1) already handles chain
          // traversal for non-shadow cases.  Surfacing them here as
          // "values" produces noisy output like "→ `x`" in hover.
          if (b.value.kind === 'var-ref') continue;
          push({
            binding: b,
            locationName: ownLocSyms.locationName,
            uri: docSyms.uri,
            origin: 'scope',
          });
        }
      }
    }
  }

  // Local helper: resolve `k` against own doc + optional project docs.
  // Prepend docSyms so it is always included even if the caller omitted it from projectDocs.
  const resolveValues = (k: string): PossibleValueEntry[] =>
    projectDocs
      ? resolvePossibleValuesAcrossProject([docSyms, ...projectDocs], k)
      : resolvePossibleValuesInDocument(docSyms, k);

  // 3. Document / project-wide non-local bindings.  Any write already
  //    surfaced as `cross-call` above will be deduped out here.
  //    `globalBindings` only contains non-local writes, so there is no
  //    need to filter by `isLocal` here — own-loc scope-visible globals
  //    are already deduped via the scope pass.
  //
  //    SHADOWING: when the cursor's symbol resolves to a LOCAL, any
  //    document-wide global write under the same name is shadowed by
  //    the local and must not surface — UNLESS the local is a
  //    self-shadow (`local x = x`), where the RHS literally reads the
  //    outer value and surfacing it is the whole point.  (The chain-
  //    tail bridge below still runs unconditionally — it queries the
  //    *chained* key, not the cursor key, so chained globals like
  //    `local $g = $other` → `$other = ...` remain reachable.)
  if (includeDocumentGlobals && (!sym?.isLocal || hasSelfShadow)) {
    const docValues = resolveValues(key);
    for (const e of docValues) {
      push({
        binding: e.binding,
        locationName: e.locationName,
        uri: e.uri,
        origin: 'document',
      });
    }
  }

  if (hoverMode && includeDocumentGlobals) {
    // 3b. Chain-tail bridge for globals.
    //
    //     When the scope pass follows a var-ref chain to a key whose
    //     only writes live in OTHER locations (e.g. `local $b = $g` in
    //     loc A, `$g = 'G'` in loc B), `resolveBindingsAt` stops at a
    //     bare var-ref edge because it searches ONLY this location's
    //     `variableBindings`.  Step 3 above re-queries the document for
    //     the ORIGINAL key, not the chained key, so the terminal is
    //     missed.
    //
    //     Bridge it conservatively:
    //       • Single-write tail → add the global write as a 'document'
    //         entry (the literal "hint constant" shape).
    //       • Multi-write tail → surface the local's own-loc var-ref
    //         binding as a 'scope' entry so the hover renderer's
    //         `expandVarRef` callback sees a chain edge and enumerates
    //         all terminal writes as individual value lines.
    //       • Zero-write tail → surface the local's chain edge as a
    //         'scope' entry too, so the renderer emits an
    //         `*(unresolved)*` line.  Showing the dangling reference
    //         is more informative than silent empty output.
    const tails = collectUnresolvedChainTails(
      ownLocSyms, locBlock, atNode, key,
      { followChain, isConsumed },
    );
    /** Find a scope-visible var-ref binding for the cursor key whose
     *  chain leads to `tail`.  Used to surface the chain edge as a
     *  CursorValueEntry when the tail has multiple writes. */
    const findVisibleVarRefForKey = (k: string): VariableBinding | undefined => {
      const bs = ownLocSyms.variableBindings.get(k);
      if (!bs) return undefined;
      for (const b of bs) {
        if (b.value.kind !== 'var-ref') continue;
        if (!isBindingVisibleFrom(
          atNode, locBlock,
          b.scopeNodeId, b.isolationAncestorId, b.isLocal, isConsumed,
        )) continue;
        return b;
      }
      return undefined;
    };
    for (const tail of tails) {
      const tailValues = resolveValues(tail);
      if (tailValues.length === 1) {
        const only = tailValues[0];
        push({
          binding: only.binding,
          locationName: only.locationName,
          uri: only.uri,
          origin: 'document',
        });
        continue;
      }
      // Zero-write or multi-write tail: surface the local's chain
      // edge so the renderer either emits an *(unresolved)* line
      // (zero writes) or enumerates each write individually (multi writes).
      const edge = findVisibleVarRefForKey(key);
      if (!edge) continue;
      push({
        binding: edge,
        locationName: ownLocSyms.locationName,
        uri: docSyms.uri,
        origin: 'scope',
      });
    }
  }

  return out;
}
