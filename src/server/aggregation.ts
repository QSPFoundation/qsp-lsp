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
}

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
    globalPrefixes: new Map(),
    propagatedLocals: new Map(),
    shadowedPropagations: new Map(),
    propagatedSyms: new Set(),
    propagationCallers: new Map(),
    externalLocalBindings: new Map(),
    crossCallWrites: new Set(),
    locationsWritingResult: new Set(),
    argsUsageByLoc: new Map(),
  };
}

/**
 * Returns true when the aggregate contribution of a location has not
 * changed between two `LocationSymbols` instances.  Used to decide
 * whether the cached `SymbolAggregates` for a document is still valid
 * after a single-location incremental re-parse.
 *
 * Checks only the fields that feed into `collectAggregates` and
 * `buildPropagatedLocals` — the expensive post-passes.  Per-location
 * diagnostics that depend solely on the location's own symbols (labels,
 * local variables, …) are unaffected by the aggregate cache.
 */
export function isAggContributionStable(
  prev: LocationSymbols,
  next: LocationSymbols,
): boolean {
  // ── Global variables (non-local) ────────────────────────────────
  const prevGlobals = new Map<string, { valueDef: boolean; prefixes: string }>();
  for (const sym of prev.ownedVariables) {
    if (sym.isLocal) continue;
    const px = sym.prefixes ? [...sym.prefixes].sort().join('') : '';
    prevGlobals.set(sym.nameLower, { valueDef: !!sym.hasValueDefinition, prefixes: px });
  }
  for (const sym of next.ownedVariables) {
    if (sym.isLocal) continue;
    const px = sym.prefixes ? [...sym.prefixes].sort().join('') : '';
    const prev_ = prevGlobals.get(sym.nameLower);
    if (!prev_) return false;
    if (prev_.valueDef !== !!sym.hasValueDefinition) return false;
    if (prev_.prefixes !== px) return false;
    prevGlobals.delete(sym.nameLower);
  }
  if (prevGlobals.size > 0) return false;

  // ── Actions ────────────────────────────────────────────────────
  if (prev.actions.length !== next.actions.length) return false;
  for (let i = 0; i < prev.actions.length; i++) {
    if (prev.actions[i].nameLower !== next.actions[i].nameLower) return false;
  }

  // ── Object refs (adds/removes definedObjects / referencedObjects)
  if (prev.objectRefs.size !== next.objectRefs.size) return false;
  for (const [key, obj] of prev.objectRefs) {
    const nObj = next.objectRefs.get(key);
    if (!nObj) return false;
    if (!!obj.definition !== !!nObj.definition) return false;
  }

  // ── Location refs (drives propagation edges + referencedLocations)
  // Compare the call-graph fingerprint: same targets with same
  // localsInScope names and same callTypes.
  if (prev.locationRefs.size !== next.locationRefs.size) return false;
  for (const [key, ref] of prev.locationRefs) {
    const nRef = next.locationRefs.get(key);
    if (!nRef) return false;
    // Compare callTypes and localsInScope sets across all references
    if (ref.references.length !== nRef.references.length) return false;
    for (let i = 0; i < ref.references.length; i++) {
      const r = ref.references[i];
      const nr = nRef.references[i];
      if (r.callType !== nr.callType) return false;
      // localsInScope: same set of base-names (scopeId changes don't
      // affect which names get propagated, only which binding is used)
      const rLS = r.localsInScope;
      const nrLS = nr.localsInScope;
      if (!rLS && !nrLS) continue;
      if (!rLS || !nrLS) return false;
      if (rLS.size !== nrLS.size) return false;
      for (const [name] of rLS) { if (!nrLS.has(name)) return false; }
    }
  }

  return true;
}

