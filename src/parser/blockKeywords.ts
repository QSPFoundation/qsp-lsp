/**
 * Block keyword highlighting — finds related if/elseif/else/end,
 * act/end, loop/end keyword positions for document highlights.
 */
import type Parser from 'web-tree-sitter';

/** Node types that represent block constructs with matching keywords. */
const BLOCK_NODE_TYPES = new Set(['if_block', 'act_block', 'loop_block']);

/** Node types that are block keywords (cursor triggers for highlighting). */
const KEYWORD_NODE_TYPES = new Set([
  'if_keyword', 'elseif_keyword', 'else_keyword', 'end_keyword',
  'act_keyword', 'loop_keyword',
]);

/** Range of a keyword in the source. */
export interface KeywordRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

/**
 * Find all related block keywords for the keyword at the given position.
 *
 * When the cursor is on `if`, `elseif`, `else`, `end`, `act`, or `loop`,
 * this returns the positions of all keywords in that block structure.
 * For example, clicking `end` of an if/elseif/else/end block returns
 * the positions of `if`, `elseif`, `else`, and `end`.
 *
 * Returns an empty array if the cursor is not on a block keyword.
 */
export function findBlockKeywordRanges(
  tree: Parser.Tree,
  line: number,
  col: number,
): KeywordRange[] {
  // Find the deepest node at the cursor position
  let node = tree.rootNode.descendantForPosition({ row: line, column: col });
  if (!node) return [];

  // Walk up to find a keyword node (the cursor might be on text inside it)
  while (node && !KEYWORD_NODE_TYPES.has(node.type)) {
    if (BLOCK_NODE_TYPES.has(node.type) || node.type === 'source_file') {
      return []; // Went past keywords without finding one
    }
    node = node.parent!;
  }
  if (!node || !KEYWORD_NODE_TYPES.has(node.type)) return [];

  // Walk up to find the containing block node
  let blockNode = node.parent;
  // elseif_clause and else_clause are intermediate wrappers
  while (blockNode && !BLOCK_NODE_TYPES.has(blockNode.type)) {
    blockNode = blockNode.parent;
  }
  if (!blockNode) return [];

  // Collect all keyword nodes from the block
  return collectBlockKeywords(blockNode);
}

/** Collect keyword ranges from a block node (if_block, act_block, loop_block). */
function collectBlockKeywords(blockNode: Parser.SyntaxNode): KeywordRange[] {
  const ranges: KeywordRange[] = [];

  for (let i = 0; i < blockNode.childCount; i++) {
    const child = blockNode.child(i)!;

    if (KEYWORD_NODE_TYPES.has(child.type)) {
      ranges.push(nodeToRange(child));
    }

    // elseif_clause and else_clause contain their keyword as a child
    if (child.type === 'elseif_clause' || child.type === 'else_clause') {
      for (let j = 0; j < child.childCount; j++) {
        const grandchild = child.child(j)!;
        if (KEYWORD_NODE_TYPES.has(grandchild.type)) {
          ranges.push(nodeToRange(grandchild));
        }
      }
    }
  }

  return ranges;
}

function nodeToRange(node: Parser.SyntaxNode): KeywordRange {
  return {
    startLine: node.startPosition.row,
    startCol: node.startPosition.column,
    endLine: node.endPosition.row,
    endCol: node.endPosition.column,
  };
}
