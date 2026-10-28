/**
 * Shared utility functions for the QSP language server.
 *
 * These are pure helpers that operate on text and AST data,
 * independent of the LSP connection lifecycle or document state.
 */


import type { Connection } from 'vscode-languageserver';
import { ConnectionError, ConnectionErrors } from 'vscode-jsonrpc';
import { shiftError, type LocationEntry, type SyntaxError, type SymbolLocation } from '../parser';
import { locationNameCol } from './regexFallback';
import type { DocumentState } from './featureTypes';

/**
 * File-system provider for project mode.
 * Only available in the Node.js server — browser has no direct FS access.
 *
 * `readFile` and `findFiles` are async and `findFiles` is an async
 * iterable (rather than `string[]`/`Promise<string[]>`) specifically so
 * that project-mode workspace scans (potentially thousands of files) can
 * be awaited one file at a time. That lets the Node.js event loop
 * interleave other pending LSP requests between files instead of the
 * whole scan running as one uninterrupted synchronous block — see
 * ProjectModeService.init()/handleWatchedFileChanges().
 */
export interface FsProvider {
  /** Read a file as text, decoded according to the given encoding. */
  readFile(filePath: string, encoding?: string): Promise<string>;
  /** Enumerate all files matching the given extensions in a directory
   *  (recursive), skipping common non-project directories. */
  findFiles(dir: string, extensions: string[]): AsyncIterable<string>;
  /** Convert a file path to a URI string. */
  pathToUri(filePath: string): string;
  /** Convert a URI string to a file path. */
  uriToPath(uri: string): string;
}

/**
 * Analysis results kept on disk between runs, so a project that hasn't
 * changed opens without being analysed again. Keys are content hashes of
 * everything a result depends on, so a stale entry is never found. Node
 * only (nodeCache.ts); the browser and the MCP server run without it.
 */
export interface AnalysisCache {
  /** A key for a result that depends on exactly these parts (hex SHA-256). */
  key(...parts: string[]): string;
  /** The value stored under `key`, or undefined when there is none or it can't be read. */
  get(key: string): unknown;
  /** Store `value` (plain data: objects, arrays, Maps, Sets, typed arrays; no cycles) in the background. */
  put(key: string, value: unknown): void;
  /**
   * Store what `AnalysisWorkers` serialized, without serializing it again:
   * one part is read back as its value, several as the array of their values.
   */
  putSerialized?(key: string, parts: readonly Uint8Array[]): void;
  /** Whether there is a value under `key`, without reading it. */
  has?(key: string): boolean;
}

/**
 * Threads that analyse project files while the main thread answers requests
 * (Node only: nodeWorkers.ts). A file's analysis comes back serialized, as
 * `bytes` for `AnalysisCache.putSerialized`; `read` makes it the value the
 * cache keeps (`CachedFileAnalysis`, before `reviveDocumentSymbols`) on the
 * main thread, which costs a small part of the analysis (0.4 s of 26 s for
 * a 12.8 M-character file).
 */
export interface AnalysisWorkers {
  /** How many files, or parts of one, are analysed at once. */
  readonly size: number;
  /**
   * Rejects when no thread could analyse the file; the caller does it then.
   * With `locations`, only the locations `from` to `to` (exclusive) of its
   * location index, in the file's coordinates, for the caller to join.
   */
  analyze(uri: string, text: string, embeddedExec: boolean, locations?: { from: number; to: number }): Promise<{ bytes: Uint8Array; read: () => unknown }>;
  /** Stop the threads; `analyze` starts them again. Idle ones stop by themselves. */
  dispose(): void;
}

/** Opens the analysis cache in a directory the client chose. */
export interface AnalysisCacheStore {
  /** Throws when the directory can't be used; `warn` gets problems worth a log line. */
  open(dir: string, warn: (message: string) => void): AnalysisCache;
}

/**
 * File extensions recognised as QSP source files.
 * Must stay in sync with contributes.languages[].extensions in package.json.
 */
export const QSP_FILE_EXTENSIONS = ['.qsps', '.qsrc'];

/** Strip a UTF-8 BOM (U+FEFF) from the start of a string if present. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

/** Shift local-coordinate errors to absolute coordinates. */
export function shiftErrors(errors: SyntaxError[], lineOffset: number, out: SyntaxError[]): void {
  for (const err of errors) {
    out.push(shiftError(err, lineOffset));
  }
}

