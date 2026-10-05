/**
 * End-to-end LSP regression test for the per-location-analysis path.
 *
 * Bug context
 * ───────────
 * Files ≥500 KB are analysed via `analyzeDocumentPerLocation` /
 * `tryIncrementalPerLocationUpdate` in src/server/common.ts.  Both
 * paths assemble a document-wide `DocumentSymbols` by transferring
 * per-location `LocationSymbols` via `addLocationFrom`, which never
 * populates the document-level `globalBindings` index.  Without an
 * explicit `symbols.rebuildGlobalBindings()` call before the new state
 * is stored, cross-document hover queries that walk the large file's
 * `globalBindings` (e.g. resolving a possible value for `$g` in a
 * small sibling document when `$g` is written in the large one) come
 * back empty.
 *
 * Test approach
 * ─────────────
 * A real `createQspServer` instance is wired up over a paired
 * `PassThrough` stream pair; a JSON-RPC client on the other end drives
 * the standard LSP handshake (`initialize` → `initialized` →
 * `didOpen` × 2 → `hover`).
 *
 *  - Big doc (>500 KB):  `# init` writes `$g = 'BIG_VALUE'`, plus a
 *    pad location to push the file past the per-location threshold.
 *  - Small doc:           reads `$g`; the cursor sits on `$g`.
 *
 * The hover result must contain `BIG_VALUE` — that string is only
 * reachable through the big file's `globalBindings`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { createConnection, TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import {
  CodeActionRequest,
  ConfigurationRequest,
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidChangeWatchedFilesNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DocumentHighlightRequest,
  DocumentSymbolRequest,
  FileChangeType,
  FoldingRangeRequest,
  HoverRequest,
  InitializeRequest,
  InitializedNotification,
  PrepareRenameRequest,
  PublishDiagnosticsNotification,
  ReferencesRequest,
  RegistrationRequest,
  RenameRequest,
  SemanticTokensRangeRequest,
  SemanticTokensRequest,
  type CodeAction,
  type DocumentSymbol,
  type Hover,
  type InitializeParams,
  type PublishDiagnosticsParams,
} from 'vscode-languageserver-protocol';
import { createQspServer } from '../src/server/common';
import { TOKEN_TYPES } from '../src/server/semanticTokens';
import { SETTLED_REQUEST } from '../src/common/analysisStatus';
import { fsProvider } from '../src/server/nodeHost';
import { NodeAnalysisCache, analyserSalt, nodeAnalysisCacheStore } from '../src/server/nodeCache';
import { WASM_PATH } from './testHelpers';

interface Harness {
  client: MessageConnection;
  diagnosticsFor: (uri: string) => Promise<PublishDiagnosticsParams>;
  /** The next diagnostics published for `uri`, ignoring any already received. */
  nextDiagnosticsFor: (uri: string) => Promise<PublishDiagnosticsParams>;
  /** The server's log lines so far. */
  logs: string[];
  shutdown: () => void;
}

/**
 * Spin up a real `createQspServer` on one half of a stream pair,
 * connect a JSON-RPC client to the other half, complete the LSP
 * handshake, and return helpers for sending requests / awaiting
 * diagnostics.
 */
async function startServer(
  qspConfig: Record<string, unknown> | null = null,
  // A folder on disk makes it a project: the server reads its files itself.
  workspaceDir?: string,
  cacheDir?: string,
): Promise<Harness> {
  const c2s = new PassThrough();
  const s2c = new PassThrough();

  const serverConn = createConnection(
    new StreamMessageReader(c2s),
    new StreamMessageWriter(s2c),
  );
  const documents = new TextDocuments(TextDocument);
  createQspServer(
    serverConn,
    documents,
    async () => fs.readFileSync(WASM_PATH),
    // Omit wasmDir: TreeSitter.init() with no `locateFile` resolves
    // its runtime via the Node.js module loader, which works in tests.
    // No fsProvider (unless a workspace is given) → no project files,
    // which is what most tests here want.
    undefined,
    workspaceDir ? fsProvider : undefined,
    cacheDir ? { analysisCache: nodeAnalysisCacheStore() } : {},
  );

  const client = createMessageConnection(
    new StreamMessageReader(s2c),
    new StreamMessageWriter(c2s),
  );

  // Server may register dynamic capabilities (DidChangeConfiguration);
  // accept them with a no-op response.
  client.onRequest(RegistrationRequest.type, () => null);

  // Server fetches `qsp` and `files` config sections during onInitialized;
  // return defaults so all diagnostics stay at their built-in defaults
  // unless the test passes an explicit `qsp` config override.
  client.onRequest(ConfigurationRequest.type, (params) => {
    return params.items.map(item => item.section === 'qsp' ? qspConfig : null);
  });

  // The server invalidates cached semantic tokens after each analysis
  // by calling `connection.languages.semanticTokens.refresh()`.  Return
  // null so the JSON-RPC client doesn't surface an "unhandled method"
  // rejection.
  client.onRequest('workspace/semanticTokens/refresh', () => null);

  // Bucket diagnostics by URI so tests can wait for analysis to complete.
  const diagnosticBuckets = new Map<string, PublishDiagnosticsParams>();
  const diagnosticWaiters = new Map<string, ((p: PublishDiagnosticsParams) => void)[]>();
  const nextWaiters = new Map<string, ((p: PublishDiagnosticsParams) => void)[]>();
  const logs: string[] = [];
  client.onNotification('window/logMessage', (p: { message: string }) => { logs.push(p.message); });
  client.onNotification(PublishDiagnosticsNotification.type, (params) => {
    const next = nextWaiters.get(params.uri);
    if (next) { nextWaiters.delete(params.uri); for (const w of next) w(params); }
    diagnosticBuckets.set(params.uri, params);
    const waiters = diagnosticWaiters.get(params.uri);
    if (waiters) {
      diagnosticWaiters.delete(params.uri);
      for (const w of waiters) w(params);
    }
  });

  client.listen();

  const folderUri = workspaceDir ? fsProvider.pathToUri(workspaceDir) : null;
  await client.sendRequest(InitializeRequest.type, {
    processId: process.pid,
    rootUri: folderUri,
    capabilities: {},
    workspaceFolders: folderUri ? [{ uri: folderUri, name: 'game' }] : null,
    initializationOptions: cacheDir ? { cacheDir } : undefined,
  } as InitializeParams);
  client.sendNotification(InitializedNotification.type, {});

  return {
    client,
    diagnosticsFor: (uri) => new Promise((resolve) => {
      const cached = diagnosticBuckets.get(uri);
      if (cached) { resolve(cached); return; }
      const arr = diagnosticWaiters.get(uri) ?? [];
      arr.push(resolve);
      diagnosticWaiters.set(uri, arr);
    }),
    nextDiagnosticsFor: (uri) => new Promise((resolve) => {
      const arr = nextWaiters.get(uri) ?? [];
      arr.push(resolve);
      nextWaiters.set(uri, arr);
    }),
    logs,
    shutdown: () => {
      client.dispose();
      c2s.destroy();
      s2c.destroy();
    },
  };
}

