/**
 * Cross-location / cross-file symbol aggregation — the **call-graph &
 * propagation** subsystem.
 *
 * Pure data structures and functions that collect global variable usage,
 * action/object definitions, location references, and transitive local
 * variable propagation across the call graph (gs / gosub / func / @ /
 * @@).  No closure captures, no mutable server state.
 *
 * ── Layering ──────────────────────────────────────────────────────────
 *
 * Two outputs of `SymbolAggregates` form the public bridge to the
 * **variable-resolution** subsystem in `parser/variableBindings.ts`:
 *
 *   • `externalLocalBindings` — callee writes that flow back onto a
 *     caller-local under gs-call semantics.
 *   • `propagationCallers`    — reverse call-graph index, used by the
 *     resolver's self-shadow path (`local x = x`).
 *
 * These two fields are exactly the structural surface declared by
 * `VarResolverCallGraph` in the parser layer.  `SymbolAggregates`
 * satisfies that interface with no explicit `implements`, keeping the
 * dependency edge one-directional (server → parser, never the reverse).
 *
 * Every other field on `SymbolAggregates` is either internal to this
 * module's post-passes or consumed exclusively by `server/diagnostics.ts`
 * — the resolver does not see them.
 */
import type { LocationSymbols, QspSymbol } from '../parser';
import { ARGS_VAR_NAME, RESULT_VAR_NAME, CALL_FRAME_BUILTINS } from '../parser';
import type { DocumentSymbols, VariableBinding } from '../parser/symbolTable';
import type { SymbolLocation } from '../parser/symbolTypes';
import { heartbeat } from './perfLog';
import { runNow, type Steps } from './slices';
import { bindingsOfLocal } from '../parser/variableBindings';
import { locationInterface } from '../parser/locationInterface';
import { literalOf, type TargetPattern } from '../parser/targetPattern';
import { addValueFlows, emptyValueFlows, runVariablesOf, type ValueFlows } from '../parser/storedBlocks';

/**
 * Project-wide aggregated data from all files.
 * Rebuilt whenever any project file changes.
 */
export interface ProjectAggregates extends SymbolAggregates {
  /** All location definitions across all project files: key→{uri, symbol} */
  locationDefs: Map<string, { uri: string; symbol: QspSymbol }>;
  /** First location in the entire project (exempt from unused-location check) */
  firstLocationKey: string | undefined;
  /** Flattened location defs (key→QspSymbol) for diagnostics — avoids per-file re-creation */
  flatLocationDefs: Map<string, QspSymbol>;
  /** Per-file location name sets for O(1) cross-file duplicate lookup.
   *  Built once in rebuildProjectAggregates, reused across all computeDiagnostics calls. */
  perFileLocNames: Map<string, Set<string>>;
  /** Cached call types per target (rebuilt with aggregates). */
  callTypesPerTarget: Map<string, { name: string; types: Set<string> }>;
}

// ──────────────────────────────────────────────────────────────────────
// Interfaces
// ──────────────────────────────────────────────────────────────────────

/**
 * Shared shape for file-local and project-wide aggregate data.
 * Used by both rebuildProjectAggregates and computeDiagnostics (single-file).
 */
export interface SymbolAggregates {
  globallyDefined: Set<string>;
  /**
   * Subset of `globallyDefined` containing only names that have at
   * least one *value-bearing* global definition (an assignment with
   * an RHS, or a side-effect write that produces a value).  A bare
   * `local x` declaration adds to `globallyDefined` (because the local
   * sym has a definition), but does NOT add to this set — used by the
   * `uninitializedVariables` diagnostic so that reads of an unbound
   * `local x` warn even when a same-named global appears in the
   * project.
   */
  globallyValueDefined: Set<string>;
  globallyRead: Set<string>;
  definedActions: Set<string>;
  definedObjects: Set<string>;
  referencedLocations: Set<string>;
  referencedObjects: Set<string>;
  /**
   * Lowercase, trimmed string literals written to variables or passed to
   * calls. A location named by one may be reached through it (`$to =
   * 'hall'`, then `gt $to` somewhere), so it isn't reported as never
   * referenced even when the jump graph can't follow the value there.
   */
  namedInText: Set<string>;
  /**
   * The literal start and end of dynamic jump targets built from text and
   * variables (`gs 'eat<<n>>'` starts with `eat`): a location whose name fits
   * one may be reached through it.
   */
  dynamicTargetShapes: Array<{ prefix: string; suffix: string }>;
  /**
   * True when any contributing location is `regexOnly`. Its references
   * are missing from `referencedLocations` / `referencedObjects` /
   * `globallyRead`, so "never used" checks built on them would be wrong.
   */
  hasRegexOnlyLocations: boolean;
  globalPrefixes: Map<string, { prefixes: Set<string>; name: string }>;
  /**
   * Transitive local-variable propagation across the call graph.
   *
   * targetLocation → varName → array of provider entries.
   * Each provider entry identifies a source location that defines the
   * local variable and propagates it (directly or transitively) to the
   * target via gs/gosub/func/@/@@.
   *
   * Built by `buildPropagatedLocals()` after `collectAggregates()`.
   */
  propagatedLocals: Map<string, Map<string, PropagatedLocal[]>>;
  /**
   * Mirror of `propagatedLocals` for the case where the target
   * *shadows* the propagated variable with its own `local`
   * declaration.  `propagatedLocals` only records targets that
   * actually consume the propagated value; this map records targets
   * whose `local` declaration silently swallows it instead.  Same
   * shape: targetLocation → varName → providers[].
   *
   * Consumed by the `shadowsPropagatedLocal` diagnostic.
   */
  shadowedPropagations: Map<string, Map<string, PropagatedLocal[]>>;
  /**
   * Set of QspSymbol instances that are propagated to at least one callee.
   * Used for O(1) lookup in the unused-variable check instead of iterating
   * the entire propagatedLocals map.
   */
  propagatedSyms: Set<QspSymbol>;
  /**
   * Reverse call-graph index for propagating calls:
   * targetLocKey → array of caller location keys that call this target
   * with locals-propagating calls (gs/gosub/func/@/@@).
   * Built by `buildPropagatedLocals()`.
   */
  propagationCallers: Map<string, Set<string>>;
  /**
   * Call-graph-sensitive dataflow.
   *
   * For every caller-local QspSymbol that is propagated via gs/gosub/func/@/@@
   * into a callee, this index records the *non-local* bindings the callee
   * makes to that variable name.  Under QSP gs-call semantics these writes
   * mutate the caller's local, so they are additional possible values that
   * the variable can hold after the call returns.
   *
   * Built by `buildPropagatedLocals()` as a post-pass.  Keyed by the
   * provider's QspSymbol instance; values are deduplicated per
   * (sourceLoc, stmtLoc) pair.
   */
  externalLocalBindings: Map<QspSymbol, ExternalBinding[]>;
  /**
   * Set of statement locations (`${uri}\0${line},${column}`) where a
   * write inside a propagated code-block flows back to a caller-local
   * via var-mediated dynamic dispatch.
   *
   * When a code-block holder `$code` is propagated and later invoked
   * by `dynamic $code` in a callee, inner writes like `x = 42` appear
   * as non-local references on a *global* `x` symbol in the block's
   * enclosing location — because the block isolates scope.  At runtime
   * these writes mutate the caller's local (recorded by the
   * cross-location var-mediated dispatch post-pass below), so the
   * global's apparent "write with no read" should NOT trigger the
   * unused-variable diagnostic.  Consumed by that check.
   */
  crossCallWrites: Set<string>;
  /**
   * Locations whose body directly assigns a value to the built-in
   * `result` variable.  Used by `missingResultInFunctionCall` to flag
   * `@`/`func` calls to locations that never set `result`.
   *
   * `result` (like `args`) is a fresh local per call frame — every
   * `gs`/`gosub`/`func`/`@`/`@@`/`dyneval`/`dynamic` invocation gets its own
   * `result`.  So a callee's write to `result` does NOT satisfy the
   * caller's need to set its own `result`; this set is *not* closed
   * transitively through the call graph.
   *
   * Built by `buildPropagatedLocals()`.
   */
  locationsWritingResult: Set<string>;
  /**
   * Per-location summary of how the built-in `args` variable is
   * consumed in the location's *own* frame (i.e. references outside
   * any inline `dynamic`/`dyneval` block — block-internal `args`
   * belongs to the block's own per-call frame).
   *
   *   - `hasOpaque: true`  — at least one read whose slot can't be
   *                          determined statically (bare `args` or
   *                          non-literal index).  Any caller passing
   *                          extras may be fully consumed; we can't
   *                          warn about partial use.
   *   - `maxLiteralIdx: N` — highest literal `args[N]` read.
   *                          `-1` means no literal-indexed read.
   *
   * Map presence replaces the older `locationsUsingArgs` set: a
   * location is in this map iff it references `args` at all.
   * Consumed by `extraArgsToTargetWithoutArgs`.
   *
   * Built by `buildPropagatedLocals()`.
   */
  argsUsageByLoc: Map<string, ArgsUsage>;
  /**
   * Per-callee `dynamic $g` / `dyneval($g, …)` call sites whose first
   * argument variable resolved — only via project-wide search — to one
   * or more global code-block bindings in *other* locations.
   *
   * Populated by `buildPropagatedLocals()` as two post-passes:
   *
   *   • over each location's `unresolvedDynamicVarCalls` (call sites
   *     that found no local binding and no caller-propagated binding,
   *     and whose enclosing code runs in the host's own call frame);
   *   • over each location's `deferredDynamicVarCalls` (call sites
   *     inside act bodies and `<a href="exec:…">` link bodies, which
   *     run at click time in a fresh frame — caller-propagated locals
   *     cannot shadow the global lookup, and the host's own globals
   *     remain visible, so self-loc is NOT excluded).
   *
   * Each entry carries the call-site location, dispatch kind, extra
   * argCount, and the candidate provider bindings.
   *
   * Consumed by the cross-location variants of the
   * `missingResultInDyneval` and `extraArgsToTargetWithoutArgs`
   * diagnostics.  Keyed by the callee's lowercase location name.
   */
  crossLocationDispatches: Map<string, CrossLocationDispatch[]>;
  /** What the locations run and how values pass between variables (storedBlocks.ts). */
  valueFlows: ValueFlows;
  /**
   * The variables whose value something may run, worked out from
   * `valueFlows` by `finishAggregates`: a block kept in any other is text.
   */
  runVariables?: ReadonlySet<string>;
}

