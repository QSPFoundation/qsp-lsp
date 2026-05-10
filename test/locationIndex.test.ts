/**
 * Tests for locationIndex — the lookup API over parseLocationBlocks.
 *
 * Edge-case parsing behaviour (CRLF, # inside location body, unclosed
 * locations, etc.) is tested in parseLocationBlocks.test.ts.
 * Here we focus on the LocationEntry field mapping and the lookup helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  buildLocationIndex,
  findLocationAtLine,
  findLocationByName,
  getLocationText,
} from '../src/common/locations';

// ──────────────────────────────────────────────────────────────────────
// buildLocationIndex — field mapping
// ──────────────────────────────────────────────────────────────────────

describe('buildLocationIndex', () => {
  it('should map all LocationEntry fields from parseLocationBlocks', () => {
    const text = 'preamble\n# Loc1\nx = 1\n--\n\n# Loc2\ny = 2\n--\n';
    const index = buildLocationIndex(text);

    expect(index).toHaveLength(2);

    // First location — verify all fields
    expect(index[0].name).toBe('Loc1');
    expect(index[0].nameLower).toBe('loc1');
    expect(index[0].startLine).toBe(1);
    expect(index[0].endLine).toBe(3);
    expect(text.slice(index[0].startOffset, index[0].endOffset)).toBe('# Loc1\nx = 1\n--');

    // Second location
    expect(index[1].name).toBe('Loc2');
    expect(index[1].nameLower).toBe('loc2');
    expect(index[1].startLine).toBe(5);
  });

  it('should return empty array for empty file', () => {
    expect(buildLocationIndex('')).toHaveLength(0);
  });

  it('should not split on --- inside single-quoted multi-line string', () => {
    const text = "# loc1\npl '\n---\nmore\n'\n--\n";
    const index = buildLocationIndex(text);
    expect(index).toHaveLength(1);
    expect(index[0].name).toBe('loc1');
    expect(index[0].endLine).toBe(5); // real -- at line 5
  });

  it('should not split on --- inside double-quoted multi-line string', () => {
    const text = '# loc1\npl "\n---\nmore\n"\n--\n';
    const index = buildLocationIndex(text);
    expect(index).toHaveLength(1);
    expect(index[0].name).toBe('loc1');
    expect(index[0].endLine).toBe(5);
  });

  it('should not split on --- inside curly-brace code block', () => {
    const text = '# loc1\nif x {\npl "hi"\n---\n}\n--\n';
    const index = buildLocationIndex(text);
    expect(index).toHaveLength(1);
    expect(index[0].name).toBe('loc1');
    expect(index[0].endLine).toBe(5);
  });

  it('should handle real-world pl with --- inside string', () => {
    const text = [
      '# shop',
      "pl '",
      '<<$tovarname>>',
      '---',
      '<<t_damg>> - damage',
      "'",
      '--',
    ].join('\n');
    const index = buildLocationIndex(text);
    expect(index).toHaveLength(1);
    expect(index[0].name).toBe('shop');
    expect(index[0].endLine).toBe(6);
  });
});

// ──────────────────────────────────────────────────────────────────────
// findLocationAtLine — binary search
// ──────────────────────────────────────────────────────────────────────

describe('findLocationAtLine', () => {
  const text = '# Loc1\nx = 1\n--\n\n# Loc2\ny = 2\n--\n';
  const index = buildLocationIndex(text);

  it('should find location containing the given line', () => {
    expect(findLocationAtLine(index, 0)?.name).toBe('Loc1');
    expect(findLocationAtLine(index, 1)?.name).toBe('Loc1');
    expect(findLocationAtLine(index, 5)?.name).toBe('Loc2');
  });

  it('should return undefined for inter-location lines', () => {
    expect(findLocationAtLine(index, 3)).toBeUndefined();
  });

  it('should return undefined for empty index', () => {
    expect(findLocationAtLine([], 0)).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// findLocationByName
// ──────────────────────────────────────────────────────────────────────

describe('findLocationByName', () => {
  const text = '# TestLoc\nx = 1\n--\n';
  const index = buildLocationIndex(text);

  it('should find location case-insensitively', () => {
    expect(findLocationByName(index, 'testloc')?.name).toBe('TestLoc');
    expect(findLocationByName(index, 'TESTLOC')?.name).toBe('TestLoc');
  });

  it('should return undefined for missing location', () => {
    expect(findLocationByName(index, 'nonexistent')).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// getLocationText
// ──────────────────────────────────────────────────────────────────────

describe('getLocationText', () => {
  it('should extract text for any location in the file', () => {
    const text = '# Loc1\nx = 1\n--\n# Loc2\ny = 2\n--\n';
    const index = buildLocationIndex(text);

    expect(getLocationText(text, index[0])).toBe('# Loc1\nx = 1\n--');
    expect(getLocationText(text, index[1])).toBe('# Loc2\ny = 2\n--');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Performance
// ──────────────────────────────────────────────────────────────────────

describe('performance — large file simulation', () => {
  it('should index 10k locations quickly', () => {
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      lines.push(`# Location_${i}`, `x_${i} = ${i}`, `pl 'Hello from location ${i}'`, '--', '');
    }
    const text = lines.join('\n');

    const start = performance.now();
    const index = buildLocationIndex(text);
    const elapsed = performance.now() - start;

    expect(index).toHaveLength(10_000);
    expect(elapsed).toBeLessThan(500);

    // Binary search should be instant
    const searchStart = performance.now();
    const loc = findLocationAtLine(index, 20_000);
    const searchElapsed = performance.now() - searchStart;

    expect(loc).toBeDefined();
    expect(searchElapsed).toBeLessThan(1);
  });
});
