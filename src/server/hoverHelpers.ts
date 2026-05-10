/**
 * Hover content builders — pure markdown-generating functions.
 *
 * Testable in isolation: no Connection, no document state.
 *
 * Exported:
 *   • `buildPossibleValuesLines` — "Possible values:" section for variable hovers
 *   • `buildCallerLines`            — "Called from:" section for location hovers
 *   • `buildJumperLines`            — "Navigated from:" section for location hovers
 *   • `buildConsumedLocalsLine`     — "Consumes locals: …" line for location hovers
 *   • `buildUsedGlobalsSection`     — "Uses globals:" section for location hovers
 */
import type {
  VariableBinding,
  CursorValueEntry,
  SymbolLocation,
} from '../parser';
import { COMPOUND_OPS, CALL_FRAME_BUILTINS } from '../parser';
import { uriBasename as basename } from './helpers';
import type {
  DocumentState,
  BuildPossibleValuesOptions,
} from './featureTypes';
import type { SymbolAggregates } from './aggregation';

// Re-export for consumers
export type { BuildPossibleValuesOptions };

// ──────────────────────────────────────────────────────────────────────
// Text formatting helpers
// ──────────────────────────────────────────────────────────────────────

/** Max possible-value entries to render in a hover, to keep tooltips small. */
const MAX_HOVER_VALUES = 10;
/** Max location/line citations to render per distinct value before collapsing. */
const MAX_HOVER_LOCATIONS_PER_VALUE = 20;
/**
 * Max characters of a single rendered value snippet before truncating —
 * applied to string literals, opaque RHS text, and array-index expressions.
 */
const MAX_HOVER_STRING = 50;
/** Cap on the number of globals to render in the hover. */
const MAX_HOVER_GLOBALS = 25;

/**
 * Per-call-frame implicit locals — `args` (incoming arguments) and
 * `result` (function/dyneval return value).  These behave as locals
 * to each invocation, not as globals, so they should not surface in
 * the "Uses globals:" hover section even though they are not declared
 * with `local`.  Imported from the parser layer for a single source
 * of truth.
 */

/** Truncate `s` to `MAX_HOVER_STRING` chars, appending `…` when cut. */
function truncate(s: string): string {
  return s.length > MAX_HOVER_STRING ? s.slice(0, MAX_HOVER_STRING) + '…' : s;
}

