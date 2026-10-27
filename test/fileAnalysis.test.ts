/**
 * One file's analysis (src/server/fileAnalysis.ts), and a large file's in
 * parts: the parts a file is split into cover it in order, and their
 * analyses joined are the file's analysed in one go.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { analyzeFileText, joinFileAnalyses, splitLocations } from '../src/server/fileAnalysis';
import { QspTreeSitterParser, buildLocationIndex } from '../src/parser';
import { initParser } from './testHelpers';

const parser = new QspTreeSitterParser();
beforeAll(() => initParser(parser));

const uri = 'file:///game.qsps';
const game = [
  "# начало\nx = 1 & $имя = 'начало'\nact 'дальше': gt 'вторая'\n--- начало ---\n",
  "# вторая\nif x = 1\n*pl $имя\n--- вторая ---\n",
  // Repeated: the second one's symbols win, at the first one's place.
  "# начало\ny = 2\n--- начало ---\n",
  "# третья\n*pl '<a href=\"exec:gt ''начало''\">go</a>'\nlocal z = y\n--- третья ---\n",
  "# четвёртая\n" + 'pl 1\n'.repeat(40) + "--- четвёртая ---\n",
].join('\n');

describe('splitLocations', () => {
  it('covers every location once, in order, in parts of about the same text', () => {
    const index = buildLocationIndex(game);
    for (const parts of [1, 2, 3, 4, 8]) {
      const ranges = splitLocations(index, parts);
      expect(ranges.length).toBeLessThanOrEqual(Math.min(parts, index.length));
      expect(ranges[0].from).toBe(0);
      expect(ranges.at(-1)!.to).toBe(index.length);
      for (let i = 1; i < ranges.length; i++) expect(ranges[i].from).toBe(ranges[i - 1].to);
      for (const r of ranges) expect(r.to).toBeGreaterThan(r.from);
    }
    // The long last location gets a part of its own.
    expect(splitLocations(index, 2)).toEqual([{ from: 0, to: 4 }, { from: 4, to: 5 }]);
  });
});

describe('joinFileAnalyses', () => {
  it('gives the analysis of the whole file from those of its parts', () => {
    const index = buildLocationIndex(game);
    const whole = analyzeFileText(parser, uri, game, index, true);
    expect(whole.syntaxErrors.length).toBeGreaterThan(0);
    for (const parts of [2, 3, 5]) {
      const analyses = splitLocations(index, parts)
        .map(r => analyzeFileText(parser, uri, game, index.slice(r.from, r.to), true));
      const joined = joinFileAnalyses(uri, analyses);
      expect([...joined.symbols.locations.keys()]).toEqual([...whole.symbols.locations.keys()]);
      expect(joined.symbols).toEqual(whole.symbols);
      expect(joined.syntaxErrors).toEqual(whole.syntaxErrors);
    }
  });
});