/** One candidate provider for a cross-location dispatch. */
export interface CrossLocationDispatchTarget {
  /** Lowercase key of the location holding the global binding. */
  providerLoc: string;
  /** URI of the document containing the provider location. */
  providerUri: string;
  /** The provider's `variableBindings` entry whose value is a code block. */
  binding: VariableBinding;
  /**
   * True iff the block body contains at least one value-bearing
   * assignment to the built-in `result`.  Pre-computed in aggregation
   * so the `missingResultInDyneval` diagnostic does not need to
   * re-scan provider symbols.
   */
  writesResult: boolean;
  /**
   * How the block body uses the built-in `args` (same shape as
   * {@link SymbolAggregates.argsUsageByLoc}).  `undefined` means the
   * block never references `args` — every extra arg the caller
   * passed is discarded.
   */
  argsUsage: ArgsUsage | undefined;
}

/** A cross-location var-mediated `dynamic`/`dyneval` dispatch. */
export interface CrossLocationDispatch {
  /** Range of the entire `dynamic`/`dyneval` call (diagnostic anchor). */
  callLoc: SymbolLocation;
  /** Statement form (`dynamic`) or function form (`dyneval`). */
  kind: 'dynamic' | 'dyneval';
  /** Number of extra positional args after the var argument. */
  argCount: number;
  /** Original-case variable name (with `$`/`#`/`%` prefix). */
  varName: string;
  /** Lowercased base name (no prefix). */
  varBaseName: string;
  /** Resolvable global candidate targets (always non-empty), the first MAX_DISPATCH_CANDIDATES. */
  candidates: CrossLocationDispatchTarget[];
  /**
   * There were more candidates than listed. Checks that must hold for
   * every candidate then say nothing.
   */
  truncated?: boolean;
}

/**
 * A dispatch lists at most this many candidate blocks. Blocks kept under
 * the same variable name in many locations (a `$menu` in every room) made
 * every unresolved `dynamic $menu` list all of them: call sites × blocks.
 */
export const MAX_DISPATCH_CANDIDATES = 16;

/** Args consumption profile for a single location/block frame. */
export interface ArgsUsage {
  hasOpaque: boolean;
  /** Highest literal `args[N]` index read; `-1` if none. */
  maxLiteralIdx: number;
}

/**
 * A callee binding that flows back to a caller-local via the call graph.
 */
export interface ExternalBinding {
  /** The binding recorded in the callee location. */
  binding: VariableBinding;
  /** Lowercase key of the callee location containing the binding. */
  sourceLoc: string;
  /** URI of the callee document. */
  sourceUri: string;
  /** Lowercase variable base-name the binding writes to (no prefix). */
  varNameLower: string;
}

/**
 * A single provider of a propagated local variable.
 */
export interface PropagatedLocal {
  /** Location name (lowercase) that defines the local */
  providerLoc: string;
  /** URI of the document containing the provider */
  providerUri: string;
  /** The QspSymbol for the local variable in the provider */
  sym: QspSymbol;
}

// ──────────────────────────────────────────────────────────────────────
// Functions
// ──────────────────────────────────────────────────────────────────────

/** Create a fresh empty SymbolAggregates. */
export function emptyAggregates(): SymbolAggregates {
  return {
    globallyDefined: new Set(),
    globallyValueDefined: new Set(),
    globallyRead: new Set(),
    definedActions: new Set(),
    definedObjects: new Set(),
    referencedLocations: new Set(),
    referencedObjects: new Set(),
    namedInText: new Set(),
    dynamicTargetShapes: [],
    hasRegexOnlyLocations: false,
    globalPrefixes: new Map(),
    propagatedLocals: new Map(),
    shadowedPropagations: new Map(),
    propagatedSyms: new Set(),
    propagationCallers: new Map(),
    externalLocalBindings: new Map(),
    crossCallWrites: new Set(),
    locationsWritingResult: new Set(),
    argsUsageByLoc: new Map(),
    crossLocationDispatches: new Map(),
    valueFlows: emptyValueFlows(),
  };
}

/** Collect symbol aggregates from a set of LocationSymbols into `out`. */
export function collectAggregates(
  locations: Iterable<LocationSymbols>,
  out: SymbolAggregates,
): void {
  for (const locSyms of locations) {
    if (locSyms.regexOnly) out.hasRegexOnlyLocations = true;
    for (const sym of locSyms.ownedVariables) {
      // Local variables are scoped to their location — skip them
      // for cross-location aggregates
      if (sym.isLocal) continue;
      if (sym.definition) out.globallyDefined.add(sym.nameLower);
      if (sym.hasValueDefinition) out.globallyValueDefined.add(sym.nameLower);
      if (!out.globallyRead.has(sym.nameLower)) {
        if (sym.references.some(ref => ref.isProperUsage)) {
          out.globallyRead.add(sym.nameLower);
        }
      }
      if (sym.prefixes) {
        let entry = out.globalPrefixes.get(sym.nameLower);
        if (!entry) {
          entry = { prefixes: new Set(), name: sym.name };
          out.globalPrefixes.set(sym.nameLower, entry);
        }
        for (const p of sym.prefixes) entry.prefixes.add(p);
      }
    }
    for (const act of locSyms.actions) {
      out.definedActions.add(act.nameLower);
    }
    for (const [key, obj] of locSyms.objectRefs) {
      if (obj.definition) out.definedObjects.add(key);
      if (!obj.definition || obj.references.length > 1) out.referencedObjects.add(key);
    }
    for (const [key, ref] of locSyms.locationRefs) {
      out.referencedLocations.add(key);
      for (const r of ref.references) for (const p of r.argPatterns ?? []) if (p) addLiterals(p, out.namedInText);
    }
    for (const [, bindings] of locSyms.variableBindings) {
      for (const b of bindings) if (b.value.kind === 'expr' && b.value.pattern) addLiterals(b.value.pattern, out.namedInText);
    }
    for (const d of locSyms.dynamicLocationRefs) {
      const shape = d.target && shapeOf(d.target);
      if (shape) out.dynamicTargetShapes.push(shape);
    }
    addValueFlows(locSyms, out.valueFlows);
  }
}

// The literal text a pattern starts and ends with, when it has some and
// isn't all literal (that one is a plain jump).
function shapeOf(pattern: TargetPattern): { prefix: string; suffix: string } | undefined {
  let start = 0;
  let prefix = '';
  for (; start < pattern.length; start++) {
    const p = pattern[start];
    if (!('lit' in p)) break;
    prefix += p.lit;
  }
  if (start === pattern.length) return undefined;
  let suffix = '';
  for (let i = pattern.length - 1; i > start; i--) {
    const p = pattern[i];
    if (!('lit' in p)) break;
    suffix = p.lit + suffix;
  }
  prefix = prefix.trimStart().toLowerCase();
  suffix = suffix.trimEnd().toLowerCase();
  return prefix || suffix ? { prefix, suffix } : undefined;
}

// The values a pattern is one of when they are all literals (`'hall'`,
// `iif(x, 'a', 'b')`).
function addLiterals(pattern: TargetPattern, into: Set<string>): void {
  const literal = literalOf(pattern);
  if (literal !== undefined) {
    into.add(literal.trim().toLowerCase());
  } else if (pattern.length === 1 && 'alt' in pattern[0]) {
    for (const arm of pattern[0].alt) addLiterals(arm, into);
  }
}

/**
 * Aggregate location call types per target across one or more files.
 *
 * Produces the `callTypesPerTarget` map consumed by the
 * `mixedLocationCallTypes` diagnostic: keyed by lowercase target-location
 * name, each entry holds the display name and the set of call-site kinds
 * (`func` | `gosub` | `goto`) that reach it.
 */
export function collectCallTypesPerTarget(
  filesSymbols: Iterable<DocumentSymbols>,
): Map<string, { name: string; types: Set<string> }> {
  const result = new Map<string, { name: string; types: Set<string> }>();
  for (const symbols of filesSymbols) {
    for (const [, locSyms] of symbols.locations) {
      for (const [key, ref] of locSyms.locationRefs) {
        for (const r of ref.references) {
          if (!r.callType) continue;
          let entry = result.get(key);
          if (!entry) {
            entry = { name: ref.name, types: new Set() };
            result.set(key, entry);
          }
          entry.types.add(r.callType);
        }
      }
    }
  }
  return result;
}