/**
 * Build a QSP document larger than the 500 KB per-location threshold
 * that defines `$g = '<marker>'` in its first location.
 */
function makeBigDocument(marker: string): string {
  const head = `# init\n$g = '${marker}'\n---\n`;
  // Pad with a single trivia-heavy location.  Comments are the cheapest
  // tree-sitter input — each line maps to a single trivia token.
  const padLine = '! ' + 'x'.repeat(120) + '\n';
  const padBody = padLine.repeat(Math.ceil(550_000 / padLine.length));
  return head + `# pad\n${padBody}---\n`;
}

describe('LSP end-to-end: per-location analysis populates globalBindings', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startServer();
  }, 30_000);

  afterAll(() => {
    h?.shutdown();
  });

  it(
    'hover on a variable in a small doc resolves a write in a >500KB sibling doc',
    async () => {
      const smallUri = 'file:///small.qsps';
      const bigUri = 'file:///big.qsps';

      // Small doc: `$x = $g` — the cursor will sit on `$g`.
      const small = `# main\n$x = $g\n---\n`;

      const big = makeBigDocument('BIG_VALUE_MARKER');
      // Sanity: the big doc must clear the per-location threshold; the
      // bug only manifests on that path.
      expect(big.length).toBeGreaterThan(500_000);

      h.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: bigUri,   languageId: 'qsp', version: 1, text: big },
      });
      h.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: smallUri, languageId: 'qsp', version: 1, text: small },
      });

      // Wait for both files to publish diagnostics — this guarantees
      // analyzeDocument has finished for each.
      await Promise.all([
        h.diagnosticsFor(bigUri),
        h.diagnosticsFor(smallUri),
      ]);

      // Hover on `$g` in the small doc (line 1, char 5 — the `g` of `$g`).
      const hover = await h.client.sendRequest(HoverRequest.type, {
        textDocument: { uri: smallUri },
        position: { line: 1, character: 5 },
      }) as Hover | null;

      expect(hover, 'hover returned null').not.toBeNull();
      const md = hover && typeof hover.contents === 'object' && 'value' in hover.contents
        ? (hover.contents as { value: string }).value
        : '';

      // The marker is reachable ONLY through the big file's
      // globalBindings index, populated by rebuildGlobalBindings().
      // Without the bugfix in common.ts, the marker is missing.
      expect(md).toContain('BIG_VALUE_MARKER');
    },
    30_000,
  );
});

// ──────────────────────────────────────────────────────────────────────
// `qsp.hover.possibleValues` setting gates the "Possible values" hover
// section.  When false, the resolver call and rendering are skipped.
// ──────────────────────────────────────────────────────────────────────

describe('LSP end-to-end: qsp.hover.possibleValues setting', () => {
  async function hoverFor(qspConfig: Record<string, unknown> | null): Promise<string> {
    const h = await startServer(qspConfig);
    try {
      const uri = 'file:///hover-gate.qsps';
      const code = `# init\n$g = 'GATED_MARKER'\n---\n# main\npl $g\n---\n`;
      h.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId: 'qsp', version: 1, text: code },
      });
      await h.diagnosticsFor(uri);
      // Position on `$g` in `pl $g` (line 4, column 4 — the `g`).
      const hover = await h.client.sendRequest(HoverRequest.type, {
        textDocument: { uri },
        position: { line: 4, character: 4 },
      }) as Hover | null;
      const md = hover && typeof hover.contents === 'object' && 'value' in hover.contents
        ? (hover.contents as { value: string }).value
        : '';
      return md;
    } finally {
      h.shutdown();
    }
  }

  it('renders "**Possible values:**" when the setting is true (default)', async () => {
    const md = await hoverFor(null);
    expect(md).toMatch(/\*\*Possible values \(\d+ definitions?\):\*\*/);
    expect(md).toContain('GATED_MARKER');
  }, 30_000);

  it('omits "**Possible values:**" when the setting is false', async () => {
    const md = await hoverFor({ hover: { possibleValues: false } });
    expect(md).not.toMatch(/\*\*Possible values[^*]*\*\*/);
    expect(md).not.toContain('GATED_MARKER');
  }, 30_000);
});

// ──────────────────────────────────────────────────────────────────────
// `qsp.hover.maxItemsPerCategory` controls the per-section item cap
// in hover tooltips.  Lowering it should truncate the "Possible values"
// list and append a "…and N more" tail.
// ──────────────────────────────────────────────────────────────────────

describe('LSP end-to-end: qsp.hover.maxItemsPerCategory setting', () => {
  async function valuesHover(qspConfig: Record<string, unknown> | null): Promise<string> {
    const h = await startServer(qspConfig);
    try {
      const uri = 'file:///hover-cap.qsps';
      // 8 distinct assignments to $g, then a read site for hover.
      const inits = Array.from({ length: 8 }, (_, i) =>
        `# init${i}\n$g = 'v${i}'\n---\n`).join('');
      const code = inits + `# main\npl $g\n---\n`;
      h.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId: 'qsp', version: 1, text: code },
      });
      await h.diagnosticsFor(uri);
      // `pl $g` lives on line (8*3 + 1) = 25.  Position on the `g` (col 4).
      const hover = await h.client.sendRequest(HoverRequest.type, {
        textDocument: { uri },
        position: { line: 25, character: 4 },
      }) as Hover | null;
      return hover && typeof hover.contents === 'object' && 'value' in hover.contents
        ? (hover.contents as { value: string }).value
        : '';
    } finally {
      h.shutdown();
    }
  }

  it('truncates the "Possible values" list when the cap is below the entry count', async () => {
    const md = await valuesHover({ hover: { maxItemsPerCategory: 3 } });
    expect(md).toMatch(/\*\*Possible values \(\d+ definitions?\):\*\*/);
    expect(md).toMatch(/…and 5 more/);
    // First 3 should be present, the 4th and beyond should not.
    expect(md).toContain("'v0'");
    expect(md).toContain("'v2'");
    expect(md).not.toContain("'v7'");
  }, 30_000);

  it('shows all entries when the cap exceeds the entry count', async () => {
    const md = await valuesHover({ hover: { maxItemsPerCategory: 50 } });
    expect(md).toMatch(/\*\*Possible values \(\d+ definitions?\):\*\*/);
    expect(md).not.toMatch(/…and \d+ more/);
    expect(md).toContain("'v7'");
  }, 30_000);
});

