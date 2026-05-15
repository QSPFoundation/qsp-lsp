/**
 * Cross-location propagation diagnostics.
 *
 * Checks that reason about how locals flow between locations:
 * inconsistent local propagation (a variable propagated as local
 * from some call sites but not others — including different call
 * sites within the same caller), and unused locations (defined but
 * never referenced by any gs/func/goto).
 */


import { DiagnosticSeverity } from 'vscode-languageserver';
import {
  type DocumentSymbols,
  type SymbolLocation,
  ARGS_VAR_NAME,
  RESULT_VAR_NAME,
} from '../../parser';
import type { ArgsUsage, SymbolAggregates } from '../aggregation';
import { DiagnosticCtx } from './diagnosticHelpers';

// ── Inconsistent local propagation ────────────────────────────────────

/** Call types that propagate locals (mirrors hoverHelpers.RETURNING_CALLS). */
const PROPAGATING_CALL_TYPES: ReadonlySet<string> = new Set(['gosub', 'func', 'desc']);

/**
 * When a target location is reached through call sites that disagree
 * about whether a variable `$v` is in scope, `$v` behaves as local at
 * some call paths and global at others — a subtle source of bugs.
 *
 * The check is per-call (not per-caller): every individual `gs`/`func`/
 * `@`/`@@`/`desc` ref against the target is classified as propagating
 * or not.  If both groups are non-empty for the same variable, a
 * warning is emitted on every read of that variable in the target.
 *
 * A ref is "propagating" if either:
 *   • its `localsInScope` set contains the variable (caller has a
 *     local with that name visible at this call), or
 *   • the caller as a whole receives the variable through propagation
 *     (transitive).
 *
 * Note: a `local <name>` declaration in the caller does NOT stop
 * propagation — it just gives the propagated value a different value.
 * The callee still sees the variable as local, which is all this
 * diagnostic cares about.
 */
export function checkInconsistentLocalPropagation(
  ctx: DiagnosticCtx,
  symbols: DocumentSymbols,
  agg: SymbolAggregates,
): void {
  const { propagatedLocals, propagationCallers } = agg;

  for (const [targetLocKey, targetVars] of propagatedLocals) {
    const callerKeys = propagationCallers.get(targetLocKey);
    if (!callerKeys || callerKeys.size === 0) continue;

    const targetLocSyms = symbols.getLocation(targetLocKey);
    if (!targetLocSyms) continue;

    type CallSite = {
      callerName: string;
      ref: SymbolLocation;
      /** Locals visible at the call site (alias of ref.localsInScope). */
      siteLocals: ReadonlyMap<string, unknown> | undefined;
      /** Vars the caller as a whole receives via propagation (or undef). */
      callerReceives: ReadonlyMap<string, unknown> | undefined;
    };
    const allSites: CallSite[] = [];
    for (const callerKey of callerKeys) {
      const callerLocSyms = symbols.getLocation(callerKey);
      if (!callerLocSyms) continue;
      const refSym = callerLocSyms.locationRefs.get(targetLocKey);
      if (!refSym) continue;
      // Hoist per-caller lookup so we don't redo it inside the var
      // loop.  In a huge file with thousands of refs and dozens of
      // propagated vars per target, this is the difference between
      // O(refs·vars) and O(callers + refs·vars) Map lookups.
      const callerReceives = propagatedLocals.get(callerKey);
      for (const r of refSym.references) {
        if (!r.callType || !PROPAGATING_CALL_TYPES.has(r.callType)) continue;
        allSites.push({
          callerName: callerLocSyms.locationName,
          ref: r,
          siteLocals: r.localsInScope,
          callerReceives,
        });
      }
    }
    if (allSites.length < 2) continue;

    for (const [varName] of targetVars) {
      const propagating: CallSite[] = [];
      const nonPropagating: CallSite[] = [];
      for (const s of allSites) {
        if (s.siteLocals?.has(varName) || s.callerReceives?.has(varName)) {
          propagating.push(s);
        } else {
          nonPropagating.push(s);
        }
      }
      if (propagating.length === 0 || nonPropagating.length === 0) continue;

      const targetSym = targetLocSyms.findVariable(varName);
      if (!targetSym) continue;

      const fromList = formatCallSiteGroups(propagating);
      const withoutList = formatCallSiteGroups(nonPropagating);
      for (const ref of targetSym.references) {
        const propMsg = `Variable '${targetSym.name}' is propagated as local`
          + ` from ${fromList} but not from ${withoutList}`
          + ` — it may behave as local or global depending on the call path`;
        ctx.push(DiagnosticSeverity.Warning, ctx.locRange(ref), propMsg);
      }
    }
  }
}

/**
 * Render a list of call sites as `caller line N` / `caller lines A, B`,
 * grouped by caller name and sorted by first line.
 */