/**
 * Build transitive propagated-locals map from the call graph.
 *
 * For every call site `gs 'target'` / `func('target')` / `@target` / `@@target`
 * that has `localsInScope`, we propagate those local names to the target.
 * If the target itself calls further locations and the variable is still
 * in scope (not redefined as local in the target), propagation continues
 * transitively.
 *
 * @param allLocations A function that yields (locName, LocationSymbols, uri)
 *   for every location across all files.  In single-file mode this iterates
 *   one DocumentSymbols; in project mode it iterates all project files.
 */
export function propagateLocals(
  allLocations: Iterable<{ locName: string; locSyms: LocationSymbols; uri: string }>,
  out: SymbolAggregates,
  /**
   * Asked every few hundred call edges; true stops the propagation and
   * drops what it found (the server is short of memory, see
   * memoryGuard.ts). The other results are still built.
   */
  shouldStop?: () => boolean,
  /** Propagate these names only (see reusePropagation). */
  onlyNames?: ReadonlySet<string>,
): void {
  runNow(propagateLocalsSteps(allLocations, out, shouldStop, onlyNames));
}

/** {@link propagateLocals} in steps, one per call edge (see slices.ts). */
export function* propagateLocalsSteps(
  allLocations: Iterable<{ locName: string; locSyms: LocationSymbols; uri: string }>,
  out: SymbolAggregates,
  shouldStop?: () => boolean,
  onlyNames?: ReadonlySet<string>,
): Steps {
  // Step 1: Index all locations and collect call edges
  const locIndex = new Map<string, { locSyms: LocationSymbols; uri: string }>();
  // propagationEdges: all gs/gosub/func/@/@@ calls (any call that propagates locals)
  const propagationEdges = new Map<string, Set<string>>();
  // initialLocals: callerLoc → [(targetLoc, localsInScope)] — only edges with own locals
  const initialLocals = new Map<string, { target: string; locals: ReadonlyMap<string, number> }[]>();

  for (const { locName, locSyms, uri } of allLocations) {
    const key = locName.toLowerCase();
    locIndex.set(key, { locSyms, uri });

    for (const [, ref] of locSyms.locationRefs) {
      for (const r of ref.references) {
        if (r.localsInScope) {
          // This is a locals-propagating call (gs/gosub/func/@/@@)
          let targets = propagationEdges.get(key);
          if (!targets) { targets = new Set(); propagationEdges.set(key, targets); }
          targets.add(ref.nameLower);

          if (r.localsInScope.size > 0) {
            let edges = initialLocals.get(key);
            if (!edges) { edges = []; initialLocals.set(key, edges); }
            edges.push({ target: ref.nameLower, locals: r.localsInScope });
          }
        }
      }
    }
  }

  // Reverse index: targetLoc → set of caller locs
  const callers = out.propagationCallers;
  for (const [callerLoc, targets] of propagationEdges) {
    for (const target of targets) {
      let s = callers.get(target);
      if (!s) { s = new Set(); callers.set(target, s); }
      s.add(callerLoc);
    }
  }

  // Step 2: what reaches each (target, name) pair. A provider is a local
  // passed by a call from where it is defined; it reaches the call's
  // target and, from there, every location the target calls, unless the
  // target's own top-level view of the name is local (it stops there).
  //
  // Every local reaches every location its callers call, so in a game
  // where most locations reach most others a pair would take a provider
  // from nearly every location: locations² per name, which ran large games
  // out of memory. A pair keeps the first MAX_PROVIDERS of those that reach
  // it, in the order of the calls that make them, plus any later one that
  // brings a type prefix or a value-bearing definition the earlier ones
  // don't: the diagnostics read only those (the union of prefixes, "is any
  // provider assigned"). Hover and navigation list a sample, as they list
  // at most a few dozen anyway.
  //
  // Chosen that way, what a pair keeps doesn't depend on the order the
  // providers arrive in, and the choice from a union is the choice from
  // the choices of its parts. So every location of a cycle of calls keeps
  // the same, and a name is propagated in one pass over the cycles
  // (strongly connected components) of its call graph, callers first; and
  // propagating some names again gives what propagating all of them would
  // (reusePropagation).
  const MAX_PROVIDERS = 8;
  const keys = [...locIndex.keys()];
  const infos = keys.map(k => locIndex.get(k)!);
  const nodeOf = new Map(keys.map((k, i) => [k, i]));
  const calls: number[][] = keys.map(k => {
    const out: number[] = [];
    for (const t of propagationEdges.get(k) ?? []) {
      const n = nodeOf.get(t);
      if (n !== undefined) out.push(n);
    }
    return out;
  });

  // `args` and `result` are QSP built-in variables with their own
  // dedicated call semantics (ARGS holds the callee's argument array;
  // RESULT is the callee's return value).  They must never be treated
  // as caller-propagated locals.
  const NO_PROPAGATE = CALL_FRAME_BUILTINS;

  // Providers numbered in the order of the calls that make them.
  const providers: PropagatedLocal[] = [];
  const rankOf = new Map<QspSymbol, number>();
  // name → node and provider rank of each call passing it, in pairs.
  const starts = new Map<string, number[]>();
  // name → caller node → targets: calls passing on a name the caller
  // doesn't define there. It reaches them through the call graph anyway,
  // unless the caller stops it; then it goes along these calls only.
  const passedOn = new Map<string, Map<number, number[]>>();
  for (const [callerLoc, edges] of initialLocals) {
    const caller = nodeOf.get(callerLoc)!;
    const callerInfo = infos[caller];
    for (const edge of edges) {
      const target = nodeOf.get(edge.target);
      if (target === undefined) continue;
      for (const [varName, scopeId] of edge.locals) {
        if (NO_PROPAGATE.has(varName)) continue;
        if (onlyNames && !onlyNames.has(varName)) continue;
        // The provider is the local in the caller at the exact scope.
        const localSym = callerInfo.locSyms.variables.get(`local\0${scopeId}\0${varName}`);
        if (!localSym || !localSym.definition) {
          let byCaller = passedOn.get(varName);
          if (!byCaller) passedOn.set(varName, byCaller = new Map());
          let targets = byCaller.get(caller);
          if (!targets) byCaller.set(caller, targets = []);
          targets.push(target);
          continue;
        }
        let rank = rankOf.get(localSym);
        if (rank === undefined) {
          rank = providers.length;
          providers.push({ providerLoc: callerLoc, providerUri: callerInfo.uri, sym: localSym });
          rankOf.set(localSym, rank);
        }
        let list = starts.get(varName);
        if (!list) starts.set(varName, list = []);
        list.push(target, rank);
      }
    }
  }

  // Ranks in order, each once: the choice a pair keeps of them.
  const choose = (ranks: number[]): number[] => {
    if (ranks.length <= MAX_PROVIDERS) return ranks;
    const kept: number[] = [];
    let prefixes = '';
    let valueBearing = false;
    for (const r of ranks) {
      const sym = providers[r].sym;
      let brings = !valueBearing && sym.hasValueDefinition === true;
      if (sym.prefixes) for (const x of sym.prefixes) if (!prefixes.includes(x)) brings = true;
      if (kept.length >= MAX_PROVIDERS && !brings) continue;
      kept.push(r);
      if (sym.prefixes) for (const x of sym.prefixes) if (!prefixes.includes(x)) prefixes += x;
      if (sym.hasValueDefinition) valueBearing = true;
    }
    return kept;
  };
  const union = (lists: number[][]): number[] => {
    if (lists.length === 1) return lists[0];
    const all = lists.flat().sort((x, y) => x - y);
    let n = 0;
    for (let i = 0; i < all.length; i++) if (i === 0 || all[i] !== all[i - 1]) all[n++] = all[i];
    all.length = n;
    return all;
  };

  const result = out.propagatedLocals;
  const count = keys.length;
  const order = new Int32Array(count);      // DFS number, -1 unvisited
  const low = new Int32Array(count);
  const comp = new Int32Array(count);       // component, -1 while open
  const onStack = new Uint8Array(count);
  const stopsAt = new Int8Array(count);     // -1 not looked up yet
  const NONE: number[] = [];
  let work = 0;

  for (const [varName, startList] of starts) {
    yield;
    heartbeat();
    if (shouldStop?.()) {
      result.clear();
      out.propagatedSyms.clear();
      out.shadowedPropagations.clear();
      break;
    }
    order.fill(-1);
    comp.fill(-1);
    stopsAt.fill(-1);
    const passed = passedOn.get(varName);
    const stops = (n: number) => {
      if (stopsAt[n] < 0) stopsAt[n] = infos[n].locSyms.findVariable(varName)?.isLocal === true ? 1 : 0;
      return stopsAt[n] === 1;
    };
    const next = (n: number) => (stops(n) ? passed?.get(n) ?? NONE : calls[n]);

    // Tarjan's algorithm, without recursion: call chains run deep.
    const components: number[][] = [];
    const stack: number[] = [];
    const frames: Array<{ node: number; i: number }> = [];
    let counter = 0;
    for (let s = 0; s < startList.length; s += 2) {
      if (order[startList[s]] >= 0) continue;
      const enter = (n: number) => {
        order[n] = low[n] = counter++;
        stack.push(n);
        onStack[n] = 1;
        frames.push({ node: n, i: 0 });
      };
      enter(startList[s]);
      while (frames.length > 0) {
        if (++work % 4096 === 0) yield;
        const frame = frames[frames.length - 1];
        const succ = next(frame.node);
        if (frame.i < succ.length) {
          const t = succ[frame.i++];
          if (order[t] < 0) enter(t);
          else if (onStack[t]) low[frame.node] = Math.min(low[frame.node], order[t]);
          continue;
        }
        frames.pop();
        const n = frame.node;
        if (frames.length > 0) {
          const up = frames[frames.length - 1].node;
          low[up] = Math.min(low[up], low[n]);
        }
        if (low[n] === order[n]) {
          const members: number[] = [];
          let m: number;
          do {
            m = stack.pop()!;
            onStack[m] = 0;
            comp[m] = components.length;
            members.push(m);
          } while (m !== n);
          components.push(members);
        }
      }
    }

    // Components come out callees first: walk them backwards, callers
    // first, handing each one's choice to the components it calls.
    const entering = new Map<number, number[]>();
    for (let s = 0; s < startList.length; s += 2) {
      let list = entering.get(startList[s]);
      if (!list) entering.set(startList[s], list = []);
      list.push(startList[s + 1]);
    }
    const incoming: number[][][] = [];
    const kept: number[][] = new Array(components.length);
    for (let c = components.length - 1; c >= 0; c--) {
      const lists = incoming[c] ?? [];
      for (const n of components[c]) {
        const own = entering.get(n);
        if (own) lists.push(union([own.slice().sort((x, y) => x - y)]));
      }
      kept[c] = choose(union(lists.length > 0 ? lists : [NONE]));
      for (const n of components[c]) {
        for (const t of next(n)) {
          if (comp[t] !== c) (incoming[comp[t]] ??= []).push(kept[c]);
        }
      }
    }

    // A provider counts as used (propagatedSyms, for unusedVariables) when
    // what it reaches uses the name, even if no pair there keeps it.
    const usesAt = (n: number) => {
      const sym = infos[n].locSyms.findVariable(varName);
      return !!sym && !sym.isLocal && sym.references.length > 0;
    };
    const reachesUse = new Uint8Array(components.length);
    for (let c = 0; c < components.length; c++) {
      for (const n of components[c]) {
        const uses = usesAt(n);
        if (uses) reachesUse[c] = 1;
        const shadows = infos[n].locSyms.localNames.has(varName);
        if (kept[c].length > 0 && (uses || shadows)) {
          const list = kept[c].map(r => providers[r]);
          const into = (map: Map<string, Map<string, PropagatedLocal[]>>) => {
            let byVar = map.get(keys[n]);
            if (!byVar) map.set(keys[n], byVar = new Map());
            byVar.set(varName, list);
          };
          if (uses) into(result);
          // Any `local varName` declaration in the target shadows the
          // propagated value, even one nested in a code block while the
          // top level uses it non-locally (`localNames` has them all).
          if (shadows) into(out.shadowedPropagations);
        }
        for (const t of next(n)) if (comp[t] !== c && reachesUse[comp[t]]) reachesUse[c] = 1;
      }
    }
    for (let s = 0; s < startList.length; s += 2) {
      if (reachesUse[comp[startList[s]]]) out.propagatedSyms.add(providers[startList[s + 1]].sym);
    }
  }

  out.propagatedLocals = inCanonicalOrder(result, locIndex.keys());
  out.shadowedPropagations = inCanonicalOrder(out.shadowedPropagations, locIndex.keys());
}