// ──────────────────────────────────────────────────────────────────────
// Numeric diagnostic settings are validated like `hover.maxItemsPerCategory`:
// settings.json isn't checked against package.json's `minimum`, so an
// out-of-range value must fall back to the default instead of silently
// disabling the check (`maxLocationLines: -1`) or hiding every error
// behind a summary (`maxErrorsPerLocation: 0`).
// ──────────────────────────────────────────────────────────────────────

describe('LSP end-to-end: numeric diagnostic settings validation', () => {
  async function messages(qspConfig: Record<string, unknown>, code: string): Promise<string[]> {
    const h = await startServer(qspConfig);
    try {
      const uri = 'file:///numeric-settings.qsps';
      // Let the server read `workspace/configuration` before the first analysis.
      await new Promise((r) => setTimeout(r, 200));
      h.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId: 'qsp', version: 1, text: code },
      });
      return (await h.diagnosticsFor(uri)).diagnostics.map(d => d.message);
    } finally {
      h.shutdown();
    }
  }

  it('an out-of-range maxLocationLines keeps the default limit', async () => {
    const code = `# long\n${'pl 1\n'.repeat(600)}---\n`;
    const msgs = await messages({ diagnostics: { maxLocationLines: -1 } }, code);
    expect(msgs.some(m => m.includes('lines long (max 500)'))).toBe(true);
  }, 30_000);

  it('an out-of-range maxErrorsPerLocation still reports individual errors', async () => {
    const msgs = await messages({ diagnostics: { maxErrorsPerLocation: 0 } }, `# bad\npl (1\n---\n`);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.some(m => /has \d+ syntax errors/.test(m))).toBe(false);
  }, 30_000);
});

// ──────────────────────────────────────────────────────────────────────
// Variable hover "N definitions, M usages" splits every occurrence —
// reads + compound ops (`x += 1`, `hp = hp + 5`) count as usages,
// plain `=` LHS / `local` / append writes (`$arr[] = …`) count as
// definitions.  When there's exactly one definition, its line number
// is shown inline.
// ──────────────────────────────────────────────────────────────────────

describe('LSP end-to-end: variable hover reference count', () => {
  async function hoverMd(code: string, line: number, character: number): Promise<string> {
    const h = await startServer(null);
    try {
      const uri = 'file:///ref-count.qsps';
      h.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId: 'qsp', version: 1, text: code },
      });
      await h.diagnosticsFor(uri);
      const hover = await h.client.sendRequest(HoverRequest.type, {
        textDocument: { uri }, position: { line, character },
      }) as Hover | null;
      return hover && typeof hover.contents === 'object' && 'value' in hover.contents
        ? (hover.contents as { value: string }).value
        : '';
    } finally {
      h.shutdown();
    }
  }

  it('counts `$arr[] = …` append writes as definitions', async () => {
    // 4 append writes — all definitions, no usages.
    const code = `# main
$jour_list[] = 'a'
$jour_list[] = 'b'
$jour_list[] = 'c'
$jour_list[] = 'd'
---
`;
    const md = await hoverMd(code, 1, 1); // on the `$` of `$jour_list`
    expect(md).toContain('`jour_list`');
    expect(md).toMatch(/4 definitions/);
    expect(md).not.toMatch(/usage/);
  }, 30_000);

  it('counts compound assignments (`x += 1`) as usages', async () => {
    const code = `# main
hp = 10
hp += 5
hp += 5
---
`;
    const md = await hoverMd(code, 1, 0); // on `hp`
    expect(md).toContain('`hp`');
    // 1 definition (hp = 10), 2 usages (the two compound ops).
    expect(md).toMatch(/1 definition \(line 2\)/);
    expect(md).toMatch(/2 usages/);
  }, 30_000);

  it('counts self-referential `hp = hp + 5` LHS as usage, RHS as usage', async () => {
    const code = `# main
hp = 10
hp = hp + 5
---
`;
    const md = await hoverMd(code, 1, 0);
    expect(md).toContain('`hp`');
    // line 2: definition; line 3: compound LHS + RHS read → 2 usages.
    expect(md).toMatch(/1 definition \(line 2\)/);
    expect(md).toMatch(/2 usages/);
  }, 30_000);

  it('counts plain reads as usages alongside the definition', async () => {
    const code = `# main
x = 1
pl x
pl x
pl x
---
`;
    const md = await hoverMd(code, 1, 0);
    expect(md).toContain('`x`');
    // 1 definition + 3 reads.
    expect(md).toMatch(/1 definition \(line 2\)/);
    expect(md).toMatch(/3 usages/);
  }, 30_000);
});

