/**
 * Shared QSP string / brace state machine.
 *
 * Tracks whether we're inside a string literal ('…' or "…") or a
 * brace block ({…}), correctly handling QSP's doubled-quote escapes
 * ('' inside '…' and "" inside "…").
 *
 * Two entry points cover every use-case in the codebase:
 *
 *  • `qspScanRange` — advance a persistent, mutable state across a
 *    byte range.  Used by locationIndex and locationBlocks where the
 *    scanner state spans multiple calls / lines.
 *
 *  • `qspFindInCode` — one-shot search for a character code that
 *    appears in top-level code (not inside a string).  Used for
 *    finding colons (statement separator) and similar single-line
 *    lookups.  Does NOT track braces (unnecessary on single lines).
 */

// ── Persistent-state scanner ────────────────────────────────────────

/**
 * Mutable scanner state.  Create once, reuse across calls.
 * - `str`: 0 = code, 1 = inside '…', 2 = inside "…"
 * - `braces`: balanced {…} nesting depth
 */
export interface QspScanState {
  str: number;
  braces: number;
}

/** Create a fresh scan state in code context. */
export function qspScanCreate(): QspScanState {
  return { str: 0, braces: 0 };
}

/** Reset state to code context. */
export function qspScanReset(s: QspScanState): void {
  s.str = 0;
  s.braces = 0;
}

/** True when the scanner is in top-level code (not inside string or braces). */
export function qspInCode(s: QspScanState): boolean {
  return s.str === 0 && s.braces === 0;
}

/**
 * Advance the scanner over `text[start .. end)`.
 *
 * Updates `state` in place.  The hot loop copies state fields into
 * local variables and writes back once — V8 keeps them in registers
 * for maximum throughput on 80 MB+ files.
 */
export function qspScanRange(
  text: string,
  start: number,
  end: number,
  state: QspScanState,
): void {
  let strState = state.str;
  let braceDepth = state.braces;

  for (let i = start; i < end; i++) {
    const ch = text.charCodeAt(i);
    if (strState === 0) {
      if (ch === 0x27 /* ' */) { strState = 1; }
      else if (ch === 0x22 /* " */) { strState = 2; }
      else if (ch === 0x7B /* { */) { braceDepth++; }
      else if (ch === 0x7D /* } */ && braceDepth > 0) { braceDepth--; }
    } else if (strState === 1) {
      if (ch === 0x27 /* ' */) {
        if (i + 1 < end && text.charCodeAt(i + 1) === 0x27) {
          i++; // skip doubled '' escape
        } else {
          strState = 0;
        }
      }
    } else /* strState === 2 */ {
      if (ch === 0x22 /* " */) {
        if (i + 1 < end && text.charCodeAt(i + 1) === 0x22) {
          i++; // skip doubled "" escape
        } else {
          strState = 0;
        }
      }
    }
  }

  state.str = strState;
  state.braces = braceDepth;
}

// ── One-shot character search ───────────────────────────────────────

/**
 * Find the index of the first `target` character code that appears in
 * top-level code (not inside a string literal).
 *
 * Handles QSP's doubled-quote escapes ('' and "").
 * Does NOT track {…} braces — unnecessary for single-line lookups.
 *
 * Returns -1 if no such character is found.
 */
export function qspFindInCode(text: string, target: number): number {
  let strState = 0; // 0=code  1=in '…'  2=in "…"
  const len = text.length;

  for (let i = 0; i < len; i++) {
    const ch = text.charCodeAt(i);
    if (strState === 0) {
      if (ch === target) return i;
      if (ch === 0x27 /* ' */) { strState = 1; }
      else if (ch === 0x22 /* " */) { strState = 2; }
    } else if (strState === 1) {
      if (ch === 0x27 /* ' */) {
        if (i + 1 < len && text.charCodeAt(i + 1) === 0x27) {
          i++; // skip doubled '' escape
        } else {
          strState = 0;
        }
      }
    } else /* strState === 2 */ {
      if (ch === 0x22 /* " */) {
        if (i + 1 < len && text.charCodeAt(i + 1) === 0x22) {
          i++; // skip doubled "" escape
        } else {
          strState = 0;
        }
      }
    }
  }

  return -1;
}
