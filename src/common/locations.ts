/**
 * QSP location parsing and manipulation.
 *
 * Provides two complementary APIs:
 *   1. Fast server-side location index: `buildLocationIndex` + lookup helpers.
 *      Jumps between `\n#` / `\n--` markers using indexOf, counting lines lazily.
 *   2. Client-side block parser: `parseLocationBlocks` + split/merge/reorder helpers.
 *      Used by sort, move, duplicate, delete, and rename commands.
 *
 * String-aware: both paths track multi-line strings and {…} code blocks so
 * `--` / `---` inside content is not mistaken for a location terminator.
 *
 * This module has NO dependency on `vscode` or tree-sitter — pure text processing.
 */
import { qspScanCreate, qspScanReset, qspScanRange, qspInCode } from './qspStringScanner';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

/** Location index entry — mapped from parseLocationBlocks for the server. */
export interface LocationEntry {
  /** Location name as written in source (preserves case). */
  name: string;
  /** Lowercase name for case-insensitive lookups. */
  nameLower: string;
  /** Line number of the '#' marker (0-based). */
  startLine: number;
  /** Line number of the '--' marker (0-based). */
  endLine: number;
  /** Character offset of the '#' marker. */
  startOffset: number;
  /** Character offset after the '--' line. */
  endOffset: number;
}

/** Location block — parsed by the client for UI commands. */
export interface LocationBlock {
  name: string;
  content: string;       // Full text including # header and --- footer
  start: number;         // Byte offset in document
  end: number;           // Byte offset of end (past the ---\n)
  startLine: number;     // 0-based line of # header
  endLine: number;       // 0-based line of --- footer
}

// ──────────────────────────────────────────────────────────────────────
// Location index (server-side, fast)
// ──────────────────────────────────────────────────────────────────────

/**
 * Fast scan of a QSP file to build a location index.
 *
 * Jumps directly between `\n#` (location header) and `\n--` (location end)
 * markers using indexOf, skipping all non-marker content.  Line numbers
 * are counted lazily — only between consecutive markers.
 *
 * Relies on two QSP format invariants:
 *  - `#` and `--` are always at column 0 (right after `\n` or at offset 0)
 *  - `--` cannot appear inside strings or code blocks
 */
export function buildLocationIndex(text: string): LocationEntry[] {
  const entries: LocationEntry[] = [];
  const len = text.length;
  if (len === 0) return entries;

  // Lazy line counter: count newlines between knownOffset and target offset.
  let knownOffset = 0;
  let knownLine = 0;

  function lineAt(offset: number): number {
    let pos = knownOffset;
    while (pos < offset) {
      const nl = text.indexOf('\n', pos);
      if (nl === -1 || nl >= offset) break;
      knownLine++;
      pos = nl + 1;
    }
    knownOffset = offset;
    return knownLine;
  }

  /** Extract trimmed location name after '#' at `hashPos`. */
  function parseName(hashPos: number): string | null {
    let eol = text.indexOf('\n', hashPos);
    if (eol === -1) eol = len;
    if (text.charCodeAt(eol - 1) === 0x0D) eol--; // strip \r

    let s = hashPos + 1;
    while (s < eol && text.charCodeAt(s) <= 0x20) s++;    // trim left
    let e = eol;
    while (e > s && text.charCodeAt(e - 1) <= 0x20) e--;  // trim right
    return e > s ? text.slice(s, e) : null;
  }

  /** Content-end offset of a '--' line (before \r\n). */
  function dashEnd(dashPos: number): number {
    let eol = text.indexOf('\n', dashPos);
    if (eol === -1) eol = len;
    return text.charCodeAt(eol - 1) === 0x0D ? eol - 1 : eol;
  }

  let openName = '';
  let openNameLower = '';
  let openStartLine = -1;
  let openStartOffset = -1;

  // Handle '#' at position 0 (no preceding \n)
  if (text.charCodeAt(0) === 0x23 /* # */) {
    const name = parseName(0);
    if (name) {
      openName = name;
      openNameLower = name.toLowerCase();
      openStartLine = 0;
      openStartOffset = 0;
    }
  }

  const scan = qspScanCreate();
  let scanPos = 0;
  let pos = 0;

  while (true) {
    if (openStartLine < 0) {
      // No open location → find next header: \n#
      const idx = text.indexOf('\n#', pos);
      if (idx === -1) break;
      const hashPos = idx + 1;
      const name = parseName(hashPos);
      if (name) {
        openName = name;
        openNameLower = name.toLowerCase();
        openStartLine = lineAt(hashPos);
        openStartOffset = hashPos;
        let bodyStart = text.indexOf('\n', hashPos);
        if (bodyStart === -1) bodyStart = len;
        else bodyStart++;
        scanPos = bodyStart;
        qspScanReset(scan);
      }
      pos = hashPos + 1;
    } else {
      // Inside a location → find its end: \n--
      const idx = text.indexOf('\n--', pos);
      if (idx === -1) break;
      const dashPos = idx + 1;

      // Check if this -- is inside a string or code block
      qspScanRange(text, scanPos, dashPos, scan);
      scanPos = dashPos;
      if (!qspInCode(scan)) {
        pos = dashPos + 2;
        continue;
      }

      entries.push({
        name: openName,
        nameLower: openNameLower,
        startLine: openStartLine,
        endLine: lineAt(dashPos),
        startOffset: openStartOffset,
        endOffset: dashEnd(dashPos),
      });
      openStartLine = -1;
      pos = dashPos + 2;
    }
  }

  // Handle unclosed final location
  if (openStartLine >= 0) {
    const lastLine = lineAt(len);
    entries.push({
      name: openName,
      nameLower: openNameLower,
      startLine: openStartLine,
      endLine: Math.max(lastLine, openStartLine),
      startOffset: openStartOffset,
      endOffset: len,
    });
  }

  return entries;
}

