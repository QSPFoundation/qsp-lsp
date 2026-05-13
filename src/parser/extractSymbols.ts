/**
 * Symbol extraction from tree-sitter parse trees.
 *
 * Walks location blocks and populates a DocumentSymbols table with
 * variables, labels, actions, location references, object references,
 * and action references.
 *
 * This module is the public-facing orchestrator.  Detailed work is
 * delegated to:
 *   - walkHelpers.ts      — shared types, constants, arg/string utilities
 *   - lookupTables.ts     — statement/function name classification sets
 *   - variableUtils.ts    — variable definition/classification helpers
 *   - symbolExtractors.ts — per-node extractors (variables, labels, …)
 *   - bindingCollector.ts — assignment pre-scan + dynamic call resolution
 *   - symbolWalker.ts     — main recursive AST walker + deferred blocks
 */


import type Parser from 'web-tree-sitter';
import { DocumentSymbols } from './symbolTable';
import { nodeLoc } from './walkHelpers';
import { hasStructuralErrors } from './extractErrors';
import { walkLocationBody } from './symbolWalker';

// Re-export for backward compatibility.
export { isVariableDefinition } from './variableUtils';
export { extractQuotedRefInfo, extractExactQuotedRefInfo, nodeLoc } from './walkHelpers';

// ──────────────────────────────────────────────────────────────────────

/**
 * Walk the parse tree and populate a DocumentSymbols table.
 *
 * When `previousSymbols` is provided, unchanged location blocks reuse
 * the old symbols with adjusted line numbers — reducing work from
 * O(tree) to O(changed_locations) for typical edits.
 */
export function extractSymbols(
  tree: Parser.Tree,
  docUri: string,
  previousSymbols?: DocumentSymbols,
  lastEdit?: { startIndex: number; newEndIndex: number } | null,
): { symbols: DocumentSymbols; reusedLocations: Set<string> } {
  const symbols = new DocumentSymbols(docUri);
  const reusedLocations = new Set<string>();
  const root = tree.rootNode;

  const findNamedChild = (
    node: Parser.SyntaxNode,
    type: string,
  ): Parser.SyntaxNode | undefined => {
    const n = node.namedChildCount;
    for (let i = 0; i < n; i++) {
      const c = node.namedChild(i);
      if (c && c.type === type) return c;
    }
    return undefined;
  };

  const rootChildCount = root.namedChildCount;
  for (let i = 0; i < rootChildCount; i++) {
    const locBlock = root.namedChild(i);
    if (!locBlock || locBlock.type !== 'location_block') continue;

    const header = locBlock.childForFieldName('location_header')
      ?? findNamedChild(locBlock, 'location_header');
    if (!header) continue;

    const nameNode = findNamedChild(header, 'location_name');
    if (!nameNode) continue;

    const locName = nameNode.text.trim();
    const locLoc = nodeLoc(nameNode, docUri);

    // Reuse previous symbols for unchanged locations.
    const locUnchanged = previousSymbols && lastEdit &&
      (locBlock.endIndex <= lastEdit.startIndex ||
       locBlock.startIndex >= lastEdit.newEndIndex);
    if (locUnchanged) {
      const oldLocSyms = previousSymbols.getLocation(locName);
      const oldLocDef = previousSymbols.locationDefs.get(locName.toLowerCase());
      if (oldLocSyms && oldLocDef?.definition) {
        const lineShift = locLoc.line - oldLocDef.definition.line;
        symbols.addLocationFrom(locName, locLoc, oldLocSyms, lineShift);
        reusedLocations.add(locName.toLowerCase());
        continue;
      }
    }

    const locSymbols = symbols.addLocation(locName, locLoc);
    locSymbols.hasErrors = hasStructuralErrors(locBlock);
    walkLocationBody(locBlock, locSymbols, docUri);
  }

  symbols.rebuildGlobalBindings();
  return { symbols, reusedLocations };
}