/** Wrap `s` in a backtick code span, escaping interior backticks. */
function codeSpan(s: string): string {
  return '`' + s.replace(/`/g, '\\`') + '`';
}

/**
 * Render a single `VariableBinding` as a short inline markdown fragment.
 *
 * Every reachable shape is some subset of `{lhs}[idx] {op} {rhs}` with
 * an optional ` *(set by stmt)*` suffix.  We extract each piece, then
 * assemble — uniformly handling indexed/non-indexed, compound-op, and
 * side-effect writes.
 *
 * Reachable invariants (enforced by `bindingCollector`):
 *   - `kind` ∈ {string, number, var-ref, code-block} ⟹ `writeOp` and
 *     `indexText` are undefined (typed-RHS plain `=` only).
 *   - `indexText` set ⟹ `kind === 'other'` (indexed writes are opaque).
 *   - `writeOp` set ⟹ `kind === 'other'` (compound ops + side-effect
 *     writes always use the catch-all kind).
 */
function formatBindingValue(b: VariableBinding, varBaseName?: string): string {
  const v = b.value;

  // RHS text — kind-dependent, formatted once.
  let rhs: string | undefined;
  switch (v.kind) {
    case 'string':     rhs = '\'' + truncate(v.value) + '\''; break;
    case 'number':     rhs = String(v.value); break;
    case 'var-ref':    rhs = (v.readPrefix ?? '') + v.varBaseName; break;
    case 'code-block': rhs = '{ … }'; break;
    case 'other':      rhs = v.text ? truncate(v.text) : undefined; break;
  }

  // Side-effect writes (`setvar`, `scanstr`, …) always render as
  // plain `=` and carry a `*(set by stmt)*` suffix.  Compound-op
  // writes preserve the operator text (`+=`, `-=`, …).  Plain `=`
  // is the default when no `writeOp` is set.
  const isSideEffect = !!b.writeOp && !COMPOUND_OPS.has(b.writeOp);
  const op = b.writeOp && COMPOUND_OPS.has(b.writeOp) ? b.writeOp : '=';
  const setBy = isSideEffect ? ` *(set by ${b.writeOp})*` : '';

  // No assigned-name context: render the value (or side-effect tag) alone.
  if (!varBaseName) {
    if (isSideEffect) return rhs !== undefined ? codeSpan(rhs) + setBy : setBy.trimStart();
    if (v.kind === 'var-ref') return '→ ' + codeSpan(rhs!);
    return rhs !== undefined ? codeSpan(rhs) : '*(expr)*';
  }

  // Build LHS (with optional index).
  let lhs = (b.writePrefix ?? '') + varBaseName;
  if (b.indexText !== undefined) lhs += '[' + truncate(b.indexText) + ']';

  if (isSideEffect) {
    return rhs !== undefined
      ? codeSpan(lhs + ' = ' + rhs) + setBy
      : codeSpan(lhs) + setBy;
  }

  if (rhs !== undefined) return codeSpan(lhs + ' ' + op + ' ' + rhs);
  // Indexed write with no captured RHS — keep the slot LHS visible
  // and elide the value, rather than collapsing to `*(expr)*`.
  if (b.indexText !== undefined) return codeSpan(lhs + ' ' + op + ' …');
  return '*(expr)*';
}

// ──────────────────────────────────────────────────────────────────────
// buildPossibleValuesLines
// ──────────────────────────────────────────────────────────────────────

/**
 * Build the "**Possible values:**" hover section for a variable query.
 *
 * Returns [] when no statically-known values are available.
 *
 * Entries are grouped by origin (scope / cross-call / document),
 * capped at `MAX_HOVER_VALUES` in total, and annotated with line
 * numbers.  Cross-file entries carry a `[basename]` suffix.
 *
 * Var-ref entries (e.g. `$b = $g`) are flattened when `expandVarRef`
 * is provided — chain targets resolve against the document/project-
 * wide GLOBAL index.  Expansion is single-level only.
 */
export function buildPossibleValuesLines(
  entries: readonly CursorValueEntry[],
  hoverUri: string,
  options: BuildPossibleValuesOptions = {},
): string[] {
  if (entries.length === 0) return [];

  const order: CursorValueEntry['origin'][] = ['scope', 'cross-call', 'document'];
  const grouped = new Map<CursorValueEntry['origin'], CursorValueEntry[]>();
  for (const o of order) grouped.set(o, []);
  for (const e of entries) {
    if (e.binding.isValueBearing === false) continue;
    grouped.get(e.origin)!.push(e);
  }

  type FlatItem = { valueStr: string; locationStr: string };
  const flat: FlatItem[] = [];
  const expandedKeys = new Set<string>();

  for (const origin of order) {
    const group = grouped.get(origin)!.slice().sort((a, b) => {
      const aLocal = a.uri === hoverUri ? 0 : 1;
      const bLocal = b.uri === hoverUri ? 0 : 1;
      if (aLocal !== bLocal) return aLocal - bLocal;
      if (a.uri < b.uri) return -1;
      if (a.uri > b.uri) return 1;
      return a.binding.stmtLoc.line - b.binding.stmtLoc.line;
    });

    for (const e of group) {
      const originTag =
        !e.binding.isLocal ? '' :
        origin === 'cross-call' ? ' *(local via call)*' :
        ' *(local)*';

      if (e.binding.value.kind === 'var-ref' && options.expandVarRef) {
        const key = e.binding.value.varBaseName;
        if (expandedKeys.has(key)) continue;
        expandedKeys.add(key);
        const children = options.expandVarRef(key);
        if (children.length === 0) {
          const fileInfo = e.uri !== hoverUri ? ` [${basename(e.uri)}]` : '';
          flat.push({
            valueStr: formatBindingValue(e.binding, options.assignedVarName) + ' *(unresolved)*',
            locationStr: `\`${e.locationName}\` line ${e.binding.stmtLoc.line + 1}${fileInfo}`,
          });
        } else {
          for (const c of children) {
            const childFileInfo = c.uri !== hoverUri ? ` [${basename(c.uri)}]` : '';
            flat.push({
              valueStr: formatBindingValue(c.binding, key),
              locationStr: `\`${c.locationName}\` line ${c.binding.stmtLoc.line + 1}${childFileInfo}`,
            });
          }
        }
        continue;
      }

      const fileInfo = e.uri !== hoverUri ? ` [${basename(e.uri)}]` : '';
      flat.push({
        valueStr: formatBindingValue(e.binding, options.assignedVarName) + originTag,
        locationStr: `\`${e.locationName}\` line ${e.binding.stmtLoc.line + 1}${fileInfo}`,
      });
    }
  }

  // Group flat items by valueStr, preserving insertion order.
  const byValue = new Map<string, string[]>();
  for (const item of flat) {
    let locs = byValue.get(item.valueStr);
    if (!locs) { locs = []; byValue.set(item.valueStr, locs); }
    locs.push(item.locationStr);
  }

  // Render, capped at MAX_HOVER_VALUES distinct values; per value,
  // cap the inline location list at MAX_HOVER_LOCATIONS_PER_VALUE.
  const lines: string[] = ['', '**Possible values:**'];
  let shown = 0;
  let overflow = 0;
  for (const [valueStr, locs] of byValue) {
    if (shown >= MAX_HOVER_VALUES) { overflow++; continue; }
    let locStr: string;
    if (locs.length <= MAX_HOVER_LOCATIONS_PER_VALUE) {
      locStr = locs.join(', ');
    } else {
      const extra = locs.length - MAX_HOVER_LOCATIONS_PER_VALUE;
      locStr = locs.slice(0, MAX_HOVER_LOCATIONS_PER_VALUE).join(', ')
        + `, *…and ${extra} more*`;
    }
    lines.push('- ' + valueStr + ' — ' + locStr);
    shown++;
  }
  if (overflow > 0) {
    lines.push(`- *…and ${overflow} more*`);
  }
  return lines;
}

