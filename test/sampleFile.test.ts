import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { initParser, runDiagnostics } from './testHelpers';

describe('examples/sample.qsps', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(() => initParser(parser));

  it('parses cleanly with all checks enabled', () => {
    const code = fs.readFileSync(
      path.join(__dirname, '..', 'examples', 'sample.qsps'),
      'utf-8',
    );
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
});