function formatCallSiteGroups(
  sites: ReadonlyArray<{ callerName: string; ref: SymbolLocation }>,
): string {
  const byCaller = new Map<string, Set<number>>();
  for (const s of sites) {
    let lines = byCaller.get(s.callerName);
    if (!lines) { lines = new Set(); byCaller.set(s.callerName, lines); }
    lines.add(s.ref.line + 1);
  }
  const parts: { firstLine: number; text: string }[] = [];
  for (const [name, lineSet] of byCaller) {
    const lines = [...lineSet].sort((a, b) => a - b);
    const text = lines.length === 1
      ? `${name} line ${lines[0]}`
      : `${name} lines ${lines.join(', ')}`;
    parts.push({ firstLine: lines[0], text });
  }
  parts.sort((a, b) => a.firstLine - b.firstLine);
  return parts.map(p => p.text).join(', ');
}

// ── Unused locations ──────────────────────────────────────────────────

/**
 * Flag locations that are defined but never referenced by any gs/func/goto
 * (except the first location, which is the entry point and therefore always "used").
 */
export function checkUnusedLocations(
  ctx: DiagnosticCtx,
  symbols: DocumentSymbols,
  locationIndex: Array<{ nameLower: string }>,
  referencedLocations: ReadonlySet<string>,
  firstLocationKey?: string,
): void {
  if (locationIndex.length === 0) return;
  const skipKey = firstLocationKey ?? locationIndex[0].nameLower;

  for (const [key, def] of symbols.locationDefs) {
    if (key === skipKey) continue;
    if (referencedLocations.has(key)) continue;
    ctx.push(
      DiagnosticSeverity.Hint,
      ctx.locRange(def.definition!),
      `Location '${def.name}' is defined but never referenced`,
      true,  // unnecessary
    );
  }
}

// ── Missing result in function-call target ───────────────────────────

/**
 * Warn when a location is invoked as `func(...)` / `@target` / `@target(...)`
 * but the target's body never assigns the built-in `result` variable.
 * `result` is a per-call-frame local, so callees writing `result` do
 * not help — only direct writes in the target's own body count
 * (including writes nested in `if`/`act`/loop blocks).  Such a call
 * always returns an empty value — almost certainly a bug.
 *
 * Diagnostics are emitted at each `func`/`@` call site referencing the
 * unproductive target.
 */
export function checkMissingResultInFunctionCall(
  ctx: DiagnosticCtx,
  symbols: DocumentSymbols,
  agg: SymbolAggregates,
): void {
  const writers = agg.locationsWritingResult;
  for (const [, locSyms] of symbols.locations) {
    if (locSyms.hasErrors) continue;
    for (const [targetKey, ref] of locSyms.locationRefs) {
      if (writers.has(targetKey)) continue;
      for (const r of ref.references) {
        if (r.callType !== 'func') continue;
        ctx.push(
          DiagnosticSeverity.Warning,
          ctx.locRange(r),
          `Location '${ref.name}' is called as a function but never assigns 'result'`
          + ` — the call always returns an empty value`,
        );
      }
    }
  }
}

// ── Missing result in dyneval block ──────────────────────────────────

/**
 * Warn when a `dyneval(<code-block>, ...)` block never directly assigns
 * `result`.  The block runs in its own call frame with a fresh `result`,
 * so calls out to other locations cannot supply it — only writes inside
 * the block body itself count.
 */
export function checkMissingResultInDyneval(
  ctx: DiagnosticCtx,
  symbols: DocumentSymbols,
  agg: SymbolAggregates,
): void {
  for (const [locKey, locSyms] of symbols.locations) {
    if (locSyms.hasErrors) continue;

    // ── Inline / locally-resolved dispatches ──
    if (locSyms.resolvedDynamicBlocks.length > 0) {
      const resultSym = locSyms.findVariable(RESULT_VAR_NAME);
      const resultDefs = resultSym
        ? resultSym.references.filter(r => r.isDefinition)
        : [];

      for (const block of locSyms.resolvedDynamicBlocks) {
        if (block.kind !== 'dyneval') continue;
        // Universal-quantification: warn iff EVERY candidate target
        // fails to assign `result`.  Single-target dispatches reduce to
        // the original check; multi-target var-mediated dispatches are
        // suppressed when at least one candidate writes `result`, since
        // runtime may dispatch to it.
        const allFail = block.blockLocs.every(
          loc => !resultDefs.some(ref => isInsideRange(ref, loc)),
        );
        if (!allFail) continue;

        ctx.push(
          DiagnosticSeverity.Warning,
          ctx.locRange(block.callLoc),
          `'dyneval' block never assigns 'result'`
          + ` — the call always returns an empty value`,
        );
      }
    }

    // ── Cross-location global-dispatch sites ──
    //
    // `dyneval($code)` where `$code` resolves only via a global
    // binding in another location.  The candidate block bodies live
    // in the provider locations; `writesResult` was pre-computed in
    // aggregation so we apply the same universal-quantification rule
    // without scanning provider symbols here.
    const crossSites = agg.crossLocationDispatches.get(locKey);
    if (crossSites) {
      for (const dispatch of crossSites) {
        if (dispatch.kind !== 'dyneval') continue;
        if (dispatch.candidates.some(c => c.writesResult)) continue;
        ctx.push(
          DiagnosticSeverity.Warning,
          ctx.locRange(dispatch.callLoc),
          `'dyneval' block never assigns 'result'`
          + ` — the call always returns an empty value`,
        );
      }
    }
  }
}

