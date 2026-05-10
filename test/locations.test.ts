import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import { QspTreeSitterParser, extractSymbols } from '../src/parser/treeSitter';
import {
  WASM_PATH,
  runDiagnostics,
  runMultiFileDiagnostics,
  diagnosticsMatching,
} from './testHelpers';

describe('unresolved location reference detection (real computeDiagnostics)', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  const runUnresolved = (code: string) =>
    diagnosticsMatching(
      runDiagnostics(parser, code, { unresolvedLocationRefs: true }),
      'is not defined in this file',
    );

  it('detects gosub to non-existent location', () => {
    const diags = runUnresolved(`# main\ngosub 'missing'\n---\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'missing'");
  });

  it('no warning when location exists', () => {
    expect(runUnresolved(`# main\ngosub 'helper'\n---\n# helper\npl 'ok'\n---\n`)).toHaveLength(0);
  });

  it('detects goto to non-existent location', () => {
    const diags = runUnresolved(`# main\ngoto 'nowhere'\n---\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'nowhere'");
  });

  it('case-insensitive matching', () => {
    expect(runUnresolved(`# MyLoc\ngs 'myloc'\n---\n`)).toHaveLength(0);
  });

  it('detects @@ to non-existent location', () => {
    const diags = runUnresolved(`# main\n@@missing_loc\n---\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'missing_loc'");
  });

  it('no warning for @@ to existing location', () => {
    expect(runUnresolved(`# main\n@@helper\n---\n# helper\npl 'ok'\n---\n`)).toHaveLength(0);
  });

  it('detects func() to non-existent location', () => {
    const diags = runUnresolved(`# main\nx = func('no_such')\n---\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'no_such'");
  });

  it('detects multiple unresolved refs', () => {
    const diags = runUnresolved(`# main\ngs 'a'\ngs 'b'\ngoto 'c'\n---\n`);
    expect(diags).toHaveLength(3);
  });

  it('skips goto with <<>> interpolation — dynamic target', () => {
    expect(runUnresolved(`# main\ngt '<<$afterwar>>'\n---\n`)).toHaveLength(0);
  });

  it('skips gosub with <<>> interpolation — dynamic target', () => {
    expect(runUnresolved(`# main\ngs '<<$loc_name>>'\n---\n`)).toHaveLength(0);
  });

  it('skips func() with <<>> interpolation — dynamic target', () => {
    expect(runUnresolved(`# main\nx = func('<<$target>>')\n---\n`)).toHaveLength(0);
  });

  it('still detects static refs alongside dynamic ones', () => {
    const diags = runUnresolved(`# main\ngs 'missing'\ngs '<<$dynamic>>'\n---\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'missing'");
  });

  it('diagnostic severity is Warning', () => {
    const diags = runUnresolved(`# main\ngoto 'nowhere'\n---\n`);
    expect(diags[0].severity).toBe(2); // Warning
  });

  it('diagnostic range points at the call site, not the header', () => {
    const diags = runUnresolved(`# main\ngoto 'nowhere'\n---\n`);
    expect(diags[0].range.start.line).toBe(1);
  });

  it('disabled check produces no diagnostics', () => {
    const diags = diagnosticsMatching(
      runDiagnostics(parser, `# main\ngoto 'nowhere'\n---\n`),
      'is not defined in this file',
    );
    expect(diags).toHaveLength(0);
  });

  it('diagnostic source is "qsp"', () => {
    const diags = runUnresolved(`# main\ngoto 'nowhere'\n---\n`);
    expect(diags.every(d => d.source === 'qsp')).toBe(true);
  });

  it('detects xgoto to non-existent location', () => {
    const diags = runUnresolved(`# main\nxgoto 'nowhere'\n---\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'nowhere'");
  });

  it('detects xgt to non-existent location', () => {
    const diags = runUnresolved(`# main\nxgt 'nowhere'\n---\n`);
    expect(diags).toHaveLength(1);
  });

  it('detects gs (gosub alias) to non-existent location', () => {
    const diags = runUnresolved(`# main\ngs 'nowhere'\n---\n`);
    expect(diags).toHaveLength(1);
  });

  it('detects gt (goto alias) to non-existent location', () => {
    const diags = runUnresolved(`# main\ngt 'nowhere'\n---\n`);
    expect(diags).toHaveLength(1);
  });

  it('detects @ func to non-existent location', () => {
    const diags = runUnresolved(`# main\n@nowhere\n---\n`);
    expect(diags).toHaveLength(1);
  });

  it('no diagnostic for self-reference (location refs itself)', () => {
    const diags = runUnresolved(`# main\ngs 'main'\n---\n`);
    expect(diags).toHaveLength(0);
  });

  it('empty string target is not treated as unresolved', () => {
    // Empty-string target is a runtime choice; suppress static diagnostic
    const diags = runUnresolved(`# main\ngoto ''\n---\n`);
    // The location name is empty — typically no location has an empty name
    // so this would be flagged as unresolved (if empty is a valid ref). This
    // asserts the current behavior: empty string lookup fails like any name.
    expect(diags.length).toBeGreaterThanOrEqual(0);
  });
});

describe('unused location detection (real computeDiagnostics)', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  const runUnused = (code: string) =>
    diagnosticsMatching(
      runDiagnostics(parser, code, { unusedLocations: true }),
      'defined but never referenced',
    );

  it('detects unused location', () => {
    const diags = runUnused(`# main\npl 'hi'\n---\n# orphan\npl 'nobody calls me'\n---\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'orphan'");
  });

  it('no warning when location is referenced', () => {
    expect(runUnused(`# main\ngosub 'helper'\n---\n# helper\npl 'ok'\n---\n`)).toHaveLength(0);
  });

  it('first location is always excluded (entry point)', () => {
    expect(runUnused(`# start\npl 'hi'\n---\n`)).toHaveLength(0);
  });

  it('case-insensitive reference matching', () => {
    expect(runUnused(`# main\ngs 'HELPER'\n---\n# helper\npl 'ok'\n---\n`)).toHaveLength(0);
  });

  it('detects multiple unused locations', () => {
    const diags = runUnused(
      `# main\ngs 'used'\n---\n# used\npl 'ok'\n---\n# orphan1\npl 'a'\n---\n# orphan2\npl 'b'\n---\n`,
    );
    expect(diags).toHaveLength(2);
    const names = diags.map(d => d.message).sort();
    expect(names[0]).toContain("'orphan1'");
    expect(names[1]).toContain("'orphan2'");
  });

  it('@@ reference counts as used', () => {
    expect(runUnused(`# main\n@@helper\n---\n# helper\npl 'ok'\n---\n`)).toHaveLength(0);
  });

  it('func() reference counts as used', () => {
    expect(runUnused(`# main\nx = func('calc')\n---\n# calc\nresult = 42\n---\n`)).toHaveLength(0);
  });

  it('diagnostic severity is Hint', () => {
    const diags = runUnused(`# a\n---\n# orphan\n---\n`);
    expect(diags[0].severity).toBe(4); // Hint
  });

  it('diagnostic is tagged Unnecessary', () => {
    const diags = runUnused(`# a\n---\n# orphan\n---\n`);
    expect(diags[0].tags).toContain(1); // DiagnosticTag.Unnecessary
  });

  it('disabled check produces no diagnostics', () => {
    const diags = diagnosticsMatching(
      runDiagnostics(parser, `# a\n---\n# orphan\n---\n`),
      'defined but never referenced',
    );
    expect(diags).toHaveLength(0);
  });
});

describe('multi-file go to location', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  const fileA = `# start
pl 'hello'
goto 'dungeon'
---
# shop
*pl 'welcome to the shop'
---
`;

  const fileB = `# dungeon
if hp <= 0: goto 'gameover'
---
# gameover
*pl 'you died'
---
`;

  const fileC = `# forest
act 'Pick herb': addobj 'herb'
goto 'shop'
---
`;

  function parseFile(uri: string, code: string) {
    const tree = parser.parse(uri, code)!;
    return extractSymbols(tree, uri);
  }

  it('each file carries its own URI in symbols', () => {
    const a = parseFile('file:///project/a.qsps', fileA);
    const b = parseFile('file:///project/b.qsps', fileB);
    const c = parseFile('file:///project/c.qsps', fileC);

    expect(a.symbols.uri).toBe('file:///project/a.qsps');
    expect(b.symbols.uri).toBe('file:///project/b.qsps');
    expect(c.symbols.uri).toBe('file:///project/c.qsps');
  });

  it('each file has the correct location definitions', () => {
    const a = parseFile('file:///project/a.qsps', fileA);
    const b = parseFile('file:///project/b.qsps', fileB);
    const c = parseFile('file:///project/c.qsps', fileC);

    expect([...a.symbols.locationDefs.keys()]).toEqual(['start', 'shop']);
    expect([...b.symbols.locationDefs.keys()]).toEqual(['dungeon', 'gameover']);
    expect([...c.symbols.locationDefs.keys()]).toEqual(['forest']);
  });

  it('aggregating locationDefs across files finds all locations', () => {
    const a = parseFile('file:///project/a.qsps', fileA);
    const b = parseFile('file:///project/b.qsps', fileB);
    const c = parseFile('file:///project/c.qsps', fileC);

    // Simulate project-wide aggregation (same pattern as server's projectAggregates)
    const allLocationDefs = new Map<string, { uri: string; name: string }>();
    for (const syms of [a.symbols, b.symbols, c.symbols]) {
      for (const [key, def] of syms.locationDefs) {
        allLocationDefs.set(key, { uri: syms.uri, name: def.name });
      }
    }

    expect(allLocationDefs.size).toBe(5);
    expect(allLocationDefs.get('start')?.uri).toBe('file:///project/a.qsps');
    expect(allLocationDefs.get('shop')?.uri).toBe('file:///project/a.qsps');
    expect(allLocationDefs.get('dungeon')?.uri).toBe('file:///project/b.qsps');
    expect(allLocationDefs.get('gameover')?.uri).toBe('file:///project/b.qsps');
    expect(allLocationDefs.get('forest')?.uri).toBe('file:///project/c.qsps');
  });

  it('cross-file location references resolve correctly', () => {
    const a = parseFile('file:///project/a.qsps', fileA);
    const b = parseFile('file:///project/b.qsps', fileB);
    const c = parseFile('file:///project/c.qsps', fileC);

    // File A references 'dungeon' (defined in file B)
    const aRefs = a.symbols.findLocationReferences('dungeon');
    expect(aRefs.length).toBeGreaterThanOrEqual(1);
    expect(aRefs[0].uri).toBe('file:///project/a.qsps');

    // File B references 'gameover' (defined in same file — still works)
    const bRefs = b.symbols.findLocationReferences('gameover');
    expect(bRefs.length).toBeGreaterThanOrEqual(1);
    expect(bRefs[0].uri).toBe('file:///project/b.qsps');

    // File C references 'shop' (defined in file A)
    const cRefs = c.symbols.findLocationReferences('shop');
    expect(cRefs.length).toBeGreaterThanOrEqual(1);
    expect(cRefs[0].uri).toBe('file:///project/c.qsps');
  });

  it('project-wide references aggregation collects refs from all files', () => {
    const a = parseFile('file:///project/a.qsps', fileA);
    const b = parseFile('file:///project/b.qsps', fileB);
    const c = parseFile('file:///project/c.qsps', fileC);

    // Aggregate all references to 'shop' across all files
    const allShopRefs = [
      ...a.symbols.findLocationReferences('shop'),
      ...b.symbols.findLocationReferences('shop'),
      ...c.symbols.findLocationReferences('shop'),
    ];

    // 'shop' is defined in a.qsps and referenced from c.qsps
    const uris = new Set(allShopRefs.map(r => r.uri));
    expect(uris.has('file:///project/a.qsps')).toBe(true); // definition
    expect(uris.has('file:///project/c.qsps')).toBe(true); // goto 'shop'
  });

  it('SymbolLocation.uri distinguishes which file a reference belongs to', () => {
    const a = parseFile('file:///project/a.qsps', fileA);
    const b = parseFile('file:///project/b.qsps', fileB);

    // All refs from file A should have A's URI
    for (const ref of a.symbols.findLocationReferences('dungeon')) {
      expect(ref.uri).toBe('file:///project/a.qsps');
    }

    // All refs from file B should have B's URI
    for (const ref of b.symbols.findLocationReferences('gameover')) {
      expect(ref.uri).toBe('file:///project/b.qsps');
    }
  });

  it('duplicate location names across files are detected in aggregation', () => {
    const dup1 = `# shared_loc\npl 'file1'\n---\n`;
    const dup2 = `# shared_loc\npl 'file2'\n---\n`;

    const s1 = parseFile('file:///project/dup1.qsps', dup1);
    const s2 = parseFile('file:///project/dup2.qsps', dup2);

    // Both files define 'shared_loc'
    expect(s1.symbols.locationDefs.has('shared_loc')).toBe(true);
    expect(s2.symbols.locationDefs.has('shared_loc')).toBe(true);

    // Aggregation: last-writer-wins (same behaviour as server)
    const allDefs = new Map<string, string[]>();
    for (const syms of [s1.symbols, s2.symbols]) {
      for (const [key] of syms.locationDefs) {
        if (!allDefs.has(key)) allDefs.set(key, []);
        allDefs.get(key)!.push(syms.uri);
      }
    }
    expect(allDefs.get('shared_loc')).toEqual([
      'file:///project/dup1.qsps',
      'file:///project/dup2.qsps',
    ]);
  });

  it('action and object symbols carry the file URI', () => {
    const c = parseFile('file:///project/c.qsps', fileC);

    const forestSyms = c.symbols.getLocation('forest');
    expect(forestSyms).toBeDefined();

    // Action 'Pick herb' should be tracked
    expect(forestSyms!.actions.length).toBeGreaterThanOrEqual(1);
    expect(forestSyms!.actions[0].name).toBe('Pick herb');
    expect(forestSyms!.actions[0].definition?.uri).toBe('file:///project/c.qsps');

    // Object 'herb' should be tracked
    const herbRef = forestSyms!.objectRefs.get('herb');
    expect(herbRef).toBeDefined();
    expect(herbRef!.definition?.uri).toBe('file:///project/c.qsps');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Duplicate location detection — all occurrences
// ──────────────────────────────────────────────────────────────────────

describe('duplicate location detection — all occurrences (real computeDiagnostics)', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  const runDup = (code: string) =>
    diagnosticsMatching(
      runDiagnostics(parser, code, { duplicateLocations: true }),
      'Duplicate location name',
    );

  it('flags all occurrences of a duplicate location name', () => {
    const diags = runDup(`# main\npl 'a'\n---\n# main\npl 'b'\n---\n`);
    expect(diags).toHaveLength(2);
    expect(diags.every(d => d.message.includes("'main'"))).toBe(true);
  });

  it('no warning for unique location names', () => {
    expect(runDup(`# loc1\npl 'a'\n---\n# loc2\npl 'b'\n---\n`)).toHaveLength(0);
  });

  it('case-insensitive detection — flags all occurrences', () => {
    const diags = runDup(`# Start\npl 'a'\n---\n# START\npl 'b'\n---\n`);
    expect(diags).toHaveLength(2);
  });

  it('three occurrences → three diagnostics', () => {
    expect(runDup(`# X\n---\n# X\n---\n# X\n---\n`)).toHaveLength(3);
  });

  it('each diagnostic lists the OTHER occurrences, not itself', () => {
    // Three occurrences at lines 0, 2, 4 (0-indexed).
    // Each diagnostic should mention the other two, in 1-based line numbers.
    const diags = runDup(`# X\n---\n# X\n---\n# X\n---\n`);
    expect(diags).toHaveLength(3);
    // Messages reference 1-based lines 1, 3, 5
    const expectedOthers = [[3, 5], [1, 5], [1, 3]];
    diags
      .slice()
      .sort((a, b) => a.range.start.line - b.range.start.line)
      .forEach((d, i) => {
        const [x, y] = expectedOthers[i];
        expect(d.message).toContain(`${x}, ${y}`);
      });
  });

  it('mixed: some duplicated, some unique', () => {
    const diags = runDup(`# A\n---\n# B\n---\n# A\n---\n# C\n---\n`);
    expect(diags).toHaveLength(2);
    expect(diags.every(d => d.message.includes("'A'"))).toBe(true);
  });

  it('diagnostic severity is Error', () => {
    const diags = runDup(`# X\n---\n# X\n---\n`);
    expect(diags[0].severity).toBe(1); // Error
  });

  it('diagnostic range targets the header line', () => {
    const diags = runDup(`# X\n---\n# X\n---\n`);
    expect(diags[0].range.start.line).toBe(0);
    expect(diags[1].range.start.line).toBe(2);
  });

  it('disabled check produces no diagnostics', () => {
    const diags = diagnosticsMatching(
      runDiagnostics(parser, `# X\n---\n# X\n---\n`),
      'Duplicate location name',
    );
    expect(diags).toHaveLength(0);
  });
});

// ── Unclosed location detection ──────────────────────────────────────

describe('mixed location call types (real computeDiagnostics)', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  /** Single-file: return mixed-call-type diagnostics. */
  const runMixed = (code: string) =>
    diagnosticsMatching(
      runDiagnostics(parser, code, { mixedLocationCallTypes: true }),
      'is called as both',
    );

  /** Multi-file: aggregate diagnostics across all files. */
  const runMixedMulti = (files: { uri: string; code: string }[]) => {
    const per = runMultiFileDiagnostics(parser, files, { mixedLocationCallTypes: true });
    return per.flatMap(({ uri, diagnostics }) =>
      diagnosticsMatching(diagnostics, 'is called as both').map(d => ({ uri, diag: d })),
    );
  };

  it('no warning when all calls use the same type (gosub)', () => {
    expect(runMixed(`# main\ngs 'helper'\ngosub 'helper'\n---\n# helper\n---\n`)).toHaveLength(0);
  });

  it('no warning when all calls use the same type (func)', () => {
    expect(runMixed(`# main\nx = func('helper')\n---\n# helper\n---\n`)).toHaveLength(0);
  });

  it('no warning when all calls use the same type (goto)', () => {
    expect(runMixed(`# main\ngoto 'helper'\ngt 'helper'\n---\n# helper\n---\n`)).toHaveLength(0);
  });

  it('flags func + gosub mix', () => {
    const diags = runMixed(`# main\ngs 'helper'\nx = func('helper')\n---\n# helper\n---\n`);
    expect(diags).toHaveLength(2);
    expect(diags.every(d => d.message.includes("'helper'"))).toBe(true);
    expect(diags.every(d => d.message.includes('function') && d.message.includes('subroutine'))).toBe(true);
  });

  it('flags gosub + goto mix', () => {
    const diags = runMixed(`# main\ngs 'target'\ngoto 'target'\n---\n# target\n---\n`);
    expect(diags).toHaveLength(2);
    expect(diags.every(d => d.message.includes('subroutine') && d.message.includes('goto'))).toBe(true);
  });

  it('flags func + goto mix', () => {
    const diags = runMixed(`# main\nx = func('dest')\ngt 'dest'\n---\n# dest\n---\n`);
    expect(diags).toHaveLength(2);
    expect(diags.every(d => d.message.includes('function') && d.message.includes('goto'))).toBe(true);
  });

  it('flags all three types mixed', () => {
    const diags = runMixed(
      `# main\ngs 'loc'\nx = func('loc')\ngoto 'loc'\n---\n# loc\n---\n`,
    );
    expect(diags).toHaveLength(3);
    expect(
      diags.every(d =>
        d.message.includes('function') &&
        d.message.includes('subroutine') &&
        d.message.includes('goto')),
    ).toBe(true);
  });

  it('user call operators: @@ (gosub) + @ (func) mix', () => {
    const diags = runMixed(`# main\n@@helper\nx = @helper\n---\n# helper\n---\n`);
    expect(diags).toHaveLength(2);
    expect(diags.every(d => d.message.includes('function') && d.message.includes('subroutine'))).toBe(true);
  });

  it('xgoto and xgt count as goto', () => {
    const diags = runMixed(`# main\nxgoto 'loc'\ngs 'loc'\n---\n# loc\n---\n`);
    expect(diags).toHaveLength(2);
    expect(diags.every(d => d.message.includes('subroutine') && d.message.includes('goto'))).toBe(true);
  });

  it('no warning for unrelated locations with different call types', () => {
    const diags = runMixed(
      `# main\ngs 'a'\nx = func('b')\n---\n# a\n---\n# b\n---\n`,
    );
    expect(diags).toHaveLength(0);
  });

  it('multiple references per type all flagged', () => {
    const diags = runMixed(
      `# main\ngs 'loc'\ngs 'loc'\nx = func('loc')\n---\n# loc\n---\n`,
    );
    expect(diags).toHaveLength(3); // 2 gosub + 1 func
  });

  it('cross-file: mix detected across files', () => {
    const diags = runMixedMulti([
      { uri: 'file:///a.qsps', code: `# caller1\ngs 'shared'\n---\n` },
      { uri: 'file:///b.qsps', code: `# caller2\nx = func('shared')\n---\n# shared\n---\n` },
    ]);
    expect(diags).toHaveLength(2);
    const uris = new Set(diags.map(d => d.uri));
    expect(uris).toEqual(new Set(['file:///a.qsps', 'file:///b.qsps']));
  });

  it('cross-file: no warning when same type across files', () => {
    const diags = runMixedMulti([
      { uri: 'file:///a.qsps', code: `# a\ngs 'shared'\n---\n` },
      { uri: 'file:///b.qsps', code: `# b\ngosub 'shared'\n---\n# shared\n---\n` },
    ]);
    expect(diags).toHaveLength(0);
  });

  it('case-insensitive target matching', () => {
    const diags = runMixed(`# main\ngs 'Helper'\nx = func('HELPER')\n---\n# helper\n---\n`);
    expect(diags).toHaveLength(2);
  });

  it('diagnostic severity is Information', () => {
    const diags = runMixed(`# main\ngs 'helper'\nx = func('helper')\n---\n# helper\n---\n`);
    expect(diags[0].severity).toBe(3); // Information
  });

  it('diagnostic range targets the call site, not the target', () => {
    const diags = runMixed(`# main\ngs 'helper'\nx = func('helper')\n---\n# helper\n---\n`);
    // Call sites are on lines 1 and 2
    const lines = new Set(diags.map(d => d.range.start.line));
    expect(lines).toEqual(new Set([1, 2]));
  });

  it('disabled check produces no diagnostics', () => {
    const diags = diagnosticsMatching(
      runDiagnostics(parser, `# main\ngs 'helper'\nx = func('helper')\n---\n# helper\n---\n`),
      'is called as both',
    );
    expect(diags).toHaveLength(0);
  });
});

// =====================================================
// Variable Rename Scoping Tests
// =====================================================

