/**
 * The QSP syntax showcase of the Sublime Text package
 * (QSPFoundation/sublime_text_qsp_package, QSP.sublime-package/syntax_test_qsp.qsps),
 * kept as test/fixtures/syntax_test_qsp.qsps.
 *
 * Why
 * ───
 * - It is the community's catalogue of how QSP reads tricky code: text
 *   between locations, `}` in comments, blocks closed by a comment line,
 *   notes after `end`, multi-line brackets and strings. Its author found
 *   the highlighting broken on it, a comment's `}` among other things.
 * - Some of its code is wrong on purpose (`# st.error`, a bad `local`, an
 *   `if` never closed): those errors must stay, and nothing else may be one.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { buildLocationIndex } from '../src/common/locations';
import { ALL_DIAGS_ON, initParser, runDiagnostics } from './testHelpers';

const parser = new QspTreeSitterParser();
beforeAll(() => initParser(parser));

const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'syntax_test_qsp.qsps'), 'utf8');

describe('syntax_test_qsp.qsps', () => {
  it('has its locations where QSP finds them', () => {
    expect(buildLocationIndex(text).map(l => `${l.startLine + 1}-${l.endLine + 1}`)).toEqual([
      '17-73', '75-115', '117-131', '133-159', '161-173', '175-177', '180-184', '186-227',
      '229-327', '329-342', '344-369', '371-531', '533-537', '539-574', '576-586', '589-605',
    ]);
  });

  it('reports the syntax errors written on purpose and no others', () => {
    const errorLocation = buildLocationIndex(text).find(l => l.name === 'st.error')!;
    const lines = runDiagnostics(parser, text, ALL_DIAGS_ON)
      .filter(d => d.code === 'syntax')
      .map(d => d.range.start.line + 1)
      .filter(line => line < errorLocation.startLine + 1 || line > errorLocation.endLine + 1);
    expect([...new Set(lines)].sort((a, b) => a - b)).toEqual([
      109, 110, 112, // `local` without a name, `local 7=9`, `local i,7=5,8`
      182, //           ` and 88999`: an operator with no left operand
      547, //           `*pl|*nl|…|*p`: a list of keywords, not code
      561, //           `loop while i<9 step:` with no step
      582, 585, //      `@foo_09 555,666`, `@foo 56`: arguments without parentheses
      597, //           `if незакрытое_условие:` never closed
    ]);
  });
});
