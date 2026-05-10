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
  ConfigurationRequest,
  DidOpenTextDocumentNotification,
  HoverRequest,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
  RegistrationRequest,
  type Hover,
  type InitializeParams,
  type PublishDiagnosticsParams,
} from 'vscode-languageserver-protocol';
import { createQspServer } from '../src/server/common';
import { WASM_PATH } from './testHelpers';

interface Harness {
  client: MessageConnection;
  diagnosticsFor: (uri: string) => Promise<PublishDiagnosticsParams>;
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
    // No fsProvider → project mode disabled, which is what we want
    // (the regression is in single-file/per-location mode).
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
  client.onNotification(PublishDiagnosticsNotification.type, (params) => {
    diagnosticBuckets.set(params.uri, params);
    const waiters = diagnosticWaiters.get(params.uri);
    if (waiters) {
      diagnosticWaiters.delete(params.uri);
      for (const w of waiters) w(params);
    }
  });

  client.listen();

  await client.sendRequest(InitializeRequest.type, {
    processId: process.pid,
    rootUri: null,
    capabilities: {},
    workspaceFolders: null,
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
    expect(md).toContain('**Possible values:**');
    expect(md).toContain('GATED_MARKER');
  }, 30_000);

  it('omits "**Possible values:**" when the setting is false', async () => {
    const md = await hoverFor({ hover: { possibleValues: false } });
    expect(md).not.toContain('**Possible values:**');
    expect(md).not.toContain('GATED_MARKER');
  }, 30_000);
});