/**
 * Find the location that contains the given line number.
 * Binary search — O(log N).
 */
export function findLocationAtLine(
  index: LocationEntry[],
  line: number,
): LocationEntry | undefined {
  let low = 0;
  let high = index.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const loc = index[mid];
    if (line < loc.startLine) { high = mid - 1; }
    else if (line > loc.endLine) { low = mid + 1; }
    else { return loc; }
  }
  return undefined;
}

/**
 * Find a location by name (case-insensitive). O(N) scan.
 */
export function findLocationByName(
  index: LocationEntry[],
  name: string,
): LocationEntry | undefined {
  const lower = name.toLowerCase();
  return index.find(loc => loc.nameLower === lower);
}

/**
 * Extract the text content of a specific location from the full document text.
 */
export function getLocationText(text: string, loc: LocationEntry): string {
  return text.slice(loc.startOffset, loc.endOffset);
}

// ──────────────────────────────────────────────────────────────────────
// Location block parser (client-side)
// ──────────────────────────────────────────────────────────────────────

/** Detect line ending style from raw text. */
function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Parse QSP location blocks from raw text using a streaming line iterator.
 * Avoids `text.split(/\r?\n/)` which allocates a 1M+ element array for 80MB+ files.
 */
export function parseLocationBlocks(text: string): LocationBlock[] {
  const blocks: LocationBlock[] = [];
  const len = text.length;
  if (len === 0) return blocks;

  let lineStartOffset = 0;
  let lineIdx = 0;
  let nextLineStart = 0;
  let currentLine: string | null = null;

  /** Advance to the next line. Returns false at EOF. */
  function nextLine(): boolean {
    if (nextLineStart >= len) { currentLine = null; return false; }
    lineStartOffset = nextLineStart;
    const nl = text.indexOf('\n', nextLineStart);
    if (nl === -1) {
      currentLine = text.slice(nextLineStart);
      nextLineStart = len;
    } else {
      let e = nl;
      if (e > 0 && text.charCodeAt(e - 1) === 0x0D /* \r */) e--;
      currentLine = text.slice(nextLineStart, e);
      nextLineStart = nl + 1;
    }
    lineIdx++;
    return true;
  }

  let blockStartLine = -1;
  let blockStartOffset = -1;
  let blockName = '';
  const scan = qspScanCreate();

  while (nextLine()) {
    const line = currentLine!;
    const lineLen = line.length;

    // If inside a location, scan this line for string/brace state
    if (blockStartLine >= 0) {
      if (!qspInCode(scan)) {
        qspScanRange(line, 0, lineLen, scan);
        continue;
      }
    }

    const headerMatch = line.match(/^#\s*(.+?)\s*$/);

    if (headerMatch && blockStartLine < 0) {
      blockStartLine = lineIdx - 1;
      blockStartOffset = lineStartOffset;
      blockName = headerMatch[1];
      qspScanReset(scan);
    } else if (/^--/.test(line) && blockStartLine >= 0) {
      const end = lineStartOffset + lineLen;
      blocks.push({
        name: blockName,
        content: text.slice(blockStartOffset, end),
        start: blockStartOffset,
        end,
        startLine: blockStartLine,
        endLine: lineIdx - 1,
      });
      blockStartLine = -1;
      qspScanReset(scan);
    } else if (blockStartLine >= 0) {
      qspScanRange(line, 0, lineLen, scan);
    }
  }

  // Handle unclosed final location
  if (blockStartLine >= 0) {
    blocks.push({
      name: blockName,
      content: text.slice(blockStartOffset),
      start: blockStartOffset,
      end: len,
      startLine: blockStartLine,
      endLine: lineIdx - 1,
    });
  }

  return blocks;
}

// ──────────────────────────────────────────────────────────────────────
// Split / merge / reorder helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Compute the inter-location text gaps that precede each block and
 * any trailing text after the last block.
 */
export function computeLocationGaps(
  text: string,
  blocks: LocationBlock[],
): { gapsBefore: string[]; trailing: string } {
  const gapsBefore: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const gapStart = i === 0 ? 0 : blocks[i - 1].end;
    const gapEnd = blocks[i].start;
    gapsBefore.push(text.slice(gapStart, gapEnd).replace(/^\r?\n/, ''));
  }
  const trailing = blocks.length > 0
    ? text.slice(blocks[blocks.length - 1].end).replace(/^\r?\n/, '')
    : '';
  return { gapsBefore, trailing };
}

