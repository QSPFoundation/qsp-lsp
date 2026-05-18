/**
 * Variable dataflow diagnostics.
 *
 * Checks that reason about how variables flow and are used across
 * the document: uninitialized reads, mixed type-prefix usage,
 * type-mismatched assignments, and unused variables.
 */


import { DiagnosticSeverity } from 'vscode-languageserver';
import type Parser from 'web-tree-sitter';
import {
  type DocumentSymbols,
  type LocationSymbols,
  type QspSymbol,
  QSP_VARIABLES,
  type TypePrefix,
  type CursorValueEntry,
  getPossibleValuesAtCursor,
  ARGS_VAR_NAME,
  CALL_FRAME_BUILTINS,
} from '../../parser';
import type { SymbolLocation } from '../../parser/symbolTypes';
import type { SymbolAggregates } from '../aggregation';
import { DiagnosticCtx } from './diagnosticHelpers';

// ── Constants ─────────────────────────────────────────────────────────

const BUILTIN_VAR_NAMES = new Set(QSP_VARIABLES.map(v => v.name.toLowerCase()));

/** Built-in variables guaranteed to hold a value before any user code
 *  can read them.  `args` is set by the runtime on every call frame
 *  (empty when none passed).  All other QSP built-in variables — handler
 *  slots like `$counter`, `$ongload`, engine-config like `disablescroll`,
 *  `bcolor` — must be assigned by the user before they can be meaningfully
 *  read; the engine does not pre-populate them with anything readable.
 *  `result` is also runtime-zeroed per frame, but reading it without a
 *  prior assignment is almost always a bug, so it stays subject to the
 *  uninitialized-read check. */
const RUNTIME_INITIALIZED_VAR_NAMES = new Set([ARGS_VAR_NAME]);

/** Per-call-frame built-ins set by the runtime on every call.  A
 *  `local` declaration of one of these is always unnecessary.
 *  Re-exported from the parser layer for single-source-of-truth. */

const ASSIGN_TYPE_RULES: Record<TypePrefix, Record<string, readonly TypePrefix[]>> = {
  '$': { '=': ['$'], 'other': ['$'], '+=': ['$'], '-=': [], '*=': [], '/=': [] },
  '%': { '=': ['%'], 'other': ['%'], '+=': ['$', '#', '%'], '-=': ['#', '%'], '*=': ['#', '%'], '/=': ['#', '%'] },
  '#': { '=': ['#'], 'other': ['#'], '+=': ['#'], '-=': ['#'], '*=': ['#'], '/=': ['#'] },
};

// ── Shared resolver cache ─────────────────────────────────────────────

/**
 * Per-symbol memoised possible-values query.
 *
 * Anchored at the first proper-usage reference of a symbol — references
 * of one sym share a scope-island, so the result generalises to every
 * read of that sym.  Returns `null` when the sym has no proper-usage
 * reference (write-only — nothing to anchor on).
 */
function buildResolverCache(
  symbols: DocumentSymbols,
  agg: SymbolAggregates,
  tree: Parser.Tree,
  projectDocs?: DocumentSymbols[],
): (sym: QspSymbol) => CursorValueEntry[] | null {
  const cache = new WeakMap<QspSymbol, CursorValueEntry[] | null>();
  const projectDocsArg = projectDocs && projectDocs.length > 0 ? projectDocs : undefined;

  return (sym: QspSymbol): CursorValueEntry[] | null => {
    const cached = cache.get(sym);
    if (cached !== undefined) return cached;
    const readRef = sym.references.find(r => r.isProperUsage);
    if (!readRef) {
      cache.set(sym, null);
      return null;
    }
    const entries = getPossibleValuesAtCursor(
      symbols, agg, tree,
      readRef.line, readRef.column, sym.nameLower,
      { projectDocs: projectDocsArg },
    );
    cache.set(sym, entries);
    return entries;
  };
}

// ── Uninitialized variables ───────────────────────────────────────────