// ──────────────────────────────────────────────────────────────────────
// buildCallerLines / buildJumperLines
// ──────────────────────────────────────────────────────────────────────

type CallType = NonNullable<SymbolLocation['callType']>;

const RETURNING_CALLS: ReadonlySet<CallType> = new Set(['gosub', 'func', 'desc']);
const NAVIGATE_CALLS:  ReadonlySet<CallType> = new Set(['goto']);

/**
 * Internal: render a `header`-prefixed list of locations whose call
 * references against `targetKey` have a callType in `accept`.
 *
 * `includePropagatedLocals` adds a `(passes locals: …)` annotation
 * sourced from `agg.propagatedLocals` — only meaningful for returning
 * calls (gs/gosub/func/desc/@/@@), which actually propagate locals.
 */
function buildLocationCallerSection(
  documentStates: Map<string, DocumentState>,
  targetKey: string,
  header: string,
  hoverUri: string,
  out: string[],
  accept: ReadonlySet<CallType>,
  includePropagatedLocals: boolean,
): void {
  type Site = { line: number; texts: string[]; locals: Set<string> };
  const callers = new Map<string, { uri: string; defLine: number | undefined; sites: Site[] }>();
  for (const [docUri, st] of documentStates) {
    for (const [, ls] of st.symbols.locations) {
      const refSym = ls.locationRefs.get(targetKey);
      if (!refSym) continue;
      const callRefs = refSym.references.filter(r => r.callType && accept.has(r.callType));
      if (callRefs.length === 0) continue;
      const key = ls.locationName.toLowerCase();
      if (callers.has(key)) continue;
      const defLine = st.symbols.locationDefs.get(key)?.definition?.line;
      // Group call sites by source line.  Multiple distinct calls on
      // the same line (e.g. `gs 'foo' & gs 'bar'`) are listed
      // together under that line.  Identical duplicates collapse;
      // dedup uses the pre-truncation text so two long calls sharing
      // a truncated prefix are not collided.  `locals` is union'd
      // per-line — within a single source line every call shares the
      // same scope, so this is just a defensive merge.
      const byLine = new Map<number, { texts: string[]; seen: Set<string>; locals: Set<string> }>();
      for (const r of callRefs) {
        const raw = r.callText ?? r.callType ?? '';
        let bucket = byLine.get(r.line);
        if (!bucket) {
          bucket = { texts: [], seen: new Set(), locals: new Set() };
          byLine.set(r.line, bucket);
        }
        if (includePropagatedLocals && r.localsInScope) {
          for (const name of r.localsInScope.keys()) bucket.locals.add(name);
        }
        if (bucket.seen.has(raw)) continue;
        bucket.seen.add(raw);
        bucket.texts.push(truncateCallText(raw));
      }
      const sites: Site[] = [];
      for (const [line, bucket] of byLine) {
        bucket.texts.sort((a, b) => a.localeCompare(b));
        sites.push({ line: line + 1, texts: bucket.texts, locals: bucket.locals });
      }
      sites.sort((a, b) => a.line - b.line);
      callers.set(key, { uri: docUri, defLine, sites });
    }
  }
  if (callers.size === 0) return;
  out.push('');
  out.push(header);
  for (const [callerName, info] of callers) {
    const lineInfo = info.defLine !== undefined ? ` (line ${info.defLine + 1})` : '';
    const fInfo = info.uri !== hoverUri ? ` [${basename(info.uri)}]` : '';
    out.push(`- \`${callerName}\`${lineInfo}${fInfo}`);
    for (const s of info.sites) {
      const calls = s.texts.map(t => `\`${t}\``).join(CALL_SEP);
      const localsSuffix = s.locals.size > 0
        ? ' (passes locals: ' + [...s.locals].sort().map(l => `\`${l}\``).join(', ') + ')'
        : '';
      out.push(`  - line ${s.line}: ${calls}${localsSuffix}`);
    }
  }
}

