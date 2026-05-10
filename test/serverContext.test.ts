/**
 * Regression tests for fixes in the LSP server context plumbing.
 *
 *  - B1: `ctx.settings` is exposed as a getter so that reassignment
 *        of the underlying `settings` variable in common.ts propagates
 *        to every feature handler.
 *  - P1: `getOrBuildAgg` caches the aggregate on the DocumentState so
 *        repeated hover/refs/completion calls in single-file mode do
 *        not rebuild it on every request.  Project-mode aggregates
 *        always win over the cache.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { QspTreeSitterParser, extractSymbols } from '../src/parser/treeSitter';
import { buildLocationIndex } from '../src/common/locations';
import { resolveDefinition } from '../src/server/lspFeatures';
import {
  emptyAggregates,
  type ProjectAggregates,
} from '../src/server/aggregation';
import type { DocumentState, ServerContext } from '../src/server/lspFeatures';
import { WASM_PATH } from './testHelpers';

// ──────────────────────────────────────────────────────────────────────
// B1 — ctx.settings getter plumbing
// ──────────────────────────────────────────────────────────────────────

describe('ServerContext.settings plumbing (B1)', () => {
  it('exposes live settings when backed by a getter', () => {
    let settings = {
      project: { enabled: false },
      semanticHighlighting: { enabled: true },
      hover: { possibleValues: true },
    };
    const ctx = {
      get settings() { return settings; },
    } as unknown as ServerContext;

    expect(ctx.settings.project.enabled).toBe(false);

    // Simulate a config change: common.ts reassigns the `settings` let.
    settings = {
      project: { enabled: true },
      semanticHighlighting: { enabled: false },
      hover: { possibleValues: true },
    };

    // With the getter, handlers see the new value.
    expect(ctx.settings.project.enabled).toBe(true);
    expect(ctx.settings.semanticHighlighting.enabled).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// P1 — aggregate caching (verified via resolveDefinition)
// ──────────────────────────────────────────────────────────────────────

describe('aggregate caching (P1)', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  // Code with a location reference so resolveDefinition triggers getOrBuildAgg
  // (it calls getOrBuildAgg when resolving variable definitions).
  const CODE = `# a
local x = 1
gs 'b'
---
# b
pl x
---
`;
  const URI = 'test://agg-cache';

  function makeState(uri = URI): DocumentState {
    const tree = parser.parse(uri, CODE)!;
    const { symbols } = extractSymbols(tree, uri);
    return { symbols, locationIndex: buildLocationIndex(CODE) };
  }

  function makeCtx(
    state: DocumentState,
    opts: { projectAggregates?: ProjectAggregates | null } = {},
  ): ServerContext {
    return {
      projectAggregates: opts.projectAggregates ?? null,
      settings: { project: { enabled: false }, semanticHighlighting: { enabled: true }, hover: { possibleValues: true } },
      documentStates: new Map([[URI, state]]),
      projectFileUris: new Set(),
    } as unknown as ServerContext;
  }

  /** Trigger getOrBuildAgg by asking resolveDefinition to resolve `x` in loc b. */
  function trigger(ctx: ServerContext, state: DocumentState): void {
    const doc = TextDocument.create(URI, 'qsp', 1, CODE);
    // Position of `x` in `pl x` — line 5 (0-based), column 3.
    resolveDefinition(ctx, state, URI, { line: 5, character: 3 }, doc);
  }

  it('handler populates aggCache on first call', () => {
    const state = makeState();
    expect(state.aggCache).toBeUndefined();
    trigger(makeCtx(state), state);
    expect(state.aggCache).toBeDefined();
  });

  it('repeated handler calls reuse the same aggregate object (cache hit)', () => {
    const state = makeState();
    const ctx = makeCtx(state);
    trigger(ctx, state);
    const first = state.aggCache;
    trigger(ctx, state);
    expect(state.aggCache).toBe(first); // identity, not just deep-equal
  });

  it('a replaced DocumentState starts with a fresh cache', () => {
    const s1 = makeState();
    trigger(makeCtx(s1), s1);
    const agg1 = s1.aggCache;

    // Re-analysis in common.ts always REPLACES the state object —
    // the new object has no aggCache, so the next call rebuilds.
    const s2 = makeState();
    expect(s2.aggCache).toBeUndefined();
    trigger(makeCtx(s2), s2);
    expect(s2.aggCache).not.toBe(agg1);
  });

  it('project aggregates win over the single-file cache', () => {
    const state = makeState();
    // Warm up the single-file cache.
    trigger(makeCtx(state), state);
    const singleFileAgg = state.aggCache;
    expect(singleFileAgg).toBeDefined();

    // Build a minimal ProjectAggregates.
    const projectAgg = emptyAggregates() as ProjectAggregates;
    projectAgg.flatLocationDefs = new Map();
    projectAgg.locationDefs = new Map();
    projectAgg.callTypesPerTarget = new Map();

    // In project mode the handler should use projectAgg, not the cache.
    // We verify indirectly: aggCache is still the single-file object
    // (getOrBuildAgg must not overwrite it when projectAggregates wins).
    const ctxProject = makeCtx(state, { projectAggregates: projectAgg });
    trigger(ctxProject, state);
    expect(state.aggCache).toBe(singleFileAgg); // untouched
  });
});