/**
 * Flag reads of variables that have no reachable value-bearing binding.
 *
 * Cases caught:
 *   • Bare `local x` declarations are non-value-bearing — reads of `x`
 *     warn even when a same-named global is assigned elsewhere.
 *   • `sortarr` / `killvar` / `menu` are non-value-bearing (read/permute/reset).
 *   • Var-ref chains are followed: `b = a` where `a` has no value-bearing
 *     binding makes reads of `b` warn too.
 *
 * Anchored at the first non-definition reference per sym; the resolver
 * cost is paid once per sym, not per reference.
 */
export function checkUninitializedVariables(
  ctx: DiagnosticCtx,
  symbols: DocumentSymbols,
  agg: SymbolAggregates,
  tree: Parser.Tree | undefined,
  projectDocs?: DocumentSymbols[],
): void {
  const { globallyValueDefined } = agg;
  // Build the resolver-cache closure once per call: each sym is visited
  // exactly once below, so the WeakMap memo never hits within this
  // function — the cache exists only to fold the `firstProperUsageRef`
  // anchor + null-write-only handling into a single reusable helper.
  const resolverCache = tree
    ? buildResolverCache(symbols, agg, tree, projectDocs)
    : null;

  for (const [, locSyms] of symbols.locations) {
    if (locSyms.hasErrors) continue;
    for (const sym of locSyms.ownedVariables) {
      if (sym.hasValueDefinition) continue;
      if (RUNTIME_INITIALIZED_VAR_NAMES.has(sym.nameLower)) continue;

      // Name-propagated local from an upstream caller — suppress only
      // when at least one provider is value-bearing.
      const providers = agg.propagatedLocals.get(locSyms.locationName.toLowerCase())
        ?.get(sym.nameLower);
      if (providers && providers.some(p => p.sym.hasValueDefinition)) continue;

      let hasValueBinding = false;
      if (resolverCache) {
        const entries = resolverCache(sym);
        if (entries) {
          // A compound-op binding (`x += 1`) is neither a proper read
          // nor a proper write: it does not, on its own, prove the
          // variable was previously assigned.  Require at least one
          // plain (`=`) value-bearing binding to suppress the warning.
          hasValueBinding = entries.some(
            e => e.binding.isValueBearing === true && e.binding.compoundOp === undefined,
          );
        } else if (!sym.isLocal) {
          // No proper-usage ref to anchor the resolver — fall back to
          // project-wide set for globals assigned in another location.
          hasValueBinding = globallyValueDefined.has(sym.nameLower);
        }
      } else {
        // Tree unavailable (regex fallback) — flat name-existence check.
        hasValueBinding = !sym.isLocal && globallyValueDefined.has(sym.nameLower);
      }
      if (hasValueBinding) continue;

      for (const ref of sym.references) {
        if (ref.isDefinition) continue;
        ctx.push(
          DiagnosticSeverity.Warning,
          ctx.locRange(ref),
          `Variable '${sym.name}' is used but never assigned`,
        );
      }
    }
  }
}

// ── Mixed variable type prefixes ──────────────────────────────────────

/**
 * Flag variables accessed with inconsistent type prefixes ($/#/%).
 *
 * Computes the union of write-prefixes visible at each reference site,
 * including caller-propagated locals and cross-location global bindings.
 * More than one distinct prefix means inconsistent usage.
 */