// ──────────────────────────────────────────────────────────────────────
// qsp/anonymizedLocation: the code a crash report may carry
// ──────────────────────────────────────────────────────────────────────
//
// The client asks the restarted server for the code of the location a
// crashed run was stuck on, with that run's pseudonyms, so the code and
// the breadcrumbs name the same locations.
describe('LSP e2e: anonymized location code for crash reports', () => {
  let h: Harness;
  beforeAll(async () => { h = await startServer(); });
  afterAll(() => h.shutdown());

  it('returns the location without its text, under the given pseudonyms', async () => {
    const uri = 'file:///game/secret.qsps';
    const text = "# Кухня\n$рецепт = 'тайный соус'\ngt 'Погреб'\n--- Кухня ---\n# Погреб\ngt 'Кухня'\n--- Погреб ---\n";
    h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text } });
    await h.diagnosticsFor(uri);
    const result = await h.client.sendRequest('qsp/anonymizedLocation', {
      uri, name: 'кухня', locations: { 'кухня': 'f01_l0001', 'погреб': 'f01_l0002' },
    }) as { text: string; names: Record<string, string> };
    expect(result.text).toBe("# f01_l0001\n$var_0001 = 'xxxxxxxxxxx'\ngt 'f01_l0002'\n--- xxxxx ---");
    expect(result.names).toEqual({ var_0001: 'рецепт' });
    expect(await h.client.sendRequest('qsp/anonymizedLocation', { uri, name: 'нет такой' })).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Quick fixes that silence a check
// ──────────────────────────────────────────────────────────────────────
//
// On a QSP diagnostic the server offers to ignore it on its line or in
// its location (a `!@qsp-ignore` comment), or to turn the check off (a
// client command, since only the client can write settings).
describe('LSP e2e: quick fixes that silence a check', () => {
  let h: Harness;
  beforeAll(async () => { h = await startServer(); });
  afterAll(() => h.shutdown());

  it('offers line, location and settings fixes, and the line fix silences the diagnostic', async () => {
    const uri = 'file:///game/quickfix.qsps';
    const text = '# Прихожая\n  *pl счёт\n---\n';
    h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text } });
    const { diagnostics } = await h.diagnosticsFor(uri);
    const uninit = diagnostics.find(d => d.code === 'uninitializedVariables')!;
    expect(uninit.data).toEqual({ name: 'счёт' });

    const actions = await h.client.sendRequest(CodeActionRequest.type, {
      textDocument: { uri }, range: uninit.range, context: { diagnostics: [uninit] },
    }) as CodeAction[];
    const fixes = actions.filter(a => a.kind === 'quickfix');
    expect(fixes.map(a => a.title)).toEqual([
      "Ignore 'uninitializedVariables' for 'счёт' on this line",
      "Ignore 'uninitializedVariables' for 'счёт' in location 'Прихожая'",
      "Turn off 'uninitializedVariables' checks in this workspace",
    ]);
    expect(fixes[0].edit!.changes![uri]).toEqual([{
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
      newText: '  !@qsp-ignore uninitializedVariables: счёт\n',
    }]);
    expect(fixes[1].edit!.changes![uri][0].range.start.line).toBe(1);
    expect(fixes[2].command).toEqual({
      title: "Turn off 'uninitializedVariables'", command: 'qsp.diagnostics.turnOff', arguments: ['uninitializedVariables'],
    });

    const fixedUri = 'file:///game/quickfix-fixed.qsps';
    const fixed = '# Прихожая\n  !@qsp-ignore uninitializedVariables: счёт\n  *pl счёт\n---\n';
    h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri: fixedUri, languageId: 'qsp', version: 1, text: fixed } });
    const after = await h.diagnosticsFor(fixedUri);
    expect(after.diagnostics.filter(d => d.code === 'uninitializedVariables')).toEqual([]);
  }, 30_000);

  it('offers nothing that would hide a syntax error', async () => {
    const uri = 'file:///game/quickfix-syntax.qsps';
    h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text: '# a\nif x = 1\n---\n' } });
    const { diagnostics } = await h.diagnosticsFor(uri);
    const syntax = diagnostics.filter(d => d.code === 'syntax');
    expect(syntax.length).toBeGreaterThan(0);
    const actions = await h.client.sendRequest(CodeActionRequest.type, {
      textDocument: { uri }, range: syntax[0].range, context: { diagnostics: syntax },
    }) as CodeAction[];
    expect(actions.filter(a => a.kind === 'quickfix')).toEqual([]);
  }, 30_000);
});

// ──────────────────────────────────────────────────────────────────────
// Syntax errors of a large open file in a project
// ──────────────────────────────────────────────────────────────────────
//
// A file past the per-location threshold has no whole-file tree, and the
// project re-diagnosis read syntax errors only from one: a large open file
// in a project showed none at all.
describe('LSP e2e: syntax errors of a large open project file', () => {
  let h: Harness;
  let dir: string;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-big-syntax-'));
    fs.writeFileSync(path.join(dir, 'main.qsps'), "# Прихожая\ngs 'Ошибка'\n--- Прихожая ---\n");
    h = await startServer(null, dir);
  });
  afterAll(() => { h.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('reports them after the project re-diagnoses', async () => {
    const text = makeBigDocument('большой') + '# Ошибка\nif x = 1\n--- Ошибка ---\n';
    const file = path.join(dir, 'big.qsps');
    fs.writeFileSync(file, text);
    const uri = fsProvider.pathToUri(file);
    const withSyntax = (async () => {
      for (;;) {
        const p = await h.nextDiagnosticsFor(uri);
        const syntax = p.diagnostics.filter(d => d.code === 'syntax');
        if (syntax.length > 0) return syntax;
      }
    })();
    h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text } });
    const syntax = await withSyntax;
    expect(syntax[0].range.start.line).toBeGreaterThan(4000);
  }, 60_000);
});

// ──────────────────────────────────────────────────────────────────────
// A closed project file keeps the editor's analysis
// ──────────────────────────────────────────────────────────────────────
//
// Closing a tab re-reads the file from disk for the project. When the text
// on disk is what the editor had, its analysis is kept instead of being
// redone (seconds for a large file); otherwise the file is analysed again.
describe('LSP e2e: closing a project file', () => {
  let h: Harness;
  let dir: string;
  const files: Record<string, string> = {
    'main.qsps': "# Прихожая\ngs 'Кухня'\n--- Прихожая ---\n",
    'kitchen.qsps': "# Кухня\n*pl счёт\ngt 'нет_такой'\n--- Кухня ---\n# Сломано\nif x = 1\n--- Сломано ---\n",
  };
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-close-'));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    h = await startServer({ debug: { performanceLog: true } }, dir);
  });
  afterAll(() => { h.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

  const summary = (p: PublishDiagnosticsParams) => p.diagnostics.map(d => `${d.range.start.line}:${d.code}`).sort();
  const analyses = () => h.logs.filter(l => l.includes('[perf] project file analysis')).length;
  const kept = () => h.logs.filter(l => l.includes('[perf] closed file kept')).length;

  it('keeps the analysis of an unchanged file, and re-analyses a changed one', async () => {
    const uri = fsProvider.pathToUri(path.join(dir, 'kitchen.qsps'));
    const fromLoad = summary(await h.diagnosticsFor(uri));
    expect(fromLoad).toEqual(expect.arrayContaining(['2:unresolvedLocationRefs']));
    expect(fromLoad.some(d => d.endsWith(':syntax'))).toBe(true);

    // Unchanged: open, close, and the closed file shows what it showed.
    const opened = h.nextDiagnosticsFor(uri);
    h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text: files['kitchen.qsps'] } });
    await opened;
    const before = analyses();
    const closed = h.nextDiagnosticsFor(uri);
    h.client.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
    expect(summary(await closed)).toEqual(fromLoad);
    expect(kept()).toBe(1);
    expect(analyses()).toBe(before);

    // Closed with unsaved edits: the file on disk differs, so it is analysed.
    const reopened = h.nextDiagnosticsFor(uri);
    h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text: files['kitchen.qsps'] + '# Новая\n--- Новая ---\n' } });
    await reopened;
    const closedAgain = h.nextDiagnosticsFor(uri);
    h.client.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
    expect(summary(await closedAgain)).toEqual(fromLoad);
    expect(kept()).toBe(1);
    expect(analyses()).toBe(before + 1);
  }, 30_000);

  it('keeps it for a large file analysed one location at a time, syntax errors included', async () => {
    const big = makeBigDocument('большой') + "# Ошибка\nif x = 1\n--- Ошибка ---\n# Ссылка\ngt 'нет_такой'\n--- Ссылка ---\n";
    const file = path.join(dir, 'big.qsps');
    fs.writeFileSync(file, big);
    const uri = fsProvider.pathToUri(file);
    // The first diagnostics may come from the quick pass before the parse.
    const parsed = (async () => {
      for (;;) {
        const p = await h.nextDiagnosticsFor(uri);
        if (summary(p).some(d => d.endsWith(':syntax'))) return p;
      }
    })();
    h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text: big } });
    const whileOpen = summary(await parsed);
    expect(h.logs.some(l => l.includes('Per-location parse'))).toBe(true);
    expect(whileOpen.some(d => d.endsWith(':syntax'))).toBe(true);
    expect(whileOpen.some(d => d.endsWith(':unresolvedLocationRefs'))).toBe(true);
    const keptBefore = kept();
    const closed = h.nextDiagnosticsFor(uri);
    h.client.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
    expect(summary(await closed)).toEqual(whileOpen);
    expect(kept()).toBe(keptBefore + 1);
  }, 60_000);
});