/** A propagation (propagateLocals) and the locations it was made from. */
export interface PropagationBase {
  /** In the order given, with their interface hashes (locationInterface). */
  locations: Array<{ uri: string; locSyms: LocationSymbols; iface: string }>;
  /** The aggregates it was run into. */
  agg: SymbolAggregates;
}

/** Remember the propagation in `agg` of `allLocations`, for reusePropagation. */
export function propagationBase(
  allLocations: ReadonlyArray<{ locSyms: LocationSymbols; uri: string }>,
  agg: SymbolAggregates,
): PropagationBase {
  return {
    locations: allLocations.map(({ uri, locSyms }) => ({ uri, locSyms, iface: locationInterface(locSyms) })),
    agg,
  };
}

/**
 * Put `base`'s propagation into `out` instead of running it again from
 * scratch. The propagation reads only what location interfaces cover
 * (calls and the locals in scope at them, variables, `local` names), and
 * runs name by name:
 * - while every location has the interface it had then, it would come out
 *   the same, and is kept whole;
 * - when some changed, only the names whose facts there changed
 *   (propagationFacts) can come out differently, and, where a location
 *   calls other locations with locals in scope than before, the names
 *   passed to calls that can lead to it: those are propagated again, the
 *   rest kept (see propagateLocals: a name comes out the same propagated
 *   alone or with the others).
 * Kept providers of locations analysed since are new objects, so they are
 * swapped for those under the same key in `variables` (scope ids are part
 * of the interface). Returns false, having done nothing, when neither
 * holds.
 */
export function reusePropagation(
  base: PropagationBase | undefined,
  allLocations: ReadonlyArray<{ locName: string; locSyms: LocationSymbols; uri: string }>,
  out: SymbolAggregates,
  /** See {@link propagateLocals}. */
  shouldStop?: () => boolean,
): boolean {
  return runNow(reusePropagationSteps(base, allLocations, out, shouldStop));
}

/** {@link reusePropagation} in steps (see slices.ts). */
export function* reusePropagationSteps(
  base: PropagationBase | undefined,
  allLocations: ReadonlyArray<{ locName: string; locSyms: LocationSymbols; uri: string }>,
  out: SymbolAggregates,
  shouldStop?: () => boolean,
): Steps<boolean> {
  if (!base || base.locations.length !== allLocations.length) return false;
  const swap = new Map<QspSymbol, QspSymbol>();
  const redo = new Set<string>();
  const callsChanged: string[] = [];
  let swapOk = true;
  const swapByKey = (before: LocationSymbols, now: LocationSymbols, strict: boolean) => {
    for (const [key, sym] of before.variables) {
      const next = now.variables.get(key);
      if (!next) { if (strict) swapOk = false; continue; }
      if (next !== sym) swap.set(sym, next);
    }
  };
  for (let i = 0; i < allLocations.length; i++) {
    yield;
    const before = base.locations[i];
    const { uri, locSyms } = allLocations[i];
    if (before.locSyms === locSyms) continue;
    if (before.uri !== uri || before.locSyms.locationName !== locSyms.locationName) return false;
    if (before.iface === locationInterface(locSyms)) {
      swapByKey(before.locSyms, locSyms, true);
      if (!swapOk) return false;
      continue;
    }
    if (!sameLocalsCalls(before.locSyms, locSyms)) callsChanged.push(locSyms.locationName.toLowerCase());
    const was = propagationFacts(before.locSyms), is = propagationFacts(locSyms);
    for (const [name, facts] of was) if (is.get(name) !== facts) redo.add(name);
    for (const name of is.keys()) if (!was.has(name)) redo.add(name);
    // A name kept has the same symbols under the same keys.
    swapByKey(before.locSyms, locSyms, false);
  }
  const from = base.agg;
  out.propagationCallers = from.propagationCallers;
  if (callsChanged.length > 0) {
    out.propagationCallers = localsCallers(allLocations);
    for (const name of namesLeadingTo(callsChanged, [out.propagationCallers, from.propagationCallers], allLocations)) redo.add(name);
  }
  if (swap.size === 0 && redo.size === 0) {
    out.propagatedLocals = from.propagatedLocals;
    out.shadowedPropagations = from.shadowedPropagations;
    out.propagatedSyms = from.propagatedSyms;
    return true;
  }

  const fresh = emptyAggregates();
  if (redo.size > 0) yield* propagateLocalsSteps(allLocations, fresh, shouldStop, redo);

  // Copied only where a provider is swapped: a large game has hundreds of
  // thousands of pairs, and an edit swaps the providers of a few locations.
  const swapped = (providers: PropagatedLocal[]) => {
    let copy: PropagatedLocal[] | undefined;
    for (let i = 0; i < providers.length; i++) {
      const sym = swap.get(providers[i].sym);
      if (!sym) continue;
      copy ??= providers.slice();
      copy[i] = { ...providers[i], sym };
    }
    return copy ?? providers;
  };
  const merge = (kept: Map<string, Map<string, PropagatedLocal[]>>, redone: Map<string, Map<string, PropagatedLocal[]>>) => {
    let changed = false;
    const all = new Map<string, Map<string, PropagatedLocal[]>>();
    for (const [target, byVar] of kept) {
      let vars: Map<string, PropagatedLocal[]> | undefined;
      for (const [name, providers] of byVar) {
        const now = redo.has(name) ? undefined : swapped(providers);
        if (now === providers && !vars) continue;
        if (!vars) {
          // The names before this one were kept as they are.
          vars = new Map();
          for (const [n, p] of byVar) {
            if (n === name) break;
            vars.set(n, p);
          }
        }
        if (now) vars.set(name, now);
      }
      if (vars) changed = true;
      const result = vars ?? byVar;
      if (result.size > 0) all.set(target, result);
    }
    if (redo.size === 0) return changed ? all : kept;
    for (const [target, byVar] of redone) {
      const vars = new Map(all.get(target));
      for (const [name, providers] of byVar) vars.set(name, providers);
      all.set(target, vars);
    }
    return inCanonicalOrder(all, allLocations.map(l => l.locName.toLowerCase()));
  };
  out.propagatedLocals = merge(from.propagatedLocals, fresh.propagatedLocals);
  out.shadowedPropagations = merge(from.shadowedPropagations, fresh.shadowedPropagations);
  out.propagatedSyms = new Set(fresh.propagatedSyms);
  for (const sym of from.propagatedSyms) if (!redo.has(sym.nameLower)) out.propagatedSyms.add(swap.get(sym) ?? sym);
  return true;
}

