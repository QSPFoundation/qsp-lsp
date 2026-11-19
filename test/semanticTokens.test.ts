/**
 * Semantic tokens (src/server/semanticTokens.ts).
 *
 * Why
 * ───
 * A `{…}` block is a string in QSP, code only when `dynamic`/`dyneval`
 * runs it. One that can't be code (an array key: `$mass[{act}]` is
 * `$mass['act']`; a list of words) must read as a string, not as
 * variables.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { collectSemanticTokenTuples, TOKEN_TYPES } from '../src/server/semanticTokens';
import { initParser } from './testHelpers';

const parser = new QspTreeSitterParser();
beforeAll(() => initParser(parser));

function tokensFor(src: string): Array<{ type: string; text: string }> {
  const tree = parser.parseOnce(src)!;
  const tuples = collectSemanticTokenTuples(tree);
  tree.delete();
  const lines = src.split('\n');
  const out: Array<{ type: string; text: string }> = [];
  for (let i = 0; i < tuples.length; i += 5) {
    out.push({ type: TOKEN_TYPES[tuples[i + 3]], text: lines[tuples[i]].substr(tuples[i + 1], tuples[i + 2]) });
  }
  return out;
}

describe('semantic tokens', () => {
  it('colour a block used as an array index as a string', () => {
    const toks = tokensFor("# a\n$x = $mass[{symb}]\npl '<<$mass[{act}]>>'\n---\n");
    expect(toks.filter(t => t.text.includes('symb') || t.text.includes('act'))).toEqual([
      { type: 'string', text: '{symb}' },
      { type: 'string', text: '{act}' },
    ]);
  });

  it('colour a block compared with as a string', () => {
    const toks = tokensFor('# a\nif $args[{test}] = {generic}:\nend\n---\n');
    expect(toks).toContainEqual({ type: 'string', text: '{test}' });
    expect(toks).toContainEqual({ type: 'string', text: '{generic}' });
  });

  it('colour a list of words kept in a variable as a string, and code run by dynamic as code', () => {
    const toks = tokensFor('# a\n$s = { Ann, Bob, }\ndynamic { x = 1 }\n---\n');
    expect(toks).toContainEqual({ type: 'string', text: '{ Ann, Bob, }' });
    expect(toks).toContainEqual({ type: 'variable', text: 'x' });
  });

  it('colour the fields of a record as fields, and a field named by text as a string', () => {
    const toks = tokensFor("# a\n%r = [x: 1, $len: 'a']\npl r.x + r.$len + r.'my key'\n---\n");
    expect(toks.filter(t => t.type === 'field').map(t => t.text)).toEqual(['x', 'len', 'x', 'len']);
    expect(toks).toContainEqual({ type: 'string', text: 'my key' });
    expect(toks.filter(t => t.type === 'variable').map(t => t.text)).toEqual(['r', 'r', 'r', 'r']);
  });
});