// ──────────────────────────────────────────────────────────────────────
// Opening a large file reuses a stored analysis
// ──────────────────────────────────────────────────────────────────────
//
// A large file opened with the text the project scan analysed (kept in
// memory) or an earlier session stored (on disk) is only parsed for its
// trees and tokens; symbols and syntax errors are taken as they are. The
// editor stores its own analysis of a file opened from scratch. Whatever
// the source, the diagnostics and the highlighting are the same.
describe('LSP e2e: opening a large file with a stored analysis', () => {
  const big = makeBigDocument('большой')
    + "# Ошибка\n*pl 'до ошибки'\nif x = 1\n--- Ошибка ---\n"
    + "# Ссылка\n$имя = 'Вася'\n*pl '<a href=\"exec:gt ''нет_ссылки''\">идти</a>'\ngt 'нет_такой'\n--- Ссылка ---\n";
  const main = "# Прихожая\ngs 'Ссылка'\n--- Прихожая ---\n";
  let root: string;
  let game: string;
  let uri: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-stored-'));
    game = path.join(root, 'game');
    fs.mkdirSync(game);
    fs.writeFileSync(path.join(game, 'main.qsps'), main);
    fs.writeFileSync(path.join(game, 'big.qsps'), big);
    uri = fsProvider.pathToUri(path.join(game, 'big.qsps'));
  });
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

  // Opens the big file (or `text` under its name) and returns what the editor shows for it, and the
  // per-location analysis' perf line.
  async function openBig(workspace: boolean, cacheDir?: string, text = big) {
    const h = await startServer({ debug: { performanceLog: true } }, workspace ? game : undefined, cacheDir);
    try {
      if (workspace) await h.diagnosticsFor(fsProvider.pathToUri(path.join(game, 'main.qsps')));
      // The performance log is on once the settings have arrived.
      while (!h.logs.some(l => l.includes('Server ready'))) await new Promise(r => setTimeout(r, 10));
      const parsed = (async () => {
        for (;;) {
          const p = await h.nextDiagnosticsFor(uri);
          if (p.diagnostics.some(d => d.code === 'syntax')) return p;
        }
      })();
      h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text } });
      const diagnostics = (await parsed).diagnostics;
      const tokens = await h.client.sendRequest(SemanticTokensRequest.type, { textDocument: { uri } });
      const perf = h.logs.find(l => l.includes('[perf] per-location analysis'));
      return { diagnostics, tokens: tokens?.data, perf: perf ?? '' };
    } finally {
      h.shutdown();
    }
  }
  const extracted = (perf: string) => /[·,] symbols /.test(perf);
  const parsed = (perf: string) => /[·,] parse /.test(perf);

  it('takes the project scan\'s analysis, then the stored one, and gives the same result', async () => {
    const cache = path.join(root, 'cache-project');
    const fresh = await openBig(true);
    expect(extracted(fresh.perf)).toBe(true);
    expect(fresh.diagnostics.some(d => d.code === 'unresolvedLocationRefs')).toBe(true);

    const fromMemory = await openBig(true, cache);
    expect(fromMemory.perf).toContain('stored analysis');
    expect(fromMemory.perf).not.toContain('cache read');
    expect(extracted(fromMemory.perf)).toBe(false);
    expect(parsed(fromMemory.perf)).toBe(false);
    expect(fromMemory.diagnostics).toEqual(fresh.diagnostics);
    expect(fromMemory.tokens).toEqual(fresh.tokens);

    const alone = await openBig(false);
    const fromDisk = await openBig(false, cache);
    expect(fromDisk.perf).toContain('cache read');
    expect(extracted(fromDisk.perf)).toBe(false);
    expect(parsed(fromDisk.perf)).toBe(false);
    expect(fromDisk.diagnostics).toEqual(alone.diagnostics);
    expect(fromDisk.tokens).toEqual(alone.tokens);
  }, 120_000);

  it('stores the analysis of a file opened from scratch, equal to the project scan\'s', async () => {
    const cache = path.join(root, 'cache-editor');
    const first = await openBig(false, cache);
    expect(extracted(first.perf)).toBe(true);
    expect(first.perf).toContain('cache write');

    const again = await openBig(false, cache);
    expect(extracted(again.perf)).toBe(false);
    expect(again.diagnostics).toEqual(first.diagnostics);
    expect(again.tokens).toEqual(first.tokens);

    // The same entry the project scan wrote in the test above.
    const read = (dir: string) => {
      const c = new NodeAnalysisCache(dir, { salt: analyserSalt([]) });
      return c.get(c.key('file symbols', uri, 'exec', big));
    };
    const byEditor = read(cache);
    expect(byEditor).toBeDefined();
    expect(byEditor).toEqual(read(path.join(root, 'cache-project')));
  }, 120_000);

  it('analyses a file with two locations of one name from scratch every time', async () => {
    const cache = path.join(root, 'cache-duplicates');
    const twice = big + "# ссылка\n*pl 'вторая'\n--- ссылка ---\n";
    const first = await openBig(false, cache, twice);
    expect(first.perf).not.toContain('cache write');
    const again = await openBig(false, cache, twice);
    expect(extracted(again.perf)).toBe(true);
    expect(again.diagnostics).toEqual(first.diagnostics);
  }, 120_000);

  it('makes tokens for the lines asked, and lets an edit re-analyse a location taken as stored', async () => {
    const cache = path.join(root, 'cache-lazy');
    await openBig(false, cache);
    const h = await startServer({ debug: { performanceLog: true } }, undefined, cache);
    try {
      while (!h.logs.some(l => l.includes('Server ready'))) await new Promise(r => setTimeout(r, 10));
      const opened = (async () => {
        for (;;) {
          const p = await h.nextDiagnosticsFor(uri);
          if (p.diagnostics.some(d => d.code === 'syntax')) return p;
        }
      })();
      h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text: big } });
      const before = (await opened).diagnostics;
      const unresolved = before.find(d => d.code === 'unresolvedLocationRefs' && d.message.includes('нет_такой'))!;
      expect(unresolved).toBeDefined();
      expect(parsed(h.logs.find(l => l.includes('[perf] per-location analysis'))!)).toBe(false);

      // Absolute [line, char, length, type, modifiers] from LSP's relative encoding.
      const decode = (data: number[]) => {
        const out: number[][] = [];
        let line = 0, char = 0;
        for (let i = 0; i < data.length; i += 5) {
          line += data[i];
          char = data[i] === 0 ? char + data[i + 1] : data[i + 1];
          out.push([line, char, data[i + 2], data[i + 3], data[i + 4]]);
        }
        return out;
      };
      const lines = big.split('\n');
      const start = lines.indexOf('# Ссылка');
      const end = lines.indexOf('--- Ссылка ---');
      const range = await h.client.sendRequest(SemanticTokensRangeRequest.type, {
        textDocument: { uri }, range: { start: { line: start, character: 0 }, end: { line: end, character: 0 } },
      });
      expect(h.logs.some(l => /\[perf\] semantic tokens .*lines/.test(l))).toBe(true);
      const full = await h.client.sendRequest(SemanticTokensRequest.type, { textDocument: { uri } });
      const inRange = decode(full!.data).filter(([line]) => line >= start && line <= end);
      expect(inRange.length).toBeGreaterThan(0);
      expect(decode(range!.data)).toEqual(inRange);

      // An edit in a location taken from the stored analysis.
      const edited = big.replace("gt 'нет_такой'", "gt 'init'");
      const changed = h.nextDiagnosticsFor(uri);
      h.client.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri, version: 2 }, contentChanges: [{ text: edited }],
      });
      let after = (await changed).diagnostics;
      // Older diagnostics may come first, from the open.
      while (!after.some(d => d.code === 'syntax')) after = (await h.nextDiagnosticsFor(uri)).diagnostics;
      expect(after).toEqual(before.filter(d => d !== unresolved));
    } finally {
      h.shutdown();
    }
  }, 120_000);
});