export function checkMixedVariablePrefixes(
  ctx: DiagnosticCtx,
  symbols: DocumentSymbols,
  agg: SymbolAggregates,
  tree: Parser.Tree | undefined,
  projectDocs?: DocumentSymbols[],
): void {
  const { globalPrefixes, propagatedLocals } = agg;
  // Hoist the projectDocs normalisation: same value for every loc/sym.
  const projectDocsArg = projectDocs && projectDocs.length > 0 ? projectDocs : undefined;

  for (const [, locSyms] of symbols.locations) {
    if (locSyms.hasErrors) continue;
    const incoming = propagatedLocals.get(locSyms.locationName.toLowerCase());

    for (const sym of locSyms.ownedVariables) {
      if (BUILTIN_VAR_NAMES.has(sym.nameLower)) continue;

      const merged = new Set<string>(sym.prefixes ?? []);

      // Caller-propagated locals contribute their write prefixes directly.
      const providers = incoming?.get(sym.nameLower);
      if (providers) {
        for (const p of providers) {
          if (p.sym.prefixes) for (const px of p.sym.prefixes) merged.add(px);
        }
      }

      if (tree) {
        // Collect write-prefixes WITHOUT following var-ref chains to
        // other base-named variables.  Chain-following would pull in
        // prefixes from different variables.

        // Scope-visible own-loc bindings (followChain:false).
        const refForPrefix = sym.references[0];
        const ownEntries = refForPrefix
          ? getPossibleValuesAtCursor(
              symbols, agg, tree,
              refForPrefix.line, refForPrefix.column, sym.nameLower,
              { projectDocs: projectDocsArg, followChain: false, includeDocumentGlobals: false },
            )
          : null;
        if (ownEntries) {
          for (const e of ownEntries) {
            if (e.binding.writePrefix !== undefined) merged.add(e.binding.writePrefix);
          }
        }

        // Cross-location globals: direct lookup by base name, no chain.
        const globalEntries = symbols.globalBindings.get(sym.nameLower);
        if (globalEntries) {
          for (const g of globalEntries) {
            if (g.binding.writePrefix !== undefined) merged.add(g.binding.writePrefix);
          }
        }
      } else {
        // Tree unavailable (regex fallback) — flat file-wide prefix union.
        const gp = globalPrefixes.get(sym.nameLower);
        if (gp) for (const px of gp.prefixes) merged.add(px);
      }

      if (merged.size <= 1) continue;

      const names = [...merged].sort().join(', ');
      for (const ref of sym.references) {
        ctx.push(
          DiagnosticSeverity.Information,
          ctx.locRange(ref),
          `Variable '${sym.name}' is used with mixed type prefixes: ${names}`,
        );
      }
    }
  }
}

// ── Type-mismatch assignments ─────────────────────────────────────────

/**
 * Flag assignments where the inferred RHS type is incompatible with
 * the LHS variable prefix.  Only literal, direct var-ref, tuple,
 * and built-in function-call RHS shapes are checked; opaque expressions
 * (arithmetic, interpolated strings, user calls…) are skipped.
 */
export function checkTypeMismatch(
  ctx: DiagnosticCtx,
  symbols: DocumentSymbols,
): void {
  const typeLabel = (p: string) => p === '$' ? 'string' : p === '%' ? 'tuple' : 'numeric';

  for (const [, locSyms] of symbols.locations) {
    if (locSyms.hasErrors) continue;
    for (const [, bindings] of locSyms.variableBindings) {
      for (const b of bindings) {
        if (!b.isValueBearing) continue;
        if (b.writePrefix === undefined || b.rhsTypePrefix === undefined) continue;
        const op = b.compoundOp ?? '=';
        const allowed = ASSIGN_TYPE_RULES[b.writePrefix]?.[op];
        if (!allowed || !allowed.includes(b.rhsTypePrefix)) {
          const lhsType = typeLabel(b.writePrefix);
          const rhsType = typeLabel(b.rhsTypePrefix);
          ctx.push(
            DiagnosticSeverity.Information,
            ctx.locRange(b.stmtLoc),
            `Type mismatch: assignment of a ${rhsType} value to a ${lhsType} variable`,
          );
        }
      }
    }
  }
}

// ── Unused variables ──────────────────────────────────────────────────

/**
 * Flag variable definitions that are never read.
 *
 * A definition is "unused" iff no read — directly or via a var-ref
 * chain — resolves to one of its bindings.  Uses `reachedBindings`
 * pre-populated from the resolver, plus side-table suppressions for
 * effects the resolver cannot trace (cross-call writes, propagated syms).
 */
