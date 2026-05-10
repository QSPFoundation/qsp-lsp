/**
 * Tests for parseLocationBlocks — the client-side location block parser
 * used by sort, move, duplicate, delete, and rename commands.
 */
import { describe, it, expect } from 'vitest';
import { parseLocationBlocks } from '../src/common/locations';

describe('parseLocationBlocks', () => {
  it('should parse a single location', () => {
    const text = '# start\npl "hello"\n---';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe('start');
    expect(blocks[0].startLine).toBe(0);
    expect(blocks[0].endLine).toBe(2);
    expect(blocks[0].content).toBe('# start\npl "hello"\n---');
  });

  it('should parse multiple locations', () => {
    const text = '# loc1\nx = 1\n---\n# loc2\ny = 2\n---';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].name).toBe('loc1');
    expect(blocks[1].name).toBe('loc2');
  });

  it('should handle location names with spaces', () => {
    const text = '# My Location Name\nx = 1\n---';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe('My Location Name');
  });

  it('should handle inter-location text before first location', () => {
    const text = 'some text\n\n# loc1\nx = 1\n---';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe('loc1');
    expect(blocks[0].startLine).toBe(2);
  });

  it('should handle unclosed location at EOF', () => {
    const text = '# unclosed\nx = 1\ny = 2';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe('unclosed');
    expect(blocks[0].startLine).toBe(0);
    expect(blocks[0].endLine).toBe(2);
  });

  it('should handle -- (two dashes) as separator', () => {
    const text = '# loc1\nx = 1\n--';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].endLine).toBe(2);
  });

  it('should handle empty locations', () => {
    const text = '# empty\n---';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe('empty');
    expect(blocks[0].content).toBe('# empty\n---');
  });

  it('should handle -- with trailing text (note string)', () => {
    const text = '# loc1\nx = 1\n-- some note after end';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe('loc1');
    expect(blocks[0].endLine).toBe(2);
    expect(blocks[0].content).toBe('# loc1\nx = 1\n-- some note after end');
  });

  it('should handle --- with trailing text', () => {
    const text = '# loc1\nx = 1\n--- end of location';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].endLine).toBe(2);
    expect(blocks[0].content).toBe('# loc1\nx = 1\n--- end of location');
  });

  it('should handle long dash separator', () => {
    const text = '# loc1\nx = 1\n-----------';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].endLine).toBe(2);
  });

  it('should return empty array for empty text', () => {
    expect(parseLocationBlocks('')).toHaveLength(0);
  });

  it('should return empty array for text without locations', () => {
    expect(parseLocationBlocks('just some text\nwith no locations')).toHaveLength(0);
  });

  it('should handle consecutive locations without gaps', () => {
    const text = '# a\n---\n# b\n---\n# c\n---';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(3);
    expect(blocks[0].name).toBe('a');
    expect(blocks[1].name).toBe('b');
    expect(blocks[2].name).toBe('c');
  });

  it('should handle location followed by unclosed location', () => {
    const text = '# closed\nx = 1\n---\n# unclosed\ny = 2';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].name).toBe('closed');
    expect(blocks[0].endLine).toBe(2);
    expect(blocks[1].name).toBe('unclosed');
    expect(blocks[1].endLine).toBe(4);
  });

  it('should produce correct byte offsets', () => {
    const text = '# loc1\nx = 1\n---';
    const blocks = parseLocationBlocks(text);

    expect(blocks[0].start).toBe(0);
    expect(blocks[0].end).toBe(text.length);
    expect(text.slice(blocks[0].start, blocks[0].end)).toBe(text);
  });

  it('should produce correct byte offsets with inter-loc text', () => {
    const text = 'preamble\n# loc1\nx = 1\n---';
    const blocks = parseLocationBlocks(text);

    const extracted = text.slice(blocks[0].start, blocks[0].end);
    expect(extracted).toBe('# loc1\nx = 1\n---');
  });

  it('should produce correct byte offsets for second block', () => {
    const text = '# a\n---\n# b\n---';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(2);
    const a = text.slice(blocks[0].start, blocks[0].end);
    const b = text.slice(blocks[1].start, blocks[1].end);
    expect(a).toBe('# a\n---');
    expect(b).toBe('# b\n---');
  });

  it('should handle CRLF line endings', () => {
    const text = '# loc1\r\nx = 1\r\n---';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe('loc1');
  });

  it('should produce correct byte offsets with CRLF', () => {
    const text = 'preamble\r\n# loc1\r\nx = 1\r\n---';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    // Offsets are valid against the original (CRLF) text
    expect(text.slice(blocks[0].start, blocks[0].end)).toBe('# loc1\r\nx = 1\r\n---');
    expect(blocks[0].content).toBe('# loc1\r\nx = 1\r\n---');
  });

  it('should produce correct byte offsets for second block with CRLF', () => {
    const text = '# a\r\n---\r\n# b\r\n---';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(2);
    // Offsets are valid against the original (CRLF) text
    expect(text.slice(blocks[0].start, blocks[0].end)).toBe('# a\r\n---');
    expect(text.slice(blocks[1].start, blocks[1].end)).toBe('# b\r\n---');
    expect(blocks[0].content).toBe('# a\r\n---');
    expect(blocks[1].content).toBe('# b\r\n---');
  });

  it('should strip trailing whitespace from location name', () => {
    const text = '# name with trailing   \nx = 1\n---';
    const blocks = parseLocationBlocks(text);

    expect(blocks[0].name).toBe('name with trailing');
  });

  it('should handle location with many lines', () => {
    const lines = ['# big'];
    for (let i = 0; i < 100; i++) {
      lines.push(`x_${i} = ${i}`);
    }
    lines.push('---');
    const text = lines.join('\n');
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].startLine).toBe(0);
    expect(blocks[0].endLine).toBe(101);
  });

  it('should treat # inside a location as code, not a new header', () => {
    // # inside a location body is valid QSP code (e.g. #var array-count prefix).
    // The location runs until -- per the PEG grammar.
    const text = '# first\nx = 1\n# second\ny = 2\n---';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe('first');
    expect(blocks[0].endLine).toBe(4); // ends at --
  });

  it('should allow # type prefix at start of line inside a location', () => {
    const text = '# myLoc\n#var = 5\npl #arr\n---';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe('myLoc');
    expect(blocks[0].startLine).toBe(0);
    expect(blocks[0].endLine).toBe(3);
  });

  it('should start new location with # only after -- closes previous', () => {
    const text = '# first\nx = 1\n---\n# second\ny = 2\n---';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].name).toBe('first');
    expect(blocks[1].name).toBe('second');
  });

  it('should treat # with only whitespace as location with space name', () => {
    // The regex `^#\s*(.+?)\s*$` lazily captures one space as the name,
    // so `#   ` creates a location with name " " (single space).
    const text = '#   \nsome code\n---';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe(' ');
  });

  it('should not treat bare # with no name as location header', () => {
    // `#` alone
    const text = '#\nsome code\n---';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(0);
  });

  it('should not treat single dash as location separator', () => {
    // Only `--` or longer closes a location; single `-` is code
    const text = '# loc1\nx = 1\n-\ny = 2\n---';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe('loc1');
    expect(blocks[0].endLine).toBe(4); // ends at ---
  });

  // ── String-aware -- detection ────────────────────────────────────

  it('should not split on --- inside single-quoted multi-line string', () => {
    const text = "# loc1\npl '\n---\nmore text\n'\n---";
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe('loc1');
    expect(blocks[0].endLine).toBe(5); // real --- at line 5
  });

  it('should not split on --- inside double-quoted multi-line string', () => {
    const text = '# loc1\npl "\n---\nmore text\n"\n---';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe('loc1');
    expect(blocks[0].endLine).toBe(5);
  });

  it('should handle escaped quotes around --- correctly', () => {
    // '' is an escape inside single-quoted strings — string continues
    const text = "# loc1\npl 'line1''\n---\nline2'\n---";
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe('loc1');
    expect(blocks[0].endLine).toBe(4); // real ---
  });

  it('should not split on --- inside curly-brace code block', () => {
    const text = '# loc1\nif x > 0 {\npl "hi"\n---\n}\n---';
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe('loc1');
    expect(blocks[0].endLine).toBe(5);
  });

  it('should handle the real-world pl with --- inside string', () => {
    // The exact pattern from the bug report
    const text = [
      "# shop",
      "pl '",
      "<<$tovarname>>",
      "---",
      "<<t_damg>> - damage",
      "'",
      "---",
    ].join('\n');
    const blocks = parseLocationBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe('shop');
    expect(blocks[0].endLine).toBe(6); // real --- at the end
  });
});
