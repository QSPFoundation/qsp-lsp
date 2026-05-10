import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import { QspTreeSitterParser, extractSymbols } from '../src/parser/treeSitter';
import { LocationSymbols, DocumentSymbols } from '../src/parser/symbolTable';
import { WASM_PATH } from './testHelpers';

describe('findSymbolAtPosition coverage', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('should find location definition at # header', () => {
    const tree = parser.parse('test://sym-locdef', `# MyRoom
pl 'hello'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://sym-locdef');
    // Cursor on 'MyRoom' in header (line 0)
    const sym = symbols.findSymbolAtPosition(0, 3);
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('location');
    expect(sym!.name).toBe('MyRoom');
  });

  it('should find location ref inside goto string', () => {
    const tree = parser.parse('test://sym-locref', `# main
goto 'room1'
---
# room1
pl 'x'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://sym-locref');
    // Cursor on 'room1' inside goto (line 1, col 6)
    const sym = symbols.findSymbolAtPosition(1, 7);
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('location');
    expect(sym!.name).toBe('room1');
  });

  it('should find label definition at : label', () => {
    const tree = parser.parse('test://sym-lbldef', `# main
:myLabel
pl 'hello'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://sym-lbldef');
    // Cursor on 'myLabel' (line 1)
    const sym = symbols.findSymbolAtPosition(1, 2);
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('label');
    expect(sym!.name).toBe('myLabel');
  });

  it('should find label ref inside jump string', () => {
    const tree = parser.parse('test://sym-lblref', `# main
:target
jump 'target'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://sym-lblref');
    // Cursor on 'target' inside jump (line 2, col 7)
    const sym = symbols.findSymbolAtPosition(2, 7);
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('label');
    expect(sym!.name).toBe('target');
  });

  it('should handle duplicate labels by recording both references', () => {
    const tree = parser.parse('test://dup-label', `# main
:myLabel
pl 'first'
:myLabel
pl 'second'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://dup-label');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms).toBeDefined();
    const label = mainSyms!.getLabel('mylabel', 0);
    expect(label).toBeDefined();
    expect(label!.references.length).toBe(2);
    // Definition is the first occurrence
    expect(label!.definition!.line).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Error classification (refineErrorNode)
// ──────────────────────────────────────────────────────────────────────

describe('incremental symbol reuse', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('should detect new variables when location content changes', () => {
    const uri = 'test://reuse-detect';
    const text1 = `# loc1\nx = 1\n---\n`;
    const tree1 = parser.parse(uri, text1);
    const { symbols: syms1 } = extractSymbols(tree1!, uri);
    expect(syms1.getLocation('loc1')!.variables.has('z')).toBe(false);

    // Add z to loc1
    const text2 = `# loc1\nx = 1\nz = 99\n---\n`;
    const tree2 = parser.parse(uri, text2);
    const { symbols: syms2 } = extractSymbols(tree2!, uri, syms1, parser.lastEdit);

    // z should be detected in loc1
    expect(syms2.getLocation('loc1')!.variables.has('z')).toBe(true);
    expect(syms2.getLocation('loc1')!.variables.has('x')).toBe(true);
  });

  it('should produce correct line numbers after content added above', () => {
    const uri = 'test://reuse-shift';
    const text1 = `# loc1\nx = 1\n---\n# loc2\ny = 2\n---\n`;
    const tree1 = parser.parse(uri, text1);
    const { symbols: syms1 } = extractSymbols(tree1!, uri);

    // In text1, loc2's y is at line 4
    expect(syms1.getLocation('loc2')!.variables.get('y')!.references[0].line).toBe(4);

    // Add 2 lines to loc1 → loc2 shifts down by 2
    const text2 = `# loc1\nx = 1\nz = 3\nw = 4\n---\n# loc2\ny = 2\n---\n`;
    const tree2 = parser.parse(uri, text2);
    const { symbols: syms2 } = extractSymbols(tree2!, uri, syms1, parser.lastEdit);

    expect(syms2.locationDefs.size).toBe(2);
    const ySym = syms2.getLocation('loc2')!.variables.get('y');
    expect(ySym).toBeDefined();
    expect(ySym!.references[0].line).toBe(6);
  });

  it('should produce equivalent results with and without previousSymbols', () => {
    const uri1 = 'test://reuse-equiv-a';
    const uri2 = 'test://reuse-equiv-b';
    const text = `# loc1\nx = 1\n---\n# loc2\ny = 2\n---\n`;
    const newText = `# loc1\nx = 1\nz = 3\n---\n# loc2\ny = 2\n---\n`;

    // Path A: with previousSymbols
    const treeA1 = parser.parse(uri1, text);
    const { symbols: symsA1 } = extractSymbols(treeA1!, uri1);
    const treeA2 = parser.parse(uri1, newText);
    const { symbols: symsA } = extractSymbols(treeA2!, uri1, symsA1, parser.lastEdit);

    // Path B: without previousSymbols (fresh parse)
    const treeB = parser.parse(uri2, newText);
    const { symbols: symsB } = extractSymbols(treeB!, uri2);

    // Both should produce the same location structure
    expect(symsA.locationDefs.size).toBe(symsB.locationDefs.size);
    for (const [key] of symsB.locations) {
      const locA = symsA.getLocation(key);
      const locB = symsB.getLocation(key);
      expect(locA).toBeDefined();
      expect(locA!.variables.size).toBe(locB!.variables.size);
    }
  });

  it('should reuse unchanged location and re-extract changed one', () => {
    const uri = 'test://reuse-selective';
    const text1 = `# loc1\nx = 1\n---\n# loc2\ny = 2\n---\n`;
    const tree1 = parser.parse(uri, text1);
    const { symbols: syms1 } = extractSymbols(tree1!, uri);

    // Change only loc1
    const text2 = `# loc1\nx = 1\nz = 3\n---\n# loc2\ny = 2\n---\n`;
    const tree2 = parser.parse(uri, text2);
    const { reusedLocations } = extractSymbols(tree2!, uri, syms1, parser.lastEdit);

    // loc2 is after the edit → reused; loc1 overlaps the edit → re-extracted
    expect(reusedLocations.has('loc2')).toBe(true);
    expect(reusedLocations.has('loc1')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// findVariableReferences
// ──────────────────────────────────────────────────────────────────────

describe('findVariableReferences', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('should find global variable references across locations', () => {
    const tree = parser.parse('test://varref-global', `# loc1
x = 1
---
# loc2
pl x
---
`);
    const { symbols } = extractSymbols(tree!, 'test://varref-global');
    const refs = symbols.findVariableReferences('x');
    expect(refs.length).toBe(2);
  });

  it('should track variable used without definition', () => {
    const tree = parser.parse('test://varref-nodef', `# test
pl myVar
---
`);
    const { symbols } = extractSymbols(tree!, 'test://varref-nodef');
    const locSyms = symbols.getLocation('test');
    const sym = locSyms!.variables.get('myvar');
    expect(sym).toBeDefined();
    expect(sym!.definition).toBeUndefined();
    expect(sym!.references.length).toBe(1);
  });

  it('should treat $name and name as same variable', () => {
    const tree = parser.parse('test://varref-prefix', `# test
$x = 'hello'
pl x
---
`);
    const { symbols } = extractSymbols(tree!, 'test://varref-prefix');
    const refs = symbols.findVariableReferences('x');
    expect(refs.length).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Symbol extraction — additional edge cases
// ──────────────────────────────────────────────────────────────────────

describe('findSymbolAtPosition — locationName scoping', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('should find symbol in the specified location only', () => {
    const tree = parser.parse('test://scope-pos', `# loc1
act 'Action A': pl 'a'
---
# loc2
act 'Action B': pl 'b'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://scope-pos');
    // Search within loc2 — should find Action B, not Action A
    const sym = symbols.findSymbolAtPosition(4, 6, 'loc2');
    expect(sym).toBeDefined();
    expect(sym!.name).toBe('Action B');

    // Same line/col would not find Action A when scoped to loc2
    const sym2 = symbols.findSymbolAtPosition(1, 6, 'loc2');
    expect(sym2).toBeNull();
  });

  it('should still find global location defs even when scoped', () => {
    const tree = parser.parse('test://scope-global', `# MyLoc
pl 'x'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://scope-global');
    // Location definition in header is always global
    const sym = symbols.findSymbolAtPosition(0, 3, 'other');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('location');
    expect(sym!.name).toBe('MyLoc');
  });
});

// ──────────────────────────────────────────────────────────────────────
// dispose() cleanup
// ──────────────────────────────────────────────────────────────────────

describe('findVariableAtPosition resolves correct scoped local', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('returns outer local when cursor is on usage outside inner scope', () => {
    const tree = parser.parse('test://fvap1', `# test
local x = 1
pl x
if 1:
  local x = 2
  pl x
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://fvap1');
    const loc = symbols.getLocation('test')!;
    // line 2: "pl x" — x at col 3
    const outerSym = loc.findVariableAtPosition('x', 2, 3);
    expect(outerSym).toBeDefined();
    expect(outerSym!.scopeId).toBe(0);
    // line 5: "  pl x" — x at col 5 (indented)
    const innerSym = loc.findVariableAtPosition('x', 5, 5);
    expect(innerSym).toBeDefined();
    expect(innerSym!.scopeId).not.toBe(0);
    // They should be different symbols
    expect(outerSym).not.toBe(innerSym);
  });

  it('returns the local definition symbol when cursor is on the LOCAL line', () => {
    const tree = parser.parse('test://fvap2', `# test
local x = 1
if 1:
  local x = 2
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://fvap2');
    const loc = symbols.getLocation('test')!;
    // line 1: "local x = 1" — x at col 6
    const outerDef = loc.findVariableAtPosition('x', 1, 6);
    expect(outerDef).toBeDefined();
    expect(outerDef!.scopeId).toBe(0);
    // line 3: "  local x = 2" — x at col 8 (indented)
    const innerDef = loc.findVariableAtPosition('x', 3, 8);
    expect(innerDef).toBeDefined();
    expect(innerDef!.scopeId).not.toBe(0);
  });

  it('returns global variable when no locals exist', () => {
    const tree = parser.parse('test://fvap3', `# test
x = 1
pl x
---
`);
    const { symbols } = extractSymbols(tree!, 'test://fvap3');
    const loc = symbols.getLocation('test')!;
    const sym = loc.findVariableAtPosition('x', 2, 3);
    expect(sym).toBeDefined();
    expect(sym!.isLocal).toBe(false);
  });

  it('falls back to findVariable when position is not on a reference', () => {
    const tree = parser.parse('test://fvap4', `# test
local x = 1
---
`);
    const { symbols } = extractSymbols(tree!, 'test://fvap4');
    const loc = symbols.getLocation('test')!;
    // line 0 col 0 = "# test" header, not on any x reference
    const sym = loc.findVariableAtPosition('x', 0, 0);
    expect(sym).toBeDefined();
    expect(sym!.isLocal).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// findVariableReferences with exactSymbol — scope filtering
// ──────────────────────────────────────────────────────────────────────

describe('findVariableReferences with exactSymbol', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('returns only the specified scoped local refs when exactSymbol provided', () => {
    const tree = parser.parse('test://fvr-exact', `# test
local x = 1
pl x
if 1:
  local x = 2
  pl x
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://fvr-exact');
    const loc = symbols.getLocation('test')!;
    const outerSym = loc.findVariableAtPosition('x', 2, 3)!;
    const innerSym = loc.findVariableAtPosition('x', 5, 5)!;

    // Without exactSymbol — gets ALL refs from both scopes
    const allRefs = symbols.findVariableReferences('x', 'test');
    expect(allRefs.length).toBeGreaterThanOrEqual(4); // at least 4 (decl+use for each)

    // With exactSymbol — only the outer local's refs
    const outerRefs = symbols.findVariableReferences('x', 'test', outerSym);
    expect(outerRefs).toHaveLength(outerSym.references.length);
    expect(outerRefs.every(r => outerSym.references.includes(r))).toBe(true);

    // With exactSymbol — only the inner local's refs
    const innerRefs = symbols.findVariableReferences('x', 'test', innerSym);
    expect(innerRefs).toHaveLength(innerSym.references.length);
    expect(innerRefs.every(r => innerSym.references.includes(r))).toBe(true);

    // No overlap
    const outerLines = new Set(outerRefs.map(r => r.line));
    const innerLines = new Set(innerRefs.map(r => r.line));
    for (const l of outerLines) expect(innerLines.has(l)).toBe(false);
  });

  it('separates pre-declaration global refs from a later local with the same name', () => {
    // Source-order semantics: writes/reads BEFORE `local x = 5` see a
    // genuine global, not the upcoming local.  Find-references must
    // therefore return two disjoint sets when the cursor lands on
    // either symbol — the global owns lines 2-3, the local owns 4-6.
    const tree = parser.parse('test://global-then-local', `# test
x = 10
pl x
local x = 5
pl x
x = 20
---
`);
    const { symbols } = extractSymbols(tree!, 'test://global-then-local');
    const loc = symbols.getLocation('test')!;

    const globalSym = loc.findVariableAtPosition('x', 1, 0);
    expect(globalSym).toBeDefined();
    expect(globalSym!.isLocal).toBe(false);
    expect(globalSym!.references.map(r => r.line).sort()).toEqual([1, 2]);

    const localSym = loc.findVariableAtPosition('x', 3, 6);
    expect(localSym).toBeDefined();
    expect(localSym!.isLocal).toBe(true);
    expect(localSym!.references.map(r => r.line).sort()).toEqual([3, 4, 5]);

    // Find-refs scoped to the global symbol returns only its refs.
    const globalRefs = symbols.findVariableReferences('x', 'test', globalSym!);
    expect(globalRefs.map(r => r.line).sort()).toEqual([1, 2]);
    const localRefs = symbols.findVariableReferences('x', 'test', localSym!);
    expect(localRefs.map(r => r.line).sort()).toEqual([3, 4, 5]);
  });

  it('reads of a non-local name with a single global write site are tracked as globals', () => {
    // Simple: no `local x` anywhere → bare assignment is the one and
    // only global write site; reads aggregate onto the same symbol.
    const tree = parser.parse('test://only-global', `# a
x = 1
pl x
---
# b
pl x
---
`);
    const { symbols } = extractSymbols(tree!, 'test://only-global');
    const a = symbols.getLocation('a')!;
    const b = symbols.getLocation('b')!;
    const aSym = a.findVariable('x')!;
    expect(aSym.isLocal).toBe(false);
    expect(aSym.references).toHaveLength(2); // assignment + read
    const bSym = b.findVariable('x')!;
    expect(bSym.isLocal).toBe(false);
    expect(bSym.references).toHaveLength(1); // read only
    // Cross-location find-refs returns both location's refs.
    const all = symbols.findVariableReferences('x');
    expect(all.length).toBe(3);
  });
});

// ──────────────────────────────────────────────────────────────────────
// copyWithLineShift — preserves scope data
// ──────────────────────────────────────────────────────────────────────

describe('copyWithLineShift preserves scope data', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('findVariable still resolves locals after copyWithLineShift', () => {
    const tree = parser.parse('test://copy1', `# test
local x = 1
if 1:
  pl x
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://copy1');
    const original = symbols.getLocation('test')!;

    const copy = LocationSymbols.copyWithLineShift(original, 10);
    // findVariable should still resolve x as local on the copy
    const found = copy.findVariable('x');
    expect(found).toBeDefined();
    expect(found!.isLocal).toBe(true);
    expect(found!.definition!.line).toBe(1 + 10);
  });

  it('findAllVariables returns all scoped locals after copyWithLineShift', () => {
    const tree = parser.parse('test://copy2', `# test
local x = 1
if 1:
  local x = 2
  pl x
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://copy2');
    const original = symbols.getLocation('test')!;

    const copy = LocationSymbols.copyWithLineShift(original, 5);
    const allX = copy.findAllVariables('x');
    expect(allX).toHaveLength(2);
    expect(allX.every(s => s.isLocal)).toBe(true);
    // Lines should be shifted
    expect(allX.every(s => s.definition!.line >= 6)).toBe(true);
  });

  it('scopeParent, isolatedScopes, and localNames are copied', () => {
    const tree = parser.parse('test://copy3', `# test
local y = 1
act 'a':
  local z = 2
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://copy3');
    const original = symbols.getLocation('test')!;

    const copy = LocationSymbols.copyWithLineShift(original, 0);
    expect(copy.scopeParent.size).toBe(original.scopeParent.size);
    expect(copy.isolatedScopes.size).toBe(original.isolatedScopes.size);
    // localNames is private, but we can verify via findVariable
    // y is local in parent scope, z is local in isolated act scope
    expect(copy.findVariable('y')).toBeDefined();
    expect(copy.findVariable('y')!.isLocal).toBe(true);
  });

  it('addLocationFrom preserves scope data through DocumentSymbols', () => {
    const tree = parser.parse('test://copy4', `# test
local x = 1
if 1:
  pl x
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://copy4');
    const original = symbols.getLocation('test')!;

    const target = new DocumentSymbols('test://target');
    target.addLocationFrom('test', { uri: 'test://copy4', line: 20, column: 0, endLine: 25, endColumn: 0 }, original, 20);
    const copied = target.getLocation('test')!;
    expect(copied).toBeDefined();
    const found = copied.findVariable('x');
    expect(found).toBeDefined();
    expect(found!.isLocal).toBe(true);
    expect(found!.definition!.line).toBe(1 + 20);
  });
});

// ──────────────────────────────────────────────────────────────────────
// getLocalsInScope — uses localsByScope index
// ──────────────────────────────────────────────────────────────────────

describe('getLocalsInScope', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('returns locals from current scope', () => {
    const tree = parser.parse('test://gls1', `# test
local x = 1
local y = 2
pl x + y
---
`);
    const { symbols } = extractSymbols(tree!, 'test://gls1');
    const loc = symbols.getLocation('test')!;
    const locals = loc.getLocalsInScope(0);
    expect(locals.has('x')).toBe(true);
    expect(locals.has('y')).toBe(true);
    expect(locals.size).toBe(2);
  });

  it('inherits locals from parent scope', () => {
    const tree = parser.parse('test://gls2', `# test
local x = 1
if 1:
  local y = 2
  pl x + y
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://gls2');
    const loc = symbols.getLocation('test')!;
    // Find the inner scope by looking at y's scopeId
    const yAll = loc.findAllVariables('y');
    const yLocal = yAll.find(s => s.isLocal)!;
    const innerScope = yLocal.scopeId!;
    const locals = loc.getLocalsInScope(innerScope);
    expect(locals.has('x')).toBe(true);
    expect(locals.has('y')).toBe(true);
    // innermost scope wins — y's scope should be the inner one
    expect(locals.get('y')).toBe(innerScope);
  });

  it('stops at isolation boundary (act)', () => {
    const tree = parser.parse('test://gls3', `# test
local x = 1
act 'a':
  local y = 2
  pl y
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://gls3');
    const loc = symbols.getLocation('test')!;
    const yAll = loc.findAllVariables('y');
    const yLocal = yAll.find(s => s.isLocal)!;
    const actScope = yLocal.scopeId!;
    const locals = loc.getLocalsInScope(actScope);
    // y is visible, x is NOT (act is isolated)
    expect(locals.has('y')).toBe(true);
    expect(locals.has('x')).toBe(false);
  });

  it('innermost scope shadows outer scope', () => {
    const tree = parser.parse('test://gls4', `# test
local x = 1
if 1:
  local x = 2
  pl x
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://gls4');
    const loc = symbols.getLocation('test')!;
    const allX = loc.findAllVariables('x');
    const innerX = allX.find(s => s.scopeId !== 0)!;
    const innerScope = innerX.scopeId!;
    const locals = loc.getLocalsInScope(innerScope);
    // x should map to the inner scope, not the outer
    expect(locals.get('x')).toBe(innerScope);
  });

  it('works after copyWithLineShift', () => {
    const tree = parser.parse('test://gls5', `# test
local a = 1
if 1:
  local b = 2
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://gls5');
    const original = symbols.getLocation('test')!;
    const copy = LocationSymbols.copyWithLineShift(original, 10);
    const locals = copy.getLocalsInScope(0);
    expect(locals.has('a')).toBe(true);
  });

  it('returns empty map for scope with no locals', () => {
    const tree = parser.parse('test://gls6', `# test
x = 1
pl x
---
`);
    const { symbols } = extractSymbols(tree!, 'test://gls6');
    const loc = symbols.getLocation('test')!;
    const locals = loc.getLocalsInScope(0);
    expect(locals.size).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// copyWithLineShift lineShift=0 — shares symbols
// ──────────────────────────────────────────────────────────────────────

describe('copyWithLineShift lineShift=0 shares symbols', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('shares symbol objects (no deep copy) when lineShift is 0', () => {
    const tree = parser.parse('test://zero1', `# test
local x = 1
pl x
---
`);
    const { symbols } = extractSymbols(tree!, 'test://zero1');
    const original = symbols.getLocation('test')!;
    const copy = LocationSymbols.copyWithLineShift(original, 0);

    // Symbol objects should be the same identity (shared, not copied)
    const origX = original.findVariable('x')!;
    const copyX = copy.findVariable('x')!;
    expect(copyX).toBe(origX);
    expect(copyX.references).toBe(origX.references);
  });

  it('does NOT share symbol objects when lineShift is non-zero', () => {
    const tree = parser.parse('test://nonzero1', `# test
local x = 1
pl x
---
`);
    const { symbols } = extractSymbols(tree!, 'test://nonzero1');
    const original = symbols.getLocation('test')!;
    const copy = LocationSymbols.copyWithLineShift(original, 5);

    const origX = original.findVariable('x')!;
    const copyX = copy.findVariable('x')!;
    expect(copyX).not.toBe(origX);
    expect(copyX.definition!.line).toBe(origX.definition!.line + 5);
  });
});

// ──────────────────────────────────────────────────────────────────────
// findSymbolAtPosition — comprehensive
// ──────────────────────────────────────────────────────────────────────

describe('findSymbolAtPosition — comprehensive', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('should find action at cursor position inside string', () => {
    const tree = parser.parse('test://pos-act', `# test\nact 'My Action':\n  pl 'hi'\nend\ndelact 'My Action'\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://pos-act');
    // The action ref in delact is at line 4, inside the string
    const sym = symbols.findSymbolAtPosition(4, 9, 'test');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('action');
    expect(sym!.name).toBe('My Action');
  });

  it('should find object at cursor position inside string', () => {
    const tree = parser.parse('test://pos-obj', `# test\naddobj 'Sword'\ndelobj 'Sword'\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://pos-obj');
    const sym = symbols.findSymbolAtPosition(2, 9, 'test');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('object');
    expect(sym!.name).toBe('Sword');
  });

  it('should find location ref at cursor position', () => {
    const tree = parser.parse('test://pos-loc', `# room1\n---\n# room2\ngosub 'room1'\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://pos-loc');
    const sym = symbols.findSymbolAtPosition(3, 8, 'room2');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('location');
    expect(sym!.name).toBe('room1');
  });

  it('should return null when cursor is not on any symbol', () => {
    const tree = parser.parse('test://pos-none', `# test\npl 'hello'\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://pos-none');
    const sym = symbols.findSymbolAtPosition(1, 0, 'test');
    expect(sym).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Mixed variable prefix tracking
// ──────────────────────────────────────────────────────────────────────