/** Max chars per rendered call-text snippet before truncation with `…`. */
const MAX_CALL_TEXT_CHARS = 60;

/** Separator between distinct calls on the same source line. */
const CALL_SEP = ' · ';

/**
 * Truncate a call-site source snippet to keep the hover compact.
 * Whitespace is already collapsed at extraction time.
 */
function truncateCallText(text: string): string {
  return text.length > MAX_CALL_TEXT_CHARS
    ? text.slice(0, MAX_CALL_TEXT_CHARS - 1) + '…'
    : text;
}

/**
 * Build the "Called from:" section for a location hover.
 *
 * Only includes call sites that *return* control to the caller —
 * `gs`/`gosub`/`@@`, `func`/`@`, and `desc`.  Pure jumps
 * (`gt`/`goto`/`xgt`/`xgoto`) are excluded since the target is not
 * "called from" the source frame in any returnable sense.
 * Non-call references like `loc` are also excluded.
 */
export function buildCallerLines(
  documentStates: Map<string, DocumentState>,
  targetKey: string,
  header: string,
  hoverUri: string,
  out: string[],
): void {
  buildLocationCallerSection(
    documentStates, targetKey, header, hoverUri, out,
    RETURNING_CALLS, /* includePropagatedLocals */ true,
  );
}

/**
 * Build the "Navigated from:" section for a location hover.
 *
 * Only includes pure-jump references (`gt`/`goto`/`xgt`/`xgoto`),
 * which transfer control without returning.  Locals do not propagate
 * across goto-family transitions, so no `(passes locals: …)` suffix
 * is rendered.
 */
export function buildJumperLines(
  documentStates: Map<string, DocumentState>,
  targetKey: string,
  header: string,
  hoverUri: string,
  out: string[],
): void {
  buildLocationCallerSection(
    documentStates, targetKey, header, hoverUri, out,
    NAVIGATE_CALLS, /* includePropagatedLocals */ false,
  );
}

/**
 * Build a "`<label>`: …" line for a location hover, listing the
 * locals the location actually reads from its caller frame — i.e.
 * variables referenced as non-local at the top of the location's
 * scope (sourced from `agg.propagatedLocals[targetKey]`), unioned
 * with locals it shadows via its own `local` declaration
 * (`agg.shadowedPropagations[targetKey]`), and with the call-frame
 * implicit locals (`args`, `result`) when this location actually
 * references them.  Locals declared but never shadowing any
 * propagated value are NOT listed — those are caller-independent.
 *
 * `label` is the inline prefix (e.g. `'Consumes locals'`).  Pushes a
 * single line into `out` when non-empty.  Order is insertion-order
 * from the aggregate maps (consumed first, then any shadow-only
 * names, then `args`/`result`).
 */