// ── Extra args to target without 'args' ─────────────────────────

/**
 * Info diagnostic: warn when a `gs`/`gosub`/`func`/`@`/`@@`/
 * `gt`/`goto`/`xgt`/`xgoto` call passes more positional arguments
 * than the target location actually reads via the built-in `args`
 * variable.  Two cases produce a warning:
 *
 *   - target never reads `args`     — every extra is discarded.
 *   - target reads only `args[0..K]` while the call passes more —
 *                                     the trailing slots are
 *                                     discarded.
 *
 * Targets whose `args` reads use a non-literal index (e.g.
 * `args[i]` in a loop) are conservatively suppressed: the loop may
 * cover every passed slot.
 *
 * For inline `dynamic { ... }` and `dyneval({ ... }, ...)` blocks,
 * the same check is applied to the block body.
 *
 * Targets unresolved across the whole project are skipped (they're
 * already flagged by `unresolvedLocationRefs`).
 */
export function checkExtraArgsToTargetWithoutArgs(
  ctx: DiagnosticCtx,
  symbols: DocumentSymbols,
  agg: SymbolAggregates,
  allLocationDefs: ReadonlyMap<string, unknown>,
): void {
  const argsUsageByLoc = agg.argsUsageByLoc;
  for (const [locKey, locSyms] of symbols.locations) {
    if (locSyms.hasErrors) continue;

    // ── Direct location calls ──
    for (const [targetKey, ref] of locSyms.locationRefs) {
      if (!allLocationDefs.has(targetKey)) continue;
      const usage = argsUsageByLoc.get(targetKey);
      for (const r of ref.references) {
        const n = r.argCount ?? 0;
        if (n === 0) continue;
        const verdict = classifyArgsConsumption(usage, n);
        if (!verdict) continue;
        ctx.push(
          DiagnosticSeverity.Information,
          ctx.locRange(r),
          formatExtraArgsMessage(`Location '${ref.name}'`, n, verdict),
        );
      }
    }

    // ── Inline dynamic/dyneval blocks ──
    if (locSyms.resolvedDynamicBlocks.length > 0) {
      // `variables.get(ARGS_VAR_NAME)` returns the bare-keyed (non-local)
      // symbol; locals live under scope-keyed entries.  A `local args`
      // inside the block therefore doesn't contribute references here
      // — they belong to a separate scoped symbol — so the block
      // correctly fails to satisfy "reads its args parameter".
      const argsSym = locSyms.variables.get(ARGS_VAR_NAME);
      const argsRefs = argsSym?.references ?? [];
      for (const block of locSyms.resolvedDynamicBlocks) {
        if (block.argCount === 0) continue;
        // Universal-quantification across multi-target dispatches:
        // warn iff EVERY candidate target has a verdict.  If at least
        // one candidate fully consumes (or has opaque reads), suppress.
        // Across emitted verdicts we choose the most informative — the
        // one with the highest `maxLiteralIdx` so the message reflects
        // the fullest consumer.
        let mostInformative: ArgsVerdict | undefined;
        let allHaveVerdict = true;
        for (const loc of block.blockLocs) {
          let hasOpaque = false;
          let maxLiteralIdx = -1;
          let hasAnyRef = false;
          for (const ref of argsRefs) {
            if (!isInsideRange(ref, loc)) continue;
            hasAnyRef = true;
            if (!ref.argsConsumer) continue;
            if (ref.argsIndex === undefined) hasOpaque = true;
            else if (ref.argsIndex > maxLiteralIdx) maxLiteralIdx = ref.argsIndex;
          }
          const usage = hasAnyRef ? { hasOpaque, maxLiteralIdx } : undefined;
          const v = classifyArgsConsumption(usage, block.argCount);
          if (!v) { allHaveVerdict = false; break; }
          if (!mostInformative || v.maxRead > mostInformative.maxRead) mostInformative = v;
        }
        if (!allHaveVerdict || !mostInformative) continue;
        ctx.push(
          DiagnosticSeverity.Information,
          ctx.locRange(block.callLoc),
          formatExtraArgsMessage(`'${block.kind}' block`, block.argCount, mostInformative),
        );
      }
    }

    // ── Cross-location global dispatches ──
    //
    // `dyneval($code, …)` where `$code` resolves only to global
    // bindings in other locations.  Each candidate's `argsUsage` was
    // pre-computed in aggregation against the provider's own `args`
    // refs; we apply the same universal-quantification rule across
    // candidates.
    const crossSites = agg.crossLocationDispatches.get(locKey);
    if (crossSites) {
      for (const dispatch of crossSites) {
        if (dispatch.argCount === 0) continue;
        let mostInformative: ArgsVerdict | undefined;
        let allHaveVerdict = true;
        for (const cand of dispatch.candidates) {
          const v = classifyArgsConsumption(cand.argsUsage, dispatch.argCount);
          if (!v) { allHaveVerdict = false; break; }
          if (!mostInformative || v.maxRead > mostInformative.maxRead) mostInformative = v;
        }
        if (!allHaveVerdict || !mostInformative) continue;
        ctx.push(
          DiagnosticSeverity.Information,
          ctx.locRange(dispatch.callLoc),
          formatExtraArgsMessage(`'${dispatch.kind}' block`, dispatch.argCount, mostInformative),
        );
      }
    }
  }
}

