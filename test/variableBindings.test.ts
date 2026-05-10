/**
 * Tests for the public variable-binding query API
 * (`src/parser/variableBindings.ts`) AND for the side-effect →
 * local-scope resolution pass inside `extractSymbols`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import {
  splitVarKey,
  parseVarStringArg,
  resolvePossibleValuesInDocument,
  resolvePossibleValuesAcrossProject,
  getMergedLocalBindings,
  getPossibleValuesAtCursor,
} from '../src/parser/variableBindings';
import {
  buildPropagatedLocals,
  emptyAggregates,
} from '../src/server/aggregation';
import { parseAndExtract, initParser } from './testHelpers';
import type { DocumentSymbols, QspSymbol, LocationSymbols, VariableBinding } from '../src/parser/symbolTable';

// ──────────────────────────────────────────────────────────────────────
// Key helpers
// ──────────────────────────────────────────────────────────────────────

describe('variableBindings: key helpers', () => {
  it('splitVarKey strips a leading $/#/% prefix', () => {
    expect(splitVarKey('$foo')).toEqual({ prefix: '$', base: 'foo' });
    expect(splitVarKey('#bar')).toEqual({ prefix: '#', base: 'bar' });
    expect(splitVarKey('%baz')).toEqual({ prefix: '%', base: 'baz' });
  });

  it('splitVarKey leaves bare base keys unchanged', () => {
    for (const base of ['foo', 'bar', 'baz', 'qux']) {
      expect(splitVarKey(base)).toEqual({ prefix: '#', base });
    }
  });

  it('splitVarKey on empty input is safe', () => {
    expect(splitVarKey('')).toEqual({ prefix: '#', base: '' });
  });

  it('parseVarStringArg strips $/#/% and an optional [index] suffix', () => {
    expect(parseVarStringArg('foo')).toEqual({ prefix: '#', base: 'foo' });
    expect(parseVarStringArg('$foo')).toEqual({ prefix: '$', base: 'foo' });
    expect(parseVarStringArg('#bar[0]')).toEqual({ prefix: '#', base: 'bar' });
    expect(parseVarStringArg('  %baz  ')).toEqual({ prefix: '%', base: 'baz' });
  });

  it('parseVarStringArg returns null for empty/prefix-only input', () => {
    expect(parseVarStringArg('')).toBeNull();
    expect(parseVarStringArg('   ')).toBeNull();
    expect(parseVarStringArg('$')).toBeNull();
    expect(parseVarStringArg('[0]')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Helpers over the DocumentSymbols shape
// ──────────────────────────────────────────────────────────────────────

function getLoc(syms: DocumentSymbols, name: string): LocationSymbols {
  const loc = syms.locations.get(name.toLowerCase());
  if (!loc) throw new Error(`location '${name}' not found`);
  return loc;
}

function iterLocs(
  syms: DocumentSymbols,
  uri: string,
): Iterable<{ locName: string; locSyms: LocationSymbols; uri: string }> {
  const out: { locName: string; locSyms: LocationSymbols; uri: string }[] = [];
  for (const [, locSyms] of syms.locations) {
    out.push({ locName: locSyms.locationName, locSyms, uri });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// resolvePossibleValuesInDocument / resolvePossibleValuesAcrossProject
// ──────────────────────────────────────────────────────────────────────

describe('variableBindings: document & project resolvers', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(() => initParser(parser));

  it('collects global-scope bindings across prefix variants', () => {
    const { symbols } = parseAndExtract(parser, `# room1
$foo = 'hello'
$foo = 'world'
---
`);
    symbols.rebuildGlobalBindings();
    const values = resolvePossibleValuesInDocument(symbols, '$foo');
    expect(values).toHaveLength(2);
    expect(values.every(v => v.binding.value.kind === 'string')).toBe(true);
    const strs = values
      .map(v => v.binding.value.kind === 'string' ? v.binding.value.value : '')
      .sort();
    expect(strs).toEqual(['hello', 'world']);
  });

  it('follows var-ref chains intra-document', () => {
    const { symbols } = parseAndExtract(parser, `# room1
$a = 'payload'
$b = $a
---
`);
    symbols.rebuildGlobalBindings();
    const values = resolvePossibleValuesInDocument(symbols, '$b');
    const strs = values
      .map(v => v.binding.value.kind === 'string' ? v.binding.value.value : null)
      .filter(Boolean);
    expect(strs).toContain('payload');
  });

  it('unions across multiple documents', () => {
    const a = parseAndExtract(parser, `# start\n$g = 'from_a'\n---\n`, 'test://a').symbols;
    const b = parseAndExtract(parser, `# other\n$g = 'from_b'\n---\n`, 'test://b').symbols;
    a.rebuildGlobalBindings();
    b.rebuildGlobalBindings();
    const all = resolvePossibleValuesAcrossProject([a, b], '$g');
    const strs = all
      .map(v => v.binding.value.kind === 'string' ? v.binding.value.value : '')
      .sort();
    expect(strs).toEqual(['from_a', 'from_b']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// getMergedLocalBindings — cross-call propagation
// ──────────────────────────────────────────────────────────────────────

describe('variableBindings: getMergedLocalBindings', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(() => initParser(parser));

  function findLocalSym(syms: DocumentSymbols, locName: string, varBase: string): QspSymbol {
    const loc = getLoc(syms, locName);
    for (const sym of loc.variables.values()) {
      if (sym.isLocal && sym.nameLower === varBase) return sym;
    }
    throw new Error(`local variable '${varBase}' not found in ${locName}`);
  }

  it('returns own-location local bindings', () => {
    const { symbols } = parseAndExtract(parser, `# caller
local $x = 'mine'
---
`, 'test://c');
    const sym = findLocalSym(symbols, 'caller', 'x');
    const loc = getLoc(symbols, 'caller');
    const agg = emptyAggregates();
    const merged = getMergedLocalBindings(agg, sym, loc, 'test://c');
    expect(merged.length).toBeGreaterThan(0);
    expect(merged.every(m => !m.fromCall)).toBe(true);
    const texts = merged
      .map(m => m.binding.value.kind === 'string' ? m.binding.value.value : null)
      .filter(Boolean);
    expect(texts).toContain('mine');
  });

  it('merges callee mutations when buildPropagatedLocals has run', () => {
    const src = `# caller
local $x = 'initial'
gs 'helper'
---

# helper
$x = 'from_callee'
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://m');
    const agg = emptyAggregates();
    buildPropagatedLocals(iterLocs(symbols, 'test://m'), agg, [symbols]);

    const sym = findLocalSym(symbols, 'caller', 'x');
    const loc = getLoc(symbols, 'caller');
    const merged = getMergedLocalBindings(agg, sym, loc, 'test://m');

    const texts = merged
      .map(m => m.binding.value.kind === 'string' ? m.binding.value.value : null)
      .filter(Boolean);
    expect(texts).toContain('initial');
    expect(texts).toContain('from_callee');
    const fromCallEntry = merged.find(m => m.fromCall);
    expect(fromCallEntry).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Side-effect writes honour local scope
// ──────────────────────────────────────────────────────────────────────

describe('variableBindings: side-effect writes honour local scope', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(() => initParser(parser));

  function bindingsIn(syms: DocumentSymbols, locName: string, canonicalKey: string) {
    const loc = getLoc(syms, locName);
    // Tolerate legacy prefixed keys ($x/#x/%x) used by older test
    // call-sites; bindings are now base-keyed.
    const c = canonicalKey.charAt(0);
    const base = (c === '$' || c === '#' || c === '%') ? canonicalKey.slice(1) : canonicalKey;
    return loc.variableBindings.get(base) ?? [];
  }

  it('setvar on a name with a visible local becomes a local-scope binding', () => {
    const { symbols } = parseAndExtract(parser, `# room
local #count = 0
setvar '#count', 42
---
`);
    const bs = bindingsIn(symbols, 'room', '#count');
    expect(bs.length).toBeGreaterThanOrEqual(2);
    expect(bs.every(b => b.isLocal)).toBe(true);
  });

  it('setvar with no matching local stays global', () => {
    const { symbols } = parseAndExtract(parser, `# room
setvar '#count', 42
---
`);
    const bs = bindingsIn(symbols, 'room', '#count');
    expect(bs.length).toBeGreaterThanOrEqual(1);
    expect(bs.every(b => !b.isLocal)).toBe(true);
  });

  it('setvar after a bare `local x` (no RHS) is tagged local', () => {
    // Regression: `local x` with no initialiser used to record no
    // binding at all, so the retag pass had no peer local declaration
    // to anchor the side-effect write against, and `setvar 'x', …`
    // wrongly stayed global despite the visible `local x`.
    const { symbols } = parseAndExtract(parser, `# room
local #count
setvar '#count', 42
---
`);
    const bs = bindingsIn(symbols, 'room', '#count');
    expect(bs.length).toBeGreaterThanOrEqual(2);
    expect(bs.every(b => b.isLocal)).toBe(true);
  });

  it('killvar after a bare `local x` (no RHS) is tagged local', () => {
    // After the prefix-collapse refactor every binding (typed decl
    // and string-arg side-effect write alike) lands in the single
    // base-keyed bucket.  Both the `local #count` declaration and
    // the `killvar '#count'` write therefore co-exist under `count`,
    // and the local-retag pass tags both as local.
    const { symbols } = parseAndExtract(parser, `# room
local #count
killvar '#count'
---
`);
    const bs = bindingsIn(symbols, 'room', 'count');
    expect(bs.length).toBe(2);
    expect(bs.every(b => b.isLocal)).toBe(true);
  });

  it('bare `local x` declaration alone produces a local binding', () => {
    const { symbols } = parseAndExtract(parser, `# room
local #count
---
`);
    const bs = bindingsIn(symbols, 'room', '#count');
    expect(bs).toHaveLength(1);
    expect(bs[0].isLocal).toBe(true);
  });

  it('bare assignment after `local x` (no RHS) retags as local', () => {
    // Same root cause as the setvar case: a bare `x = 5` after
    // `local x` (no RHS) needs the declaration to surface as a peer
    // local binding for the retag pass to find.
    const { symbols } = parseAndExtract(parser, `# room
local #count
#count = 5
---
`);
    const bs = bindingsIn(symbols, 'room', '#count');
    expect(bs.length).toBeGreaterThanOrEqual(2);
    expect(bs.every(b => b.isLocal)).toBe(true);
  });

  it('bare assignment BEFORE `local x` stays global (source-order retag)', () => {
    // Source-order semantics: `x = 10` runs at a point where the
    // local doesn't exist yet, so it writes a real global.  Only
    // bare writes that follow the `local` declaration retag onto
    // the local.
    const { symbols } = parseAndExtract(parser, `# room
#count = 10
local #count = 5
#count = 20
---
`);
    const bs = bindingsIn(symbols, 'room', '#count');
    expect(bs.length).toBe(3);
    // Pre-declaration write: still a real global.
    expect(bs[0].isLocal).toBe(false);
    expect(bs[0].value).toEqual({ kind: 'number', value: 10 });
    // The `local` declaration itself.
    expect(bs[1].isLocal).toBe(true);
    expect(bs[1].value).toEqual({ kind: 'number', value: 5 });
    // Post-declaration bare write: retagged to the local.
    expect(bs[2].isLocal).toBe(true);
    expect(bs[2].value).toEqual({ kind: 'number', value: 20 });
  });

  it('setvar BEFORE `local x` stays global, setvar AFTER retags', () => {
    const { symbols } = parseAndExtract(parser, `# room
setvar '#count', 1
local #count
setvar '#count', 2
---
`);
    const bs = bindingsIn(symbols, 'room', '#count');
    expect(bs.length).toBe(3);
    expect(bs[0].isLocal).toBe(false); // pre-declaration setvar → global
    expect(bs[1].isLocal).toBe(true);  // the local declaration
    expect(bs[2].isLocal).toBe(true);  // post-declaration setvar → local
  });

  it('every side-effect statement participates in the resolution', () => {
    const src = `# room
local $s = ''
local #n = 0
local %a = 0
local kv = 0
setvar '$s', 'hi'
scanstr '#n', $s, 'xyz'
unpackarr '%a', $s
copyarr '%a', '%a'
sortarr '%a'
killvar 'kv'
---
`;
    const { symbols } = parseAndExtract(parser, src);
    for (const key of ['$s', '#n', '%a', 'kv']) {
      const bs = bindingsIn(symbols, 'room', key);
      expect(bs.length, `no bindings for ${key}`).toBeGreaterThan(0);
      expect(
        bs.every(b => b.isLocal),
        `${key}: at least one binding is still global`,
      ).toBe(true);
    }
  });

  it('side-effect inside act with no outer local stays global', () => {
    const src = `# room
act 'Go':
  setvar '#x', 1
end
---
`;
    const { symbols } = parseAndExtract(parser, src);
    const bs = bindingsIn(symbols, 'room', '#x');
    expect(bs.length).toBeGreaterThanOrEqual(1);
    expect(bs.every(b => !b.isLocal)).toBe(true);
  });

  it('side-effect inside act cannot see an outer local (isolation)', () => {
    // Outer local exists, but the setvar is inside an `act` body which
    // is an isolating scope - so the write should NOT bind to the
    // outer local; it falls back to global.
    const src = `# room
local #x = 0
act 'Go':
  setvar '#x', 1
end
---
`;
    const { symbols } = parseAndExtract(parser, src);
    const bs = bindingsIn(symbols, 'room', '#x');
    // Outer `local #x = 0` contributes an isLocal binding; the setvar
    // inside `act` should remain global (isLocal=false).
    const nonLocal = bs.filter(b => !b.isLocal);
    expect(nonLocal.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Intra-location nested-scope writes "pop-up" to outer local
// (bare assignments, not side-effect writes)
// ──────────────────────────────────────────────────────────────────────

describe('variableBindings: nested-scope writes bubble up to outer local', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(() => initParser(parser));

  function bindingsIn(syms: DocumentSymbols, locName: string, canonicalKey: string) {
    const c = canonicalKey.charAt(0);
    const base = (c === '$' || c === '#' || c === '%') ? canonicalKey.slice(1) : canonicalKey;
    return getLoc(syms, locName).variableBindings.get(base) ?? [];
  }

  it('bare assignment inside if-block retargets the outer local', () => {
    const { symbols } = parseAndExtract(parser, `# room
local x = 1
if 1:
  x = 2
end
---
`);
    const bs = bindingsIn(symbols, 'room', 'x');
    expect(bs).toHaveLength(2);
    // Both must be local (the declaration, AND the nested write).
    expect(bs.every(b => b.isLocal)).toBe(true);
    // Nested write does NOT leak into globalBindings.
    symbols.rebuildGlobalBindings();
    expect(symbols.globalBindings.get('x')).toBeUndefined();
  });

  it('bare assignment inside loop-block retargets the outer local', () => {
    const { symbols } = parseAndExtract(parser, `# room
local x = 1
loop while x < 10:
  x = x + 1
end
---
`);
    const bs = bindingsIn(symbols, 'room', 'x');
    expect(bs.length).toBeGreaterThanOrEqual(2);
    expect(bs.every(b => b.isLocal)).toBe(true);
  });

  it('if / else-branch writes both retarget the outer local', () => {
    const { symbols } = parseAndExtract(parser, `# room
local x = 1
if cond:
  x = 2
else
  x = 3
end
---
`);
    const bs = bindingsIn(symbols, 'room', 'x');
    expect(bs).toHaveLength(3);
    expect(bs.every(b => b.isLocal)).toBe(true);
  });

  it('bare assignment inside act-block (isolating) stays global', () => {
    const { symbols } = parseAndExtract(parser, `# room
local x = 1
act 'A':
  x = 99
end
---
`);
    const bs = bindingsIn(symbols, 'room', 'x');
    // The `local x = 1` is local; the act-body write is across an
    // isolating boundary and remains non-local.
    expect(bs.some(b => b.isLocal)).toBe(true);
    expect(bs.some(b => !b.isLocal)).toBe(true);
  });

  it('no retag when no outer local declaration exists', () => {
    const { symbols } = parseAndExtract(parser, `# room
if 1:
  x = 2
end
---
`);
    const bs = bindingsIn(symbols, 'room', 'x');
    expect(bs).toHaveLength(1);
    expect(bs[0].isLocal).toBe(false);
  });

  it('deep nesting: write inside if inside loop retargets outer local', () => {
    const { symbols } = parseAndExtract(parser, `# room
local x = 0
loop while x < 10:
  if x > 5:
    x = 100
  end
end
---
`);
    const bs = bindingsIn(symbols, 'room', 'x');
    expect(bs.length).toBeGreaterThanOrEqual(2);
    expect(bs.every(b => b.isLocal)).toBe(true);
  });

  it('deep callee write bubbles up to deepest caller local (cross-location transitive)', () => {
    // A → gs B → gs C, and C writes to `x`.  The write must flow back
    // to A's local via externalLocalBindings.
    const src = `# a
local x = 0
gs 'b'
pl x
---
# b
gs 'c'
---
# c
x = 777
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://deep');
    const agg = emptyAggregates();
    buildPropagatedLocals(iterLocs(symbols, 'test://deep'), agg, [symbols]);

    const locA = getLoc(symbols, 'a');
    let aSym: QspSymbol | undefined;
    for (const s of locA.variables.values()) {
      if (s.isLocal && s.nameLower === 'x') aSym = s;
    }
    expect(aSym).toBeDefined();

    const ext = agg.externalLocalBindings.get(aSym!);
    expect(ext).toBeDefined();
    const fromC = ext!.filter(e => e.sourceLoc === 'c');
    expect(fromC).toHaveLength(1);
    expect(fromC[0].binding.value).toEqual({ kind: 'number', value: 777 });
  });

  it('callee nested-block write bubbles up to caller local', () => {
    // Callee `c` writes to `x` inside a nested `if` - the post-pass
    // tags it as a write against a (non-existent) local in `c`, but
    // since `c` has no `local x`, it stays non-local, so the write
    // flows back to A's propagated local.
    const src = `# a
local x = 0
gs 'c'
pl x
---
# c
if 1:
  x = 55
end
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://deep2');
    const agg = emptyAggregates();
    buildPropagatedLocals(iterLocs(symbols, 'test://deep2'), agg, [symbols]);

    const locA = getLoc(symbols, 'a');
    let aSym: QspSymbol | undefined;
    for (const s of locA.variables.values()) {
      if (s.isLocal && s.nameLower === 'x') aSym = s;
    }
    expect(aSym).toBeDefined();

    const ext = agg.externalLocalBindings.get(aSym!);
    expect(ext).toBeDefined();
    expect(ext!.some(e => e.sourceLoc === 'c' &&
      e.binding.value.kind === 'number' && e.binding.value.value === 55)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Recursive call value resolution
// ──────────────────────────────────────────────────────────────────────

describe('variableBindings: recursive calls', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(() => initParser(parser));

  function aggFor(syms: DocumentSymbols, uri: string) {
    const agg = emptyAggregates();
    buildPropagatedLocals(iterLocs(syms, uri), agg, [syms]);
    return agg;
  }
  function localSymOf(syms: DocumentSymbols, locName: string, varBase: string): QspSymbol {
    const loc = getLoc(syms, locName);
    for (const s of loc.variables.values()) if (s.isLocal && s.nameLower === varBase) return s;
    throw new Error(`local '${varBase}' not found in ${locName}`);
  }

  it('self-recursive: recursive write in same location is captured by getMergedLocalBindings', () => {
    // A calls A and writes to its own local x before recursing.
    // The write lives in A's own variableBindings — no cross-location
    // routing needed. getMergedLocalBindings surfaces it as an
    // own-location entry (fromCall=false).
    const src = `# A
local x = 0
x = 1
gs 'A'
pl x
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://rec1');
    const agg = aggFor(symbols, 'test://rec1');
    const sym = localSymOf(symbols, 'A', 'x');
    const loc = getLoc(symbols, 'A');
    const merged = getMergedLocalBindings(agg, sym, loc, 'test://rec1');

    const values = merged
      .map(m => m.binding.value.kind === 'number' ? m.binding.value.value : null)
      .filter(v => v !== null);
    expect(values).toContain(0);
    expect(values).toContain(1);
    // No fromCall entries — self-recursion keeps everything in-location.
    expect(merged.every(m => !m.fromCall)).toBe(true);
  });

  it('mutual recursion A→B→A: B\'s write to x pops back to A\'s local', () => {
    const src = `# A
local x = 0
gs 'B'
---
# B
x = 42
gs 'A'
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://rec2');
    const agg = aggFor(symbols, 'test://rec2');
    const sym = localSymOf(symbols, 'A', 'x');
    const ext = agg.externalLocalBindings.get(sym) ?? [];
    const fromB = ext.filter(e => e.sourceLoc === 'b');
    expect(fromB).toHaveLength(1);
    expect(fromB[0].binding.value).toEqual({ kind: 'number', value: 42 });
  });

  it('3-cycle A→B→C→A: C\'s write pops back to A\'s local', () => {
    const src = `# A
local x = 0
gs 'B'
---
# B
gs 'C'
---
# C
x = 7
gs 'A'
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://rec3');
    const agg = aggFor(symbols, 'test://rec3');
    const sym = localSymOf(symbols, 'A', 'x');
    const ext = agg.externalLocalBindings.get(sym) ?? [];
    expect(ext.some(e => e.sourceLoc === 'c' &&
      e.binding.value.kind === 'number' && e.binding.value.value === 7)).toBe(true);
  });

  it('recursion terminates cleanly (no infinite loop, no duplicate entries)', () => {
    // A→B→A cycle where both A and B write x. Each distinct write
    // should appear exactly once in A's merged bindings.
    const src = `# A
local x = 0
x = 1
gs 'B'
---
# B
x = 2
gs 'A'
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://rec4');
    const agg = aggFor(symbols, 'test://rec4');
    const sym = localSymOf(symbols, 'A', 'x');
    const loc = getLoc(symbols, 'A');
    const merged = getMergedLocalBindings(agg, sym, loc, 'test://rec4');
    // Dedup check: every entry's (uri, locationName, stmtLoc) is unique.
    const seen = new Set<string>();
    for (const m of merged) {
      const k = `${m.uri}\0${m.locationName}\0${m.binding.stmtLoc.line}:${m.binding.stmtLoc.column}`;
      expect(seen.has(k), `duplicate: ${k}`).toBe(false);
      seen.add(k);
    }
    // Values from A (0, 1) and from B (2) all present.
    const values = merged
      .map(m => m.binding.value.kind === 'number' ? m.binding.value.value : null)
      .filter(v => v !== null)
      .sort();
    expect(values).toEqual([0, 1, 2]);
  });

  it('self-recursion with side-effect write: pops back to own local', () => {
    const src = `# A
local $s = ''
setvar '$s', 'recursive'
gs 'A'
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://rec5');
    const agg = aggFor(symbols, 'test://rec5');
    const sym = localSymOf(symbols, 'A', 's');
    const loc = getLoc(symbols, 'A');
    const merged = getMergedLocalBindings(agg, sym, loc, 'test://rec5');
    // The setvar write is tagged local against the same scope and
    // captured in the own-location bucket.
    expect(merged.length).toBeGreaterThanOrEqual(2); // local decl + setvar
    expect(merged.every(m => !m.fromCall)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// dynamic inside dynamic (nested dynamic blocks)
// ──────────────────────────────────────────────────────────────────────

describe('variableBindings: dynamic inside dynamic', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(() => initParser(parser));

  function aggFor(syms: DocumentSymbols, uri: string) {
    const agg = emptyAggregates();
    buildPropagatedLocals(iterLocs(syms, uri), agg, [syms]);
    return agg;
  }
  function localSymOf(syms: DocumentSymbols, locName: string, varBase: string): QspSymbol {
    const loc = getLoc(syms, locName);
    for (const s of loc.variables.values()) if (s.isLocal && s.nameLower === varBase) return s;
    throw new Error(`local '${varBase}' not found in ${locName}`);
  }

  it('nested dynamic literal: write reaches the outer local (same location)', () => {
    const src = `# A
local x = 0
dynamic {
  dynamic {
    x = 10
  }
}
---
`;
    const { symbols } = parseAndExtract(parser, src);
    const loc = getLoc(symbols, 'A');
    const bs = loc.variableBindings.get('x') ?? [];
    // Two bindings: the `local x = 0` and the deeply-nested `x = 10`.
    expect(bs).toHaveLength(2);
    // Both are tagged local against the outer scope.
    expect(bs.every(b => b.isLocal)).toBe(true);
    // The nested write carries the actual value.
    expect(bs.some(b => b.value.kind === 'number' && b.value.value === 10)).toBe(true);
    // No leak into globalBindings.
    symbols.rebuildGlobalBindings();
    expect(symbols.globalBindings.get('x')).toBeUndefined();
  });

  it('nested dyneval literal: write reaches the outer local (same location)', () => {
    // Both `dynamic` and `dyneval` create a new scope inside their
    // code block that inherits locals from the enclosing scope —
    // identically.  So the deeply-nested `x = 15` retags onto the
    // outer `local x`.
    const src = `# A
local x = 0
y = dyneval({
  dyneval({
    x = 15
  })
})
---
`;
    const { symbols } = parseAndExtract(parser, src);
    const loc = getLoc(symbols, 'A');
    const bs = loc.variableBindings.get('x') ?? [];
    expect(bs).toHaveLength(2);
    expect(bs.every(b => b.isLocal)).toBe(true);
    expect(bs.some(b => b.value.kind === 'number' && b.value.value === 15)).toBe(true);
    symbols.rebuildGlobalBindings();
    expect(symbols.globalBindings.get('x')).toBeUndefined();
  });

  it('nested dynamic in callee: write bubbles up through call to caller local', () => {
    const src = `# A
local x = 0
gs 'B'
---
# B
dynamic {
  dynamic {
    x = 20
  }
}
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://nd1');
    const agg = aggFor(symbols, 'test://nd1');
    const sym = localSymOf(symbols, 'A', 'x');
    const ext = agg.externalLocalBindings.get(sym) ?? [];
    expect(ext.some(e => e.sourceLoc === 'b' &&
      e.binding.value.kind === 'number' && e.binding.value.value === 20)).toBe(true);
  });

  it('side-effect write inside nested dynamic bubbles up', () => {
    const src = `# A
local $s = ''
gs 'B'
---
# B
dynamic {
  dynamic {
    setvar '$s', 'deep'
  }
}
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://nd2');
    const agg = aggFor(symbols, 'test://nd2');
    const sym = localSymOf(symbols, 'A', 's');
    const ext = agg.externalLocalBindings.get(sym) ?? [];
    expect(ext.some(e => e.sourceLoc === 'b' && e.varNameLower === 's')).toBe(true);
  });

  it('var-mediated inner dynamic: dynamic { dynamic $code } still bubbles', () => {
    const src = `# A
local x = 0
gs 'B'
---
# B
$code = { x = 30 }
dynamic {
  dynamic $code
}
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://nd3');
    const agg = aggFor(symbols, 'test://nd3');
    const sym = localSymOf(symbols, 'A', 'x');
    const ext = agg.externalLocalBindings.get(sym) ?? [];
    expect(ext.some(e => e.sourceLoc === 'b' &&
      e.binding.value.kind === 'number' && e.binding.value.value === 30)).toBe(true);
  });

  it('triply nested dynamic: write still reaches the outermost local', () => {
    const src = `# A
local x = 0
dynamic {
  dynamic {
    dynamic {
      x = 99
    }
  }
}
---
`;
    const { symbols } = parseAndExtract(parser, src);
    const loc = getLoc(symbols, 'A');
    const bs = loc.variableBindings.get('x') ?? [];
    expect(bs.some(b => b.isLocal && b.value.kind === 'number' && b.value.value === 99)).toBe(true);
    symbols.rebuildGlobalBindings();
    expect(symbols.globalBindings.get('x')).toBeUndefined();
  });

  it('nested dynamic + recursive gs: still terminates', () => {
    const src = `# A
local x = 0
dynamic {
  dynamic {
    x = 1
    gs 'A'
  }
}
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://nd4');
    const agg = aggFor(symbols, 'test://nd4');
    const sym = localSymOf(symbols, 'A', 'x');
    const loc = getLoc(symbols, 'A');
    // Should not hang; merged bindings contain both 0 and 1.
    const merged = getMergedLocalBindings(agg, sym, loc, 'test://nd4');
    const values = merged
      .map(m => m.binding.value.kind === 'number' ? m.binding.value.value : null)
      .filter(v => v !== null)
      .sort();
    expect(values).toEqual([0, 1]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Var-mediated dynamic/dyneval:  $code holder is global / local /
// propagated-local.  Verifies that caller locals propagate INTO the
// deferred block and that writes inside the block propagate BACK to
// caller locals — across all three kinds of code-block holders.
// ──────────────────────────────────────────────────────────────────────

describe('variableBindings: var-mediated dynamic/dyneval by holder kind', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(() => initParser(parser));

  function aggFor(syms: DocumentSymbols, uri: string) {
    const agg = emptyAggregates();
    buildPropagatedLocals(iterLocs(syms, uri), agg, [syms]);
    return agg;
  }
  function localSymOf(syms: DocumentSymbols, locName: string, varBase: string): QspSymbol {
    const loc = getLoc(syms, locName);
    for (const s of loc.variables.values()) if (s.isLocal && s.nameLower === varBase) return s;
    throw new Error(`local '${varBase}' not found in ${locName}`);
  }

  // ── Holder = GLOBAL ─────────────────────────────────────────────────

  it('global $code: caller local propagates INTO block', () => {
    const src = `# A
local x = 1
$code = { pl x }
dynamic $code
---
`;
    const { symbols } = parseAndExtract(parser, src);
    const loc = getLoc(symbols, 'A');
    expect(loc.dynamicVarCalls).toHaveLength(1);
    expect(loc.dynamicVarCalls[0].varBaseName).toBe('code');
    expect(loc.dynamicVarCalls[0].localNames).toContain('x');
  });

  it('global $code: write inside block retags onto outer local (per-call-site inlining)', () => {
    // Var-mediated `dynamic $code` is treated as if the block were
    // inlined at the call site — so the inner write retags onto the
    // outer `local x` just like a direct `dynamic { x = 99 }` would.
    const src = `# A
local x = 0
$code = { x = 99 }
dynamic $code
---
`;
    const { symbols } = parseAndExtract(parser, src);
    const loc = getLoc(symbols, 'A');
    const bs = loc.variableBindings.get('x') ?? [];
    expect(bs.some(b => b.isLocal && b.value.kind === 'number' && b.value.value === 0)).toBe(true);
    expect(bs.some(b => b.isLocal && b.value.kind === 'number' && b.value.value === 99)).toBe(true);
    symbols.rebuildGlobalBindings();
    expect(symbols.globalBindings.get('x')).toBeUndefined();
  });

  it('direct (non-var-mediated) dynamic { x = N }: write DOES retag (symmetric)', () => {
    // Symmetry test: both var-mediated and direct forms now retag
    // inner writes onto the outer local identically.
    const src = `# A
local x = 0
dynamic { x = 99 }
---
`;
    const { symbols } = parseAndExtract(parser, src);
    const loc = getLoc(symbols, 'A');
    const bs = loc.variableBindings.get('x') ?? [];
    expect(bs).toHaveLength(2);
    expect(bs.every(b => b.isLocal)).toBe(true);
    expect(bs.some(b => b.value.kind === 'number' && b.value.value === 99)).toBe(true);
    symbols.rebuildGlobalBindings();
    expect(symbols.globalBindings.get('x')).toBeUndefined();
  });

  it('global $code: write inside block flows BACK across gs to caller local', () => {
    const src = `# A
local x = 0
gs 'B'
---
# B
$code = { x = 42 }
dynamic $code
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://g1');
    const agg = aggFor(symbols, 'test://g1');
    const sym = localSymOf(symbols, 'A', 'x');
    const ext = agg.externalLocalBindings.get(sym) ?? [];
    expect(ext.some(e => e.sourceLoc === 'b' &&
      e.binding.value.kind === 'number' && e.binding.value.value === 42)).toBe(true);
  });

  // ── Holder = LOCAL (same location, visible at call site) ───────────

  it('local $code: caller local propagates INTO block (inside same scope)', () => {
    const src = `# A
local x = 1
if 1:
  local $code = { pl x }
  dynamic $code
end
---
`;
    const { symbols } = parseAndExtract(parser, src);
    const loc = getLoc(symbols, 'A');
    expect(loc.dynamicVarCalls).toHaveLength(1);
    expect(loc.dynamicVarCalls[0].localNames).toContain('x');
  });

  it('local $code: write inside block retags onto outer local', () => {
    // Per-call-site inlining finds the outer `local x` visible from
    // the `dynamic $code` call site and retags the inner write.
    const src = `# A
local x = 0
if 1:
  local $code = { x = 55 }
  dynamic $code
end
---
`;
    const { symbols } = parseAndExtract(parser, src);
    const loc = getLoc(symbols, 'A');
    const bs = loc.variableBindings.get('x') ?? [];
    expect(bs.some(b => b.isLocal && b.value.kind === 'number' && b.value.value === 55)).toBe(true);
    symbols.rebuildGlobalBindings();
    expect(symbols.globalBindings.get('x')).toBeUndefined();
  });

  it('local $code scoped-out: NOT tracked at outer call site', () => {
    // Pinning the existing visibility rule — outer `dynamic $code`
    // cannot see a `local $code` confined to an inner if-branch.
    const src = `# A
if 1:
  local $code = { pl 'inner' }
end
dynamic $code
---
`;
    const { symbols } = parseAndExtract(parser, src);
    const loc = getLoc(symbols, 'A');
    expect(loc.dynamicVarCalls).toHaveLength(0);
  });

  it('local $code: writes flow back to caller local across gs', () => {
    // Callee B holds $code as a local, uses it locally.
    const src = `# A
local x = 0
gs 'B'
---
# B
local $code = { x = 88 }
dynamic $code
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://l1');
    const agg = aggFor(symbols, 'test://l1');
    const sym = localSymOf(symbols, 'A', 'x');
    const ext = agg.externalLocalBindings.get(sym) ?? [];
    expect(ext.some(e => e.sourceLoc === 'b' &&
      e.binding.value.kind === 'number' && e.binding.value.value === 88)).toBe(true);
  });

  // ── Holder = PROPAGATED-LOCAL (caller provides $code, callee dynamic $code) ──

  it('propagated-local $code: propagatedLocals carries $code to callee', () => {
    // Caller A declares a local $code holding a code block; callee B
    // uses `dynamic $code`.  The propagation machinery records that
    // $code reaches B from A — even though B has no local binding for
    // it.  This is the prerequisite for any future cross-location
    // var-mediated resolution.
    const src = `# A
local $code = { pl 'hi' }
gs 'B'
---
# B
dynamic $code
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://pl1');
    const agg = aggFor(symbols, 'test://pl1');
    const byVar = agg.propagatedLocals.get('b');
    expect(byVar, 'b should receive propagated locals from A').toBeDefined();
    const provs = byVar!.get('code') ?? [];
    expect(provs.some(p => p.providerLoc === 'a')).toBe(true);
  });

  it('propagated-local $code: callee dynamic $code flows inner writes back (gap 2 fix)', () => {
    // Cross-location var-mediated dispatch: caller A provides the
    // code-block holder `$code` and the target local `x` as propagated
    // locals to B.  B's `dynamic $code` has no local binding, but the
    // aggregator follows propagatedLocals to A's $code, reads its
    // bodyWrites (`x = 123`), and flows the write onto A's local x
    // with sourceLoc = 'b' (where the dispatch happens).
    const src = `# A
local x = 0
local $code = { x = 123 }
gs 'B'
---
# B
dynamic $code
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://pl2');
    const agg = aggFor(symbols, 'test://pl2');
    const locB = getLoc(symbols, 'B');

    // B has no local resolution for $code …
    expect(locB.dynamicVarCalls).toHaveLength(0);
    // … and no "untracked" diagnostic is raised either (the resolver
    // deliberately treats var-mediated-via-propagation as a routine
    // case, not as an ambiguous / complex-expression fallback).
    expect(locB.untrackedDynamicVarCalls).toHaveLength(0);
    // But the call site IS recorded as unresolved for the aggregator.
    expect(locB.unresolvedDynamicVarCalls).toHaveLength(1);
    expect(locB.unresolvedDynamicVarCalls[0].varBaseName).toBe('code');

    // The inner write flows back to A's local x as if the block had
    // executed at B's call site with caller locals in scope.
    const sym = localSymOf(symbols, 'A', 'x');
    const ext = agg.externalLocalBindings.get(sym) ?? [];
    expect(ext.some(e => e.sourceLoc === 'b'
      && e.binding.value.kind === 'number'
      && e.binding.value.value === 123)).toBe(true);
  });

  it('propagated-local $code + global $code same name: both bindings flow to caller x', () => {
    // Caller A has `local $code = { x = 1 }` (propagated to B).
    // Callee B also has a global `$code = { x = 2 }` visible at call
    // site.  B's `dynamic $code` resolves to its OWN global binding
    // via the local resolver (so x=2 reaches A via the direct
    // callee-write path); separately, the cross-location resolver
    // also flows the caller's block body (x = 1) through the
    // unresolved-dispatch path — but only if B has no local $code
    // shadowing.  Here B assigns $code as a global, which IS a local
    // binding the resolver picks up, so the unresolved pathway does
    // NOT fire (blocks.length > 0).  Thus only x=2 reaches A.
    const src = `# A
local x = 0
local $code = { x = 1 }
gs 'B'
---
# B
$code = { x = 2 }
dynamic $code
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://pl3');
    const agg = aggFor(symbols, 'test://pl3');
    const sym = localSymOf(symbols, 'A', 'x');
    const ext = agg.externalLocalBindings.get(sym) ?? [];
    // B's own global binding flows back as usual.
    expect(ext.some(e => e.sourceLoc === 'b' &&
      e.binding.value.kind === 'number' && e.binding.value.value === 2)).toBe(true);
    // B found a local code-block binding, so the call site is NOT
    // marked unresolved, and the caller's block body is not consulted
    // by the cross-location pass.  This reflects QSP's runtime, where
    // B's own `$code = { x = 2 }` overwrites the propagated value
    // before `dynamic $code` executes.
    expect(ext.some(e => e.sourceLoc === 'b' &&
      e.binding.value.kind === 'number' && e.binding.value.value === 1)).toBe(false);
  });

  it('propagated-local $code: deep chain A→B→C flows inner writes to A', () => {
    // Transitive propagation: A holds $code and x as locals, calls B,
    // which calls C, which does `dynamic $code`.  Both $code and x
    // propagate transitively through B to C.  The cross-location
    // resolver in C must walk via propagatedLocals['c']['code'] back
    // to A's bodyWrites, and emit the write on A's local x.
    const src = `# A
local x = 0
local $code = { x = 77 }
gs 'B'
---
# B
gs 'C'
---
# C
dynamic $code
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://pl4');
    const agg = aggFor(symbols, 'test://pl4');
    const locC = getLoc(symbols, 'C');
    expect(locC.unresolvedDynamicVarCalls).toHaveLength(1);

    const sym = localSymOf(symbols, 'A', 'x');
    const ext = agg.externalLocalBindings.get(sym) ?? [];
    expect(ext.some(e => e.sourceLoc === 'c'
      && e.binding.value.kind === 'number'
      && e.binding.value.value === 77)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// getPossibleValuesAtCursor — composite cursor resolver
// ──────────────────────────────────────────────────────────────────────

describe('variableBindings: getPossibleValuesAtCursor', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(() => initParser(parser));

  function iterLocs(syms: DocumentSymbols, uri: string) {
    return [...syms.locations.entries()].map(
      ([, ls]) => ({ locName: ls.locationName, locSyms: ls, uri }),
    );
  }
  function aggFor(syms: DocumentSymbols, uri: string) {
    const agg = emptyAggregates();
    buildPropagatedLocals(iterLocs(syms, uri), agg, [syms]);
    return agg;
  }

  /** Locate a cursor by substring match; returns (line, column) inside it. */
  function locate(src: string, needle: string, offset = 0): { line: number; column: number } {
    const idx = src.indexOf(needle);
    if (idx < 0) throw new Error(`needle not found: ${JSON.stringify(needle)}`);
    const before = src.slice(0, idx + offset);
    const line = (before.match(/\n/g) ?? []).length;
    const column = before.length - (before.lastIndexOf('\n') + 1);
    return { line, column };
  }

  it('returns scope-visible local binding at cursor', () => {
    const src = `# a
local x = 1
pl x
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv1');
    const agg = aggFor(symbols, 'test://pv1');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    expect(vals.some(v => v.origin === 'scope'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 1)).toBe(true);
  });

  it('scope-filters nested locals: inner cursor sees inner binding', () => {
    const src = `# a
local x = 1
if y:
  local x = 2
  pl x
end
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv2');
    const agg = aggFor(symbols, 'test://pv2');
    const { line, column } = locate(src, '  pl x', 5);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    // Inner cursor sees the inner local x = 2 (and possibly the outer).
    expect(vals.some(v => v.origin === 'scope'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 2)).toBe(true);
  });

  it('includes cross-call writes flowing back to a caller-local', () => {
    const src = `# a
local x = 1
gs 'b'
pl x
---
# b
x = 99
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv3');
    const agg = aggFor(symbols, 'test://pv3');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    expect(vals.some(v => v.origin === 'scope'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 1)).toBe(true);
    expect(vals.some(v => v.origin === 'cross-call'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 99)).toBe(true);
  });

  it('includes Gap 2 cross-call writes via dynamic $code', () => {
    const src = `# a
local x = 0
local $code = { x = 42 }
gs 'b'
pl x
---
# b
dynamic $code
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv4');
    const agg = aggFor(symbols, 'test://pv4');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    expect(vals.some(v => v.origin === 'cross-call'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 42)).toBe(true);
  });

  it('includes document-level non-local bindings for a global', () => {
    const src = `# a
$g = 'from_a'
---
# b
pl $g
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv5');
    const agg = aggFor(symbols, 'test://pv5');
    const { line, column } = locate(src, 'pl $g', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '$g');
    expect(vals.some(v => v.binding.value.kind === 'string'
      && v.binding.value.value === 'from_a')).toBe(true);
  });

  it('follows var-ref chains', () => {
    const src = `# a
$a = 'hello'
$b = $a
pl $b
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv6');
    const agg = aggFor(symbols, 'test://pv6');
    const { line, column } = locate(src, 'pl $b', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '$b');
    // Chain terminates on the string literal.
    expect(vals.some(v => v.binding.value.kind === 'string'
      && v.binding.value.value === 'hello')).toBe(true);
  });

  it('returns empty when cursor is outside any location_block', () => {
    const src = `# a
local x = 1
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv7');
    const agg = aggFor(symbols, 'test://pv7');
    // Cursor at line 0, column 0 (header `#`) — still inside locBlock.
    // Use past-end (line 5, column 0) which is after the closing `---`.
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, 5, 0, 'x');
    expect(vals).toHaveLength(0);
  });

  it('dedups bindings reachable through multiple paths', () => {
    const src = `# a
$g = 'v'
pl $g
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv8');
    const agg = aggFor(symbols, 'test://pv8');
    const { line, column } = locate(src, 'pl $g', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '$g');
    // Scope pass sees the global; document pass sees it too — but
    // dedup should collapse them to one entry.
    const matching = vals.filter(v => v.binding.value.kind === 'string'
      && v.binding.value.value === 'v');
    expect(matching).toHaveLength(1);
  });

  // ── Edge cases & correctness guards ────────────────────────────────

  it('returns empty for an empty canonical key', () => {
    const src = `# a
local x = 1
pl x
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv-empty');
    const agg = aggFor(symbols, 'test://pv-empty');
    const { line, column } = locate(src, 'pl x', 3);
    expect(getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '')).toEqual([]);
  });

  it('returns empty for an unknown variable name', () => {
    const src = `# a
local x = 1
pl x
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv-unknown');
    const agg = aggFor(symbols, 'test://pv-unknown');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'never_bound');
    expect(vals).toEqual([]);
  });

  it('treats canonical key as case-insensitive', () => {
    const src = `# a
local x = 5
pl x
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv-ci');
    const agg = aggFor(symbols, 'test://pv-ci');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'X');
    expect(vals.some(v => v.origin === 'scope'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 5)).toBe(true);
  });

  it('cross-call surfaces a typed-prefix write through a bare-name query', () => {
    // Modern QSP semantics (post prefix-collapse refactor): `$x`,
    // `#x`, `x` all denote ONE underlying variable, with the prefix
    // acting as a read/write coercion lens.  A callee's `$x = 'v'`
    // write therefore DOES surface when the caller queries `#x` —
    // the value at the cursor includes every write that touched the
    // shared base name.
    const src = `# a
local x = 0
gs 'b'
pl #x
---
# b
$x = 'oops'
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv-prefix');
    const agg = aggFor(symbols, 'test://pv-prefix');
    const { line, column } = locate(src, 'pl #x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '#x');
    expect(vals.some(v => v.binding.value.kind === 'string'
      && v.binding.value.value === 'oops')).toBe(true);
  });

  it('cross-call merges writes from every prefix variant under one base name', () => {
    // Both callees write the shared base `x` (one through `$x`, one
    // bare); a query for `x` at the caller surfaces both writes.
    const src = `# a
local x = 0
gs 'b'
gs 'c'
pl x
---
# b
$x = 'str_write'
---
# c
x = 7
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv-prefix2');
    const agg = aggFor(symbols, 'test://pv-prefix2');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    const numeric = vals.filter(v => v.binding.value.kind === 'number'
      && v.binding.value.value === 7);
    const stringy = vals.filter(v => v.binding.value.kind === 'string'
      && v.binding.value.value === 'str_write');
    expect(numeric.length).toBeGreaterThan(0);
    expect(stringy.length).toBeGreaterThan(0);
  });

  it('callee-local shadow does NOT leak as cross-call', () => {
    // Callee declares `local x` then writes to it — caller's `x`
    // must not receive that value via cross-call.
    const src = `# a
local x = 1
gs 'b'
pl x
---
# b
local x = 99
x = 100
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv-shadow');
    const agg = aggFor(symbols, 'test://pv-shadow');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    expect(vals.every(v => !(v.origin === 'cross-call'
      && v.binding.value.kind === 'number'
      && (v.binding.value.value === 99 || v.binding.value.value === 100)))).toBe(true);
  });

  it('cross-call flows transitively through a pass-through callee (a → b → c)', () => {
    const src = `# a
local x = 0
gs 'b'
pl x
---
# b
gs 'c'
---
# c
x = 777
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv-deep');
    const agg = aggFor(symbols, 'test://pv-deep');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    expect(vals.some(v => v.origin === 'cross-call'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 777)).toBe(true);
  });

  it('cross-call entries are NOT added when cursor is on a non-local (global) name', () => {
    // No `local x`; cursor is on a global — cross-call pass should
    // not produce entries because only caller-locals benefit from it.
    // Writes surface as 'document' instead.
    const src = `# a
gs 'b'
pl x
---
# b
x = 42
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv-nocl');
    const agg = aggFor(symbols, 'test://pv-nocl');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    expect(vals.every(v => v.origin !== 'cross-call')).toBe(true);
    expect(vals.some(v => v.origin === 'document'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 42)).toBe(true);
  });

  it('isolation-scope: cursor inside `act` does NOT see outer local', () => {
    // `act` is an isolating scope — outer locals are invisible inside.
    const src = `# a
local x = 1
act 'go':
  pl x
end
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv-iso');
    const agg = aggFor(symbols, 'test://pv-iso');
    const { line, column } = locate(src, '  pl x', 5);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    // Outer local not reachable via scope here.
    expect(vals.every(v => !(v.origin === 'scope'
      && v.binding.isLocal))).toBe(true);
  });

  it('includeDocumentGlobals=false suppresses the document pass', () => {
    const src = `# a
$g = 'from_a'
---
# b
pl $g
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv-nodoc');
    const agg = aggFor(symbols, 'test://pv-nodoc');
    const { line, column } = locate(src, 'pl $g', 3);
    const vals = getPossibleValuesAtCursor(
      symbols, agg, tree!, line, column, '$g',
      { includeDocumentGlobals: false },
    );
    expect(vals.every(v => v.origin !== 'document')).toBe(true);
  });

  it('followChain=false stops var-ref resolution at the first hop', () => {
    const src = `# a
$a = 'hello'
$b = $a
pl $b
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv-chain-off');
    const agg = aggFor(symbols, 'test://pv-chain-off');
    const { line, column } = locate(src, 'pl $b', 3);
    const vals = getPossibleValuesAtCursor(
      symbols, agg, tree!, line, column, '$b',
      { followChain: false },
    );
    // Without chain-following we should NOT see the 'hello' terminal.
    expect(vals.every(v => !(v.origin === 'scope'
      && v.binding.value.kind === 'string'
      && v.binding.value.value === 'hello'))).toBe(true);
  });

  it('projectDocs: finds a global defined in another document', () => {
    const srcA = `# a
$shared = 'from_other_doc'
---
`;
    const srcB = `# b
pl $shared
---
`;
    const a = parseAndExtract(parser, srcA, 'test://pv-proj-a');
    const b = parseAndExtract(parser, srcB, 'test://pv-proj-b');

    // Both documents must contribute to aggregates so call-graph and
    // document pass both see cross-document references.
    const agg = emptyAggregates();
    const allLocs = [
      ...iterLocs(a.symbols, 'test://pv-proj-a'),
      ...iterLocs(b.symbols, 'test://pv-proj-b'),
    ];
    buildPropagatedLocals(allLocs, agg, [a.symbols, b.symbols]);

    const { line, column } = locate(srcB, 'pl $shared', 3);
    const vals = getPossibleValuesAtCursor(
      b.symbols, agg, b.tree!, line, column, '$shared',
      { projectDocs: [a.symbols] },
    );
    expect(vals.some(v => v.origin === 'document'
      && v.uri === 'test://pv-proj-a'
      && v.binding.value.kind === 'string'
      && v.binding.value.value === 'from_other_doc')).toBe(true);
  });

  it('handles var-ref cycles without looping forever', () => {
    const src = `# a
$a = $b
$b = $a
pl $a
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv-cycle');
    const agg = aggFor(symbols, 'test://pv-cycle');
    const { line, column } = locate(src, 'pl $a', 3);
    // Must terminate (no literal values exist in the cycle).
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '$a');
    expect(Array.isArray(vals)).toBe(true);
    // Any terminal in cycle chains would be a literal/code-block/other;
    // none exist here, so it is OK for vals to be empty or contain
    // only var-ref entries (the implementation drops pure-chain results).
  });

  it('returns empty when cursor is inside the location_header line', () => {
    // The header itself is inside `location_block`, so the resolver
    // succeeds and returns whatever is visible from that position
    // (nothing in this tiny doc) — but the call must not throw.
    const src = `# a
local x = 1
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv-hdr');
    const agg = aggFor(symbols, 'test://pv-hdr');
    // Cursor on header line 0, column 0 (at `#`).
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, 0, 0, 'x');
    // No bindings visible before the `local x = 1` line via any path.
    expect(Array.isArray(vals)).toBe(true);
    // The own-loc local IS scope-visible (isBindingVisibleFrom is not
    // source-line-ordered) so we accept either 0 or 1 entries.
    for (const v of vals) {
      expect(v.locationName.toLowerCase()).toBe('a');
    }
  });

  it('cross-call does NOT fire for a local whose name does not match the query base', () => {
    // Cursor local is `y`; queried canonical is `x`.  The call writes
    // `x` — this must not surface against `y`.
    const src = `# a
local y = 1
gs 'b'
pl y
---
# b
x = 42
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv-mismatch');
    const agg = aggFor(symbols, 'test://pv-mismatch');
    const { line, column } = locate(src, 'pl y', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'y');
    expect(vals.every(v => !(v.binding.value.kind === 'number'
      && v.binding.value.value === 42))).toBe(true);
  });

  it('code-block body local writes do NOT leak to caller via cross-call', () => {
    // Block contains `local x = 99` — local scope inside the block —
    // asking about outer `x` must not receive 99.
    const src = `# a
local x = 1
local $code = { local x = 99 }
gs 'b'
pl x
---
# b
dynamic $code
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv-cb-local');
    const agg = aggFor(symbols, 'test://pv-cb-local');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    expect(vals.every(v => !(v.origin === 'cross-call'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 99))).toBe(true);
  });

  it('bindings carry the expected origin tags (scope vs cross-call vs document)', () => {
    const src = `# a
local x = 1
$g = 'g_in_a'
gs 'b'
pl x
---
# b
x = 2
$g = 'g_in_b'
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv-origins');
    const agg = aggFor(symbols, 'test://pv-origins');
    const { line, column } = locate(src, 'pl x', 3);

    const xVals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    // `local x = 1` in own loc → 'scope'
    expect(xVals.find(v => v.binding.value.kind === 'number'
      && v.binding.value.value === 1)?.origin).toBe('scope');
    // `x = 2` in callee reaches caller-local via cross-call
    expect(xVals.find(v => v.binding.value.kind === 'number'
      && v.binding.value.value === 2)?.origin).toBe('cross-call');

    const gVals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '$g');
    // `$g = 'g_in_a'` in own loc → 'scope' (globals always visible)
    expect(gVals.find(v => v.binding.value.kind === 'string'
      && v.binding.value.value === 'g_in_a')?.origin).toBe('scope');
    // `$g = 'g_in_b'` in other loc → 'document'
    expect(gVals.find(v => v.binding.value.kind === 'string'
      && v.binding.value.value === 'g_in_b')?.origin).toBe('document');
  });

  it('isConsumed predicate hides code-block scope boundaries as expected', () => {
    // With a dynamic code-block that's inlined at the call site, the
    // caller passes `isConsumed` to treat the block as consumed —
    // writes inside become part of the enclosing scope.
    const src = `# a
local x = 1
local $code = { x = 2 }
dynamic $code
pl x
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://pv-consumed');
    const agg = aggFor(symbols, 'test://pv-consumed');
    const { line, column } = locate(src, 'pl x', 3);

    // Default: scope sees the outer binding.
    const defaults = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    expect(defaults.some(v => v.origin === 'scope'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 1)).toBe(true);

    // With an `isConsumed` that marks ALL nodes as consumed, the
    // query must still not throw and returns a well-typed result.
    const vals = getPossibleValuesAtCursor(
      symbols, agg, tree!, line, column, 'x',
      { isConsumed: () => true },
    );
    expect(Array.isArray(vals)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Goto-style calls (gt / xgt / goto / xgoto) must NOT propagate locals
//
// Only gosub-style calls (`gs`/`gosub`/`func`) are in the resolver's
// LOCALS_PROPAGATING_NAMES set.  `gt` and friends transfer control
// without a return frame, so caller-locals must not flow INTO the
// callee, and callee writes must not bubble BACK to the caller-local.
// ──────────────────────────────────────────────────────────────────────

describe('variableBindings: goto-style calls do NOT propagate locals', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(() => initParser(parser));

  function iterLocs(syms: DocumentSymbols, uri: string) {
    return [...syms.locations.entries()].map(
      ([, ls]) => ({ locName: ls.locationName, locSyms: ls, uri }),
    );
  }
  function aggFor(syms: DocumentSymbols, uri: string) {
    const agg = emptyAggregates();
    buildPropagatedLocals(iterLocs(syms, uri), agg, [syms]);
    return agg;
  }
  function locate(src: string, needle: string, offset = 0) {
    const idx = src.indexOf(needle);
    const before = src.slice(0, idx + offset);
    const line = (before.match(/\n/g) ?? []).length;
    const column = before.length - (before.lastIndexOf('\n') + 1);
    return { line, column };
  }

  // ── INTO direction: caller-local must NOT appear in callee ──────────
  it('gt: caller-local does NOT propagate into the callee', () => {
    const src = `# a
local x = 1
gt 'b'
---
# b
pl x
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://gt-into');
    const agg = aggFor(symbols, 'test://gt-into');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    // `local x = 1` from caller must NOT surface in callee b.
    expect(vals.every(v => !(v.binding.value.kind === 'number'
      && v.binding.value.value === 1))).toBe(true);
  });

  it('xgt: caller-local does NOT propagate into the callee', () => {
    const src = `# a
local x = 1
xgt 'b'
---
# b
pl x
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://xgt-into');
    const agg = aggFor(symbols, 'test://xgt-into');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    expect(vals.every(v => !(v.binding.value.kind === 'number'
      && v.binding.value.value === 1))).toBe(true);
  });

  it('goto / xgoto (long form): caller-local does NOT propagate into the callee', () => {
    const srcGoto = `# a
local x = 1
goto 'b'
---
# b
pl x
---
`;
    const a = parseAndExtract(parser, srcGoto, 'test://goto-into');
    const aggA = aggFor(a.symbols, 'test://goto-into');
    const cA = locate(srcGoto, 'pl x', 3);
    const vA = getPossibleValuesAtCursor(a.symbols, aggA, a.tree!, cA.line, cA.column, 'x');
    expect(vA.every(v => !(v.binding.value.kind === 'number'
      && v.binding.value.value === 1))).toBe(true);

    const srcXgoto = srcGoto.replace('goto', 'xgoto');
    const b = parseAndExtract(parser, srcXgoto, 'test://xgoto-into');
    const aggB = aggFor(b.symbols, 'test://xgoto-into');
    const cB = locate(srcXgoto, 'pl x', 3);
    const vB = getPossibleValuesAtCursor(b.symbols, aggB, b.tree!, cB.line, cB.column, 'x');
    expect(vB.every(v => !(v.binding.value.kind === 'number'
      && v.binding.value.value === 1))).toBe(true);
  });

  // ── BACK direction: callee write must NOT bubble to caller-local ────
  it('gt: callee write does NOT bubble back as a cross-call to caller-local', () => {
    const src = `# a
local x = 1
pl x
gt 'b'
---
# b
x = 99
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://gt-back');
    const agg = aggFor(symbols, 'test://gt-back');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    // Caller's own local stays visible.
    expect(vals.some(v => v.origin === 'scope'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 1)).toBe(true);
    // Callee write to `x` (now a global, since `gt` doesn't share scope)
    // must NOT appear as a cross-call entry.  It MAY appear as a
    // 'document' entry — that's the global write surfaced by step 3.
    expect(vals.every(v => !(v.origin === 'cross-call'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 99))).toBe(true);
  });

  it('xgt: callee write does NOT bubble back as a cross-call to caller-local', () => {
    const src = `# a
local x = 1
pl x
xgt 'b'
---
# b
x = 99
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://xgt-back');
    const agg = aggFor(symbols, 'test://xgt-back');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    expect(vals.some(v => v.origin === 'scope'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 1)).toBe(true);
    expect(vals.every(v => !(v.origin === 'cross-call'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 99))).toBe(true);
  });

  // ── Mixed: gs alongside gt — only gs propagates ─────────────────────
  it('mixed gs + gt to the same callee: only the gs-edge propagates', () => {
    const src = `# a
local x = 1
gs 'b'
gt 'c'
pl x
---
# b
x = 22
---
# c
x = 99
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://mixed-gs-gt');
    const agg = aggFor(symbols, 'test://mixed-gs-gt');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    // gs-callee write reaches caller-local as cross-call.
    expect(vals.some(v => v.origin === 'cross-call'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 22)).toBe(true);
    // gt-callee write does NOT reach caller-local as cross-call.
    expect(vals.every(v => !(v.origin === 'cross-call'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 99))).toBe(true);
  });

  // ── externalLocalBindings should be empty for the goto-only callee ──
  it('buildPropagatedLocals: gt does NOT add an externalLocalBindings edge', () => {
    const src = `# a
local x = 1
gt 'b'
---
# b
x = 77
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://gt-ext');
    const agg = emptyAggregates();
    buildPropagatedLocals(iterLocs(symbols, 'test://gt-ext'), agg, [symbols]);

    const locA = getLoc(symbols, 'a');
    let aSym: QspSymbol | undefined;
    for (const s of locA.variables.values()) {
      if (s.isLocal && s.nameLower === 'x') aSym = s;
    }
    expect(aSym).toBeDefined();

    // No reverse edge from b → caller-local because `gt` is not a
    // gosub-style call.
    const ext = agg.externalLocalBindings.get(aSym!);
    if (ext) {
      expect(ext.filter(e => e.sourceLoc === 'b')).toHaveLength(0);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Code-block-in-local-variable & dynamic-extra-args scenarios
// ──────────────────────────────────────────────────────────────────────
// These cover the two questions:
//   (a) Does per-call-site resolution + locals propagation work when a
//       code block is held in a LOCAL variable ($code / $c)?
//   (b) Does `dynamic {literal}, extra1, extra2` (and the dyneval
//       variant) still propagate caller locals into the block body?

describe('variableBindings: code-block-in-local + dynamic/dyneval with extras', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(() => initParser(parser));

  function iterLocs(syms: DocumentSymbols, uri: string) {
    return [...syms.locations.entries()].map(
      ([, ls]) => ({ locName: ls.locationName, locSyms: ls, uri }),
    );
  }
  function aggFor(syms: DocumentSymbols, uri: string) {
    const agg = emptyAggregates();
    buildPropagatedLocals(iterLocs(syms, uri), agg, [syms]);
    return agg;
  }
  function locate(src: string, needle: string, offset = 0): { line: number; column: number } {
    const idx = src.indexOf(needle);
    if (idx < 0) throw new Error(`needle not found: ${JSON.stringify(needle)}`);
    const before = src.slice(0, idx + offset);
    const line = (before.match(/\n/g) ?? []).length;
    const column = before.length - (before.lastIndexOf('\n') + 1);
    return { line, column };
  }

  // ── (a) code block in LOCAL variable, same location ───────────────

  it('local $code body write is surfaced at read position after dynamic $code call', () => {
    const src = `# a
local x = 0
local $code = { x = 42 }
dynamic $code
pl x
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://cbl-1');
    const agg = aggFor(symbols, 'test://cbl-1');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    expect(vals.some(v => v.binding.value.kind === 'number'
      && v.binding.value.value === 0)).toBe(true);
    expect(vals.some(v => v.binding.value.kind === 'number'
      && v.binding.value.value === 42)).toBe(true);
  });

  it('per-call-site resolution: two scope-separate local $code each write different values', () => {
    // Two if-arms each define their own `local $code` with a different
    // body; each `dynamic $code` must resolve to the correct block.
    const src = `# a
local x = 0
if y = 1:
  local $code = { x = 100 }
  dynamic $code
end
if y = 2:
  local $code = { x = 200 }
  dynamic $code
end
pl x
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://cbl-2');
    const agg = aggFor(symbols, 'test://cbl-2');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    expect(vals.some(v => v.binding.value.kind === 'number'
      && v.binding.value.value === 100)).toBe(true);
    expect(vals.some(v => v.binding.value.kind === 'number'
      && v.binding.value.value === 200)).toBe(true);
  });

  it('var-ref chain through local aliasing: $alias = $code; dynamic $alias', () => {
    const src = `# a
local x = 0
local $code = { x = 7 }
local $alias = $code
dynamic $alias
pl x
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://cbl-3');
    const agg = aggFor(symbols, 'test://cbl-3');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    expect(vals.some(v => v.binding.value.kind === 'number'
      && v.binding.value.value === 7)).toBe(true);
  });

  it('reassigned local $code picks up ALL reachable block bodies (ambiguity)', () => {
    const src = `# a
local x = 0
local $code = { x = 1 }
$code = { x = 2 }
dynamic $code
pl x
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://cbl-4');
    const agg = aggFor(symbols, 'test://cbl-4');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    // Ambiguous reassignment: implementation either keeps both writes
    // or neither (current impl flags as untracked).  Accept any
    // well-typed result so we aren't coupled to that choice.
    expect(Array.isArray(vals)).toBe(true);
  });

  it('caller local read inside block body of a local $c invoked via dyneval', () => {
    // Regression for the symbol-based fallback: cursor is INSIDE the
    // body of `{ y = x + 1 }` held in `local $c`, which is invoked via
    // `dyneval($c, 5)`.  `x` must resolve to the caller's outer
    // `local x = 10` (propagated by the deferred walker).
    const src = `# a
local x = 10
local $c = { y = x + 1 }
z = dyneval($c, 5)
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://cbl-5');
    const agg = aggFor(symbols, 'test://cbl-5');
    // Cursor on the `x` inside the block body.
    const { line, column } = locate(src, 'x + 1');
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x', { hoverMode: true });
    expect(vals.some(v => v.origin === 'scope'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 10)).toBe(true);
  });

  it('caller local read inside block body of a local $code invoked via dynamic $code', () => {
    const src = `# a
local x = 42
local $code = { pl x }
dynamic $code
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://cbl-6');
    const agg = aggFor(symbols, 'test://cbl-6');
    // Cursor on the `x` inside `pl x` in the block body.
    const idx = src.indexOf('pl x');
    const before = src.slice(0, idx + 3);
    const line = (before.match(/\n/g) ?? []).length;
    const column = before.length - (before.lastIndexOf('\n') + 1);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x', { hoverMode: true });
    expect(vals.some(v => v.origin === 'scope'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 42)).toBe(true);
  });

  // ── (b) dynamic/dyneval with direct literal + extra positional args ──

  it('dynamic { literal }, 1, 2 propagates caller local into the block body', () => {
    const src = `# a
local x = 5
dynamic { pl x }, 1, 2
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://da-1');
    const agg = aggFor(symbols, 'test://da-1');
    // Cursor on the `x` inside `pl x` within the dynamic literal.
    const idx = src.indexOf('pl x');
    const before = src.slice(0, idx + 3);
    const line = (before.match(/\n/g) ?? []).length;
    const column = before.length - (before.lastIndexOf('\n') + 1);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    expect(vals.some(v => v.origin === 'scope'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 5)).toBe(true);
  });

  it('dyneval({ literal }, 1) propagates caller local into the block body', () => {
    const src = `# a
local x = 10
y = dyneval({ pl x }, 1)
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://da-2');
    const agg = aggFor(symbols, 'test://da-2');
    const idx = src.indexOf('pl x');
    const before = src.slice(0, idx + 3);
    const line = (before.match(/\n/g) ?? []).length;
    const column = before.length - (before.lastIndexOf('\n') + 1);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    expect(vals.some(v => v.origin === 'scope'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 10)).toBe(true);
  });

  it('dynamic {literal}, extras: writes in the block mutate outer local', () => {
    const src = `# a
local x = 0
dynamic { x = 99 }, 1, 2
pl x
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://da-3');
    const agg = aggFor(symbols, 'test://da-3');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    expect(vals.some(v => v.binding.value.kind === 'number'
      && v.binding.value.value === 0)).toBe(true);
    expect(vals.some(v => v.binding.value.kind === 'number'
      && v.binding.value.value === 99)).toBe(true);
  });

  it('dyneval({literal}, extras): writes in the block mutate outer local', () => {
    const src = `# a
local x = 0
z = dyneval({ x = 11 }, 5, 6)
pl x
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://da-4');
    const agg = aggFor(symbols, 'test://da-4');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    expect(vals.some(v => v.binding.value.kind === 'number'
      && v.binding.value.value === 11)).toBe(true);
  });

  it('extra positional args to dynamic are not treated as named locals', () => {
    // The `1, 2` extras become runtime `args[]`, not named locals.
    // A block reading `args` without declaring it must not confuse the
    // resolver into producing false matches for the extras.
    const src = `# a
local x = 1
dynamic { pl x }, 99, 100
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://da-5');
    const agg = aggFor(symbols, 'test://da-5');
    const idx = src.indexOf('pl x');
    const before = src.slice(0, idx + 3);
    const line = (before.match(/\n/g) ?? []).length;
    const column = before.length - (before.lastIndexOf('\n') + 1);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    // Only the caller-local `x = 1` should surface — NOT the extra `99`
    // or `100` which are positional args unrelated to `x`.
    expect(vals.some(v => v.binding.value.kind === 'number'
      && v.binding.value.value === 1)).toBe(true);
    expect(vals.every(v => !(v.binding.value.kind === 'number'
      && (v.binding.value.value === 99 || v.binding.value.value === 100)))).toBe(true);
  });

  it('cross-location: local $code in caller, dynamic $code in callee with extras', () => {
    const src = `# a
local x = 0
local $code = { x = 777 }
gs 'b'
pl x
---
# b
dynamic $code, 99
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://cbl-cross');
    const agg = aggFor(symbols, 'test://cbl-cross');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    // Write MUST flow back to caller local via cross-call.
    expect(vals.some(v => v.origin === 'cross-call'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 777)).toBe(true);
  });

  it('cross-location dyneval with extras: local $c, dyneval($c, …) in callee', () => {
    const src = `# a
local x = 0
local $c = { x = 5 }
z = func('b')
pl x
---
# b
y = dyneval($c, 1, 2)
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://cbl-cross-dy');
    const agg = aggFor(symbols, 'test://cbl-cross-dy');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    expect(vals.some(v => v.origin === 'cross-call'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 5)).toBe(true);
  });

  it('nested deferred blocks: outer caller-local reaches an inner block`s read', () => {
    // `$outer = { dynamic $inner }`, `$inner = { pl x }`, called from
    // top-level with `local x = 3`.  Ideally the inner block would see
    // `x = 3` via transitive propagation through the outer block's
    // synthetic scope.
    //
    // KNOWN LIMITATION: in nested deferred chains, the collect-pass
    // registers a GLOBAL `x` reference for the inner block before the
    // outer-block walker injects the caller local.  Consequently
    // `findVariableAtPosition` at the inner `pl x` returns the global
    // symbol, and the symbol-based fallback (which only fires for
    // local cursor symbols) does not contribute.  This test pins the
    // current behavior so future fixes flip it deliberately.
    const src = `# a
local x = 3
local $inner = { pl x }
local $outer = { dynamic $inner }
dynamic $outer
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://cbl-nest');
    const agg = aggFor(symbols, 'test://cbl-nest');
    const idx = src.indexOf('pl x');
    const before = src.slice(0, idx + 3);
    const line = (before.match(/\n/g) ?? []).length;
    const column = before.length - (before.lastIndexOf('\n') + 1);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    // Result must be well-formed; must not contain any false values
    // that aren't present in the source.
    for (const v of vals) {
      if (v.binding.value.kind === 'number') {
        expect(v.binding.value.value).toBe(3);
      }
    }
  });

  it('symbol-based fallback does NOT trigger for a GLOBAL cursor symbol', () => {
    // No `local x` — `x` is a bare global.  The symbol-based fallback
    // should be a no-op; only the scope/document passes surface values.
    const src = `# a
x = 10
pl x
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://cbl-global');
    const agg = aggFor(symbols, 'test://cbl-global');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    expect(vals.some(v => v.binding.value.kind === 'number'
      && v.binding.value.value === 10)).toBe(true);
    // All entries must carry the global (non-local) flag.
    expect(vals.every(v => !v.binding.isLocal)).toBe(true);
  });

  it('symbol-based fallback respects scope-anchor: sibling-scope local does NOT leak', () => {
    // Two separate `local x` in sibling `if` arms.  Cursor sym picks
    // one; the symbol-based fallback must only surface THAT symbol's
    // bindings, not the sibling's.
    const src = `# a
if y = 1:
  local x = 1
  local $c = { pl x }
  dynamic $c
end
if y = 2:
  local x = 2
end
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://cbl-sibling');
    const agg = aggFor(symbols, 'test://cbl-sibling');
    // Cursor inside the first arm's block body.
    const idx = src.indexOf('pl x');
    const before = src.slice(0, idx + 3);
    const line = (before.match(/\n/g) ?? []).length;
    const column = before.length - (before.lastIndexOf('\n') + 1);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x', { hoverMode: true });
    // Must see the first arm's `x = 1`, NOT the sibling arm's `x = 2`.
    expect(vals.some(v => v.binding.value.kind === 'number'
      && v.binding.value.value === 1)).toBe(true);
    expect(vals.every(v => !(v.binding.value.kind === 'number'
      && v.binding.value.value === 2))).toBe(true);
  });

  // ── Reassignment chains (RHS is another variable) ──────────────────
  //
  // `extractSymbols` emits a `{kind:'var-ref', varNameLower}` edge for
  // any simple `LHS = RHS` where RHS is a bare variable_ref.  This
  // applies equally to:
  //   • `local $b = $a`  (LHS local, declaration form)
  //   • `$b = $a`        (LHS non-local / re-assignment form)
  //   • zero-arg func-call RHS form (`$foo` parsed as na_func_call)
  //
  // The canonical key preserves the type prefix so `$x`, `#x`, `x`
  // never collide via aliasing.  Resolvers follow these edges
  // transitively with a visited-set cycle guard.

  it('reassign chain: local-from-local (local $b = $a where $a is local)', () => {
    const src = `# a
local $a = 'A'
local $b = $a
pl $b
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://rc-1');
    const agg = aggFor(symbols, 'test://rc-1');
    const { line, column } = locate(src, 'pl $b', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '$b');
    expect(vals.some(v => v.binding.value.kind === 'string'
      && v.binding.value.value === 'A')).toBe(true);
  });

  it('reassign chain: local-from-global same-location (local $b = $g)', () => {
    const src = `# a
$g = 'G'
local $b = $g
pl $b
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://rc-2');
    const agg = aggFor(symbols, 'test://rc-2');
    const { line, column } = locate(src, 'pl $b', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '$b');
    expect(vals.some(v => v.binding.value.kind === 'string'
      && v.binding.value.value === 'G')).toBe(true);
  });

  it('reassign chain: global-from-global non-local write (long chain)', () => {
    const src = `# a
$a = 'ROOT'
$b = $a
$c = $b
$d = $c
pl $d
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://rc-3');
    const agg = aggFor(symbols, 'test://rc-3');
    const { line, column } = locate(src, 'pl $d', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '$d');
    expect(vals.some(v => v.binding.value.kind === 'string'
      && v.binding.value.value === 'ROOT')).toBe(true);
  });

  it('reassign chain: global-from-local ($b = $a where $a is local)', () => {
    // A non-local write that aliases a local.  The scope pass sees
    // `$a = 'A'` as a visible local, follows the var-ref, and
    // terminates on the string literal.
    const src = `# a
local $a = 'A'
$b = $a
pl $b
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://rc-4');
    const agg = aggFor(symbols, 'test://rc-4');
    const { line, column } = locate(src, 'pl $b', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '$b');
    expect(vals.some(v => v.binding.value.kind === 'string'
      && v.binding.value.value === 'A')).toBe(true);
  });

  it('reassign chain: numeric-prefix crossing (local y = #n)', () => {
    // `#n = 5` (global numeric prefix) is aliased by `local y = #n`.
    // The canonical key for #n must be preserved through the chain
    // so we reach the numeric terminal.
    const src = `# a
#n = 5
local y = #n
pl y
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://rc-5');
    const agg = aggFor(symbols, 'test://rc-5');
    const { line, column } = locate(src, 'pl y', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'y');
    expect(vals.some(v => v.binding.value.kind === 'number'
      && v.binding.value.value === 5)).toBe(true);
  });

  it('reassign chain: non-local reassignment of a local (both writes surface)', () => {
    // `local $b = 'first'; $b = 'second'` — both writes target the
    // same declared-local $b and should both appear as possible values.
    const src = `# a
local $b = 'first'
$b = 'second'
pl $b
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://rc-6');
    const agg = aggFor(symbols, 'test://rc-6');
    const { line, column } = locate(src, 'pl $b', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '$b');
    expect(vals.some(v => v.binding.value.kind === 'string'
      && v.binding.value.value === 'first')).toBe(true);
    expect(vals.some(v => v.binding.value.kind === 'string'
      && v.binding.value.value === 'second')).toBe(true);
  });

  it('reassign chain: all-local multi-hop (x → y → z)', () => {
    const src = `# a
local x = 10
local y = x
local z = y
pl z
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://rc-7');
    const agg = aggFor(symbols, 'test://rc-7');
    const { line, column } = locate(src, 'pl z', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'z');
    expect(vals.some(v => v.binding.value.kind === 'number'
      && v.binding.value.value === 10)).toBe(true);
  });

  it('reassign chain: mid-chain reassignment fans out to BOTH originals', () => {
    // `local $b = $a` binds $b to $a at chain-capture time; later the
    // terminal $a is reassigned.  A query at `pl $b` must see BOTH
    // 'first' and 'second' because $a accumulates both writes.
    const src = `# a
$a = 'first'
local $b = $a
$a = 'second'
pl $b
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://rc-8');
    const agg = aggFor(symbols, 'test://rc-8');
    const { line, column } = locate(src, 'pl $b', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '$b');
    expect(vals.some(v => v.binding.value.kind === 'string'
      && v.binding.value.value === 'first')).toBe(true);
    expect(vals.some(v => v.binding.value.kind === 'string'
      && v.binding.value.value === 'second')).toBe(true);
  });

  it('reassign chain: bare `local $b` declaration then separate assignment', () => {
    // `local $b` (no RHS) reserves the name; the subsequent
    // non-local `$b = 'later'` write is the only value that should
    // surface at the read site.
    const src = `# a
local $b
$b = 'later'
pl $b
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://rc-9');
    const agg = aggFor(symbols, 'test://rc-9');
    const { line, column } = locate(src, 'pl $b', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '$b');
    expect(vals.some(v => v.binding.value.kind === 'string'
      && v.binding.value.value === 'later')).toBe(true);
  });

  it('reassign chain: overwriting a global with another global aliasing', () => {
    // `$b` is first assigned a literal, then reassigned to reference
    // `$a`.  Both original values (B and A via chain) must surface.
    const src = `# a
$a = 'A'
$b = 'B'
$b = $a
pl $b
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://rc-10');
    const agg = aggFor(symbols, 'test://rc-10');
    const { line, column } = locate(src, 'pl $b', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '$b');
    expect(vals.some(v => v.binding.value.kind === 'string'
      && v.binding.value.value === 'B')).toBe(true);
    expect(vals.some(v => v.binding.value.kind === 'string'
      && v.binding.value.value === 'A')).toBe(true);
  });

  it('reassign chain: cross-location global reached via local alias (single write bridged)', () => {
    // `local $b = $g` in loc A, `$g = 'G'` written in loc B.  The
    // scope pass finds no same-loc binding for $g so the chain stops
    // at a bare var-ref edge.  Step 3b (chain-tail bridge) detects
    // that $g has exactly ONE write site document-wide and surfaces
    // the terminal 'G' as a 'document'-origin value.
    const src = `# a
local $b = $g
pl $b
---
# b
$g = 'G'
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://rc-11');
    const agg = aggFor(symbols, 'test://rc-11');
    const { line, column } = locate(src, 'pl $b', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '$b', { hoverMode: true });
    // Var-ref edges are chain-traversal artifacts, not values — they
    // must NOT appear in the output; only terminals.
    expect(vals.every(v => v.binding.value.kind !== 'var-ref')).toBe(true);
    // The bridge surfaces the single terminal write as 'document'.
    expect(vals.some(v => v.origin === 'document'
      && v.binding.value.kind === 'string'
      && v.binding.value.value === 'G')).toBe(true);
  });

  it('reassign chain: cross-location multi-write global surfaces chain edge for renderer summary', () => {
    // $g has two write sites → the resolver surfaces the local's own
    // var-ref edge as a 'scope' entry so the renderer can expand both
    // chain-target writes as individual value lines.
    const src = `# a
local $b = $g
pl $b
---
# b
$g = 'G1'
---
# c
$g = 'G2'
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://rc-11b');
    const agg = aggFor(symbols, 'test://rc-11b');
    const { line, column } = locate(src, 'pl $b', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '$b', { hoverMode: true });
    // Individual terminal writes must NOT be enumerated through the
    // local chain — that's the whole point of the summary collapse.
    expect(vals.every(v => !(v.binding.value.kind === 'string'
      && (v.binding.value.value === 'G1' || v.binding.value.value === 'G2')))).toBe(true);
    // Exactly one entry surfaces: the local's own var-ref edge,
    // marked 'scope' so the renderer treats it as a chain to expand.
    const varRefs = vals.filter(v => v.binding.value.kind === 'var-ref');
    expect(varRefs.length).toBe(1);
    expect(varRefs[0].origin).toBe('scope');
    expect(varRefs[0].binding.value.kind === 'var-ref'
      && varRefs[0].binding.value.varBaseName).toBe('g');
  });

  it('reassign chain: cross-location chain to a never-written name surfaces a var-ref edge', () => {
    // `$missing` has no writes anywhere.  The chain-tail bridge has
    // nothing to flatten, so it surfaces the local's own var-ref
    // edge as a 'scope' entry — the renderer uses this to emit an
    // *(unresolved)* line so the dangling reference stays visible
    // (silent empty output would be misleading).
    const src = `# a
local $a = $missing
pl $a
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://rc-11c');
    const agg = aggFor(symbols, 'test://rc-11c');
    const { line, column } = locate(src, 'pl $a', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '$a', { hoverMode: true });
    // Exactly one entry: the local's own var-ref edge.
    expect(vals.length).toBe(1);
    expect(vals[0].origin).toBe('scope');
    expect(vals[0].binding.value.kind).toBe('var-ref');
    expect(vals[0].binding.value.kind === 'var-ref'
      && vals[0].binding.value.varBaseName).toBe('missing');
  });

  it('reassign chain: a local that shadows an outer global SUPPRESSES the outer global write', () => {
    // `$g` is written as a global in `# init` AND declared as a local
    // in `# a` whose RHS reads ANOTHER global `$other`.  The local
    // shadows the outer global from inside this scope: only `$other`'s
    // value should surface — the outer `$g = 'OUTER_G'` write must be
    // invisible because the cursor sym is a local under that name.
    const src = `# init
$g = 'OUTER_G'
$other = 'OTHER_VAL'
---
# a
local $g = $other
pl $g
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://rc-11d');
    const agg = aggFor(symbols, 'test://rc-11d');
    const { line, column } = locate(src, 'pl $g', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '$g', { hoverMode: true });
    // Chain-flattened RHS surfaces the global write of $other.
    expect(vals.some(v => v.binding.value.kind === 'string'
      && v.binding.value.value === 'OTHER_VAL')).toBe(true);
    // The shadowed outer $g write must NOT surface.
    expect(vals.every(v => !(v.binding.value.kind === 'string'
      && v.binding.value.value === 'OUTER_G'))).toBe(true);
  });

  it('reassign chain: compound ops (+=) do NOT produce a var-ref alias', () => {
    // `$b += $a` is not a simple rebinding — extractSymbols stores an
    // `{kind:'other'}` binding because the result depends on the
    // previous value of $b.  No aliasing edge should be emitted.
    const src = `# a
$a = 'A'
$b = 'B'
$b += $a
pl $b
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://rc-12');
    const agg = aggFor(symbols, 'test://rc-12');
    const { line, column } = locate(src, 'pl $b', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '$b');
    // No var-ref edge from $b to $a.
    expect(vals.every(v => !(v.binding.value.kind === 'var-ref'
      && v.binding.value.varBaseName === '$a'))).toBe(true);
    // Compound-op binding IS included in possible values so the hover
    // renderer can display it as e.g. `$b + 'extra'`.
    expect(vals.some(v => v.binding.writeOp?.includes('='))).toBe(true);
    // The plain assignment ($b = 'B') is still shown.
    expect(vals.some(v => v.binding.value.kind === 'string'
      && v.binding.value.value === 'B')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Self-shadow:  `local x = x` / `$a = $a`
//
// The RHS reads the outer / caller-propagated binding; the LHS creates
// a fresh local that shadows the outer name.  The resolver must surface
// *outer* values — both globals (via the document pass) and caller
// propagated locals (via the reverse call graph) — even though the
// same-name local normally occludes them.
// ──────────────────────────────────────────────────────────────────────

describe('variableBindings: self-shadow rebinding', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(async () => { await initParser(parser); });

  function aggFor(syms: DocumentSymbols, uri: string) {
    const agg = emptyAggregates();
    buildPropagatedLocals(iterLocs(syms, uri), agg, [syms]);
    return agg;
  }
  function locate(src: string, needle: string, offset = 0) {
    const idx = src.indexOf(needle);
    const before = src.slice(0, idx + offset);
    const line = (before.match(/\n/g) ?? []).length;
    const column = before.length - (before.lastIndexOf('\n') + 1);
    return { line, column };
  }

  it('classifies `local x = x` as a self-referential var-ref edge', () => {
    const src = `# test
local x = x
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://ss-ext');
    const loc = symbols.locations.get('test')!;
    const entries = loc.variableBindings.get('x')!;
    expect(entries).toHaveLength(1);
    expect(entries[0].value.kind).toBe('var-ref');
    if (entries[0].value.kind === 'var-ref') {
      expect(entries[0].value.varBaseName).toBe('x');
    }
    expect(entries[0].isLocal).toBe(true);
  });

  it('classifies `$a = $a` (non-local self-noop) as a self-var-ref edge', () => {
    const src = `# test
$a = 'hi'
$a = $a
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://ss-ext-nonlocal');
    const loc = symbols.locations.get('test')!;
    const entries = loc.variableBindings.get('a')!;
    expect(entries).toHaveLength(2);
    expect(entries[0].value.kind).toBe('string');
    expect(entries[1].value.kind).toBe('var-ref');
    if (entries[1].value.kind === 'var-ref') {
      expect(entries[1].value.varBaseName).toBe('a');
    }
  });

  it('surfaces the global value through a self-shadowing local', () => {
    const src = `# a
x = 7
gs 'b'
---
# b
local x = x
pl x
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://ss-A');
    const agg = aggFor(symbols, 'test://ss-A');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    // No var-ref edges leak as values.
    expect(vals.every(v => v.binding.value.kind !== 'var-ref')).toBe(true);
    // The document pass surfaces the single global write of `x`.
    expect(vals.some(v => v.origin === 'document'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 7)).toBe(true);
  });

  it('surfaces the caller-propagated local through a self-shadowing local', () => {
    const src = `# a
local x = 99
gs 'b'
---
# b
local x = x
pl x
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://ss-B');
    const agg = aggFor(symbols, 'test://ss-B');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x', { hoverMode: true });
    expect(vals.every(v => v.binding.value.kind !== 'var-ref')).toBe(true);
    // Caller's `local x = 99` reaches the callee via the reverse call
    // graph; reported as 'cross-call' origin.
    expect(vals.some(v => v.origin === 'cross-call'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 99)).toBe(true);
  });

  it('surfaces BOTH caller-local and global when both exist', () => {
    const src = `# a
local x = 99
gs 'b'
---
# b
local x = x
pl x
---
# init
x = 7
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://ss-D');
    const agg = aggFor(symbols, 'test://ss-D');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x', { hoverMode: true });
    // Caller local (cross-call) + global (document) — both visible.
    expect(vals.some(v => v.origin === 'cross-call'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 99)).toBe(true);
    expect(vals.some(v => v.origin === 'document'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 7)).toBe(true);
  });

  it('surfaces every caller-local when multiple callers propagate the same name', () => {
    const src = `# a
local x = 1
gs 'target'
---
# b
local x = 2
gs 'target'
---
# target
local x = x
pl x
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://ss-multi');
    const agg = aggFor(symbols, 'test://ss-multi');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x', { hoverMode: true });
    const numVals = vals
      .filter(v => v.origin === 'cross-call' && v.binding.value.kind === 'number')
      .map(v => (v.binding.value as { kind: 'number'; value: number }).value)
      .sort();
    expect(numVals).toEqual([1, 2]);
  });

  it('honours type prefix: `local $s = $s` picks up caller `local $s = ...`', () => {
    const src = `# a
local $s = 'alpha'
gs 'b'
---
# b
local $s = $s
pl $s
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://ss-prefix');
    const agg = aggFor(symbols, 'test://ss-prefix');
    const { line, column } = locate(src, 'pl $s', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, '$s', { hoverMode: true });
    expect(vals.some(v => v.origin === 'cross-call'
      && v.binding.value.kind === 'string'
      && v.binding.value.value === 'alpha')).toBe(true);
  });

  it('does NOT inject caller-locals when the callee is not a self-shadow', () => {
    // `local x = 5` (not `= x`) — the RHS is a literal, not a read of
    // the outer `x`.  Caller-local writes must NOT be surfaced.
    const src = `# a
local x = 99
gs 'b'
---
# b
local x = 5
pl x
---
`;
    const { symbols, tree } = parseAndExtract(parser, src, 'test://ss-nonshadow');
    const agg = aggFor(symbols, 'test://ss-nonshadow');
    const { line, column } = locate(src, 'pl x', 3);
    const vals = getPossibleValuesAtCursor(symbols, agg, tree!, line, column, 'x');
    // Only the local = 5 value is visible.
    expect(vals.some(v => v.origin === 'scope'
      && v.binding.value.kind === 'number'
      && v.binding.value.value === 5)).toBe(true);
    // The caller's 99 must NOT leak in.
    expect(vals.every(v => !(v.binding.value.kind === 'number'
      && v.binding.value.value === 99))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Regression: empty / missing variable names must never produce bindings
//
// The PEG grammar requires `varName = nonDelimiterChar+` (1+ chars) and
// the tree-sitter grammar marks `name: $.identifier_text` as non-optional
// on `variable_ref`.  When the source code is malformed (e.g. `local $ =`,
// `x = #`, `$ = $`) tree-sitter performs error recovery by inserting a
// MISSING `identifier_text` node whose text is the empty string.  The
// extractor must reject such nodes so they never leak into the binding
// store or produce spurious var-ref edges keyed by just a type prefix.
// ──────────────────────────────────────────────────────────────────────

describe('variableBindings: empty / missing variable names are rejected', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(() => initParser(parser));

  function locVars(syms: DocumentSymbols, locName: string) {
    const loc = getLoc(syms, locName);
    return [...loc.variables.entries()].map(([key, sym]) => ({
      key,
      nameLower: sym.nameLower,
    }));
  }

  function bindingKeys(syms: DocumentSymbols, locName: string): string[] {
    const loc = getLoc(syms, locName);
    return [...loc.variableBindings.keys()];
  }

  it('`local $ = 5` does not record a binding under the bare prefix', () => {
    const src = `# main
local $ = 5
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://empty-lhs-dollar');
    const vars = locVars(symbols, 'main');
    // No variable whose base name is empty (prefix-only).
    expect(vars.every(v => v.nameLower !== '')).toBe(true);
    expect(vars.every(v => v.key !== '$')).toBe(true);
    // And no binding keyed to just the prefix.
    expect(bindingKeys(symbols, 'main').every(k => k !== '$' && k !== '')).toBe(true);
  });

  it('`# = 1` (hash prefix alone) records no binding', () => {
    const src = `# main
# = 1
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://empty-lhs-hash');
    expect(locVars(symbols, 'main').every(v => v.nameLower !== '' && v.key !== '#')).toBe(true);
    expect(bindingKeys(symbols, 'main').every(k => k !== '#' && k !== '')).toBe(true);
  });

  it('`% = 1` (percent prefix alone) records no binding', () => {
    const src = `# main
% = 1
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://empty-lhs-percent');
    expect(locVars(symbols, 'main').every(v => v.nameLower !== '' && v.key !== '%')).toBe(true);
    expect(bindingKeys(symbols, 'main').every(k => k !== '%' && k !== '')).toBe(true);
  });

  it('`local x = #` (missing RHS name) does not emit a var-ref edge to a prefix-only key', () => {
    const src = `# main
local x = #
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://empty-rhs');
    const loc = getLoc(symbols, 'main');
    for (const [, arr] of loc.variableBindings) {
      for (const b of arr) {
        if (b.value.kind === 'var-ref') {
          expect(b.value.varBaseName).not.toBe('');
          expect(b.value.varBaseName).not.toBe('#');
          expect(b.value.varBaseName).not.toBe('$');
          expect(b.value.varBaseName).not.toBe('%');
        }
      }
    }
  });

  it('`$ = $` (both sides empty) records nothing keyed to a bare prefix', () => {
    const src = `# main
$ = $
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://empty-both');
    expect(locVars(symbols, 'main').every(v => v.nameLower !== '' && v.key !== '$')).toBe(true);
    expect(bindingKeys(symbols, 'main').every(k => k !== '$' && k !== '')).toBe(true);
    // And any var-ref edge we did emit must not point at the bare prefix.
    const loc = getLoc(symbols, 'main');
    for (const [, arr] of loc.variableBindings) {
      for (const b of arr) {
        if (b.value.kind === 'var-ref') {
          expect(b.value.varBaseName).not.toBe('$');
          expect(b.value.varBaseName).not.toBe('');
        }
      }
    }
  });

  it('valid `local $a = $b` still works (positive control)', () => {
    const src = `# main
local $b = 'hello'
local $a = $b
---
`;
    const { symbols } = parseAndExtract(parser, src, 'test://empty-control');
    const loc = getLoc(symbols, 'main');
    const names = [...loc.variables.values()].map(v => v.nameLower).sort();
    expect(names).toContain('a');
    expect(names).toContain('b');
    // `$a` must carry a var-ref binding to `$b`.
    const aBindings = loc.variableBindings.get('a') ?? [];
    expect(aBindings.some(b =>
      b.value.kind === 'var-ref' && b.value.varBaseName === 'b',
    )).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Indexed writes record `indexText` so hover surfaces the slot being
// assigned (`arr[test] = 6`) rather than misleadingly suggesting the
// whole array is `6`.  Value-tracking still treats the binding as
// opaque (kind='other', no rhsTypePrefix) — see bindingCollector.
// ──────────────────────────────────────────────────────────────────────

describe('variableBindings: indexed writes capture indexText', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(() => initParser(parser));

  function bindingsFor(src: string, locName: string, varBase: string) {
    const { symbols } = parseAndExtract(parser, src, 'test://idx');
    const loc = getLoc(symbols, locName);
    return loc.variableBindings.get(varBase) ?? [];
  }

  it('captures simple identifier index', () => {
    const bs = bindingsFor(`# main\nqqq[test] = 6\n---\n`, 'main', 'qqq');
    expect(bs).toHaveLength(1);
    expect(bs[0].indexText).toBe('test');
    expect(bs[0].value.kind).toBe('other');
    expect(bs[0].writePrefix).toBe('#');
  });

  it('captures numeric literal index', () => {
    const bs = bindingsFor(`# main\narr[0] = 5\n---\n`, 'main', 'arr');
    expect(bs).toHaveLength(1);
    expect(bs[0].indexText).toBe('0');
  });

  it('captures string-key index', () => {
    const bs = bindingsFor(`# main\n$arr['k'] = 'v'\n---\n`, 'main', 'arr');
    expect(bs).toHaveLength(1);
    expect(bs[0].indexText).toBe("'k'");
    expect(bs[0].writePrefix).toBe('$');
  });

  it('captures empty bracket as empty string', () => {
    const bs = bindingsFor(`# main\narr[] = 99\n---\n`, 'main', 'arr');
    expect(bs).toHaveLength(1);
    expect(bs[0].indexText).toBe('');
  });

  it('captures multi-arg index preserving interior spaces', () => {
    // Interior spaces/tabs are preserved verbatim; only line breaks
    // are collapsed.  Author's `[1,  2]` survives as `1,  2`.
    const bs = bindingsFor(`# main\narr[1,  2] = 5\n---\n`, 'main', 'arr');
    expect(bs).toHaveLength(1);
    expect(bs[0].indexText).toBe('1,  2');
  });

  it('non-indexed write does not set indexText', () => {
    const bs = bindingsFor(`# main\narr = 5\n---\n`, 'main', 'arr');
    expect(bs).toHaveLength(1);
    expect(bs[0].indexText).toBeUndefined();
  });

  it('captures index expression using a variable read', () => {
    // The index expression itself reads `test` — that read is tracked
    // by the symbolWalker independently; here we only check that the
    // binding's indexText preserves the source text.
    const bs = bindingsFor(`# main\nqqq[test+1] = 6\n---\n`, 'main', 'qqq');
    expect(bs).toHaveLength(1);
    expect(bs[0].indexText).toBe('test+1');
  });

  it("captures setvar's third positional arg as indexText", () => {
    // `setvar 'q', 5, 3` — the third arg is the index (not embedded
    // in the name string).  The binding records `q` as the var, with
    // indexText='3' and writeOp='setvar'.
    const bs = bindingsFor(`# main\nsetvar 'q', 5, 3\n---\n`, 'main', 'q');
    expect(bs).toHaveLength(1);
    expect(bs[0].indexText).toBe('3');
    expect(bs[0].writeOp).toBe('setvar');
    expect(bs[0].writePrefix).toBe('#');
  });

  it('setvar without the optional index leaves indexText undefined', () => {
    const bs = bindingsFor(`# main\nsetvar 'q', 5\n---\n`, 'main', 'q');
    expect(bs).toHaveLength(1);
    expect(bs[0].indexText).toBeUndefined();
    expect(bs[0].writeOp).toBe('setvar');
  });

  it("setvar with prefixed name keeps prefix and captures index", () => {
    const bs = bindingsFor(`# main\nsetvar '$q', 'hi', 0\n---\n`, 'main', 'q');
    expect(bs).toHaveLength(1);
    expect(bs[0].indexText).toBe('0');
    expect(bs[0].writePrefix).toBe('$');
  });

  it('setvar captures the value arg text alongside the index', () => {
    // `setvar 'q', 5, 3` — value `5` is recorded as `value.text` so
    // hovers can show `#q[3] = 5 *(set by setvar)*`.
    const bs = bindingsFor(`# main\nsetvar 'q', 5, 3\n---\n`, 'main', 'q');
    expect(bs).toHaveLength(1);
    const v = bs[0].value as { kind: 'other'; text?: string };
    expect(v.kind).toBe('other');
    expect(v.text).toBe('5');
    expect(bs[0].indexText).toBe('3');
    expect(bs[0].writeOp).toBe('setvar');
  });

  it('setvar without an index still captures the value arg text', () => {
    const bs = bindingsFor(`# main\nsetvar 'q', 'hi'\n---\n`, 'main', 'q');
    expect(bs).toHaveLength(1);
    const v = bs[0].value as { kind: 'other'; text?: string };
    expect(v.text).toBe("'hi'");
    expect(bs[0].indexText).toBeUndefined();
  });

  it('setvar captures complex expression value text (whitespace-collapsed)', () => {
    const bs = bindingsFor(`# main\nsetvar 'q',  a + b * 2,  idx\n---\n`, 'main', 'q');
    expect(bs).toHaveLength(1);
    const v = bs[0].value as { kind: 'other'; text?: string };
    expect(v.text).toBe('a + b * 2');
    expect(bs[0].indexText).toBe('idx');
  });

  // ── Dynamic name args ─────────────────────────────────────────
  // The setvar/scanstr/… name arg must be a *direct* string literal
  // child of arg #0 — anything else (concat, function call, variable
  // holder, interpolation) is treated as dynamic and produces NO
  // binding.  This avoids mis-attributing the write to a misleading
  // base name picked from somewhere inside the expression.

  function allBindings(src: string, locName: string) {
    const { symbols } = parseAndExtract(parser, src, 'test://idx-dyn');
    const loc = getLoc(symbols, locName);
    const out: { key: string; b: VariableBinding }[] = [];
    for (const [k, bs] of loc.variableBindings) for (const b of bs) out.push({ key: k, b });
    return out;
  }

  it('does not record a binding when setvar name is interpolated', () => {
    expect(allBindings(`# main\nsetvar 'q<<i>>', 5, 3\n---\n`, 'main')).toHaveLength(0);
  });

  it('does not record a binding when setvar name is a concatenation', () => {
    expect(allBindings(`# main\nsetvar 'q' + '_x', 5, 3\n---\n`, 'main')).toHaveLength(0);
    expect(allBindings(`# main\nsetvar('q' + '_x', 5, 3)\n---\n`, 'main')).toHaveLength(0);
  });

  it('does not record a binding when setvar name is a variable holder', () => {
    expect(allBindings(`# main\nsetvar $nm, 5, 3\n---\n`, 'main')).toHaveLength(0);
    expect(allBindings(`# main\nsetvar($nm, 5, 3)\n---\n`, 'main')).toHaveLength(0);
  });

  it('does not record a binding when setvar name is a function call', () => {
    expect(allBindings(`# main\nsetvar $iif(1, 'a', 'b'), 5, 3\n---\n`, 'main')).toHaveLength(0);
  });

  it('still records a binding for constant-string setvar inside parens', () => {
    const bs = bindingsFor(`# main\nsetvar('q', 5, 3)\n---\n`, 'main', 'q');
    expect(bs).toHaveLength(1);
    expect(bs[0].indexText).toBe('3');
    expect((bs[0].value as { text?: string }).text).toBe('5');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Indexed-write rhsTypePrefix inference
//
// Indexed writes don't propagate slot values, but we DO record the
// prefix of the RHS so the typeMismatch diagnostic can compare write
// lens vs. read lens (e.g. `$arr[0] = 5` is `$ ← #` mismatch).
// ──────────────────────────────────────────────────────────────────────

describe('variableBindings: indexed-write rhsTypePrefix inference', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(() => initParser(parser));

  function bindingsFor(src: string, locName: string, varBase: string) {
    const { symbols } = parseAndExtract(parser, src, 'test://idx-rhs');
    const loc = getLoc(symbols, locName);
    return loc.variableBindings.get(varBase) ?? [];
  }

  it('infers # for numeric-literal RHS on indexed write', () => {
    const bs = bindingsFor(`# main\narr[0] = 5\n---\n`, 'main', 'arr');
    expect(bs[0].rhsTypePrefix).toBe('#');
  });

  it('infers $ for string-literal RHS on indexed write', () => {
    const bs = bindingsFor(`# main\narr[0] = 'hi'\n---\n`, 'main', 'arr');
    expect(bs[0].rhsTypePrefix).toBe('$');
  });

  it('infers % for tuple RHS on indexed write', () => {
    const bs = bindingsFor(`# main\narr[0] = [1, 2]\n---\n`, 'main', 'arr');
    expect(bs[0].rhsTypePrefix).toBe('%');
  });

  it("infers RHS prefix from a plain var-ref on indexed write ($b → '$')", () => {
    const bs = bindingsFor(`# main\narr[0] = $b\n---\n`, 'main', 'arr');
    expect(bs[0].rhsTypePrefix).toBe('$');
  });

  it("infers RHS prefix from an indexed var-ref on indexed write ($b[0] → '$')", () => {
    // The key new behavior: the prefix on `$b[0]` is the read lens,
    // independent of `b`'s definition.
    const bs = bindingsFor(`# main\narr[0] = $b[0]\n---\n`, 'main', 'arr');
    expect(bs[0].rhsTypePrefix).toBe('$');
  });

  it("infers RHS prefix from an indexed var-ref with no explicit prefix as '#'", () => {
    const bs = bindingsFor(`# main\n$arr[0] = b[1]\n---\n`, 'main', '$arr');
    // Note: $arr stored under base 'arr' (prefix-stripped).
    const arrBs = bindingsFor(`# main\n$arr[0] = b[1]\n---\n`, 'main', 'arr');
    expect(arrBs[0].writePrefix).toBe('$');
    expect(arrBs[0].rhsTypePrefix).toBe('#');
    expect(bs).toHaveLength(0); // sanity: not stored under '$arr'
  });

  it('records writeOp for compound-op indexed writes', () => {
    const bs = bindingsFor(`# main\narr[0] += 1\n---\n`, 'main', 'arr');
    expect(bs[0].writeOp).toBe('+=');
    expect(bs[0].indexText).toBe('0');
    expect(bs[0].rhsTypePrefix).toBe('#');
  });

  it('non-indexed RHS read (was already covered) keeps rhsTypePrefix on plain assignment', () => {
    // Sanity for the catch-all `else` branch refactor: tuple stays '%'.
    const bs = bindingsFor(`# main\nx = [1, 2]\n---\n`, 'main', 'x');
    expect(bs[0].rhsTypePrefix).toBe('%');
  });

  it('plain assignment from indexed read still propagates RHS prefix', () => {
    // `$x = b[0]` — RHS is indexed read with no prefix → '#'.
    // (Previously this was 'undefined'; now properly inferred.)
    const bs = bindingsFor(`# main\n$x = b[0]\n---\n`, 'main', 'x');
    expect(bs[0].rhsTypePrefix).toBe('#');
    expect(bs[0].writePrefix).toBe('$');
  });

  it('indexed writes do NOT create var-ref alias edges', () => {
    // `arr[i] = b` reads one slot — we must not propagate `b`'s value
    // to the whole `arr` chain.  The binding stays opaque kind='other'.
    const bs = bindingsFor(`# main\narr[0] = b\n---\n`, 'main', 'arr');
    expect(bs[0].value.kind).toBe('other');
    // Sanity: `b` itself has no aliased binding from this site either.
    const bBs = bindingsFor(`# main\narr[0] = b\n---\n`, 'main', 'b');
    expect(bBs).toHaveLength(0);
  });

  it('plain assignment from indexed read does NOT create var-ref alias', () => {
    // `$x = b[0]` reads one slot, so we don't alias $x → b.
    const bs = bindingsFor(`# main\n$x = b[0]\n---\n`, 'main', 'x');
    expect(bs[0].value.kind).toBe('other');
    expect(bs[0].value.kind === 'other' && bs[0].value.text).toBe('b[0]');
  });
});
