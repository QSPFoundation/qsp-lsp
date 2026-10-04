// ── Analysis of one location ─────────────────────────────────────────
//
// Files are parsed one location at a time, by the project scan and by the
// editor. Shared here so both get the same symbols.

import type Parser from 'web-tree-sitter';
import { LocationSymbols, descendantsOfType, extractErrors, extractSymbols, locationInterface, parentOf, type SyntaxError } from '../parser';
import { extractLocationSymbolsFromText, mergeActionsFromText, mergeLabelsFromText } from './regexFallback';

/**
 * The symbols of a location parsed alone (`tree`, of `locText`), in its
 * own coordinates: its header is line 0. Where syntax errors hid actions
 * or labels from tree-sitter, they are added from the text; a location
 * tree-sitter didn't find at all gets them from the text only (`regexOnly`).
 */
export function extractLocationSymbols(
  tree: Parameters<typeof extractSymbols>[0],
  docUri: string,
  locationName: string,
  locText: string,
  embedParseFn: Parameters<typeof extractSymbols>[2],
): LocationSymbols {
  // extractSymbols wraps the location in a DocumentSymbols with one entry.
  let found: LocationSymbols | undefined;
  for (const [, ls] of extractSymbols(tree, docUri, embedParseFn).symbols.locations) {
    found = ls;
    break;
  }
  const lines = locText.split('\n').length;
  const wholeText = {
    name: locationName, nameLower: locationName.toLowerCase(),
    startLine: 0, endLine: lines - 1, startOffset: 0, endOffset: locText.length,
  };
  if (!found) {
    // E.g. the entire tree is ERROR: an empty location, so the result is still cached.
    const empty = new LocationSymbols(locationName);
    empty.hasErrors = true;
    extractLocationSymbolsFromText(locText, wholeText, empty, docUri);
    return empty;
  }
  if (found.hasErrors) {
    // ERROR nodes can swallow act blocks and labels; tree-sitter's own are
    // kept (more accurate for valid syntax), the text adds those on lines it missed.
    mergeActionsFromText(locText, wholeText, found, docUri);
    mergeLabelsFromText(locText, wholeText, found, docUri);
  }
  return found;
}

/**
 * The symbols and syntax errors of a location parsed alone (`tree`, of
 * `locText`), in its own coordinates. `step` times each part (PerfLog.step).
 */
export function analyzeParsedLocation(
  tree: Parameters<typeof extractSymbols>[0],
  docUri: string,
  locationName: string,
  locText: string,
  embedParseFn: Parameters<typeof extractSymbols>[2],
  step: <T>(name: string, fn: () => T) => T,
): { symbols: LocationSymbols; errors: SyntaxError[] } {
  const symbols = step('symbols', () => extractLocationSymbols(tree, docUri, locationName, locText, embedParseFn));
  // Made now, from the symbols as extracted, so deciding what an edit
  // changed for the other files costs nothing then.
  step('interface', () => locationInterface(symbols));
  return { symbols, errors: step('errors', () => extractErrors(tree)) };
}

const BLOCK_TYPES = new Set(['act_block', 'if_block', 'loop_block']);
const BRANCH_TYPES = new Set(['elseif_clause', 'else_clause']);
const FOLDABLE_TYPES = [...BLOCK_TYPES, ...BRANCH_TYPES, 'label_statement'];

// The last line `node` has text on: a branch ends where the next one starts.
const lastRow = (node: Parser.SyntaxNode) => (node.endPosition.column === 0 && node.endPosition.row > node.startPosition.row
  ? node.endPosition.row - 1 : node.endPosition.row);

// A label's part of its block: up to the next label beside it, the next
// branch, or the end of what holds it. Folding ranges must nest, and this
// keeps a label's inside the branch or block it is in.
function labelEnd(label: Parser.SyntaxNode): number {
  const line = parentOf(label);
  const holder = line && parentOf(line);
  if (!line || !holder) return label.startPosition.row;
  let end = lastRow(line);
  let after = false;
  for (const sibling of holder.namedChildren) {
    if (sibling.id === line.id) { after = true; continue; }
    if (!after || sibling.startPosition.row <= line.startPosition.row) continue;
    if (BRANCH_TYPES.has(sibling.type) || sibling.type === 'location_end' || sibling.type.endsWith('_keyword')
      || sibling.namedChildren.some(c => c.type === 'label_statement')) break;
    end = lastRow(sibling);
  }
  return end;
}

/**
 * Start and end lines, in pairs, of what folds in `tree`, where it spans
 * several lines: act, if and loop blocks, the `elseif`/`else` branches of
 * an if, and the part of a block under each label. Sticky Scroll shows
 * them too.
 */
export function collectFoldLines(tree: Parameters<typeof extractSymbols>[0]): number[] {
  const lines: number[] = [];
  // Searched inside tree-sitter: walking every node from JS cost as much
  // as half the parse.
  for (const node of descendantsOfType(tree.rootNode, FOLDABLE_TYPES)) {
    const start = node.startPosition.row;
    const end = node.type === 'label_statement' ? labelEnd(node) : BRANCH_TYPES.has(node.type) ? lastRow(node) : node.endPosition.row;
    if (end > start) lines.push(start, end);
  }
  return lines;
}