// Caller locations of each location, by the calls that pass locals
// (propagationCallers).
function localsCallers(allLocations: Iterable<{ locName: string; locSyms: LocationSymbols }>): Map<string, Set<string>> {
  const callers = new Map<string, Set<string>>();
  for (const { locName, locSyms } of allLocations) {
    for (const [, ref] of locSyms.locationRefs) {
      if (!ref.references.some(r => r.localsInScope)) continue;
      let s = callers.get(ref.nameLower);
      if (!s) callers.set(ref.nameLower, s = new Set());
      s.add(locName.toLowerCase());
    }
  }
  return callers;
}

// The names passed to calls that can lead to one of `changed` (in either
// call graph, given as callers): only their propagation goes through it.
function namesLeadingTo(
  changed: string[],
  callerMaps: Array<Map<string, Set<string>>>,
  allLocations: Iterable<{ locSyms: LocationSymbols }>,
): Set<string> {
  const reach = new Set(changed);
  const queue = [...changed];
  while (queue.length > 0) {
    const loc = queue.pop()!;
    for (const map of callerMaps) {
      for (const caller of map.get(loc) ?? []) {
        if (!reach.has(caller)) {
          reach.add(caller);
          queue.push(caller);
        }
      }
    }
  }
  const names = new Set<string>();
  for (const { locSyms } of allLocations) {
    for (const [, ref] of locSyms.locationRefs) {
      if (!reach.has(ref.nameLower)) continue;
      for (const r of ref.references) for (const name of r.localsInScope?.keys() ?? []) names.add(name);
    }
  }
  return names;
}

// What the propagation reads of a location, name by name: its symbols of
// that name (key, local or not, used, defined, prefixes, given a value),
// whether it declares the name `local`, and the calls it passes the name
// to, in order, with the scope it is passed from.
function propagationFacts(l: LocationSymbols): Map<string, string> {
  const facts = new Map<string, string>();
  const add = (name: string, fact: string) => facts.set(name, (facts.get(name) ?? '') + fact + '\n');
  for (const [key, sym] of l.variables) {
    const prefixes = sym.prefixes ? [...sym.prefixes].sort().join('') : '';
    add(sym.nameLower, `${key}\0${sym.isLocal}\0${sym.references.length > 0}\0${!!sym.definition}\0${prefixes}\0${!!sym.hasValueDefinition}`);
  }
  for (const name of l.localNames) add(name, 'local');
  for (const [, ref] of l.locationRefs) {
    for (const r of ref.references) for (const [name, scopeId] of r.localsInScope ?? []) add(name, `call\0${ref.nameLower}\0${scopeId}`);
  }
  return facts;
}

// Whether two versions of a location call the same locations, in the same
// order, at places where locals are in scope: the call graph the
// propagation walks, as far as this location goes.
function sameLocalsCalls(a: LocationSymbols, b: LocationSymbols): boolean {
  const targets = (l: LocationSymbols) => {
    const out: string[] = [];
    for (const [, ref] of l.locationRefs) if (ref.references.some(r => r.localsInScope)) out.push(ref.nameLower);
    return out;
  };
  const x = targets(a), y = targets(b);
  return x.length === y.length && x.every((t, i) => t === y[i]);
}

// Targets in the order of the locations, names in alphabetical order: the
// same whether the propagation ran whole or a few names of it again (the
// diagnostics come out in this order).
function inCanonicalOrder(
  byTarget: Map<string, Map<string, PropagatedLocal[]>>,
  locationKeys: Iterable<string>,
): Map<string, Map<string, PropagatedLocal[]>> {
  const sorted = new Map<string, Map<string, PropagatedLocal[]>>();
  for (const key of locationKeys) {
    const byVar = byTarget.get(key);
    if (!byVar || sorted.has(key)) continue;
    sorted.set(key, new Map([...byVar].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))));
  }
  return sorted;
}

// ── Propagation in the analysis cache ────────────────────────────────

/**
 * A propagation (propagateLocals) as the analysis cache keeps it: names
 * in one table, everything else numbers indexing it, so a large game's
 * million providers make a few typed arrays rather than a million objects.
 * A provider is its location and its key in that location's `variables`.
 */
export interface StoredPropagation {
  names: string[];
  /** Per target: name, count of names; per name: name, count of providers; per provider: location, key. */
  locals: Uint32Array;
  /** As `locals`. */
  shadowed: Uint32Array;
  /** Location and key of each symbol in `propagatedSyms`. */
  syms: Uint32Array;
  /** Per target: name, count of callers, the callers. */
  callers: Uint32Array;
}

// The location each lowercase name stands for, as propagateLocals indexes
// them (a later one of the same name wins).
function locationsByKey(allLocations: Iterable<{ locName: string; locSyms: LocationSymbols; uri: string }>) {
  const byKey = new Map<string, { locSyms: LocationSymbols; uri: string }>();
  for (const { locName, locSyms, uri } of allLocations) byKey.set(locName.toLowerCase(), { locSyms, uri });
  return byKey;
}

/** `agg`'s propagation of `allLocations`, to store; undefined when a provider can't be named. */
export function* storedPropagationSteps(
  agg: SymbolAggregates,
  allLocations: Iterable<{ locName: string; locSyms: LocationSymbols; uri: string }>,
): Steps<StoredPropagation | undefined> {
  const where = new Map<QspSymbol, { loc: string; key: string }>();
  for (const [loc, { locSyms }] of locationsByKey(allLocations)) {
    yield;
    for (const [key, sym] of locSyms.variables) if (!where.has(sym)) where.set(sym, { loc, key });
  }
  const names: string[] = [];
  const indexes = new Map<string, number>();
  const name = (s: string) => {
    let n = indexes.get(s);
    if (n === undefined) {
      n = names.length;
      names.push(s);
      indexes.set(s, n);
    }
    return n;
  };
  function* byTarget(map: Map<string, Map<string, PropagatedLocal[]>>): Steps<Uint32Array | undefined> {
    const out: number[] = [];
    for (const [target, byVar] of map) {
      yield;
      out.push(name(target), byVar.size);
      for (const [varName, providers] of byVar) {
        out.push(name(varName), providers.length);
        for (const p of providers) {
          const at = where.get(p.sym);
          if (!at || at.loc !== p.providerLoc) return undefined;
          out.push(name(at.loc), name(at.key));
        }
      }
    }
    return Uint32Array.from(out);
  }
  const locals = yield* byTarget(agg.propagatedLocals);
  const shadowed = yield* byTarget(agg.shadowedPropagations);
  if (!locals || !shadowed) return undefined;
  const syms: number[] = [];
  let sinceYield = 0;
  for (const sym of agg.propagatedSyms) {
    if (++sinceYield % 1024 === 0) yield;
    const at = where.get(sym);
    if (!at) return undefined;
    syms.push(name(at.loc), name(at.key));
  }
  const callers: number[] = [];
  for (const [target, from] of agg.propagationCallers) {
    yield;
    callers.push(name(target), from.size);
    for (const caller of from) callers.push(name(caller));
  }
  return { names, locals, shadowed, syms: Uint32Array.from(syms), callers: Uint32Array.from(callers) };
}

/**
 * Put a stored propagation of `allLocations` into `out`, its providers
 * found in their symbols as they are now. Returns false, having done
 * nothing, when it doesn't fit them (or isn't one).
 */
