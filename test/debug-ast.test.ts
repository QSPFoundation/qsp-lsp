import { describe, it, beforeAll } from 'vitest';
import type Parser from 'web-tree-sitter';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { initParser } from './testHelpers';

const parser = new QspTreeSitterParser();
beforeAll(() => initParser(parser));

describe('debug', () => {
  it('dump local_statement', () => {
    const tree = parser.parse('file:///t.qsps', '# test\nlocal temp = 5\npl temp\n---\n')!;
    const dump = (n: Parser.SyntaxNode, d = 0): void => {
      console.log(' '.repeat(d) + n.type + ' : ' + n.text.replace(/\n/g, '\\n').slice(0, 50));
      for (const c of n.namedChildren) dump(c, d + 2);
    };
    dump(tree.rootNode);
  });
});
