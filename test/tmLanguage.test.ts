/**
 * The TextMate grammar (syntaxes/qsp.tmLanguage.json), which colours a file
 * before the language server's tokens arrive and wherever they don't.
 *
 * Why
 * ───
 * - QSP ignores the text outside locations. Coloured as code, a quote in it
 *   opened a string that ran into the next location, and every string after
 *   it was coloured inside out. Code rules apply only inside a location;
 *   the text around them is a comment.
 * - A location starts and ends where buildLocationIndex says it does, or
 *   the colours and the analysis disagree about what is code.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { buildLocationIndex } from '../src/common/locations';

interface Rule { begin?: string; end?: string; match?: string; include?: string; patterns?: Rule[] }
const grammar = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'syntaxes', 'qsp.tmLanguage.json'), 'utf8')) as
  { patterns: Rule[]; repository: Record<string, Rule> };

describe('qsp.tmLanguage.json', () => {
  it('has only locations and the text around them at the top level', () => {
    expect(grammar.patterns).toEqual([{ include: '#location' }, { include: '#outside-location' }]);
    expect(grammar.repository.location.patterns).toEqual([{ include: '#code' }]);
    // `$self` would bring the top-level rules into a block.
    expect(JSON.stringify(grammar)).not.toContain('$self');
  });

  it('starts and ends a location where the location index does', () => {
    const begin = new RegExp(grammar.repository.location.begin!);
    const end = new RegExp(grammar.repository.location.end!);
    const text = ['# первая', 'pl 1', '--- первая ---', '#', '#   ', ' # не локация', '# вторая  ', '--', ''].join('\n');
    const index = buildLocationIndex(text);
    const lines = text.split('\n');
    expect(index.map(l => l.startLine)).toEqual(lines.flatMap((l, i) => (begin.test(l) ? [i] : [])));
    expect(index.map(l => l.endLine)).toEqual(lines.flatMap((l, i) => (end.test(l) ? [i] : [])));
  });
});