export function* loadPropagationSteps(
  stored: unknown,
  allLocations: Iterable<{ locName: string; locSyms: LocationSymbols; uri: string }>,
  out: SymbolAggregates,
): Steps<boolean> {
  const s = stored as Partial<StoredPropagation> | undefined;
  if (!s || !Array.isArray(s.names) || !(s.locals instanceof Uint32Array) || !(s.shadowed instanceof Uint32Array)
    || !(s.syms instanceof Uint32Array) || !(s.callers instanceof Uint32Array)) return false;
  const names = s.names;
  const byKey = locationsByKey(allLocations);
  const text = (n: number | undefined) => (n === undefined ? undefined : names[n]);
  const symAt = (loc: string | undefined, key: string | undefined) =>
    loc === undefined || key === undefined ? undefined : byKey.get(loc)?.locSyms.variables.get(key);
  function* byTarget(a: Uint32Array): Steps<Map<string, Map<string, PropagatedLocal[]>> | undefined> {
    const map = new Map<string, Map<string, PropagatedLocal[]>>();
    let i = 0;
    while (i < a.length) {
      yield;
      const target = text(a[i++]);
      const nVars = a[i++];
      if (target === undefined || nVars === undefined) return undefined;
      const byVar = new Map<string, PropagatedLocal[]>();
      for (let v = 0; v < nVars; v++) {
        const varName = text(a[i++]);
        const nProviders = a[i++];
        if (varName === undefined || nProviders === undefined) return undefined;
        const providers: PropagatedLocal[] = [];
        for (let k = 0; k < nProviders; k++) {
          const loc = text(a[i++]);
          const sym = symAt(loc, text(a[i++]));
          if (!sym) return undefined;
          providers.push({ providerLoc: loc!, providerUri: byKey.get(loc!)!.uri, sym });
        }
        byVar.set(varName, providers);
      }
      map.set(target, byVar);
    }
    return map;
  }
  const locals = yield* byTarget(s.locals);
  const shadowed = yield* byTarget(s.shadowed);
  if (!locals || !shadowed) return false;
  const syms = new Set<QspSymbol>();
  for (let i = 0; i < s.syms.length; i += 2) {
    if (i % 2048 === 0) yield;
    const sym = symAt(text(s.syms[i]), text(s.syms[i + 1]));
    if (!sym) return false;
    syms.add(sym);
  }
  const callers = new Map<string, Set<string>>();
  for (let i = 0; i < s.callers.length;) {
    yield;
    const target = text(s.callers[i++]);
    const n = s.callers[i++];
    if (target === undefined || n === undefined) return false;
    const from = new Set<string>();
    for (let k = 0; k < n; k++) {
      const caller = text(s.callers[i++]);
      if (caller === undefined) return false;
      from.add(caller);
    }
    callers.set(target, from);
  }
  out.propagatedLocals = locals;
  out.shadowedPropagations = shadowed;
  out.propagatedSyms = syms;
  out.propagationCallers = callers;
  return true;
}

/**
 * propagateLocals, then finishAggregates: every aggregate the call graph
 * gives.
 */
export function buildPropagatedLocals(
  allLocations: Iterable<{ locName: string; locSyms: LocationSymbols; uri: string }>,
  out: SymbolAggregates,
  /** See {@link propagateLocals}. */
  shouldStop?: () => boolean,
): void {
  const locations = [...allLocations];
  propagateLocals(locations, out, shouldStop);
  finishAggregates(locations, out);
}

/**
 * Everything the aggregates take from the propagation (see
 * propagateLocals, already run into `out`) and the locations' symbols as
 * they are now: write-backs into callers' locals, dispatches of stored
 * code blocks, the refined `globallyRead`, `result` writers and `args`
 * use. Cheap next to the propagation, and the only part that holds
 * positions, so a propagation reused across an edit gets them right.
 */
export function finishAggregates(
  allLocations: Iterable<{ locName: string; locSyms: LocationSymbols; uri: string }>,
  out: SymbolAggregates,
): void {
  runNow(finishAggregatesSteps(allLocations, out));
}

