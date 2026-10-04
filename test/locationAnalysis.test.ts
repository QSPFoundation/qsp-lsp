/**
 * Symbols of a location parsed alone (src/server/locationAnalysis.ts), as
 * large files get them in the editor and in the project scan.
 *
 * Why
 * ───
 * Syntax errors can hide actions and labels from tree-sitter inside ERROR
 * nodes. A whole-file parse adds them from the text; a location parsed
 * alone must too, or the Outline and action checks of a large or closed
 * file lose them.
 * A syntax error tree-sitter can't recover from (an `if` never closed,
 * prose written into the code) leaves no `location_block` at all, only an
 * ERROR node holding the header and the statements. Those still give
 * symbols: a location filled from the text alone (`regexOnly`) has no
 * variables or jumps, and turns off the "never used" checks of the whole
 * project.
 * What folds is what Sticky Scroll keeps at the top of the editor: the
 * blocks, each `elseif`/`else` branch, and the part under each label, so
 * a nested `if`, a branch or a label in a long location can be found.
 * Folding ranges must nest, so a label's part stays inside its branch.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { collectFoldLines, extractLocationSymbols } from '../src/server/locationAnalysis';
import { initParser } from './testHelpers';

const parser = new QspTreeSitterParser();
beforeAll(() => initParser(parser));

function symbolsOf(text: string) {
  const tree = parser.parseOnce(text)!;
  try {
    return extractLocationSymbols(tree, 'test://loc', 'комната', text, undefined);
  } finally {
    tree.delete();
  }
}

describe('extractLocationSymbols', () => {
  it('adds an action a syntax error hid, from the text, without doubling labels', () => {
    const symbols = symbolsOf("# комната\n(((\nact 'взять':\n*pl 1\nend\n:метка\n--- комната ---\n");
    expect(symbols.hasErrors).toBe(true);
    expect(symbols.actions.map(a => [a.name, a.definition?.line])).toEqual([['взять', 2]]);
    expect([...symbols.allLabelSymbols()].map(l => l.name)).toEqual(['метка']);
    expect(symbols.regexOnly).toBe(false);
  });

  it('leaves a location without errors as tree-sitter found it', () => {
    const symbols = symbolsOf("# комната\nact 'взять':\n  *pl 1\nend\n:метка\n--- комната ---\n");
    expect(symbols.hasErrors).toBe(false);
    expect(symbols.actions.map(a => a.name)).toEqual(['взять']);
    expect([...symbols.allLabelSymbols()].map(l => l.name)).toEqual(['метка']);
  });

  it('takes the symbols of a location whose syntax error leaves no location block', () => {
    const text = "# комната\nсчёт = 1\nif счёт = 1:\n  pl 'a'\nact 'выйти':\n  gt 'кухня'\nend\n--- комната ---\n";
    const tree = parser.parseOnce(text)!;
    expect(tree.rootNode.namedChildren.map(n => n.type)).toEqual(['ERROR']);
    tree.delete();

    const symbols = symbolsOf(text);
    expect(symbols.regexOnly).toBe(false);
    expect(symbols.hasErrors).toBe(true);
    expect(symbols.findVariable('счёт')?.hasValueDefinition).toBe(true);
    expect([...symbols.locationRefs.keys()]).toEqual(['кухня']);
    expect(symbols.actions.map(a => a.name)).toEqual(['выйти']);
  });
});

describe('collectFoldLines', () => {
  it('folds blocks, each branch of an if and the part under each label, nested', () => {
    const text = [
      '# t',            // 0
      ':start',         // 1
      'pl 1',           // 2
      'if x = 1:',      // 3
      '  :inner',       // 4
      '  pl 2',         // 5
      '  if y:',        // 6
      '    pl 3',       // 7
      '  end',          // 8
      'elseif x = 2:',  // 9
      '  pl 4',         // 10
      'else',           // 11
      '  pl 5',         // 12
      'end',            // 13
      ':second',        // 14
      'pl 6',           // 15
      ':last',          // 16
      '--- t ---',      // 17
      '',
    ].join('\n');
    const tree = parser.parseOnce(text)!;
    try {
      const lines = collectFoldLines(tree);
      const pairs: string[] = [];
      for (let i = 0; i < lines.length; i += 2) pairs.push(`${lines[i]}-${lines[i + 1]}`);
      // `:last` holds nothing after it, so it doesn't fold.
      expect(pairs.sort()).toEqual(['1-13', '11-12', '14-15', '3-13', '4-8', '6-8', '9-10']);
    } finally {
      tree.delete();
    }
  });
});
