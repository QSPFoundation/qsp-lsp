/**
 * Unit tests for buildPropagatedLocals — transitive local-variable
 * propagation across the call graph.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import { QspTreeSitterParser, extractSymbols } from '../src/parser/treeSitter';
import type { LocationSymbols } from '../src/parser/symbolTable';
import {
  buildPropagatedLocals,
  collectAggregates,
  emptyAggregates,
  type SymbolAggregates,
} from '../src/server/aggregation';
import { WASM_PATH } from './testHelpers';

describe('buildPropagatedLocals', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  function build(code: string): SymbolAggregates {
    const tree = parser.parse('test://agg', code)!;
    const { symbols } = extractSymbols(tree, 'test://agg');
    const agg = emptyAggregates();
    collectAggregates(symbols.locations.values(), agg);
    const allLocs: { locName: string; locSyms: LocationSymbols; uri: string }[] = [];
    for (const [, ls] of symbols.locations) {
      allLocs.push({ locName: ls.locationName, locSyms: ls, uri: 'test://agg' });
    }
    buildPropagatedLocals(allLocs, agg, [symbols]);
    return agg;
  }

  /** Provider location names for `varName` at `targetLoc` (lowercase). */
  function providersOf(agg: SymbolAggregates, targetLoc: string, varName: string): string[] {
    const ps = agg.propagatedLocals.get(targetLoc)?.get(varName) ?? [];
    return ps.map(p => p.providerLoc).sort();
  }

  it('propagates a local through a direct call', () => {
    const agg = build(`# a
local x = 1
gs 'b'
---
# b
pl x
---
`);
    expect(providersOf(agg, 'b', 'x')).toEqual(['a']);
  });

  it('propagates a local transitively through a non-reading pass-through', () => {
    const agg = build(`# a
local x = 1
gs 'b'
---
# b
gs 'c'
---
# c
pl x
---
`);
    expect(providersOf(agg, 'c', 'x')).toEqual(['a']);
  });

  it('stops propagation when the target defines the variable', () => {
    const agg = build(`# a
local x = 1
gs 'b'
---
# b
local x = 2
gs 'c'
---
# c
pl x
---
`);
    // C reads its own x from B's local, not from A's.
    expect(providersOf(agg, 'c', 'x')).toEqual(['b']);
  });

  // Regression test for the bug fixed in aggregation.ts: when multiple
  // callers provide the same variable and a reading target is only
  // discovered after a first caller's traversal already marked the
  // intermediate (non-reading) pass-through node as visited, the second
  // caller's provider must still reach the reading descendant.
  it('merges providers from multiple callers through a shared pass-through', () => {
    const agg = build(`# a
local x = 1
gs 'b'
---
# d
local x = 2
gs 'b'
---
# b
gs 'c'
---
# c
pl x
---
`);
    expect(providersOf(agg, 'c', 'x')).toEqual(['a', 'd']);
  });

  it('merges providers from multiple direct callers at a reading target', () => {
    const agg = build(`# a
local x = 1
gs 'c'
---
# d
local x = 2
gs 'c'
---
# c
pl x
---
`);
    expect(providersOf(agg, 'c', 'x')).toEqual(['a', 'd']);
  });

  it('handles a call cycle without infinite recursion', () => {
    const agg = build(`# a
local x = 1
gs 'b'
---
# b
gs 'c'
pl x
---
# c
gs 'b'
pl x
---
`);
    expect(providersOf(agg, 'b', 'x')).toEqual(['a']);
    expect(providersOf(agg, 'c', 'x')).toEqual(['a']);
  });

  it('does not propagate across non-locals-propagating calls', () => {
    // `goto` does not carry locals — only gs/func/@/@@ do.
    const agg = build(`# a
local x = 1
goto 'b'
---
# b
pl x
---
`);
    expect(providersOf(agg, 'b', 'x')).toEqual([]);
  });

  it.each([
    ['goto',  "goto 'b'"],
    ['gt',    "gt 'b'"],
    ['xgoto', "xgoto 'b'"],
    ['xgt',   "xgt 'b'"],
  ])('stops propagation for %s', (_name, callLine) => {
    const agg = build(`# a
local x = 1
${callLine}
---
# b
pl x
---
`);
    expect(providersOf(agg, 'b', 'x')).toEqual([]);
  });

  it('propagates via gs but a subsequent goto does not forward', () => {
    // a → gs b → goto c : x reaches b (as propagated) but NOT c.
    const agg = build(`# a
local x = 1
gs 'b'
---
# b
goto 'c'
pl x
---
# c
pl x
---
`);
    expect(providersOf(agg, 'b', 'x')).toEqual(['a']);
    expect(providersOf(agg, 'c', 'x')).toEqual([]);
  });

  // ── Write-in-callee propagation ────────────────────────────────
  // A write to an undeclared variable in a callee is not a new global
  // definition; it aliases the caller's propagated local. All four of
  // these scenarios must keep propagation intact so hover/go-to-def/
  // find-refs/rename treat the write as a reference to the caller's
  // local.

  it('keeps propagation when the callee writes (not declares) the variable', () => {
    const agg = build(`# a
local x = 1
gs 'b'
pl x
---
# b
x = 2
---
`);
    expect(providersOf(agg, 'b', 'x')).toEqual(['a']);
  });

  it('propagates through a callee that only writes the variable', () => {
    const agg = build(`# a
local x = 1
gs 'b'
---
# b
x = 2
gs 'c'
---
# c
pl x
---
`);
    // B is a pass-through that writes but does not declare, so A's
    // local reaches C.
    expect(providersOf(agg, 'b', 'x')).toEqual(['a']);
    expect(providersOf(agg, 'c', 'x')).toEqual(['a']);
  });

  it('stops propagation when the callee declares LOCAL even before writing', () => {
    const agg = build(`# a
local x = 1
gs 'b'
---
# b
local x
x = 2
gs 'c'
---
# c
pl x
---
`);
    // B shadows with its own local; A must not reach C.
    expect(providersOf(agg, 'c', 'x')).toEqual(['b']);
  });

  it('handles write-then-read in the same callee', () => {
    const agg = build(`# a
local x = 1
gs 'b'
---
# b
x = x + 1
pl x
---
`);
    expect(providersOf(agg, 'b', 'x')).toEqual(['a']);
  });

  it('does not propagate the built-in "args" variable', () => {
    // ARGS is a QSP built-in that holds the callee's argument array.
    // A caller that happens to have `local args = …` must not cause
    // the callee to show ARGS as a propagated-local provider.
    const agg = build(`# a
local args = 1
gs 'b'
---
# b
pl args
---
`);
    expect(providersOf(agg, 'b', 'args')).toEqual([]);
  });

  it('does not propagate the built-in "result" variable', () => {
    // RESULT is the QSP built-in return-value variable.
    const agg = build(`# a
local result = 1
gs 'b'
---
# b
pl result
---
`);
    expect(providersOf(agg, 'b', 'result')).toEqual([]);
  });
});

