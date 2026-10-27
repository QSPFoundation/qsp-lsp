// ── QSP host for the MCP server ──────────────────────────────────────
//
// Runs the QSP language server in this process and talks to it over LSP,
// the way the editor does. MCP tools ask it questions (locations,
// references, diagnostics, rename edits) instead of re-implementing the
// analysis, so they answer exactly what the editor shows.
//
// The MCP process sees only the disk: before each tool call `sync()`
// compares file mtimes with what the server was last given and forwards
// the differences, so edits an agent makes with its own tools are seen.
// Documents are opened in the server only for the length of one tool call
// (`closeAll()`): an open document's edits are analyzed after a 500 ms
// debounce, while a closed file's change is analyzed right away.

import * as fs from 'fs';
import * as path from 'path';
import { PassThrough } from 'stream';
import { parse as parseJsonc } from 'jsonc-parser';
import { createConnection, TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import {
  ConfigurationRequest,
  DidChangeWatchedFilesNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  FileChangeType,
  InitializedNotification,
  InitializeRequest,
  PublishDiagnosticsNotification,
  RegistrationRequest,
  ShowMessageRequest,
  type Diagnostic,
  type FileEvent,
  type InitializeParams,
} from 'vscode-languageserver-protocol';
import { ANALYSIS_STATUS_NOTIFICATION, SETTLED_REQUEST, type AnalysisStatus } from '../common/analysisStatus';
import { createQspServer } from '../server/common';
import { decodeBuffer, fsProvider } from '../server/nodeHost';
import { nodeAnalysisCacheStore } from '../server/nodeCache';
import type { AnalysisWorkers } from '../server/serverUtils';
import { nodeMemory } from '../server/nodeRecorder';
import type { WasmDirProvider, WasmLoader } from '../parser';
import { QSP_FILE_EXTENSIONS } from '../server/serverUtils';

/** A source file as the server was last told about it. */
interface KnownFile {
  mtimeMs: number;
  size: number;
}

interface OpenDoc {
  text: string;
}

// How long to wait for the analysis a notification triggers. Generous: a
// multi-megabyte project can take seconds, and a missed diagnostics
// publish (nothing to report for a file) must not hang a tool call.
const ANALYSIS_TIMEOUT_MS = 15_000;

export class QspHost {
  readonly rootUri: string;
  private client!: MessageConnection;
  private readonly known = new Map<string, KnownFile>();
  private readonly open = new Map<string, OpenDoc>();
  private readonly diagnostics = new Map<string, Diagnostic[]>();
  private status: AnalysisStatus | undefined;
  private readonly statusWaiters: Array<() => void> = [];
  private readonly diagnosticWaiters = new Map<string, Array<() => void>>();
  private stop: (() => void) | undefined;
  /** The workspace's `.vscode/settings.json`, flattened keys as VS Code stores them. */
  readonly settings: Record<string, unknown>;
  private readonly cacheDir: string | undefined;

  constructor(
    readonly workspaceDir: string,
    private readonly wasm: { wasmLoader: WasmLoader; wasmDir?: WasmDirProvider },
    private readonly log: (message: string) => void = () => {},
    /** Directory of an analysis cache (src/server/nodeCache.ts); none when absent. */
    cacheDir?: string,
    /** The analyser's files (bundle, grammar), which salt every cache key. */
    private readonly analyserFiles: readonly string[] = [],
    /** Threads that analyse the project's files on start (src/server/nodeWorkers.ts). */
    private readonly workers?: AnalysisWorkers,
  ) {
    this.rootUri = URI.file(workspaceDir).toString();
    this.settings = readWorkspaceSettings(workspaceDir);
    // The editor's `qsp.cache.enabled` turns this server's cache off too.
    const cache = nestUnder(this.settings, 'qsp').cache as { enabled?: unknown } | undefined;
    this.cacheDir = cache?.enabled === false ? undefined : cacheDir;
  }

  /** Start the embedded server and wait until the project is analyzed. */
  async start(): Promise<void> {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const serverConn = createConnection(new StreamMessageReader(c2s), new StreamMessageWriter(s2c));
    createQspServer(serverConn, new TextDocuments(TextDocument), this.wasm.wasmLoader, this.wasm.wasmDir, fsProvider, {
      memory: nodeMemory,
      ...(this.cacheDir ? { analysisCache: nodeAnalysisCacheStore(this.analyserFiles) } : {}),
      ...(this.workers ? { analysisWorkers: this.workers } : {}),
    });

    const client = createMessageConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s));
    this.client = client;
    client.onRequest(RegistrationRequest.type, () => null);
    client.onRequest(ShowMessageRequest.type, (p) => { this.log(`[server] ${p.message}`); return null; });
    client.onRequest('workspace/semanticTokens/refresh', () => null);
    client.onRequest(ConfigurationRequest.type, (params) =>
      params.items.map(item => this.configurationSection(item.section)));
    client.onNotification('window/logMessage', (p: { message: string }) => this.log(p.message));
    client.onNotification(PublishDiagnosticsNotification.type, (p) => {
      this.diagnostics.set(p.uri, p.diagnostics);
      const waiters = this.diagnosticWaiters.get(p.uri);
      if (waiters) {
        this.diagnosticWaiters.delete(p.uri);
        for (const w of waiters) w();
      }
    });
    client.onNotification(ANALYSIS_STATUS_NOTIFICATION, (status: AnalysisStatus) => {
      this.status = status;
      for (const w of this.statusWaiters.splice(0)) w();
    });
    client.listen();
    this.stop = () => { client.dispose(); c2s.destroy(); s2c.destroy(); };

    await client.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri: this.rootUri,
      capabilities: {},
      workspaceFolders: [{ uri: this.rootUri, name: path.basename(this.workspaceDir) }],
      initializationOptions: this.cacheDir ? { cacheDir: this.cacheDir } : undefined,
    } as InitializeParams);
    client.sendNotification(InitializedNotification.type, {});

    // The server scans the workspace itself; remember what it will have read.
    for await (const file of this.scan()) this.known.set(file.path, file.stat);
    await this.waitForStatus(s => s.configured && (!s.project || s.project.state === 'ready') && s.busyUris.length === 0);
  }

  dispose(): void {
    this.stop?.();
    this.stop = undefined;
  }

  /** The LSP connection to the embedded server, for requests the tools make. */
  get lsp(): MessageConnection {
    return this.client;
  }

  // ── Workspace paths ──────────────────────────────────────────────

  /** Absolute path for a workspace-relative one; refuses paths outside the workspace. */
  resolve(relPath: string): string {
    const abs = path.resolve(this.workspaceDir, relPath);
    const rel = path.relative(this.workspaceDir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`"${relPath}" is outside the workspace`);
    }
    return abs;
  }

  relative(uri: string): string {
    return path.relative(this.workspaceDir, URI.parse(uri).fsPath).split(path.sep).join('/');
  }

  uriOf(absPath: string): string {
    return URI.file(absPath).toString();
  }

  // ── Keeping the server in step with the disk ─────────────────────

  /**
   * Forward files created, changed or deleted on disk since the last call,
   * then wait for their analysis. Cheap when nothing changed: one directory
   * walk and a stat per source file.
   */
  async sync(): Promise<void> {
    await this.closeAll();
    const seen = new Set<string>();
    const changes: FileEvent[] = [];
    for await (const { path: file, stat } of this.scan()) {
      seen.add(file);
      const before = this.known.get(file);
      if (before && before.mtimeMs === stat.mtimeMs && before.size === stat.size) continue;
      this.known.set(file, stat);
      changes.push({ uri: this.uriOf(file), type: before ? FileChangeType.Changed : FileChangeType.Created });
    }
    for (const file of [...this.known.keys()]) {
      if (seen.has(file)) continue;
      this.known.delete(file);
      changes.push({ uri: this.uriOf(file), type: FileChangeType.Deleted });
    }
    if (changes.length === 0) return;
    this.log(`[sync] ${changes.length} file(s) changed on disk`);

    // The whole batch is re-analyzed once, and every project file's
    // diagnostics are published again, the last of them after the rebuild.
    const analyzed = changes.filter(e => e.type !== FileChangeType.Deleted).map(e => this.nextDiagnostics(e.uri));
    this.client.sendNotification(DidChangeWatchedFilesNotification.type, { changes });
    await Promise.all(analyzed);
    await this.settled();
  }

  /**
   * Close every document opened during a tool call. The server then drops
   * the document and re-reads the file from disk; until that analysis is
   * published the file would be missing from the project, so wait for it.
   */
  async closeAll(): Promise<void> {
    if (this.open.size === 0) return;
    const analyzed = [...this.open.keys()].map(uri => this.nextDiagnostics(uri));
    for (const uri of this.open.keys()) {
      this.client.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
    }
    this.open.clear();
    await Promise.all(analyzed);
    await this.settled();
  }

  /**
   * Open a file in the server, as the editor would. Position-based requests
   * (definition, references, rename, formatting) need an open document.
   */
  async ensureOpen(uri: string): Promise<string> {
    const doc = this.open.get(uri);
    if (doc) return doc.text;
    const text = this.readText(URI.parse(uri).fsPath);
    this.open.set(uri, { text });
    const analyzed = this.nextDiagnostics(uri);
    this.client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: 'qsp', version: 1, text },
    });
    await analyzed;
    await this.settled();
    return text;
  }

  /**
   * Whether `absPath` is still what the server last analyzed. Edits are
   * computed from that analysis, so writing them over a newer file would
   * clobber whatever changed it.
   */
  isUnchangedSinceSync(absPath: string): boolean {
    const known = this.known.get(absPath);
    if (!known) return false;
    try {
      const st = fs.statSync(absPath);
      return st.mtimeMs === known.mtimeMs && st.size === known.size;
    } catch {
      return false;
    }
  }

  /** Text of a source file as the server sees it (decoded, BOM stripped). */
  readText(absPath: string): string {
    return decodeBuffer(fs.readFileSync(absPath), String(this.settings['files.encoding'] ?? 'utf8'));
  }

  /**
   * Analyze `text` as a document that doesn't exist on disk and return its
   * diagnostics. The document is closed again afterwards.
   */
  async checkText(text: string): Promise<Diagnostic[]> {
    const uri = `untitled:qsp-check-${Date.now()}-${Math.random().toString(36).slice(2)}.qsps`;
    const analyzed = this.nextDiagnostics(uri);
    this.client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: 'qsp', version: 1, text },
    });
    await analyzed;
    const result = this.diagnostics.get(uri) ?? [];
    this.client.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
    this.diagnostics.delete(uri);
    return result;
  }

  /** Last published diagnostics, by URI. */
  allDiagnostics(): ReadonlyMap<string, Diagnostic[]> {
    return this.diagnostics;
  }

  // ── Internals ────────────────────────────────────────────────────

  private async *scan(): AsyncGenerator<{ path: string; stat: KnownFile }> {
    for await (const file of fsProvider.findFiles(this.workspaceDir, QSP_FILE_EXTENSIONS)) {
      try {
        const st = await fs.promises.stat(file);
        yield { path: file, stat: { mtimeMs: st.mtimeMs, size: st.size } };
      } catch {
        // Deleted between the directory walk and the stat.
      }
    }
  }

  // The changed files' diagnostics come first; the other files' are sent
  // in slices after them.
  private async settled(): Promise<void> {
    await this.client.sendRequest(SETTLED_REQUEST);
  }

  private nextDiagnostics(uri: string): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ANALYSIS_TIMEOUT_MS);
      const list = this.diagnosticWaiters.get(uri) ?? [];
      list.push(() => { clearTimeout(timer); resolve(); });
      this.diagnosticWaiters.set(uri, list);
    });
  }

  private async waitForStatus(ready: (s: AnalysisStatus) => boolean): Promise<void> {
    const deadline = Date.now() + ANALYSIS_TIMEOUT_MS * 4;
    while (!(this.status && ready(this.status))) {
      if (Date.now() > deadline) throw new Error('The QSP analysis did not finish in time');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        this.statusWaiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  private configurationSection(section: string | undefined): unknown {
    if (section === 'files') return { encoding: this.settings['files.encoding'] ?? 'utf8' };
    if (section !== 'qsp') return null;
    const qsp = nestUnder(this.settings, 'qsp');
    // Tools answer questions about the whole workspace, which only project
    // mode can: a workspace that turned it off for the editor still gets it here.
    qsp.project = { ...(qsp.project as object | undefined), enabled: true };
    return qsp;
  }
}

/**
 * Read `.vscode/settings.json` (JSON with comments). Missing or unreadable
 * settings are not an error: the defaults apply, as in a fresh workspace.
 */
export function readWorkspaceSettings(workspaceDir: string): Record<string, unknown> {
  try {
    const text = fs.readFileSync(path.join(workspaceDir, '.vscode', 'settings.json'), 'utf8');
    const value: unknown = parseJsonc(text);
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

// VS Code stores settings as flat dotted keys (`"qsp.project.enabled": true`)
// but also accepts nested objects; getConfiguration('qsp') returns them nested.
function nestUnder(settings: Record<string, unknown>, section: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const nested = settings[section];
  if (nested && typeof nested === 'object') Object.assign(result, nested);
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith(section + '.')) continue;
    const parts = key.slice(section.length + 1).split('.');
    let node = result;
    for (const part of parts.slice(0, -1)) {
      if (!node[part] || typeof node[part] !== 'object') node[part] = {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = value;
  }
  return result;
}
