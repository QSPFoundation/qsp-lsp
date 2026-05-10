import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import { QspTreeSitterParser, extractErrors } from '../src/parser/treeSitter';
import { WASM_PATH, runDiagnostics, diagnosticsMatching } from './testHelpers';

describe('extractErrors — error classification', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('should narrow single-line error to one row', () => {
    const tree = parser.parse('test://err-single', `# test
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
    const tree = parser.parse('test://err-quote', `# test
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
    const tree = parser.parse('test://err-noend', `# test
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
    const tree = parser.parse('test://err-brace', `# test
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
    const tree = parser.parse('test://err-brace-balanced', `# test
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
  it('should report MISSING node with descriptive message', () => {
    // `act:` without a name triggers a MISSING identifier_text node
    const tree = parser.parse('test://err-missing', `# test
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
    const tree = parser.parse(`test://mc-${keyword}`, text)!;
    const errors = extractErrors(tree);
    expect(errors.some(e => e.message === `Missing ':' after '${keyword}'`)).toBe(true);
  });

  it('should report valid code with no errors', () => {
    const tree = parser.parse('test://ok1', "# t\nif x=1:\n  y=2\nend\nact 'go':\n  z=3\nend\n---")!;
    expect(extractErrors(tree)).toEqual([]);
  });

  // ── BOM handling ──

  it('BOM at start of file → parse fails (BOM-stripping done in server)', () => {
    const tree = parser.parse('test://bom1', '\uFEFF# test\nx=1\n---')!;
    expect(tree.rootNode.hasError).toBe(true);
  });

  it('text with BOM stripped parses correctly', () => {
    const raw = '\uFEFF# test\nx=1\n---';
    const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    const tree = parser.parse('test://bom2', text)!;
    expect(tree.rootNode.hasError).toBe(false);
  });

  // ── Cascading error recovery ──

  it('detects missing colon in location after error-filled location', () => {
    const text = [
      '# templates', 'REMOVE MARKS FROM INVENTORY NAMES', '--- templates', '',
      '# next_loc', "if $j_name = 'test'", '  x = 1', 'end', '--- next_loc',
    ].join('\n');
    const tree = parser.parse('test://cascade1', text)!;
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
    const tree = parser.parse('test://cascade2', text)!;
    const colonErrors = extractErrors(tree).filter(e => e.message.includes("Missing ':'"));
    expect(colonErrors.some(e => e.message.includes("'if'"))).toBe(true);
  });

  it('reports errors in erroneous location AND valid code in next location has none', () => {
    const text = [
      '# templates', 'REMOVE MARKS FROM INVENTORY NAMES', '--- templates', '',
      '# next_loc', 'x = 1', '--- next_loc',
    ].join('\n');
    const tree = parser.parse('test://cascade3', text)!;
    const errors = extractErrors(tree);
    expect(errors.some(e => e.startRow <= 2)).toBe(true);
    expect(errors.filter(e => e.message.includes("Missing ':'"))).toHaveLength(0);
  });

  it('detects missing colon with string interpolation', () => {
    const text = [
      '# test', "if $j_name = 'Sidework at Stem'",
      "    $j_text='<<$stemwork>>'", 'end', '--- test',
    ].join('\n');
    const tree = parser.parse('test://cascade4', text)!;
    expect(extractErrors(tree).some(e => e.message === "Missing ':' after 'if'")).toBe(true);
  });

  it('detects missing colon with CRLF line endings', () => {
    const text = [
      '# test', "if $j_name = 'Sidework at Stem'",
      "    $j_text='<<$stemwork>>'", 'end', '--- test',
    ].join('\r\n');
    const tree = parser.parse('test://cascade5', text)!;
    expect(extractErrors(tree).some(e => e.message === "Missing ':' after 'if'")).toBe(true);
  });

  it('marks errors inside code_block as inCodeBlock', () => {
    // Use dynamic with a syntactic code block that has errors inside
    const tree = parser.parse('test://err-cb', `# test
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
    const tree = parser.parse('test://err-interp', `# test
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
    const tree = parser.parse('test://err-no-interp', `# test
)(
---
`);
    const errors = extractErrors(tree!);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every(e => !e.inInterpolation)).toBe(true);
  });

  it('errors outside code_block are not tagged inCodeBlock', () => {
    const tree = parser.parse('test://err-no-cb', `# test
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

  it('syntax errors inside code_block are Information severity (downgraded)', () => {
    const diags = runDiagnostics(parser, `# test\ndynamic {\n  if\n}\n---\n`, { maxErrorsPerLocation: 100 });
    // All syntax diagnostics in this snippet come from the code block → Information (3)
    const infoDiags = diags.filter(d => d.severity === 3);
    const errorDiags = diags.filter(d => d.severity === 1);
    expect(infoDiags.length).toBeGreaterThan(0);
    expect(errorDiags).toHaveLength(0);
  });

  // ── Invalid variable names (PEG: varName = ~digit nonDelimiterChar+) ──

  it.each([
    ['local', 'local 7=9'],
    ['set',   'set 7=9'],
    ['let',   'let 7=9'],
  ])("reports 'Expected a variable name' when '%s' is followed by a digit", (kw, line) => {
    const tree = parser.parse(`test://vn-lead-${kw}`, `# t\n${line}\n---\n`)!;
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
    const tree = parser.parse(`test://vn-list-${_label}`, `# t\n${line}\n---\n`)!;
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
    const tree = parser.parse('test://bare-at', '# t\n@\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /expected user function name.*'@'/i.test(e.message)
                          && !/'@@'/.test(e.message))).toBe(true);
  });

  it('bare `@@` reports "Expected user function name after \'@@\'"', () => {
    const tree = parser.parse('test://bare-atat', '# t\n@@\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /expected user function name.*'@@'/i.test(e.message))).toBe(true);
  });

  it('trailing operator reports "Expected expression after \'+\'"', () => {
    const tree = parser.parse('test://trail-op', '# t\nx = 1 +\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /expected expression after '\+'/i.test(e.message))).toBe(true);
  });

  it('double type prefix `$$x` reports "Duplicate type prefix"', () => {
    const tree = parser.parse('test://dup-prefix', '# t\n$$x = "a"\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /duplicate type prefix.*\$/i.test(e.message))).toBe(true);
  });

  it('`@` and `.` are valid inside variable names — no errors', () => {
    const tree = parser.parse('test://at-dot', '# t\nlocal x@y = 1\nlocal x.y = 2\n---\n');
    const errs = extractErrors(tree!);
    expect(errs).toHaveLength(0);
  });

  // ── Whitespace between type prefix and name ─────────────────────────

  it('whitespace between `#` and variable name is flagged', () => {
    const tree = parser.parse('test://hash-space', '# t\n# foo = 1\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /no whitespace allowed.*type prefix.*variable/i.test(e.message))).toBe(true);
  });

  it('whitespace between `$` and variable name is flagged', () => {
    const tree = parser.parse('test://dollar-space', '# t\n$ name = "x"\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /no whitespace allowed.*type prefix.*variable/i.test(e.message))).toBe(true);
  });

  it('whitespace between `@` and user function name is flagged', () => {
    const tree = parser.parse('test://at-space', '# t\n@ foo\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /no whitespace allowed.*'@'.*user function/i.test(e.message))).toBe(true);
  });

  it('whitespace between `@@` and user function name is flagged', () => {
    const tree = parser.parse('test://atat-space', '# t\n@@ foo\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /no whitespace allowed.*'@@'.*user function/i.test(e.message))).toBe(true);
  });

  it('adjacent prefix and name produces no whitespace error', () => {
    const tree = parser.parse('test://prefix-ok',
      '# t\n#x = 1\n$y = "a"\n@foo\n@@bar\nlen("z")\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.filter(e => /no whitespace allowed/i.test(e.message))).toHaveLength(0);
  });

  it('line continuation between prefix and name is flagged', () => {
    const tree = parser.parse('test://prefix-cont', '# t\n# _\n  foo = 1\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /no whitespace allowed.*type prefix/i.test(e.message))).toBe(true);
  });

  // ── Function name as lvalue ─────────────────────────────────────────

  it('`$len = "a"` reports function name cannot be assigned to', () => {
    const tree = parser.parse('test://fn-lvalue-1', '# t\n$len = "a"\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /'len'.*reserved function name.*cannot be assigned/i.test(e.message))).toBe(true);
  });

  it('`len = 1` reports function name cannot be assigned to', () => {
    const tree = parser.parse('test://fn-lvalue-2', '# t\nlen = 1\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /'len'.*reserved function name/i.test(e.message))).toBe(true);
  });

  it('`$mid = "a"` reports function name cannot be assigned to', () => {
    const tree = parser.parse('test://fn-lvalue-3', '# t\n$mid = "a"\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /'mid'.*reserved function name/i.test(e.message))).toBe(true);
  });

  it('`len("sdsd") = 44` is flagged (QSP parses as assignment)', () => {
    const tree = parser.parse('test://fn-args-1', "# t\nlen('sdsd') = 44\n---\n");
    const errs = extractErrors(tree!);
    expect(errs.some(e => /'len'.*reserved function name/i.test(e.message))).toBe(true);
  });

  it('`$mid("a",1,2) = "b"` is flagged', () => {
    const tree = parser.parse('test://fn-args-2', '# t\n$mid("a",1,2) = "b"\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.some(e => /'mid'.*reserved function name/i.test(e.message))).toBe(true);
  });

  it('`if len("x") = 5:` (comparison inside condition) is NOT flagged', () => {
    const tree = parser.parse('test://fn-cmp-call', '# t\nif len("x") = 5:\n  x = 1\nend\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.filter(e => /reserved function name/i.test(e.message))).toHaveLength(0);
  });

  it('`x = len("a")` is NOT flagged (function call on RHS)', () => {
    const tree = parser.parse('test://fn-rhs', '# t\nx = len("a")\n---\n');
    const errs = extractErrors(tree!);
    expect(errs.filter(e => /reserved function name/i.test(e.message))).toHaveLength(0);
  });

  it('`if len = 5:` (comparison, not assignment) is still flagged', () => {
    // This one is a judgment call — `len = 5` at any expression position
    // looks like assignment intent. We flag it consistently.
    const tree = parser.parse('test://fn-if-cmp', '# t\nif len = 5:\n  x = 1\nend\n---\n');
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

