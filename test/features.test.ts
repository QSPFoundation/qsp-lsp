/**
 * Tests for the pure helper functions extracted from client features:
 * - computeLocationGaps — inter-location text gap computation
 * - buildSplitFileContent — single-file content assembly for split
 * - buildMergedContent — merged file content assembly
 * - buildMoveTargetContent — target file content for move
 * - reorderLocations — reorder blocks within a file preserving gaps
 * - removeSelectedLocations — source file content after deletion
 * - sanitizeLocationName — filename sanitization & dedup
 */
import { describe, it, expect } from 'vitest';
import {
  parseLocationBlocks,
  computeLocationGaps,
  buildSplitFileContent,
  buildMergedContent,
  buildMoveTargetContent,
  reorderLocations,
  removeSelectedLocations,
  sanitizeLocationName,
} from '../src/common/locations';

// ──────────────────────────────────────────────────────────────────────
// computeLocationGaps
// ──────────────────────────────────────────────────────────────────────

describe('computeLocationGaps', () => {
  it('should return empty arrays for no blocks', () => {
    const { gapsBefore, trailing } = computeLocationGaps('some text', []);
    expect(gapsBefore).toHaveLength(0);
    expect(trailing).toBe('');
  });

  it('should return empty gap for single location at file start', () => {
    const text = '# loc1\nx = 1\n---';
    const blocks = parseLocationBlocks(text);
    const { gapsBefore, trailing } = computeLocationGaps(text, blocks);

    expect(gapsBefore).toHaveLength(1);
    expect(gapsBefore[0]).toBe('');
    expect(trailing).toBe('');
  });

  it('should capture preamble text before first location', () => {
    const text = '! QSP file\n\n# loc1\nx = 1\n---';
    const blocks = parseLocationBlocks(text);
    const { gapsBefore } = computeLocationGaps(text, blocks);

    expect(gapsBefore).toHaveLength(1);
    expect(gapsBefore[0]).toBe('! QSP file\n\n');
  });

  it('should capture trailing text after last location', () => {
    const text = '# loc1\nx = 1\n---\n! end of file';
    const blocks = parseLocationBlocks(text);
    const { trailing } = computeLocationGaps(text, blocks);

    expect(trailing).toBe('! end of file');
  });

  it('should capture trailing text with leading newline stripped', () => {
    const text = '# loc1\nx = 1\n---\n\n! trailing comment\n';
    const blocks = parseLocationBlocks(text);
    const { trailing } = computeLocationGaps(text, blocks);

    // The first \n after --- is stripped; the rest is preserved
    expect(trailing).toBe('\n! trailing comment\n');
  });

  it('should return empty inter-location gap for consecutive blocks', () => {
    const text = '# a\n---\n# b\n---';
    const blocks = parseLocationBlocks(text);
    const { gapsBefore } = computeLocationGaps(text, blocks);

    expect(gapsBefore).toHaveLength(2);
    expect(gapsBefore[0]).toBe('');
    // Between first --- and second #, there's just \n which gets stripped
    expect(gapsBefore[1]).toBe('');
  });

  it('should capture inter-location comment text', () => {
    const text = '# a\n---\n! comment between\n# b\n---';
    const blocks = parseLocationBlocks(text);
    const { gapsBefore } = computeLocationGaps(text, blocks);

    expect(gapsBefore).toHaveLength(2);
    expect(gapsBefore[0]).toBe('');
    expect(gapsBefore[1]).toBe('! comment between\n');
  });

  it('should capture multi-line inter-location text', () => {
    const text = '# a\n---\n\n! group: chapter 2\n! author: x\n\n# b\n---';
    const blocks = parseLocationBlocks(text);
    const { gapsBefore } = computeLocationGaps(text, blocks);

    expect(gapsBefore[1]).toBe('\n! group: chapter 2\n! author: x\n\n');
  });

  it('should handle preamble + inter-location text + trailing', () => {
    const text = '! preamble\n# a\n---\n! mid\n# b\n---\n! end';
    const blocks = parseLocationBlocks(text);
    const { gapsBefore, trailing } = computeLocationGaps(text, blocks);

    expect(gapsBefore[0]).toBe('! preamble\n');
    expect(gapsBefore[1]).toBe('! mid\n');
    expect(trailing).toBe('! end');
  });

  it('should handle CRLF line endings', () => {
    const text = '! preamble\r\n# loc1\r\nx = 1\r\n---\r\n! end';
    const blocks = parseLocationBlocks(text);
    const { gapsBefore, trailing } = computeLocationGaps(text, blocks);

    expect(gapsBefore[0]).toBe('! preamble\r\n');
    expect(trailing).toBe('! end');
  });

  it('should strip leading \\r\\n from gaps (CRLF)', () => {
    const text = '# a\r\n---\r\n# b\r\n---';
    const blocks = parseLocationBlocks(text);
    const { gapsBefore } = computeLocationGaps(text, blocks);

    // \r\n after first --- gets stripped
    expect(gapsBefore[1]).toBe('');
  });

  it('should handle three locations with varying gaps', () => {
    const text = '# a\n---\n\n# b\n---\n! note\n# c\n---';
    const blocks = parseLocationBlocks(text);
    const { gapsBefore, trailing } = computeLocationGaps(text, blocks);

    expect(gapsBefore).toHaveLength(3);
    expect(gapsBefore[0]).toBe('');
    expect(gapsBefore[1]).toBe('\n');     // just a blank line
    expect(gapsBefore[2]).toBe('! note\n');
    expect(trailing).toBe('');
  });

  it('should handle whitespace-only gaps', () => {
    const text = '# a\n---\n   \n# b\n---';
    const blocks = parseLocationBlocks(text);
    const { gapsBefore } = computeLocationGaps(text, blocks);

    // Gap is "   \n" (the leading \n after --- stripped)
    expect(gapsBefore[1]).toBe('   \n');
    expect(gapsBefore[1].trim()).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildSplitFileContent
// ──────────────────────────────────────────────────────────────────────

describe('buildSplitFileContent', () => {
  it('should produce block content with trailing newline when no gap', () => {
    const result = buildSplitFileContent('# loc1\nx = 1\n---', '', null);
    expect(result).toBe('# loc1\nx = 1\n---\n');
  });

  it('should prepend non-whitespace gap before block', () => {
    const result = buildSplitFileContent('# loc1\nx = 1\n---', '! comment\n', null);
    expect(result).toBe('! comment\n# loc1\nx = 1\n---\n');
  });

  it('should strip trailing newline from gap to avoid double newline', () => {
    const result = buildSplitFileContent('# loc1\n---', '! note\n\n', null);
    // gap "! note\n\n" → strip trailing \n → "! note\n" + "\n" = "! note\n\n"
    // then block content, then final \n
    expect(result).toBe('! note\n\n# loc1\n---\n');
  });

  it('should skip whitespace-only gaps', () => {
    const result = buildSplitFileContent('# loc1\n---', '   \n', null);
    expect(result).toBe('# loc1\n---\n');
  });

  it('should append trailing text for last location', () => {
    const result = buildSplitFileContent('# loc1\n---', '', '! end of file');
    expect(result).toBe('# loc1\n---\n! end of file\n');
  });

  it('should strip trailing newline from trailing text', () => {
    const result = buildSplitFileContent('# loc1\n---', '', '! end\n');
    expect(result).toBe('# loc1\n---\n! end\n');
  });

  it('should skip whitespace-only trailing text', () => {
    const result = buildSplitFileContent('# loc1\n---', '', '   \n');
    expect(result).toBe('# loc1\n---\n');
  });

  it('should combine gap + block + trailing for last location', () => {
    const result = buildSplitFileContent(
      '# loc1\nx = 1\n---',
      '! header comment\n',
      '! footer\n',
    );
    expect(result).toBe('! header comment\n# loc1\nx = 1\n---\n! footer\n');
  });

  it('should handle null trailing (not the last location)', () => {
    const result = buildSplitFileContent('# loc1\n---', '! gap\n', null);
    expect(result).toBe('! gap\n# loc1\n---\n');
  });

  it('should handle empty string trailing (last location, no content after)', () => {
    const result = buildSplitFileContent('# loc1\n---', '', '');
    expect(result).toBe('# loc1\n---\n');
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildMergedContent
// ──────────────────────────────────────────────────────────────────────

describe('buildMergedContent', () => {
  it('should produce single location with trailing newline', () => {
    const result = buildMergedContent([
      { content: '# loc1\nx = 1\n---', gapBefore: '' },
    ]);
    expect(result).toBe('# loc1\nx = 1\n---\n');
  });

  it('should separate multiple locations with newlines', () => {
    const result = buildMergedContent([
      { content: '# a\n---', gapBefore: '' },
      { content: '# b\n---', gapBefore: '' },
    ]);
    expect(result).toBe('# a\n---\n# b\n---\n');
  });

  it('should preserve non-whitespace gap text', () => {
    const result = buildMergedContent([
      { content: '# a\n---', gapBefore: '' },
      { content: '# b\n---', gapBefore: '! section 2\n' },
    ]);
    expect(result).toBe('# a\n---\n! section 2\n# b\n---\n');
  });

  it('should skip whitespace-only gap text', () => {
    const result = buildMergedContent([
      { content: '# a\n---', gapBefore: '' },
      { content: '# b\n---', gapBefore: '   \n' },
    ]);
    expect(result).toBe('# a\n---\n# b\n---\n');
  });

  it('should strip trailing newline from gap to avoid double-newline', () => {
    const result = buildMergedContent([
      { content: '# a\n---', gapBefore: '' },
      { content: '# b\n---', gapBefore: '! note\n' },
    ]);
    // gap "! note\n" → strip trailing \n → "! note" + "\n"
    // then block content
    expect(result).toBe('# a\n---\n! note\n# b\n---\n');
  });

  it('should include preamble gap for first location', () => {
    const result = buildMergedContent([
      { content: '# a\n---', gapBefore: '! file header\n' },
    ]);
    expect(result).toBe('! file header\n# a\n---\n');
  });

  it('should handle three locations with mixed gaps', () => {
    const result = buildMergedContent([
      { content: '# a\n---', gapBefore: '' },
      { content: '# b\n---', gapBefore: '! chapter 2\n' },
      { content: '# c\n---', gapBefore: '' },
    ]);
    expect(result).toBe('# a\n---\n! chapter 2\n# b\n---\n# c\n---\n');
  });

  it('should handle empty items array', () => {
    const result = buildMergedContent([]);
    expect(result).toBe('\n');
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildMoveTargetContent
// ──────────────────────────────────────────────────────────────────────

describe('buildMoveTargetContent', () => {
  it('should create new file content from single block', () => {
    const result = buildMoveTargetContent(
      [{ content: '# loc1\nx = 1\n---', gapBefore: '' }], '',
    );
    expect(result).toBe('# loc1\nx = 1\n---\n');
  });

  it('should join multiple blocks with newline', () => {
    const result = buildMoveTargetContent(
      [{ content: '# a\n---', gapBefore: '' }, { content: '# b\n---', gapBefore: '' }],
      '',
    );
    expect(result).toBe('# a\n---\n# b\n---\n');
  });

  it('should append to existing content with double newline separator', () => {
    const result = buildMoveTargetContent(
      [{ content: '# new\nx = 1\n---', gapBefore: '' }],
      '# existing\ny = 2\n---',
    );
    expect(result).toBe('# existing\ny = 2\n---\n\n# new\nx = 1\n---\n');
  });

  it('should trim trailing whitespace from existing content', () => {
    const result = buildMoveTargetContent(
      [{ content: '# new\n---', gapBefore: '' }],
      '# existing\n---\n\n\n',
    );
    expect(result).toBe('# existing\n---\n\n# new\n---\n');
  });

  it('should handle existing content with trailing newline only', () => {
    const result = buildMoveTargetContent(
      [{ content: '# new\n---', gapBefore: '' }],
      '# existing\n---\n',
    );
    expect(result).toBe('# existing\n---\n\n# new\n---\n');
  });

  it('should handle empty block contents array', () => {
    const result = buildMoveTargetContent([], '');
    expect(result).toBe('\n');
  });

  it('should handle empty block contents with existing content', () => {
    const result = buildMoveTargetContent([], '# existing\n---');
    expect(result).toBe('# existing\n---\n\n\n');
  });

  it('should preserve inter-location gap text', () => {
    const result = buildMoveTargetContent(
      [
        { content: '# a\n---', gapBefore: '' },
        { content: '# b\n---', gapBefore: '! chapter 2\n' },
      ],
      '',
    );
    expect(result).toBe('# a\n---\n! chapter 2\n# b\n---\n');
  });

  it('should preserve gap text when appending to existing file', () => {
    const result = buildMoveTargetContent(
      [
        { content: '# new\n---', gapBefore: '! note\n' },
      ],
      '# existing\n---',
    );
    expect(result).toBe('# existing\n---\n\n! note\n# new\n---\n');
  });
});

// ──────────────────────────────────────────────────────────────────────
// sanitizeLocationName
// ──────────────────────────────────────────────────────────────────────

describe('sanitizeLocationName', () => {
  it('should return a simple name unchanged', () => {
    const used = new Set<string>();
    expect(sanitizeLocationName('start', used)).toBe('start');
    expect(used.has('start')).toBe(true);
  });

  it('should preserve spaces in names', () => {
    const used = new Set<string>();
    expect(sanitizeLocationName('My Location', used)).toBe('My Location');
  });

  it('should replace path-unsafe characters with underscore', () => {
    const used = new Set<string>();
    expect(sanitizeLocationName('a<b>c:d', used)).toBe('a_b_c_d');
  });

  it('should replace quotes and backslashes', () => {
    const used = new Set<string>();
    expect(sanitizeLocationName('a"b\\c', used)).toBe('a_b_c');
  });

  it('should replace pipe, question mark, and asterisk', () => {
    const used = new Set<string>();
    expect(sanitizeLocationName('a|b?c*d', used)).toBe('a_b_c_d');
  });

  it('should replace control characters', () => {
    const used = new Set<string>();
    expect(sanitizeLocationName('a\x00b\x1fc', used)).toBe('a_b_c');
  });

  it('should replace forward slash', () => {
    const used = new Set<string>();
    expect(sanitizeLocationName('a/b', used)).toBe('a_b');
  });

  it('should fall back to "unnamed" for empty-after-sanitize names', () => {
    const used = new Set<string>();
    expect(sanitizeLocationName('', used)).toBe('unnamed');
  });

  it('should fall back to "unnamed" for whitespace-only names', () => {
    const used = new Set<string>();
    expect(sanitizeLocationName('   ', used)).toBe('unnamed');
  });

  it('should deduplicate names case-insensitively', () => {
    const used = new Set<string>();
    expect(sanitizeLocationName('Loc', used)).toBe('Loc');
    expect(sanitizeLocationName('loc', used)).toBe('loc_2');
    expect(sanitizeLocationName('LOC', used)).toBe('LOC_3');
  });

  it('should track all used names', () => {
    const used = new Set<string>();
    sanitizeLocationName('a', used);
    sanitizeLocationName('b', used);
    sanitizeLocationName('c', used);
    expect(used.size).toBe(3);
    expect(used.has('a')).toBe(true);
    expect(used.has('b')).toBe(true);
    expect(used.has('c')).toBe(true);
  });

  it('should handle many duplicates', () => {
    const used = new Set<string>();
    expect(sanitizeLocationName('dup', used)).toBe('dup');
    expect(sanitizeLocationName('dup', used)).toBe('dup_2');
    expect(sanitizeLocationName('dup', used)).toBe('dup_3');
    expect(sanitizeLocationName('dup', used)).toBe('dup_4');
    expect(sanitizeLocationName('dup', used)).toBe('dup_5');
  });

  it('should not conflict sanitized name with already-used names', () => {
    const used = new Set<string>();
    sanitizeLocationName('test', used);
    // A name that sanitizes to "test" after replacement
    expect(sanitizeLocationName('te"st', used)).toBe('te_st');
  });

  it('should trim whitespace from sanitized names', () => {
    const used = new Set<string>();
    expect(sanitizeLocationName('  hello  ', used)).toBe('hello');
  });

  // ── Unicode support ───────────────────────────────────────────────

  it('should preserve Cyrillic names', () => {
    const used = new Set<string>();
    expect(sanitizeLocationName('Начало игры', used)).toBe('Начало игры');
  });

  it('should preserve Chinese names', () => {
    const used = new Set<string>();
    expect(sanitizeLocationName('开始位置', used)).toBe('开始位置');
  });

  it('should preserve Japanese names', () => {
    const used = new Set<string>();
    expect(sanitizeLocationName('はじめ', used)).toBe('はじめ');
  });

  it('should preserve Korean names', () => {
    const used = new Set<string>();
    expect(sanitizeLocationName('시작', used)).toBe('시작');
  });

  it('should preserve mixed Latin/Cyrillic names', () => {
    const used = new Set<string>();
    expect(sanitizeLocationName('Start - Начало', used)).toBe('Start - Начало');
  });

  it('should preserve emoji in names', () => {
    const used = new Set<string>();
    expect(sanitizeLocationName('🏠 Home', used)).toBe('🏠 Home');
  });

  it('should preserve accented characters', () => {
    const used = new Set<string>();
    expect(sanitizeLocationName('café résumé naïve', used)).toBe('café résumé naïve');
  });

  it('should only replace unsafe chars in Unicode names', () => {
    const used = new Set<string>();
    // Cyrillic name with an unsafe colon in it
    expect(sanitizeLocationName('Магазин: оружие', used)).toBe('Магазин_ оружие');
  });

  it('should deduplicate Unicode names case-insensitively', () => {
    const used = new Set<string>();
    expect(sanitizeLocationName('Начало', used)).toBe('Начало');
    expect(sanitizeLocationName('начало', used)).toBe('начало_2');
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end: parseLocationBlocks → computeGaps → buildSplit / buildMerge
// ──────────────────────────────────────────────────────────────────────

describe('end-to-end: split pipeline', () => {
  it('should split a simple two-location file', () => {
    const text = '# a\nx = 1\n---\n# b\ny = 2\n---';
    const blocks = parseLocationBlocks(text);
    const { gapsBefore, trailing } = computeLocationGaps(text, blocks);

    const fileA = buildSplitFileContent(blocks[0].content, gapsBefore[0], null);
    const fileB = buildSplitFileContent(blocks[1].content, gapsBefore[1], trailing);

    expect(fileA).toBe('# a\nx = 1\n---\n');
    expect(fileB).toBe('# b\ny = 2\n---\n');
  });

  it('should preserve preamble in first split file', () => {
    const text = '! game config\n\n# a\nx = 1\n---\n# b\ny = 2\n---';
    const blocks = parseLocationBlocks(text);
    const { gapsBefore, trailing } = computeLocationGaps(text, blocks);

    const fileA = buildSplitFileContent(blocks[0].content, gapsBefore[0], null);
    const fileB = buildSplitFileContent(blocks[1].content, gapsBefore[1], trailing);

    expect(fileA).toBe('! game config\n\n# a\nx = 1\n---\n');
    expect(fileB).toBe('# b\ny = 2\n---\n');
  });

  it('should preserve inter-location comments in correct files', () => {
    const text = '# a\n---\n! chapter 2\n# b\n---\n! chapter 3\n# c\n---';
    const blocks = parseLocationBlocks(text);
    const { gapsBefore, trailing } = computeLocationGaps(text, blocks);

    const fileA = buildSplitFileContent(blocks[0].content, gapsBefore[0], null);
    const fileB = buildSplitFileContent(blocks[1].content, gapsBefore[1], null);
    const fileC = buildSplitFileContent(blocks[2].content, gapsBefore[2], trailing);

    expect(fileA).toBe('# a\n---\n');
    expect(fileB).toBe('! chapter 2\n# b\n---\n');
    expect(fileC).toBe('! chapter 3\n# c\n---\n');
  });

  it('should preserve trailing content in last split file', () => {
    const text = '# a\n---\n# b\n---\n! end notes\n';
    const blocks = parseLocationBlocks(text);
    const { gapsBefore, trailing } = computeLocationGaps(text, blocks);

    const fileB = buildSplitFileContent(blocks[1].content, gapsBefore[1], trailing);

    expect(fileB).toBe('# b\n---\n! end notes\n');
  });

  it('should handle single location with preamble and trailing', () => {
    const text = '! header\n# only\nx = 1\n---\n! footer';
    const blocks = parseLocationBlocks(text);
    const { gapsBefore, trailing } = computeLocationGaps(text, blocks);

    const file = buildSplitFileContent(blocks[0].content, gapsBefore[0], trailing);
    expect(file).toBe('! header\n# only\nx = 1\n---\n! footer\n');
  });
});

describe('end-to-end: merge pipeline', () => {
  it('should merge locations from two files', () => {
    const text1 = '# a\nx = 1\n---';
    const text2 = '# b\ny = 2\n---';
    const blocks1 = parseLocationBlocks(text1);
    const blocks2 = parseLocationBlocks(text2);
    const gaps1 = computeLocationGaps(text1, blocks1);
    const gaps2 = computeLocationGaps(text2, blocks2);

    const merged = buildMergedContent([
      { content: blocks1[0].content, gapBefore: gaps1.gapsBefore[0] },
      { content: blocks2[0].content, gapBefore: gaps2.gapsBefore[0] },
    ]);

    expect(merged).toBe('# a\nx = 1\n---\n# b\ny = 2\n---\n');
  });

  it('should preserve inter-location comments in merge', () => {
    const text = '! header\n# a\n---\n! section\n# b\n---';
    const blocks = parseLocationBlocks(text);
    const { gapsBefore } = computeLocationGaps(text, blocks);

    const merged = buildMergedContent([
      { content: blocks[0].content, gapBefore: gapsBefore[0] },
      { content: blocks[1].content, gapBefore: gapsBefore[1] },
    ]);

    expect(merged).toBe('! header\n# a\n---\n! section\n# b\n---\n');
  });

  it('should merge subset of locations (skipping some)', () => {
    const text = '# a\n---\n# b\n---\n# c\n---';
    const blocks = parseLocationBlocks(text);
    const { gapsBefore } = computeLocationGaps(text, blocks);

    // Only merge a and c, skipping b
    const merged = buildMergedContent([
      { content: blocks[0].content, gapBefore: gapsBefore[0] },
      { content: blocks[2].content, gapBefore: gapsBefore[2] },
    ]);

    expect(merged).toBe('# a\n---\n# c\n---\n');
  });
});

describe('end-to-end: move pipeline', () => {
  it('should create target file from moved blocks', () => {
    const text = '# a\nx = 1\n---\n# b\ny = 2\n---';
    const blocks = parseLocationBlocks(text);
    const { gapsBefore } = computeLocationGaps(text, blocks);

    const target = buildMoveTargetContent(
      blocks.map((b, i) => ({ content: b.content, gapBefore: gapsBefore[i] })),
      '',
    );

    expect(target).toBe('# a\nx = 1\n---\n# b\ny = 2\n---\n');
  });

  it('should append to existing file', () => {
    const text = '# new\nx = 1\n---';
    const blocks = parseLocationBlocks(text);
    const { gapsBefore } = computeLocationGaps(text, blocks);

    const target = buildMoveTargetContent(
      [{ content: blocks[0].content, gapBefore: gapsBefore[0] }],
      '# existing\ny = 2\n---\n',
    );

    expect(target).toBe('# existing\ny = 2\n---\n\n# new\nx = 1\n---\n');
  });

  it('should preserve inter-location comments in move', () => {
    const text = '# a\n---\n! chapter 2\n# b\n---';
    const blocks = parseLocationBlocks(text);
    const { gapsBefore } = computeLocationGaps(text, blocks);

    const target = buildMoveTargetContent(
      blocks.map((b, i) => ({ content: b.content, gapBefore: gapsBefore[i] })),
      '',
    );

    expect(target).toBe('# a\n---\n! chapter 2\n# b\n---\n');
  });
});

// ──────────────────────────────────────────────────────────────────────
// removeSelectedLocations
// ──────────────────────────────────────────────────────────────────────

describe('removeSelectedLocations', () => {
  it('should return text unchanged when no blocks selected', () => {
    const text = '# a\n---\n# b\n---';
    expect(removeSelectedLocations(text, new Set())).toBe(text);
  });

  it('should remove a single block', () => {
    const text = '# a\n---\n# b\n---';
    expect(removeSelectedLocations(text, new Set([0]))).toBe('# b\n---');
  });

  it('should remove the last block', () => {
    const text = '# a\n---\n# b\n---';
    expect(removeSelectedLocations(text, new Set([1]))).toBe('# a\n---');
  });

  it('should remove all blocks', () => {
    const text = '# a\n---\n# b\n---';
    expect(removeSelectedLocations(text, new Set([0, 1]))).toBe('');
  });

  it('should remove preceding gap text with block', () => {
    const text = '# a\n---\n! chapter 2\n# b\n---';
    expect(removeSelectedLocations(text, new Set([1]))).toBe('# a\n---');
  });

  it('should keep gap text when its block stays', () => {
    const text = '# a\n---\n! chapter 2\n# b\n---';
    expect(removeSelectedLocations(text, new Set([0]))).toBe('! chapter 2\n# b\n---');
  });

  it('should remove preamble with first block', () => {
    const text = '! header\n# a\n---\n# b\n---';
    expect(removeSelectedLocations(text, new Set([0]))).toBe('# b\n---');
  });

  it('should keep preamble when first block stays', () => {
    const text = '! header\n# a\n---\n# b\n---';
    expect(removeSelectedLocations(text, new Set([1]))).toBe('! header\n# a\n---');
  });

  it('should remove trailing text with last block', () => {
    const text = '# a\n---\n# b\n---\n! footer';
    expect(removeSelectedLocations(text, new Set([1]))).toBe('# a\n---');
  });

  it('should keep trailing text when last block stays', () => {
    const text = '# a\n---\n# b\n---\n! footer';
    expect(removeSelectedLocations(text, new Set([0]))).toBe('# b\n---\n! footer');
  });

  it('should remove gap + block + trailing together', () => {
    const text = '# a\n---\n! note\n# b\n---\n! end';
    expect(removeSelectedLocations(text, new Set([1]))).toBe('# a\n---');
  });

  it('should handle preamble + gap + trailing all removed', () => {
    const text = '! header\n# a\n---\n! mid\n# b\n---\n! footer';
    expect(removeSelectedLocations(text, new Set([0, 1]))).toBe('');
  });

  it('should handle three blocks, remove middle', () => {
    const text = '# a\n---\n! ch2\n# b\n---\n! ch3\n# c\n---';
    expect(removeSelectedLocations(text, new Set([1]))).toBe('# a\n---\n! ch3\n# c\n---');
  });

  it('should handle three blocks, remove first and last', () => {
    const text = '# a\n---\n! ch2\n# b\n---\n! ch3\n# c\n---\n! end';
    expect(removeSelectedLocations(text, new Set([0, 2]))).toBe('! ch2\n# b\n---');
  });

  it('should not remove whitespace-only gaps', () => {
    const text = '# a\n---\n   \n# b\n---';
    expect(removeSelectedLocations(text, new Set([1]))).toBe('# a\n---\n   ');
  });

  it('should not remove whitespace-only trailing', () => {
    const text = '# a\n---\n  ';
    expect(removeSelectedLocations(text, new Set([0]))).toBe('  ');
  });

  it('should handle CRLF line endings', () => {
    const text = '# a\r\n---\r\n! note\r\n# b\r\n---';
    expect(removeSelectedLocations(text, new Set([1]))).toBe('# a\r\n---');
  });

  it('should handle out-of-range indices gracefully', () => {
    const text = '# a\n---';
    expect(removeSelectedLocations(text, new Set([5]))).toBe(text);
    expect(removeSelectedLocations(text, new Set([-1]))).toBe(text);
  });

  it('should return text unchanged when no blocks exist', () => {
    const text = 'just some text\nno locations here';
    expect(removeSelectedLocations(text, new Set([0]))).toBe(text);
  });
});

// ──────────────────────────────────────────────────────────────────────
// reorderLocations
// ──────────────────────────────────────────────────────────────────────

describe('reorderLocations', () => {
  it('should return text unchanged for identity permutation', () => {
    const text = '# a\nx = 1\n---\n# b\ny = 2\n---\n';
    expect(reorderLocations(text, [0, 1])).toBe(text);
  });

  it('should swap two blocks', () => {
    const text = '# a\n---\n# b\n---\n';
    expect(reorderLocations(text, [1, 0])).toBe('# b\n---\n# a\n---\n');
  });

  it('should preserve gap text with its block when swapping', () => {
    const text = '# a\n---\n! chapter 2\n# b\n---\n';
    const result = reorderLocations(text, [1, 0]);
    expect(result).toBe('! chapter 2\n# b\n---\n# a\n---\n');
  });

  it('should move preamble with its block', () => {
    const text = '! header\n# a\n---\n# b\n---\n';
    const result = reorderLocations(text, [1, 0]);
    expect(result).toBe('# b\n---\n! header\n# a\n---\n');
  });

  it('should move trailing with its block', () => {
    const text = '# a\n---\n# b\n---\n! footer';
    const result = reorderLocations(text, [1, 0]);
    expect(result).toBe('# b\n---\n! footer\n# a\n---\n');
  });

  it('should move both preamble and trailing with their blocks', () => {
    const text = '! header\n# a\n---\n# b\n---\n! footer';
    const result = reorderLocations(text, [1, 0]);
    expect(result).toBe('# b\n---\n! footer\n! header\n# a\n---\n');
  });

  it('should move gap with block in three-block reorder', () => {
    const text = '# a\n---\n! ch2\n# b\n---\n! ch3\n# c\n---\n';
    // Move c before b: [a, c, b]
    const result = reorderLocations(text, [0, 2, 1]);
    expect(result).toBe('# a\n---\n! ch3\n# c\n---\n! ch2\n# b\n---\n');
  });

  it('should return text unchanged for single block', () => {
    const text = '# only\n---\n';
    expect(reorderLocations(text, [0])).toBe(text);
  });

  it('should handle consecutive blocks with no gaps', () => {
    const text = '# a\n---\n# b\n---\n# c\n---\n';
    const result = reorderLocations(text, [2, 1, 0]);
    expect(result).toBe('# c\n---\n# b\n---\n# a\n---\n');
  });

  it('should preserve whitespace-only gaps as empty (not as content)', () => {
    const text = '# a\n---\n   \n# b\n---\n';
    // Whitespace-only gap is not "content", so it gets dropped
    const result = reorderLocations(text, [1, 0]);
    expect(result).toBe('# b\n---\n# a\n---\n');
  });

  it('should handle CRLF line endings', () => {
    const text = '# a\r\n---\r\n! note\r\n# b\r\n---\r\n';
    const result = reorderLocations(text, [1, 0]);
    expect(result).toBe('! note\r\n# b\r\n---\r\n# a\r\n---\r\n');
  });

  it('should preserve preamble and trailing on identity permutation', () => {
    const text = '! header\n# a\n---\n# b\n---\n! footer\n';
    expect(reorderLocations(text, [0, 1])).toBe(text);
  });

  it('should move trailing with last block in three-block reorder', () => {
    const text = '# a\n---\n# b\n---\n# c\n---\n! footer';
    // Reverse: c (with trailing) goes first
    const result = reorderLocations(text, [2, 1, 0]);
    expect(result).toBe('# c\n---\n! footer\n# b\n---\n# a\n---\n');
  });

  it('should handle preamble and gaps together when reordering', () => {
    const text = '! header\n# a\n---\n! ch2\n# b\n---\n# c\n---\n';
    // Move a (with preamble) to the end
    const result = reorderLocations(text, [1, 2, 0]);
    expect(result).toBe('! ch2\n# b\n---\n# c\n---\n! header\n# a\n---\n');
  });
});