export function checkUnusedVariables(
  ctx: DiagnosticCtx,
  symbols: DocumentSymbols,
  agg: SymbolAggregates,
  docUri: string,
): void {
  const { globallyRead, propagatedSyms, propagatedLocals, crossCallWrites } = agg;

  for (const [, locSyms] of symbols.locations) {
    if (locSyms.hasErrors) continue;
    const incoming = propagatedLocals.get(locSyms.locationName.toLowerCase());

    for (const sym of locSyms.ownedVariables) {
      if (!sym.definition) continue;
      if (BUILTIN_VAR_NAMES.has(sym.nameLower)) continue;

      if (sym.isLocal) {
        // Locals are scope-bounded by the parser.  A proper-usage ref
        // proves it IS read — the resolver adds no precision over
        // `sym.references` for locals.
        const hasRead = sym.references.some(ref => ref.isProperUsage);
        if (hasRead) continue;
        if (propagatedSyms.has(sym)) continue;
      } else {
        // A write to a variable propagated in from a caller aliases the
        // caller's local — not a truly unused global.
        if (incoming?.has(sym.nameLower)) continue;

        // Write inside a deferred code-block whose holder reaches a
        // dyn-dispatch — runtime flows it back to a caller-local.
        const writeKey = `${docUri}\0${sym.definition.line},${sym.definition.column}`;
        if (crossCallWrites.has(writeKey)) continue;

        // A global is used if it is read (isProperUsage) anywhere in the
        // project — globallyRead aggregates isProperUsage refs across all
        // locations and documents, so it is the correct and sufficient check.
        if (globallyRead.has(sym.nameLower)) continue;
      }

      ctx.push(
        DiagnosticSeverity.Information,
        ctx.locRange(sym.definition),
        `Variable '${sym.name}' is assigned but never read`,
        true,  // unnecessary
      );
    }
  }
}

// ── shadowsCallFrameBuiltin ───────────────────────────────────

/**
 * Info on `local args` / `local result` declarations.
 *
 * `args` and `result` are already per-call-frame variables — every
 * call gets its own fresh binding for them.  Adding `local` is
 * therefore never necessary: at a location's top level it has no
 * observable effect, and inside a nested scope it merely hides the
 * outer value (which is itself already call-frame-local).  Almost
 * always a misconception about how the call protocol works.
 */
export function checkShadowsCallFrameBuiltin(
  ctx: DiagnosticCtx,
  symbols: DocumentSymbols,
): void {
  for (const [, locSyms] of symbols.locations) {
    if (locSyms.hasErrors) continue;
    // Fast reject: skip the entire location when neither name has any
    // `local` declaration (the overwhelmingly common case).
    const { localNames } = locSyms;
    for (const name of CALL_FRAME_BUILTINS) {
      if (!localNames.has(name)) continue;
      for (const sym of locSyms.findAllVariables(name)) {
        if (!sym.isLocal || !sym.definition) continue;
        ctx.push(
          DiagnosticSeverity.Information,
          ctx.locRange(sym.definition),
          `'local ${sym.name}' is unnecessary — '${sym.name}' is already a per-call-frame variable`,
          true,  // unnecessary
        );
      }
    }
  }
}

// ── shadowsPropagatedLocal ────────────────────────────────────

/**
 * True iff this `local` declaration sits on an executable code path
 * of `locSyms` — and therefore actually shadows a propagated-in local
 * at runtime.  Two cases qualify:
 *
 *   • Scope reachable from scope 0 via a non-isolated chain — top-level
 *     body, inline `if`/`else`/`loop` branches, and inline
 *     `dynamic { … }` / `dyneval({…}, …)` argument blocks (which
 *     inherit the caller's scope).
 *   • Declaration inside a stored code block that the location actually
 *     dispatches via `dynamic $code` / `dyneval($code, …)` — recorded
 *     in `resolvedDynamicBlocks.blockLocs`, including alias-chain and
 *     multi-target dispatches.
 *
 * Stored blocks that are never dispatched (e.g. `$code = { local x }`
 * with no matching `dynamic $code`) are walked under an isolated
 * synthetic scope and their `local` declarations do NOT shadow.
 */
function isExecutableShadow(locSyms: LocationSymbols, sym: QspSymbol): boolean {
  // Case A: scope reachable from scope 0 without crossing isolation.
  let s: number | undefined = sym.scopeId ?? 0;
  while (s !== undefined) {
    if (s === 0) return true;
    if (locSyms.isolatedScopes.has(s)) break;
    s = locSyms.scopeParent.get(s);
  }
  // Case B: declaration sits inside a dispatched block range.
  const def = sym.definition;
  if (!def) return false;
  for (const b of locSyms.resolvedDynamicBlocks) {
    for (const r of b.blockLocs) {
      if (locContains(r, def)) return true;
    }
  }
  return false;
}