/**
 * Classify how a callee's args usage relates to a call's argCount.
 *
 *   - `undefined`            — no warning (target fully consumes the
 *                              passed extras, or has an opaque read
 *                              that may consume them all).
 *   - `{ kind: 'never', … }` — target never reads args.
 *   - `{ kind: 'partial', … }` — target reads at most `args[K]` but
 *                                caller passed more than K+1 extras.
 */
type ArgsVerdict =
  | { kind: 'never'; maxRead: -1 }
  | { kind: 'partial'; maxRead: number };

function classifyArgsConsumption(
  usage: ArgsUsage | undefined,
  argCount: number,
): ArgsVerdict | undefined {
  if (!usage) return { kind: 'never', maxRead: -1 };
  if (usage.hasOpaque) return undefined;
  if (usage.maxLiteralIdx < 0) {
    // References exist but they're all pure writes (`args[0] = …`).
    // Caller's slots are received but immediately overwritten —
    // treat as "never reads".
    return { kind: 'never', maxRead: -1 };
  }
  const used = usage.maxLiteralIdx + 1;
  if (used >= argCount) return undefined;
  return { kind: 'partial', maxRead: usage.maxLiteralIdx };
}

function formatExtraArgsMessage(
  subject: string,
  argCount: number,
  v: ArgsVerdict,
): string {
  const argWord = argCount === 1 ? 'argument' : 'arguments';
  if (v.kind === 'never') {
    const valueWord = argCount === 1 ? 'value is' : 'values are';
    return `${subject} is called with ${argCount} extra ${argWord}`
      + ` but never reads 'args'`
      + ` — the extra ${valueWord} discarded`;
  }
  // partial
  const used = v.maxRead + 1;
  const discarded = argCount - used;
  const valueWord = discarded === 1 ? 'value is' : 'values are';
  return `${subject} is called with ${argCount} extra ${argWord}`
    + ` but reads at most 'args[${v.maxRead}]'`
    + ` — ${discarded} extra ${valueWord} discarded`;
}

/** True when `inner`'s start..end fits inside `outer`'s start..end. */
function isInsideRange(
  inner: { line: number; column: number; endLine: number; endColumn: number },
  outer: { line: number; column: number; endLine: number; endColumn: number },
): boolean {
  if (inner.line < outer.line) return false;
  if (inner.line === outer.line && inner.column < outer.column) return false;
  if (inner.endLine > outer.endLine) return false;
  if (inner.endLine === outer.endLine && inner.endColumn > outer.endColumn) return false;
  return true;
}

// ── Orchestrator ──────────────────────────────────────────────────────

export function checkPropagation(
  ctx: DiagnosticCtx,
  symbols: DocumentSymbols,
  agg: SymbolAggregates,
  locationIndex: Array<{ nameLower: string }>,
  allLocationDefs: ReadonlyMap<string, unknown>,
  firstLocationKey?: string,
): void {
  const { referencedLocations } = agg;

  if (ctx.settings.inconsistentLocalPropagation) {
    checkInconsistentLocalPropagation(ctx, symbols, agg);
  }

  if (ctx.settings.missingResultInFunctionCall) {
    checkMissingResultInFunctionCall(ctx, symbols, agg);
    checkMissingResultInDyneval(ctx, symbols, agg);
  }

  if (ctx.settings.extraArgsToTargetWithoutArgs) {
    checkExtraArgsToTargetWithoutArgs(ctx, symbols, agg, allLocationDefs);
  }

  if (ctx.settings.unusedLocations) {
    checkUnusedLocations(
      ctx, symbols, locationIndex, referencedLocations,
      firstLocationKey,
    );
  }
}
