/**
 * The insides of `{…}` blocks, each a tree of its own.
 *
 * QSP finds a block's end by its braces and quotes, whatever is inside,
 * and the grammar does the same: a `code_block` holds one opaque
 * `block_body` token. What's inside is parsed apart, on first use, as the
 * body of the location the block stands in: the parser reads the
 * location's header line, the block's body and the location's end line of
 * the same text (included ranges), so every node keeps the row and column
 * it has in the document. A body that isn't code (a list of words) has
 * errors in its own tree only.
 *
 * A block's tree belongs to the tree it was parsed for, and goes when that
 * one is deleted. Walks go into a block through {@link blockStatements}
 * and up out of one through {@link parentOf}.
 */
import type Parser from 'web-tree-sitter';

/** Parses `text` within `ranges`, the parser's included ranges. */
export type RangeParseFn = (text: string, ranges: Parser.Range[]) => Parser.Tree | null;

interface Forest {
  text: string;
  parse: RangeParseFn;
  /** Every block's tree, by the offset of its `{`; null when it has none. */
  blocks: Map<number, Parser.Tree | null>;
  owned: Parser.Tree[];
  end?: Parser.Point;
}

// The forest of the tree a parse made, and of every block tree in it.
const forests = new WeakMap<Parser.Tree, Forest>();
// A block tree's `code_block`.
const hosts = new WeakMap<Parser.Tree, Parser.SyntaxNode>();

/**
 * Make `tree`, parsed from `text`, give its blocks trees of their own,
 * parsed by `parse`; `tree.delete()` deletes them too.
 */
export function adoptTree(tree: Parser.Tree, text: string, parse: RangeParseFn): void {
  const forest: Forest = { text, parse, blocks: new Map(), owned: [] };
  forests.set(tree, forest);
  const deleteTree = tree.delete.bind(tree);
  tree.delete = () => {
    for (const t of forest.owned) t.delete();
    forest.owned.length = 0;
    forest.blocks.clear();
    deleteTree();
  };
}

/**
 * Whether `node` holds a location: a `location_block`, or an ERROR node
 * that starts with a location header. A syntax error tree-sitter can't
 * recover from (prose written into the code, an `if` never closed) leaves
 * no `location_block`: the location parsed alone gets an ERROR root
 * holding its header and statements, which still give symbols.
 */
export function isLocationBlock(node: Parser.SyntaxNode): boolean {
  return node.type === 'location_block'
    || (node.type === 'ERROR' && node.namedChild(0)?.type === 'location_header');
}

/** The tree of a `code_block`'s inside, or null (an empty block, a tree not from a parse). */
export function blockTree(block: Parser.SyntaxNode): Parser.Tree | null {
  if (block.type !== 'code_block') return null;
  const forest = forests.get(block.tree);
  if (!forest) return null;
  const key = block.startIndex;
  const known = forest.blocks.get(key);
  if (known !== undefined) return known;
  let tree: Parser.Tree | null = null;
  const body = block.namedChild(0);
  const location = body?.type === 'block_body' ? enclosingLocation(block) : null;
  const header = location?.namedChild(0);
  if (body && header?.type === 'location_header') {
    const ranges: Parser.Range[] = [rangeOf(header), rangeOf(body)];
    const end = location!.lastChild;
    if (end?.type === 'location_end' && !end.isMissing) ranges.push(lineBreakAndRest(forest, end));
    tree = forest.parse(forest.text, ranges);
    if (tree) {
      forests.set(tree, forest);
      hosts.set(tree, block);
      forest.owned.push(tree);
    }
  }
  forest.blocks.set(key, tree);
  return tree;
}

/** The node holding the location a block's tree parsed: its statements, after the header. */
export function blockLocation(block: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const tree = blockTree(block);
  if (!tree) return null;
  const root = tree.rootNode;
  for (const child of root.namedChildren) if (isLocationBlock(child)) return child;
  return root;
}

/** The statements of a `code_block`, in order: the statement groups of its tree. */
export function blockStatements(block: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const location = blockLocation(block);
  if (!location) return [];
  return location.children.filter(c => c.type !== 'location_header' && c.type !== 'location_end');
}

/** Whether a `code_block`'s inside doesn't parse as code. */
export function blockHasError(block: Parser.SyntaxNode): boolean {
  return blockLocation(block)?.hasError ?? false;
}

/**
 * Whether a `code_block` is text that nothing can run: an array's key
 * (`$mass[{act}]` is `$mass['act']`), or an operand of an operator whose
 * result is a number (`$s = {generic}` compares with the text `generic`;
 * `and`, `-`, `no`, `loc`…). Only `+` and `&` join texts, whose result may
 * be kept and run.
 */
export function isNeverRunBlock(block: Parser.SyntaxNode): boolean {
  if (block.type !== 'code_block') return false;
  const parent = parentOf(block);
  if (!parent) return false;
  if (parent.type === 'array_index' || parent.type.endsWith('_unary')) return true;
  if (!parent.type.endsWith('_binary')) return false;
  for (const child of parent.namedChildren) {
    if (child.type === 'op_amp') return false;
    if (child.type === 'op_arith') return child.text.trim() !== '+';
    if (child.type.startsWith('op_')) return true;
  }
  return false;
}

