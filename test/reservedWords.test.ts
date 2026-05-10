import { describe, expect, beforeAll, it } from 'vitest';
import * as fs from 'fs';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import { QspTreeSitterParser, extractSymbols } from '../src/parser/treeSitter';
import { buildLocationIndex } from '../src/common/locations';
import { computeDiagnostics, type DiagnosticSettings } from '../src/server/diagnostics';
import { checkReservedWordMisuse } from '../src/parser/extractErrors';
import { initParser, WASM_PATH } from './testHelpers';

const ALL_OFF: DiagnosticSettings = {
  duplicateLocations: false,
  duplicateLabels: false,
  duplicateActions: false,
  unclosedLocations: false,
  uninitializedVariables: false,
  unresolvedLocationRefs: false,
  unresolvedLabelRefs: false,
  unresolvedActionRefs: false,
  unresolvedObjectRefs: false,
  unusedLocations: false,
  unusedLabels: false,
  unusedVariables: false,
  unusedObjects: false,
  invalidFunctionPrefix: false,
  invalidBuiltinArgCount: false,
  mixedVariablePrefixes: false,
  mixedLocationCallTypes: false,
  inconsistentLocalPropagation: false,
  untrackedDynamicCalls: false,
  missingResultInFunctionCall: false,
  extraArgsToTargetWithoutArgs: false,
  shadowsCallFrameBuiltin: false,
  shadowsPropagatedLocal: false,
  maxErrorsPerLocation: 1000,
  maxLocationLines: 0,
};

describe('reserved-word misuse lint', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(() => initParser(parser));

  function analyse(src: string) {
    const tree = parser.parse('file:///t.qsps', src)!;
    return checkReservedWordMisuse(tree);
  }

  it('flags `end = 1`', () => {
    const reserved = analyse('# test\nend = 1\n--\n');
    expect(reserved).toHaveLength(1);
    expect(reserved[0].message).toMatch(/reserved keyword/);
    expect(reserved[0].startRow).toBe(1);
    expect(reserved[0].startCol).toBe(0);
    expect(reserved[0].endCol).toBe(3);
  });

  it('flags each of end/while/step/else/elseif/if/act/loop/local/set/let when used as var', () => {
    const src = [
      '# t',
      'end = 1',
      'while = 2',
      'step = 3',
      'else = 4',
      'elseif = 5',
      'if = 6',
      'act = 7',
      'loop = 8',
      'local = 9',
      'set = 10',
      'let = 11',
      '--',
    ].join('\n');
    const reserved = analyse(src);
    // `set`/`let`/`local`/`if`/`act`/`loop` are already caught by tree-sitter
    // keyword extraction (they contest at statement-start), so they may or
    // may not reach the lint — what matters is we catch at least the ones
    // the grammar lets through:  end, while, step, else, elseif.
    const flagged = new Set(reserved.map(e => e.message.toLowerCase()));
    for (const kw of ['end', 'while', 'step', 'else', 'elseif']) {
      expect(
        Array.from(flagged).some(m => m.includes(`'${kw}'`)),
        `expected diagnostic for '${kw}', got: ${[...flagged].join(' | ')}`,
      ).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    const reserved = analyse('# t\nEND = 1\nWhile = 2\n--\n');
    expect(reserved.length).toBeGreaterThanOrEqual(2);
  });

  it('does not flag `end123` or `ending` (keyword + non-delim suffix)', () => {
    const reserved = analyse('# t\nend123 = 1\nending = 2\n--\n');
    expect(reserved).toHaveLength(0);
  });

  it('does not flag legitimate identifiers', () => {
    const reserved = analyse('# t\nfoo = 1\nbar = 2\n--\n');
    expect(reserved).toHaveLength(0);
  });

  it('flags binary keyword operators used as variables (`and`, `or`, `mod`)', () => {
    // `and = 1` slips past tree-sitter's keyword extraction because
    // binaryKeywordOperator only contests with identifier between two
    // expressions, not at statement-start.
    const reserved = analyse('# t\nand = 1\nor = 2\nx = mod\n--\n');
    const flagged = reserved.map(e => e.message.toLowerCase());
    for (const kw of ['and', 'or', 'mod']) {
      expect(
        flagged.some(m => m.includes(`'${kw}'`)),
        `expected '${kw}' to be flagged`,
      ).toBe(true);
    }
  });

  it('flags statement names used as rvalues (`x = play`)', () => {
    // At statement-start, `play = 1` parses as `statement play = 1`
    // (call to `play` with arg `=1`), so tree-sitter DOES reserve it
    // there. But at rvalue position `x = play` parses as a read of a
    // variable named `play`, which the PEG forbids.
    const reserved = analyse('# t\nx = play\ny = msg\nz = goto\n--\n');
    const flagged = reserved.map(e => e.message.toLowerCase());
    for (const kw of ['play', 'msg', 'goto']) {
      expect(
        flagged.some(m => m.includes(`'${kw}'`)),
        `expected '${kw}' to be flagged`,
      ).toBe(true);
    }
  });
});

describe('reserved-word misuse surfaces as LSP diagnostics', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  function run(code: string) {
    const uri = 'test://reserved';
    const doc = TextDocument.create(uri, 'qsp', 1, code);
    const tree = parser.parse(uri, code)!;
    const { symbols } = extractSymbols(tree, uri);
    const locationIndex = buildLocationIndex(code);
    return computeDiagnostics(doc, uri, locationIndex, ALL_OFF, parser, new Map(), symbols);
  }

  it('produces Error-severity diagnostics routed through computeDiagnostics', () => {
    const diags = run('# t\nend = 1\nand = 2\nx = play\n--\n');
    const reservedDiags = diags.filter(d => d.message.includes('reserved keyword'));
    expect(reservedDiags.length).toBeGreaterThanOrEqual(3);
    for (const d of reservedDiags) {
      expect(d.severity).toBe(DiagnosticSeverity.Error);
      expect(d.source).toBe('qsp');
    }
    const texts = reservedDiags.map(d => d.message);
    expect(texts.some(t => t.includes("'end'"))).toBe(true);
    expect(texts.some(t => t.includes("'and'"))).toBe(true);
    expect(texts.some(t => t.includes("'play'"))).toBe(true);
  });
});
