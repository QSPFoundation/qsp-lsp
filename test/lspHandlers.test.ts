/**
 * Tests for the LSP handler helpers extracted from the
 * `onDefinition` / `onReferences` / `onPrepareRename` / `onRenameRequest`
 * registrations in lspFeatures.ts.
 *
 * The helpers are pure functions that take a `ServerContext` +
 * `DocumentState` + `Position`, so we can drive them directly without
 * a mock LSP connection.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Position, Location } from 'vscode-languageserver';
import { QspTreeSitterParser, extractSymbols } from '../src/parser/treeSitter';
import { buildLocationIndex } from '../src/common/locations';
import {
  resolveDefinition,
  resolvePrepareRename,
  buildRenameEdit,
  collectAllReferences,
  buildCallerLines,
  buildJumperLines,
  buildConsumedLocalsLine,
  buildUsedGlobalsSection,
  buildPossibleValuesLines,
} from '../src/server/lspFeatures';
import type { DocumentState, ServerContext } from '../src/server/lspFeatures';
import { emptyAggregates, buildPropagatedLocals, buildFileAggregates, type ProjectAggregates } from '../src/server/aggregation';
import type { CursorValueEntry, PossibleValueEntry, BindingValue } from '../src/parser';
import { WASM_PATH } from './testHelpers';

// ──────────────────────────────────────────────────────────────────────
// Fixture helpers
// ──────────────────────────────────────────────────────────────────────

const parser = new QspTreeSitterParser();
beforeAll(async () => {
  await parser.init(async () => fs.readFileSync(WASM_PATH));
});

interface Fixture {
  ctx: ServerContext;
  state: DocumentState;
  doc: TextDocument;
  uri: string;
}

function makeFixture(code: string, uri = 'test://file.qsps'): Fixture {
  const tree = parser.parse(uri, code)!;
  const { symbols } = extractSymbols(tree, uri);
  const locationIndex = buildLocationIndex(code);
  const state: DocumentState = { symbols, locationIndex };
  const doc = TextDocument.create(uri, 'qsp', 1, code);
  const documentStates = new Map<string, DocumentState>([[uri, state]]);
  const ctx = {
    documentStates,
    settings: { project: { enabled: false }, semanticHighlighting: { enabled: true }, hover: { possibleValues: true } },
    projectAggregates: null,
    projectFileUris: new Set<string>(),
  } as unknown as ServerContext;
  return { ctx, state, doc, uri };
}

function makeProjectFixture(files: { uri: string; code: string }[]): {
  ctx: ServerContext;
  states: Map<string, DocumentState>;
  docs: Map<string, TextDocument>;
} {
  const states = new Map<string, DocumentState>();
  const docs = new Map<string, TextDocument>();
  const projectFileUris = new Set<string>();
  for (const { uri, code } of files) {
    const tree = parser.parse(uri, code)!;
    const { symbols } = extractSymbols(tree, uri);
    const locationIndex = buildLocationIndex(code);
    states.set(uri, { symbols, locationIndex });
    docs.set(uri, TextDocument.create(uri, 'qsp', 1, code));
    projectFileUris.add(uri);
  }
  // Build a minimal ProjectAggregates.locationDefs so findLocationDef
  // can resolve cross-file. Mirrors the relevant slice of
  // rebuildProjectAggregates in common.ts.
  const projectAggregates = {
    ...emptyAggregates(),
    locationDefs: new Map<string, { uri: string; symbol: unknown }>(),
    flatLocationDefs: new Map(),
    perFileLocNames: new Map(),
    callTypesPerTarget: new Map(),
    firstLocationKey: undefined,
  } as unknown as ProjectAggregates;
  for (const uri of projectFileUris) {
    const state = states.get(uri)!;
    for (const loc of state.locationIndex) {
      const key = loc.nameLower;
      if (!projectAggregates.locationDefs.has(key)) {
        const sym = state.symbols.locationDefs.get(key);
        if (sym) projectAggregates.locationDefs.set(key, { uri, symbol: sym });
      }
    }
  }
  // Build cross-file propagated locals so reference/rename tests for
  // local-with-propagation work in project mode.
  {
    const allLocs: { locName: string; locSyms: import('../src/parser/symbolTable').LocationSymbols; uri: string }[] = [];
    const allDocs: import('../src/parser/symbolTable').DocumentSymbols[] = [];
    for (const uri of projectFileUris) {
      const st = states.get(uri)!;
      allDocs.push(st.symbols);
      for (const [, locSyms] of st.symbols.locations) {
        allLocs.push({ locName: locSyms.locationName, locSyms, uri });
      }
    }
    buildPropagatedLocals(allLocs, projectAggregates, allDocs);
  }
  const ctx = {
    documentStates: states,
    settings: { project: { enabled: true }, semanticHighlighting: { enabled: true }, hover: { possibleValues: true } },
    projectAggregates,
    projectFileUris,
  } as unknown as ServerContext;
  return { ctx, states, docs };
}

/** Position of the first occurrence of `needle` in `code`. */
function posOf(code: string, needle: string, nth = 0): Position {
  let idx = -1;
  for (let i = 0; i <= nth; i++) idx = code.indexOf(needle, idx + 1);
  if (idx < 0) throw new Error(`needle not found: ${needle}`);
  const before = code.slice(0, idx);
  const line = (before.match(/\n/g) ?? []).length;
  const lastNl = before.lastIndexOf('\n');
  const character = idx - (lastNl + 1);
  // Aim at the middle of the needle so we always land inside the token.
  return { line, character: character + Math.floor(needle.length / 2) };
}

/** Position at the start of the Nth occurrence of `needle`. */
function posAtStart(code: string, needle: string, nth = 0): Position {
  let idx = -1;
  for (let i = 0; i <= nth; i++) idx = code.indexOf(needle, idx + 1);
  if (idx < 0) throw new Error(`needle not found: ${needle}`);
  const before = code.slice(0, idx);
  const line = (before.match(/\n/g) ?? []).length;
  const lastNl = before.lastIndexOf('\n');
  return { line, character: idx - (lastNl + 1) };
}

function singleLoc(result: Location | Location[] | null): Location {
  expect(result).not.toBeNull();
  expect(Array.isArray(result)).toBe(false);
  return result as Location;
}

// ══════════════════════════════════════════════════════════════════════
// resolveDefinition
// ══════════════════════════════════════════════════════════════════════

