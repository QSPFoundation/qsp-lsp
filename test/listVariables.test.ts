/**
 * Tests for `collectProjectVariables` — the filter used by the
 * `qsp/listVariables` LSP custom request.
 *
 * Invariants (treated as the spec; the implementation must satisfy them):
 *   1. Built-in variables (args, result, …) are excluded.
 *   2. A variable whose base name is ONLY ever declared `local` anywhere in
 *      the scanned files is excluded — it can't be used as a global.
 *   3. A base name used as both local (in some locations) and global (in
 *      others) keeps ALL its entries, since the same name is also globally
 *      accessible.
 *   4. Each unique variable key appears at most once in the output.
 *   5. Results are sorted alphabetically, case-insensitive.
 *
 * Tests call the real exported function — no mirroring of implementation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import { QspTreeSitterParser, extractSymbols } from '../src/parser/treeSitter';
import type { DocumentSymbols } from '../src/parser/symbolTable';
import { collectProjectVariables } from '../src/server/lspFeatures';
import { WASM_PATH } from './testHelpers';

describe('collectProjectVariables', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  function parse(code: string, uri = 'test://t'): DocumentSymbols {
    const tree = parser.parse(uri, code)!;
    return extractSymbols(tree, uri).symbols;
  }

  function names(items: ReturnType<typeof collectProjectVariables>): string[] {
    return items.map(e => e.name.toLowerCase());
  }

  // ── (2) purely local → excluded ──────────────────────────────────

  it('excludes a variable that is only ever declared local', () => {
    const syms = parse(`# loc
local i = 0
i + 1
---
`);
    expect(names(collectProjectVariables([syms]))).not.toContain('i');
  });

  it('excludes multiple purely-local variables in the same location', () => {
    const syms = parse(`# loc
local i = 1
local j = 2
---
`);
    const result = names(collectProjectVariables([syms]));
    expect(result).not.toContain('i');
    expect(result).not.toContain('j');
  });

  it('excludes purely-local variables even across multiple files', () => {
    const f1 = parse(`# a\nlocal i = 0\ni + 1\n---\n`, 'test://f1');
    const f2 = parse(`# b\nlocal i = 0\ni + 1\n---\n`, 'test://f2');
    expect(names(collectProjectVariables([f1, f2]))).not.toContain('i');
  });

  // ── globals → included ───────────────────────────────────────────

  it('includes a plain global variable', () => {
    const syms = parse(`# loc
score = 42
pl score
---
`);
    expect(names(collectProjectVariables([syms]))).toContain('score');
  });

  it('includes a global that is only read (never assigned)', () => {
    const syms = parse(`# setup
score = 0
---
# show
pl score
---
`);
    expect(names(collectProjectVariables([syms]))).toContain('score');
  });

  // ── (3) mixed local + global → included, order-independent ──────

  it('includes a name declared local in one file but global in another (local seen first)', () => {
    const f1 = parse(`# a\nlocal tmp = 1\n---\n`, 'test://a');
    const f2 = parse(`# b\ntmp = 99\n---\n`, 'test://b');
    expect(names(collectProjectVariables([f1, f2]))).toContain('tmp');
  });

  it('includes a name declared global in one file but local in another (global seen first)', () => {
    const f1 = parse(`# a\ntmp = 99\n---\n`, 'test://a');
    const f2 = parse(`# b\nlocal tmp = 1\n---\n`, 'test://b');
    expect(names(collectProjectVariables([f1, f2]))).toContain('tmp');
  });

  it('keeps BOTH the local and global entries when the name is mixed across locations', () => {
    const syms = parse(`# a
local x = 1
---
# b
x = 2
---
`);
    const result = collectProjectVariables([syms]);
    const xs = result.filter(e => e.name.toLowerCase() === 'x');
    // One entry is local (from loc a), the other global (from loc b)
    expect(xs).toHaveLength(2);
    expect(xs.some(e => e.isLocal)).toBe(true);
    expect(xs.some(e => !e.isLocal)).toBe(true);
  });

  // ── (1) built-ins excluded ───────────────────────────────────────

  it('excludes built-in variables (args, result, …)', () => {
    const syms = parse(`# loc
pl $args[0]
result = 1
---
`);
    const result = names(collectProjectVariables([syms]));
    expect(result).not.toContain('args');
    expect(result).not.toContain('result');
  });

  // ── multi-file aggregation ───────────────────────────────────────

  it('collects global variables from multiple files', () => {
    const f1 = parse(`# init\ngold = 0\n---\n`, 'test://f1');
    const f2 = parse(`# shop\npl gold\n---\n`, 'test://f2');
    expect(names(collectProjectVariables([f1, f2]))).toContain('gold');
  });

  // ── (4) dedup ────────────────────────────────────────────────────

  it('deduplicates a global variable that appears in multiple locations', () => {
    const syms = parse(`# a
score = 0
---
# b
score = score + 1
---
`);
    const result = names(collectProjectVariables([syms]));
    expect(result.filter(n => n === 'score')).toHaveLength(1);
  });

  // ── metadata ─────────────────────────────────────────────────────

  it('reports isDefined=true and isLocal=false for a global assignment', () => {
    const syms = parse(`# loc\nscore = 1\n---\n`);
    const entry = collectProjectVariables([syms]).find(e => e.name.toLowerCase() === 'score');
    expect(entry).toBeDefined();
    expect(entry!.isDefined).toBe(true);
    expect(entry!.isLocal).toBe(false);
  });

  it('captures the prefix set of a variable', () => {
    const syms = parse(`# loc
$name = 'x'
pl $name
---
`);
    const entry = collectProjectVariables([syms]).find(e => e.name.toLowerCase() === 'name');
    expect(entry).toBeDefined();
    expect(entry!.prefixes).toContain('$');
  });

  it('points each entry at a real location (uri + line)', () => {
    const syms = parse(`# loc\n\nscore = 1\n---\n`, 'test://file.qsps');
    const entry = collectProjectVariables([syms]).find(e => e.name.toLowerCase() === 'score');
    expect(entry!.uri).toBe('test://file.qsps');
    expect(entry!.line).toBe(2); // 0-indexed, blank line above
  });

  // ── (5) sort order ───────────────────────────────────────────────

  it('returns variables sorted alphabetically (case-insensitive)', () => {
    const syms = parse(`# loc\nzap = 1\nalpha = 2\nMid = 3\n---\n`);
    const result = names(collectProjectVariables([syms]));
    expect(result).toEqual(
      [...result].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    );
  });

  // ── empty ────────────────────────────────────────────────────────

  it('returns an empty list when there are no files', () => {
    expect(collectProjectVariables([])).toEqual([]);
  });

  it('returns an empty list when files contain no global-capable variables', () => {
    const syms = parse(`# loc\nlocal only = 1\nonly + 1\n---\n`);
    // 'only' is purely local → excluded; builtins excluded → empty result
    expect(collectProjectVariables([syms])).toEqual([]);
  });
});
