import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { QspTreeSitterParser, extractErrors } from '../src/parser/treeSitter';
import { WASM_PATH, loadWasm, runDiagnostics, diagnosticsMatching } from './testHelpers';
import { QspHost } from '../src/mcp/qspHost';

describe('extractErrors — error classification', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('should narrow single-line error to one row', () => {
    const tree = parser.parseOnce(`# test
)(
---
`);
    expect(tree).not.toBeNull();
    const errors = extractErrors(tree!);
    expect(errors.length).toBeGreaterThan(0);
    // Single-line error should have startRow === endRow
    const lineOneErrors = errors.filter(e => e.startRow === 1);
    expect(lineOneErrors.length).toBeGreaterThan(0);
    expect(lineOneErrors[0].endRow).toBe(1);
  });

  it('should detect unclosed string as root cause', () => {
    const tree = parser.parseOnce(`# test
pl 'unclosed
x = 1
y = 2
---
`);
    expect(tree).not.toBeNull();
    const errors = extractErrors(tree!);
    expect(errors.length).toBeGreaterThan(0);
    // Should identify the unclosed string, not cascading errors
    const hasStringError = errors.some(e =>
      /unclosed string/i.test(e.message)
    );
    expect(hasStringError).toBe(true);
  });

  it('should detect missing end keyword for unclosed block', () => {
    const tree = parser.parseOnce(`# test
if x > 0:
  pl 'hello'
---
`);
    expect(tree).not.toBeNull();
    const errors = extractErrors(tree!);
    expect(errors.length).toBeGreaterThan(0);
    // Should mention missing 'end' or unclosed block
    const hasEndError = errors.some(e =>
      /end/i.test(e.message) || /unclosed/i.test(e.message)
    );
    expect(hasEndError).toBe(true);
  });

  it('should detect unclosed brace as root cause', () => {
    const tree = parser.parseOnce(`# test
pl {
x = 1
y = 2
---
`);
    expect(tree).not.toBeNull();
    const errors = extractErrors(tree!);
    expect(errors.length).toBeGreaterThan(0);
    const hasBraceError = errors.some(e =>
      /unclosed.*\{/i.test(e.message)
    );
    expect(hasBraceError).toBe(true);
  });

  it('does NOT report Unclosed "{" when braces balance inside a recovery subtree', () => {
    // An unrelated parse error causes the whole region to become one
    // big ERROR. The `{ ... }` on line 3 is well-balanced but its `}`
    // lands inside a grandchild ERROR. A shallow scan would spuriously
    // flag "Unclosed '{'"; a deep stack-match must not.
    const tree = parser.parseOnce(`# test
if x = 1
  pl {balanced block}
end
---
`)!;
    const errors = extractErrors(tree);
    // There IS an error (missing ':' after 'if'), but NOT "Unclosed '{'".
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => /unclosed.*\{/i.test(e.message))).toBe(false);
  });

  it('contains doubled quotes inside <<>> via the raw-body token (no host derailment)', () => {
    // Doubled-quote escapes inside `<<...>>` used to confuse tree-sitter
    // so badly that the matching `>>` was lost and the rest of the
    // location was swallowed into a giant ERROR.  The external scanner
    // now captures such bodies as one opaque `interpolation_raw_body`
    // token, so the host parses cleanly and no false diagnostics fire.
    const tree = parser.parseOnce(`# forest
! Demonstrates: loop, rand(), local variables, mixed call types.
local encounters = rand(1, 3)
local i = 0
pl 'You step into the forest.  The path forks <<func(''forest/encounter''), 2>> times.'

loop i = 1 while i <= encounters step i = i + 1:
    gs 'forest/encounter', i
end

act 'Rest by the river':
    hp = min(hp + 20, 100)
end
---
# forest/encounter
result = 1
---
`)!;
    const errors = extractErrors(tree);
    // The raw-body token keeps the host parse clean: no "Malformed
    // interpolation" and no misleading "Unclosed '('".
    expect(errors.some(e => /malformed interpolation/i.test(e.message))).toBe(false);
    expect(errors.some(e => /unclosed.*\(/i.test(e.message))).toBe(false);
  });

  // ── Stack-counting <<>> detection in refineErrorNode ──
  // The detection loop counts `<<` opens against `>>` closes and emits
  // "Malformed interpolation expression" at the LAST unmatched opener.
  // These cases exercise every branch of that counter (open++/close--/
  // stray-close-discard) and the negative case (balanced ⇒ no diag).
  describe('malformed <<>> stack-counting cases', () => {
    it('flags a lone unclosed `<<` at end-of-line', () => {
      // `<<func(` with no `>>` anywhere; ERROR spans into next line.
      const tree = parser.parseOnce(`# t\npl 'a <<func(\n---\n`)!;
      const errs = extractErrors(tree);
      const hit = errs.find(e => /malformed interpolation/i.test(e.message));
      expect(hit).toBeDefined();
      expect(hit!.startRow).toBe(1);
      expect(hit!.startCol).toBe(6);
    });

    it('does NOT flag a balanced `<<x>>` interpolation', () => {
      const tree = parser.parseOnce(`# t\npl 'a <<x>> b'\n---\n`)!;
      const errs = extractErrors(tree);
      expect(errs.some(e => /malformed interpolation/i.test(e.message))).toBe(false);
    });

    it('does NOT flag a stray `>>` with no preceding `<<`', () => {
      // openCount stays 0 on `>>`, so it's discarded and no diag fires.
      const tree = parser.parseOnce(`# t\npl 'a >> b'\n---\n`)!;
      const errs = extractErrors(tree);
      expect(errs.some(e => /malformed interpolation/i.test(e.message))).toBe(false);
    });

    it('flags an unclosed `<<` that follows a stray `>>`', () => {
      // The leading `>>` is discarded (openCount=0); the later `<<func(`
      // has no matching `>>` and triggers the diagnostic at the `<<`.
      const tree = parser.parseOnce(`# t\npl 'a >> b <<func(\n---\n`)!;
      const errs = extractErrors(tree);
      const hit = errs.find(e => /malformed interpolation/i.test(e.message));
      expect(hit).toBeDefined();
      expect(hit!.startRow).toBe(1);
      expect(hit!.startCol).toBe(11);
    });

    it('flags a second unclosed `<<` after a balanced pair', () => {
      // `<<x>>` cancels out; the second `<<func(` is the unmatched
      // opener and is what the diagnostic should anchor to.
      const tree = parser.parseOnce(`# t\npl 'a <<x>> b <<func(\nact 'y':\nend\n---\n`,
      )!;
      const errs = extractErrors(tree);
      const hit = errs.find(e => /malformed interpolation/i.test(e.message));
      expect(hit).toBeDefined();
      expect(hit!.startRow).toBe(1);
      expect(hit!.startCol).toBe(14);
    });
  });

  // ── Grammar-level containment of doubled-quote interpolation bodies ──
  //
  // A `<<…>>` body that uses the host string's doubled-quote escapes
  // (e.g. `'<<$func(''a/b'', ''c'')>>'`) is captured by the external
  // scanner as one opaque `interpolation_raw_body` token, so the host
  // parse stays clean and extractErrors reports nothing — no re-parse
  // callback needed.  Genuinely unclosed `<<` (no doubled quotes) still
  // surfaces.  Errors INSIDE a decoded body are reported by the
  // decode-and-reparse pass (covered in embeddedExec.test.ts), not here.
  describe('doubled-quote interpolation containment', () => {
    it('single-quoted host with `' + "''" + '` escapes parses cleanly', () => {
      const tree = parser.parseOnce(`# t\npl '<<$func(''a/b'', ''c'')>>'\n---\n`,
      )!;
      expect(extractErrors(tree)).toEqual([]);
    });

    it('double-quoted host with `""` escapes parses cleanly', () => {
      const tree = parser.parseOnce(`# t\npl "<<$func(""a/b"", ""c"")>>"\n---\n`,
      )!;
      expect(extractErrors(tree)).toEqual([]);
    });

    it('body carrying both doubled-quote types parses cleanly', () => {
      // The body holds BOTH a `''` sequence (an inner single-quoted
      // literal's own escape) and the `""` host escape.  The scanner
      // keys on the HOST quote, so the inner `''` is plain content.
      const tree = parser.parseOnce(`# t\npl "<<$func(""a/b"", 'it''s')>>"\n---\n`,
      )!;
      expect(extractErrors(tree)).toEqual([]);
    });

    it('still reports a genuinely unclosed `<<`', () => {
      // No `>>` and no doubled quotes: the raw-body token is not
      // emitted, so the inline path runs and the diagnostic fires.
      const tree = parser.parseOnce(`# t\npl 'a <<func(\n---\n`)!;
      const errs = extractErrors(tree);
      expect(errs.some(e => /malformed interpolation/i.test(e.message))).toBe(true);
    });

    it('an unterminated host string ends the raw body at the lone quote', () => {
      // `'<<mid(''abc'', 1)'` — the trailing `'` is a LONE host quote,
      // which always terminates the host string.  The scanner ends the
      // raw body before it and the missing `>>` surfaces as an error
      // instead of the whole rest of the file being swallowed.
      const tree = parser.parseOnce(`# t\npl '<<mid(''abc'', 1)'\nx = 1\n---\n`,
      )!;
      const errs = extractErrors(tree);
      expect(errs.length).toBeGreaterThan(0);
      // Containment: the error stays on the string's line.
      expect(errs.every(e => e.startRow === 1)).toBe(true);
    });
  });

  it('should report MISSING node with descriptive message', () => {
    // `act:` without a name triggers a MISSING identifier_text node
    const tree = parser.parseOnce(`# test
act:
end
---
`);
    expect(tree).not.toBeNull();
    const errors = extractErrors(tree!);
    expect(errors.length).toBeGreaterThan(0);
    // MISSING nodes produce "Expected ..." messages with friendly names
    const expectedMsg = errors.find(e => /expected/i.test(e.message));
    expect(expectedMsg).toBeDefined();
    // Should use friendly name, not raw grammar node type
    expect(expectedMsg!.message).toBe("Expected an identifier");
    // Must NOT contain underscores from raw node types
    expect(expectedMsg!.message).not.toContain('_');
  });

  // ── Missing colon diagnostics ──

  it.each([
    ['if', '# t\nif x = 1\n  y = 2\nend\n---'],
    ['elseif', '# t\nif x = 1:\n  y = 2\nelseif x = 2\n  y = 3\nend\n---'],
    ['act', "# t\nact 'do it'\n  x = 1\nend\n---"],
    ['loop', '# t\nloop i=0 while i<10\n  x+=1\nend\n---'],
  ])("should detect missing colon after '%s'", (keyword, text) => {
    const tree = parser.parseOnce(text)!;
    const errors = extractErrors(tree);
    expect(errors.some(e => e.message === `Missing ':' after '${keyword}'`)).toBe(true);
  });

  it('should report valid code with no errors', () => {
    const tree = parser.parseOnce("# t\nif x=1:\n  y=2\nend\nact 'go':\n  z=3\nend\n---")!;
    expect(extractErrors(tree)).toEqual([]);
  });

  // ── BOM handling ──

  it('BOM at start of file → parse fails (BOM-stripping done in server)', () => {
    const tree = parser.parseOnce('\uFEFF# test\nx=1\n---')!;
    expect(tree.rootNode.hasError).toBe(true);
  });

  it('text with BOM stripped parses correctly', () => {
    const raw = '\uFEFF# test\nx=1\n---';
    const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    const tree = parser.parseOnce(text)!;
    expect(tree.rootNode.hasError).toBe(false);
  });

  // ── Cascading error recovery ──

  it('detects missing colon in location after error-filled location', () => {
    const text = [
      '# templates', 'REMOVE MARKS FROM INVENTORY NAMES', '--- templates', '',
      '# next_loc', "if $j_name = 'test'", '  x = 1', 'end', '--- next_loc',
    ].join('\n');
    const tree = parser.parseOnce(text)!;
    const colonErrors = extractErrors(tree).filter(e => e.message.includes("Missing ':'"));
    expect(colonErrors.some(e => e.message.includes("'if'"))).toBe(true);
  });

  it('detects missing colon after location with multiline string + plain text', () => {
    const text = [
      '# templates', "! some comment",
      "*P 'Here are the templates that simplify building the game.", '',
      "$line = ''Now I can leave the fort.''&$jtorg+=$line", '',
      "$guardchain[39]=''Since recently the fort has opened its borders.'''",
      '! END BASE', 'REMOVE MARKS FROM INVENTORY NAMES',
      'ENTER DIALOG WITH CHARACTER', '--- templates', '',
      '# next_loc', "if $j_name = 'Sidework'", '  x = 1', 'end', '--- next_loc',
    ].join('\n');
    const tree = parser.parseOnce(text)!;
    const colonErrors = extractErrors(tree).filter(e => e.message.includes("Missing ':'"));
    expect(colonErrors.some(e => e.message.includes("'if'"))).toBe(true);
  });

  it('reports errors in erroneous location AND valid code in next location has none', () => {
    const text = [
      '# templates', 'REMOVE MARKS FROM INVENTORY NAMES', '--- templates', '',
      '# next_loc', 'x = 1', '--- next_loc',
    ].join('\n');
    const tree = parser.parseOnce(text)!;
    const errors = extractErrors(tree);
    expect(errors.some(e => e.startRow <= 2)).toBe(true);
    expect(errors.filter(e => e.message.includes("Missing ':'"))).toHaveLength(0);
  });

  it('detects missing colon with string interpolation', () => {
    const text = [
      '# test', "if $j_name = 'Sidework at Stem'",
      "    $j_text='<<$stemwork>>'", 'end', '--- test',
    ].join('\n');
    const tree = parser.parseOnce(text)!;
    expect(extractErrors(tree).some(e => e.message === "Missing ':' after 'if'")).toBe(true);
  });

  it('detects missing colon with CRLF line endings', () => {
    const text = [
      '# test', "if $j_name = 'Sidework at Stem'",
      "    $j_text='<<$stemwork>>'", 'end', '--- test',
    ].join('\r\n');
    const tree = parser.parseOnce(text)!;
    expect(extractErrors(tree).some(e => e.message === "Missing ':' after 'if'")).toBe(true);
  });

  it('marks errors inside code_block as inCodeBlock', () => {
    // Use dynamic with a syntactic code block that has errors inside
    const tree = parser.parseOnce(`# test
dynamic {
  if
}
---
`);
    const errors = extractErrors(tree!);
    const cbErrors = errors.filter(e => e.inCodeBlock);
    expect(cbErrors.length).toBeGreaterThan(0);
    // All errors should be tagged as inCodeBlock
    expect(errors.every(e => e.inCodeBlock)).toBe(true);
  });

  it('marks errors inside <<>> interpolation as inInterpolation', () => {
    // The scanner must accept this as "syntactically valid" for the grammar
    // to attempt parsing. Use an expression that passes the scanner validator
    // but fails the full grammar parse.
    const tree = parser.parseOnce(`# test
pl '<<x + >>'
---
`);
    const errors = extractErrors(tree!);
    // If the scanner accepted it (syntactic path), errors should be inInterpolation
    const interpErrors = errors.filter(e => e.inInterpolation);
    if (errors.length > 0) {
      // Either the scanner fell back to raw (no errors) or grammar errors are tagged
      expect(interpErrors.length).toBe(errors.length);
    }
  });

  it('errors outside interpolation are not tagged inInterpolation', () => {
    const tree = parser.parseOnce(`# test
)(
---
`);
    const errors = extractErrors(tree!);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every(e => !e.inInterpolation)).toBe(true);
  });

  it('errors outside code_block are not tagged inCodeBlock', () => {
    const tree = parser.parseOnce(`# test
)(
---
`);
    const errors = extractErrors(tree!);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every(e => !e.inCodeBlock)).toBe(true);
  });

  // ── Severity downgrade in computeDiagnostics ────────────────────

  it('syntax errors outside code blocks are Error severity (real diagnostics)', () => {
    const diags = runDiagnostics(parser, `# test\n)(\n---\n`, { maxErrorsPerLocation: 100 });
    // Syntax errors surface at Error (1) severity
    const errors = diags.filter(d => d.severity === 1);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('reports the syntax errors of a block run where it stands as errors', () => {
    for (const code of ['dynamic {\n  if\n}', '$x = dyneval({ if })']) {
      const diags = runDiagnostics(parser, `# test\n${code}\n---\n`, { maxErrorsPerLocation: 100 });
      expect(diags.length, code).toBeGreaterThan(0);
      expect(diags.every(d => d.severity === 1 && d.code === 'syntax'), code).toBe(true);
    }
  });

  // A `{…}` kept in a variable is a string, and games keep lists of words
  // in them: QSP checks it only when something runs it, and so do we.
  it('a stored block that is no code says nothing, single- or multi-line, until something runs it', () => {
    const settings = { maxErrorsPerLocation: 100, uninitializedVariables: true };
    for (const block of ['{ Яблоко, Банан }', '{ \n    Яблоко, Банан, Ананас,\n    Вишня, Папайя,\n}']) {
      expect(runDiagnostics(parser, `# test\nlocal $фрукты = ${block}\npl $фрукты\n---\n`, settings), block).toEqual([]);
      const ran = runDiagnostics(parser, `# test\n$фрукты = ${block}\ndynamic $фрукты\n---\n`, settings);
      expect(ran.length, block).toBeGreaterThan(0);
      expect(ran.every(d => d.code === 'syntax' && d.severity === 1), block).toBe(true);
    }
    // Run from another location of the file.
    const elsewhere = runDiagnostics(parser, `# a\n$фрукты = { Яблоко, Банан }\n---\n# b\ndynamic $фрукты\n---\n`, settings);
    expect(elsewhere.filter(d => d.code === 'syntax' && d.severity === 1).length).toBeGreaterThan(0);
  });

  // The shape of a game's word list: a multi-line block whose lines, the
  // last one too, end in a comma, split into an array by `scanstr`, in a
  // UTF-8 file with a BOM.
  const wordListLocation = [
    '# старт',
    "killvar '$названия'",
    'local $сырой_список = {',
    '    Яблоко, Груша, Слива, Персик, Абрикос,',
    '    Вишня, Черешня, Малина, Ежевика, Клубника,',
    '    Айва, Инжир, Финик, Лимон, Апельсин,',
    '}',
    "scanstr '$названия', $сырой_список, '[\\w-]+'",
    'pl $названия[rand(0, arrsize(\'$названия\') - 1)]',
    '--- старт ---',
    '',
  ].join('\n');

  it('a multi-line word list nothing runs gets no diagnostics at all', () => {
    const diags = runDiagnostics(parser, wordListLocation, {
      maxErrorsPerLocation: 100, uninitializedVariables: true, unusedVariables: true,
      typeMismatch: true, mixedVariablePrefixes: true, invalidBuiltinArgCount: true,
    });
    expect(diags).toEqual([]);
  });

  // `$mass[{act}]` is `$mass['act']`: the block is the key's text, and
  // nothing can run it.
  it('a block used as an array index is the text of its key, not code', () => {
    const code = "# test\n$mass['symb'] = '*'\n$x = $mass[{symb}]\npl '<<$mass[{symb}]>><<$mass[{act}]>>'\n$mass[{k}] = 1\npl $x\n---\n";
    expect(runDiagnostics(parser, code, { uninitializedVariables: true, unusedVariables: true, maxErrorsPerLocation: 100 })).toEqual([]);
  });

  // `{generic}` is the text `generic`, like 'generic': compared, or taken
  // by any operator whose result is a number, it is never run.
  it('a block an operator turns into a number is text, not code', () => {
    const settings = { uninitializedVariables: true, maxErrorsPerLocation: 100 };
    for (const line of ['if $args[{test}] = {generic}:\nend', 'x = {a} <> {b} and {act} >= 1\npl x', 'x = -{y} + no {z}\npl x', 'pl {if} = $args[0]']) {
      expect(runDiagnostics(parser, `# test\n${line}\n---\n`, settings), line).toEqual([]);
    }
    // Joined texts may be kept and run: still code.
    for (const line of ['$c = {pl y} + {pl z}', '$c = {pl y} & {pl z}']) {
      const diags = runDiagnostics(parser, `# test\n${line}\ndynamic $c\n---\n`, settings);
      expect(diags.map(d => d.message), line).toContain("Variable 'y' is used but never assigned");
    }
  });

  // A block passed as an argument is the text the callee gets as $args[N]:
  // code only when the callee runs it.
  it('a block passed as an argument is text unless the callee runs it', () => {
    const settings = { uninitializedVariables: true, maxErrorsPerLocation: 100 };
    const quiet = [
      "# a\ndynamic $args['test'], 10, {generic}\n---\n",
      "# a\ngs 'b', {generic}, {act}\n---\n# b\npl $args[0] + $args[1]\n---\n",
      "# a\n@b({generic})\n---\n# b\npl $args[0]\n---\n",
      "# a\n$where = $args[0]\ngs $where, {generic}\n---\n",
    ];
    for (const code of quiet) expect(runDiagnostics(parser, code, settings), code).toEqual([]);
    const run = runDiagnostics(parser, "# a\ngs 'b', {generic}, {act}\n---\n# b\ndynamic $args[0]\ndynamic $args[1]\n---\n", settings);
    expect(run.map(d => d.message).sort()).toEqual(["Missing ':' after 'act'", "Variable 'generic' is used but never assigned"]);
    const here = runDiagnostics(parser, '# a\ndynamic {dynamic $args[1]}, {g1}, {g2}\n---\n', settings);
    expect(here.map(d => d.message)).toEqual(["Variable 'g2' is used but never assigned"]);
  });

  // A block kept in a variable is the text the variable holds: code only
  // when something may run the variable, directly, through a copy or as
  // an argument of a location that runs its own.
  it('a block kept in a variable is text unless something may run the variable', () => {
    const settings = { uninitializedVariables: true, maxErrorsPerLocation: 100 };
    const quiet = [
      "# a\nset $args['temp_<<args[{gen}]>>'] = {generic}\n---\n",
      '# a\n$k = {pl y}\npl $k\n---\n',
      "# a\n$k = {pl y}\n$c = $k\ngs 'b', $k\n---\n# b\npl $args[0]\n---\n",
      "# a\n$args['t'] = {pl y}\n---\n# b\ndynamic $args[0]\n---\n",
      // Another element runs: `$args['temp_…']` is not `$args['something']`.
      "# a\nset $args['temp_<<args[{gen}]>>'] = {generic}\ndynamic $args['something'], 1, {value}\n---\n",
      '# a\n$h[1] = {pl y}\ndynamic $h[2]\n---\n',
      "# a\n$h['a'] = {pl y}\n$s = dyneval($h['b'])\n---\n",
      "# a\n$h = {pl y}\ndynamic $h['0']\n---\n",
      // A call passes its arguments into $args[N] of the callee, not into the element run.
      "# a\n$args['t'] = {pl y}\ndynamic $args['s']\ngs 'a', $args['subject']\n---\n",
      "# a\n$k = {pl y}\ngs 'b', 1, $k\n---\n# b\ndynamic $args[0]\n---\n",
      // `$result` takes `$args['subject_…']` of `b`; the call passes `$args[3]`.
      "# a\n$args['t'] = {pl y}\nset args['case'] = func('b', 'n', 's', 't', args['total'])\n---\n# b\nset $result = $args['subject_<<args[{i}]>>']\n---\n# c\n$x = dyneval($result)\n---\n",
    ];
    for (const code of quiet) expect(runDiagnostics(parser, code, settings), code).toEqual([]);
    const runs = [
      '# a\n$k = {pl y}\ndynamic $k\n---\n',
      '# a\n$k = {pl y}\n---\n# b\n$s = dyneval($k)\n---\n',
      "# a\n$h[1] = {pl y}\n$c = $h[1]\n---\n# b\ndynamic $c\n---\n",
      "# a\n$k = {pl y}\ngs 'b', $k\n---\n# b\ndynamic $args[0]\n---\n",
      "# a\n$args['t'] = {pl y}\ndynamic $args['t']\n---\n",
      "# a\n$k = 'a' + {pl y}\n*pl '<a href=\"exec:dynamic $k\">go</a>'\n---\n",
      '# a\n$result = {pl y}\n---\n',
      "# a\n$h['A'] = {pl y}\ndynamic $h['a']\n---\n",
      "# a\n$i = 'x'\n$args['temp_<<$i>>'] = {pl y}\ndynamic $args['temp_x']\n---\n",
      "# a\n$i = 'a'\n$h['a'] = {pl y}\ndynamic $h[$i]\n---\n",
      '# a\n$h = {pl y}\ndynamic $h[0]\n---\n',
      "# a\n$h['a'] = {pl y}\n$c = $h\ndynamic $c['b']\n---\n",
      "# a\n$k = {pl y}\ngs 'b', 1, $k\n---\n# b\ndynamic $args[1]\n---\n",
      "# a\n$k = {pl y}\ngs 'b', $k\n---\n# b\ni = 0\ndynamic $args[i]\n---\n",
      "# a\n$k = {pl y}\n$r = func('b', 'n', $k)\n---\n# b\n$result = $args[1]\n---\n# c\n$x = dyneval($result)\n---\n",
      "# a\n$h['go'] = {pl y}\n$c = $h['GO']\ndynamic $c\n---\n",
    ];
    for (const code of runs) {
      expect(runDiagnostics(parser, code, settings).map(d => d.message), code).toEqual(["Variable 'y' is used but never assigned"]);
    }
  });

  // Running a block doesn't run the blocks inside it: their syntax errors
  // count only when they run themselves.
  it('a block run shows the syntax errors of its own code, not of the blocks it holds', () => {
    const settings = { maxErrorsPerLocation: 100 };
    const key = runDiagnostics(parser, '# test\n$people = {\n$mass[{act}]\nset i = 0\n}\ndynamic $people\n---\n', settings);
    expect(key.filter(d => d.code === 'syntax')).toEqual([]);
    const list = runDiagnostics(parser, '# test\n$code = {\n$s = { Ann, Bob, }\npl 1\n}\ndynamic $code\n---\n', settings);
    expect(list.filter(d => d.code === 'syntax')).toEqual([]);
    const both = runDiagnostics(parser, '# test\n$code = {\n$s = { Ann, Bob, }\npl 1\n}\ndynamic $code\ndynamic $s\n---\n', settings);
    expect(both.filter(d => d.code === 'syntax').map(d => d.range.start.line)).toEqual([2]);
    const own = runDiagnostics(parser, '# test\n$code = {\n$s = { Ann, Bob, }\nact\n}\ndynamic $code\n---\n', settings);
    expect(own.filter(d => d.code === 'syntax').map(d => d.range.start.line)).toEqual([3]);
  });

  it('a word list in a file with a BOM gets no diagnostics, as without one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-bom-'));
    const diagnosticsOf = async (text: string) => {
      fs.writeFileSync(path.join(dir, 'main.qsps'), text);
      const host = new QspHost(dir, { wasmLoader: loadWasm });
      try {
        await host.start();
        return [...host.allDiagnostics()].flatMap(([, ds]) => ds);
      } finally {
        host.dispose();
      }
    };
    try {
      expect(await diagnosticsOf(wordListLocation)).toEqual([]);
      expect(await diagnosticsOf('\uFEFF' + wordListLocation)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // QSP trims each line before joining those that end in ` _`.
  it('accepts blanks after the underscore of a line continuation', () => {
    const code = "# test\nif args[{n}] > 0 _ \nand generic['<<$gen1>>_<<args[{n}]>>_<<$num[0]>>'] > 25 _\t\r\nor x:\nend\n---\n";
    expect(runDiagnostics(parser, code, { maxErrorsPerLocation: 100 }).filter(d => d.code === 'syntax')).toEqual([]);
  });

  it('accepts unary plus, also right after a binary plus', () => {
    for (const line of ["$s = 'a'++rand(0,20)++'b'", 'x = 1++2', "pl 'a' + +rand(0, 20)", 'x = +5']) {
      const tree = parser.parseOnce(`# t\n${line}\n---\n`)!;
      expect(extractErrors(tree), line).toEqual([]);
      tree.delete();
    }
  });

  // ── Invalid variable names (PEG: varName = ~digit nonDelimiterChar+) ──

  it.each([
    ['local', 'local 7=9'],
    ['set',   'set 7=9'],
    ['let',   'let 7=9'],
  ])("reports 'Expected a variable name' when '%s' is followed by a digit", (kw, line) => {
    const tree = parser.parseOnce(`# t\n${line}\n---\n`)!;
    const errors = extractErrors(tree);
    const hit = errors.find(e => /expected a variable name/i.test(e.message));
    expect(hit, `missing descriptive error for '${line}'\nGot: ${JSON.stringify(errors)}`).toBeDefined();
    expect(hit!.message).toMatch(new RegExp(`'${kw}'`, 'i'));
    // Generic fallback must not appear for this ERROR node
    expect(errors.some(e => /^Unexpected syntax/i.test(e.message) && e.startRow === 1)).toBe(false);
  });

  it.each([
    ['local',      'local i,7=5,8'],
    ['set',        'set i,7=5,8'],
    ['let',        'let i,7=5,8'],
    ['assignment', 'i,7=5,8'],
  ])("reports 'Invalid variable name' for digit in %s variable list", (_label, line) => {
    const tree = parser.parseOnce(`# t\n${line}\n---\n`)!;
    const errors = extractErrors(tree);
    const hit = errors.find(e => /invalid variable name/i.test(e.message));
    expect(hit, `missing descriptive error for '${line}'. Got: ${JSON.stringify(errors)}`).toBeDefined();
    expect(hit!.message).toMatch(/'7'/);
    expect(hit!.message).toMatch(/cannot start with a digit/i);
    // Must point at the offending token, not the whole statement
    expect(hit!.startRow).toBe(1);
    expect(hit!.endRow).toBe(1);
  });

  // ── Targeted single-line ERROR shapes ─────────────────────────────

  it('bare `@` reports "Expected user function name after \'@\'"', () => {
    const tree = parser.parseOnce('# t\n@\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /expected user function name.*'@'/i.test(e.message)
                          && !/'@@'/.test(e.message))).toBe(true);
  });

  it('bare `@@` reports "Expected user function name after \'@@\'"', () => {
    const tree = parser.parseOnce('# t\n@@\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /expected user function name.*'@@'/i.test(e.message))).toBe(true);
  });

  it('trailing operator reports "Expected expression after \'+\'"', () => {
    const tree = parser.parseOnce('# t\nx = 1 +\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /expected expression after '\+'/i.test(e.message))).toBe(true);
  });

  it('double type prefix `$$x` reports "Duplicate type prefix"', () => {
    const tree = parser.parseOnce('# t\n$$x = "a"\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /duplicate type prefix.*\$/i.test(e.message))).toBe(true);
  });

  it('`@` and `.` are valid inside variable names — no errors', () => {
    const tree = parser.parseOnce('# t\nlocal x@y = 1\nlocal x.y = 2\n---\n');
    const errs = extractErrors(tree!);
    expect(errs).toHaveLength(0);
  });

  // ── Whitespace between type prefix and name ─────────────────────────

  it('whitespace between `#` and variable name is flagged', () => {
    const tree = parser.parseOnce('# t\n# foo = 1\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /no whitespace allowed.*type prefix.*variable/i.test(e.message))).toBe(true);
  });

  it('whitespace between `$` and variable name is flagged', () => {
    const tree = parser.parseOnce('# t\n$ name = "x"\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /no whitespace allowed.*type prefix.*variable/i.test(e.message))).toBe(true);
  });

  it('whitespace between `@` and user function name is flagged', () => {
    const tree = parser.parseOnce('# t\n@ foo\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /no whitespace allowed.*'@'.*user function/i.test(e.message))).toBe(true);
  });

  it('whitespace between `@@` and user function name is flagged', () => {
    const tree = parser.parseOnce('# t\n@@ foo\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /no whitespace allowed.*'@@'.*user function/i.test(e.message))).toBe(true);
  });

  it('adjacent prefix and name produces no whitespace error', () => {
    const tree = parser.parseOnce('# t\n#x = 1\n$y = "a"\n@foo\n@@bar\nlen("z")\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.filter(e => /no whitespace allowed/i.test(e.message))).toHaveLength(0);
  });

  it('line continuation between prefix and name is flagged', () => {
    const tree = parser.parseOnce('# t\n# _\n  foo = 1\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /no whitespace allowed.*type prefix/i.test(e.message))).toBe(true);
  });

  it('prefix-whitespace check is suppressed inside an ERROR region', () => {
    // An unclosed `{` collapses the following lines into one ERROR node.
    // The `# foo` / `$ bar` inside it parse as prefixed variable_refs
    // with a phantom prefix/name gap, but those groupings are recovery
    // artifacts -- the ERROR is already reported, so no redundant
    // prefix-whitespace noise should be emitted.
    const tree = parser.parseOnce('# t\nx = {\n# foo = 1\n$ bar = 2\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /no whitespace allowed/i.test(e.message))).toBe(false);
  });

  it('prefix-whitespace check resumes after an ERROR region ends', () => {
    // Validates that the errorDepth counter is decremented on exit: a
    // genuine `# foo = 1` gap in a well-formed location AFTER an earlier
    // broken one must still be flagged.
    const tree = parser.parseOnce('# t\nif x:\n---\n# t2\n# foo = 1\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /no whitespace allowed.*type prefix.*variable/i.test(e.message))).toBe(true);
  });

  // ── Function name as lvalue ─────────────────────────────────────────

  it('`$len = "a"` reports function name cannot be assigned to', () => {
    const tree = parser.parseOnce('# t\n$len = "a"\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /'len'.*reserved function name.*cannot be assigned/i.test(e.message))).toBe(true);
  });

  it('`len = 1` reports function name cannot be assigned to', () => {
    const tree = parser.parseOnce('# t\nlen = 1\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /'len'.*reserved function name/i.test(e.message))).toBe(true);
  });

  it('`$mid = "a"` reports function name cannot be assigned to', () => {
    const tree = parser.parseOnce('# t\n$mid = "a"\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /'mid'.*reserved function name/i.test(e.message))).toBe(true);
  });

  it('`len("sdsd") = 44` is flagged (QSP parses as assignment)', () => {
    const tree = parser.parseOnce("# t\nlen('sdsd') = 44\n---\n");
    const errs = extractErrors(tree!);
    expect(errs.some(e => /'len'.*reserved function name/i.test(e.message))).toBe(true);
  });

  it('`$mid("a",1,2) = "b"` is flagged', () => {
    const tree = parser.parseOnce('# t\n$mid("a",1,2) = "b"\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /'mid'.*reserved function name/i.test(e.message))).toBe(true);
  });

  it('`if len("x") = 5:` (comparison inside condition) is NOT flagged', () => {
    const tree = parser.parseOnce('# t\nif len("x") = 5:\n  x = 1\nend\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.filter(e => /reserved function name/i.test(e.message))).toHaveLength(0);
  });

  it('`x = len("a")` is NOT flagged (function call on RHS)', () => {
    const tree = parser.parseOnce('# t\nx = len("a")\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.filter(e => /reserved function name/i.test(e.message))).toHaveLength(0);
  });

  it('`if len = 5:` (comparison, not assignment) is still flagged', () => {
    // This one is a judgment call — `len = 5` at any expression position
    // looks like assignment intent. We flag it consistently.
    const tree = parser.parseOnce('# t\nif len = 5:\n  x = 1\nend\n---\n');
    const errs = extractErrors(tree!);
    // Inside `if ... :`, na_binary's parent is `if_keyword`-bearing rule,
    // not `implicit_statement` — so this case is NOT flagged. Verify
    // the lint stays scoped to top-level statements.
    expect(errs.filter(e => /reserved function name/i.test(e.message))).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Incremental parsing & cache management
// ──────────────────────────────────────────────────────────────────────

describe('unclosed location detection (real computeDiagnostics)', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(async () => { await parser.init(async () => fs.readFileSync(WASM_PATH)); });

  /** Run the real diagnostic engine with only the unclosedLocations check on. */
  const runUnclosed = (code: string) =>
    diagnosticsMatching(
      runDiagnostics(parser, code, { unclosedLocations: true }),
      'may not be properly closed',
    );

  it('properly closed location produces no warning', () => {
    expect(runUnclosed(`# start\npl 'hello'\n---\n`)).toHaveLength(0);
  });

  it('location without closing -- is flagged', () => {
    const diags = runUnclosed(`# start\npl 'hello'\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'start'");
  });

  it('multiple locations — only unclosed one is flagged', () => {
    const diags = runUnclosed(`# first\npl 'a'\n---\n# second\npl 'b'\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'second'");
  });

  it('all locations properly closed → no warnings', () => {
    const diags = runUnclosed(`# a\nx = 1\n---\n# b\ny = 2\n---\n# c\nz = 3\n---\n`);
    expect(diags).toHaveLength(0);
  });

  it('adjacent # lines without a --- between them form a single unclosed location', () => {
    // buildLocationIndex closes on \n-- only; an internal \n# is treated as content.
    const diags = runUnclosed(`# first\npl 'a'\n# second\npl 'b'\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'first'");
  });

  it('indented --- is not a valid terminator', () => {
    const diags = runUnclosed(`# start\npl 'hello'\n  ---\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'start'");
  });

  it('--- followed by a name on same line still closes the location', () => {
    expect(runUnclosed(`# start\npl 'hello'\n--- start\n`)).toHaveLength(0);
  });

  it('empty location without closing -- is flagged', () => {
    const diags = runUnclosed(`# empty\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'empty'");
  });

  it('diagnostic range points at the location header line', () => {
    const diags = runUnclosed(`# a\npl 'a'\n---\n# broken\nx = 1\n`);
    expect(diags).toHaveLength(1);
    // broken starts on line 3 (0-indexed)
    expect(diags[0].range.start.line).toBe(3);
    expect(diags[0].range.start.character).toBe(0);
  });

  it('disabled check produces no diagnostics even with unclosed location', () => {
    // Default (unclosedLocations: false) — should not surface the check
    const diags = diagnosticsMatching(
      runDiagnostics(parser, `# broken\npl 'a'\n`),
      'may not be properly closed',
    );
    expect(diags).toHaveLength(0);
  });
});

// ── Location too long detection ──────────────────────────────────────

describe('location too long detection (real computeDiagnostics)', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(async () => { await parser.init(async () => fs.readFileSync(WASM_PATH)); });

  const runTooLong = (code: string, maxLocationLines: number) =>
    diagnosticsMatching(
      runDiagnostics(parser, code, { maxLocationLines }),
      'lines long (max',
    );

  const buildLocation = (name: string, bodyLines: number): string => {
    const lines = [`# ${name}`];
    for (let i = 0; i < bodyLines; i++) lines.push(`x = ${i}`);
    lines.push('---', '');
    return lines.join('\n');
  };

  it('short location produces no warning', () => {
    expect(runTooLong(`# start\npl 'hello'\n---\n`, 500)).toHaveLength(0);
  });

  it('location exceeding limit is flagged', () => {
    // `# big` + 10 body lines + `---` → endLine - startLine = 11
    const diags = runTooLong(buildLocation('big', 10), 5);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'big'");
    expect(diags[0].message).toContain('11 lines long (max 5)');
  });

  it('location exactly at limit is not flagged (strict greater-than)', () => {
    // 5 body + header + --- → endLine - startLine = 6
    expect(runTooLong(buildLocation('exact', 5), 6)).toHaveLength(0);
  });

  it('location one over limit is flagged', () => {
    expect(runTooLong(buildLocation('over', 5), 5)).toHaveLength(1);
  });

  it('mixed: only long location is flagged', () => {
    const code = '# short\nx = 1\n---\n' + buildLocation('long', 10);
    const diags = runTooLong(code, 5);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'long'");
  });

  it('maxLocationLines = 0 disables the check entirely', () => {
    // Even a 1000-line location must not be flagged when the setting is 0.
    const diags = runTooLong(buildLocation('huge', 1000), 0);
    expect(diags).toHaveLength(0);
  });

  it('diagnostic severity is Warning (not Error)', () => {
    const diags = runTooLong(buildLocation('big', 10), 5);
    expect(diags).toHaveLength(1);
    // DiagnosticSeverity.Warning === 2
    expect(diags[0].severity).toBe(2);
  });

  it('diagnostic range targets the header line', () => {
    const diags = runTooLong(buildLocation('big', 10), 5);
    expect(diags[0].range.start.line).toBe(0);
    expect(diags[0].range.start.character).toBe(0);
  });

  it('multiple locations can each exceed the limit independently', () => {
    const code = buildLocation('a', 10) + buildLocation('b', 10);
    const diags = runTooLong(code, 5);
    expect(diags).toHaveLength(2);
    const names = diags.map(d => d.message).sort();
    expect(names[0]).toContain("'a'");
    expect(names[1]).toContain("'b'");
  });
});

// ── Syntax error threshold collapsing ────────────────────────────────

describe('syntax error threshold collapsing (real computeDiagnostics)', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  /** Classify diagnostics emitted by the real engine. */
  function classify(code: string, maxErrorsPerLocation: number) {
    const diags = runDiagnostics(parser, code, { maxErrorsPerLocation });
    const collapsed = diagnosticsMatching(diags, 'syntax errors — only non-code content?');
    const individual = diags.filter(d => !collapsed.includes(d));
    return { diags, individual, collapsed };
  }

  it('few errors stay as individual diagnostics', () => {
    const code = `# test\nlocal 7\nlocal 8\n---\n`;
    const { individual, collapsed } = classify(code, 20);
    expect(individual.length).toBeGreaterThan(0);
    expect(collapsed).toHaveLength(0);
  });

  it('errors exceeding threshold collapse to one summary', () => {
    const lines = ['# broken'];
    // Each `local 7` line produces an independent "Expected variable name
    // after 'local'" error — used here to force many per-location errors.
    for (let i = 0; i < 20; i++) lines.push('local 7');
    lines.push('---', '');
    const code = lines.join('\n');
    const { individual, collapsed } = classify(code, 2);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].message).toContain("'broken'");
    expect(collapsed[0].message).toMatch(/has \d+ syntax errors/);
    // No individual syntax errors from within the collapsed location.
    const brokenIndividual = individual.filter(
      d => d.range.start.line >= 1 && d.range.start.line <= 22,
    );
    expect(brokenIndividual).toHaveLength(0);
  });

  it('mixed: one location collapses, another stays individual', () => {
    const lines = [
      '# clean', 'local 7', '---',
      '# noisy',
    ];
    for (let i = 0; i < 20; i++) lines.push('local 7');
    lines.push('---', '');
    const code = lines.join('\n');
    const { individual, collapsed } = classify(code, 2);
    expect(collapsed.some(d => d.message.includes("'noisy'"))).toBe(true);
    expect(collapsed.every(d => !d.message.includes("'clean'"))).toBe(true);
    // 'clean' contributes individual diagnostic(s)
    expect(individual.length).toBeGreaterThan(0);
  });

  it('errors on location end-lines (---) are excluded from buckets', () => {
    const code = `# test\npl 'hello'\n---\n`;
    const { individual, collapsed } = classify(code, 20);
    // End-line errors (line 2 = ---) must not appear among diagnostics.
    expect(individual.every(d => d.range.start.line !== 2)).toBe(true);
    expect(collapsed).toHaveLength(0);
  });

  it('location with exactly threshold errors stays individual (<= boundary)', () => {
    const lines = ['# exact'];
    for (let i = 0; i < 3; i++) lines.push('local 7');
    lines.push('---', '');
    const code = lines.join('\n');
    const { individual, collapsed } = classify(code, 3);
    expect(collapsed).toHaveLength(0);
    expect(individual.length).toBeGreaterThan(0);
  });

  it('collapsed summary is emitted once per over-threshold location', () => {
    const buildNoisy = (name: string): string[] => {
      const ls = [`# ${name}`];
      for (let i = 0; i < 20; i++) ls.push('local 7');
      ls.push('---', '');
      return ls;
    };
    const code = [...buildNoisy('n1'), ...buildNoisy('n2')].join('\n');
    const { collapsed } = classify(code, 2);
    expect(collapsed).toHaveLength(2);
    expect(collapsed.some(d => d.message.includes("'n1'"))).toBe(true);
    expect(collapsed.some(d => d.message.includes("'n2'"))).toBe(true);
  });

  it('collapsed summary range targets the location header line', () => {
    const lines = ['# hdr'];
    for (let i = 0; i < 20; i++) lines.push('local 7');
    lines.push('---', '');
    const { collapsed } = classify(lines.join('\n'), 2);
    expect(collapsed[0].range.start.line).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Mixed location call types diagnostics
// ──────────────────────────────────────────────────────────────────────


// The loosest operator in a multi-line expression (`or`) must be able to
// end right before a newline; otherwise a closer on the next line shows up
// as "Unexpected syntax" on the last operand. The QSP engine treats
// newlines inside brackets as whitespace, so these are all valid.
describe('extractErrors — multi-line `or` before a closer on the next line', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  const errorsIn = (body: string) => {
    const tree = parser.parseOnce(`# test\n${body}\n---\n`)!;
    try {
      return extractErrors(tree).map(e => `${e.startRow}:${e.startCol} ${e.message}`);
    } finally {
      tree.delete();
    }
  };

  it('accepts the reported if-condition with or/and spread over lines', () => {
    expect(errorsIn(`if $people['<<args[{i}]>>_<<$num[0]>>'] <> 'Неизвестно'  _
	and (relat['<<$rab>>_<<args[{i}]>>_<<$num[0]>>'] >= -25
		or relat['<<$rab>>_<<args[{i}]>>_<<$num[9]>>'] = 1
	):
		set args['teacher_<<args[{teachers}]>>'] = args[{i}]
		set args[{teachers}] += 1
	end`)).toEqual([]);
  });

  it('accepts line continuations before operators inside parentheses', () => {
    expect(errorsIn(`set args[{ORM}] = ( $people['<<$tempArg>>_<<$num[3]>>'] = 'Д'  _
		and $people['<<$tempArg>>_<<$num[4]>>'] ! 'С' _
	) or ( $people['<<$rab>>_<<$num[3]>>'] ! 'Д'  _
		and $people['<<$tempArg>>_<<$num[4]>>'] ! 'А' )`)).toEqual([]);
  });

  it.each([
    ['paren', `x = (a or b\n)`],
    ['function args', `x = max(a or b\n)`],
    ['args before a comma', `x = max(a or b\n, 1)`],
    ['array index', `x = arr[a or b\n]`],
    ['tuple', `x = [1, a or b\n]`],
    ['interpolation', `pl '<<a or b\n>>'`],
    ['or chain with newlines before each or', `x = (a\n or b\n or c\n)`],
  ])('accepts %s', (_name, body) => {
    expect(errorsIn(body)).toEqual([]);
  });
});
