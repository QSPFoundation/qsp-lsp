/**
 * Regex-based fallback symbol extraction.
 *
 * Used when tree-sitter is unavailable (initial load, browser bundle
 * before WASM is fetched) or when tree-sitter reports parse errors and
 * we need to fill in symbols on lines it couldn't recover.
 *
 * These helpers are pure — they take text and a `LocationEntry` and
 * mutate the supplied `DocumentSymbols`/`LocationSymbols`.  No server
 * state, no parser handle, no settings.
 */
import { DocumentSymbols } from '../parser/symbolTable';
import type { LocationEntry } from '../common/locations';
import { parseActName } from './helpers';

const LABEL_RE = /^\s*:([\p{L}_][\p{L}\p{N}_]*)/u;

type LocSyms = ReturnType<DocumentSymbols['addLocation']>;

/**
 * Compute the 0-based column of a location's name within its header
 * line.  Falls back to column 1 (right after `#`) when `indexOf`
 * can't find it (e.g. the location header was synthesised).
 */
export function locationNameCol(text: string, loc: LocationEntry): number {
  const headerEnd = text.indexOf('\n', loc.startOffset);
  const nameStart = text.indexOf(loc.name, loc.startOffset + 1);
  return (nameStart >= 0 && (headerEnd < 0 || nameStart < headerEnd))
    ? nameStart - loc.startOffset : 1;
}

/** Split a location's slice of `text` into newline-delimited lines. */
export function splitLocationLines(text: string, loc: LocationEntry): string[] {
  return text.slice(loc.startOffset, loc.endOffset).split(/\r?\n/);
}

/**
 * Regex-based action extraction from pre-split lines.
 * @param skipLines  Optional set of absolute line numbers to skip
 *   (used by the merge path to avoid overwriting tree-sitter results).
 */
export function extractActionsFromLines(
  lines: string[],
  startLine: number,
  locSymbols: LocSyms,
  uri: string,
  skipLines?: Set<number | undefined>,
): void {
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*act[\s(]/i.test(lines[i])) continue;
    const absLine = startLine + i;
    if (skipLines?.has(absLine)) continue;
    const result = parseActName(lines.slice(i).join('\n'));
    if (result !== null) {
      const endIdx = i + result.extraLines;
      locSymbols.addAction(result.name, {
        uri,
        line: absLine,
        column: 0,
        endLine: startLine + endIdx,
        endColumn: lines[endIdx]?.length ?? lines[i].length,
      });
      i += result.extraLines;
    }
  }
}

/**
 * Regex-based label extraction from pre-split lines.
 *
 * The regex fallback has no scope information, so it inserts every
 * label into the location-root namespace bucket (key 0).  Pass
 * `skipLines` from the merge path to avoid creating phantom root
 * duplicates of labels tree-sitter already extracted into act /
 * code-block namespaces.
 */
export function extractLabelsFromLines(
  lines: string[],
  startLine: number,
  locSymbols: LocSyms,
  uri: string,
  skipLines?: Set<number | undefined>,
): void {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LABEL_RE);
    if (m) {
      const labelName = m[1];
      const col = lines[i].indexOf(':' + labelName);
      const absLine = startLine + i;
      if (skipLines?.has(absLine)) continue;
      locSymbols.addLabel(labelName, {
        uri,
        line: absLine,
        column: col,
        endLine: absLine,
        endColumn: col + labelName.length + 1,
      });
    }
  }
}

/**
 * Single-pass regex extraction of labels + actions for one location.
 * Used as the full fallback when tree-sitter is unavailable.
 */
export function extractLocationSymbolsFromText(
  text: string,
  loc: LocationEntry,
  locSymbols: LocSyms,
  uri: string,
): void {
  const lines = splitLocationLines(text, loc);
  extractLabelsFromLines(lines, loc.startLine, locSymbols, uri);
  extractActionsFromLines(lines, loc.startLine, locSymbols, uri);
}

/**
 * Build a fresh `DocumentSymbols` purely from regex.  Used when
 * tree-sitter has not yet initialised.
 */
export function buildRegexSymbols(
  uri: string,
  locationIndex: LocationEntry[],
  text: string,
): DocumentSymbols {
  const symbols = new DocumentSymbols(uri);
  for (const loc of locationIndex) {
    const nameCol = locationNameCol(text, loc);
    const locSymbols = symbols.addLocation(loc.name, {
      uri,
      line: loc.startLine,
      column: nameCol,
      endLine: loc.startLine,
      endColumn: nameCol + loc.name.length,
    });
    extractLocationSymbolsFromText(text, loc, locSymbols, uri);
  }
  return symbols;
}

/**
 * Merge regex-found actions into a `LocationSymbols` that tree-sitter
 * parsed with errors.  Keeps the tree-sitter actions and adds only
 * those on lines tree-sitter missed.
 */
export function mergeActionsFromText(
  text: string,
  loc: LocationEntry,
  locSymbols: LocSyms,
  uri: string,
): void {
  const tsLines = new Set(locSymbols.actions.map(a => a.definition?.line));
  const lines = splitLocationLines(text, loc);
  extractActionsFromLines(lines, loc.startLine, locSymbols, uri, tsLines);
}

/**
 * Merge regex-found labels into a partially-parsed `LocationSymbols`.
 * Skips lines tree-sitter already covered so we don't insert phantom
 * root-namespace duplicates of labels TS placed in act/code-block
 * namespaces.
 */
export function mergeLabelsFromText(
  text: string,
  loc: LocationEntry,
  locSymbols: LocSyms,
  uri: string,
): void {
  const tsLines = new Set<number | undefined>();
  for (const sym of locSymbols.allLabelSymbols()) {
    for (const r of sym.references) tsLines.add(r.line);
  }
  const lines = splitLocationLines(text, loc);
  extractLabelsFromLines(lines, loc.startLine, locSymbols, uri, tsLines);
}
