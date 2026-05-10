import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import { DocumentHighlightKind } from 'vscode-languageserver';
import { QspTreeSitterParser, extractSymbols, findBlockKeywordRanges } from '../src/parser/treeSitter';
import { findLabelHighlightsInLocation } from '../src/server/lspFeatures';
import { WASM_PATH } from './testHelpers';

describe('findBlockKeywordRanges', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('should highlight if/elseif/else/end keywords', () => {
    const tree = parser.parse('test://bk-if', `# test
if x > 0:
  pl 'a'
elseif x = 0:
  pl 'b'
else
  pl 'c'
end
---
`);
    // Cursor on 'if' (line 1, col 0)
    const ranges = findBlockKeywordRanges(tree!, 1, 0);
    expect(ranges).toHaveLength(4);
    expect(ranges[0]).toEqual({ startLine: 1, startCol: 0, endLine: 1, endCol: 2 });  // if
    expect(ranges[1]).toEqual({ startLine: 3, startCol: 0, endLine: 3, endCol: 6 });  // elseif
    expect(ranges[2]).toEqual({ startLine: 5, startCol: 0, endLine: 5, endCol: 4 });  // else
    expect(ranges[3]).toEqual({ startLine: 7, startCol: 0, endLine: 7, endCol: 3 });  // end
  });

  it('should highlight same keywords when cursor is on end', () => {
    const tree = parser.parse('test://bk-end', `# test
if x > 0:
  pl 'a'
elseif x = 0:
  pl 'b'
else
  pl 'c'
end
---
`);
    // Cursor on 'end' (line 7, col 1)
    const ranges = findBlockKeywordRanges(tree!, 7, 1);
    expect(ranges).toHaveLength(4);
    expect(ranges[0].startLine).toBe(1); // if
    expect(ranges[3].startLine).toBe(7); // end
  });

  it('should highlight same keywords when cursor is on elseif', () => {
    const tree = parser.parse('test://bk-elseif', `# test
if x > 0:
  pl 'a'
elseif x = 0:
  pl 'b'
end
---
`);
    // Cursor on 'elseif' (line 3, col 2)
    const ranges = findBlockKeywordRanges(tree!, 3, 2);
    expect(ranges).toHaveLength(3); // if, elseif, end
    expect(ranges[0].startLine).toBe(1); // if
    expect(ranges[1].startLine).toBe(3); // elseif
    expect(ranges[2].startLine).toBe(5); // end
  });

  it('should highlight act/end keywords', () => {
    const tree = parser.parse('test://bk-act', `# test
act 'Go':
  pl 'walking'
end
---
`);
    // Cursor on 'act' (line 1, col 1)
    const ranges = findBlockKeywordRanges(tree!, 1, 1);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toEqual({ startLine: 1, startCol: 0, endLine: 1, endCol: 3 }); // act
    expect(ranges[1]).toEqual({ startLine: 3, startCol: 0, endLine: 3, endCol: 3 }); // end
  });

  it('should highlight loop/end keywords', () => {
    const tree = parser.parse('test://bk-loop', `# test
loop while x < 10:
  x += 1
end
---
`);
    // Cursor on 'loop' (line 1, col 0)
    const ranges = findBlockKeywordRanges(tree!, 1, 0);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toEqual({ startLine: 1, startCol: 0, endLine: 1, endCol: 4 }); // loop
    expect(ranges[1]).toEqual({ startLine: 3, startCol: 0, endLine: 3, endCol: 3 }); // end
  });

  it('should highlight correct block for nested structures', () => {
    const tree = parser.parse('test://bk-nested', `# test
if x:
  act 'Go':
    pl 'a'
  end
end
---
`);
    // Cursor on inner 'end' (line 4, col 2) — belongs to act_block
    const ranges = findBlockKeywordRanges(tree!, 4, 2);
    expect(ranges).toHaveLength(2);
    expect(ranges[0].startLine).toBe(2); // act
    expect(ranges[1].startLine).toBe(4); // end (inner)
  });

  it('should highlight outer block when cursor is on outer end', () => {
    const tree = parser.parse('test://bk-outer', `# test
if x:
  act 'Go':
    pl 'a'
  end
end
---
`);
    // Cursor on outer 'end' (line 5, col 0) — belongs to if_block
    const ranges = findBlockKeywordRanges(tree!, 5, 0);
    expect(ranges).toHaveLength(2);
    expect(ranges[0].startLine).toBe(1); // if
    expect(ranges[1].startLine).toBe(5); // end (outer)
  });

  it('should return empty array when cursor is not on a keyword', () => {
    const tree = parser.parse('test://bk-nocursor', `# test
if x:
  pl 'hello'
end
---
`);
    // Cursor on 'pl' (line 2, col 2) — not a block keyword
    const ranges = findBlockKeywordRanges(tree!, 2, 2);
    expect(ranges).toHaveLength(0);
  });

  it('should return empty array for non-block keywords', () => {
    const tree = parser.parse('test://bk-nonblock', `# test
x = 1
---
`);
    const ranges = findBlockKeywordRanges(tree!, 1, 0);
    expect(ranges).toHaveLength(0);
  });

  it('should handle if/else without elseif', () => {
    const tree = parser.parse('test://bk-ifelse', `# test
if x:
  pl 'a'
else
  pl 'b'
end
---
`);
    // Cursor on 'else' (line 3, col 0)
    const ranges = findBlockKeywordRanges(tree!, 3, 0);
    expect(ranges).toHaveLength(3); // if, else, end
    expect(ranges[0].startLine).toBe(1); // if
    expect(ranges[1].startLine).toBe(3); // else
    expect(ranges[2].startLine).toBe(5); // end
  });

  it('should handle simple if/end without else', () => {
    const tree = parser.parse('test://bk-simple-if', `# test
if x:
  pl 'a'
end
---
`);
    const ranges = findBlockKeywordRanges(tree!, 1, 0);
    expect(ranges).toHaveLength(2); // if, end
  });

  it('should handle multiple elseif clauses', () => {
    const tree = parser.parse('test://bk-multi-elseif', `# test
if x = 1:
  pl 'a'
elseif x = 2:
  pl 'b'
elseif x = 3:
  pl 'c'
end
---
`);
    const ranges = findBlockKeywordRanges(tree!, 7, 0); // cursor on end
    expect(ranges).toHaveLength(4); // if, elseif, elseif, end
    expect(ranges[0].startLine).toBe(1); // if
    expect(ranges[1].startLine).toBe(3); // elseif 1
    expect(ranges[2].startLine).toBe(5); // elseif 2
    expect(ranges[3].startLine).toBe(7); // end
  });
});