/**
 * Compute a `perLocationCache` key for every entry of a `LocationEntry[]`,
 * in source order, keyed by lowercase name plus an occurrence counter.
 *
 * `perLocationCache` (used by common.ts's `analyzeDocumentPerLocation`,
 * `tryIncrementalPerLocationUpdate`, and `buildTokensFromCache`, and read
 * directly by hover/document-highlight in lspFeatures.ts) can't be keyed
 * by plain `loc.nameLower`: a file with a duplicate location name — an
 * error the user will see reported, but one they may be mid-typing when
 * this runs — would collapse onto the same cache slot.
 * `currentIndex.length !== prevCache.size` would then hold forever, so
 * `tryIncrementalPerLocationUpdate` never succeeds again for that file
 * (every keystroke pays for a full per-location re-analysis instead of
 * an O(1)-location incremental one); the full-analysis path silently
 * overwrites one duplicate's cache entry with the other's, leaking the
 * discarded entry's retained tree-sitter tree if it had one; and
 * semantic tokens / hover / document-highlight for every duplicate past
 * the first silently get nothing (a lookup by plain name only ever
 * finds whichever one happens to be stored under it).
 *
 * The occurrence counter gives each duplicate a distinct, and — as long
 * as their relative order doesn't change — *stable* key, so both the
 * `.size` comparison and normal cache reuse work exactly as they did for
 * non-duplicate names. Lives here (rather than in common.ts, which
 * imports lspFeatures.ts) so both common.ts and lspFeatures.ts can use
 * it without a circular import.
 */
export function perLocationCacheKeys(locationIndex: readonly LocationEntry[]): string[] {
  const occurrenceOf = new Map<string, number>();
  return locationIndex.map((loc) => {
    const n = occurrenceOf.get(loc.nameLower) ?? 0;
    occurrenceOf.set(loc.nameLower, n + 1);
    return n === 0 ? loc.nameLower : `${loc.nameLower}\u0000${n}`;
  });
}

/**
 * Free the trees large locations keep for incremental edits when they
 * haven't been used for `idleMs`: a 200 KB location's tree takes megabytes
 * of WASM memory, and an edit after a long pause pays one location parse.
 * Returns how many were dropped.
 */
export function dropIdleTrees(states: Iterable<DocumentState>, now: number, idleMs: number): number {
  let dropped = 0;
  for (const state of states) {
    if (!state.perLocationCache) continue;
    for (const entry of state.perLocationCache.values()) {
      if (!entry.tree || now - (entry.treeUsedAt ?? 0) < idleMs) continue;
      entry.tree.delete();
      entry.tree = undefined;
      entry.treeUsedAt = undefined;
      dropped++;
    }
  }
  return dropped;
}

/** Build the `SymbolLocation` for a location header, used by both the
 *  full-tree and per-location analysis paths. */
export function makeLocSymLoc(uri: string, text: string, loc: LocationEntry): SymbolLocation {
  const nameCol = locationNameCol(text, loc);
  return {
    uri,
    line: loc.startLine,
    column: nameCol,
    endLine: loc.startLine,
    endColumn: nameCol + loc.name.length,
  };
}

/**
 * Wrapper around `connection.sendDiagnostics` that silently ignores
 * `ConnectionErrors.Closed` and `ConnectionErrors.Disposed` errors.
 * These occur when a debounced timer fires after the LSP connection has
 * been torn down (e.g. at test teardown), and they are harmless.
 *
 * Unlike `connection.console.*` (which vscode-languageserver already
 * `.catch`es internally), `sendDiagnostics` returns the underlying
 * `sendNotification` promise uncaught — if the transport write itself
 * fails (the stream closes between the synchronous not-closed check and
 * the write completing), that becomes an unhandled rejection unless we
 * catch it here too.
 */
export function safeSendDiagnostics(
  connection: Connection,
  params: Parameters<Connection['sendDiagnostics']>[0],
): void {
  safeConnectionCall(() => connection.sendDiagnostics(params));
}

/**
 * Wrapper around arbitrary connection calls that silently ignores
 * `ConnectionErrors.Closed` and `ConnectionErrors.Disposed` errors
 * for the same reason as safeSendDiagnostics.
 *
 * `fn` may return a Promise (e.g. `client.register(...)`,
 * `semanticTokens.refresh()`) — that promise is awaited internally so a
 * rejection can't become an unhandled rejection and crash the process.
 * Any rejection other than Closed/Disposed is logged via `console.error`
 * (not `connection.console.error`: the connection may be the very thing
 * that's failing).
 */
export function safeConnectionCall(fn: () => void | Promise<unknown>): void {
  try {
    const result = fn();
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch((err: unknown) => {
        if (err instanceof ConnectionError && (err.code === ConnectionErrors.Closed || err.code === ConnectionErrors.Disposed)) return;
        console.error('[QSP] Unhandled connection call rejection:', err);
      });
    }
  } catch (err) {
    if (err instanceof ConnectionError && (err.code === ConnectionErrors.Closed || err.code === ConnectionErrors.Disposed)) return;
    throw err;
  }
}

/**
 * `connection.console.*` throws synchronously (not a rejected promise) once
 * the connection is closed or disposed — a debounced analysis timer that
 * fires during test teardown, or after a client disconnects, would crash
 * the process on its next log line otherwise. Wraps every method with
 * `safeConnectionCall` so logging after teardown is silently dropped.
 */
export function safeConsole(connection: Connection): Pick<Connection['console'], 'error' | 'warn' | 'info' | 'log'> {
  return {
    error: (m: string) => safeConnectionCall(() => connection.console.error(m)),
    warn: (m: string) => safeConnectionCall(() => connection.console.warn(m)),
    info: (m: string) => safeConnectionCall(() => connection.console.info(m)),
    log: (m: string) => safeConnectionCall(() => connection.console.log(m)),
  };
}
