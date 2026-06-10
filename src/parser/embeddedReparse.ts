/**
 * Shared primitives for re-parsing a `<<…>>` interpolation body as a
 * standalone QSP fragment.
 *
 * Both the symbol-extraction "special parser" ({@link
 * import('./embeddedInterpolation')}) and the error-classification path
 * ({@link import('./extractErrors')}) need to (a) decode the host
 * string's doubled-quote escapes and (b) wrap the decoded body in a
 * synthetic location so it parses as a single expression.
 *
 * This module is a dependency-free LEAF so both callers can share the
 * exact same decode + wrapper without a circular import (`embeddedShared`
 * depends on `extractErrors`, so `extractErrors` cannot import from it).
 */

/** Wrap an interpolation body as the RHS of an assignment. */
export const INTP_WRAPPER_PREFIX = '# __intp__\n_r_=(';
export const INTP_WRAPPER_SUFFIX = ')\n---\n';

/** Column where the body begins on line 1 of a wrapped sub-tree. */
export const INTP_BODY_SUB_COL = '_r_=('.length;

/** Wrap a decoded interpolation body so it parses as a location body. */
export function wrapInterpolationBody(decoded: string): string {
  return INTP_WRAPPER_PREFIX + decoded + INTP_WRAPPER_SUFFIX;
}

/**
 * Decode QSP doubled-quote escapes (`qq` → `q` where `q` is `hostQuote`)
 * in `raw`.  Returns the decoded text plus a `decoded → raw` shift map
 * (`extra[d]` = number of escape pairs collapsed strictly before
 * decoded position `d`); `extra` is `null` when no escapes were
 * present (fast path — avoids an O(n) allocation).
 *
 * Hot path on large host strings: chunks between escapes are copied
 * via `substring` (one V8-allocated slice each) and joined once, and
 * `extra` is a pre-sized `Int32Array` filled by chunk rather than by
 * per-character `push`.
 */
export function decodeDoubledQuotes(
  raw: string,
  hostQuote: string,
): { text: string; extra: Int32Array | null } {
  const dq = hostQuote + hostQuote;
  let i = raw.indexOf(dq);
  if (i < 0) return { text: raw, extra: null };

  const parts: string[] = [];
  // `extra` has one entry per decoded position INCLUDING the
  // sentinel at the end (length = decoded.length + 1), so callers can
  // safely look up `extra[decoded.length]` when projecting end-of-body.
  // Decoded length is at most `raw.length`; we size to that and slice
  // at the end.
  const extra = new Int32Array(raw.length + 1);
  let start = 0;       // start of next un-copied raw chunk
  let decLen = 0;      // current decoded length
  let escapes = 0;
  while (i >= 0) {
    // Copy raw[start..i] verbatim, then the collapsed quote.
    if (i > start) {
      parts.push(raw.substring(start, i));
      extra.fill(escapes, decLen, decLen + (i - start) + 1);
      decLen += (i - start);
    } else {
      extra[decLen] = escapes;
    }
    parts.push(hostQuote);
    decLen++;
    escapes++;
    extra[decLen] = escapes;
    start = i + 2;
    i = raw.indexOf(dq, start);
  }
  if (start < raw.length) {
    parts.push(raw.substring(start));
    const tailLen = raw.length - start;
    extra.fill(escapes, decLen, decLen + tailLen + 1);
    decLen += tailLen;
  }
  return { text: parts.join(''), extra: extra.subarray(0, decLen + 1) };
}

/** A source position (0-based row + column). */
export interface SourcePos {
  row: number;
  column: number;
}

/**
 * Build a projector that maps a *decoded-inner* offset back to its
 * source `(row, column)`.
 *
 * `innerRow` / `innerCol` are the source position of decoded offset `0`
 * — i.e. the first character of the host's inner text (just past the
 * opening `'` / `"` / `<<`).
 *
 * Newlines are never part of a doubled-quote escape (`''` / `""` are two
 * adjacent quote chars), so a decoded newline maps 1:1 to a raw newline.
 * The source row therefore advances by the decoded newline count and the
 * column resets to the raw line offset after each newline — which lets
 * the same flat `extra` shift map drive multi-line projection.
 *
 * Newline offsets are scanned once; each projection is an O(log n)
 * binary search with no per-call allocation.
 */
export function makeOffsetProjector(
  decoded: string,
  extra: Int32Array | null,
  innerRow: number,
  innerCol: number,
): (d: number) => SourcePos {
  const nl: number[] = [];
  for (let k = decoded.indexOf('\n'); k >= 0; k = decoded.indexOf('\n', k + 1)) nl.push(k);
  const rawOf = extra
    ? (d: number): number => d + extra[d]
    : (d: number): number => d;
  return (d: number): SourcePos => {
    const raw = rawOf(d);
    // Count newlines strictly before `d`.
    let lo = 0;
    let hi = nl.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (nl[mid] < d) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return { row: innerRow, column: innerCol + raw };
    // Column is the raw distance from the start of the current line
    // (one past the previous newline).
    return { row: innerRow + lo, column: raw - rawOf(nl[lo - 1]) - 1 };
  };
}

/**
 * Decoded-offset of each body line's first character, relative to the
 * body's own start.  `starts[0]` is always `0`; subsequent entries mark
 * the character after each newline within the body.  Used to translate a
 * wrapped sub-tree row (body line index) into a decoded offset.
 */
export function bodyLineStarts(decoded: string, bodyStart: number, bodyLen: number): number[] {
  const starts = [0];
  const end = bodyStart + bodyLen;
  for (let k = decoded.indexOf('\n', bodyStart); k >= 0 && k < end; k = decoded.indexOf('\n', k + 1)) {
    starts.push(k - bodyStart + 1);
  }
  return starts;
}