describe('findLabelHighlightsInLocation (jump / label document highlight)', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  /** Resolve the location's symbol table, then call the real LSP helper. */
  function getHighlights(code: string, uri: string, locationName: string, line: number, col: number) {
    const tree = parser.parse(uri, code)!;
    const { symbols } = extractSymbols(tree, uri);
    const loc = symbols.getLocation(locationName);
    if (!loc) throw new Error(`Location '${locationName}' not found`);
    return findLabelHighlightsInLocation(loc, line, col);
  }

  it('cursor on label definition highlights def + all jumps', () => {
    const hl = getHighlights(`# main
:loop
pl 'tick'
jump 'loop'
jump 'loop'
---
`, 'test://hl-label', 'main', 1, 1);
    expect(hl).not.toBeNull();
    expect(hl).toHaveLength(3); // 1 def + 2 jumps
    expect(hl!.filter(h => h.kind === DocumentHighlightKind.Text)).toHaveLength(1);
    expect(hl!.filter(h => h.kind === DocumentHighlightKind.Write)).toHaveLength(2);
  });

  it('cursor on jump highlights def + all jumps', () => {
    const hl = getHighlights(`# main
:target
pl 'a'
jump 'target'
---
`, 'test://hl-jump', 'main', 3, 6);
    expect(hl).not.toBeNull();
    expect(hl).toHaveLength(2); // 1 def + 1 jump
  });

  it('cursor outside label/jump returns null', () => {
    const hl = getHighlights(`# main
:loop
pl 'tick'
jump 'loop'
---
`, 'test://hl-miss', 'main', 2, 0);
    expect(hl).toBeNull();
  });

  it('case-insensitive matching', () => {
    const hl = getHighlights(`# main
:MyLabel
jump 'MYLABEL'
jump 'mylabel'
---
`, 'test://hl-case', 'main', 1, 1);
    expect(hl).not.toBeNull();
    expect(hl).toHaveLength(3);
  });

  it('label without jumps highlights only the def', () => {
    const hl = getHighlights(`# main
:orphan
pl 'hello'
---
`, 'test://hl-noref', 'main', 1, 1);
    expect(hl).not.toBeNull();
    expect(hl).toHaveLength(1);
    expect(hl![0].kind).toBe(DocumentHighlightKind.Text);
  });

  it('jump without matching label highlights only the ref', () => {
    const hl = getHighlights(`# main
jump 'nowhere'
---
`, 'test://hl-nodef', 'main', 1, 6);
    expect(hl).not.toBeNull();
    expect(hl).toHaveLength(1);
    expect(hl![0].kind).toBe(DocumentHighlightKind.Write);
  });

  it('different labels in same location are independent', () => {
    const code = `# main
:alpha
jump 'alpha'
:beta
jump 'beta'
---
`;
    const hlAlpha = getHighlights(code, 'test://hl-multi', 'main', 1, 1);
    expect(hlAlpha).toHaveLength(2); // :alpha + jump 'alpha'
    expect(hlAlpha!.every(h => h.range.start.line === 1 || h.range.start.line === 2)).toBe(true);

    const hlBeta = getHighlights(code, 'test://hl-multi', 'main', 3, 1);
    expect(hlBeta).toHaveLength(2); // :beta + jump 'beta'
    expect(hlBeta!.every(h => h.range.start.line === 3 || h.range.start.line === 4)).toBe(true);
  });

  it('returns ranges that span the full label/jump identifier', () => {
    const hl = getHighlights(`# main
:mylabel
jump 'mylabel'
---
`, 'test://hl-range', 'main', 1, 1);
    expect(hl).not.toBeNull();
    const defRange = hl!.find(h => h.kind === DocumentHighlightKind.Text)!.range;
    expect(defRange.end.character - defRange.start.character).toBeGreaterThan(0);
  });

  it('returns null when no labels exist at all', () => {
    const hl = getHighlights(`# main
x = 1
---
`, 'test://hl-none', 'main', 1, 0);
    expect(hl).toBeNull();
  });
});

