/**
 * Tests for server-side pure helper functions.
 */
import { describe, it, expect } from 'vitest';
import {
  opensBlock,
  findColonOutsideStrings,
  splitInlineStatement,
  buildBlockReplacement,
  formatLines,
  inferIndentLevel,
  parseActName,
} from '../src/server/helpers';

// ──────────────────────────────────────────────────────────────────────
// opensBlock
// ──────────────────────────────────────────────────────────────────────

describe('opensBlock', () => {
  // ── Block forms (should return true) ─────────────────────────────

  it.each([
    ['if x > 0:'],
    ["act 'Go north':"],
    ['loop while x < 10:'],
    ['else:'],
    ['else'],
    ['elseif y = 2:'],
    ['else if y = 2:'],
    // Case-insensitive
    ['IF x > 0:'],
    ["Act 'Go':"],
    ['LOOP while 1:'],
    ['ELSE:'],
    ['ELSEIF x:'],
    // Comment after colon → block form
    ['if x > 0: ! check positive'],
    ["act 'Go': ! go action"],
    ['else: ! fallback'],
    // Bare else with comment
    ['else ! fallback'],
    ['else ! note'],
    // Doubled-quote escape in act name → colon outside string
    ["act 'it''s a test':"],
    // Complex expression with colon
    ["act 'Go' + $dir:"],
    // String containing colon, then real colon
    ["if 'a:b' = x:"],
    // Doubled-quote in elseif
    ["elseif $x = 'it''s':"],
  ])('should detect block opener: %s', (line) => {
    expect(opensBlock(line)).toBe(true);
  });

  // ── Inline forms (should return false) ──────────────────────────

  it.each([
    ["if x > 0: pl 'hi'"],
    ["act 'Go north': pl 'going'"],
    ['loop while x < 10: x += 1'],
    ["else: pl 'nope'"],
    ["else pl 'nope'"],
    ["elseif y = 2: pl 'two'"],
    ["else if y = 2: pl 'two'"],
    ["act 'label: name': pl 'hi'"],
    // Case-insensitive inline
    ["IF x > 0: pl 'hi'"],
    ["Act 'Go': pl 'x'"],
    ['LOOP while 1: x += 1'],
    // Doubled-quote inline
    ["act 'it''s a test': body"],
  ])('should reject inline form: %s', (line) => {
    expect(opensBlock(line)).toBe(false);
  });

  // ── Non-openers (should return false) ───────────────────────────

  it.each([
    ['if x > 0'],          // if without colon
    ["gosub 'test'"],      // not a block keyword
    ['pl "hello"'],
    ['x = 1'],
    ["act 'key: value'"],  // colon inside string, no trailing colon
    ['act "key: value"'],
    [''],                   // empty string
    ['elseif x > 0'],      // elseif without colon
    ['loop while x < 10'], // loop without colon
    ["pl 'hello':"],       // unknown keyword with colon
  ])('should reject non-opener: %s', (line) => {
    expect(opensBlock(line)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// findColonOutsideStrings
// ──────────────────────────────────────────────────────────────────────

describe('findColonOutsideStrings', () => {
  it.each([
    ['if x > 0: body', 8],
    ["act 'name': body", 10],
    ["if 'a:b' = x: body", 12],
    ["act 'it''s a test': body", 18],
    ["if 'test''': body", 11],
  ])('should find colon at index: %s → %i', (text, expected) => {
    expect(findColonOutsideStrings(text)).toBe(expected);
  });

  it.each([
    ['x = 1'],
    ["pl 'a:b'"],
    ['pl "a:b"'],
    [''],
    ["pl 'a:b"],                      // unclosed quote
    ["act 'it''s a:test'"],           // colon inside doubled-quote string
    ['act "say ""hi:there"""'],       // double-quote escape
  ])('should return -1: %s', (text) => {
    expect(findColonOutsideStrings(text)).toBe(-1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// splitInlineStatement
// ──────────────────────────────────────────────────────────────────────

describe('splitInlineStatement', () => {
  it.each([
    ["if x > 0: pl 'positive'", 'if x > 0:', "pl 'positive'"],
    ["act 'Go north': goto 'forest'", "act 'Go north':", "goto 'forest'"],
    ["if 'a:b' = x: pl 'match'", "if 'a:b' = x:", "pl 'match'"],
    ["  if x > 0: pl 'yes'", '  if x > 0:', "pl 'yes'"],
    ["act 'it''s': goto 'room'", "act 'it''s':", "goto 'room'"],
    ["if x: if y: pl 'z'", 'if x:', "if y: pl 'z'"],
    ['loop while x < 10: x += 1', 'loop while x < 10:', 'x += 1'],
    ["else: pl 'default'", 'else:', "pl 'default'"],
    ['if x: ! comment', 'if x:', '! comment'],
    ["\tif x > 0: pl 'a'", '\tif x > 0:', "pl 'a'"],
  ])('should split: %s', (input, expectedHeader, expectedBody) => {
    const result = splitInlineStatement(input);
    expect(result).not.toBeNull();
    expect(result!.header).toBe(expectedHeader);
    expect(result!.body).toBe(expectedBody);
  });

  it.each([
    ["pl 'hello: world'"],  // colon only inside string
    ['if x > 0:'],          // empty body
    ['if x > 0:   '],       // whitespace-only body
  ])('should return null: %s', (input) => {
    expect(splitInlineStatement(input)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildBlockReplacement
// ──────────────────────────────────────────────────────────────────────

describe('buildBlockReplacement', () => {
  it.each([
    ["if x > 0: pl 'hi'", "if x > 0:\n  pl 'hi'\nend"],
    ["  if x > 0: pl 'hi'", "  if x > 0:\n    pl 'hi'\n  end"],
    ["act 'Go': goto 'forest'", "act 'Go':\n  goto 'forest'\nend"],
    ['loop while x < 10: x += 1', 'loop while x < 10:\n  x += 1\nend'],
    ["    act 'test': pl 'body'", "    act 'test':\n      pl 'body'\n    end"],
    ["act 'key: val': pl 'ok'", "act 'key: val':\n  pl 'ok'\nend"],
    ["elseif x > 0: pl 'yes'", "elseif x > 0:\n  pl 'yes'\nend"],
    ["else: pl 'default'", "else:\n  pl 'default'\nend"],
    ["\tif x > 0: pl 'hi'", "\tif x > 0:\n\t  pl 'hi'\n\tend"],
    ["        if x: y = 1", "        if x:\n          y = 1\n        end"],
    ["act 'it''s a test': goto 'room'", "act 'it''s a test':\n  goto 'room'\nend"],
  ])('should convert to block: %s', (input, expected) => {
    expect(buildBlockReplacement(input)).toBe(expected);
  });

  it('should use custom eol for line endings', () => {
    expect(buildBlockReplacement("if x > 0: pl 'hi'", '\r\n'))
      .toBe("if x > 0:\r\n  pl 'hi'\r\nend");
  });

  it.each([
    ["pl 'hello: world'"],  // no colon outside strings
    ['if x > 0:'],          // empty body
  ])('should return null: %s', (input) => {
    expect(buildBlockReplacement(input)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// formatLines
// ──────────────────────────────────────────────────────────────────────

describe('formatLines', () => {
  it('should indent block-form if…end', () => {
    expect(formatLines(['# test', 'if x > 0:', "pl 'hello'", 'end', '---']))
      .toBe("# test\nif x > 0:\n  pl 'hello'\nend\n---");
  });

  it('should indent nested blocks (if inside act)', () => {
    expect(formatLines([
      '# test', "act 'Go':", 'if x > 0:', "pl 'yes'", 'end', 'end', '---',
    ])).toBe("# test\nact 'Go':\n  if x > 0:\n    pl 'yes'\n  end\nend\n---");
  });

  it('should outdent else/elseif to parent level', () => {
    expect(formatLines([
      '# test', 'if x > 0:', "pl 'positive'", 'elseif x = 0:',
      "pl 'zero'", 'else', "pl 'negative'", 'end', '---',
    ])).toBe([
      '# test', 'if x > 0:', "  pl 'positive'", 'elseif x = 0:',
      "  pl 'zero'", 'else', "  pl 'negative'", 'end', '---',
    ].join('\n'));
  });

  it('should keep labels at column 0', () => {
    expect(formatLines(['# test', 'if x:', '  :myLabel', "  pl 'hi'", 'end', '---']))
      .toBe("# test\nif x:\n:myLabel\n  pl 'hi'\nend\n---");
  });

  it('should keep empty lines empty', () => {
    expect(formatLines(['# test', '', 'x = 1', '', '---']))
      .toBe('# test\n\nx = 1\n\n---');
  });

  it('should not indent inline if (no block)', () => {
    expect(formatLines(['# test', "if x > 0: pl 'hi'", 'y = 2', '---']))
      .toBe("# test\nif x > 0: pl 'hi'\ny = 2\n---");
  });

  it('should handle loop blocks', () => {
    expect(formatLines(['# test', 'loop while x < 10:', 'x += 1', 'end', '---']))
      .toBe('# test\nloop while x < 10:\n  x += 1\nend\n---');
  });

  it('should strip existing indentation and re-indent', () => {
    expect(formatLines(['# test', '    if x:', '  pl "a"', '         end', '---']))
      .toBe('# test\nif x:\n  pl "a"\nend\n---');
  });

  it('should respect baseIndent parameter', () => {
    expect(formatLines(["pl 'inside block'", 'x = 1'], 2))
      .toBe("    pl 'inside block'\n    x = 1");
  });

  it('should use tabs when useTabs is true', () => {
    expect(formatLines(['# test', 'if x:', "pl 'a'", 'end', '---'], 0, { useTabs: true }))
      .toBe("# test\nif x:\n\tpl 'a'\nend\n---");
  });

  it('should use custom tabSize', () => {
    expect(formatLines(['# test', 'if x:', "pl 'a'", 'end', '---'], 0, { tabSize: 4 }))
      .toBe("# test\nif x:\n    pl 'a'\nend\n---");
  });

  it('should use custom eol', () => {
    expect(formatLines(['# test', 'x = 1', '---'], 0, { eol: '\r\n' }))
      .toBe('# test\r\nx = 1\r\n---');
  });

  it('should handle location header and separator at column 0', () => {
    expect(formatLines(['   # test', '   x = 1', '    ---']))
      .toBe('# test\nx = 1\n---');
  });

  it('should handle end reducing indent to 0 (not negative)', () => {
    expect(formatLines(['end', 'x = 1'])).toBe('end\nx = 1');
  });

  it('should format multiple locations in sequence', () => {
    expect(formatLines([
      '# loc1', 'if x:', "pl 'a'", 'end', '---',
      '# loc2', "act 'Go':", "pl 'b'", 'end', '---',
    ])).toBe([
      '# loc1', 'if x:', "  pl 'a'", 'end', '---',
      '# loc2', "act 'Go':", "  pl 'b'", 'end', '---',
    ].join('\n'));
  });

  it('should handle block-form else: (with colon)', () => {
    expect(formatLines(['# test', 'if x:', "pl 'a'", 'else:', "pl 'b'", 'end', '---']))
      .toBe("# test\nif x:\n  pl 'a'\nelse:\n  pl 'b'\nend\n---");
  });

  it('should handle deeply nested blocks (3+ levels)', () => {
    expect(formatLines([
      '# test', "act 'Go':", 'if x:', 'loop while y:',
      "pl 'deep'", 'end', 'end', 'end', '---',
    ])).toBe([
      '# test', "act 'Go':", '  if x:', '    loop while y:',
      "      pl 'deep'", '    end', '  end', 'end', '---',
    ].join('\n'));
  });

  it('should handle else if (two words) as block opener', () => {
    expect(formatLines([
      '# test', 'if x > 0:', "pl 'a'",
      'else if y > 0:', "pl 'b'", 'end', '---',
    ])).toBe([
      '# test', 'if x > 0:', "  pl 'a'",
      'else if y > 0:', "  pl 'b'", 'end', '---',
    ].join('\n'));
  });

  it('should handle mixed inline and block forms', () => {
    expect(formatLines([
      '# test', "if x > 0: pl 'inline'", 'if y > 0:',
      "pl 'block'", 'end', "act 'Go': goto 'room'", '---',
    ])).toBe([
      '# test', "if x > 0: pl 'inline'", 'if y > 0:',
      "  pl 'block'", 'end', "act 'Go': goto 'room'", '---',
    ].join('\n'));
  });

  it('should handle comments at current indent', () => {
    expect(formatLines([
      '# test', 'if x:', '! this is a comment', "pl 'a'", 'end', '---',
    ])).toBe([
      '# test', 'if x:', '  ! this is a comment', "  pl 'a'", 'end', '---',
    ].join('\n'));
  });

  it('should handle elseif with colon and trailing comment', () => {
    expect(formatLines([
      '# test', 'if x > 0:', "pl 'a'",
      'elseif y > 0: ! fallback', "pl 'b'", 'end', '---',
    ])).toBe([
      '# test', 'if x > 0:', "  pl 'a'",
      'elseif y > 0: ! fallback', "  pl 'b'", 'end', '---',
    ].join('\n'));
  });

  it('should handle else with inline body (not a block opener)', () => {
    expect(formatLines([
      '# test', 'if x > 0:', "pl 'a'", "else pl 'b'", 'end', '---',
    ])).toBe([
      '# test', 'if x > 0:', "  pl 'a'", "else pl 'b'", 'end', '---',
    ].join('\n'));
  });

  it('should handle labels inside nested blocks at column 0', () => {
    expect(formatLines([
      '# test', 'if x:', ':innerLabel', "pl 'at label'", 'end', '---',
    ])).toBe([
      '# test', 'if x:', ':innerLabel', "  pl 'at label'", 'end', '---',
    ].join('\n'));
  });

  it('should reset indent at new location boundary', () => {
    expect(formatLines([
      '# loc1', 'if x:', "pl 'a'", 'end', '---',
      '# loc2', "pl 'b'", '---',
    ])).toBe([
      '# loc1', 'if x:', "  pl 'a'", 'end', '---',
      '# loc2', "pl 'b'", '---',
    ].join('\n'));
  });

  it('should handle consecutive block openers and closers', () => {
    expect(formatLines(['# test', 'if a:', 'end', 'if b:', 'end', '---']))
      .toBe('# test\nif a:\nend\nif b:\nend\n---');
  });

  it('should handle loop with act inside', () => {
    expect(formatLines([
      '# test', 'loop while 1:', "act 'Do':", "pl 'inner'", 'end', 'end', '---',
    ])).toBe([
      '# test', 'loop while 1:', "  act 'Do':", "    pl 'inner'", '  end', 'end', '---',
    ].join('\n'));
  });

  it('should handle tabs with nested blocks', () => {
    expect(formatLines(
      ['# test', 'if x:', 'if y:', "pl 'deep'", 'end', 'end', '---'],
      0, { useTabs: true },
    )).toBe([
      '# test', 'if x:', '\tif y:', "\t\tpl 'deep'", '\tend', 'end', '---',
    ].join('\n'));
  });

  it('should handle tabSize 4 with nested blocks', () => {
    expect(formatLines(
      ['# test', 'if x:', "pl 'a'", 'end', '---'],
      0, { tabSize: 4 },
    )).toBe("# test\nif x:\n    pl 'a'\nend\n---");
  });

  it('should handle baseIndent with block openers', () => {
    expect(formatLines(['if x:', "pl 'nested'", 'end'], 1))
      .toBe("  if x:\n    pl 'nested'\n  end");
  });

  it('should handle end with extra text (end if)', () => {
    expect(formatLines(['# test', 'if x:', "pl 'a'", 'end if', '---']))
      .toBe("# test\nif x:\n  pl 'a'\nend if\n---");
  });

  it('should handle act with comment after colon', () => {
    expect(formatLines(['# test', "act 'Go': ! navigate", "pl 'going'", 'end', '---']))
      .toBe("# test\nact 'Go': ! navigate\n  pl 'going'\nend\n---");
  });

  it('should handle all-empty input', () => {
    expect(formatLines(['', '', ''])).toBe('\n\n');
  });

  it('should handle single location header', () => {
    expect(formatLines(['# test'])).toBe('# test');
  });

  it('should handle unicode labels', () => {
    expect(formatLines(['# test', 'if x:', ':метка', "pl 'у метки'", 'end', '---']))
      .toBe("# test\nif x:\n:метка\n  pl 'у метки'\nend\n---");
  });

  // ── Multi-line strings: continuation lines must be verbatim ──────

  it('passes continuation lines of a single-quoted multi-line string through verbatim', () => {
    // The second line is string content — must not be trimmed or re-indented.
    expect(formatLines([
      '# test',
      "pl 'first line",
      '     second line',
      "     third line'",
      '---',
    ])).toBe("# test\npl 'first line\n     second line\n     third line'\n---");
  });

  it('passes continuation lines of a double-quoted multi-line string through verbatim', () => {
    expect(formatLines([
      '# test',
      'x = "hello',
      '  world"',
      'y = 1',
      '---',
    ])).toBe('# test\nx = "hello\n  world"\ny = 1\n---');
  });

  it('does not treat "end" inside a string as a block closer', () => {
    // The "end" on the continuation line is string content, not a keyword.
    expect(formatLines([
      '# test',
      'if x:',
      "x = 'start",
      '  end of string',
      "  done'",
      'end',
      '---',
    ])).toBe([
      '# test',
      'if x:',
      "  x = 'start",
      '  end of string',   // verbatim — string content
      "  done'",           // verbatim — string content
      'end',               // correct block close at indent 0
      '---',
    ].join('\n'));
  });

  it('does not treat "end" inside a double-quoted string as a block closer', () => {
    expect(formatLines([
      '# test',
      'if x:',
      'x = "start',
      '  end of string',
      '  done"',
      'end',
      '---',
    ])).toBe([
      '# test',
      'if x:',
      '  x = "start',
      '  end of string',   // verbatim — string content
      '  done"',           // verbatim — string content
      'end',               // correct block close at indent 0
      '---',
    ].join('\n'));
  });

  it('resumes normal formatting after a multi-line string closes', () => {
    expect(formatLines([
      '# test',
      'if x:',
      "pl 'line one",
      "line two'",
      'x = 1',
      'end',
      '---',
    ])).toBe([
      '# test',
      'if x:',
      "  pl 'line one",
      "line two'",   // verbatim
      '  x = 1',     // back to normal formatting at indent 1
      'end',
      '---',
    ].join('\n'));
  });

  it('passes continuation lines of a brace block through verbatim', () => {
    expect(formatLines([
      '# test',
      'x = {',
      '  inner code',
      '  more code',
      '}',
      'y = 1',
      '---',
    ])).toBe([
      '# test',
      'x = {',
      '  inner code',   // verbatim — inside brace block
      '  more code',    // verbatim — inside brace block
      '}',              // verbatim — closes brace block
      'y = 1',
      '---',
    ].join('\n'));
  });

  it('does not let an apostrophe in a location header pollute subsequent lines', () => {
    // "# it's a room" has an unmatched apostrophe — header scanning must reset state.
    expect(formatLines([
      "# it's a room",
      'if x:',
      "pl 'hi'",
      'end',
      '---',
    ])).toBe("# it's a room\nif x:\n  pl 'hi'\nend\n---");
  });
});

// ──────────────────────────────────────────────────────────────────────
// inferIndentLevel
// ──────────────────────────────────────────────────────────────────────

describe('inferIndentLevel', () => {
  it.each([
    [['# test', 'x = 1', '---'], 1, 0],
    [['# test', 'if x > 0:', '  pl "hi"', 'end', '---'], 2, 1],
    [['# test', "act 'Go':", 'if x:', '  pl "a"', 'end', 'end', '---'], 3, 2],
    [['# test', 'if x:', 'pl "a"', 'end', 'z = 1'], 4, 0],
    [['end', 'end', 'x = 1'], 2, 0],                    // extra ends clamp to 0
    [['# test', 'if x:', '', '', 'pl "a"'], 4, 1],       // empty lines skipped
    [['# test', "act 'Go':", 'if x:', 'loop while y:', "pl 'deep'"], 4, 3],
    [['# test', 'if x:', "pl 'a'", 'else', "pl 'b'"], 4, 1],    // else branch is depth 1
    [['# test', 'if x:', "pl 'a'", 'else if y > 0:', "pl 'b'"], 4, 1], // else if (two words) is depth 1
    [['# test', "if x > 0: pl 'inline'", 'if y > 0:', "pl 'in block'"], 3, 1],
    [['# test', 'if a:', 'end', 'if b:', "pl 'in b'"], 4, 1],
    [['# test', 'if x:', "pl 'a'", 'elseif y:', "pl 'b'"], 4, 1], // elseif branch is depth 1
  ])('should return correct indent for lines %j at index %i → %i', (lines, idx, expected) => {
    expect(inferIndentLevel(lines as string[], idx as number)).toBe(expected);
  });

  it('should return 0 at line 0', () => {
    expect(inferIndentLevel(['# test', 'x = 1'], 0)).toBe(0);
  });

  it('should stop scanning at location header', () => {
    const lines = ['# loc1', 'if x:', 'pl "a"', 'end', '---', '# loc2', 'y = 1', '---'];
    expect(inferIndentLevel(lines, 6)).toBe(0);
  });

  it('should stop scanning at separator', () => {
    expect(inferIndentLevel(['# loc1', 'if x:', 'pl "a"', '---', 'y = 1'], 4)).toBe(0);
  });

  // ── String-awareness: keywords inside strings must not affect depth ──

  it('does not count "end" inside a multi-line string as a block closer', () => {
    // "end" appears on a continuation line of a string — should not decrement depth.
    const lines = [
      '# test',
      'if x:',
      "x = 'start",
      '  end of string',   // "end" is string content, not a closer
      "  done'",
      'pl x',              // ← startLine = 5; should be at depth 1 (inside if)
    ];
    expect(inferIndentLevel(lines, 5)).toBe(1);
  });

  it('does not count "if …:" inside a multi-line string as a block opener', () => {
    const lines = [
      '# test',
      "x = 'if y:",        // "if y:" is string content
      '  more string',
      "  end'",
      'pl x',              // ← startLine = 4; should be at depth 0
    ];
    expect(inferIndentLevel(lines, 4)).toBe(0);
  });

  it('counts real block openers correctly after a multi-line string closes', () => {
    const lines = [
      '# test',
      "x = 'if y:",        // string containing "if y:" — NOT an opener
      "  end'",
      'if z:',             // real opener
      'pl x',              // ← startLine = 4; should be at depth 1
    ];
    expect(inferIndentLevel(lines, 4)).toBe(1);
  });

  it('does not count keywords inside a brace block as depth changers', () => {
    // "if:" and "end" inside a brace block are not in code context and must not affect depth.
    const lines = [
      '# test',
      'x = {',
      '  if y:',   // inside brace — not a block opener
      '  end',     // inside brace — not a closer
      '}',
      'pl x',      // ← startLine = 5; should be at depth 0
    ];
    expect(inferIndentLevel(lines, 5)).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// parseActName
// ──────────────────────────────────────────────────────────────────────

describe('parseActName', () => {
  // ── Non-act lines (should return null) ───────────────────────────

  it.each([
    ['pl "hello"'],
    ['if x:'],
    [''],
    ["action 'test':"],  // "action" ≠ "act"
    ['act '],            // nothing after keyword
  ])('should return null for: %s', (line) => {
    expect(parseActName(line)).toBeNull();
  });

  // ── Simple quoted names ──────────────────────────────────────────

  it.each([
    ["act 'Go north':", { name: 'Go north', extraLines: 0 }],
    ['act "Go north":', { name: 'Go north', extraLines: 0 }],
    ["act 'Go north', 'img.png':", { name: 'Go north', extraLines: 0 }],
    ["act ('Go north'):", { name: 'Go north', extraLines: 0 }],
    ["act ('Go north', 'img.png'):", { name: 'Go north', extraLines: 0 }],
    ["act 'has:colon':", { name: 'has:colon', extraLines: 0 }],
    ["act 'a,b':", { name: 'a,b', extraLines: 0 }],
    ["ACT 'Test':", { name: 'Test', extraLines: 0 }],
    ["Act 'Test':", { name: 'Test', extraLines: 0 }],
  ])('should parse: %s', (input, expected) => {
    expect(parseActName(input)).toEqual(expected);
  });

  // ── Doubled-quote escapes ────────────────────────────────────────

  it("should unescape '' in single-quoted name", () => {
    expect(parseActName("act 'it''s a test':"))
      .toEqual({ name: "it's a test", extraLines: 0 });
  });

  it('should unescape "" in double-quoted name', () => {
    expect(parseActName('act "say ""hello""":'))
      .toEqual({ name: 'say "hello"', extraLines: 0 });
  });

  // ── Expression names ─────────────────────────────────────────────

  it.each([
    ['act $var:', { name: '$var', extraLines: 0 }],
    ["act 'test ' + $name:", { name: "'test ' + $name", extraLines: 0 }],
  ])('should parse expression name: %s', (input, expected) => {
    expect(parseActName(input)).toEqual(expected);
  });

  // ── Mid-edit (no terminator) ─────────────────────────────────────

  it.each([
    ["act 'Go north'", { name: 'Go north', extraLines: 0 }],
    ["act 'hello world", { name: 'hello world', extraLines: 0 }],
  ])('should return partial for mid-edit: %s', (input, expected) => {
    expect(parseActName(input)).toEqual(expected);
  });

  // ── Multiline support ────────────────────────────────────────────

  it.each([
    ["act 'line one\nline two':", { name: 'line one line two', extraLines: 1 }],
    ["act 'one\ntwo\nthree':", { name: 'one two three', extraLines: 2 }],
    ["act 'hello\nworld'\n:", { name: 'hello world', extraLines: 2 }],
    ["act 'it''s\na test':", { name: "it's a test", extraLines: 1 }],
    ["act ('line one\nline two'):", { name: 'line one line two', extraLines: 1 }],
    ["act 'line one\nline two', 'img':", { name: 'line one line two', extraLines: 1 }],
    ["act (\n'name'\n):", { name: 'name', extraLines: 2 }],
  ])('should parse multiline: %s', (input, expected) => {
    expect(parseActName(input)).toEqual(expected);
  });

  it('should return first-line partial for unclosed multiline quote', () => {
    expect(parseActName("act 'hello\nworld"))
      .toEqual({ name: 'hello', extraLines: 0 });
  });

  it('should stop expression scan at bare newline outside quotes', () => {
    expect(parseActName("act x + y\n:"))
      .toEqual({ name: 'x + y', extraLines: 0 });
  });

  it('should handle trailing text after the act header', () => {
    expect(parseActName("act 'name': pl 'hello'\nother stuff"))
      .toEqual({ name: 'name', extraLines: 0 });
  });

  // ── Parenthesized expression form (regression) ───────────────────
  // Bug: expression scan broke on the outer `)` without returning a
  // result, so the fall-through sliced up to the next newline and
  // returned a display name that still contained the `)`.

  it('should strip outer parens in parenthesized expression form', () => {
    expect(parseActName("act ('foo' + 'bar'):"))
      .toEqual({ name: "'foo' + 'bar'", extraLines: 0 });
  });

  it('should parse parenthesized expression with trailing comma arg', () => {
    expect(parseActName("act ('foo' + $name, 'img.png'):"))
      .toEqual({ name: "'foo' + $name", extraLines: 0 });
  });

  it('should parse parenthesized variable-only expression', () => {
    expect(parseActName("act ($name):"))
      .toEqual({ name: '$name', extraLines: 0 });
  });

  it('should handle nested parens inside an expression', () => {
    expect(parseActName("act (iif(x, 'a', 'b')):"))
      .toEqual({ name: "iif(x, 'a', 'b')", extraLines: 0 });
  });
});