describe('externalLocalBindings (call-graph-sensitive dataflow, fix #6)', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  function build(code: string) {
    const tree = parser.parse('test://agg', code)!;
    const { symbols } = extractSymbols(tree, 'test://agg');
    const agg = emptyAggregates();
    collectAggregates(symbols.locations.values(), agg);
    const allLocs: { locName: string; locSyms: LocationSymbols; uri: string }[] = [];
    for (const [, ls] of symbols.locations) {
      allLocs.push({ locName: ls.locationName, locSyms: ls, uri: 'test://agg' });
    }
    buildPropagatedLocals(allLocs, agg, [symbols]);
    return { symbols, agg };
  }

  function localSymOf(symbols: ReturnType<typeof build>['symbols'], locName: string, varName: string) {
    const locSyms = symbols.locations.get(locName.toLowerCase());
    expect(locSyms).toBeDefined();
    // Find any local QspSymbol with this base-name.
    for (const [, sym] of locSyms!.variables) {
      if (sym.isLocal && sym.nameLower === varName.toLowerCase()) return sym;
    }
    return undefined;
  }

  it('records callee non-local write as external binding of caller local (gs)', () => {
    const { symbols, agg } = build(`# a
local x = 1
gs 'b'
pl x
---
# b
x = 2
---
`);
    const sym = localSymOf(symbols, 'a', 'x');
    expect(sym).toBeDefined();
    const ext = agg.externalLocalBindings.get(sym!);
    expect(ext).toBeDefined();
    expect(ext).toHaveLength(1);
    expect(ext![0].sourceLoc).toBe('b');
    expect(ext![0].varNameLower).toBe('x');
    expect(ext![0].binding.isLocal).toBe(false);
    expect(ext![0].binding.value).toEqual({ kind: 'number', value: 2 });
  });

  it('records callee non-local string write via func', () => {
    const { symbols, agg } = build(`# a
local $s = 'hi'
x = func('b')
---
# b
$s = 'bye'
result = $s
---
`);
    const sym = localSymOf(symbols, 'a', 's');
    expect(sym).toBeDefined();
    const ext = agg.externalLocalBindings.get(sym!);
    expect(ext).toBeDefined();
    expect(ext!.some(e => e.sourceLoc === 'b' &&
      e.binding.value.kind === 'string' && e.binding.value.value === 'bye')).toBe(true);
  });

  it('does NOT record callee LOCAL write as external binding', () => {
    // Callee shadows with LOCAL x — write is to callee's own local, not caller's.
    const { symbols, agg } = build(`# a
local x = 1
gs 'b'
---
# b
local x = 99
---
`);
    const sym = localSymOf(symbols, 'a', 'x');
    expect(sym).toBeDefined();
    const ext = agg.externalLocalBindings.get(sym!);
    // Either undefined or empty — either is acceptable.
    expect(ext === undefined || ext.length === 0).toBe(true);
  });

  it('flows transitively through a pass-through callee', () => {
    const { symbols, agg } = build(`# a
local x = 1
gs 'b'
---
# b
gs 'c'
---
# c
x = 42
---
`);
    const sym = localSymOf(symbols, 'a', 'x');
    expect(sym).toBeDefined();
    const ext = agg.externalLocalBindings.get(sym!);
    expect(ext).toBeDefined();
    expect(ext!.some(e => e.sourceLoc === 'c' &&
      e.binding.value.kind === 'number' && e.binding.value.value === 42)).toBe(true);
  });

  it('records multiple distinct bindings from the same callee', () => {
    const { symbols, agg } = build(`# a
local x = 0
gs 'b'
---
# b
if 1:
  x = 1
else
  x = 2
end
---
`);
    const sym = localSymOf(symbols, 'a', 'x');
    expect(sym).toBeDefined();
    const ext = agg.externalLocalBindings.get(sym!);
    expect(ext).toBeDefined();
    const values = ext!.map(e => e.binding.value).filter(v => v.kind === 'number').map(v => (v as { value: number }).value).sort();
    expect(values).toEqual([1, 2]);
  });

  it('deduplicates identical bindings reached via multiple paths', () => {
    // Two call paths from `a` to `c` (direct and via `b`) should not
    // duplicate `c`'s binding of x.
    const { symbols, agg } = build(`# a
local x = 0
gs 'b'
gs 'c'
---
# b
gs 'c'
---
# c
x = 7
---
`);
    const sym = localSymOf(symbols, 'a', 'x');
    expect(sym).toBeDefined();
    const ext = agg.externalLocalBindings.get(sym!);
    expect(ext).toBeDefined();
    const fromC = ext!.filter(e => e.sourceLoc === 'c');
    expect(fromC).toHaveLength(1);
  });

  it('propagates through @/func (user call) channel', () => {
    const { symbols, agg } = build(`# a
local $fn = ''
x = @b
---
# b
$fn = 'updated'
---
`);
    const sym = localSymOf(symbols, 'a', 'fn');
    expect(sym).toBeDefined();
    const ext = agg.externalLocalBindings.get(sym!);
    expect(ext).toBeDefined();
    expect(ext!.some(e => e.sourceLoc === 'b' &&
      e.binding.value.kind === 'string' && e.binding.value.value === 'updated')).toBe(true);
  });

  it('has no entry when caller local is unused downstream', () => {
    const { symbols, agg } = build(`# a
local x = 1
gs 'b'
---
# b
y = 2
---
`);
    const sym = localSymOf(symbols, 'a', 'x');
    expect(sym).toBeDefined();
    // Nothing writes to x in the callee — no external bindings.
    const ext = agg.externalLocalBindings.get(sym!);
    expect(ext === undefined || ext.length === 0).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Side-effect writes (setvar / killvar / copyarr / sortarr / unpackarr /
// scanstr) inside callees must flow back to caller-propagated locals
// through every call channel: gs, gosub, func, @, @@, and dynamic.
// ──────────────────────────────────────────────────────────────────────

describe('externalLocalBindings: side-effect writes propagate back to caller locals', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  function build(code: string) {
    const tree = parser.parse('test://se', code)!;
    const { symbols } = extractSymbols(tree, 'test://se');
    const agg = emptyAggregates();
    collectAggregates(symbols.locations.values(), agg);
    const allLocs: { locName: string; locSyms: LocationSymbols; uri: string }[] = [];
    for (const [, ls] of symbols.locations) {
      allLocs.push({ locName: ls.locationName, locSyms: ls, uri: 'test://se' });
    }
    buildPropagatedLocals(allLocs, agg, [symbols]);
    return { symbols, agg };
  }

  function localSymOf(symbols: ReturnType<typeof build>['symbols'], locName: string, varName: string) {
    const locSyms = symbols.locations.get(locName.toLowerCase());
    for (const [, sym] of locSyms!.variables) {
      if (sym.isLocal && sym.nameLower === varName.toLowerCase()) return sym;
    }
    return undefined;
  }

  function extOf(agg: SymbolAggregates, sym: ReturnType<typeof localSymOf>, loc: string) {
    const ext = agg.externalLocalBindings.get(sym!) ?? [];
    return ext.filter(e => e.sourceLoc === loc);
  }

  // ── setvar ─────────────────────────────────────────────────────────

  it('setvar in callee propagates to caller local (gs)', () => {
    const { symbols, agg } = build(`# a
local $s = ''
gs 'b'
---
# b
setvar '$s', 'hi'
---
`);
    const sym = localSymOf(symbols, 'a', 's');
    expect(extOf(agg, sym, 'b')).toHaveLength(1);
  });

  it('setvar transitively flows through A → B → C to A\'s local', () => {
    const { symbols, agg } = build(`# a
local #n = 0
gs 'b'
---
# b
gs 'c'
---
# c
setvar '#n', 42
---
`);
    const sym = localSymOf(symbols, 'a', 'n');
    const fromC = extOf(agg, sym, 'c');
    expect(fromC).toHaveLength(1);
    expect(fromC[0].varNameLower).toBe('n');
  });

  // ── killvar ────────────────────────────────────────────────────────

  it('killvar in callee records a reset-binding on caller local', () => {
    const { symbols, agg } = build(`# a
local arr = 0
gs 'b'
---
# b
killvar 'arr'
---
`);
    const sym = localSymOf(symbols, 'a', 'arr');
    expect(extOf(agg, sym, 'b')).toHaveLength(1);
  });

  // ── copyarr (destination) ──────────────────────────────────────────

  it('copyarr destination in callee flows to caller local', () => {
    const { symbols, agg } = build(`# a
local dst = 0
gs 'b'
---
# b
copyarr 'dst', 'src'
---
`);
    const sym = localSymOf(symbols, 'a', 'dst');
    expect(extOf(agg, sym, 'b')).toHaveLength(1);
  });

  // ── sortarr ────────────────────────────────────────────────────────

  it('sortarr in callee flows to caller local', () => {
    const { symbols, agg } = build(`# a
local arr = 0
gs 'b'
---
# b
sortarr 'arr'
---
`);
    const sym = localSymOf(symbols, 'a', 'arr');
    expect(extOf(agg, sym, 'b')).toHaveLength(1);
  });

  // ── unpackarr ──────────────────────────────────────────────────────

  it('unpackarr in callee flows to caller local', () => {
    const { symbols, agg } = build(`# a
local %a = 0
gs 'b'
---
# b
unpackarr '%a', 'src'
---
`);
    const sym = localSymOf(symbols, 'a', 'a');
    expect(extOf(agg, sym, 'b')).toHaveLength(1);
  });

  // ── scanstr ────────────────────────────────────────────────────────

  it('scanstr in callee flows to caller local', () => {
    const { symbols, agg } = build(`# a
local #n = 0
gs 'b'
---
# b
scanstr '#n', $text, 'abc'
---
`);
    const sym = localSymOf(symbols, 'a', 'n');
    expect(extOf(agg, sym, 'b')).toHaveLength(1);
  });

  // ── Shadowing: callee's own LOCAL blocks propagation ───────────────

  it('side-effect write in callee does NOT flow back when callee has its own local', () => {
    const { symbols, agg } = build(`# a
local arr = 0
gs 'b'
---
# b
local arr = 5
sortarr 'arr'
---
`);
    const sym = localSymOf(symbols, 'a', 'arr');
    expect(agg.externalLocalBindings.get(sym!) === undefined ||
      agg.externalLocalBindings.get(sym!)!.length === 0).toBe(true);
  });

  // ── Nested scope inside callee ─────────────────────────────────────

  it('setvar inside nested if/loop in callee still flows back', () => {
    const { symbols, agg } = build(`# a
local #n = 0
gs 'b'
---
# b
if 1:
  setvar '#n', 55
end
---
`);
    const sym = localSymOf(symbols, 'a', 'n');
    expect(extOf(agg, sym, 'b')).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// All call channels (gs / gosub / func / @ / @@) carry locals and
// propagate callee writes back.  `goto` / `gt` / `xgoto` / `xgt` do NOT.
// ──────────────────────────────────────────────────────────────────────

describe('externalLocalBindings: every call channel carries mutations back', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  function build(code: string) {
    const tree = parser.parse('test://ch', code)!;
    const { symbols } = extractSymbols(tree, 'test://ch');
    const agg = emptyAggregates();
    collectAggregates(symbols.locations.values(), agg);
    const allLocs: { locName: string; locSyms: LocationSymbols; uri: string }[] = [];
    for (const [, ls] of symbols.locations) {
      allLocs.push({ locName: ls.locationName, locSyms: ls, uri: 'test://ch' });
    }
    buildPropagatedLocals(allLocs, agg, [symbols]);
    return { symbols, agg };
  }

  function localSymOf(symbols: ReturnType<typeof build>['symbols'], locName: string, varName: string) {
    const locSyms = symbols.locations.get(locName.toLowerCase());
    for (const [, sym] of locSyms!.variables) {
      if (sym.isLocal && sym.nameLower === varName.toLowerCase()) return sym;
    }
    return undefined;
  }

  it.each([
    ['gs',     "gs 'b'"],
    ['gosub',  "gosub 'b'"],
    ['func',   "y = func('b')"],
    ['@',      "y = @b"],
    ['@@',     "@@b"],
  ])('%s: callee writes flow back to caller local', (_name, call) => {
    const { symbols, agg } = build(`# a
local x = 0
${call}
pl x
---
# b
x = 42
---
`);
    const sym = localSymOf(symbols, 'a', 'x');
    const ext = agg.externalLocalBindings.get(sym!) ?? [];
    expect(ext.some(e => e.sourceLoc === 'b' &&
      e.binding.value.kind === 'number' && e.binding.value.value === 42)).toBe(true);
  });

  it.each([
    ['goto',  "goto 'b'"],
    ['gt',    "gt 'b'"],
    ['xgoto', "xgoto 'b'"],
    ['xgt',   "xgt 'b'"],
  ])('%s: callee writes do NOT flow back (non-propagating channel)', (_name, call) => {
    const { symbols, agg } = build(`# a
local x = 0
${call}
---
# b
x = 42
---
`);
    const sym = localSymOf(symbols, 'a', 'x');
    expect(agg.externalLocalBindings.get(sym!) === undefined ||
      agg.externalLocalBindings.get(sym!)!.length === 0).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// dynamic / dyneval — writes inside executed code blocks flow to caller
// locals (both code_block-literal and var-mediated forms).
// ──────────────────────────────────────────────────────────────────────

describe('externalLocalBindings: dynamic / dyneval writes propagate', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  function build(code: string) {
    const tree = parser.parse('test://dyn', code)!;
    const { symbols } = extractSymbols(tree, 'test://dyn');
    const agg = emptyAggregates();
    collectAggregates(symbols.locations.values(), agg);
    const allLocs: { locName: string; locSyms: LocationSymbols; uri: string }[] = [];
    for (const [, ls] of symbols.locations) {
      allLocs.push({ locName: ls.locationName, locSyms: ls, uri: 'test://dyn' });
    }
    buildPropagatedLocals(allLocs, agg, [symbols]);
    return { symbols, agg };
  }

  function localSymOf(symbols: ReturnType<typeof build>['symbols'], locName: string, varName: string) {
    const locSyms = symbols.locations.get(locName.toLowerCase());
    for (const [, sym] of locSyms!.variables) {
      if (sym.isLocal && sym.nameLower === varName.toLowerCase()) return sym;
    }
    return undefined;
  }

  it('dynamic { block } in callee writes to caller-propagated local', () => {
    const { symbols, agg } = build(`# a
local x = 0
gs 'b'
pl x
---
# b
dynamic { x = 42 }
---
`);
    const sym = localSymOf(symbols, 'a', 'x');
    const ext = agg.externalLocalBindings.get(sym!) ?? [];
    expect(ext.some(e => e.sourceLoc === 'b' &&
      e.binding.value.kind === 'number' && e.binding.value.value === 42)).toBe(true);
  });

  it('dyneval("code") in callee writes to caller-propagated local', () => {
    const { symbols, agg } = build(`# a
local x = 0
gs 'b'
---
# b
y = dyneval({ x = 99 })
---
`);
    const sym = localSymOf(symbols, 'a', 'x');
    const ext = agg.externalLocalBindings.get(sym!) ?? [];
    expect(ext.some(e => e.sourceLoc === 'b' &&
      e.binding.value.kind === 'number' && e.binding.value.value === 99)).toBe(true);
  });

  it('var-mediated dynamic $code in callee writes to caller local', () => {
    const { symbols, agg } = build(`# a
local x = 0
gs 'b'
pl x
---
# b
$code = { x = 77 }
dynamic $code
---
`);
    const sym = localSymOf(symbols, 'a', 'x');
    const ext = agg.externalLocalBindings.get(sym!) ?? [];
    expect(ext.some(e => e.sourceLoc === 'b' &&
      e.binding.value.kind === 'number' && e.binding.value.value === 77)).toBe(true);
  });

  it('dynamic inside nested if/loop still flows back', () => {
    const { symbols, agg } = build(`# a
local x = 0
gs 'b'
---
# b
if 1:
  dynamic { x = 11 }
end
---
`);
    const sym = localSymOf(symbols, 'a', 'x');
    const ext = agg.externalLocalBindings.get(sym!) ?? [];
    expect(ext.some(e => e.sourceLoc === 'b' &&
      e.binding.value.kind === 'number' && e.binding.value.value === 11)).toBe(true);
  });

  it('side-effect write inside dynamic block flows back', () => {
    const { symbols, agg } = build(`# a
local $s = ''
gs 'b'
---
# b
dynamic { setvar '$s', 'from-dynamic' }
---
`);
    const sym = localSymOf(symbols, 'a', 's');
    const ext = agg.externalLocalBindings.get(sym!) ?? [];
    expect(ext.some(e => e.sourceLoc === 'b' && e.varNameLower === 's')).toBe(true);
  });

  it('chain: dynamic in callee, then callee calls deeper — flows to outermost caller', () => {
    const { symbols, agg } = build(`# a
local x = 0
gs 'b'
---
# b
gs 'c'
---
# c
dynamic { x = 5 }
---
`);
    const sym = localSymOf(symbols, 'a', 'x');
    const ext = agg.externalLocalBindings.get(sym!) ?? [];
    expect(ext.some(e => e.sourceLoc === 'c' &&
      e.binding.value.kind === 'number' && e.binding.value.value === 5)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// collectAggregates — globallyRead correctness
// ──────────────────────────────────────────────────────────────────────

describe('collectAggregates: globallyRead', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  function buildAgg(code: string): SymbolAggregates {
    const tree = parser.parse('test://gr', code)!;
    const { symbols } = extractSymbols(tree, 'test://gr');
    const agg = emptyAggregates();
    collectAggregates(symbols.locations.values(), agg);
    return agg;
  }

  it('assigned and read variable is in globallyRead', () => {
    const agg = buildAgg(`# main\nx = 1\npl x\n---\n`);
    expect(agg.globallyRead.has('x')).toBe(true);
  });

  it('assigned-only variable is NOT in globallyRead', () => {
    const agg = buildAgg(`# main\nx = 1\n---\n`);
    expect(agg.globallyRead.has('x')).toBe(false);
  });

  it('killvar-only reference does NOT add variable to globallyRead', () => {
    // Regression: the old check (!ref.isDefinition) incorrectly counted
    // killvar references as reads, suppressing the "unused" warning.
    const agg = buildAgg(`# main\nx = 42\nkillvar 'x'\n---\n`);
    expect(agg.globallyRead.has('x')).toBe(false);
  });

  it('sortarr-only reference does NOT add variable to globallyRead', () => {
    const agg = buildAgg(`# main\narr[0] = 1\nsortarr 'arr'\n---\n`);
    expect(agg.globallyRead.has('arr')).toBe(false);
  });

  it('compound-assignment LHS does NOT add variable to globallyRead', () => {
    // `x += 1` is a read-then-write at runtime, but isProperUsage is false
    // on the LHS ref — it should not count as "read" in the fallback path.
    const agg = buildAgg(`# main\nx = 1\nx += 2\n---\n`);
    expect(agg.globallyRead.has('x')).toBe(false);
  });

  it('killvar in a different location does NOT add variable to globallyRead', () => {
    // Cross-location case: x assigned in locA, killvar'd in locB.
    // globallyRead should not contain x since no proper read exists.
    const agg = buildAgg(`# locA\nx = 42\n---\n# locB\nkillvar 'x'\n---\n`);
    expect(agg.globallyRead.has('x')).toBe(false);
  });
});

describe('crossLocationDispatches (project-wide global code-block dispatch)', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  function buildBoth(code: string) {
    const tree = parser.parse('test://cld', code)!;
    const { symbols } = extractSymbols(tree, 'test://cld');
    const agg = emptyAggregates();
    collectAggregates(symbols.locations.values(), agg);
    const allLocs: { locName: string; locSyms: LocationSymbols; uri: string }[] = [];
    for (const [, ls] of symbols.locations) {
      allLocs.push({ locName: ls.locationName, locSyms: ls, uri: 'test://cld' });
    }
    buildPropagatedLocals(allLocs, agg);
    return { symbols, agg };
  }

  function build(code: string): SymbolAggregates {
    return buildBoth(code).agg;
  }

  it('resolves a global code-block written in another location', () => {
    const agg = build(`# init
$dispatch = { result = 42 }
---
# other
res = dyneval($dispatch)
---
`);
    const sites = agg.crossLocationDispatches.get('other') ?? [];
    expect(sites).toHaveLength(1);
    expect(sites[0].kind).toBe('dyneval');
    expect(sites[0].varBaseName).toBe('dispatch');
    expect(sites[0].candidates).toHaveLength(1);
    expect(sites[0].candidates[0].providerLoc).toBe('init');
    expect(sites[0].candidates[0].writesResult).toBe(true);
  });

  it('records argCount and per-candidate argsUsage', () => {
    const agg = build(`# init
$d = { result = args[0] + args[1] }
---
# other
res = dyneval($d, 1, 2, 3)
---
`);
    const sites = agg.crossLocationDispatches.get('other') ?? [];
    expect(sites).toHaveLength(1);
    expect(sites[0].argCount).toBe(3);
    const cand = sites[0].candidates[0];
    expect(cand.argsUsage).toBeDefined();
    expect(cand.argsUsage!.maxLiteralIdx).toBe(1);
  });

  it('does NOT resolve when an intra-location binding is visible', () => {
    // `$d` is bound globally in BOTH `init` and `other`; the intra-location
    // pass at `other` already finds it, so no cross-location entry.
    const agg = build(`# init
$d = { result = 1 }
---
# other
$d = { result = 2 }
res = dyneval($d)
---
`);
    expect(agg.crossLocationDispatches.get('other')).toBeUndefined();
  });

  it('does NOT resolve when a propagated-local provider already supplied the binding', () => {
    // `local $d` in caller propagates to callee; callee's `dyneval($d)`
    // is resolved via propagatedLocals, not cross-location globals.
    const agg = build(`# caller
local $d = { result = 1 }
gs 'callee'
---
# callee
res = dyneval($d)
---
# decoy
$d = { result = 999 }
---
`);
    expect(agg.crossLocationDispatches.get('callee')).toBeUndefined();
  });

  it('propagated caller-local shadows global even when local is not a code-block', () => {
    // Caller propagates `local $d = 'foo'` into callee.  At runtime
    // that local shadows the global $d entirely — `dynamic $d` would
    // be a runtime error (string, not code), NOT a dispatch to the
    // global block in `decoy`.  Cross-loc must NOT emit an entry.
    const agg = build(`# caller
local $d = 'foo'
gs 'callee'
---
# callee
dynamic $d
---
# decoy
$d = { result = 999 }
---
`);
    expect(agg.crossLocationDispatches.get('callee')).toBeUndefined();
  });

  it('intra-loc local shadows cross-loc global: cross-loc post-pass does not fire', () => {
    // `other` has its own `local $d = {...}` in scope at the call.
    // Intra-loc finds the local, resolves the call, and the cross-loc
    // pass is skipped — the global $d in `init` is shadowed.
    const agg = build(`# init
$d = { result = 1 }
---
# other
local $d = { result = 2 }
res = dyneval($d)
---
`);
    expect(agg.crossLocationDispatches.get('other')).toBeUndefined();
  });

  it('intra-loc local shadows caller-propagated code-block local at dispatch', () => {
    // `caller` propagates `local $d = { … }` to `callee`.  But
    // `callee` declares its OWN `local $d = { … }` which shadows the
    // propagated one at the dispatch site — intra-loc resolves the
    // call before it reaches `unresolvedDynamicVarCalls`, so neither
    // propagated-locals dispatch nor cross-loc fires.
    const { symbols, agg } = buildBoth(`# caller
local $d = { x = 1 }
gs 'callee'
---
# callee
local $d = { y = 2 }
res = dyneval($d)
---
`);
    expect(agg.crossLocationDispatches.get('callee')).toBeUndefined();
    // The call site found a single local target (the callee's own
    // `local $d`), so the locSyms tracks it as a resolved dynamic
    // block rather than an unresolved call.
    const callee = symbols.getLocation('callee')!;
    expect(callee.unresolvedDynamicVarCalls).toHaveLength(0);
    expect(callee.resolvedDynamicBlocks).toHaveLength(1);
  });

  it('collects multiple global candidates across locations', () => {
    const agg = build(`# a
$d = { result = 1 }
---
# b
$d = { result = 2 }
---
# c
res = dyneval($d)
---
`);
    const sites = agg.crossLocationDispatches.get('c') ?? [];
    expect(sites).toHaveLength(1);
    const providers = sites[0].candidates.map(c => c.providerLoc).sort();
    expect(providers).toEqual(['a', 'b']);
  });

  it('does not emit an entry for an unresolved var with no global block', () => {
    const agg = build(`# other
res = dyneval($nowhere)
---
`);
    expect(agg.crossLocationDispatches.get('other')).toBeUndefined();
  });

  it('ignores local code-block bindings in other locations (only globals qualify)', () => {
    // `local $d = {...}` in `init` is purely local to that location's
    // call frame — it doesn't establish a global $d that another loc
    // could dispatch to.  Cross-loc resolution must skip it.
    const agg = build(`# init
local $d = { result = 1 }
---
# other
res = dyneval($d)
---
`);
    expect(agg.crossLocationDispatches.get('other')).toBeUndefined();
  });

  it('ignores non-code-block global values (e.g. a string $d = "foo")', () => {
    // Only code-block bindings can be dispatch targets; a plain string
    // value isn't introspectable statically.  Confirm no cross-loc
    // entry is recorded even though a global $d exists.
    const agg = build(`# init
$d = 'foo'
---
# other
res = dyneval($d)
---
`);
    expect(agg.crossLocationDispatches.get('other')).toBeUndefined();
  });

  it('records `dynamic` statement-form calls with kind="dynamic" and argCount=0', () => {
    const agg = build(`# init
$d = { x = 1 }
---
# other
dynamic $d
---
`);
    const sites = agg.crossLocationDispatches.get('other') ?? [];
    expect(sites).toHaveLength(1);
    expect(sites[0].kind).toBe('dynamic');
    expect(sites[0].argCount).toBe(0);
  });

  it('records `dynamic` statement-form calls with extra arguments', () => {
    const agg = build(`# init
$d = { x = args[0] }
---
# other
dynamic $d, 10, 20
---
`);
    const sites = agg.crossLocationDispatches.get('other') ?? [];
    expect(sites).toHaveLength(1);
    expect(sites[0].kind).toBe('dynamic');
    expect(sites[0].argCount).toBe(2);
    expect(sites[0].candidates[0].argsUsage?.maxLiteralIdx).toBe(0);
  });

  it('falls back to cross-loc when intra-loc binding is non-code-block (string)', () => {
    // `other` has `$d = 'foo'` (non-code-block) — the intra-location
    // resolver filters that out, so blocks.length===0 and the call is
    // marked unresolved.  The cross-loc pass should then find the
    // global code-block in `init` and record the dispatch.
    const agg = build(`# init
$d = { result = 1 }
---
# other
$d = 'foo'
res = dyneval($d)
---
`);
    const sites = agg.crossLocationDispatches.get('other') ?? [];
    expect(sites).toHaveLength(1);
    expect(sites[0].candidates).toHaveLength(1);
    expect(sites[0].candidates[0].providerLoc).toBe('init');
  });

  it('pre-computes argsUsage.hasOpaque for non-literal args[i] indices', () => {
    const agg = build(`# init
$d = { i = 0 & result = args[i] }
---
# other
res = dyneval($d, 1, 2, 3)
---
`);
    const sites = agg.crossLocationDispatches.get('other') ?? [];
    expect(sites).toHaveLength(1);
    expect(sites[0].candidates[0].argsUsage?.hasOpaque).toBe(true);
  });

  it('records writesResult=false when block has no result assignment', () => {
    const agg = build(`# init
$d = { x = 1 & y = 2 }
---
# other
res = dyneval($d)
---
`);
    const sites = agg.crossLocationDispatches.get('other') ?? [];
    expect(sites).toHaveLength(1);
    expect(sites[0].candidates[0].writesResult).toBe(false);
  });

  it('records candidate.argsUsage as undefined when block has no args ref', () => {
    const agg = build(`# init
$d = { result = 42 }
---
# other
res = dyneval($d, 1, 2)
---
`);
    const sites = agg.crossLocationDispatches.get('other') ?? [];
    expect(sites).toHaveLength(1);
    expect(sites[0].candidates[0].argsUsage).toBeUndefined();
  });

  it('resolves cross-file: global block in fileA, dispatch in fileB', () => {
    // Project mode: the global $d code-block lives in a different
    // file than the dyneval call.  The cross-loc index must include
    // both files' locations.
    const treeA = parser.parse('test://fA', `# init
$d = { result = 7 }
---
`)!;
    const treeB = parser.parse('test://fB', `# other
res = dyneval($d)
---
`)!;
    const symsA = extractSymbols(treeA, 'test://fA').symbols;
    const symsB = extractSymbols(treeB, 'test://fB').symbols;
    const agg = emptyAggregates();
    collectAggregates(symsA.locations.values(), agg);
    collectAggregates(symsB.locations.values(), agg);
    const allLocs: { locName: string; locSyms: LocationSymbols; uri: string }[] = [];
    for (const [, ls] of symsA.locations) {
      allLocs.push({ locName: ls.locationName, locSyms: ls, uri: 'test://fA' });
    }
    for (const [, ls] of symsB.locations) {
      allLocs.push({ locName: ls.locationName, locSyms: ls, uri: 'test://fB' });
    }
    buildPropagatedLocals(allLocs, agg);
    const sites = agg.crossLocationDispatches.get('other') ?? [];
    expect(sites).toHaveLength(1);
    expect(sites[0].candidates).toHaveLength(1);
    expect(sites[0].candidates[0].providerLoc).toBe('init');
    expect(sites[0].candidates[0].providerUri).toBe('test://fA');
    expect(sites[0].candidates[0].writesResult).toBe(true);
  });

  it('exec-body dispatch resolves cross-file global', () => {
    // Exec-body equivalent of the cross-file test above: the
    // dispatch lives inside an `<a href="exec:…">` link in fileB,
    // and the global code-block lives in fileA.
    const treeA = parser.parse('test://fA', `# init
$code = { result = 99 }
---
`)!;
    const treeB = parser.parse('test://fB', `# home
pl '<a href="exec:y = dyneval($code)">click</a>'
---
`)!;
    const symsA = extractSymbols(
      treeA, 'test://fA', undefined, undefined,
      (t) => parser.parseOnce(t),
    ).symbols;
    const symsB = extractSymbols(
      treeB, 'test://fB', undefined, undefined,
      (t) => parser.parseOnce(t),
    ).symbols;
    const agg = emptyAggregates();
    collectAggregates(symsA.locations.values(), agg);
    collectAggregates(symsB.locations.values(), agg);
    const allLocs: { locName: string; locSyms: LocationSymbols; uri: string }[] = [];
    for (const [, ls] of symsA.locations) {
      allLocs.push({ locName: ls.locationName, locSyms: ls, uri: 'test://fA' });
    }
    for (const [, ls] of symsB.locations) {
      allLocs.push({ locName: ls.locationName, locSyms: ls, uri: 'test://fB' });
    }
    buildPropagatedLocals(allLocs, agg);
    // The exec-body call site was merged into `home`; the
    // cross-loc post-pass for exec-body calls finds the global in
    // fileA's `init`.
    const sites = agg.crossLocationDispatches.get('home') ?? [];
    expect(sites).toHaveLength(1);
    expect(sites[0].candidates).toHaveLength(1);
    expect(sites[0].candidates[0].providerLoc).toBe('init');
    expect(sites[0].candidates[0].providerUri).toBe('test://fA');
    expect(sites[0].candidates[0].writesResult).toBe(true);
  });

  it('act-body dispatch resolves cross-loc global (no propagation shadow)', () => {
    // An `act` body runs at click time in a fresh frame — caller-
    // propagated locals don't reach it.  Even when `caller`
    // propagates `local $code = {…}` into `callee`, the act-internal
    // `dyneval($code)` must still resolve to `init`'s global `$code`,
    // not be blocked by the propagated-local shadow.
    const { agg } = buildBoth(`# init
$code = { result = 42 }
---
# caller
local $code = { result = 1 }
gosub 'callee'
---
# callee
act 'go':
  res = dyneval($code)
end
---
`);
    const sites = agg.crossLocationDispatches.get('callee') ?? [];
    expect(sites).toHaveLength(1);
    expect(sites[0].candidates).toHaveLength(1);
    expect(sites[0].candidates[0].providerLoc).toBe('init');
    expect(sites[0].candidates[0].writesResult).toBe(true);
  });

  it('act-body dispatch ignores caller-propagated local (no externalLocalBindings)', () => {
    // Same scenario without an init global: the act-internal call
    // stays unresolved (correct — no global candidate exists), and
    // the propagated-locals dispatch pass must NOT treat caller's
    // `local $code` as a click-time candidate.  No flow-back into
    // caller's locals is recorded.
    const { agg } = buildBoth(`# caller
local $code = { y = 99 }
gosub 'callee'
---
# callee
act 'go':
  res = dyneval($code)
end
---
`);
    expect(agg.crossLocationDispatches.get('callee') ?? []).toHaveLength(0);
    // No spurious caller-local write recorded from the act-internal
    // dispatch.
    const extCaller = agg.externalLocalBindings.get('caller');
    expect(extCaller === undefined || extCaller.size === 0).toBe(true);
  });

  it('inline-act dispatch also bypasses propagation shadow', () => {
    // Single-statement form `act 'x': stmt` parses as `act_inline`
    // (vs multi-statement `act_block`).  Both have identical click-
    // time/fresh-frame semantics, so deferred routing must trigger
    // for `act_inline` too.
    const { agg } = buildBoth(`# init
$code = { result = 7 }
---
# caller
local $code = { result = 1 }
gosub 'callee'
---
# callee
act 'go': res = dyneval($code)
---
`);
    const sites = agg.crossLocationDispatches.get('callee') ?? [];
    expect(sites).toHaveLength(1);
    expect(sites[0].candidates).toHaveLength(1);
    expect(sites[0].candidates[0].providerLoc).toBe('init');
  });

  it('intra-act local binding still resolves before deferred routing', () => {
    // When the act body itself declares the code-block, intra-loc
    // resolution at `bindingCollector` time wins and the call site
    // never reaches the unresolved/deferred bucket — verified by
    // the dispatch NOT appearing in crossLocationDispatches.
    const { symbols, agg } = buildBoth(`# init
$code = { result = 99 }
---
# callee
act 'go':
  local $code = { result = 1 }
  res = dyneval($code)
end
---
`);
    expect(agg.crossLocationDispatches.get('callee') ?? []).toHaveLength(0);
    // The intra-loc dispatch IS recorded as resolved on the location.
    const callee = symbols.getLocation('callee')!;
    expect(callee.dynamicVarCalls).toHaveLength(1);
    // And it did NOT end up in the deferred bucket (it was resolved
    // intra-loc to the act-internal local before any routing).
    expect(callee.deferredDynamicVarCalls).toHaveLength(0);
  });

  it('act inside <a href="exec:…"> body also routes to deferred bucket', () => {
    // Regression: an `act` block nested inside an exec-body link
    // body is doubly deferred — the link's exec body runs at link-
    // click time, and the act inside runs at action-click time after
    // that.  Pre-fix, the embedded-exec sub-walker correctly routed
    // the act-internal dispatch to `sub.deferredDynamicVarCalls` but
    // the merge step only forwarded `sub.unresolvedDynamicVarCalls`,
    // silently dropping the dispatch.  Now `walkLocationBody` is
    // invoked with `inDeferredExecution=true` for exec bodies, so
    // ALL unresolved dispatches inside land in `deferred…` and the
    // merge forwards that bucket.
    //
    // Requires `parseFn` to drive the embedded-exec sub-parser, so
    // we invoke `extractSymbols` directly (mirroring the cross-file
    // exec-body test above) rather than going through `buildBoth`.
    const tree = parser.parse('test://aie', `# init
$code = { result = 99 }
---
# home
pl '<a href="exec:act ''go'': res = dyneval($code)">click</a>'
---
`)!;
    const { symbols } = extractSymbols(
      tree, 'test://aie', undefined, undefined,
      (t) => parser.parseOnce(t),
    );
    const agg = emptyAggregates();
    collectAggregates(symbols.locations.values(), agg);
    const allLocs: { locName: string; locSyms: LocationSymbols; uri: string }[] = [];
    for (const [, ls] of symbols.locations) {
      allLocs.push({ locName: ls.locationName, locSyms: ls, uri: 'test://aie' });
    }
    buildPropagatedLocals(allLocs, agg);
    const sites = agg.crossLocationDispatches.get('home') ?? [];
    expect(sites).toHaveLength(1);
    expect(sites[0].candidates).toHaveLength(1);
    expect(sites[0].candidates[0].providerLoc).toBe('init');
  });
});