/**
 * Build the file content for one location produced by "split".
 */
export function buildSplitFileContent(
  blockContent: string,
  gapBefore: string,
  trailing: string | null,
): string {
  let content = '';
  if (gapBefore.trim()) content += gapBefore.replace(/\r?\n$/, '') + '\n';
  content += blockContent;
  if (trailing !== null && trailing.trim()) content += '\n' + trailing.replace(/\r?\n$/, '');
  return content + '\n';
}

/**
 * Build the merged file content from a list of selected locations.
 */
export function buildMergedContent(
  items: { content: string; gapBefore: string }[],
): string {
  let content = '';
  for (const item of items) {
    if (content) content += '\n';
    if (item.gapBefore.trim()) content += item.gapBefore.replace(/\r?\n$/, '') + '\n';
    content += item.content;
  }
  content += '\n';
  return content;
}

/**
 * Build the target file content for "move locations to file".
 */
export function buildMoveTargetContent(
  items: { content: string; gapBefore: string }[],
  existingContent: string,
): string {
  const locContent = buildMergedContent(items);
  return existingContent
    ? existingContent.trimEnd() + '\n\n' + locContent
    : locContent;
}

/**
 * Reorder location blocks within a file, preserving inter-location
 * gap text (comments, blank lines) with each block.
 *
 * Text before the first block (preamble) belongs to the first block
 * and travels with it.  Text between two blocks belongs to the block
 * that follows it.  Text after the last block (trailing) belongs to
 * the last block and travels with it.
 *
 * @param text      Full file content.
 * @param newOrder  Array of original 0-based block indices in the desired order.
 *                  Must be a permutation of [0..blocks.length-1].
 */
export function reorderLocations(
  text: string,
  newOrder: number[],
): string {
  const blocks = parseLocationBlocks(text);
  if (blocks.length <= 1) return text;
  const { gapsBefore, trailing } = computeLocationGaps(text, blocks);
  const eol = detectEol(text);
  const stripTrailingEol = (s: string) => s.replace(/\r?\n$/, '');
  const lastIdx = blocks.length - 1;

  const parts: string[] = [];
  for (let i = 0; i < newOrder.length; i++) {
    const origIdx = newOrder[i];
    const gap = gapsBefore[origIdx];
    if (i > 0) parts.push(eol);
    if (gap.trim()) parts.push(stripTrailingEol(gap), eol);
    parts.push(blocks[origIdx].content);
    if (origIdx === lastIdx && trailing.trim())
      parts.push(eol, stripTrailingEol(trailing));
  }

  let result = parts.join('');
  if (!result.endsWith('\n')) result += eol;
  return result;
}

/**
 * Compute the text that remains in a source file after removing
 * selected location blocks along with their preceding gap text
 * and (for the last block) any trailing text.
 */
export function removeSelectedLocations(
  text: string,
  selectedIndices: Set<number>,
): string {
  if (selectedIndices.size === 0) return text;
  const blocks = parseLocationBlocks(text);
  if (blocks.length === 0) return text;
  const { gapsBefore, trailing } = computeLocationGaps(text, blocks);
  const lines = text.split(/\r?\n/);
  const eol = detectEol(text);
  const linesToDelete = new Set<number>();

  for (const idx of selectedIndices) {
    if (idx < 0 || idx >= blocks.length) continue;
    const block = blocks[idx];
    const gap = gapsBefore[idx];

    for (let l = block.startLine; l <= block.endLine; l++) {
      linesToDelete.add(l);
    }

    if (gap.trim().length > 0) {
      const gapStartLine = idx === 0 ? 0 : blocks[idx - 1].endLine + 1;
      for (let l = gapStartLine; l < block.startLine; l++) {
        linesToDelete.add(l);
      }
    }

    if (idx === blocks.length - 1 && trailing.trim().length > 0) {
      for (let l = block.endLine + 1; l < lines.length; l++) {
        linesToDelete.add(l);
      }
    }
  }

  const kept = lines.filter((_, i) => !linesToDelete.has(i));
  return kept.join(eol);
}

/**
 * Sanitize a location name for use as a file name and deduplicate
 * against already-used names.
 */
export function sanitizeLocationName(
  name: string,
  usedNames: Set<string>,
): string {
  let safeName = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'unnamed';
  const baseName = safeName;
  let counter = 2;
  while (usedNames.has(safeName.toLowerCase())) {
    safeName = `${baseName}_${counter++}`;
  }
  usedNames.add(safeName.toLowerCase());
  return safeName;
}