// ──────────────────────────────────────────────────────────────────────
// Hover on a local of a nested block in a large file
// ──────────────────────────────────────────────────────────────────────
//
// Past 500 KB, hover parses the location again (only locations of 50 KB
// and more keep their tree); scopes recorded as node ids of the first
// parse matched nothing in it, so a loop body's local had no values.
describe('LSP e2e: possible values of a nested local in a large file', () => {
  it('follows a loop body\'s local to the loop variable', async () => {
    const text = makeBigDocument('большой')
      + '# комната\nloop local i = 0 while i < 3 step i += 1:\n  local y = i\n  *pl y\nend\n--- комната ---\n';
    const uri = 'file:///nested-local-big.qsps';
    const h = await startServer();
    try {
      h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text } });
      for (;;) {
        await h.nextDiagnosticsFor(uri);
        if (h.logs.some(l => l.includes('Per-location parse'))) break;
      }
      const line = text.split('\n').indexOf('  *pl y');
      const hover = await h.client.sendRequest(HoverRequest.type, { textDocument: { uri }, position: { line, character: 6 } }) as Hover | null;
      const md = hover && typeof hover.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '';
      expect(md).toContain('local i = 0');
    } finally {
      h.shutdown();
    }
  }, 60_000);
});

// ──────────────────────────────────────────────────────────────────────
// Variable checks don't depend on whether a file is open
// ──────────────────────────────────────────────────────────────────────
//
// `uninitializedVariables` follows `б = а` to the never assigned `а` using
// the scopes around the read. They used to come from the whole-file tree,
// which only a small open file has: closed project files and large files
// fell back to "`б` is assigned somewhere" and showed no warning.
describe('LSP e2e: variable checks open and closed', () => {
  const code = "# начало\nб = а\n--- начало ---\n# конец\n*pl б\n--- конец ---\n";
  const readLine = 4;
  const uninitialized = (p: PublishDiagnosticsParams) =>
    p.diagnostics.filter(d => d.code === 'uninitializedVariables').map(d => d.range.start.line).sort();
  let dir: string;
  let h: Harness;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-var-checks-'));
    fs.writeFileSync(path.join(dir, 'main.qsps'), code);
    h = await startServer(null, dir);
  });
  afterAll(() => { h.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('reports the same for a closed and an open file', async () => {
    const uri = fsProvider.pathToUri(path.join(dir, 'main.qsps'));
    const closed = uninitialized(await h.diagnosticsFor(uri));
    expect(closed).toContain(readLine);

    const opened = (async () => {
      for (;;) {
        const p = await h.nextDiagnosticsFor(uri);
        if (p.diagnostics.length > 0) return p;
      }
    })();
    h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text: code } });
    expect(uninitialized(await opened)).toEqual(closed);
  }, 30_000);

  it('reports it in a large file parsed location by location', async () => {
    const big = makeBigDocument('большой') + code.replace(/начало/g, 'старт').replace(/конец/g, 'финиш');
    const file = path.join(dir, 'big.qsps');
    fs.writeFileSync(file, big);
    const uri = fsProvider.pathToUri(file);
    const line = big.split('\n').indexOf('*pl б');
    const parsed = (async () => {
      for (;;) {
        const p = await h.nextDiagnosticsFor(uri);
        if (uninitialized(p).length > 0) return p;
      }
    })();
    h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text: big } });
    expect(uninitialized(await parsed)).toContain(line);
  }, 60_000);
});

// ──────────────────────────────────────────────────────────────────────
// Actions a syntax error hides, in a large file
// ──────────────────────────────────────────────────────────────────────
//
// A whole-file parse adds actions that ERROR nodes swallowed from the
// text; locations parsed alone didn't, so a large file's Outline lost them.
describe('LSP e2e: an action behind a syntax error in a large file', () => {
  it('is in the Outline', async () => {
    const text = makeBigDocument('большой') + "# комната\n(((\nact 'взять':\n*pl 1\nend\n--- комната ---\n";
    const uri = 'file:///hidden-action-big.qsps';
    const h = await startServer();
    try {
      h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text } });
      for (;;) {
        await h.nextDiagnosticsFor(uri);
        if (h.logs.some(l => l.includes('Per-location parse'))) break;
      }
      const outline = await h.client.sendRequest(DocumentSymbolRequest.type, { textDocument: { uri } }) as DocumentSymbol[];
      const room = outline.find(s => s.name === 'комната');
      expect(room?.children?.map(c => c.name)).toContain('act взять');
    } finally {
      h.shutdown();
    }
  }, 60_000);
});