function locContains(outer: SymbolLocation, inner: SymbolLocation): boolean {
  if (inner.line < outer.line) return false;
  if (inner.line === outer.line && inner.column < outer.column) return false;
  if (inner.endLine > outer.endLine) return false;
  if (inner.endLine === outer.endLine && inner.endColumn > outer.endColumn) return false;
  return true;
}

/**
 * Info on a `local x` declaration in a callee whose name collides
 * with a local variable propagated in from one or more callers.
 *
 * QSP propagates a caller's locals into every gs/gosub/func/@/@@
 * target as if they were defined in the callee's own top scope.
 * If the callee then declares `local x`, that fresh local replaces
 * the propagated binding for the rest of the callee's scope — the
 * caller's value becomes invisible, and writes to `x` no longer
 * flow back.  Almost always either dead code (top-level redeclare
 * of an already-available variable) or an accidental name clash.
 */
export function checkShadowsPropagatedLocal(
  ctx: DiagnosticCtx,
  symbols: DocumentSymbols,
  agg: SymbolAggregates,
): void {
  for (const [, locSyms] of symbols.locations) {
    if (locSyms.hasErrors) continue;
    const shadowMap = agg.shadowedPropagations.get(locSyms.locationName.toLowerCase());
    if (!shadowMap || shadowMap.size === 0) continue;

    // Iterate by shadow-map key, not by every variable in the location:
    // shadowMap is keyed by *propagated* names from upstream callers
    // (typically a handful), while `locSyms.variables` may hold tens of
    // thousands of entries in large files.  For each name, fetch only
    // its local symbols via `findAllVariables` (O(scope-chain) hit if
    // `localNames` lists the name).
    for (const [varName, providers] of shadowMap) {
      if (CALL_FRAME_BUILTINS.has(varName)) continue;  // covered by shadowsCallFrameBuiltin
      if (providers.length === 0) continue;
      if (!locSyms.localNames.has(varName)) continue;

      for (const sym of locSyms.findAllVariables(varName)) {
        if (!sym.isLocal || !sym.definition) continue;
        // Only locals that actually run on an executable path of the
        // location shadow the propagated value.  A `local x` buried in
        // a stored code block that nobody dispatches is dead code; the
        // shadow record exists at the name level (see `localNames` in
        // aggregation) but this individual symbol does not shadow.
        if (!isExecutableShadow(locSyms, sym)) continue;

        const callerNames = [...new Set(providers.map(p => p.sym.locationName ?? p.providerLoc))]
          .filter((n): n is string => Boolean(n))
          .sort();
        const callerList = callerNames.map(n => `'${n}'`).join(', ');
        ctx.push(
          DiagnosticSeverity.Information,
          ctx.locRange(sym.definition),
          `'local ${sym.name}' shadows a local variable propagated in from ${callerList}`,
        );
      }
    }
  }
}

// ── Orchestrator ────────────────────────────────────────────

/** Run all variable dataflow diagnostics. */
export function checkVariables(
  ctx: DiagnosticCtx,
  symbols: DocumentSymbols,
  agg: SymbolAggregates,
  docUri: string,
  tree: Parser.Tree | undefined,
  projectDocs?: DocumentSymbols[],
): void {
  if (ctx.settings.uninitializedVariables)  checkUninitializedVariables(ctx, symbols, agg, tree, projectDocs);
  if (ctx.settings.mixedVariablePrefixes)   checkMixedVariablePrefixes(ctx, symbols, agg, tree, projectDocs);
  if (ctx.settings.typeMismatch)             checkTypeMismatch(ctx, symbols);
  if (ctx.settings.unusedVariables)          checkUnusedVariables(ctx, symbols, agg, docUri);
  if (ctx.settings.shadowsCallFrameBuiltin)  checkShadowsCallFrameBuiltin(ctx, symbols);
  if (ctx.settings.shadowsPropagatedLocal)   checkShadowsPropagatedLocal(ctx, symbols, agg);
}
