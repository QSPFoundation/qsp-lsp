/**
 * Pure helper functions for QSP server logic.
 * Extracted so they can be unit-tested independently.
 */
import { URI } from 'vscode-uri';
import { qspFindInCode, qspScanCreate, qspScanRange, qspInCode, qspScanReset } from '../common/qspStringScanner';

// ── URI helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the filename portion of a URI for display in diagnostic messages.
 *
 * Uses `vscode-uri` so query strings, fragments, and percent-encoded
 * characters are handled correctly. Falls back to the raw URI when
 * parsing fails or the path is empty.
 */
export function uriBasename(uri: string): string {
  try {
    const p = URI.parse(uri).path;
    const slash = p.lastIndexOf('/');
    const name = slash >= 0 ? p.slice(slash + 1) : p;
    return name || uri;
  } catch {
    return uri;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Formatting
// ──────────────────────────────────────────────────────────────────────

export interface FormatOptions {
  /** Number of spaces per indent level (ignored when useTabs is true). */
  tabSize?: number;
  /** Use tab characters instead of spaces. */
  useTabs?: boolean;
  /** Line ending to use. Default `'\n'`. */
  eol?: string;
}

/**
 * Format an array of QSP source lines with correct indentation.
 *
 * Rules:
 * - Location headers (`# ...`) and separators (`---`) are always at column 0.
 * - `end` decreases indent *before* the line.
 * - `else` / `elseif` temporarily outdents to the parent level.
 * - Block-opening keywords (act/if/loop with a trailing colon, bare else)
 *   increase indent *after* the line.
 * - Labels (`:name`) stay at column 0.
 * - Empty lines are kept empty.
 *
 * @param lines      Raw source lines (may have arbitrary indentation).
 * @param baseIndent Starting indent level (default 0). Useful when formatting
 *                   a range that is already inside nested blocks.
 * @param opts       Formatting options.
 * @returns The re-indented lines joined with `opts.eol`.
 */
export function formatLines(
  lines: string[],
  baseIndent = 0,
  opts: FormatOptions = {},
): string {
  const tabSize = opts.tabSize ?? 2;
  const useTabs = opts.useTabs ?? false;
  const eol = opts.eol ?? '\n';
  const indentUnit = useTabs ? '\t' : ' '.repeat(tabSize);

  const result: string[] = [];
  let indentLevel = baseIndent;
  // Track whether we are inside a string literal ('\u2026' or "\u2026") or a
  // brace block ({\u2026}).  Lines where the scanner is not at top-level code
  // at the start of the line are continuation lines of a multi-line string or
  // block — their content is string data and must not be re-indented.
  const scanState = qspScanCreate();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Lines that are continuations of a multi-line string or brace block must
    // be passed through verbatim: re-indenting them would alter the string value.
    if (!qspInCode(scanState)) {
      result.push(line);
      qspScanRange(line, 0, line.length, scanState);
      continue;
    }

    const trimmed = line.trim();

    // Empty lines
    if (trimmed === '') {
      result.push('');
      // An empty line in code context carries no string-open characters.
      continue;
    }

    // Location headers and separators always at column 0.
    // Reset scanner state: the header text is not QSP code and any apostrophe
    // in it (e.g. "# it's a room") must not pollute the subsequent code context.
    if (trimmed.startsWith('#') || trimmed.startsWith('--')) {
      indentLevel = 0;
      result.push(trimmed);
      qspScanReset(scanState);
      continue;
    }

    // Labels always at column 0
    if (/^:[\p{L}_]/u.test(trimmed)) {
      result.push(trimmed);
      qspScanRange(trimmed, 0, trimmed.length, scanState);
      continue;
    }

    // 'end' keyword decreases indent before printing
    if (/^end\b/i.test(trimmed)) {
      indentLevel = Math.max(0, indentLevel - 1);
      result.push(indentUnit.repeat(indentLevel) + trimmed);
      qspScanRange(trimmed, 0, trimmed.length, scanState);
      continue;
    }

    // 'else' and 'elseif' temporarily decrease for that line
    if (/^(else\b|elseif\b)/i.test(trimmed)) {
      const tempIndent = Math.max(0, indentLevel - 1);
      result.push(indentUnit.repeat(tempIndent) + trimmed);
      qspScanRange(trimmed, 0, trimmed.length, scanState);
      // If this else/elseif opens a block, indent stays; it was
      // already bumped when the original if was opened.
      continue;
    }

    // Print at current indent
    result.push(indentUnit.repeat(indentLevel) + trimmed);
    qspScanRange(trimmed, 0, trimmed.length, scanState);

    // Block-opening keywords increase indent for subsequent lines
    if (opensBlock(trimmed)) {
      indentLevel++;
    }
  }

  return result.join(eol);
}

/**
 * Infer the current block-nesting depth at a given line by scanning
 * **forward** from the nearest location header (or start of file).
 * This mirrors `formatLines` logic exactly, including string/brace
 * awareness, so keywords inside strings are never mistaken for block
 * openers or closers.
 *
 * Returns the indent level that `formatLines` would assign to the line
 * at `startLine` given the preceding code.
 */
export function inferIndentLevel(allLines: string[], startLine: number): number {
  // Find the nearest location header at or before startLine.
  let scanFrom = 0;
  for (let i = startLine - 1; i >= 0; i--) {
    const t = allLines[i].trim();
    if (t.startsWith('#') || t.startsWith('--')) {
      scanFrom = i;
      break;
    }
  }

  const scanState = qspScanCreate();
  let depth = 0;

  for (let i = scanFrom; i < startLine; i++) {
    const line = allLines[i];

    if (!qspInCode(scanState)) {
      // Inside string/brace — scan for closing delimiter, no depth change.
      qspScanRange(line, 0, line.length, scanState);
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === '') continue;

    if (trimmed.startsWith('#') || trimmed.startsWith('--')) {
      depth = 0;
      qspScanReset(scanState);
      continue;
    }

    if (/^end\b/i.test(trimmed)) {
      depth = Math.max(0, depth - 1);
    } else if (/^(else\b|elseif\b)/i.test(trimmed)) {
      // else/elseif temporarily outdents for that line but keeps depth
    } else if (opensBlock(trimmed)) {
      qspScanRange(trimmed, 0, trimmed.length, scanState);
      depth++;
      continue;
    }

    qspScanRange(trimmed, 0, trimmed.length, scanState);
  }

  return Math.max(0, depth);
}

/**
 * Check if a trimmed line opens a **multi-line** block.
 *
 * Returns `true` only for block forms where the body starts on the NEXT line:
 *   - `if condition:`  / `act 'name':` / `loop ...:` → true  (block)
 *   - `if condition: body` / `act 'name': body`       → false (inline)
 *   - `else:` / bare `else`                           → true  (block)
 *   - `else: body` / `else body`                      → false (inline)
 *   - `elseif cond:` / `else if cond:`                → true  (block)
 *   - `elseif cond: body`                             → false (inline)
 *
 * A trailing comment (`! ...`) after the colon is NOT considered body content,
 * so `if cond: ! note` is still treated as a block opener.
 */
export function opensBlock(trimmed: string): boolean {
  // Must start with a block-opening keyword
  if (!/^(act|if|loop|elseif|else)\b/i.test(trimmed)) return false;

  const colonIdx = findColonOutsideStrings(trimmed);

  if (colonIdx >= 0) {
    // Has colon outside strings: block form only when nothing meaningful
    // follows (empty or only a comment).
    const afterColon = trimmed.slice(colonIdx + 1).trim();
    return afterColon === '' || afterColon.startsWith('!');
  }

  // No colon: only bare `else` can open a block.
  // `elseif x` / `else if x` / `else body` fall through naturally —
  // afterElse is non-empty and doesn't start with `!`.
  if (/^else\b/i.test(trimmed)) {
    const afterElse = trimmed.slice(4).trim();
    return afterElse === '' || afterElse.startsWith('!');
  }

  return false;
}

/**
 * Find the index of the first colon outside quoted strings.
 * Handles QSP's doubled-quote escapes ('' and "").
 * Returns -1 if no such colon exists.
 */
export function findColonOutsideStrings(text: string): number {
  return qspFindInCode(text, 0x3A /* : */);
}

/**
 * Given an inline statement line like `if x > 0: pl 'hi'`,
 * split it into the header (up to and including the colon) and the body.
 * Returns null if no colon outside strings or body is empty.
 */
export function splitInlineStatement(lineText: string): { header: string; body: string } | null {
  const colonIdx = findColonOutsideStrings(lineText);
  if (colonIdx < 0) return null;

  const header = lineText.slice(0, colonIdx + 1);
  const body = lineText.slice(colonIdx + 1).trim();
  if (body === '') return null;

  return { header, body };
}

/**
 * Build the block-form replacement text from an inline statement.
 * E.g. `if x > 0: pl 'hi'` → `if x > 0:\n  pl 'hi'\nend`
 *
 * @param eol Line ending to use in the replacement (default `'\n'`).
 */
export function buildBlockReplacement(lineText: string, eol = '\n'): string | null {
  const parts = splitInlineStatement(lineText);
  if (!parts) return null;

  const indent = lineText.match(/^(\s*)/)?.[1] ?? '';
  const innerIndent = indent + '  ';

  return `${parts.header}${eol}${innerIndent}${parts.body}${eol}${indent}end`;
}

// ──────────────────────────────────────────────────────────────────────
// Act-name parsing
// ──────────────────────────────────────────────────────────────────────

/**
 * Parse an act line and extract the display name for the outline.
 *
 * Handles all act forms:
 *   act 'name':              → "name"        (simple quoted)
 *   act "name":              → "name"
 *   act 'name', 'img':       → "name"        (multi-arg, first only)
 *   act ('name'):            → "name"        (parenthesized)
 *   act ('name', 'img'):     → "name"
 *   act 'test ' + $name:    → "'test ' + $name"  (expression)
 *   act $var:                → "$var"
 *   act 'has:colon':        → "has:colon"    (colon inside quotes)
 *   act 'name'              → "name"         (mid-edit, no colon)
 *   act 'line one\n          → "line one line two" (multiline string)
 *        line two':
 *
 * Accepts remaining text from the act line onward (may be multiline).
 * Returns null if no act keyword, otherwise { name, extraLines }.
 */
export function parseActName(text: string): { name: string; extraLines: number } | null {
  const actMatch = text.match(/^\s*act[\s(]/i);
  if (!actMatch) return null;

  let pos = actMatch[0].length - 1; // back up to the space or '('
  // Skip optional opening paren and whitespace (incl. newlines after paren)
  let sawParen = false;
  while (pos < text.length) {
    const pc = text[pos];
    if (pc === '(') { sawParen = true; pos++; }
    else if (pc === ' ' || pc === '\t') { pos++; }
    else if (sawParen && (pc === '\n' || pc === '\r')) { pos++; }
    else break;
  }
  if (pos >= text.length) return null;

  const startPos = pos;
  const ch = text[pos];

  /** Count \n characters in text[0..end). */
  function newlinesBefore(end: number): number {
    let n = 0;
    for (let j = 0; j < end; j++) {
      if (text.charCodeAt(j) === 0x0A) n++;
    }
    return n;
  }

  /** Collapse newlines to spaces for display names. */
  function displayName(raw: string): string {
    return raw.indexOf('\n') >= 0 ? raw.replace(/\r?\n/g, ' ') : raw;
  }

  if (ch === "'" || ch === '"') {
    // Starts with a quote — find the matching close (skip '' / "" escapes)
    let closePos = pos + 1;
    while (closePos < text.length) {
      closePos = text.indexOf(ch, closePos);
      if (closePos < 0) break;
      if (closePos + 1 < text.length && text[closePos + 1] === ch) {
        closePos += 2; // skip doubled-quote escape
        continue;
      }
      break;
    }
    if (closePos < 0) {
      // No closing quote — mid-edit, return first-line partial
      const eol = text.indexOf('\n');
      const partial = (eol >= 0 ? text.slice(pos + 1, eol) : text.slice(pos + 1)).trim();
      return partial ? { name: partial, extraLines: 0 } : null;
    }

    // Check what follows the closing quote (skip whitespace incl. newlines)
    let after = closePos + 1;
    while (after < text.length && text.charCodeAt(after) <= 0x20) after++;

    const nextChar = text[after];
    if (nextChar === ':' || nextChar === ',' || nextChar === ')' || after >= text.length) {
      // Simple quoted string — strip quotes and unescape doubled quotes
      const raw = text.slice(pos + 1, closePos);
      const unescaped = raw.includes(ch) ? raw.split(ch + ch).join(ch) : raw;
      return { name: displayName(unescaped), extraLines: newlinesBefore(after) };
    }

    // An operator follows (e.g. +, &) — it's a complex expression.
    // Fall through to expression scanning below.
  }

  // Expression: scan for the terminating ':' or ',' outside quotes.
  // Bare newline outside quotes and parens terminates the scan
  // (newline = statement boundary in QSP).
  let inQuote: string | null = null;
  let parenDepth = 0;
  for (let i = startPos; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === inQuote) {
        // Doubled quote ('' or "") is an escape — stay in string
        if (i + 1 < text.length && text[i + 1] === inQuote) {
          i++; // skip the second quote
        } else {
          inQuote = null;
        }
      }
    } else if (c === "'" || c === '"') {
      inQuote = c;
    } else if (c === '\n' || c === '\r') {
      if (parenDepth === 0) break; // statement boundary
    } else if (c === '(') {
      parenDepth++;
    } else if (c === ')' && parenDepth === 0) {
      // Closing paren of act(...) — treat as end-of-expression.
      const raw = text.slice(startPos, i).trim();
      if (!raw) return null;
      return { name: displayName(raw), extraLines: newlinesBefore(i) };
    } else if (c === ')') {
      parenDepth--;
    } else if ((c === ',' || c === ':') && parenDepth === 0) {
      const raw = text.slice(startPos, i).trim();
      if (!raw) return null;
      return { name: displayName(raw), extraLines: newlinesBefore(i) };
    }
  }

  // No colon or comma found — mid-edit, return first-line content
  const eol = text.indexOf('\n', startPos);
  const remaining = (eol >= 0 ? text.slice(startPos, eol) : text.slice(startPos)).trim();
  return remaining ? { name: remaining, extraLines: 0 } : null;
}