/** Collect symbol aggregates from a set of LocationSymbols into `out`. */
export function collectAggregates(
  locations: Iterable<LocationSymbols>,
  out: SymbolAggregates,
): void {
  for (const locSyms of locations) {
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
    for (const [key] of locSyms.locationRefs) {
      out.referencedLocations.add(key);
    }
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
export function buildPropagatedLocals(
  allLocations: Iterable<{ locName: string; locSyms: LocationSymbols; uri: string }>,
  out: SymbolAggregates,
): void {
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

  // Step 2: For each call edge, resolve which local QspSymbols are the
  // providers, then propagate transitively via depth-parameterised
  // recursion.  The `forwarded` memo guarantees each (target, var,
  // provider) triple is visited at most once, so the call graph is
  // traversed in O(edges) regardless of cycles; `MAX_PROPAGATION_DEPTH`
  // is a belt-and-braces stack-overflow guard for pathological inputs
  // (QSP games rarely exceed call depth 20).
  const result = out.propagatedLocals;
  const forwarded = new Map<string, Set<string>>();
  const MAX_PROPAGATION_DEPTH = 1000;

  // `args` and `result` are QSP built-in variables with their own
  // dedicated call semantics (ARGS holds the callee's argument array;
  // RESULT is the callee's return value).  They must never be treated
  // as caller-propagated locals.
  const NO_PROPAGATE = CALL_FRAME_BUILTINS;

  const providerKey = (p: PropagatedLocal) =>
    `${p.providerLoc}\0${p.sym.nameLower}\0${p.sym.scopeId ?? 0}`;

  function propagate(
    targetLoc: string,
    varName: string,
    providers: PropagatedLocal[],
    depth: number,
  ): void {
    if (depth > MAX_PROPAGATION_DEPTH) return;

    // Filter to providers we haven't already routed through this node.
    const pairKey = `${targetLoc}\0${varName}`;
    let seen = forwarded.get(pairKey);
    if (!seen) { seen = new Set(); forwarded.set(pairKey, seen); }
    const fresh: PropagatedLocal[] = [];
    for (const p of providers) {
      const k = providerKey(p);
      if (!seen.has(k)) { seen.add(k); fresh.push(p); }
    }
    if (fresh.length === 0) return;

    const targetInfo = locIndex.get(targetLoc);
    if (!targetInfo) return;

    const targetSym = targetInfo.locSyms.findVariable(varName);
    // The target "uses" the propagated variable when it has any non-local
    // reference to it — reads *and* writes.
    const targetUsesIt = targetSym && !targetSym.isLocal && targetSym.references.length > 0;

    // Record providers when the target actually uses the variable.
    if (targetUsesIt) {
      let targetMap = result.get(targetLoc);
      if (!targetMap) { targetMap = new Map(); result.set(targetLoc, targetMap); }
      const existing = targetMap.get(varName);
      if (existing) {
        existing.push(...fresh);
      } else {
        targetMap.set(varName, [...fresh]);
      }
      for (const p of fresh) out.propagatedSyms.add(p.sym);
    }

    // Record any `local varName` declaration in the target as a
    // shadow of the propagated value, regardless of whether the target
    // also uses `varName` non-locally elsewhere.  This catches `local x`
    // declarations nested inside code blocks (inline dynamic/dyneval
    // arg blocks, which share the caller's scope, or stored blocks
    // dispatched via `dynamic $code`) that would otherwise be hidden
    // when the target's top-level scope already references `x` non-
    // locally — `findVariable` returns the non-local in that case.
    //
    // `localNames` is the authoritative set of base names with at
    // least one `local` declaration somewhere in the location.
    if (targetInfo.locSyms.localNames.has(varName)) {
      let shadowMap = out.shadowedPropagations.get(targetLoc);
      if (!shadowMap) { shadowMap = new Map(); out.shadowedPropagations.set(targetLoc, shadowMap); }
      const existing = shadowMap.get(varName);
      if (existing) existing.push(...fresh);
      else shadowMap.set(varName, [...fresh]);
    }

    // If the top-level (non-local) view of the target IS the local
    // declaration (i.e. there's no non-local use), propagation is
    // fully consumed and does not flow further.
    if (targetSym?.isLocal) return;

    // Otherwise propagate the fresh providers to callees.
    const targetEdges = propagationEdges.get(targetLoc);
    if (!targetEdges) return;

    for (const nextTarget of targetEdges) {
      propagate(nextTarget, varName, fresh, depth + 1);
    }
  }

  // Build reverse index: targetLoc → set of caller locs
  const callers = out.propagationCallers;
  for (const [callerLoc, targets] of propagationEdges) {
    for (const target of targets) {
      let s = callers.get(target);
      if (!s) { s = new Set(); callers.set(target, s); }
      s.add(callerLoc);
    }
  }

  // Process all direct call edges
  for (const [callerLoc, edges] of initialLocals) {
    const callerInfo = locIndex.get(callerLoc);
    if (!callerInfo) continue;

    for (const edge of edges) {
      for (const [varName, scopeId] of edge.locals) {
        if (NO_PROPAGATE.has(varName)) continue;
        // Find the provider QspSymbol — the local in the caller at the exact scope
        const localKey = `local\0${scopeId}\0${varName}`;
        const localSym = callerInfo.locSyms.variables.get(localKey);
        if (!localSym || !localSym.definition) {
          // Caller doesn't define it — it might be a pass-through.
          // Check if caller itself receives it from upstream.
          const callerProviders = result.get(callerLoc)?.get(varName);
          if (callerProviders && callerProviders.length > 0) {
            propagate(edge.target, varName, callerProviders, 1);
          }
          continue;
        }
        const provider: PropagatedLocal = {
          providerLoc: callerLoc,
          providerUri: callerInfo.uri,
          sym: localSym,
        };
        propagate(edge.target, varName, [provider], 1);
      }
    }
  }

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
  // Per-target-symbol dedup memo, shared across both post-passes below.
  // For each provider QspSymbol, holds the set of `${sourceLoc}\0${line},${col}`
  // keys already pushed to ext.get(sym).  Avoids repeatedly scanning the
  // growing list to rebuild a fresh Set for every (provider, varName) pair.
  const extSeen = new Map<QspSymbol, Set<string>>();
  const getOrInitSeen = (sym: QspSymbol): Set<string> => {
    let seen = extSeen.get(sym);
    if (!seen) {
      seen = new Set();
      const list = ext.get(sym);
      if (list) {
        for (const e of list) {
          seen.add(`${e.sourceLoc}\0${e.binding.stmtLoc.line},${e.binding.stmtLoc.column}`);
        }
      }
      extSeen.set(sym, seen);
    }
    return seen;
  };
  for (const [targetLoc, byVar] of result) {
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
      const nonLocalBindings = calleeBindings.filter(b => !b.isLocal);
      if (nonLocalBindings.length === 0) continue;

      for (const p of providers) {
        let list = ext.get(p.sym);
        if (!list) { list = []; ext.set(p.sym, list); }
        const seen = getOrInitSeen(p.sym);
        for (const cb of nonLocalBindings) {
          const k = `${targetLoc}\0${cb.stmtLoc.line},${cb.stmtLoc.column}`;
          if (seen.has(k)) continue;
          seen.add(k);
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

        for (const pb of providerBindings) {
          if (pb.value.kind !== 'code-block') continue;
          // Match the binding to the propagated QspSymbol: a local
          // binding at a different scope is shadowed / unrelated.
          if (pb.isLocal) {
            const symScope = codeProvider.sym.scopeId ?? 0;
            if (pb.scopeNodeId !== symScope) continue;
          }
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
              const seen = getOrInitSeen(targetSym);
              const dedupKey =
                `${calleeLoc}\0${w.binding.stmtLoc.line},${w.binding.stmtLoc.column}`;
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
 * Build a fresh single-file `SymbolAggregates` for `docSyms` —
 * `collectAggregates` followed by `buildPropagatedLocals`.  The
 * caller is responsible for caching the result.
 */
export function buildFileAggregates(
  docSyms: DocumentSymbols,
  uri: string,
): SymbolAggregates {
  const a = emptyAggregates();
  collectAggregates(docSyms.locations.values(), a);
  const allLocs: { locName: string; locSyms: LocationSymbols; uri: string }[] = [];
  for (const [, ls] of docSyms.locations) {
    allLocs.push({ locName: ls.locationName, locSyms: ls, uri });
  }
  buildPropagatedLocals(allLocs, a);
  return a;
}
