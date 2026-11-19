import { describe, it, expect, beforeAll } from 'vitest';
import { DiagnosticTag } from 'vscode-languageserver';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { initParser, runDiagnostics } from './testHelpers';

// What QSP does here was checked on the 5.7 (qsp-legacy), 5.9.5 and 5.9.6
// libraries, by which branch set a variable: they all agree.
describe('skippedCode', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(async () => { await initParser(parser); });

  const loc = (body: string) => `# t\n${body}\n--- t ---\n`;
  const run = (body: string, overrides = {}) =>
    runDiagnostics(parser, loc(body), { skippedCode: true, ...overrides });
  const found = (body: string) => run(body).map(d => ({
    line: d.range.start.line, column: d.range.start.character,
    endLine: d.range.end.line, endColumn: d.range.end.character,
    message: d.message,
  }));

  it('accepts comments between one-line branches (reported by Alex Versus)', () => {
    const body = [
      'if 0:',
      "\telseif x = 1: *pl '1'",
      "\telseif x = 2: *pl '2'",
      '!   ^^^^^^ a comment',
      "\telse: *pl '0'",
      '!   ^^^^ a comment',
      'end',
    ].join('\n');
    const diags = runDiagnostics(parser, loc(body), { skippedCode: true, unsupportedSyntax: true });
    expect(diags).toEqual([]);
  });

  it('reports the lines after a one-line ELSEIF or ELSE, nested blocks included, and fades them', () => {
    const body = [
      'if 0:',              // 2
      '\telseif x = 1: r = 1',
      '\ts = 5',            // 4
      '\t! a comment',
      '\tif 1:',
      '\t\tt = 1',
      '\tend',              // 8
      '\telse: r = 9',
      '\tr = 5',            // 10
      'end',
    ].join('\n');
    expect(found(body)).toEqual([
      { line: 3, column: 1, endLine: 7, endColumn: 4, message: 'QSP never runs these lines: after a one-line ELSEIF it goes on at the next branch or END' },
      { line: 9, column: 1, endLine: 9, endColumn: 6, message: 'QSP never runs these lines: after a one-line ELSE it goes on at the next branch or END' },
    ]);
    expect(run(body).every(d => d.tags?.includes(DiagnosticTag.Unnecessary))).toBe(true);
  });

  it('keeps the body of a multi-line branch', () => {
    expect(found('if 0:\n\telseif x = 1:\n\t\tr = 1\n\t\ts = 2\n\telse\n\t\tr = 3\nend')).toEqual([]);
  });

  it('reports the branches after an ELSE', () => {
    const body = 'if 0:\n\telse\n\t\tr = 9\n\telseif x = 2: r = 2\n\telse: r = 3\nend';
    expect(found(body).map(d => [d.line, d.message])).toEqual([
      [4, 'QSP never reaches this branch: it comes after ELSE'],
      [5, 'QSP never reaches this branch: it comes after ELSE'],
    ]);
  });

  it('reads a one-line else if as an ELSE with an inline IF, and says so when branches follow it', () => {
    const body = [
      'if 0:',
      "\telse if x = 1: *pl '1'",
      "\telse if x = 2: *pl '2'",
      "\telse *pl '0'",
      'end',
    ].join('\n');
    expect(found(body).map(d => [d.line, d.column, d.endColumn, d.message])).toEqual([
      [3, 1, 23, 'QSP never reaches this branch: the ELSE IF on one line above is an ELSE with an inline IF in it, not an ELSEIF'],
      [4, 1, 13, 'QSP never reaches this branch: the ELSE IF on one line above is an ELSE with an inline IF in it, not an ELSEIF'],
      [2, 1, 8, 'On one line ELSE IF is an ELSE with an inline IF in it, not an ELSEIF: QSP never reaches the branches below. Write ELSEIF'],
    ]);
  });

  it('is quiet about a last one-line else if, and about a multi-line one, which are ELSEIFs in effect', () => {
    expect(found('if 0:\n\tr = 1\n\telse if x = 2: r = 2\nend')).toEqual([]);
    expect(found('if 0:\n\telse if x = 1:\n\t\tr = 1\n\telse if x = 2:\n\t\tr = 2\n\telse\n\t\tr = 9\nend')).toEqual([]);
  });

  it('names a plain ELSE when the colon after it shows the IF is inside', () => {
    expect(found('if 1:\n\telse: if x: r = 2\n\telse r = 3\nend').map(d => d.message))
      .toEqual(['QSP never reaches this branch: it comes after ELSE']);
  });

  it('is off with its setting, and the code still parses', () => {
    const body = 'if 0:\n\telseif x = 1: r = 1\n\ts = 5\nend';
    expect(runDiagnostics(parser, loc(body), { skippedCode: false, unsupportedSyntax: true })).toEqual([]);
  });

  it('works in every syntax version', () => {
    const body = 'if 0:\n\telseif x = 1: r = 1\n\ts = 5\nend';
    for (const syntaxVersion of ['5.7.0', '5.9.5', '5.9.6'] as const) {
      expect(run(body, { syntaxVersion }).map(d => d.code)).toEqual(['skippedCode']);
    }
  });
});