// ──────────────────────────────────────────────────────────────────────
// Folding in a large file
// ──────────────────────────────────────────────────────────────────────
//
// Without a whole-file tree, a large file's blocks were folded by
// matching `act`/`if`/`loop` lines with `end` lines, which one-line
// `if x: …` and `act '…': …` threw off. They now come from the
// locations' own trees, as a small file's come from its tree.
describe('LSP e2e: folding blocks of a large file', () => {
  const room = [
    '# комната',
    "act 'взять':",
    '  if x = 1: *pl 1',
    '  if y = 2:',
    "    act 'внутри': *pl 2",
    '    *pl 3',
    '  end',
    'end',
    'loop local i = 0 while i < 2 step i += 1:',
    '  *pl i',
    'end',
    '--- комната ---',
    '',
  ].join('\n');

  async function blockFolds(text: string, uri: string): Promise<string[]> {
    const h = await startServer();
    try {
      h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text } });
      await h.diagnosticsFor(uri);
      for (;;) {
        // The quick pass publishes before the parse; folding then still lacks the blocks.
        const ranges = await h.client.sendRequest(FoldingRangeRequest.type, { textDocument: { uri } }) ?? [];
        const start = text.split('\n').indexOf('# комната');
        const inRoom = ranges
          .filter(r => r.kind === 'region' && r.startLine > start)
          .map(r => `${r.startLine - start}-${r.endLine - start}`).sort();
        if (inRoom.length > 0) return inRoom;
        await new Promise(r => setTimeout(r, 50));
      }
    } finally {
      h.shutdown();
    }
  }

  it('folds the same blocks as a small file with the same location', async () => {
    const small = await blockFolds(room, 'file:///fold-small.qsps');
    expect(small).toEqual(['1-7', '3-6', '8-10']);
    expect(await blockFolds(makeBigDocument('большой') + room, 'file:///fold-big.qsps')).toEqual(small);
  }, 60_000);
});

// ──────────────────────────────────────────────────────────────────────
// Aggregates kept across an edit of one location
// ──────────────────────────────────────────────────────────────────────
//
// An edit that changes nothing other locations see keeps the propagation
// of locals; the edited location's symbols are new objects, so the kept
// one must point at them, or `x`, read by the location it is passed to,
// is reported as never read.
describe('LSP e2e: a local passed to a call, after an edit of its location', () => {
  it('is still read by the callee', async () => {
    const h = await startServer();
    try {
      const uri = 'file:///single/passed.qsps';
      // `никто` is never assigned: a warning to wait for.
      const text = "# старт\nlocal x = 1\ngs 'вызов'\n---\n# вызов\npl x, никто\n---\n";
      const unread = (p: PublishDiagnosticsParams) => p.diagnostics.filter(d => d.code === 'unusedVariables').map(d => d.message);
      h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text } });
      expect(unread(await h.diagnosticsFor(uri))).toEqual([]);

      await new Promise(r => setTimeout(r, 900)); // the open's analysis is over
      // The edit's diagnostics replace the open's; none are cleared before.
      const checked = h.nextDiagnosticsFor(uri);
      h.client.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri, version: 2 },
        contentChanges: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, text: "pl 'привет'\n" }],
      });
      const after = await checked;
      expect(after.diagnostics.map(d => d.message)).toContain("Variable 'никто' is used but never assigned");
      expect(unread(after)).toEqual([]);
    } finally {
      h.shutdown();
    }
  }, 30_000);
});

// ──────────────────────────────────────────────────────────────────────
// A `{…}` passed as an argument is a string the callee gets as $args[N]:
// highlighted as code only when the callee runs it (`dynamic $args[N]`).
// ──────────────────────────────────────────────────────────────────────

describe('LSP e2e: blocks passed as arguments', () => {
  let h: Harness;
  beforeAll(async () => { h = await startServer(); }, 30_000);
  afterAll(() => { h?.shutdown(); });

  it('highlights a block nothing runs as a string, and one the callee runs as code', async () => {
    const uri = 'file:///args.qsps';
    const text = "# a\ngs 'show', {generic}\ngs 'run', {pl x}\n--- a ---\n# show\npl $args[0]\n--- show ---\n# run\ndynamic $args[0]\n--- run ---\n";
    h.client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: 'qsp', version: 1, text },
    });
    await h.diagnosticsFor(uri);
    const { data } = await h.client.sendRequest(SemanticTokensRequest.type, { textDocument: { uri } });
    const lines = text.split('\n');
    const tokens: Array<{ text: string; type: string }> = [];
    let line = 0, char = 0;
    for (let i = 0; i < data.length; i += 5) {
      line += data[i];
      char = data[i] === 0 ? char + data[i + 1] : data[i + 1];
      tokens.push({ text: lines[line].substr(char, data[i + 2]), type: TOKEN_TYPES[data[i + 3]] });
    }
    expect(tokens).toContainEqual({ text: '{generic}', type: 'string' });
    expect(tokens.some(t => t.text.includes('generic') && t.type !== 'string')).toBe(false);
    expect(tokens).toContainEqual({ text: 'x', type: 'variable' });
  }, 30_000);

  it('leaves a block nothing runs out of hover, definition, references, rename and highlights', async () => {
    const uri = 'file:///args-nav.qsps';
    // `generic` is a variable on lines 1–2; on line 3 it is the text `b` gets.
    const text = "# a\ngeneric = 1\npl generic\ngs 'b', {generic}\ngs 'c', {generic}\n--- a ---\n# b\npl $args[0]\n--- b ---\n# c\ndynamic $args[0]\n--- c ---\n";
    h.client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: 'qsp', version: 1, text },
    });
    await h.diagnosticsFor(uri);
    const textDocument = { uri };
    const onVariable = { line: 1, character: 2 };
    const inText = { line: 3, character: 11 };

    const refs = await h.client.sendRequest(ReferencesRequest.type, { textDocument, position: onVariable, context: { includeDeclaration: true } });
    // Line 4 passes `{generic}` to `c`, which runs it: code, so a reference.
    expect((refs ?? []).map(r => r.range.start.line).sort()).toEqual([1, 2, 4]);
    const rename = await h.client.sendRequest(RenameRequest.type, { textDocument, position: onVariable, newName: 'other' });
    expect(rename?.changes?.[uri]?.map(e => e.range.start.line).sort()).toEqual([1, 2, 4]);

    expect(await h.client.sendRequest(HoverRequest.type, { textDocument, position: inText })).toBeNull();
    expect(await h.client.sendRequest(DefinitionRequest.type, { textDocument, position: inText })).toBeNull();
    expect(await h.client.sendRequest(ReferencesRequest.type, { textDocument, position: inText, context: { includeDeclaration: true } })).toEqual([]);
    expect(await h.client.sendRequest(PrepareRenameRequest.type, { textDocument, position: inText })).toBeNull();
    expect(await h.client.sendRequest(RenameRequest.type, { textDocument, position: inText, newName: 'other' })).toBeNull();
    expect(await h.client.sendRequest(DocumentHighlightRequest.type, { textDocument, position: inText })).toBeNull();
  }, 30_000);
});