// Each tree's parents found so far, by node id.
const parents = new WeakMap<Parser.Tree, Map<number, Parser.SyntaxNode | null>>();

// `node.parent`, remembered. Tree-sitter keeps no parent links: it finds a
// parent by going down from the root, through every child before it on
// the way, so climbing from each of a location's thousand statements cost
// a thousand children each. A parent found is remembered for all its
// children at once, one pass over them, and the next ones cost nothing.
function rawParent(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let known = parents.get(node.tree);
  if (!known) parents.set(node.tree, known = new Map());
  const cached = known.get(node.id);
  if (cached !== undefined) return cached;
  const parent = node.parent;
  if (parent) {
    for (const child of parent.children) known.set(child.id, parent);
  }
  known.set(node.id, parent);
  return parent;
}

/** `node`'s parent; for a block's statement, the `code_block`. */
export function parentOf(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const parent = rawParent(node);
  const host = hosts.get(node.tree);
  if (!host) return parent;
  // The root of a block's tree, or the location node under it.
  if (!parent) return host;
  const grand = rawParent(parent);
  if (!grand || (isLocationBlock(parent) && !rawParent(grand))) return host;
  return parent;
}

/** The smallest node at `point` under `root`, inside its blocks too. */
export function descendantAt(root: Parser.SyntaxNode, point: Parser.Point): Parser.SyntaxNode {
  let node = root.descendantForPosition(point);
  while (node.type === 'block_body' && node.parent) {
    const location = blockLocation(node.parent);
    if (!location) break;
    const inner = location.descendantForPosition(point);
    if (inner.id === location.id) break;
    node = inner;
  }
  return node;
}

/** The nodes of `types` under `root`, inside its blocks too, found by tree-sitter. */
export function descendantsOfType(root: Parser.SyntaxNode, types: string | string[]): Parser.SyntaxNode[] {
  const found = root.descendantsOfType(types);
  // Each search walks the whole tree: don't make the same one twice.
  const blocks = types === 'code_block' ? found.slice() : root.descendantsOfType('code_block');
  for (const block of blocks) {
    // One search of the block's tree, not one per statement: a native call
    // and a node for each is what costs. Its header and end line are the
    // location's, outside the block.
    const location = blockLocation(block);
    const body = block.namedChild(0);
    if (!location || !body) continue;
    for (const node of descendantsOfType(location, types)) {
      if (node.startIndex >= body.startIndex && node.endIndex <= body.endIndex) found.push(node);
    }
  }
  return found;
}

/**
 * Visit `root` and every node under it, the statements of its blocks too,
 * in document order. `visit` returning `false` skips a node's children;
 * `leave`, if given, runs after a node's children, for every visited node.
 */
export function forEachDescendant(
  root: Parser.SyntaxNode,
  visit: (node: Parser.SyntaxNode) => boolean | void,
  leave?: (node: Parser.SyntaxNode) => void,
): void {
  const cursor = root.walk();
  const step = (): void => {
    const node = cursor.currentNode;
    if (visit(node) !== false) {
      if (node.type === 'code_block') {
        for (const stmt of blockStatements(node)) forEachDescendant(stmt, visit, leave);
      } else if (cursor.gotoFirstChild()) {
        do { step(); } while (cursor.gotoNextSibling());
        cursor.gotoParent();
      }
    }
    leave?.(node);
  };
  try {
    step();
  } finally {
    cursor.delete();
  }
}

// The location around `node`, across block trees.
function enclosingLocation(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (let n: Parser.SyntaxNode | null = parentOf(node); n; n = parentOf(n)) {
    if (!isLocationBlock(n)) continue;
    // A block's own tree holds a location too: the one it stands in is
    // further up, past the block.
    const host = hosts.get(n.tree);
    if (!host) return n;
    n = host;
  }
  return null;
}

function rangeOf(node: Parser.SyntaxNode): Parser.Range {
  return {
    startIndex: node.startIndex, endIndex: node.endIndex,
    startPosition: node.startPosition, endPosition: node.endPosition,
  };
}

// The end line with the line break before it, so the body's last line ends
// before the end mark, which only counts at the start of a line.
function lineBreakAndRest(forest: Forest, end: Parser.SyntaxNode): Parser.Range {
  const text = forest.text;
  let start = end.startIndex;
  let row = end.startPosition.row;
  let column = 0;
  if (start > 0 && text.charCodeAt(start - 1) === 0x0a) {
    start--;
    if (start > 0 && text.charCodeAt(start - 1) === 0x0d) start--;
    row--;
    column = start - (text.lastIndexOf('\n', start - 1) + 1);
  }
  return {
    startIndex: start, endIndex: text.length,
    startPosition: { row, column }, endPosition: forest.end ??= endOf(text),
  };
}

function endOf(text: string): Parser.Point {
  let row = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) row++;
  return { row, column: text.length - (text.lastIndexOf('\n') + 1) };
}