/** {@link finishAggregates} in steps, one per location of each pass (see slices.ts). */
export function* finishAggregatesSteps(
  allLocations: Iterable<{ locName: string; locSyms: LocationSymbols; uri: string }>,
  out: SymbolAggregates,
): Steps {
  const locIndex = new Map<string, { locSyms: LocationSymbols; uri: string }>();
  for (const { locName, locSyms, uri } of allLocations) locIndex.set(locName.toLowerCase(), { locSyms, uri });
  const result = out.propagatedLocals;
  out.runVariables = runVariablesOf(out.valueFlows);

  // ────────────────────────────────────────────────────────────────────
  // Post-pass: call-graph-sensitive dataflow.
  //
  // For every (targetLoc, varName) → providers[] entry in propagatedLocals,
  // collect the target's non-local bindings of varName and attach them to
  // each provider's local QspSymbol.  Under QSP gs-call semantics the
  // callee's bare `x = …` is a write to the caller's local, so those
  // bindings are additional possible values for that local.
  //
  // Dedup key = `${sourceLoc}\0${stmtLoc.line},${stmtLoc.column}` — the
  // same callee binding may be reached through multiple propagation paths
  // but should only be reported once per provider.
  // ────────────────────────────────────────────────────────────────────
  const ext = out.externalLocalBindings;
  // Dedup memo of the second post-pass below: for each provider QspSymbol,
  // the (source location, statement position) pairs already pushed to
  // ext.get(sym), made from its list on first use.
  const extSeen = new Map<QspSymbol, Map<string, Set<number>>>();
  const seenAt = (sym: QspSymbol, sourceLoc: string): Set<number> => {
    let bySource = extSeen.get(sym);
    if (!bySource) {
      bySource = new Map();
      extSeen.set(sym, bySource);
      for (const e of ext.get(sym) ?? []) seenIn(bySource, e.sourceLoc).add(positionKey(e.binding.stmtLoc));
    }
    return seenIn(bySource, sourceLoc);
  };
  for (const [targetLoc, byVar] of result) {
    yield;
    const targetInfo = locIndex.get(targetLoc);
    if (!targetInfo) continue;
    const targetBindings = targetInfo.locSyms.variableBindings;
    if (!targetBindings || targetBindings.size === 0) continue;

    for (const [varName, providers] of byVar) {
      // `variableBindings` is keyed by the lowercased BASE name (no
      // `$/#/%` prefix) since modern QSP collapses every prefix into
      // a single underlying value.  `propagatedLocals` is also keyed
      // by base name, so the lookup is a direct hit.
      const calleeBindings = targetBindings.get(varName);
      if (!calleeBindings || calleeBindings.length === 0) continue;

      // Only non-local bindings mutate the caller's local.  A `local x = …`
      // inside the callee is shadowed and doesn't flow back.
      // One per statement position, as the dedup below keyed them.
      const nonLocalBindings: VariableBinding[] = [];
      const positions = new Set<number>();
      for (const b of calleeBindings) {
        if (b.isLocal) continue;
        const k = positionKey(b.stmtLoc);
        if (positions.has(k)) continue;
        positions.add(k);
        nonLocalBindings.push(b);
      }
      if (nonLocalBindings.length === 0) continue;

      // No dedup needed here: a pair's providers are distinct, and a
      // provider of this name reaches this target through this pair only.
      for (const p of providers) {
        let list = ext.get(p.sym);
        if (!list) { list = []; ext.set(p.sym, list); }
        for (const cb of nonLocalBindings) {
          list.push({
            binding: cb,
            sourceLoc: targetLoc,
            sourceUri: targetInfo.uri,
            varNameLower: varName,
          });
        }
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Post-pass: cross-location var-mediated dispatch.
  //
  // Callee `dynamic $code` / `dyneval($code, …)` that found no visible
  // code-block binding locally may still be resolvable via a propagated
  // local from an upstream caller.  For each such unresolved call:
  //
  //   1. Look up `propagatedLocals[calleeLoc][baseOf($code)]` to find
  //      the upstream providers of `$code`.
  //   2. For each provider, inspect its stored `$code` bindings; every
  //      code-block value carries a `bodyWrites` list captured at
  //      extraction time.
  //   3. For each body write `w = value`, look up which provider(s)
  //      supplied the caller-local `w` to the callee; flow the write
  //      back onto those providers' locals via `externalLocalBindings`.
  //
  // Conceptually this mirrors the simple-gs case (bare writes in a
  // direct callee flow back to caller locals), but over an extra
  // indirection — the write is written in provider P as "what $code
  // does when invoked", and invoked in the callee K whose scope is
  // also fed by P (or upstream).
  //
  // `sourceLoc` on each ExternalBinding is set to the callee location
  // (where the dispatch happens), matching the semantic pattern of
  // "this value reaches the caller's local because of the call to K".
  // ────────────────────────────────────────────────────────────────────
  for (const [calleeLoc, calleeInfo] of locIndex) {
    yield;
    const unresolved = calleeInfo.locSyms.unresolvedDynamicVarCalls;
    if (unresolved.length === 0) continue;
    const byVar = result.get(calleeLoc);
    if (!byVar || byVar.size === 0) continue;

    for (const call of unresolved) {
      const varBase = call.varBaseName;
      const codeProviders = byVar.get(varBase);
      if (!codeProviders || codeProviders.length === 0) continue;

      for (const codeProvider of codeProviders) {
        const providerInfo = locIndex.get(codeProvider.providerLoc);
        if (!providerInfo) continue;
        const providerBindings =
          providerInfo.locSyms.variableBindings.get(varBase);
        if (!providerBindings || providerBindings.length === 0) continue;

        // A local holder: only the bindings of the propagated symbol; one
        // in another scope is shadowed or unrelated.
        const holderBindings = codeProvider.sym.isLocal
          ? bindingsOfLocal(providerBindings, codeProvider.sym)
          : providerBindings.filter(b => !b.isLocal);
        for (const pb of holderBindings) {
          if (pb.value.kind !== 'code-block') continue;
          const writes = pb.value.bodyWrites;
          if (!writes || writes.length === 0) continue;

          for (const w of writes) {
            // A local declaration inside the block (`local y = …`) is
            // scoped to the block and does not flow back.
            if (w.binding.isLocal) continue;
            const innerBase = w.varBaseName;

            // Mark this write as "alive via cross-call" so the
            // unused-variable diagnostic does not falsely flag the
            // global symbol that the parser created from the bare
            // `x = 42` inside the scope-isolating block.
            out.crossCallWrites.add(
              `${providerInfo.uri}\0${w.binding.stmtLoc.line},${w.binding.stmtLoc.column}`,
            );

            // Find the caller-local symbol(s) the write should flow
            // back to.  First-choice: the propagated-locals index —
            // same record used by the simple-gs post-pass; contains
            // the authoritative provider(s) of `innerBase` reaching
            // the callee, even across multi-hop chains.
            //
            // Fallback: when the callee never textually references
            // `innerBase`, propagatedLocals doesn't record it (only
            // "sinks" are recorded).  But the write still happens at
            // runtime against the provider's local.  Scan the
            // codeProvider's own locals for a same-name local as the
            // flow-back target.
            let targetSyms: QspSymbol[] = [];
            const innerProviders = byVar.get(innerBase);
            if (innerProviders && innerProviders.length > 0) {
              targetSyms = innerProviders.map(p => p.sym);
            } else {
              for (const sym of providerInfo.locSyms.ownedVariables) {
                if (!sym.isLocal) continue;
                if (sym.nameLower !== innerBase) continue;
                targetSyms.push(sym);
              }
            }
            if (targetSyms.length === 0) continue;

            for (const targetSym of targetSyms) {
              let list = ext.get(targetSym);
              if (!list) { list = []; ext.set(targetSym, list); }
              const seen = seenAt(targetSym, calleeLoc);
              const dedupKey = positionKey(w.binding.stmtLoc);
              if (seen.has(dedupKey)) continue;
              seen.add(dedupKey);
              list.push({
                binding: w.binding,
                sourceLoc: calleeLoc,
                sourceUri: calleeInfo.uri,
                varNameLower: innerBase,
              });
            }
          }
        }
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Post-pass: cross-location global dispatch resolution.
  //
  // An `unresolvedDynamicVarCalls` entry that still has no candidate
  // after the propagated-locals pass above may still resolve via a
  // *global* code-block binding written in another location.  In
  //   # init
  //   $dispatch = { result = 42 }
  //   -
  //   # other
  //   res = dyneval($dispatch)
  //   -
  // the `dyneval` call in `other` has no local binding for `dispatch`
  // and no caller-propagated provider — but at runtime QSP resolves
  // `$dispatch` against the global namespace and finds `init`'s write.
  //
  // We build a project-wide index of every non-local code-block
  // binding once and then look up each unresolved call's varBase to
  // collect candidates.  The result feeds the cross-location variants
  // of the `missingResultInDyneval` and `extraArgsToTargetWithoutArgs`
  // diagnostics; no `externalLocalBindings` flow-back is needed
  // because every write inside the block already targets a true
  // global (not a caller-local).
  //
  // We intentionally do NOT use this fallback as a tie-breaker when
  // propagated-locals already found candidates — the two channels
  // describe different runtime behaviours (caller-local vs. global)
  // and should not be conflated.  The resolution is "global iff no
  // local/caller binding exists at this call site".
  // ────────────────────────────────────────────────────────────────────
  type GlobalProvider = { providerLoc: string; providerUri: string; binding: VariableBinding };
  let globalCodeBlockIndex: Map<string, GlobalProvider[]> | undefined;
  const buildGlobalIndex = (): Map<string, GlobalProvider[]> => {
    const idx = new Map<string, GlobalProvider[]>();
    for (const [providerLoc, info] of locIndex) {
      for (const [varBase, bindings] of info.locSyms.variableBindings) {
        for (const b of bindings) {
          if (b.isLocal) continue;
          if (b.value.kind !== 'code-block') continue;
          let arr = idx.get(varBase);
          if (!arr) { arr = []; idx.set(varBase, arr); }
          arr.push({ providerLoc, providerUri: info.uri, binding: b });
        }
      }
    }
    return idx;
  };

  // Pre-compute writesResult / argsUsage for a candidate block.
  // `result` and `args` are non-local symbols at the provider; we
  // filter their references to those inside the block range.
  const computeBlockFacts = (
    providerLocSyms: LocationSymbols,
    blockRange: SymbolLocation,
  ): { writesResult: boolean; argsUsage: ArgsUsage | undefined } => {
    const resultSym = providerLocSyms.variables.get(RESULT_VAR_NAME);
    let writesResult = false;
    if (resultSym) {
      for (const ref of resultSym.references) {
        if (!ref.isDefinition) continue;
        if (locContains(blockRange, ref)) { writesResult = true; break; }
      }
    }
    const argsSym = providerLocSyms.variables.get(ARGS_VAR_NAME);
    let argsUsage: ArgsUsage | undefined;
    if (argsSym) {
      let hasOpaque = false;
      let maxLiteralIdx = -1;
      let hasAnyRef = false;
      for (const ref of argsSym.references) {
        if (!locContains(blockRange, ref)) continue;
        hasAnyRef = true;
        if (!ref.argsConsumer) continue;
        if (ref.argsIndex === undefined) hasOpaque = true;
        else if (ref.argsIndex > maxLiteralIdx) maxLiteralIdx = ref.argsIndex;
      }
      if (hasAnyRef) argsUsage = { hasOpaque, maxLiteralIdx };
    }
    return { writesResult, argsUsage };
  };

  const crossLoc = out.crossLocationDispatches;

  /**
   * Collect every global code-block candidate for `varBaseName`.
   * Excludes the named location if `excludeSelfLoc` is provided
   * (used by the regular cross-loc pass to skip bindings the
   * intra-location pass already searched).
   */
  // Every block kept under a name, worked out once per name rather than
  // once per call site that dispatches it.
  const blocksByName = new Map<string, CrossLocationDispatchTarget[]>();
  const blocksNamed = (varBaseName: string): CrossLocationDispatchTarget[] => {
    let all = blocksByName.get(varBaseName);
    if (all) return all;
    all = [];
    if (!globalCodeBlockIndex) globalCodeBlockIndex = buildGlobalIndex();
    for (const p of globalCodeBlockIndex.get(varBaseName) ?? []) {
      const providerInfo = locIndex.get(p.providerLoc);
      if (!providerInfo) continue;
      if (p.binding.value.kind !== 'code-block') continue;
      const { writesResult, argsUsage } = computeBlockFacts(
        providerInfo.locSyms, p.binding.value.blockRange,
      );
      all.push({ providerLoc: p.providerLoc, providerUri: p.providerUri, binding: p.binding, writesResult, argsUsage });
    }
    blocksByName.set(varBaseName, all);
    return all;
  };
  const collectCandidates = (
    varBaseName: string,
    excludeSelfLoc: string | null,
  ): { candidates: CrossLocationDispatchTarget[]; truncated: boolean } => {
    const candidates: CrossLocationDispatchTarget[] = [];
    for (const c of blocksNamed(varBaseName)) {
      if (excludeSelfLoc !== null && c.providerLoc === excludeSelfLoc) continue;
      if (candidates.length === MAX_DISPATCH_CANDIDATES) return { candidates, truncated: true };
      candidates.push(c);
    }
    return { candidates, truncated: false };
  };

  const recordDispatch = (
    calleeLoc: string,
    call: { loc: SymbolLocation; kind: 'dynamic' | 'dyneval'; argCount: number; varName: string; varBaseName: string },
    found: { candidates: CrossLocationDispatchTarget[]; truncated: boolean },
  ) => {
    let list = crossLoc.get(calleeLoc);
    if (!list) { list = []; crossLoc.set(calleeLoc, list); }
    list.push({
      callLoc: call.loc,
      kind: call.kind,
      argCount: call.argCount,
      varName: call.varName,
      varBaseName: call.varBaseName,
      candidates: found.candidates,
      ...(found.truncated ? { truncated: true } : {}),
    });
  };

  for (const [calleeLoc, calleeInfo] of locIndex) {
    yield;
    const unresolved = calleeInfo.locSyms.unresolvedDynamicVarCalls;
    if (unresolved.length === 0) continue;
    const byVar = result.get(calleeLoc);

    for (const call of unresolved) {
      // Propagated caller-local shadows the global.  Once any caller
      // propagates `local $x` into this callee, the callee's frame
      // sees that local — the global namespace lookup for `$x` is
      // shadowed.  Skip cross-loc resolution regardless of whether
      // the propagated local happens to hold a code-block (if it
      // does, the propagated-locals pass already flowed its
      // bodyWrites back; if it doesn't, the call is a runtime error
      // we can't statically predict, but it's still NOT a dispatch
      // to the global).
      if (byVar?.get(call.varBaseName)?.length) continue;

      // Exclude self-loc: those bindings were already searched by
      // the intra-location pass; if they were visible, the call
      // wouldn't be unresolved.
      const found = collectCandidates(call.varBaseName, calleeLoc);
      if (found.candidates.length === 0) continue;
      recordDispatch(calleeLoc, call, found);
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Post-pass: deferred-body dispatch resolution.
  //
  // `deferredDynamicVarCalls` are var-mediated calls whose enclosing
  // code runs at *click time* in a fresh frame: either lifted from
  // `<a href="exec:…">` link bodies (merged by the embedded-exec
  // sub-walker) or routed directly from `act 'name': … end` action
  // bodies (by `bindingCollector` when the call's lexical container
  // is an `act_block`/`act_inline`).  They have global-namespace-only
  // visibility:
  //
  //   • caller-propagated locals cannot reach this frame — the
  //     propagated-locals dispatch channel is NOT consulted;
  //   • the host (callee) location's own globals ARE visible — the
  //     self-loc exclusion that applies to normal cross-loc resolution
  //     does NOT apply here (exec-body entries come from a sub-walker
  //     that never saw host's bindings; act-body entries come from a
  //     pass that already failed intra-loc lookup).
  // ────────────────────────────────────────────────────────────────────
  for (const [calleeLoc, calleeInfo] of locIndex) {
    yield;
    const deferredCalls = calleeInfo.locSyms.deferredDynamicVarCalls;
    if (deferredCalls.length === 0) continue;

    for (const call of deferredCalls) {
      const found = collectCandidates(call.varBaseName, /*excludeSelfLoc*/ null);
      if (found.candidates.length === 0) continue;
      recordDispatch(calleeLoc, call, found);
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Post-pass: refine globallyRead.
  //
  // `collectAggregates` populated `globallyRead` before propagation data
  // was available, so it may include names whose proper-usage reads
  // are actually consuming a propagated-in local rather than a genuine
  // global.  Rebuild the set with the rule:
  //
  //   A name `x` is genuinely globally read iff there exists at least
  //   one location L containing a proper-usage read of `x` on the
  //   non-local symbol where `x` is NOT propagated as a caller-local
  //   into L.
  //
  // We iterate only non-local symbols' reference lists.  The parser
  // (`addVariable` → `findLocalSym`) already attributes each ref to
  // either a scoped local or the non-local symbol based on lexical
  // visibility — so a ref reaching the non-local list cannot resolve
  // to any local in the location, regardless of whether the location
  // happens to declare a same-named local in some unreachable scope
  // (nested inline/multiline branch, scope-isolating code block, …).
  // Filtering by `localNames.has(sym.nameLower)` here would discard
  // those genuine non-local reads and produce false-positive
  // unused-variable diagnostics on the corresponding writes.
  // ────────────────────────────────────────────────────────────────────
  out.globallyRead.clear();
  for (const [locKey, { locSyms }] of locIndex) {
    yield;
    const propagatedIntoLoc = out.propagatedLocals.get(locKey);
    for (const sym of locSyms.ownedVariables) {
      if (sym.isLocal) continue;
      if (propagatedIntoLoc?.has(sym.nameLower)) continue;
      if (out.globallyRead.has(sym.nameLower)) continue;
      if (!sym.references.some(ref => ref.isProperUsage)) continue;
      out.globallyRead.add(sym.nameLower);
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Post-pass: locationsWritingResult.
  //
  // A location L "writes result" iff its body has a value-bearing
  // assignment to `result`.  No transitive closure: `result` is a
  // per-call-frame local (every gs/gosub/func/@/@@/dyneval/dynamic call gets
  // a fresh one), so a callee writing `result` does not satisfy the
  // caller's own need to set `result`.
  // ────────────────────────────────────────────────────────────────────
  const writers = out.locationsWritingResult;
  writers.clear();
  const argsUsage = out.argsUsageByLoc;
  argsUsage.clear();
  for (const [locKey, { locSyms }] of locIndex) {
    yield;
    // Collect every code-block range in this location once: inline
    // dynamic/dyneval-arg blocks plus stored blocks bound to a
    // variable.  Both `result` and `args` are fresh per call frame at
    // runtime, so any reference inside such a block belongs to the
    // block's own frame — not the enclosing location's.
    const blockRanges: Array<{ line: number; column: number; endLine: number; endColumn: number }> = [];
    for (const b of locSyms.resolvedDynamicBlocks) {
      for (const loc of b.blockLocs) blockRanges.push(loc);
    }
    for (const [, bindings] of locSyms.variableBindings) {
      for (const b of bindings) {
        if (b.value.kind === 'code-block') blockRanges.push(b.value.blockRange);
      }
    }

    const isOutsideBlocks = (ref: { line: number; column: number; endLine: number; endColumn: number }) => {
      for (const r of blockRanges) {
        if (locContains(r, ref)) return false;
      }
      return true;
    };

    // ── locationsWritingResult ──────────────────────────────────
    // A location "writes result" iff at least one value-bearing
    // assignment to the built-in (non-local) `result` lies outside
    // every code-block range in the location.  Block-internal writes
    // hit the block's own per-frame `result` and do NOT satisfy the
    // enclosing location's contract.
    //
    // `variables.get('result')` is the bare-keyed entry — by
    // construction the non-local symbol (locals live under
    // `local\0scopeId\0result`).  We then scan its references for
    // `isDefinition` outside all block ranges; a hit guarantees a
    // top-level value-bearing write because a bare `local result`
    // declaration would be on a different, local-keyed symbol.
    const resultSym = locSyms.variables.get(RESULT_VAR_NAME);
    if (resultSym?.hasValueDefinition) {
      if (blockRanges.length === 0) {
        writers.add(locKey);
      } else {
        for (const ref of resultSym.references) {
          if (!ref.isDefinition) continue;
          if (isOutsideBlocks(ref)) { writers.add(locKey); break; }
        }
      }
    }

    // ── argsUsageByLoc ──────────────────────────────────────────
    // A location "uses args" iff it has at least one reference to the
    // built-in (non-local) `args` outside any code block in its own
    // body.  Same per-frame argument as `result` above.
    //
    // A `local args` declaration lives on a separate scoped symbol;
    // a location with ONLY `local args` and no built-in usage returns
    // undefined here and is skipped.
    //
    // For locations that do use args, we additionally summarise the
    // index profile (max literal index, opaque flag) so the
    // `extraArgsToTargetWithoutArgs` diagnostic can detect partial
    // consumption (`pl args[0]` when caller passes two extras).
    const argsSym = locSyms.variables.get(ARGS_VAR_NAME);
    if (!argsSym) continue;

    let hasOpaque = false;
    let maxLiteralIdx = -1;
    let hasAnyRefOutsideBlocks = false;
    for (const ref of argsSym.references) {
      if (blockRanges.length > 0 && !isOutsideBlocks(ref)) continue;
      hasAnyRefOutsideBlocks = true;
      if (!ref.argsConsumer) continue;  // pure write — not a consumer
      if (ref.argsIndex === undefined) hasOpaque = true;
      else if (ref.argsIndex > maxLiteralIdx) maxLiteralIdx = ref.argsIndex;
    }
    if (hasAnyRefOutsideBlocks) {
      argsUsage.set(locKey, { hasOpaque, maxLiteralIdx });
    }
  }
}

// A statement's position as one number: exact up to columns of 2^24 (a
// line of 16 M characters).
function positionKey(loc: SymbolLocation): number {
  return loc.line * 16_777_216 + loc.column;
}

function seenIn(bySource: Map<string, Set<number>>, sourceLoc: string): Set<number> {
  let seen = bySource.get(sourceLoc);
  if (!seen) {
    seen = new Set();
    bySource.set(sourceLoc, seen);
  }
  return seen;
}

/** Inclusive containment test for SymbolLocation-shaped ranges. */
function locContains(
  outer: { line: number; column: number; endLine: number; endColumn: number },
  inner: { line: number; column: number; endLine: number; endColumn: number },
): boolean {
  if (inner.line < outer.line) return false;
  if (inner.line === outer.line && inner.column < outer.column) return false;
  if (inner.endLine > outer.endLine) return false;
  if (inner.endLine === outer.endLine && inner.endColumn > outer.endColumn) return false;
  return true;
}

/**
 * The single-file aggregates of an open document, made once per state
 * (`aggCache`) and reusing the propagation of the state before it while
 * no location's interface changed (`propagation`, carried over by the
 * server; see reusePropagation).
 */
export function fileAggregates(
  state: { symbols: DocumentSymbols; aggCache?: SymbolAggregates; propagation?: PropagationBase },
  uri: string,
  /** See {@link propagateLocals}. */
  shouldStop?: () => boolean,
): SymbolAggregates {
  return runNow(fileAggregatesSteps(state, uri, shouldStop));
}

/** {@link fileAggregates} in steps (see slices.ts). */
export function* fileAggregatesSteps(
  state: { symbols: DocumentSymbols; aggCache?: SymbolAggregates; propagation?: PropagationBase },
  uri: string,
  shouldStop?: () => boolean,
): Steps<SymbolAggregates> {
  if (state.aggCache) return state.aggCache;
  const agg = emptyAggregates();
  collectAggregates(state.symbols.locations.values(), agg);
  const locations = [...state.symbols.locations.values()].map(locSyms => ({ locName: locSyms.locationName, locSyms, uri }));
  if (!(yield* reusePropagationSteps(state.propagation, locations, agg, shouldStop))) {
    yield* propagateLocalsSteps(locations, agg, shouldStop);
  }
  yield* finishAggregatesSteps(locations, agg);
  state.propagation = propagationBase(locations, agg);
  state.aggCache = agg;
  return agg;
}

/**
 * Build a fresh single-file `SymbolAggregates` for `docSyms` —
 * `collectAggregates` followed by `buildPropagatedLocals`.  The
 * caller is responsible for caching the result.
 */
export function buildFileAggregates(
  docSyms: DocumentSymbols,
  uri: string,
  /** See {@link buildPropagatedLocals}. */
  shouldStop?: () => boolean,
): SymbolAggregates {
  const a = emptyAggregates();
  collectAggregates(docSyms.locations.values(), a);
  const allLocs: { locName: string; locSyms: LocationSymbols; uri: string }[] = [];
  for (const [, ls] of docSyms.locations) {
    allLocs.push({ locName: ls.locationName, locSyms: ls, uri });
  }
  buildPropagatedLocals(allLocs, a, shouldStop);
  return a;
}