// A `{…}` kept in a variable is the text it holds: code only when
// something may run the variable.
describe('LSP e2e: blocks kept in variables', () => {
  let h: Harness;
  beforeAll(async () => { h = await startServer(); }, 30_000);
  afterAll(() => { h?.shutdown(); });

  it('highlights and navigates a block nothing runs as text, and one that runs as code', async () => {
    const uri = 'file:///stored.qsps';
    // `generic` is a variable on lines 1–2; line 3 keeps the text, line 4 code that runs.
    const text = "# a\ngeneric = 1\npl generic\n$args['t'] = {generic}\n$code = {pl generic}\ndynamic $code\n--- a ---\n";
    h.client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: 'qsp', version: 1, text },
    });
    await h.diagnosticsFor(uri);
    const { data } = await h.client.sendRequest(SemanticTokensRequest.type, { textDocument: { uri } });
    const lines = text.split('\n');
    const tokens: Array<{ line: number; text: string; type: string }> = [];
    let line = 0, char = 0;
    for (let i = 0; i < data.length; i += 5) {
      line += data[i];
      char = data[i] === 0 ? char + data[i + 1] : data[i + 1];
      tokens.push({ line, text: lines[line].substr(char, data[i + 2]), type: TOKEN_TYPES[data[i + 3]] });
    }
    expect(tokens).toContainEqual({ line: 3, text: '{generic}', type: 'string' });
    expect(tokens).toContainEqual({ line: 4, text: 'generic', type: 'variable' });

    const textDocument = { uri };
    const refs = await h.client.sendRequest(ReferencesRequest.type, { textDocument, position: { line: 1, character: 2 }, context: { includeDeclaration: true } });
    expect((refs ?? []).map(r => r.range.start.line).sort()).toEqual([1, 2, 4]);
    expect(await h.client.sendRequest(HoverRequest.type, { textDocument, position: { line: 3, character: 16 } })).toBeNull();
  }, 30_000);
});

describe('LSP e2e: highlighting after a closed file changes on disk', () => {
  let h: Harness;
  let dir: string;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-args-'));
    fs.writeFileSync(path.join(dir, 'main.qsps'), "# a\ngs 'b', {pl x}\n--- a ---\n");
    fs.writeFileSync(path.join(dir, 'b.qsps'), '# b\npl $args[0]\n--- b ---\n');
    h = await startServer(null, dir);
  });
  afterAll(() => { h.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('colours a block as code once the callee runs it', async () => {
    const uri = fsProvider.pathToUri(path.join(dir, 'main.qsps'));
    const text = fs.readFileSync(path.join(dir, 'main.qsps'), 'utf8');
    const ready = h.nextDiagnosticsFor(uri);
    h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text } });
    await ready;
    const typeOfX = async () => {
      const { data } = await h.client.sendRequest(SemanticTokensRequest.type, { textDocument: { uri } });
      for (let i = 0, line = 0, char = 0; i < data.length; i += 5) {
        line += data[i];
        char = data[i] === 0 ? char + data[i + 1] : data[i + 1];
        if (line === 1 && char <= 12 && 12 < char + data[i + 2]) return TOKEN_TYPES[data[i + 3]];
      }
      return undefined;
    };
    expect(await typeOfX()).toBe('string');

    const bPath = path.join(dir, 'b.qsps');
    fs.writeFileSync(bPath, '# b\ndynamic $args[0]\n--- b ---\n');
    const rediagnosed = h.nextDiagnosticsFor(fsProvider.pathToUri(bPath));
    h.client.sendNotification(DidChangeWatchedFilesNotification.type, { changes: [{ uri: fsProvider.pathToUri(bPath), type: FileChangeType.Changed }] });
    await rediagnosed;
    await h.client.sendRequest(SETTLED_REQUEST);
    expect(await typeOfX()).toBe('variable');
  }, 30_000);
});

describe('LSP e2e: a block kept in a variable after a closed file changes on disk', () => {
  let h: Harness;
  let dir: string;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-stored-'));
    fs.writeFileSync(path.join(dir, 'main.qsps'), '# a\n$k = {pl x}\n--- a ---\n');
    fs.writeFileSync(path.join(dir, 'b.qsps'), '# b\npl $k\n--- b ---\n');
    h = await startServer(null, dir);
  });
  afterAll(() => { h.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('colours the block as code once another file runs the variable', async () => {
    const uri = fsProvider.pathToUri(path.join(dir, 'main.qsps'));
    const text = fs.readFileSync(path.join(dir, 'main.qsps'), 'utf8');
    const ready = h.nextDiagnosticsFor(uri);
    h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text } });
    await ready;
    await h.client.sendRequest(SETTLED_REQUEST);
    const typeOfX = async () => {
      const { data } = await h.client.sendRequest(SemanticTokensRequest.type, { textDocument: { uri } });
      for (let i = 0, line = 0, char = 0; i < data.length; i += 5) {
        line += data[i];
        char = data[i] === 0 ? char + data[i + 1] : data[i + 1];
        if (line === 1 && char <= 9 && 9 < char + data[i + 2]) return TOKEN_TYPES[data[i + 3]];
      }
      return undefined;
    };
    expect(await typeOfX()).toBe('string');

    const bPath = path.join(dir, 'b.qsps');
    fs.writeFileSync(bPath, '# b\ndynamic $k\n--- b ---\n');
    const rediagnosed = h.nextDiagnosticsFor(fsProvider.pathToUri(bPath));
    h.client.sendNotification(DidChangeWatchedFilesNotification.type, { changes: [{ uri: fsProvider.pathToUri(bPath), type: FileChangeType.Changed }] });
    await rediagnosed;
    await h.client.sendRequest(SETTLED_REQUEST);
    expect(await typeOfX()).toBe('variable');
  }, 30_000);
});