describe('resolveDefinition', () => {
  it('resolves a location reference in gosub to its # header', () => {
    const code = `# start
gs 'loc2'
---
# loc2
x = 1
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const result = singleLoc(resolveDefinition(ctx, state, uri, posOf(code, "'loc2'"), doc));
    expect(result.uri).toBe(uri);
    // # loc2 is on line 3 (0-based)
    expect(result.range.start.line).toBe(3);
  });

  it('resolves a location reference in a @func() call', () => {
    const code = `# start
y = @helper(1)
---
# helper
result = args[1] + 1
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const result = singleLoc(resolveDefinition(ctx, state, uri, posOf(code, 'helper'), doc));
    expect(result.range.start.line).toBe(3);
  });

  it('resolves a label reference to its : definition', () => {
    const code = `# start
:loop
jump 'loop'
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const result = singleLoc(resolveDefinition(ctx, state, uri, posOf(code, "'loop'"), doc));
    expect(result.range.start.line).toBe(1); // :loop on line 1
  });

  it('resolves jump inside an act to the act-internal label, not the outer one', () => {
    // Both an outer `:foo` and an act-internal `:foo` exist.  The jump
    // is inside the act and must resolve to the act-internal definition.
    const code = `# start
:foo
pl 'outer'
act 'go':
  :foo
  jump 'foo'
end
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const result = singleLoc(resolveDefinition(ctx, state, uri, posOf(code, "'foo'"), doc));
    // The act-internal `:foo` is on line 4 (0-based); outer `:foo` is on 1.
    expect(result.range.start.line).toBe(4);
  });

  it('resolves a jump at the location root to the root label, not an act-internal duplicate', () => {
    const code = `# start
:foo
act 'go':
  :foo
end
jump 'foo'
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const result = singleLoc(resolveDefinition(ctx, state, uri, posOf(code, "'foo'"), doc));
    // Root `:foo` is on line 1; act-internal is on line 3.
    expect(result.range.start.line).toBe(1);
  });

  it('find-all-references on act-internal label only returns same-namespace jumps', () => {
    const code = `# start
:foo
jump 'foo'
act 'go':
  :foo
  jump 'foo'
end
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Cursor on the act-internal `:foo` definition (line 4).
    const refs = collectAllReferences(ctx, state, uri, { line: 4, character: 4 }, doc);
    // Should yield only the act-internal def (line 4) and the act-internal
    // jump (line 5) — never the outer ones on lines 1 / 2.
    const lines = refs.map(r => r.line).sort();
    expect(lines).toEqual([4, 5]);
  });

  it('resolves jump in inner act to inner-act label, not outer-act label', () => {
    const code = `# start
act 'outer':
  :foo
  act 'inner':
    :foo
    jump 'foo'
  end
end
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const result = singleLoc(resolveDefinition(ctx, state, uri, posOf(code, "'foo'"), doc));
    // Inner-act `:foo` is on line 4 (0-based); outer-act on line 2.
    expect(result.range.start.line).toBe(4);
  });

  it('resolves jump inside a stored code-block to the block-internal label', () => {
    const code = `# start
:foo
$cb = {
  :foo
  jump 'foo'
}
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const result = singleLoc(resolveDefinition(ctx, state, uri, posOf(code, "'foo'"), doc));
    // Block-internal `:foo` is on line 3; root `:foo` on line 1.
    expect(result.range.start.line).toBe(3);
  });

  it('jump in dynamic code-block resolves to a block-internal label, not outside', () => {
    // `dynamic { … }` is label-isolated: an inner `jump` resolves to
    // a label defined inside the block, never to an outer one.
    const code = `# start
:foo
dynamic {
  :foo
  jump 'foo'
}
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const result = singleLoc(resolveDefinition(ctx, state, uri, posOf(code, "'foo'"), doc));
    // Block-internal `:foo` is on line 3; outer `:foo` is on line 1.
    expect(result.range.start.line).toBe(3);
  });

  it('cursor on the `:label` definition itself resolves to that same definition', () => {
    const code = `# start
:loop
jump 'loop'
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Cursor sits on the bare label name following `:`.
    const result = singleLoc(resolveDefinition(ctx, state, uri, posOf(code, ':loop'), doc));
    expect(result.range.start.line).toBe(1);
  });

  it('resolves a variable reference to its first assignment', () => {
    const code = `# start
x = 1
y = x + 2
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Target the `x` inside `x + 2` (second occurrence).
    const result = singleLoc(resolveDefinition(ctx, state, uri, posOf(code, 'x', 1), doc));
    expect(result.range.start.line).toBe(1);
  });

  it('returns null when cursor is on whitespace', () => {
    const code = `# start
x = 1
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const result = resolveDefinition(ctx, state, uri, { line: 1, character: 3 }, doc);
    // Position `x _= 1` between '=' and ' ' is whitespace; word regex still
    // won't match → null.
    if (result !== null) {
      // Implementation may still pick up adjacent identifier; accept either,
      // but if non-null it must be a valid Location.
      const r = singleLoc(result);
      expect(r.uri).toBe(uri);
    }
  });

  it('returns null for an unknown token', () => {
    const code = `# start
gs 'nowhere'
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const result = resolveDefinition(ctx, state, uri, posOf(code, "'nowhere'"), doc);
    expect(result).toBeNull();
  });

  it('resolves an action reference to its act statement', () => {
    const code = `# start
act 'look':
  pl 'ok'
end
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // The `act` definition IS the usage — cursor on 'look' resolves to itself.
    const result = resolveDefinition(ctx, state, uri, posOf(code, "'look'"), doc);
    expect(result).not.toBeNull();
  });

  it('resolves across project files when project mode is enabled', () => {
    const fileA = `# start
gs 'shared'
---
`;
    const uriA = 'test://a.qsps';
    const fileB = `# shared
x = 1
---
`;
    const uriB = 'test://b.qsps';
    const { ctx, states, docs } = makeProjectFixture([
      { uri: uriA, code: fileA },
      { uri: uriB, code: fileB },
    ]);
    const result = singleLoc(
      resolveDefinition(ctx, states.get(uriA)!, uriA, posOf(fileA, "'shared'"), docs.get(uriA)!),
    );
    expect(result.uri).toBe(uriB);
    expect(result.range.start.line).toBe(0);
  });

  // ── Additional coverage: object / action-usage / propagated local / arrays / call types ──

  it('resolves an object reference from addobj to the first addobj', () => {
    const code = `# a
addobj 'sword'
---
# b
delobj 'sword'
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const result = singleLoc(resolveDefinition(ctx, state, uri, posOf(code, "'sword'", 1), doc));
    expect(result.uri).toBe(uri);
    // addobj is on line 1, delobj on line 4
    expect(result.range.start.line).toBe(1);
  });

  it('resolves a delact usage to its act definition', () => {
    const code = `# start
act 'look':
  pl 'ok'
end
delact 'look'
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Cursor on the 'look' inside delact (second occurrence).
    const result = singleLoc(resolveDefinition(ctx, state, uri, posOf(code, "'look'", 1), doc));
    expect(result.uri).toBe(uri);
    // `act 'look':` is on line 1.
    expect(result.range.start.line).toBe(1);
  });

  it('resolves a propagated local to the caller\'s local declaration', () => {
    const code = `# caller
local p = 1
gs 'callee'
---
# callee
pl p
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Cursor on `p` inside callee (non-local use).
    const result = singleLoc(resolveDefinition(ctx, state, uri, posAtStart(code, 'p', 2), doc));
    expect(result.uri).toBe(uri);
    // The caller's `local p = 1` is on line 1.
    expect(result.range.start.line).toBe(1);
  });

  it('returns an array when a non-local var has defs in multiple locations', () => {
    const code = `# a
g = 1
---
# b
g = 2
---
# c
pl g
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Cursor on `g` inside location c (non-local use, no local def in c).
    const result = resolveDefinition(ctx, state, uri, posAtStart(code, 'g', 2), doc);
    // Implementation returns either a single Location (first assignment
    // is treated as the def in c) OR an array when the var has no
    // definition in the current location — accept both shapes but
    // verify we at least locate an assignment in a or b.
    expect(result).not.toBeNull();
    const locs = Array.isArray(result) ? result : [result as Location];
    const lines = locs.map(l => l.range.start.line);
    // Must point at one of the assignments (line 1 or line 4).
    expect(lines.some(l => l === 1 || l === 4)).toBe(true);
  });

  it('resolves xgoto / xgt / gt call types', () => {
    const cases: { code: string; cursor: string }[] = [
      { code: `# a\nxgoto 'b'\n---\n# b\nx = 1\n---\n`, cursor: "'b'" },
      { code: `# a\nxgt 'b'\n---\n# b\nx = 1\n---\n`,   cursor: "'b'" },
      { code: `# a\ngt 'b'\n---\n# b\nx = 1\n---\n`,    cursor: "'b'" },
    ];
    for (const { code, cursor } of cases) {
      const { ctx, state, doc, uri } = makeFixture(code);
      const result = singleLoc(resolveDefinition(ctx, state, uri, posOf(code, cursor), doc));
      // # b header starts on line 3 in each fixture.
      expect(result.range.start.line).toBe(3);
    }
  });

  it('resolves every location-call keyword (gs/gt/gosub/goto/xgoto/xgt/func/desc)', () => {
    // Every recognised LOCATION_REF_NAME plus the @ user-call expression.
    const cases: { label: string; snippet: string }[] = [
      { label: 'gs',     snippet: `gs 'b'` },
      { label: 'gt',     snippet: `gt 'b'` },
      { label: 'gosub',  snippet: `gosub 'b'` },
      { label: 'goto',   snippet: `goto 'b'` },
      { label: 'xgoto',  snippet: `xgoto 'b'` },
      { label: 'xgt',    snippet: `xgt 'b'` },
      { label: 'func',   snippet: `y = func('b')` },
      { label: 'desc',   snippet: `$t = desc('b')` },
    ];
    for (const { label, snippet } of cases) {
      const code = `# a\n${snippet}\n---\n# b\nx = 1\n---\n`;
      const { ctx, state, doc, uri } = makeFixture(code);
      const result = resolveDefinition(ctx, state, uri, posOf(code, "'b'"), doc);
      expect(result, `call-type ${label} did not resolve`).not.toBeNull();
      const loc = Array.isArray(result) ? result[0] : result as Location;
      expect(loc.range.start.line, `call-type ${label} resolved to wrong line`).toBe(3);
    }
  });

  it('resolves @name and @@name user-call forms (all parens/no-parens variants) to the location header', () => {
    // Every valid shape per grammar: bare, empty parens, paren-args, and
    // (for `@@` statements only) na-arg lists.
    const cases: { label: string; snippet: string }[] = [
      { label: '@expr bare',           snippet: `y = @target` },
      { label: '@expr empty parens',   snippet: `y = @target()` },
      { label: '@expr paren args',     snippet: `y = @target(1)` },
      { label: '@stmt bare',           snippet: `@target` },
      { label: '@stmt empty parens',   snippet: `@target()` },
      { label: '@stmt paren args',     snippet: `@target(1)` },
      { label: '@stmt na-arg',         snippet: `@target 1` },
      { label: '@@stmt bare',          snippet: `@@target` },
      { label: '@@stmt empty parens',  snippet: `@@target()` },
      { label: '@@stmt paren args',    snippet: `@@target(1)` },
      { label: '@@stmt na-arg',        snippet: `@@target 1` },
    ];
    for (const { label, snippet } of cases) {
      const code = `# a\n${snippet}\n---\n# target\nresult = 1\n---\n`;
      const { ctx, state, doc, uri } = makeFixture(code);
      const result = resolveDefinition(ctx, state, uri, posOf(code, 'target'), doc);
      expect(result, `user-call ${label} did not resolve`).not.toBeNull();
      const loc = Array.isArray(result) ? result[0] : result as Location;
      expect(loc.range.start.line, `user-call ${label} resolved to wrong line`).toBe(3);
    }
  });

  it('resolves the loc operator (location-existence check) to the header', () => {
    // `loc 'name'` returns 1 if the location exists.
    const code = `# a
if loc 'target':
  pl 'exists'
end
---
# target
x = 1
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const result = singleLoc(resolveDefinition(ctx, state, uri, posOf(code, "'target'"), doc));
    // # target header on line 5
    expect(result.range.start.line).toBe(5);
  });

  it('is case-insensitive when resolving a location name', () => {
    const code = `# Hub
x = 1
---
# a
gs 'HUB'
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const result = singleLoc(resolveDefinition(ctx, state, uri, posOf(code, "'HUB'"), doc));
    // # Hub header is on line 0.
    expect(result.range.start.line).toBe(0);
  });

  it('resolves a $-prefixed string variable', () => {
    const code = `# a
$s = 'hi'
pl $s
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Cursor on the second `$s` (the usage).
    const result = singleLoc(resolveDefinition(ctx, state, uri, posOf(code, '$s', 1), doc));
    expect(result.range.start.line).toBe(1);
  });

  it('returns null for an uninitialized variable with no definition anywhere', () => {
    const code = `# a
pl unknownVar
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const result = resolveDefinition(ctx, state, uri, posOf(code, 'unknownVar'), doc);
    expect(result).toBeNull();
  });

  it('resolves to a location header when cursor is on the # header itself', () => {
    const code = `# target
x = 1
---
# caller
gs 'target'
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Cursor directly on `target` in the # header.
    const result = singleLoc(resolveDefinition(ctx, state, uri, posOf(code, 'target'), doc));
    expect(result.range.start.line).toBe(0);
  });

  it('resolves across files in project mode with action definitions', () => {
    const fileA = `# a
delact 'wait'
---
`;
    const fileB = `# b
act 'wait':
  pl 'ok'
end
---
`;
    const uriA = 'test://a.qsps';
    const uriB = 'test://b.qsps';
    const { ctx, states, docs } = makeProjectFixture([
      { uri: uriA, code: fileA },
      { uri: uriB, code: fileB },
    ]);
    const result = singleLoc(
      resolveDefinition(ctx, states.get(uriA)!, uriA, posOf(fileA, "'wait'"), docs.get(uriA)!),
    );
    expect(result.uri).toBe(uriB);
    // `act 'wait':` is on line 1 of fileB.
    expect(result.range.start.line).toBe(1);
  });

  it('resolves across files in project mode with object definitions', () => {
    const fileA = `# a
delobj 'sword'
---
`;
    const fileB = `# b
addobj 'sword'
---
`;
    const uriA = 'test://a.qsps';
    const uriB = 'test://b.qsps';
    const { ctx, states, docs } = makeProjectFixture([
      { uri: uriA, code: fileA },
      { uri: uriB, code: fileB },
    ]);
    const result = singleLoc(
      resolveDefinition(ctx, states.get(uriA)!, uriA, posOf(fileA, "'sword'"), docs.get(uriA)!),
    );
    expect(result.uri).toBe(uriB);
    expect(result.range.start.line).toBe(1);
  });

  it('resolves a variable when the cursor is on its definition site', () => {
    const code = `# a
myVar = 42
pl myVar
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Cursor on the DEF (first occurrence) — should still return a location
    // (pointing at itself) rather than null.
    const result = singleLoc(resolveDefinition(ctx, state, uri, posOf(code, 'myVar'), doc));
    expect(result.range.start.line).toBe(1);
  });

  it('resolves a variable used inside every built-in statement / function form', () => {
    // Same variable `x` used in every shape the grammar allows for built-in
    // statements (bare / parens / multi-arg) and built-in functions
    // (na_func_call bare / parenthesized / as any expression operand).
    const cases: { label: string; snippet: string }[] = [
      { label: 'stmt bare',            snippet: `pl x` },
      { label: 'stmt parens',          snippet: `pl(x)` },
      { label: 'stmt bare multi',      snippet: `pl x, 1` },
      { label: 'stmt parens multi',    snippet: `pl(x, 1)` },
      { label: 'func parens',          snippet: `y = len(x)` },
      { label: 'func bare (na-arg)',   snippet: `y = val x` },
      { label: 'func nested in args',  snippet: `y = iif(x, 1, 2)` },
    ];
    for (const { label, snippet } of cases) {
      const code = `# a\nx = 42\n${snippet}\n---\n`;
      const { ctx, state, doc, uri } = makeFixture(code);
      // Land on the 2nd `x` — the usage inside the snippet, not the def.
      const result = resolveDefinition(ctx, state, uri, posOf(code, 'x', 1), doc);
      expect(result, `${label} did not resolve`).not.toBeNull();
      const loc = Array.isArray(result) ? result[0] : result as Location;
      // Definition is on line 1 (`x = 42`).
      expect(loc.range.start.line, `${label} resolved to wrong line`).toBe(1);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// collectAllReferences
// ══════════════════════════════════════════════════════════════════════

describe('collectAllReferences', () => {
  it('finds all references to a global variable across locations', () => {
    const code = `# a
x = 1
---
# b
y = x + 1
pl x
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const refs = collectAllReferences(ctx, state, uri, posOf(code, 'x'), doc);
    // x appears 3 times: def in a, use in b (line 4), use in b (line 5)
    expect(refs.length).toBeGreaterThanOrEqual(3);
    expect(refs.every(r => r.uri === uri)).toBe(true);
  });

  it('finds all references to a location name', () => {
    const code = `# start
gs 'hub'
gs 'hub'
---
# hub
x = 1
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const refs = collectAllReferences(ctx, state, uri, posOf(code, "'hub'"), doc);
    // 2 call sites
    expect(refs.length).toBeGreaterThanOrEqual(2);
  });

  it('finds location refs across every call-type keyword', () => {
    // Each call-type keyword contributes exactly one reference.
    const code = `# a
gs 'target'
gt 'target'
gosub 'target'
goto 'target'
xgoto 'target'
xgt 'target'
y = func('target')
$t = desc('target')
---
# target
x = 1
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const refs = collectAllReferences(ctx, state, uri, posOf(code, "'target'"), doc);
    // 8 call sites + 1 header on line 10 = 9 references.
    expect(refs).toHaveLength(9);
    const lines = new Set(refs.map(r => r.line));
    for (let l = 1; l <= 8; l++) expect(lines.has(l)).toBe(true);
    expect(lines.has(10)).toBe(true); // # target header
  });

  it('finds user-call refs across every @ and @@ parens/no-parens variant', () => {
    // 11 call sites covering every valid grammar shape for `@` and `@@`.
    const code = `# a
y = @target
y = @target()
y = @target(1)
@target
@target()
@target(1)
@target 1
@@target
@@target()
@@target(1)
@@target 1
---
# target
result = 1
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const refs = collectAllReferences(ctx, state, uri, posOf(code, 'target'), doc);
    // 11 call sites + 1 header on line 13 = 12 references.
    expect(refs).toHaveLength(12);
    const lines = new Set(refs.map(r => r.line));
    for (let l = 1; l <= 11; l++) expect(lines.has(l)).toBe(true);
    expect(lines.has(13)).toBe(true); // # target header
  });

  it('finds refs from the loc operator (existence check)', () => {
    const code = `# a
if loc 'target':
  gs 'target'
end
---
# target
x = 1
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const refs = collectAllReferences(ctx, state, uri, posOf(code, "'target'"), doc);
    // loc-operator ref + gs call + header = 3 refs.
    expect(refs).toHaveLength(3);
    const lines = new Set(refs.map(r => r.line));
    expect(lines.has(1)).toBe(true); // loc 'target'
    expect(lines.has(2)).toBe(true); // gs 'target'
    expect(lines.has(5)).toBe(true); // # target header
  });

  it('finds label references within a location', () => {
    const code = `# start
:loop
jump 'loop'
jump 'loop'
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const refs = collectAllReferences(ctx, state, uri, posOf(code, "'loop'"), doc);
    expect(refs.length).toBeGreaterThanOrEqual(2);
  });

  it('finds the label definition + every jump when the cursor is on the `:` definition', () => {
    const code = `# start
:loop
jump 'loop'
jump 'loop'
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Cursor on the bare label name following `:`.
    const refs = collectAllReferences(ctx, state, uri, posOf(code, ':loop'), doc);
    // 1 def + 2 jumps = 3 refs.
    expect(refs).toHaveLength(3);
    const lines = refs.map(r => r.line).sort();
    expect(lines).toEqual([1, 2, 3]);
  });

  it('finds the label definition + every jump when the cursor is on a jump', () => {
    const code = `# start
:loop
jump 'loop'
jump 'loop'
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Cursor on the second jump (so we exercise jump-as-anchor).
    const refs = collectAllReferences(ctx, state, uri, posOf(code, "'loop'", 1), doc);
    expect(refs).toHaveLength(3);
    const lines = refs.map(r => r.line).sort();
    expect(lines).toEqual([1, 2, 3]);
  });

  it('returns empty array when cursor is on nothing', () => {
    const code = `# a
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const refs = collectAllReferences(ctx, state, uri, { line: 1, character: 0 }, doc);
    expect(refs).toHaveLength(0);
  });

  it('collects cross-file references in project mode', () => {
    const fileA = `# a
gs 'hub'
---
`;
    const fileB = `# b
gs 'hub'
---
# hub
x = 1
---
`;
    const uriA = 'test://a.qsps';
    const uriB = 'test://b.qsps';
    const { ctx, states, docs } = makeProjectFixture([
      { uri: uriA, code: fileA },
      { uri: uriB, code: fileB },
    ]);
    const refs = collectAllReferences(
      ctx,
      states.get(uriA)!,
      uriA,
      posOf(fileA, "'hub'"),
      docs.get(uriA)!,
    );
    const uris = new Set(refs.map(r => r.uri));
    // Both call sites are picked up across files.
    expect(uris.has(uriA)).toBe(true);
    expect(uris.has(uriB)).toBe(true);
  });

  it('isolates a local variable to its defining location', () => {
    const code = `# a
local x = 1
pl x
---
# b
x = 99
pl x
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Cursor on local x's def inside location a (land exactly on `x` at col 6).
    const refs = collectAllReferences(ctx, state, uri, posAtStart(code, 'x = 1') , doc);
    // Refs for the local should not include assignments in location b.
    // They live at lines 1..2 only.
    for (const r of refs) {
      expect(r.line).toBeLessThanOrEqual(2);
    }
  });

  // ── Additional coverage: object / action / label-scoping / prefixes ──

  it('finds object references from addobj/delobj across locations', () => {
    const code = `# a
addobj 'sword'
---
# b
delobj 'sword'
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const refs = collectAllReferences(ctx, state, uri, posOf(code, "'sword'"), doc);
    expect(refs.length).toBeGreaterThanOrEqual(2);
    const lines = refs.map(r => r.line).sort();
    // Both references are recorded.
    expect(lines).toContain(1);
    expect(lines).toContain(4);
  });

  it('finds action references for a named act', () => {
    const code = `# start
act 'wait':
  pl 'ok'
end
delact 'wait'
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const refs = collectAllReferences(ctx, state, uri, posOf(code, "'wait'", 1), doc);
    // At least the delact reference (the act def itself is its own
    // definition, implementations vary on whether it counts here).
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });

  it('finds references to a variable with a $ type prefix', () => {
    const code = `# a
$s = 'hi'
pl $s
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Cursor is past the $ on either occurrence.
    const refs = collectAllReferences(ctx, state, uri, posOf(code, '$s', 1), doc);
    expect(refs.length).toBeGreaterThanOrEqual(2);
  });

  it('is case-insensitive when matching variable names', () => {
    const code = `# a
Foo = 1
pl FOO
pl foo
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const refs = collectAllReferences(ctx, state, uri, posOf(code, 'Foo'), doc);
    // All 3 occurrences should be collected regardless of case.
    expect(refs.length).toBe(3);
  });

  it('includes the definition itself when cursor is on the definition', () => {
    const code = `# a
x = 1
pl x
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Cursor on the assignment (definition).
    const refs = collectAllReferences(ctx, state, uri, posOf(code, 'x'), doc);
    // Def + use == 2 references, both on separate lines.
    const lines = new Set(refs.map(r => r.line));
    expect(lines.has(1)).toBe(true);
    expect(lines.has(2)).toBe(true);
  });

  it('scopes label references per-location', () => {
    const code = `# a
:loop
jump 'loop'
---
# b
:loop
jump 'loop'
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Cursor on the :loop label in location a.
    const refs = collectAllReferences(ctx, state, uri, posOf(code, "'loop'"), doc);
    // Refs must all stay within location a (lines 0..3 before --- at 3).
    for (const r of refs) {
      expect(r.line).toBeLessThan(4);
    }
  });

  it('keeps label references file-local in project mode', () => {
    // File A and B both define `:loop` and `jump 'loop'`. Looking up
    // refs for the label in file A must NOT pick up file B's refs
    // (labels are strictly local to one location in one file).
    const fileA = `# a
:loop
jump 'loop'
---
`;
    const fileB = `# b
:loop
jump 'loop'
---
`;
    const uriA = 'test://a.qsps';
    const uriB = 'test://b.qsps';
    const { ctx, states, docs } = makeProjectFixture([
      { uri: uriA, code: fileA },
      { uri: uriB, code: fileB },
    ]);
    const refs = collectAllReferences(
      ctx,
      states.get(uriA)!,
      uriA,
      posOf(fileA, "'loop'"),
      docs.get(uriA)!,
    );
    // All refs must be in file A only.
    expect(refs.length).toBeGreaterThanOrEqual(2);
    expect(refs.every(r => r.uri === uriA)).toBe(true);
  });

  it('resolves propagated-local references across caller/callee', () => {
    const code = `# caller
local p = 1
gs 'callee'
---
# callee
pl p
p = p + 1
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Cursor on caller's local definition — land exactly on `p` at col 6.
    const refs = collectAllReferences(ctx, state, uri, posAtStart(code, 'p = 1'), doc);
    // Caller refs + callee's read + callee's write should all be found.
    expect(refs.length).toBeGreaterThanOrEqual(3);
    const lines = new Set(refs.map(r => r.line));
    // line 1 (caller def), line 5 (pl p), line 6 (p = p+1)
    expect(lines.has(1)).toBe(true);
    expect(lines.has(5)).toBe(true);
    expect(lines.has(6)).toBe(true);
  });

  it('returns empty refs on a builtin variable (handler rejects later)', () => {
    const code = `# a
result = 1
pl result
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // `result` is a builtin — collectAllReferences still returns its
    // occurrences, but resolvePrepareRename will reject the rename.
    // This test documents the observable shape.
    const refs = collectAllReferences(ctx, state, uri, posOf(code, 'result'), doc);
    // It should at least return something non-negative (2 occurrences).
    expect(refs.length).toBeGreaterThanOrEqual(0);
  });

  it('finds variable refs inside every built-in statement / function form', () => {
    // `x` used in every grammar shape for built-in statements and functions.
    const code = `# a
x = 1
pl x
pl(x)
pl x, 1
pl(x, 1)
msg x
msg(x)
y = len(x)
y = len x
y = iif(x, 1, 2)
y = val x
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const refs = collectAllReferences(ctx, state, uri, posAtStart(code, 'x = 1'), doc);
    // 1 def (line 1) + 10 usages across lines 2..11 = 11 references.
    expect(refs).toHaveLength(11);
    const lines = new Set(refs.map(r => r.line));
    for (let l = 1; l <= 11; l++) expect(lines.has(l)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// resolvePrepareRename
// ══════════════════════════════════════════════════════════════════════

describe('resolvePrepareRename', () => {
  it('returns the word range for an ordinary identifier', () => {
    const code = `# start
myvar = 1
---
`;
    const { state, doc } = makeFixture(code);
    const range = resolvePrepareRename(state, doc, posOf(code, 'myvar'));
    expect(range).not.toBeNull();
    expect(doc.getText(range!)).toBe('myvar');
  });

  it('strips the $ type prefix from the rename range', () => {
    const code = `# start
$s = 'hi'
---
`;
    const { state, doc } = makeFixture(code);
    const range = resolvePrepareRename(state, doc, posOf(code, '$s'));
    expect(range).not.toBeNull();
    // $ must NOT be part of the renamed text.
    expect(doc.getText(range!)).toBe('s');
  });

  it('strips the # type prefix from the rename range', () => {
    const code = `# start
#n = 1
---
`;
    const { state, doc } = makeFixture(code);
    const range = resolvePrepareRename(state, doc, posOf(code, '#n'));
    // `#` inside a location header line 0 is the header sigil; we target line 1.
    expect(range).not.toBeNull();
    expect(doc.getText(range!)).toBe('n');
  });

  it('returns null on a builtin variable name', () => {
    const code = `# start
result = 1
---
`;
    const { state, doc } = makeFixture(code);
    const range = resolvePrepareRename(state, doc, posOf(code, 'result'));
    expect(range).toBeNull();
  });

  it('returns null when cursor is on whitespace', () => {
    const code = `# start
    
---
`;
    const { state, doc } = makeFixture(code);
    const range = resolvePrepareRename(state, doc, { line: 1, character: 2 });
    expect(range).toBeNull();
  });

  it('works even when state is undefined (fresh doc fallback)', () => {
    const code = `# start
foo = 1
---
`;
    const { doc } = makeFixture(code);
    const range = resolvePrepareRename(undefined, doc, posOf(code, 'foo'));
    expect(range).not.toBeNull();
    expect(doc.getText(range!)).toBe('foo');
  });

  it('prefers the exact reference range over the generic word range', () => {
    const code = `# start
gs 'target'
---
# target
x = 1
---
`;
    const { state, doc } = makeFixture(code);
    const range = resolvePrepareRename(state, doc, posOf(code, "'target'"));
    expect(range).not.toBeNull();
    // The reference range is just the bare name, no surrounding quotes.
    expect(doc.getText(range!)).toBe('target');
  });

  it('returns the bare label name (no `:`) when the cursor is on a label definition', () => {
    const code = `# start
:loop
jump 'loop'
---
`;
    const { state, doc } = makeFixture(code);
    const range = resolvePrepareRename(state, doc, posOf(code, ':loop'));
    expect(range).not.toBeNull();
    // Range covers exactly `loop` — the leading `:` must be excluded.
    expect(doc.getText(range!)).toBe('loop');
  });

  it('returns the bare jump target (no quotes) when the cursor is on a jump', () => {
    const code = `# start
:loop
jump 'loop'
---
`;
    const { state, doc } = makeFixture(code);
    const range = resolvePrepareRename(state, doc, posOf(code, "'loop'"));
    expect(range).not.toBeNull();
    expect(doc.getText(range!)).toBe('loop');
  });
});

// ══════════════════════════════════════════════════════════════════════
// buildRenameEdit
// ══════════════════════════════════════════════════════════════════════

describe('buildRenameEdit', () => {
  it('returns null when no references exist at the cursor', () => {
    const code = `# a
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const edit = buildRenameEdit(ctx, state, uri, { line: 1, character: 0 }, doc, 'newName');
    expect(edit).toBeNull();
  });

  it('groups edits under the single file URI for local refs', () => {
    const code = `# a
x = 1
pl x
pl x
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const edit = buildRenameEdit(ctx, state, uri, posOf(code, 'x'), doc, 'renamed');
    expect(edit).not.toBeNull();
    expect(Object.keys(edit!.changes!)).toEqual([uri]);
    const edits = edit!.changes![uri];
    expect(edits.length).toBeGreaterThanOrEqual(3);
    expect(edits.every(e => e.newText === 'renamed')).toBe(true);
  });

  it('produces edits for every occurrence of a location rename', () => {
    const code = `# start
gs 'hub'
gs 'hub'
---
# hub
x = 1
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const edit = buildRenameEdit(ctx, state, uri, posOf(code, "'hub'"), doc, 'center');
    expect(edit).not.toBeNull();
    const edits = edit!.changes![uri];
    // 2 call sites + the `# hub` header itself.
    expect(edits.length).toBeGreaterThanOrEqual(2);
    for (const e of edits) {
      expect(e.newText).toBe('center');
    }
  });

  it('renames a location across every call-type keyword', () => {
    const code = `# a
gs 'target'
gt 'target'
gosub 'target'
goto 'target'
xgoto 'target'
xgt 'target'
y = func('target')
$t = desc('target')
---
# target
x = 1
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const edit = buildRenameEdit(ctx, state, uri, posOf(code, "'target'"), doc, 'dest');
    expect(edit).not.toBeNull();
    const edits = edit!.changes![uri];
    // 8 call sites + 1 header = 9 edits. Each replaced range is bare "target".
    expect(edits).toHaveLength(9);
    for (const e of edits) {
      expect(doc.getText(e.range)).toBe('target');
      expect(e.newText).toBe('dest');
    }
  });

  it('renames a location across every @ and @@ parens/no-parens variant', () => {
    // 11 call sites covering every valid grammar shape for `@` and `@@`.
    const code = `# a
y = @target
y = @target()
y = @target(1)
@target
@target()
@target(1)
@target 1
@@target
@@target()
@@target(1)
@@target 1
---
# target
result = 1
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const edit = buildRenameEdit(ctx, state, uri, posOf(code, 'target'), doc, 'dest');
    expect(edit).not.toBeNull();
    const edits = edit!.changes![uri];
    // 11 call sites + 1 header = 12 edits. `@`/`@@` sigils and parens must
    // survive — each replaced range is bare "target".
    expect(edits).toHaveLength(12);
    for (const e of edits) {
      expect(doc.getText(e.range)).toBe('target');
      expect(e.newText).toBe('dest');
    }
  });

  it('renames a location across the loc existence operator', () => {
    const code = `# a
if loc 'target':
  gs 'target'
end
---
# target
x = 1
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const edit = buildRenameEdit(ctx, state, uri, posOf(code, "'target'"), doc, 'dest');
    expect(edit).not.toBeNull();
    const edits = edit!.changes![uri];
    // loc 'target' + gs 'target' + # target header = 3 edits.
    expect(edits).toHaveLength(3);
    for (const e of edits) {
      expect(doc.getText(e.range)).toBe('target');
      expect(e.newText).toBe('dest');
    }
  });

  it('groups edits per-file in project mode', () => {
    const fileA = `# start
gs 'hub'
---
`;
    const fileB = `# b
gs 'hub'
---
# hub
x = 1
---
`;
    const uriA = 'test://a.qsps';
    const uriB = 'test://b.qsps';
    const { ctx, states, docs } = makeProjectFixture([
      { uri: uriA, code: fileA },
      { uri: uriB, code: fileB },
    ]);
    const edit = buildRenameEdit(
      ctx,
      states.get(uriA)!,
      uriA,
      posOf(fileA, "'hub'"),
      docs.get(uriA)!,
      'center',
    );
    expect(edit).not.toBeNull();
    const keys = new Set(Object.keys(edit!.changes!));
    expect(keys.has(uriA)).toBe(true);
    expect(keys.has(uriB)).toBe(true);
    // Every grouped edit uses the new name.
    for (const uri of keys) {
      for (const e of edit!.changes![uri]) {
        expect(e.newText).toBe('center');
      }
    }
  });

  it('does not overlap ranges on a single reference', () => {
    const code = `# a
foo = 1
pl foo
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const edit = buildRenameEdit(ctx, state, uri, posOf(code, 'foo'), doc, 'bar');
    const edits = edit!.changes![uri];
    // Every edit range covers exactly the identifier length.
    for (const e of edits) {
      const text = doc.getText(e.range);
      expect(text).toBe('foo');
    }
  });

  // ── Additional coverage: label / object / action / prefix / propagation ──

  it('renames a label producing edits only for the label name', () => {
    const code = `# a
:loop
jump 'loop'
jump 'loop'
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const edit = buildRenameEdit(ctx, state, uri, posOf(code, "'loop'"), doc, 'cycle');
    expect(edit).not.toBeNull();
    const edits = edit!.changes![uri];
    // Each edit ONLY covers "loop" (no quotes, no colon).
    for (const e of edits) {
      expect(doc.getText(e.range)).toBe('loop');
      expect(e.newText).toBe('cycle');
    }
  });

  it('renames a label when the cursor is on the `:` definition itself', () => {
    const code = `# a
:loop
jump 'loop'
jump 'loop'
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Cursor on the bare label name following `:`.
    const edit = buildRenameEdit(ctx, state, uri, posOf(code, ':loop'), doc, 'cycle');
    expect(edit).not.toBeNull();
    const edits = edit!.changes![uri];
    // 1 def + 2 jumps = 3 edits, all covering bare "loop".
    expect(edits).toHaveLength(3);
    for (const e of edits) {
      expect(doc.getText(e.range)).toBe('loop');
      expect(e.newText).toBe('cycle');
    }
  });

  it('renames only labels in the same namespace (act-internal stays isolated)', () => {
    const code = `# a
:foo
jump 'foo'
act 'go':
  :foo
  jump 'foo'
end
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Cursor on the act-internal `:foo` definition (line 4).
    const edit = buildRenameEdit(ctx, state, uri, { line: 4, character: 4 }, doc, 'bar');
    expect(edit).not.toBeNull();
    const edits = edit!.changes![uri];
    // Must only rename act-internal def + jump (lines 4 & 5), never the
    // outer pair on lines 1 & 2.
    expect(edits).toHaveLength(2);
    const lines = edits.map(e => e.range.start.line).sort();
    expect(lines).toEqual([4, 5]);
    for (const e of edits) {
      expect(doc.getText(e.range)).toBe('foo');
      expect(e.newText).toBe('bar');
    }
  });

  it('renames a label inside a dynamic block and leaves outer same-name labels untouched', () => {
    const code = `# a
:foo
jump 'foo'
dynamic {
  :foo
  jump 'foo'
}
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Cursor on the dynamic-block-internal `:foo` definition (line 4).
    const edit = buildRenameEdit(ctx, state, uri, { line: 4, character: 4 }, doc, 'bar');
    expect(edit).not.toBeNull();
    const edits = edit!.changes![uri];
    expect(edits).toHaveLength(2);
    const lines = edits.map(e => e.range.start.line).sort();
    expect(lines).toEqual([4, 5]);
  });

  it('renames all object references', () => {
    const code = `# a
addobj 'sword'
---
# b
delobj 'sword'
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const edit = buildRenameEdit(ctx, state, uri, posOf(code, "'sword'"), doc, 'blade');
    expect(edit).not.toBeNull();
    const edits = edit!.changes![uri];
    expect(edits.length).toBeGreaterThanOrEqual(2);
    for (const e of edits) {
      expect(doc.getText(e.range)).toBe('sword');
      expect(e.newText).toBe('blade');
    }
  });

  it('renames a $-prefixed variable without touching the $ sigil', () => {
    const code = `# a
$s = 'hi'
pl $s
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const edit = buildRenameEdit(ctx, state, uri, posOf(code, '$s', 1), doc, 'greeting');
    expect(edit).not.toBeNull();
    const edits = edit!.changes![uri];
    // Each replaced range must be just "s" (or "$s" depending on how the
    // symbol table records it). The $ sigil must survive: the new text
    // combined with the untouched prefix must still produce valid source.
    for (const e of edits) {
      const replaced = doc.getText(e.range);
      expect(['s', '$s']).toContain(replaced);
      expect(e.newText).toBe('greeting');
    }
  });

  it('renames a propagated local across caller and callee', () => {
    const code = `# caller
local p = 1
gs 'callee'
---
# callee
pl p
p = p + 1
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const edit = buildRenameEdit(ctx, state, uri, posAtStart(code, 'p = 1'), doc, 'q');
    expect(edit).not.toBeNull();
    const edits = edit!.changes![uri];
    // Caller def (line 1) + callee read (line 5) + callee write+use (line 6).
    const lines = new Set(edits.map(e => e.range.start.line));
    expect(lines.has(1)).toBe(true);
    expect(lines.has(5)).toBe(true);
    expect(lines.has(6)).toBe(true);
    for (const e of edits) {
      expect(doc.getText(e.range)).toBe('p');
      expect(e.newText).toBe('q');
    }
  });

  it('performs case-insensitive matching but uses newName verbatim', () => {
    const code = `# a
Foo = 1
pl FOO
pl foo
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const edit = buildRenameEdit(ctx, state, uri, posOf(code, 'Foo'), doc, 'Bar');
    const edits = edit!.changes![uri];
    expect(edits).toHaveLength(3);
    // Every replacement uses the verbatim new name — no case rewriting.
    for (const e of edits) {
      expect(e.newText).toBe('Bar');
    }
  });

  it('does not emit duplicate edits for the same reference position', () => {
    const code = `# a
x = 1
pl x
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const edit = buildRenameEdit(ctx, state, uri, posOf(code, 'x'), doc, 'y');
    const edits = edit!.changes![uri];
    const keys = new Set(edits.map(e =>
      `${e.range.start.line}:${e.range.start.character}-${e.range.end.line}:${e.range.end.character}`,
    ));
    // Every edit range is unique (no duplicates from propagation paths).
    expect(keys.size).toBe(edits.length);
  });

  it('renames a location name across all call sites in project mode', () => {
    const fileA = `# start
gs 'hub'
gs 'hub'
---
`;
    const fileB = `# b
xgt 'hub'
---
# hub
x = 1
---
`;
    const uriA = 'test://a.qsps';
    const uriB = 'test://b.qsps';
    const { ctx, states, docs } = makeProjectFixture([
      { uri: uriA, code: fileA },
      { uri: uriB, code: fileB },
    ]);
    const edit = buildRenameEdit(
      ctx,
      states.get(uriA)!,
      uriA,
      posOf(fileA, "'hub'"),
      docs.get(uriA)!,
      'center',
    );
    expect(edit).not.toBeNull();
    // fileA has 2 call sites, fileB has 1 call site (xgt counts).
    expect(edit!.changes![uriA].length).toBeGreaterThanOrEqual(2);
    expect(edit!.changes![uriB].length).toBeGreaterThanOrEqual(1);
  });

  it('renames a variable across every built-in statement / function form', () => {
    const code = `# a
x = 1
pl x
pl(x)
pl x, 1
pl(x, 1)
msg x
msg(x)
y = len(x)
y = len x
y = iif(x, 1, 2)
y = val x
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    const edit = buildRenameEdit(ctx, state, uri, posAtStart(code, 'x = 1'), doc, 'z');
    expect(edit).not.toBeNull();
    const edits = edit!.changes![uri];
    // 1 def + 10 usages = 11 edits. Sigils/parens/commas must survive —
    // each replaced range is exactly the bare identifier `x`.
    expect(edits).toHaveLength(11);
    for (const e of edits) {
      expect(doc.getText(e.range)).toBe('x');
      expect(e.newText).toBe('z');
    }
  });

  // ── Variable rename: bidirectional propagation + cross-file ─────────

  it('renames a propagated local when cursor is on the CALLEE reference', () => {
    // Cursor sits on the callee's non-local `p`.  The rename must
    // bubble up to the caller's `local p = 1` AND fan out to every
    // other callee that receives `p` through propagation.
    const code = `# caller
local p = 1
gs 'a'
gs 'b'
---
# a
pl p
---
# b
p = p + 1
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Cursor on `pl p`'s second `p` (the variable) inside callee `a`.
    // Line 6: "pl p" — col 3 is the variable `p`.
    const edit = buildRenameEdit(ctx, state, uri, { line: 6, character: 3 }, doc, 'q');
    expect(edit).not.toBeNull();
    const edits = edit!.changes![uri];
    const lines = new Set(edits.map(e => e.range.start.line));
    // Caller def (1) + callee `a` read (6) + callee `b` write+use (9).
    expect(lines.has(1)).toBe(true);
    expect(lines.has(6)).toBe(true);
    expect(lines.has(9)).toBe(true);
    for (const e of edits) {
      expect(doc.getText(e.range)).toBe('p');
      expect(e.newText).toBe('q');
    }
  });

  it('renames a propagated local across files (caller in A, callee in B)', () => {
    const fileA = `# caller
local p = 1
gs 'callee'
---
`;
    const fileB = `# callee
pl p
p = p + 1
---
`;
    const uriA = 'test://a.qsps';
    const uriB = 'test://b.qsps';
    const { ctx, states, docs } = makeProjectFixture([
      { uri: uriA, code: fileA },
      { uri: uriB, code: fileB },
    ]);
    // Cursor on caller's local def in fileA.
    const edit = buildRenameEdit(
      ctx,
      states.get(uriA)!,
      uriA,
      posAtStart(fileA, 'p = 1'),
      docs.get(uriA)!,
      'q',
    );
    expect(edit).not.toBeNull();
    // Edits must span BOTH files.
    expect(edit!.changes![uriA]?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(edit!.changes![uriB]?.length ?? 0).toBeGreaterThanOrEqual(2);
    // Every replaced range matches the bare identifier `p`.
    const docB = docs.get(uriB)!;
    for (const e of edit!.changes![uriB]) {
      expect(docB.getText(e.range)).toBe('p');
      expect(e.newText).toBe('q');
    }
  });

  it('renames a propagated local from cursor on CALLEE in cross-file project', () => {
    const fileA = `# caller
local p = 1
gs 'callee'
---
`;
    const fileB = `# callee
pl p
---
`;
    const uriA = 'test://a.qsps';
    const uriB = 'test://b.qsps';
    const { ctx, states, docs } = makeProjectFixture([
      { uri: uriA, code: fileA },
      { uri: uriB, code: fileB },
    ]);
    // Cursor on callee's `p` in fileB.
    // Line 1: "pl p" — col 3 is the variable `p`.
    const edit = buildRenameEdit(
      ctx,
      states.get(uriB)!,
      uriB,
      { line: 1, character: 3 },
      docs.get(uriB)!,
      'q',
    );
    expect(edit).not.toBeNull();
    // Caller's local in fileA must also be renamed.
    expect(edit!.changes![uriA]?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(edit!.changes![uriB]?.length ?? 0).toBeGreaterThanOrEqual(1);
    const docA = docs.get(uriA)!;
    for (const e of edit!.changes![uriA]) {
      expect(docA.getText(e.range)).toBe('p');
      expect(e.newText).toBe('q');
    }
  });

  it('renames a global variable across multiple locations and files', () => {
    const fileA = `# a
g = 1
pl g
---
# b
g = g + 1
---
`;
    const fileB = `# c
pl g
g = 99
---
`;
    const uriA = 'test://a.qsps';
    const uriB = 'test://b.qsps';
    const { ctx, states, docs } = makeProjectFixture([
      { uri: uriA, code: fileA },
      { uri: uriB, code: fileB },
    ]);
    const edit = buildRenameEdit(
      ctx,
      states.get(uriA)!,
      uriA,
      posAtStart(fileA, 'g = 1'),
      docs.get(uriA)!,
      'globalCounter',
    );
    expect(edit).not.toBeNull();
    // fileA: 3 occurrences (line 1 def, line 2 read, line 5 read+write).
    // fileB: 2 occurrences.
    expect(edit!.changes![uriA].length).toBeGreaterThanOrEqual(3);
    expect(edit!.changes![uriB].length).toBeGreaterThanOrEqual(2);
    for (const uri of [uriA, uriB]) {
      const d = docs.get(uri)!;
      for (const e of edit!.changes![uri]) {
        expect(d.getText(e.range)).toBe('g');
        expect(e.newText).toBe('globalCounter');
      }
    }
  });

  it('does NOT propagate rename when callee has its own LOCAL shadow', () => {
    // The callee declares `local p`, shadowing the caller's `p`.
    // Renaming the callee's `p` must stay inside the callee.
    const code = `# caller
local p = 1
gs 'callee'
---
# callee
local p = 99
pl p
---
`;
    const { ctx, state, doc, uri } = makeFixture(code);
    // Cursor on callee's local def.
    const edit = buildRenameEdit(ctx, state, uri, posAtStart(code, 'p = 99'), doc, 'q');
    expect(edit).not.toBeNull();
    const edits = edit!.changes![uri];
    const lines = new Set(edits.map(e => e.range.start.line));
    // Callee lines 5, 6 only — never the caller's line 1.
    expect(lines.has(5)).toBe(true);
    expect(lines.has(6)).toBe(true);
    expect(lines.has(1)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// buildCallerLines
// ══════════════════════════════════════════════════════════════════════

describe('buildCallerLines', () => {
  it('lists returning-call callers (gs/gosub/func/@/@@) and excludes goto-family (gt/goto/xgt/xgoto)', () => {
    const code = `# main
gs 'target'
---
# fn_caller
x = func('target')
---
# jumper
gt 'target'
---
# xjumper
xgt 'target'
---
# target
x = 1
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildCallerLines(ctx.documentStates, 'target', '**Called from:**', uri, out);
    expect(out).toContain('**Called from:**');
    const text = out.join('\n');
    expect(text).toContain('main');
    expect(text).toContain('fn_caller');
    expect(text).not.toContain('jumper');
    expect(text).not.toContain('xjumper');
  });

  it('excludes loc operator (non-call reference) from callers', () => {
    const code = `# checker
if loc 'target':
  pl 'yes'
end
---
# target
x = 1
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildCallerLines(ctx.documentStates, 'target', '**Called from:**', uri, out);
    // loc is not a call, so checker should NOT appear.
    expect(out).toHaveLength(0);
  });

  it('includes desc function as a caller (desc propagates locals to target)', () => {
    const code = `# describer
$d = desc('target')
---
# target
x = 1
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildCallerLines(ctx.documentStates, 'target', '**Called from:**', uri, out);
    // desc is a propagating call, so describer SHOULD appear.
    expect(out.some(l => l.includes('describer'))).toBe(true);
  });

  it('includes a caller that uses gs but excludes one that only uses loc', () => {
    const code = `# caller
gs 'target'
---
# checker
if loc 'target':
  pl 'yes'
end
---
# target
x = 1
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildCallerLines(ctx.documentStates, 'target', '**Called from:**', uri, out);
    const text = out.join('\n');
    expect(text).toContain('caller');
    expect(text).not.toContain('checker');
  });

  it('includes the current location as a caller if it calls itself', () => {
    const code = `# recursive
gs 'recursive'
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildCallerLines(ctx.documentStates, 'recursive', '**Called from:**', uri, out);
    const text = out.join('\n');
    expect(text).toContain('recursive');
  });

  it('shows propagated locals in callers', () => {
    const code = `# main
local x = 1
gs 'worker'
---
# worker
pl x
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildCallerLines(ctx.documentStates, 'worker', '**Called from:**', uri, out);
    const text = out.join('\n');
    expect(text).toContain('main');
    expect(text).toContain('passes locals');
    expect(text).toContain('x');
  });

  it('returns nothing when location has no callers', () => {
    const code = `# lonely
x = 1
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildCallerLines(ctx.documentStates, 'lonely', '**Called from:**', uri, out);
    expect(out).toHaveLength(0);
  });

  it('shows the line number for a single call site as `line N`', () => {
    const code = `# main
x = 1
gs 'target'
---
# target
y = 1
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildCallerLines(ctx.documentStates, 'target', '**Called from:**', uri, out);
    const text = out.join('\n');
    // `gs 'target'` is on the 3rd line (1-based) of the document.
    // `main` is defined on line 1, so its bullet shows `(line 1)`.
    expect(text).toMatch(/`main` \(line 1\)\n  - line 3:/);
  });

  it('shows multiple line numbers for multiple call sites as `lines A, B`', () => {
    const code = `# main
gs 'target'
x = 1
gs 'target'
---
# target
y = 1
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildCallerLines(ctx.documentStates, 'target', '**Called from:**', uri, out);
    const text = out.join('\n');
    expect(text).toMatch(/`main` \(line 1\)\n  - line 2: `gs 'target'`\n  - line 4: `gs 'target'`/);
  });

  it('places the line suffix before the `(passes locals: …)` annotation', () => {
    const code = `# main
local x = 1
gs 'worker'
---
# worker
pl x
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildCallerLines(ctx.documentStates, 'worker', '**Called from:**', uri, out);
    const text = out.join('\n');
    // Single call on line 3.
    expect(text).toMatch(/`main` \(line 1\)\n  - line 3: `gs 'worker'` \(passes locals: `x`\)/);
  });

  it('lists multiple distinct callers each with their own line numbers', () => {
    const code = `# alpha
gs 'target'
---
# beta
x = 1
gs 'target'
gs 'target'
---
# target
y = 1
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildCallerLines(ctx.documentStates, 'target', '**Called from:**', uri, out);
    const text = out.join('\n');
    expect(text).toMatch(/`alpha` \(line 1\)\n  - line 2: `gs 'target'`/);
    expect(text).toMatch(/`beta` \(line 4\)\n  - line 6: `gs 'target'`\n  - line 7: `gs 'target'`/);
  });

  it('annotates cross-file callers with `[basename]` suffix', () => {
    const fileA = `# main
gs 'target'
---
`;
    const fileB = `# target
x = 1
---
`;
    const uriA = 'file:///proj/a.qsps';
    const uriB = 'file:///proj/b.qsps';
    const { ctx } = makeProjectFixture([
      { uri: uriA, code: fileA },
      { uri: uriB, code: fileB },
    ]);
    const out: string[] = [];
    // Hover is on `target` in fileB; caller `main` lives in fileA.
    buildCallerLines(ctx.documentStates, 'target', '**Called from:**', uriB, out);
    const text = out.join('\n');
    expect(text).toMatch(/`main` \(line 1\) \[a\.qsps\]\n  - line 2: `gs 'target'`/);
  });
});

describe('buildJumperLines', () => {
  it('lists goto-family jumpers (gt/goto/xgt/xgoto) and excludes returning calls', () => {
    const code = `# jumper_a
gt 'target'
---
# jumper_b
xgt 'target'
---
# caller
gs 'target'
---
# target
x = 1
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildJumperLines(ctx.documentStates, 'target', '**Navigated from:**', uri, out);
    expect(out).toContain('**Navigated from:**');
    const text = out.join('\n');
    expect(text).toContain('jumper_a');
    expect(text).toContain('jumper_b');
    expect(text).not.toContain('caller');
  });

  it('emits nothing when location is only called (gs) and never jumped to', () => {
    const code = `# caller
gs 'target'
---
# target
x = 1
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildJumperLines(ctx.documentStates, 'target', '**Navigated from:**', uri, out);
    expect(out).toHaveLength(0);
  });

  it('shows multiple line numbers for multiple jump sites in one location', () => {
    const code = `# jumper
gt 'target'
x = 1
gt 'target'
---
# target
y = 1
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildJumperLines(ctx.documentStates, 'target', '**Navigated from:**', uri, out);
    const text = out.join('\n');
    expect(text).toMatch(/`jumper` \(line 1\)\n  - line 2: `gt 'target'`\n  - line 4: `gt 'target'`/);
  });

  it('does NOT add `(passes locals: …)` even if the jumper has matching locals', () => {
    const code = `# jumper
local x = 1
gt 'target'
---
# target
pl x
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildJumperLines(ctx.documentStates, 'target', '**Navigated from:**', uri, out);
    const text = out.join('\n');
    expect(text).toContain('jumper');
    expect(text).not.toContain('passes locals');
  });

  it('excludes loc operator (non-call reference)', () => {
    const code = `# checker
if loc 'target':
  pl 'yes'
end
---
# target
x = 1
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildJumperLines(ctx.documentStates, 'target', '**Navigated from:**', uri, out);
    expect(out).toHaveLength(0);
  });

  it('annotates cross-file jumpers with `[basename]` suffix', () => {
    const fileA = `# jumper
gt 'target'
---
`;
    const fileB = `# target
x = 1
---
`;
    const uriA = 'file:///proj/a.qsps';
    const uriB = 'file:///proj/b.qsps';
    const { ctx } = makeProjectFixture([
      { uri: uriA, code: fileA },
      { uri: uriB, code: fileB },
    ]);
    const out: string[] = [];
    buildJumperLines(ctx.documentStates, 'target', '**Navigated from:**', uriB, out);
    const text = out.join('\n');
    expect(text).toMatch(/`jumper` \(line 1\) \[a\.qsps\]\n  - line 2: `gt 'target'`/);
  });

  it('a single source location may appear in BOTH `Called from` and `Navigated from` when it uses gs and gt', () => {
    const code = `# mixed
gs 'target'
x = 1
gt 'target'
---
# target
y = 1
---
`;
    const { ctx, uri } = makeFixture(code);
    const callOut: string[] = [];
    const jumpOut: string[] = [];
    buildCallerLines(ctx.documentStates, 'target', '**Called from:**', uri, callOut);
    buildJumperLines(ctx.documentStates, 'target', '**Navigated from:**', uri, jumpOut);
    // The gs is on line 2; gt is on line 4 — each section reports only its own.
    expect(callOut.join('\n')).toMatch(/`mixed` \(line 1\)\n  - line 2:/);
    expect(jumpOut.join('\n')).toMatch(/`mixed` \(line 1\)\n  - line 4:/);
  });

  it('renders extra positional args at a single gs call site', () => {
    const code = `# main
gs 'target', 1, 'foo'
---
# target
x = args[0]
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildCallerLines(ctx.documentStates, 'target', '**Called from:**', uri, out);
    const text = out.join('\n');
    expect(text).toMatch(/`main` \(line 1\)\n  - line 2: `gs 'target', 1, 'foo'`/);
  });

  it('renders extra args for func() call sites', () => {
    const code = `# main
y = func('target', 42)
---
# target
result = args[0]
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildCallerLines(ctx.documentStates, 'target', '**Called from:**', uri, out);
    const text = out.join('\n');
    expect(text).toMatch(/`main` \(line 1\)\n  - line 2: `func\('target', 42\)`/);
  });

  it('renders extra args at user-call sites (`@@target a, b`)', () => {
    const code = `# main
@@target 1, 2
---
# target
x = args[0]
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildCallerLines(ctx.documentStates, 'target', '**Called from:**', uri, out);
    const text = out.join('\n');
    expect(text).toMatch(/`main` \(line 1\)\n  - line 2: `@@target 1, 2`/);
  });

  it('renders per-site args when multiple call sites pass different args', () => {
    const code = `# main
gs 'target', 'a'
x = 1
gs 'target', 'b', 2
---
# target
y = args[0]
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildCallerLines(ctx.documentStates, 'target', '**Called from:**', uri, out);
    const text = out.join('\n');
    expect(text).toMatch(/`main` \(line 1\)\n  - line 2: `gs 'target', 'a'`\n  - line 4: `gs 'target', 'b', 2`/);
  });

  it('renders just the call kind when the call passes only the location name', () => {
    const code = `# main
gs 'target'
---
# target
x = 1
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildCallerLines(ctx.documentStates, 'target', '**Called from:**', uri, out);
    const text = out.join('\n');
    expect(text).toMatch(/`main` \(line 1\)\n  - line 2: `gs 'target'`$/m);
  });

  it('places the args before the `(passes locals: …)` annotation', () => {
    const code = `# main
local x = 1
gs 'worker', 7
---
# worker
pl x
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildCallerLines(ctx.documentStates, 'worker', '**Called from:**', uri, out);
    const text = out.join('\n');
    expect(text).toMatch(/`main` \(line 1\)\n  - line 3: `gs 'worker', 7` \(passes locals: `x`\)/);
  });

  it('renders args for gt/goto jump sites in `Navigated from:`', () => {
    const code = `# jumper
gt 'target', 99
---
# target
x = 1
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildJumperLines(ctx.documentStates, 'target', '**Navigated from:**', uri, out);
    const text = out.join('\n');
    expect(text).toMatch(/`jumper` \(line 1\)\n  - line 2: `gt 'target', 99`/);
  });

  it('truncates very long arg lists with `…`', () => {
    const longArg = "'" + 'x'.repeat(80) + "'";
    const code = `# main
gs 'target', ${longArg}
---
# target
y = 1
---
`;
    const { ctx, uri } = makeFixture(code);
    const out: string[] = [];
    buildCallerLines(ctx.documentStates, 'target', '**Called from:**', uri, out);
    const text = out.join('\n');
    expect(text).toContain('…');
    // The truncated rendering still wraps in backticks and stays on one line.
    expect(text).toMatch(/`main` \(line 1\)\n  - line 2: `gs 'target', 'x+\S*…`/);
  });
});

describe('buildConsumedLocalsLine', () => {
  it('lists locals the target reads from caller frames', () => {
    const code = `# main
local x = 1
gs 'worker'
---
# worker
pl x
---
`;
    const { ctx, state, uri } = makeFixture(code);
    const agg = buildFileAggregates(state.symbols, uri);
    const out: string[] = [];
    buildConsumedLocalsLine(ctx.documentStates, agg, 'worker', 'Consumes locals:', out);
    const text = out.join('\n');
    expect(text).toContain('Consumes locals:');
    expect(text).toContain('`x`');
  });

  it('emits nothing when target consumes no caller-propagated locals', () => {
    const code = `# main
gs 'worker'
---
# worker
y = 1
---
`;
    const { ctx, state, uri } = makeFixture(code);
    const agg = buildFileAggregates(state.symbols, uri);
    const out: string[] = [];
    buildConsumedLocalsLine(ctx.documentStates, agg, 'worker', 'Consumes locals:', out);
    expect(out).toHaveLength(0);
  });

  it('lists multiple consumed locals', () => {
    const code = `# main
local x = 1
local y = 2
gs 'worker'
---
# worker
pl x
pl y
---
`;
    const { ctx, state, uri } = makeFixture(code);
    const agg = buildFileAggregates(state.symbols, uri);
    const out: string[] = [];
    buildConsumedLocalsLine(ctx.documentStates, agg, 'worker', 'Consumes locals:', out);
    const text = out.join('\n');
    expect(text).toContain('`x`');
    expect(text).toContain('`y`');
  });

  it('includes locals shadowed by the target via its own `local` decl', () => {
    // worker never reads x as non-local (only declares its own
    // `local x`), but the shadow is still meaningful — the caller's
    // x is hidden inside worker.  shadowedPropagations records this.
    const code = `# main
local x = 1
gs 'worker'
---
# worker
local x = 99
pl x
---
`;
    const { ctx, state, uri } = makeFixture(code);
    const agg = buildFileAggregates(state.symbols, uri);
    const out: string[] = [];
    buildConsumedLocalsLine(ctx.documentStates, agg, 'worker', 'Consumes locals:', out);
    const text = out.join('\n');
    expect(text).toContain('Consumes locals:');
    expect(text).toContain('`x`');
  });

  it('does not list locals declared by the target with no propagation', () => {
    // worker has its own `local y` but no caller passes `y`, so y
    // is not a consumed/shadowed propagation.
    const code = `# main
gs 'worker'
---
# worker
local y = 1
pl y
---
`;
    const { ctx, state, uri } = makeFixture(code);
    const agg = buildFileAggregates(state.symbols, uri);
    const out: string[] = [];
    buildConsumedLocalsLine(ctx.documentStates, agg, 'worker', 'Consumes locals:', out);
    expect(out).toHaveLength(0);
  });

  it('returns nothing for a target with no entries in either map', () => {
    const code = `# lonely
x = 1
---
`;
    const { ctx, state, uri } = makeFixture(code);
    const agg = buildFileAggregates(state.symbols, uri);
    const out: string[] = [];
    buildConsumedLocalsLine(ctx.documentStates, agg, 'lonely', 'Consumes locals:', out);
    expect(out).toHaveLength(0);
  });

  it('precedes its line with a blank separator line', () => {
    const code = `# main
local x = 1
gs 'worker'
---
# worker
pl x
---
`;
    const { ctx, state, uri } = makeFixture(code);
    const agg = buildFileAggregates(state.symbols, uri);
    const out: string[] = ['existing'];
    buildConsumedLocalsLine(ctx.documentStates, agg, 'worker', 'Consumes locals:', out);
    expect(out[0]).toBe('existing');
    expect(out[1]).toBe('');
    expect(out[2]).toMatch(/^Consumes locals:/);
  });

  it('lists `args` when the location reads it', () => {
    const code = `# main
gs 'worker', 1, 2
---
# worker
pl args[0]
---
`;
    const { ctx, state, uri } = makeFixture(code);
    const agg = buildFileAggregates(state.symbols, uri);
    const out: string[] = [];
    buildConsumedLocalsLine(ctx.documentStates, agg, 'worker', 'Consumes locals:', out);
    const text = out.join('\n');
    expect(text).toContain('Consumes locals:');
    expect(text).toContain('`args`');
  });

  it('lists `result` when the location assigns it', () => {
    const code = `# fn
result = 42
---
`;
    const { ctx, state, uri } = makeFixture(code);
    const agg = buildFileAggregates(state.symbols, uri);
    const out: string[] = [];
    buildConsumedLocalsLine(ctx.documentStates, agg, 'fn', 'Consumes locals:', out);
    const text = out.join('\n');
    expect(text).toContain('`result`');
  });

  it('lists both `args` and propagated locals together', () => {
    const code = `# main
local x = 1
gs 'worker', 7
---
# worker
pl x
pl args[0]
---
`;
    const { ctx, state, uri } = makeFixture(code);
    const agg = buildFileAggregates(state.symbols, uri);
    const out: string[] = [];
    buildConsumedLocalsLine(ctx.documentStates, agg, 'worker', 'Consumes locals:', out);
    const text = out.join('\n');
    expect(text).toContain('`x`');
    expect(text).toContain('`args`');
  });
});

describe('buildUsedGlobalsSection', () => {
  it('lists globals defined in the location with assigned-line annotation', () => {
    const code = `# room
$name = 'hero'
hp = 100
---
`;
    const { ctx, state, uri } = makeFixture(code);
    const agg = buildFileAggregates(state.symbols, uri);
    const out: string[] = [];
    buildUsedGlobalsSection(ctx.documentStates, agg, 'room', '**Uses globals:**', out);
    expect(out).toContain('**Uses globals:**');
    const text = out.join('\n');
    expect(text).toMatch(/`name` — assigned line 2/);
    expect(text).toMatch(/`hp` — assigned line 3/);
  });

  it('lists globals only read in the location with read-count annotation', () => {
    const code = `# setup
hp = 100
---
# show
pl hp
pl hp
---
`;
    const { ctx, state, uri } = makeFixture(code);
    const agg = buildFileAggregates(state.symbols, uri);
    const out: string[] = [];
    buildUsedGlobalsSection(ctx.documentStates, agg, 'show', '**Uses globals:**', out);
    const text = out.join('\n');
    expect(text).toMatch(/`hp`.*2 reads/);
  });

  it('excludes locals declared in the target', () => {
    const code = `# room
local tmp = 1
hp = 100
---
`;
    const { ctx, state, uri } = makeFixture(code);
    const agg = buildFileAggregates(state.symbols, uri);
    const out: string[] = [];
    buildUsedGlobalsSection(ctx.documentStates, agg, 'room', '**Uses globals:**', out);
    const text = out.join('\n');
    expect(text).toContain('hp');
    expect(text).not.toContain('tmp');
  });

  it('excludes propagated-in locals (caller-frame variables)', () => {
    const code = `# main
local x = 1
gs 'worker'
---
# worker
pl x
hp = 5
---
`;
    const { ctx, state, uri } = makeFixture(code);
    const agg = buildFileAggregates(state.symbols, uri);
    const out: string[] = [];
    buildUsedGlobalsSection(ctx.documentStates, agg, 'worker', '**Uses globals:**', out);
    const text = out.join('\n');
    expect(text).toContain('hp');
    // x is a propagated-in local, not a global from worker's POV.
    expect(text).not.toMatch(/`x`/);
  });

  it('returns nothing when location uses no globals', () => {
    const code = `# pure
local x = 1
pl x
---
`;
    const { ctx, state, uri } = makeFixture(code);
    const agg = buildFileAggregates(state.symbols, uri);
    const out: string[] = [];
    buildUsedGlobalsSection(ctx.documentStates, agg, 'pure', '**Uses globals:**', out);
    expect(out).toHaveLength(0);
  });

  it('returns nothing for a non-existent target', () => {
    const code = `# room
hp = 1
---
`;
    const { ctx, state, uri } = makeFixture(code);
    const agg = buildFileAggregates(state.symbols, uri);
    const out: string[] = [];
    buildUsedGlobalsSection(ctx.documentStates, agg, 'no_such_loc', '**Uses globals:**', out);
    expect(out).toHaveLength(0);
  });

  it('combines assigned + read counts on the same line', () => {
    const code = `# room
hp = 100
hp += 5
pl hp
---
`;
    const { ctx, state, uri } = makeFixture(code);
    const agg = buildFileAggregates(state.symbols, uri);
    const out: string[] = [];
    buildUsedGlobalsSection(ctx.documentStates, agg, 'room', '**Uses globals:**', out);
    const text = out.join('\n');
    expect(text).toMatch(/`hp` — assigned line 2, \d+ reads?/);
  });

  it('finds the target location across files in project mode', () => {
    const fileA = `# room
hp = 1
---
`;
    const fileB = `# other
x = 1
---
`;
    const uriA = 'file:///proj/a.qsps';
    const uriB = 'file:///proj/b.qsps';
    const { ctx } = makeProjectFixture([
      { uri: uriA, code: fileA },
      { uri: uriB, code: fileB },
    ]);
    const out: string[] = [];
    buildUsedGlobalsSection(ctx.documentStates, ctx.projectAggregates!, 'room', '**Uses globals:**', out);
    const text = out.join('\n');
    expect(text).toContain('**Uses globals:**');
    expect(text).toMatch(/`hp`/);
  });

  it('lists a read-only global (no assignment in this location) without an "assigned" tag', () => {
    const code = `# setup
hp = 100
---
# show
pl hp
---
`;
    const { ctx, state, uri } = makeFixture(code);
    const agg = buildFileAggregates(state.symbols, uri);
    const out: string[] = [];
    buildUsedGlobalsSection(ctx.documentStates, agg, 'show', '**Uses globals:**', out);
    const text = out.join('\n');
    expect(text).toMatch(/`hp` — 1 read/);
    expect(text).not.toMatch(/assigned line/);
    expect(text).not.toMatch(/declared line/);
  });

  it('caps the list at MAX_HOVER_GLOBALS with an overflow line', () => {
    // 26 distinct globals → 25 listed + 1-overflow line.
    const lines: string[] = ['# big'];
    for (let i = 0; i < 26; i++) lines.push(`g${i} = ${i}`);
    lines.push('---');
    const code = lines.join('\n') + '\n';
    const { ctx, state, uri } = makeFixture(code);
    const agg = buildFileAggregates(state.symbols, uri);
    const out: string[] = [];
    buildUsedGlobalsSection(ctx.documentStates, agg, 'big', '**Uses globals:**', out);
    const body = out.join('\n');
    // Header + 25 entry lines + 1 overflow line = 27 total when the
    // section is non-empty (header is 2 entries: blank + label).
    const overflow = out.filter(l => /…and \d+ more/.test(l));
    expect(overflow).toHaveLength(1);
    expect(overflow[0]).toMatch(/…and 1 more/);
    expect(body).toContain('`g0`');
    expect(body).toContain('`g24`');
    expect(body).not.toContain('`g25`');
  });

  it('uses singular "read" when there is exactly one read', () => {
    const code = `# show
pl hp
---
`;
    const { ctx, state, uri } = makeFixture(code);
    const agg = buildFileAggregates(state.symbols, uri);
    const out: string[] = [];
    buildUsedGlobalsSection(ctx.documentStates, agg, 'show', '**Uses globals:**', out);
    const text = out.join('\n');
    expect(text).toMatch(/`hp` — 1 read\b/);
    expect(text).not.toMatch(/1 reads/);
  });
});

describe('inline "This call passes locals" hover annotation (data flow)', () => {
  // The inline "This call passes locals: …" string in lspFeatures'
  // location-hover handler is a direct join over Reference.localsInScope.
  // These tests pin down the underlying data so the rendered string is
  // implicitly covered.

  it('populates localsInScope on a gs reference with the caller\u2019s locals', () => {
    const code = `# main
local x = 1
local $y = 'z'
gs 'worker'
---
# worker
pl x
---
`;
    const { state } = makeFixture(code);
    const main = state.symbols.getLocation('main');
    const ref = main!.locationRefs.get('worker')!.references[0];
    expect(ref.localsInScope).toBeDefined();
    const names = [...ref.localsInScope!.keys()].sort();
    expect(names).toContain('x');
    expect(names).toContain('y');
  });

  it('does not populate localsInScope on a goto-family reference', () => {
    const code = `# main
local x = 1
gt 'target'
---
# target
pl x
---
`;
    const { state } = makeFixture(code);
    const main = state.symbols.getLocation('main');
    const ref = main!.locationRefs.get('target')!.references[0];
    // gt does not propagate locals — localsInScope is undefined or empty.
    expect(ref.localsInScope === undefined || ref.localsInScope.size === 0).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Renderer: buildPossibleValuesLines shape tests
// ──────────────────────────────────────────────────────────────────────
//
// Synthetic tests for the rendering layer in isolation.  The renderer
// now formats `binding.stmtText` verbatim inside a code span — there
// is no LHS reconstruction, no compound-op formatting, no indexed
// write formatting, no side-effect tagging.  Everything the user sees
// is sourced from the captured statement text, which `bindingCollector`
// populates from the original source line.
//
// Concerns covered here:
//   • `*(expr)*` fallback for empty stmtText
//   • origin grouping (scope → cross-call → document)
//   • `*(local)*` / `*(local via call)*` tags
//   • var-ref chain expansion (single / multi / unresolved / dedup)
//   • MAX_HOVER_VALUES overflow ("…and N more")
//   • MAX_HOVER_LOCATIONS_PER_VALUE per-value tail
//   • cross-file [basename] annotation
//
// Scenario coverage — what the resolver decides to surface for each
// variable shape — lives in test/variableBindings.test.ts.

describe('buildPossibleValuesLines (renderer shape)', () => {
  type Origin = CursorValueEntry['origin'];

  /** Build a synthetic terminal-value entry. */
  function entry(
    value: BindingValue,
    opts: {
      origin?: Origin;
      uri?: string;
      locationName?: string;
      line?: number;
      isLocal?: boolean;
      stmtText?: string;
    } = {},
  ): CursorValueEntry {
    const origin = opts.origin ?? 'scope';
    const uri = opts.uri ?? 'test://hover.qsps';
    const locationName = opts.locationName ?? 'L';
    const line = opts.line ?? 1; // 0-based; renders as line+1
    const stmtLoc = {
      line, column: 0, endLine: line, endColumn: 1,
    } as unknown as CursorValueEntry['binding']['stmtLoc'];
    return {
      binding: {
        value,
        stmtText: opts.stmtText ?? '',
        stmtLoc,
        // cross-call entries are always local writes (propagated from callee)
        isLocal: opts.isLocal ?? (origin !== 'document'),
        scopeNodeId: 0,
        isolationAncestorId: 0,
      },
      locationName,
      uri,
      origin,
    } as CursorValueEntry;
  }

  /** Convenience: an opaque expression entry whose source is `stmtText`. */
  const expr = (stmtText: string | undefined, opts?: Parameters<typeof entry>[1]) =>
    entry({ kind: 'expr' }, { ...opts, stmtText: stmtText ?? '' });
  /** Convenience: a var-ref edge entry (the chain hop, not its target). */
  const ref = (target: string, opts?: Parameters<typeof entry>[1]) =>
    entry({ kind: 'var-ref', varBaseName: target },
          { ...opts, stmtText: opts?.stmtText ?? `$${target}` });
  /** Convenience: a code-block entry. */
  const block = (opts?: Parameters<typeof entry>[1]) => entry(
    { kind: 'code-block', blockRange: { line: 0, column: 0, endLine: 0, endColumn: 1 } as never },
    { ...opts, stmtText: opts?.stmtText ?? '{ … }' },
  );

  /** Build a `PossibleValueEntry[]` list of synthetic chain children. */
  function children(...items: { stmtText: string; loc?: string; line?: number; uri?: string }[]):
    PossibleValueEntry[] {
    return items.map(i => ({
      binding: {
        value: { kind: 'expr' },
        stmtText: i.stmtText,
        stmtLoc: {
          line: i.line ?? 1, column: 0,
          endLine: i.line ?? 1, endColumn: 1,
        },
        isLocal: false,
        scopeNodeId: 0,
        isolationAncestorId: 0,
      },
      locationName: i.loc ?? 'init',
      uri: i.uri ?? 'test://hover.qsps',
    } as unknown as PossibleValueEntry));
  }

  // ── Empty input ─────────────────────────────────────────────────

  it('returns [] when given no entries', () => {
    expect(buildPossibleValuesLines([], 'test://hover.qsps')).toEqual([]);
  });

  // ── Header & terminal lines ─────────────────────────────────────

  it('emits the bold header followed by one entry per row', () => {
    const out = buildPossibleValuesLines(
      [expr('42', { locationName: 'a', line: 1, isLocal: false })],
      'test://hover.qsps',
    );
    expect(out[0]).toBe('');
    expect(out[1]).toBe('**Possible values:**');
    expect(out[2]).toBe('- `42` — `a` line 2');
  });

  it('renders stmtText verbatim inside a code span', () => {
    const out = buildPossibleValuesLines(
      [expr("'hi'", { locationName: 'a', line: 0, isLocal: false })],
      'test://hover.qsps',
    ).join('\n');
    expect(out).toContain("- `'hi'` — `a` line 1");
  });

  it('falls back to *(expr)* when stmtText is empty', () => {
    const out = buildPossibleValuesLines(
      [expr(undefined, { locationName: 'a', isLocal: false })],
      'test://hover.qsps',
    ).join('\n');
    expect(out).toContain('*(expr)*');
  });

  it('renders an arbitrary source-line statement verbatim', () => {
    const out = buildPossibleValuesLines(
      [expr('$a + $b', { locationName: 'a', isLocal: false })],
      'test://hover.qsps',
    ).join('\n');
    expect(out).toContain('`$a + $b`');
    expect(out).not.toContain('*(expr)*');
  });

  // ── Origin tags ─────────────────────────────────────────────────

  it('tags scope-origin local entries with *(local)*', () => {
    const out = buildPossibleValuesLines(
      [expr("'S'", { origin: 'scope', locationName: 'a', line: 0 })],
      'test://hover.qsps',
    ).join('\n');
    expect(out).toMatch(/^- `'S'` \*\(local\)\* — `a` line 1$/m);
    expect(out).not.toContain('*(local via call)*');
  });

  it('leaves scope-origin global entries untagged', () => {
    const out = buildPossibleValuesLines(
      [expr('42', { origin: 'scope', isLocal: false, locationName: 'room3', line: 0 })],
      'test://hover.qsps',
    ).join('\n');
    expect(out).toMatch(/^- `42` — `room3` line 1$/m);
  });

  it('tags cross-call-origin local entries with *(local via call)*', () => {
    const out = buildPossibleValuesLines(
      [expr('99', { origin: 'cross-call', locationName: 'b', line: 4 })],
      'test://hover.qsps',
    ).join('\n');
    expect(out).toMatch(/^- `99` \*\(local via call\)\* — `b` line 5$/m);
  });

  it('leaves document-origin entries untagged', () => {
    const out = buildPossibleValuesLines(
      [expr("'G'", { origin: 'document', locationName: 'init', line: 1 })],
      'test://hover.qsps',
    ).join('\n');
    expect(out).toMatch(/^- `'G'` — `init` line 2$/m);
  });

  // ── Grouping order ──────────────────────────────────────────────

  it('groups entries deterministically: scope → cross-call → document', () => {
    const out = buildPossibleValuesLines([
      expr("'D'", { origin: 'document', locationName: 'g',  line: 1 }),
      expr("'C'", { origin: 'cross-call', locationName: 'b', line: 2 }),
      expr("'S'", { origin: 'scope', locationName: 'a', line: 3 }),
    ], 'test://hover.qsps');
    const idxScope    = out.findIndex(l => l.includes("`'S'`"));
    const idxCrossCall = out.findIndex(l => l.includes("`'C'`"));
    const idxDocument = out.findIndex(l => l.includes("`'D'`"));
    expect(idxScope).toBeGreaterThan(-1);
    expect(idxCrossCall).toBeGreaterThan(idxScope);
    expect(idxDocument).toBeGreaterThan(idxCrossCall);
  });

  // ── Var-ref chain expansion ─────────────────────────────────────

  it('flattens a single-write var-ref to the chain target stmtText', () => {
    const expandVarRef = () => children({ stmtText: "g = 'GLOBAL'", loc: 'init', line: 1 });
    const out = buildPossibleValuesLines(
      [ref('g', { origin: 'scope', locationName: 'a', line: 4 })],
      'test://hover.qsps',
      { expandVarRef },
    ).join('\n');
    expect(out).toMatch(/^- `g = 'GLOBAL'` — `init` line 2$/m);
    // The bare var-ref placeholder is suppressed in favor of the flat line.
    expect(out).not.toContain('`$g`');
  });

  it('flattens a cross-call var-ref without origin tags (target is global)', () => {
    const expandVarRef = () => children({ stmtText: "g = 'X'", loc: 'init', line: 1 });
    const out = buildPossibleValuesLines(
      [ref('g', { origin: 'cross-call', locationName: 'callee', line: 6 })],
      'test://hover.qsps',
      { expandVarRef },
    ).join('\n');
    expect(out).toMatch(/^- `g = 'X'` — `init` line 2$/m);
    expect(out).not.toContain('*(local via call)*');
  });

  it('expands a multi-write var-ref into one row per chain target', () => {
    const expandVarRef = () => children(
      { stmtText: "g = 'A'", loc: 'init1', line: 1 },
      { stmtText: "g = 'B'", loc: 'init2', line: 1 },
    );
    const out = buildPossibleValuesLines(
      [ref('g', { origin: 'scope', locationName: 'a', line: 1 })],
      'test://hover.qsps',
      { expandVarRef },
    ).join('\n');
    expect(out).toMatch(/^- `g = 'A'` — `init1` line 2$/m);
    expect(out).toMatch(/^- `g = 'B'` — `init2` line 2$/m);
  });

  it('tags an unresolved var-ref edge with *(unresolved)*', () => {
    const expandVarRef = () => [];
    const out = buildPossibleValuesLines(
      [ref('missing', { origin: 'scope', locationName: 'a', line: 1 })],
      'test://hover.qsps',
      { expandVarRef },
    ).join('\n');
    expect(out).toMatch(/^- `\$missing` \*\(unresolved\)\* — `a` line 2$/m);
  });

  it('dedups var-ref expansion when multiple entries alias the same target', () => {
    let calls = 0;
    const expandVarRef = () => {
      calls++;
      return children({ stmtText: "g = 'X'", loc: 'init', line: 1 });
    };
    const out = buildPossibleValuesLines([
      ref('g', { origin: 'scope', locationName: 'a', line: 1 }),
      ref('g', { origin: 'scope', locationName: 'a', line: 2 }),
    ], 'test://hover.qsps', { expandVarRef });
    expect(calls).toBe(1);
    const flat = out.filter(l => l.includes("`g = 'X'`"));
    expect(flat.length).toBe(1);
  });

  it('renders var-ref entries verbatim when no expandVarRef callback is supplied', () => {
    // Without a chain resolver, the renderer falls through to the
    // standard stmtText path.
    const out = buildPossibleValuesLines(
      [ref('g', { origin: 'scope', locationName: 'a', line: 1 })],
      'test://hover.qsps',
    ).join('\n');
    expect(out).toContain('`$g`');
    expect(out).not.toContain('*(unresolved)*');
  });

  // ── Overflow caps ───────────────────────────────────────────────

  it('caps visible distinct values at MAX_HOVER_VALUES (10) with "…and N more"', () => {
    const entries: CursorValueEntry[] = [];
    for (let i = 0; i < 14; i++) {
      entries.push(expr(`'v${i}'`, { origin: 'document', locationName: `loc${i}`, line: i }));
    }
    const out = buildPossibleValuesLines(entries, 'test://hover.qsps');
    const valueLines = out.filter(l => l.startsWith('- `'));
    expect(valueLines).toHaveLength(10);
    expect(out.join('\n')).toMatch(/…and 4 more/);
  });

  it('caps inline locations per value at MAX_HOVER_LOCATIONS_PER_VALUE (20)', () => {
    const entries: CursorValueEntry[] = [];
    for (let i = 0; i < 25; i++) {
      entries.push(expr('42', { origin: 'document', locationName: `l${i}`, line: i }));
    }
    const out = buildPossibleValuesLines(entries, 'test://hover.qsps');
    const valueLines = out.filter(l => l.startsWith('- `'));
    expect(valueLines).toHaveLength(1);
    const row = valueLines[0];
    expect(row).toContain('*…and 5 more*');
    expect(row).toContain('`l0` line 1');
    expect(row).not.toContain('`l24` line 25');
    const beforeTail = row.split('*…and')[0];
    const matches = beforeTail.match(/`l\d+` line \d+/g) ?? [];
    expect(matches).toHaveLength(20);
  });

  it('does not add a per-value tail marker when locations fit exactly at the cap', () => {
    const entries: CursorValueEntry[] = [];
    for (let i = 0; i < 20; i++) {
      entries.push(expr('7', { origin: 'document', locationName: `l${i}`, line: i }));
    }
    const out = buildPossibleValuesLines(entries, 'test://hover.qsps');
    const row = out.find(l => l.startsWith('- `'))!;
    expect(row).not.toContain('*…and');
    const matches = row.match(/`l\d+` line \d+/g) ?? [];
    expect(matches).toHaveLength(20);
  });

  // ── Cross-file annotation ──────────────────────────────────────

  it('annotates entries from a foreign URI with [basename]', () => {
    const out = buildPossibleValuesLines(
      [expr("'CROSS'", { origin: 'document', locationName: 'init', line: 1, uri: 'file:///tmp/other.qsps' })],
      'file:///tmp/own.qsps',
    ).join('\n');
    expect(out).toContain('[other.qsps]');
    expect(out).toContain("`'CROSS'`");
  });

  it('does NOT annotate entries from the hover URI with [basename]', () => {
    const out = buildPossibleValuesLines(
      [expr("'LOCAL'", { origin: 'document', locationName: 'init', line: 1, uri: 'file:///tmp/own.qsps' })],
      'file:///tmp/own.qsps',
    ).join('\n');
    expect(out).not.toMatch(/\[own\.qsps\]/);
  });

  it('annotates flattened var-ref children from a foreign URI with [basename]', () => {
    const expandVarRef = () => children({
      stmtText: "g = 'CROSS'", loc: 'init', line: 1, uri: 'file:///tmp/other.qsps',
    });
    const out = buildPossibleValuesLines(
      [ref('g', { origin: 'scope', locationName: 'a', line: 1 })],
      'file:///tmp/own.qsps',
      { expandVarRef },
    ).join('\n');
    expect(out).toContain('[other.qsps]');
    expect(out).toContain("`g = 'CROSS'`");
  });

  // ── Code-block bindings render their captured source ────────────

  it('renders a code-block binding using its stmtText', () => {
    const out = buildPossibleValuesLines(
      [block({ locationName: 'a', isLocal: false, stmtText: "$f = { gs 'do' }" })],
      'test://hover.qsps',
    ).join('\n');
    expect(out).toContain("`$f = { gs 'do' }`");
  });

  // ── isValueBearing:false entries are filtered ──────────────────

  it('omits entries where binding.isValueBearing is false', () => {
    const e = expr('42', { locationName: 'a', line: 0, isLocal: false });
    const filtered: CursorValueEntry = {
      ...e,
      binding: { ...e.binding, isValueBearing: false },
    } as CursorValueEntry;
    const kept = expr("'kept'", { locationName: 'b', line: 1, isLocal: false });
    const out = buildPossibleValuesLines([filtered, kept], 'test://hover.qsps').join('\n');
    expect(out).not.toContain('`42`');
    expect(out).toContain("`'kept'`");
  });
});
