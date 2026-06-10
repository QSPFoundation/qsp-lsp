import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';
import { QspTreeSitterParser, extractSymbols } from '../src/parser/treeSitter';
import { initParser, runDiagnostics } from './testHelpers';

describe('examples/sample.qsps', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(() => initParser(parser));

  const readSample = (): string =>
    fs.readFileSync(path.join(__dirname, '..', 'examples', 'sample.qsps'), 'utf-8');

  it('parses cleanly with all checks enabled', () => {
    const code = readSample();
    const diags = runDiagnostics(parser, code, {
      duplicateLocations: true,
      duplicateLabels: true,
      duplicateActions: true,
      unclosedLocations: true,
      unresolvedLocationRefs: true,
      unresolvedLabelRefs: true,
      unresolvedActionRefs: true,
      invalidFunctionPrefix: true,
      invalidBuiltinArgCount: true,
      typeMismatch: true,
    });
    if (diags.length > 0) {
      console.log(diags.map(d => `[${d.severity}] L${d.range.start.line + 1}: ${d.message}`).join('\n'));
    }
    expect(diags).toEqual([]);
  });

  // Regression: an interpolation whose body carries doubled host
  // quotes — e.g.
  //   '<center><img src="<<$func(''cave/look'', ''arg'')>>"></center>'
  // used to collapse the inline parse so badly that the lifted
  // `$func('cave/look')` location reference was lost and `cave/look`
  // was wrongly flagged "defined but never referenced".  The grammar
  // now contains such bodies as an `interpolation_raw_body` token and
  // the decode-and-reparse pass must recover the reference.
  it('recovers location refs from a doubled-quote interpolation body', () => {
    const code = readSample();
    const tree = parser.parse('file:///sample.qsps', code)!;
    const { symbols } = extractSymbols(
      tree, 'file:///sample.qsps', undefined, undefined,
      (t) => parser.parseOnce(t),
    );

    let caveLookRefs = 0;
    for (const locName of symbols.locationDefs.keys()) {
      const ls = symbols.getLocation(locName);
      const ref = ls?.locationRefs.get('cave/look');
      if (ref) caveLookRefs += ref.references.length;
    }
    expect(caveLookRefs).toBeGreaterThan(0);
  });
});