export function buildConsumedLocalsLine(
  documentStates: Map<string, DocumentState>,
  agg: SymbolAggregates,
  targetKey: string,
  label: string,
  out: string[],
): void {
  const consumed = agg.propagatedLocals.get(targetKey);
  const shadowed = agg.shadowedPropagations.get(targetKey);
  const names = new Set<string>();
  if (consumed) for (const n of consumed.keys()) names.add(n);
  if (shadowed) for (const n of shadowed.keys()) names.add(n);

  // `args`/`result` are call-frame implicit locals: they are not
  // tracked through `propagatedLocals` (see NO_PROPAGATE in
  // aggregation.ts), but if this location actually references them
  // we still want to surface them here as part of its caller-frame
  // contract.  Look them up directly on the location's symbols.
  let locSyms: import('../parser').LocationSymbols | undefined;
  for (const [, st] of documentStates) {
    locSyms = st.symbols.getLocation(targetKey);
    if (locSyms) break;
  }
  if (locSyms) {
    for (const builtin of CALL_FRAME_BUILTINS) {
      const sym = locSyms.variables.get(builtin);
      if (sym && !sym.isLocal && sym.references.length > 0) names.add(builtin);
    }
  }

  if (names.size === 0) return;
  out.push('');
  out.push(
    `${label} `
    + [...names].map(n => `\`${n}\``).join(', '),
  );
}

/**
 * Build the "**Uses globals:**" section for a location hover.
 *
 * Lists every non-local, non-propagated-in variable referenced by the
 * target location.  Each entry annotates whether the location assigns
 * the variable in this scope and how many reads it has.  Order
 * follows insertion order in `locSyms.ownedVariables` (roughly source
 * order).  Capped at `MAX_HOVER_GLOBALS` entries.
 *
 * Globals here means *globals from THIS location's perspective* —
 * vars that aren't `local` and aren't received via caller-frame
 * propagation.  Cross-location ownership of those globals lives in
 * the variable hover, not here.
 */
export function buildUsedGlobalsSection(
  documentStates: Map<string, DocumentState>,
  agg: SymbolAggregates,
  targetKey: string,
  header: string,
  out: string[],
): void {
  // Resolve the target's LocationSymbols from any open document — the
  // location may live in a sibling file in project mode.
  let locSyms: import('../parser').LocationSymbols | undefined;
  for (const [, st] of documentStates) {
    locSyms = st.symbols.getLocation(targetKey);
    if (locSyms) break;
  }
  if (!locSyms) return;
  const propagated = agg.propagatedLocals.get(targetKey);

  type Entry = {
    name: string;
    defLine?: number;
    readCount: number;
  };
  const entries: Entry[] = [];
  for (const sym of locSyms.ownedVariables) {
    if (sym.isLocal) continue;
    if (propagated?.has(sym.nameLower)) continue;
    if (CALL_FRAME_BUILTINS.has(sym.nameLower)) continue;
    const refCount = sym.references.length;
    const readCount = refCount - (sym.definition ? 1 : 0);
    entries.push({
      name: sym.name,
      defLine: sym.definition?.line,
      readCount: Math.max(0, readCount),
    });
  }
  if (entries.length === 0) return;

  out.push('');
  out.push(header);
  let shown = 0;
  for (const e of entries) {
    if (shown >= MAX_HOVER_GLOBALS) {
      out.push(`- *…and ${entries.length - shown} more*`);
      break;
    }
    const parts: string[] = [];
    // Globals are always value-bearing when defined — there's no bare
    // `global x` declaration form.  A missing `defLine` simply means
    // the location only reads the variable.
    if (e.defLine !== undefined) parts.push(`assigned line ${e.defLine + 1}`);
    if (e.readCount > 0) {
      parts.push(`${e.readCount} read${e.readCount !== 1 ? 's' : ''}`);
    }
    const annot = parts.length > 0 ? ` — ${parts.join(', ')}` : '';
    out.push(`- \`${e.name}\`${annot}`);
    shown++;
  }
}
