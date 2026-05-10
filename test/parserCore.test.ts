import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import { QspTreeSitterParser, extractErrors } from '../src/parser/treeSitter';
import { WASM_PATH } from './testHelpers';

describe('QspTreeSitterParser', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('should parse a simple location', () => {
    const tree = parser.parse('test://doc', `# start
pl 'hello'
---
`);
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe('source_file');
    expect(tree!.rootNode.hasError).toBe(false);

    const locBlock = tree!.rootNode.namedChildren.find(c => c.type === 'location_block');
    expect(locBlock).toBeDefined();
  });

  it('should report no errors for valid code', () => {
    const tree = parser.parse('test://valid', `# test
x = 1
if x > 0: pl 'positive'
---
`);
    expect(tree).not.toBeNull();
    const errors = extractErrors(tree!);
    expect(errors).toHaveLength(0);
  });

  it('should report errors for invalid syntax', () => {
    const tree = parser.parse('test://invalid', `# test
if
---
`);
    expect(tree).not.toBeNull();
    const errors = extractErrors(tree!);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should re-parse the same URI with new content', () => {
    const uri = 'test://reparse';
    const tree1 = parser.parse(uri, `# loc1
x = 1
---
`);
    expect(tree1).not.toBeNull();

    // Parse again with modified content (full re-parse, no stale tree)
    const tree2 = parser.parse(uri, `# loc1
x = 2
y = 3
---
`);
    expect(tree2).not.toBeNull();
    expect(tree2!.rootNode.hasError).toBe(false);
  });
});

describe('incremental parsing & cache management', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('should use incremental parsing on second parse with changed text', () => {
    const uri = 'test://incr-changed';
    parser.parse(uri, `# test\nx = 1\n---\n`);
    parser.parse(uri, `# test\nx = 2\n---\n`);
    expect(parser.wasLastParseIncremental).toBe(true);
  });

  it('should not use incremental parsing on first parse', () => {
    parser.parse('test://incr-first', `# test\nx = 1\n---\n`);
    expect(parser.wasLastParseIncremental).toBe(false);
  });

  it('should return same tree reference for identical text', () => {
    const uri = 'test://incr-same';
    const text = `# test\nx = 1\n---\n`;
    const tree1 = parser.parse(uri, text);
    const tree2 = parser.parse(uri, text);
    expect(tree2).toBe(tree1);
    expect(parser.wasLastParseIncremental).toBe(false);
  });

  it('getTree should return cached tree after parse', () => {
    const uri = 'test://incr-get';
    const tree = parser.parse(uri, `# test\nx = 1\n---\n`);
    expect(parser.getTree(uri)).toBe(tree);
  });

  it('getTree should return null for unknown URI', () => {
    expect(parser.getTree('test://incr-unknown')).toBeNull();
  });

  it('removeTree should clear the cache', () => {
    const uri = 'test://incr-remove';
    parser.parse(uri, `# test\nx = 1\n---\n`);
    parser.removeTree(uri);
    expect(parser.getTree(uri)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Incremental symbol reuse
// ──────────────────────────────────────────────────────────────────────

describe('QspTreeSitterParser — dispose', () => {
  it('should clean up all resources on dispose', async () => {
    const p = new QspTreeSitterParser();
    await p.init(async () => fs.readFileSync(WASM_PATH));

    p.parse('test://disp-1', `# loc1\nx = 1\n---\n`);
    p.parse('test://disp-2', `# loc2\ny = 2\n---\n`);

    expect(p.getTree('test://disp-1')).not.toBeNull();
    expect(p.getTree('test://disp-2')).not.toBeNull();

    p.dispose();

    expect(p.getTree('test://disp-1')).toBeNull();
    expect(p.getTree('test://disp-2')).toBeNull();
    expect(p.isReady).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Block keyword highlighting
// ──────────────────────────────────────────────────────────────────────

