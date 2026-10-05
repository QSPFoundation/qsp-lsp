import {
  CancellationToken,
  CodeActionKind,
  Connection,
  DidChangeWatchedFilesNotification,
  InitializeParams,
  InitializeResult,
  DidChangeConfigurationNotification,
  TextDocumentSyncKind,
  TextDocuments,
  SemanticTokensBuilder,
  type Diagnostic,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  buildLocationIndex,
  findLocationAtLine,
  DocumentSymbols,
  LocationSymbols,
  LocationEntry,
  QspTreeSitterParser,
  computeTreeEdit,
  shiftError,
  type SymbolLocation,
  type SyntaxError,
  type WasmLoader,
} from '../parser';
import { collectSemanticTokenTuples, SEMANTIC_TOKENS_LEGEND, GOTO_MODIFIER_BIT, NAMESPACE_TOKEN_TYPE, STRING_TOKEN_TYPE } from './semanticTokens';
import {
  buildRegexSymbols,
  extractLocationSymbolsFromText,
} from './regexFallback';
import { fileAggregatesSteps, collectCallTypesPerTarget as collectCallTypesPerTargetFromSymbols } from './aggregation';
import { diagnosticsSteps, type DiagnosticSettings } from './diagnostics';
import { registerLspFeatures, type DocumentState, type PerLocationParseResult } from './lspFeatures';
import type { TokenFacts } from './featureTypes';
import { stripBom, shiftErrors, dropIdleTrees, makeLocSymLoc, perLocationCacheKeys, safeSendDiagnostics, safeConnectionCall, safeConsole, QSP_FILE_EXTENSIONS, type FsProvider } from './serverUtils';
import { ProjectModeService, type RebuildOptions } from './projectMode';
import { runInSlices, type Steps } from './slices';
import { analyzeParsedLocation, collectFoldLines } from './locationAnalysis';
import { AnalysisStatusReporter } from './analysisStatus';
import { ANALYSIS_STATUS_MIN_BYTES, SETTLED_REQUEST } from '../common/analysisStatus';
import { libraryFolderPrefixes } from '../common/libraryConfig';
import { parseSuppressions } from '../common/suppressions';
import { PerfLog, formatChars, type ServerHost } from './perfLog';
import { buildPerformanceReport } from './performanceReport';
import { Pseudonyms } from './pseudonyms';
import { MemoryGuard } from './memoryGuard';
import { anonymizeCode } from '../parser/anonymize';

// Re-export FsProvider for backward compatibility.
export type { FsProvider } from './serverUtils';

/**
 * Aggregate call types per target location across all document states.
 *
 * Per-document results are cached on the DocumentState (invalidated when
 * the state object is replaced after analysis).  This avoids re-walking
 * every location and locationRef of every open document on every
 * keystroke (the dominant cost on huge files).
 */
function collectCallTypesPerTarget(
  documentStates: Map<string, DocumentState>,
): Map<string, { name: string; types: Set<string> }> {
  // Fast path: only one open document.
  if (documentStates.size === 1) {
    for (const [, ds] of documentStates) {
      if (!ds.cachedCallTypes) {
        ds.cachedCallTypes = collectCallTypesPerTargetFromSymbols([ds.symbols]);
      }
      return ds.cachedCallTypes;
    }
  }
  // Multi-document: merge per-document caches.  Each per-doc map is
  // tiny (only targets called from THAT doc), so merging is cheap.
  const merged = new Map<string, { name: string; types: Set<string> }>();
  for (const [, ds] of documentStates) {
    if (!ds.cachedCallTypes) {
      ds.cachedCallTypes = collectCallTypesPerTargetFromSymbols([ds.symbols]);
    }
    for (const [key, entry] of ds.cachedCallTypes) {
      let m = merged.get(key);
      if (!m) {
        m = { name: entry.name, types: new Set(entry.types) };
        merged.set(key, m);
      } else {
        for (const t of entry.types) m.types.add(t);
      }
    }
  }
  return merged;
}

/**
 * Collect every other document's `DocumentSymbols` for project-wide
 * resolver queries (uninitialized variables, mixed prefixes).  Empty
 * in single-file mode and when only the active document exists.
 */
function collectPeerDocs(
  documentStates: Map<string, DocumentState>,
  ownUri: string,
): DocumentSymbols[] {
  const out: DocumentSymbols[] = [];
  for (const [uri, ds] of documentStates) {
    if (uri === ownUri) continue;
    out.push(ds.symbols);
  }
  return out;
}

/** Build merged semantic tokens from per-location caches; `tokensOf` makes those a location lacks. */
function buildTokensFromCache(
  locationIndex: LocationEntry[],
  cache: Map<string, PerLocationParseResult>,
  tokensOf: (entry: PerLocationParseResult) => Uint32Array,
  project?: TokenFacts,
  lines?: { start: number; end: number },
) {
  const builder = new SemanticTokensBuilder();
  // Same key scheme as perLocationCache's writers (analyzeDocumentPerLocation /
  // tryIncrementalPerLocationUpdate) — see perLocationCacheKeys' doc comment.
  // Plain `loc.nameLower` would only ever hit the FIRST of two same-named
  // locations' cache entries, leaving every duplicate after it with no
  // semantic tokens at all.
  const cacheKeys = perLocationCacheKeys(locationIndex);
  for (const [i, loc] of locationIndex.entries()) {
    if (lines && (loc.endLine < lines.start || loc.startLine > lines.end)) continue;
    const cached = cache.get(cacheKeys[i]);
    if (!cached) continue;
    const textBlocks = project?.textBlocksOf(cached) ?? [];
    const tuples = textBlocks.length > 0 ? asText(tokensOf(cached), textBlocks, cached) : tokensOf(cached);
    const isGoto = project?.gotoTargets.has(loc.nameLower) ?? false;
    for (let j = 0; j < tuples.length; j += 5) {
      let mod = tuples[j + 4];
      // Patch the location_name token (first namespace token at line 0)
      if (isGoto && tuples[j] === 0 && tuples[j + 3] === NAMESPACE_TOKEN_TYPE) {
        mod |= GOTO_MODIFIER_BIT;
      }
      builder.push(
        tuples[j] + loc.startLine,
        tuples[j + 1],
        tuples[j + 2],
        tuples[j + 3],
        mod,
      );
    }
  }
  return builder.build();
}

// A location's tokens with `blocks` (where its symbols put them) as
// strings: whatever their words look like, they are text.
function asText(tuples: Uint32Array, blocks: readonly SymbolLocation[], entry: PerLocationParseResult): Uint32Array {
  const local = blocks.map(b => ({ ...b, line: b.line - entry.symbolsLine, endLine: b.endLine - entry.symbolsLine }));
  const inside = (line: number, col: number) => local.some(b =>
    (line > b.line || (line === b.line && col >= b.column)) && (line < b.endLine || (line === b.endLine && col < b.endColumn)));
  const out: number[][] = [];
  for (let j = 0; j < tuples.length; j += 5) {
    if (!inside(tuples[j], tuples[j + 1])) out.push([tuples[j], tuples[j + 1], tuples[j + 2], tuples[j + 3], tuples[j + 4]]);
  }
  const lines = entry.text.split('\n');
  for (const b of local) {
    for (let line = b.line; line <= b.endLine; line++) {
      const from = line === b.line ? b.column : 0;
      const to = line === b.endLine ? b.endColumn : (lines[line] ?? '').replace(/\r$/, '').length;
      if (to > from) out.push([line, from, to - from, STRING_TOKEN_TYPE, 0]);
    }
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return Uint32Array.from(out.flat());
}

/** Fold ranges of the blocks in per-location caches; `foldsOf` makes those a location lacks. */
function buildFoldsFromCache(
  locationIndex: LocationEntry[],
  cache: Map<string, PerLocationParseResult>,
  foldsOf: (entry: PerLocationParseResult) => Uint32Array,
): Array<{ startLine: number; endLine: number }> {
  const ranges: Array<{ startLine: number; endLine: number }> = [];
  const cacheKeys = perLocationCacheKeys(locationIndex);
  for (const [i, loc] of locationIndex.entries()) {
    const cached = cache.get(cacheKeys[i]);
    if (!cached) continue;
    const lines = foldsOf(cached);
    for (let j = 0; j < lines.length; j += 2) {
      ranges.push({ startLine: lines[j] + loc.startLine, endLine: lines[j + 1] + loc.startLine });
    }
  }
  return ranges;
}

/**
 * Create and configure the QSP language server on a given connection.
 * @param wasmLoader Optional callback that provides the tree-sitter-qsp WASM.
 *   If omitted, the server runs in "lite" mode with regex-only analysis.
 * @param fsProvider Optional file-system provider for project mode (Node.js only).
 */
export function createQspServer(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  wasmLoader?: WasmLoader,
  wasmDir?: () => string,
  fsProvider?: FsProvider,
  host: ServerHost = {},
): void {
  // A debounced timer can fire after the connection is closed/disposed (test
  // teardown, client disconnect) — connection.console.* throws synchronously
  // in that case, so every log call in this module goes through this wrapper.
  const log = safeConsole(connection);
  const status = new AnalysisStatusReporter(connection);
  const perf = new PerfLog((line) => log.log(line), host.memory);
  const memoryGuard = new MemoryGuard(host.memory, (heapUsed, heapLimit) => {
    const heapMB = Math.round(heapUsed / 1048576), limitMB = Math.round(heapLimit / 1048576);
    log.warn(`[QSP] Heap at ${heapMB} of ${limitMB} MB: switching to reduced analysis until the server restarts`);
    status.setReduced({ heapMB, limitMB });
  });
  const tightOnMemory = () => memoryGuard.tight();
  const startedAt = Date.now();
  // The file analysis running right now, for reports written mid-analysis
  // (a run that crashes never finishes it).
  let analysisInProgress: { uri: string; locationIndex: readonly LocationEntry[]; parsedLocations: number } | undefined;
  // Neutral names for files and locations in reports and breadcrumbs.
  const pseudonyms = new Pseudonyms();
  let savedPseudonyms = -1;
  let workspaceFolderUris: string[] = [];
  // While the project loads, an open file's own aggregates and diagnostics
  // would be thrown away seconds later, when the project load diagnoses
  // every file with project-wide ones: for a large game that is the
  // longest step of its analysis done twice, and its memory held twice.
  // The files skipped meanwhile are here, for when no project comes.
  let projectLoadPending = false;
  const deferredDiagnostics = new Set<string>();
  const documentStates = new Map<string, DocumentState>();
  const tsParser = new QspTreeSitterParser();
  // Surface non-timeout parse failures (e.g. a WASM runtime error) in the
  // server log instead of letting them pass as silent timeouts.
  tsParser.setErrorReporter((message) => log.error(message));

  /**
   * Invalidate every open document's cached semantic tokens, then ask
   * the client to re-request them.
   *
   * A document's GOTO_MODIFIER_BIT / NAMESPACE_TOKEN_TYPE styling (see
   * semanticTokens.ts) depends on `collectCallTypesPerTarget`, which
   * merges call types across EVERY open document — not just the one
   * that just changed (see that function's doc comment). Without
   * clearing every document's `cachedSemanticTokens` here, editing
   * document B to add/remove a `gt`-style call targeting a location
   * defined in document A would leave A's cached tokens (and its
   * goto-highlighting) stale until A itself is next edited, even
   * though the client was told to refresh: our own per-document cache,
   * not the client's, would serve the stale result.
   */
  function refreshSemanticTokens(): void {
    for (const [, state] of documentStates) {
      state.cachedSemanticTokens = undefined;
    }
    safeConnectionCall(() => connection.languages.semanticTokens.refresh());
  }

  // ── User settings ──────────────────────────────────────────────────
  // QspSettings is the full configuration shape; the diagnostics half
  // is owned by ./diagnostics so adding a flag in one place compiles
  // everywhere it's used.
  interface QspSettings {
    project: { enabled: boolean };
    embeddedExec: { enabled: boolean };
    diagnostics: DiagnosticSettings;
    semanticHighlighting: { enabled: boolean };
    hover: { possibleValues: boolean; maxItemsPerCategory: number };
    debug: { performanceLog: boolean };
  }

  const defaultSettings: QspSettings = {
    project: { enabled: true },
    embeddedExec: { enabled: true },
    diagnostics: {
      duplicateLocations: true,
      duplicateLabels: true,
      duplicateActions: true,
      unreachableLabels: true,
      unclosedLocations: true,
      uninitializedVariables: true,
      unresolvedLocationRefs: true,
      unresolvedLabelRefs: true,
      unresolvedActionRefs: true,
      unresolvedObjectRefs: true,
      unusedLocations: true,
      unusedLabels: true,
      unusedVariables: true,
      unusedObjects: true,
      invalidFunctionPrefix: true,
      invalidBuiltinArgCount: true,
      deprecatedBuiltins: true,
      mixedVariablePrefixes: true,
      typeMismatch: true,
      mixedLocationCallTypes: true,
      inconsistentLocalPropagation: true,
      untrackedDynamicCalls: true,
      missingResultInFunctionCall: true,
      extraArgsToTargetWithoutArgs: true,
      shadowsCallFrameBuiltin: true,
      shadowsPropagatedLocal: true,
      maxErrorsPerLocation: 20,
      maxLocationLines: 500,
      maxPerFile: 5000,
    },
    semanticHighlighting: { enabled: true },
    hover: { possibleValues: true, maxItemsPerCategory: 20 },
    debug: { performanceLog: false },
  };
  let settings: QspSettings = defaultSettings;

  /**
   * Build QspSettings from raw VS Code configuration, falling back to
   * defaultSettings for any field with the wrong type or missing.
   * Driven by the keys of defaultSettings, so adding a diagnostic flag
   * to DiagnosticSettings + defaultSettings is the only change needed.
   */
  function parseSettingsFromConfig(qspConfig: Record<string, unknown> | undefined): QspSettings {
    const d = qspConfig?.diagnostics as Record<string, unknown> | undefined;
    const proj = qspConfig?.project as Record<string, unknown> | undefined;
    const emb = qspConfig?.embeddedExec as Record<string, unknown> | undefined;
    const sem = qspConfig?.semanticHighlighting as Record<string, unknown> | undefined;
    const hov = qspConfig?.hover as Record<string, unknown> | undefined;
    const dbg = qspConfig?.debug as Record<string, unknown> | undefined;
    const pick = <T>(v: unknown, def: T): T => typeof v === typeof def ? v as T : def;
    // settings.json isn't checked against package.json's `minimum`, so NaN,
    // fractions and negatives can arrive here.
    const pickInt = (v: unknown, def: number, min: number): number =>
      typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.floor(v) : def;

    const dd = defaultSettings.diagnostics;
    const diagnostics = { ...dd } as Record<string, unknown>;
    for (const key of Object.keys(dd) as (keyof DiagnosticSettings)[]) {
      diagnostics[key] = pick(d?.[key], dd[key]);
    }
    diagnostics.maxErrorsPerLocation = pickInt(d?.maxErrorsPerLocation, dd.maxErrorsPerLocation, 1);
    diagnostics.maxLocationLines = pickInt(d?.maxLocationLines, dd.maxLocationLines, 0);
    diagnostics.maxPerFile = pickInt(d?.maxPerFile, dd.maxPerFile, 0);
    diagnostics.libraryFolders = libraryFolderPrefixes(workspaceFolderUris);
    return {
      project: { enabled: pick(proj?.enabled, defaultSettings.project.enabled) },
      embeddedExec: { enabled: pick(emb?.enabled, defaultSettings.embeddedExec.enabled) },
      diagnostics: diagnostics as unknown as DiagnosticSettings,
      semanticHighlighting: { enabled: pick(sem?.enabled, defaultSettings.semanticHighlighting.enabled) },
      hover: {
        possibleValues: pick(hov?.possibleValues, defaultSettings.hover.possibleValues),
        maxItemsPerCategory: pickInt(hov?.maxItemsPerCategory, defaultSettings.hover.maxItemsPerCategory, 1),
      },
      debug: { performanceLog: pick(dbg?.performanceLog, defaultSettings.debug.performanceLog) },
    };
  }

  /** VS Code's files.encoding setting — used when reading non-open project files. */
  let fileEncoding = 'utf8';

  connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
    // The client passes a directory for the crash recorder
    // (src/client/crashReports.ts). Start before anything is parsed: the
    // initial load is where large games crash.
    workspaceFolderUris = params.workspaceFolders?.map(f => f.uri) ?? [];
    // Until the client's configuration arrives (parseSettingsFromConfig sets it too).
    settings = { ...settings, diagnostics: { ...settings.diagnostics, libraryFolders: libraryFolderPrefixes(workspaceFolderUris) } };
    // The client passes a per-workspace directory when qsp.cache.enabled is on.
    const cacheDir = (params.initializationOptions as { cacheDir?: unknown } | undefined)?.cacheDir;
    if (typeof cacheDir === 'string' && host.analysisCache) {
      try {
        project.analysisCache = host.analysisCache.open(cacheDir, (message) => log.warn(message));
      } catch (err) {
        log.warn(`[QSP] Analysis cache unavailable, analysing from scratch: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const crashDir = (params.initializationOptions as { crashDir?: unknown } | undefined)?.crashDir;
    if (typeof crashDir === 'string' && host.recorder) {
      const recorder = host.recorder;
      try {
        recorder.start(crashDir);
        perf.tracker = recorder;
        // The report needs the analysis state, so the main thread writes
        // it whenever the analysis passes a heartbeat; the recorder's own
        // thread writes the memory, heap and breadcrumb files.
        let lastReport = 0;
        perf.onHeartbeat(() => {
          if (Date.now() - lastReport < 30_000) return;
          lastReport = Date.now();
          recorder.writeJson('report', buildReport());
          savePseudonyms();
        });
        savePseudonyms();
      } catch (e) {
        log.error(`[QSP] Could not start the crash recorder: ${e}`);
      }
    }

    // Capture workspace folders for project mode. Only populated when a
    // filesystem provider is available (i.e. Node.js server, not browser)
    // — project mode is a no-op otherwise.
    if (fsProvider && params.workspaceFolders) {
      project.workspaceFolders = params.workspaceFolders.map(f => fsProvider.uriToPath(f.uri));
      // Project mode is on by default; the settings come later.
      projectLoadPending = params.workspaceFolders.length > 0;
      log.log(`[QSP] Workspace folders: ${project.workspaceFolders.join(', ')}`);
    }

    // Initialize tree-sitter in the background (non-blocking)
    if (wasmLoader) {
      try {
        await tsParser.init(wasmLoader, wasmDir);
        log.log('[QSP] Tree-sitter parser initialized');
        status.setParser('full');

        // Re-analyze all open documents now that tree-sitter is ready
        for (const doc of documents.all()) {
          analyzeDocument(doc);
        }
      } catch (e) {
        log.error(`[QSP] Tree-sitter init failed: ${e}`);
        status.setParser('failed');
        // Without tree-sitter every feature silently degrades to regex
        // analysis, so the user must hear about it. window/showMessageRequest
        // is one of the few messages allowed before the initialize response.
        safeConnectionCall(() => connection.window.showWarningMessage(
          'QSP: the tree-sitter parser failed to load, so the extension is running in limited regex mode. '
          + 'See the "QSP Language Server" output for details.',
        ));
      }
    } else {
      log.log('[QSP] Running in lite mode (no tree-sitter parser — regex-only analysis)');
      status.setParser('lite');
    }

    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        completionProvider: {
          triggerCharacters: ['$', '#', '%', '@', "'", '"', '.'],
          resolveProvider: true,
        },
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
        renameProvider: {
          prepareProvider: true,
        },
        semanticTokensProvider: {
          legend: SEMANTIC_TOKENS_LEGEND,
          full: true,
          // VS Code colours the visible lines from a range request while a
          // large file's full request is still making tokens.
          range: true,
        },
        codeActionProvider: {
          codeActionKinds: [
            CodeActionKind.QuickFix,
            CodeActionKind.RefactorExtract,
            CodeActionKind.Refactor,
            CodeActionKind.Source,
          ],
        },
        foldingRangeProvider: true,
        documentFormattingProvider: true,
        documentRangeFormattingProvider: true,
        documentHighlightProvider: true,
      },
    };
  });

  connection.onInitialized(() => {
    status.start();
    safeConnectionCall(() => connection.client.register(DidChangeConfigurationNotification.type, undefined));

    // Register file watcher for project mode
    if (fsProvider) {
      const globs = QSP_FILE_EXTENSIONS.map(ext => `**/*${ext}`);
      safeConnectionCall(() => connection.client.register(DidChangeWatchedFilesNotification.type, {
        watchers: globs.map(globPattern => ({ globPattern })),
      }));
      log.log(`[QSP] Watching: ${globs.join(', ')}`);
    }

    // Read initial settings and potentially start project mode
    Promise.all([
      connection.workspace.getConfiguration({ section: 'qsp' }),
      connection.workspace.getConfiguration({ section: 'files' }),
    ]).then(async ([qspConfig, filesConfig]) => {
      fileEncoding = filesConfig?.encoding ?? 'utf8';
      settings = parseSettingsFromConfig(qspConfig as Record<string, unknown> | undefined);
      project.embeddedExecEnabled = settings.embeddedExec.enabled;
      perf.verbose = settings.debug.performanceLog;
      status.configure(settings.project.enabled ? { state: 'loading', files: 0 } : undefined);
      log.log(`[QSP] Server ready (encoding: ${fileEncoding}, project: ${settings.project.enabled}, embeddedExec: ${settings.embeddedExec.enabled})`);
      if (settings.project.enabled) {
        // Async: scans the workspace and reads/parses files off the main
        // synchronous path so other LSP requests keep being served while
        // a large project loads. See ProjectModeService.init().
        await initProject();
      } else {
        endProjectLoad();
      }
    }).catch((err: unknown) => {
      console.error('[QSP] Failed to read initial configuration:', err);
      endProjectLoad();
      // Reading the settings failed, so the defaults stay in effect; don't
      // leave the indicator spinning. A failure later, in the project scan,
      // keeps the project state it already reported.
      if (!status.isConfigured) status.configure(undefined);
    });
  });

  connection.onDidChangeWatchedFiles((params) => {
    if (!settings.project.enabled) return;
    // Apply the whole batch of changes and rebuild project aggregates
    // ONCE at the end, instead of once per changed file (a `git
    // checkout` touching hundreds of files would otherwise trigger
    // hundreds of full project rebuilds). Fire-and-forget: this is a notification
    // handler, so nothing awaits its result; rejections are caught here
    // so they can't become unhandled rejections that crash the server.
    running(project.handleWatchedFileChanges(
      params.changes, fsProvider, fileEncoding,
      settings.diagnostics,
      () => collectCallTypesPerTarget(documentStates),
      (ownUri: string) => collectPeerDocs(documentStates, ownUri),
    ).then(
      () => {
        reportProjectSize();
        // An open file's highlighting reads the changed files' symbols
        // (which arguments their locations run, which they jump to).
        refreshSemanticTokens();
      },
      (err: unknown) => { console.error('[QSP] Failed to handle watched file changes:', err); },
    ));
  });

  connection.onDidChangeConfiguration((_change) => {
    Promise.all([
      connection.workspace.getConfiguration({ section: 'qsp' }),
      connection.workspace.getConfiguration({ section: 'files' }),
    ]).then(async ([qspConfig, filesConfig]) => {
      fileEncoding = filesConfig?.encoding ?? 'utf8';
      const prevProjectEnabled = settings.project.enabled;
      const prevEmbeddedExec = settings.embeddedExec.enabled;
      settings = parseSettingsFromConfig(qspConfig as Record<string, unknown> | undefined);
      project.embeddedExecEnabled = settings.embeddedExec.enabled;
      perf.verbose = settings.debug.performanceLog;

      if (settings.embeddedExec.enabled !== prevEmbeddedExec) {
        log.log(`[QSP] embeddedExec.enabled: ${prevEmbeddedExec} → ${settings.embeddedExec.enabled}`);
      }
      // Re-analyze all open documents with new settings
      for (const doc of documents.all()) {
        analyzeDocument(doc);
      }

      // Handle project mode toggling
      if (settings.project.enabled && !prevProjectEnabled) {
        log.log('[QSP] project.enabled: false → true');
        await initProject();
      } else if (!settings.project.enabled && prevProjectEnabled) {
        log.log('[QSP] project.enabled: true → false');
        cancelProjectRediagnose();
        project.teardown();
        status.setProject(undefined);
        // Re-analyze open documents without project aggregates
        for (const doc of documents.all()) {
          analyzeDocument(doc);
        }
      } else if (settings.project.enabled) {
        projectRebuildAndReanalyze();
      }
    }).catch((err: unknown) => {
      console.error('[QSP] Failed to read updated configuration:', err);
    });
  });

  // ==================== PROJECT MODE ====================
  const project = new ProjectModeService(connection, documents, documentStates, tsParser);
  project.perf = perf;
  project.shouldStop = tightOnMemory;
  project.tracking = {
    progress: (state) => {
      analysisInProgress = state;
      trackFile(state?.uri, state?.locationIndex);
    },
  };

  // Scan the workspace, showing the scan in the language status item and,
  // since a big workspace takes a while, as a progress notification too.
  async function initProject(): Promise<void> {
    projectLoadPending = true;
    status.setProject({ state: 'loading', files: 0 });
    const progress = await connection.window.createWorkDoneProgress().catch(() => undefined);
    safeConnectionCall(() => progress?.begin('QSP: loading project', undefined, 'Scanning files…'));
    let lastReported = 0;
    try {
      await perf.phaseAsync('project load', () => project.init(
        fsProvider, fileEncoding,
        () => collectCallTypesPerTarget(documentStates),
        (ownUri: string) => collectPeerDocs(documentStates, ownUri),
        settings.diagnostics,
        (files) => {
          // Every file would flood the client during a large scan.
          if (files - lastReported < 10) return;
          lastReported = files;
          status.setProject({ state: 'loading', files });
          safeConnectionCall(() => progress?.report(`${files} files`));
        },
      ), () => `${project.projectFileUris.size} files`);
      if (project.analysisCache) {
        const { hits, misses, diagnostics } = project.cacheStats;
        log.log(`[QSP] Analysis cache: ${hits} of ${hits + misses} project files read from it, ${misses} analysed`
          + (diagnostics ? '; stored diagnostics shown first' : ''));
      }
    } finally {
      safeConnectionCall(() => progress?.done());
      if (settings.project.enabled) reportProjectSize();
      endProjectLoad();
    }
  }

  // The project load diagnosed every file, deferred ones included; if it
  // failed or project mode is off, those still need their own.
  function endProjectLoad(): void {
    projectLoadPending = false;
    const deferred = [...deferredDiagnostics];
    deferredDiagnostics.clear();
    if (settings.project.enabled && project.projectAggregates) return;
    for (const uri of deferred) {
      const doc = documents.get(uri);
      if (doc) analyzeDocument(doc);
    }
  }

  function reportProjectSize(): void {
    if (settings.project.enabled) status.setProject({ state: 'ready', files: project.projectFileUris.size });
  }

  // Helper: rebuild aggregates + re-diagnose all project files. It covers
  // everything a pending fast-tier re-diagnosis would do, so that one is dropped.
  // With `changed`, the files whose text changed: the others are diagnosed
  // again only if one of them changed what they can see (fileInterface).
  const projectRebuildAndReanalyze = (changed?: string) => {
    cancelProjectRediagnose();
    runProjectRebuild({ changed: changed === undefined ? undefined : [changed] }, changed);
  };

  // The project's aggregates and diagnostics, in slices (see
  // ProjectModeService.rebuildAndReanalyzeAll); when they take more than
  // one, `busyUri` shows as busy until they are sent.
  function runProjectRebuild(options: RebuildOptions, busyUri?: string): void {
    const busy = busyWhilePausing(busyUri);
    running(project.rebuildAndReanalyzeAll(
      settings.diagnostics,
      () => collectCallTypesPerTarget(documentStates),
      (ownUri: string) => collectPeerDocs(documentStates, ownUri),
      { ...options, pause: busy.pause },
    ).catch((err: unknown) => {
      log.error(`[QSP] Project diagnostics failed: ${err}`);
    }).finally(busy.end));
  }

  // Aggregates and diagnostics running in slices, until they end.
  const inFlight = new Set<Promise<unknown>>();
  function running(work: Promise<unknown>): void {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  }

  // The MCP server reads every file's diagnostics after an edit: only
  // once the slices of the work it started have all run.
  connection.onRequest(SETTLED_REQUEST, async () => {
    while (inFlight.size > 0) await Promise.all(inFlight);
  });

  // A pause between slices that reports `uri` as busy from the first one
  // on: work done in one slice is too short to show.
  function busyWhilePausing(uri: string | undefined): { pause: () => Promise<void>; end: () => void } {
    let busy = false;
    return {
      pause: () => {
        if (!busy && uri) { busy = true; status.begin(uri); }
        return pauseForWrites();
      },
      end: () => { if (busy) status.end(uri!); },
    };
  }

  // ── Fast-tier cross-file re-diagnosis ─────────────────────────────
  // When an edit changes a file's location names, the other project files
  // are re-diagnosed on a follow-up timer so their cross-file duplicate
  // errors update before the tree tier. One run is pending at a time:
  // files whose fast tiers fire together share it. The edited files are
  // left out (their symbols lag behind; their diagnostics were just
  // cleared and the tree tier re-sends them).
  let projectRediagnoseTimer: ReturnType<typeof setTimeout> | undefined;

  function cancelProjectRediagnose(): void {
    if (projectRediagnoseTimer) clearTimeout(projectRediagnoseTimer);
    projectRediagnoseTimer = undefined;
  }

  function scheduleProjectRediagnose(): void {
    if (projectRediagnoseTimer) return;
    projectRediagnoseTimer = setTimeout(() => {
      projectRediagnoseTimer = undefined;
      if (project.projectAggregates && settings.project.enabled) runProjectRebuild({});
    }, 0);
  }

  // ==================== DOCUMENT SYNC ====================

  // TextDocuments fires onDidChangeContent right after onDidOpen for the
  // same document. The open already runs the full analysis, so that change
  // event must not queue both debounce tiers again: the tree tier would
  // re-parse the whole file (seconds for a large one) for no change.
  const openedJustNow = new Set<string>();

  documents.onDidOpen((event: { document: TextDocument }) => {
    // In project mode, add to project file set
    if (settings.project.enabled) {
      project.projectFileUris.add(event.document.uri);
      if (project.projectAggregates) reportProjectSize();
    }
    openedJustNow.add(event.document.uri);
    analyzeWithStatus(event.document.uri);
  });

  let shuttingDown = false;

  // vscode-jsonrpc writes queued messages from its own setImmediate (a
  // setTimeout(0) in the browser, which has no setImmediate). Scheduling
  // with the same primitive runs `fn` after those writes, FIFO, so a
  // message sent just before is in the pipe before a long synchronous parse.
  const afterPendingWrites: (fn: () => void) => void = typeof setImmediate === 'function'
    ? (fn) => { setImmediate(fn); }
    : (fn) => { setTimeout(fn, 0); };
  // A pause between slices of work (slices.ts). vscode-jsonrpc handles a
  // request that came in from one turn and writes its answer from the
  // next: two turns let both through before the work goes on (on a
  // 12.8 M-character file, answers in 32 ms instead of 80 ms).
  const pauseForWrites = async () => {
    await new Promise<void>((resolve) => afterPendingWrites(resolve));
    await new Promise<void>((resolve) => afterPendingWrites(resolve));
  };
  project.pause = pauseForWrites;

  /**
   * Analyze an open document, reporting it as busy when it is big enough
   * for the user to wait on. The parse is synchronous, so the busy
   * notification would otherwise leave only after it; the analysis waits
   * one event-loop turn to let the notification out first.
   */
  function analyzeWithStatus(uri: string): void {
    const doc = documents.get(uri);
    if (!doc) return;
    if (!tsParser.isReady || doc.getText().length < ANALYSIS_STATUS_MIN_BYTES) {
      analyzeDocument(doc);
      return;
    }
    status.begin(uri);
    afterPendingWrites(() => {
      try {
        const latest = documents.get(uri);
        if (latest && !shuttingDown) analyzeDocument(latest);
      } finally {
        status.end(uri);
      }
    });
  }

  /**
   * Two-tier debounce for change events:
   *  - Fast tier (150ms): rebuild location index, reuse existing symbols.
   *    Keeps outline, completions, and hover responsive during typing.
   *  - Tree tier (500ms): full tree-sitter re-parse + diagnostics.
   *    Only runs after the user pauses, so the heavy parse doesn't
   *    block the server on every keystroke.
   */
  const fastTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const treeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const DEBOUNCE_FAST_MS = 150;
  const DEBOUNCE_TREE_MS = 500;

  documents.onDidChangeContent((event: { document: TextDocument }) => {
    const uri = event.document.uri;
    if (openedJustNow.delete(uri)) return;

    // Immediately invalidate stale cached semantic tokens so that any
    // semantic-token request arriving before the tree tier fires won't
    // return tokens with outdated line positions.
    const existingState = documentStates.get(uri);
    if (existingState) existingState.cachedSemanticTokens = undefined;

    // Fast tier: location index + reuse symbols
    const existingFast = fastTimers.get(uri);
    if (existingFast) clearTimeout(existingFast);
    fastTimers.set(uri, setTimeout(() => {
      fastTimers.delete(uri);
      const latest = documents.get(uri);
      if (latest) analyzeDocumentFast(latest);
    }, DEBOUNCE_FAST_MS));

    // Tree tier: full tree-sitter parse + analysis
    const existingTree = treeTimers.get(uri);
    if (existingTree) clearTimeout(existingTree);
    treeTimers.set(uri, setTimeout(() => {
      treeTimers.delete(uri);
      analyzeWithStatus(uri);
    }, DEBOUNCE_TREE_MS));
  });

  // Trees that large locations keep for edits go when nobody used them for a while.
  const TREE_IDLE_MS = 5 * 60_000;
  const treeSweep = setInterval(() => {
    const dropped = dropIdleTrees(documentStates.values(), Date.now(), TREE_IDLE_MS);
    if (dropped > 0) perf.note(`idle trees dropped · ${dropped}`);
  }, 60_000);
  // Node only: the sweep alone mustn't keep a process (tests, the MCP server) running.
  (treeSweep as { unref?: () => void }).unref?.();

  // After shutdown only `exit` may arrive, so pending debounce timers must not
  // fire into a disposed parser. Freeing WASM memory matters for hosts that
  // keep the process alive (tests, embedders).
  connection.onShutdown(async () => {
    shuttingDown = true;
    // A recorder stopped here marks the run as ended cleanly, so the
    // client doesn't report it as a crash.
    if (host.recorder?.active) await host.recorder.stop().catch(() => []);
    status.stop();
    clearInterval(treeSweep);
    for (const t of fastTimers.values()) clearTimeout(t);
    for (const t of treeTimers.values()) clearTimeout(t);
    fastTimers.clear();
    treeTimers.clear();
    cancelProjectRediagnose();
    project.stopRebuild();
    for (const state of documentStates.values()) releasePerLocationTrees(state);
    tsParser.dispose();
  });

  documents.onDidClose((event: { document: TextDocument }) => {
    const uri = event.document.uri;
    const ft = fastTimers.get(uri);
    if (ft) { clearTimeout(ft); fastTimers.delete(uri); }
    const tt = treeTimers.get(uri);
    if (tt) { clearTimeout(tt); treeTimers.delete(uri); }
    status.forget(uri);
    // The editor's analysis, kept if the file on disk turns out to hold the
    // same text: the trees go, but symbols and syntax errors are what a
    // closed project file needs, and re-analysing a large one takes seconds.
    // Not when an analysis was still pending (it lags behind the text).
    const closedText = stripBom(event.document.getText());
    const kept = ft || tt ? undefined : keepableAnalysis(uri, documentStates.get(uri));
    // Clean up retained per-location trees before discarding state.
    releasePerLocationTrees(documentStates.get(uri));
    documentStates.delete(uri);

    // In project mode, re-read the file from disk so its symbols remain
    // in the project aggregates (the editor no longer holds the text).
    // Fire-and-forget: onDidClose is a synchronous notification handler,
    // and the read/parse is off the main path so it doesn't block other
    // requests while this file is (re-)analyzed.
    if (settings.project.enabled && fsProvider && project.projectFileUris.has(uri)) {
      const filePath = fsProvider.uriToPath(uri);
      fsProvider.readFile(filePath, fileEncoding).then(
        (text) => {
          if (kept && stripBom(text) === closedText) project.keepFile(uri, text, kept.symbols, kept.syntaxErrors);
          else project.analyzeFile(uri, text);
          projectRebuildAndReanalyze(uri);
        },
        (err: unknown) => {
          // A file deleted on disk is dropped from the project by the file watcher.
          if ((err as { code?: unknown } | null)?.code === 'ENOENT') return;
          log.error(`[QSP] Failed to re-read closed project file ${filePath}: ${err}`);
        },
      ).catch((err: unknown) => {
        log.error(`[QSP] Failed to re-analyze closed project file ${filePath}: ${err}`);
      });
    } else {
      // Clear any diagnostics we previously published for this URI so
      // they don't linger in the Problems panel after the editor closes
      // the document.  In project mode the file is still part of the
      // project and projectRebuildAndReanalyze re-publishes accurate
      // diagnostics, so we skip the clear there.
      safeSendDiagnostics(connection, { uri, diagnostics: [] });
    }
  });

  /**
   * Fast-path analysis: rebuild location index and reuse existing
   * symbols so that outline / completions / hover stay responsive
   * while the user is typing.  Tree-sitter parse is deferred to the
   * tree tier (analyzeDocument) which fires on a longer debounce.
   */
  function analyzeDocumentFast(doc: TextDocument): void {
    const text = stripBom(doc.getText());
    const locationIndex = buildLocationIndex(text);

    const previousState = documentStates.get(doc.uri);
    // Reuse tree-sitter symbols if available; fall back to regex-only.
    // When reusing old symbols, line numbers may be stale — mark the
    // state so hover can show "(approximate)".
    const symbols = previousState?.symbols ?? buildRegexSymbols(doc.uri, locationIndex, text);
    const positionsApproximate = previousState?.symbols !== undefined;

    documentStates.set(doc.uri, {
      locationIndex,
      symbols,
      cachedSemanticTokens: undefined,   // stale tokens have wrong positions
      perLocationCache: previousState?.perLocationCache,
      rawText: text,
      positionsApproximate,
      storedAnalysis: previousState?.storedAnalysis,
      propagation: previousState?.propagation,
      suppressions: parseSuppressions(text, locationIndex),
    });

    // The diagnostics published are kept until the tree tier replaces
    // them: the editor moves their squiggles with the text meanwhile.
    // Clearing them on every keystroke made the Problems panel flicker,
    // and VS Code's table view (1.140) fails to redraw a list that
    // shrinks under a selected row, leaving the panel empty.

    // In project mode, if the set of location names changed (rename,
    // add, or delete), re-diagnose all OTHER project files so their
    // cross-file duplicate errors update immediately.
    // Note: rebuildProjectAggregates and computeDiagnostics use
    // state.locationIndex (always fresh) for location name checks,
    // so no symbols.locationDefs sync is needed here.
    if (settings.project.enabled && project.projectAggregates && previousState) {
      const oldIdx = previousState.locationIndex;
      const newIdx = locationIndex;
      let changed = oldIdx.length !== newIdx.length;
      if (!changed) {
        for (let i = 0; i < oldIdx.length; i++) {
          if (oldIdx[i].nameLower !== newIdx[i].nameLower) { changed = true; break; }
        }
      }
      if (changed) scheduleProjectRediagnose();
    }
  }

  // Locations above this size keep their tree-sitter tree in memory
  // for incremental re-parsing (avoids ~1s full parse for 200KB locations).
  const INCREMENTAL_LOC_THRESHOLD = 50_000; // 50 KB

  // Put a cached location's symbols into `symbols` at the location's
  // lines. The document and the cache then share the object, so a large
  // file keeps one copy of its symbols, and a location that stays on the
  // same lines is handed over without copying. Returns the cache entry
  // to keep.
  function placeLocation(
    symbols: DocumentSymbols, loc: LocationEntry, locLoc: SymbolLocation, entry: PerLocationParseResult,
  ): PerLocationParseResult {
    const shift = loc.startLine - entry.symbolsLine;
    if (shift === 0) {
      symbols.adoptLocation(loc.name, locLoc, entry.symbols);
      return entry;
    }
    const placed = LocationSymbols.copyWithLineShift(entry.symbols, shift);
    symbols.adoptLocation(loc.name, locLoc, placed);
    return { ...entry, symbols: placed, symbolsLine: loc.startLine };
  }

  /**
   * An open file's symbols and syntax errors, for keeping when it closes;
   * undefined when they can't stand for a fresh analysis (positions reused
   * from an older parse, regex-only symbols, or errors no longer at hand).
   * Call before the file's trees are released.
   */
  function keepableAnalysis(uri: string, state: DocumentState | undefined): { symbols: DocumentSymbols; syntaxErrors: SyntaxError[] } | undefined {
    if (!state || state.positionsApproximate || !tsParser.isReady) return undefined;
    for (const loc of state.symbols.locations.values()) if (loc.regexOnly) return undefined;
    const syntaxErrors: SyntaxError[] = [];
    if (state.perLocationCache) {
      const keys = perLocationCacheKeys(state.locationIndex);
      for (const [i, loc] of state.locationIndex.entries()) {
        const entry = state.perLocationCache.get(keys[i]);
        if (!entry) return undefined;
        shiftErrors(entry.errors, loc.startLine, syntaxErrors);
      }
    } else {
      return undefined;
    }
    return { symbols: state.symbols, syntaxErrors };
  }

  // A location's fold ranges and, with semantic highlighting on, its
  // tokens, from a parse of its text the first time they are asked for.
  // The tree isn't kept: the entry may already belong to a replaced state,
  // whose trees nothing would free.
  function completeLocation(entry: PerLocationParseResult): void {
    const wantTokens = settings.semanticHighlighting.enabled && !entry.tokens;
    if (entry.folds && !wantTokens) return;
    // Short of memory, or a parse that fails: none, and no retrying.
    const tree = tightOnMemory() ? null : perf.step('parse', () => tsParser.parseOnce(entry.text));
    if (!tree) {
      entry.folds ??= new Uint32Array(0);
      entry.tokens ??= new Uint32Array(0);
      return;
    }
    try {
      entry.folds ??= perf.step('folding', () => Uint32Array.from(collectFoldLines(tree)));
      if (wantTokens) {
        const embedParseFn = settings.embeddedExec.enabled ? (t: string) => tsParser.parseOnce(t) : undefined;
        entry.tokens = perf.step('semantic tokens', () => Uint32Array.from(collectSemanticTokenTuples(tree, undefined, embedParseFn)));
      }
    } finally {
      tree.delete();
    }
  }

  function locationTokens(entry: PerLocationParseResult): Uint32Array {
    if (!entry.tokens) completeLocation(entry);
    return entry.tokens ?? new Uint32Array(0);
  }

  function locationFolds(entry: PerLocationParseResult): Uint32Array {
    if (!entry.folds) completeLocation(entry);
    return entry.folds ?? new Uint32Array(0);
  }

  const SLICE_MS = 20;

  async function completeLocations(uri: string, cancel: CancellationToken): Promise<void> {
    const cache = documentStates.get(uri)?.perLocationCache;
    if (!cache) return;
    let made = 0;
    const started = Date.now();
    let sliceStarted = started;
    for (const entry of [...cache.values()]) {
      if (cancel.isCancellationRequested || shuttingDown) return;
      if (entry.folds && (entry.tokens || !settings.semanticHighlighting.enabled)) continue;
      completeLocation(entry);
      made++;
      if (Date.now() - sliceStarted >= SLICE_MS) {
        await pauseForWrites();
        sliceStarted = Date.now();
      }
    }
    if (made > 0) perf.note(`locations completed · ${made} locations, ${Date.now() - started} ms`);
  }

  function releasePerLocationTrees(state: DocumentState | undefined): void {
    if (!state?.perLocationCache) return;
    for (const entry of state.perLocationCache.values()) {
      if (entry.tree) { entry.tree.delete(); entry.tree = undefined; }
    }
  }

  // The diagnostics of an open file outside a project, in slices (see
  // slices.ts) so requests are answered meanwhile. A run stops when the
  // file's analysis is replaced: the next one's run sends them instead.
  function diagnoseFile(uri: string): void {
    const state = documentStates.get(uri);
    const doc = documents.get(uri);
    if (!state || !doc) return;
    const busy = busyWhilePausing(uri);
    running(runInSlices(
      perf.phaseSteps('file diagnostics', fileDiagnosticsSteps(doc, uri, state), (d) => `${d.length} diagnostics`),
      { sliceMs: SLICE_MS, pause: busy.pause, cancelled: () => shuttingDown || documentStates.get(uri) !== state },
    ).then(
      (done) => { if (done) safeSendDiagnostics(connection, { uri, diagnostics: done.value }); },
      (err: unknown) => { log.error(`[QSP] Diagnostics failed: ${err}`); },
    ).finally(busy.end));
  }

  function* fileDiagnosticsSteps(doc: TextDocument, uri: string, state: DocumentState): Steps<Diagnostic[]> {
    const fileAgg = yield* perf.stepSteps('file aggregates', fileAggregatesSteps(state, uri, tightOnMemory));
    return yield* perf.stepSteps('diagnostics', diagnosticsSteps(
      doc, uri, state.locationIndex, settings.diagnostics,
      collectCallTypesPerTarget(documentStates), state.symbols,
      state.syntaxErrors, undefined, fileAgg,
      collectPeerDocs(documentStates, uri),
      state.suppressions,
    ));
  }

  function analyzeDocument(doc: TextDocument): void {
    const text = stripBom(doc.getText());
    if (tsParser.isReady) {
      analyzeDocumentPerLocation(doc, text);
      return;
    }
    trackFile(doc.uri, buildLocationIndex(text));
    try {
      perf.phase('regex analysis', () => analyzeDocumentByRegex(doc, text), () => formatChars(text.length));
    } finally {
      trackFile(undefined);
    }
  }

  // Without tree-sitter (the browser's lite mode, or before it has loaded):
  // symbols from the text only.
  function analyzeDocumentByRegex(doc: TextDocument, text: string): void {
    const locationIndex = buildLocationIndex(text);
    const symbols = buildRegexSymbols(doc.uri, locationIndex, text);
    const previous = documentStates.get(doc.uri);
    releasePerLocationTrees(previous);
    documentStates.set(doc.uri, {
      locationIndex, symbols, cachedSemanticTokens: undefined, suppressions: parseSuppressions(text, locationIndex),
      propagation: previous?.propagation,
    });

    if (settings.project.enabled && project.projectAggregates) {
      projectRebuildAndReanalyze(doc.uri);
    } else if (projectLoadPending) {
      deferredDiagnostics.add(doc.uri);
    } else {
      diagnoseFile(doc.uri);
    }
    refreshSemanticTokens();
  }

  // ── Per-location analysis ──────────────────────────────────────────
  //
  // Every document is parsed one QSP location at a time (~4KB average,
  // ~1-5ms each), never as one tree: a multi-MB file as one tree can take
  // 20s+ (GLR with error recovery), and a closed project file is analysed
  // the same way (locationAnalysis.ts). On edits, only the changed
  // location is re-parsed; all others reuse cached symbols/errors/tokens
  // with adjusted line numbers: ~10-40ms per edit.
  //
  // Locations taken from a stored analysis aren't parsed at all until a
  // feature needs their tree, tokens or fold ranges.

  type StoredLocation = Pick<PerLocationParseResult, 'symbols' | 'symbolsLine' | 'errors'>;

  // A complete analysis of exactly this text made earlier, split per
  // location: by the project scan, kept while the file was closed, or
  // stored on disk. Undefined when there is none, or it doesn't match the
  // locations one to one (symbols are keyed by name, so duplicates collapse).
  function storedLocations(
    key: string, prevState: DocumentState | undefined, locationIndex: readonly LocationEntry[],
  ): StoredLocation[] | undefined {
    const stored = prevState?.storedAnalysis?.key === key
      ? { symbols: prevState.symbols, syntaxErrors: prevState.storedAnalysis.syntaxErrors }
      : project.readAnalysis(key);
    if (!stored || stored.symbols.locations.size !== locationIndex.length) return undefined;
    const result: StoredLocation[] = [];
    const indexOf = new Map<LocationEntry, number>();
    for (const [i, loc] of locationIndex.entries()) {
      const symbols = stored.symbols.locations.get(loc.nameLower);
      if (!symbols || symbols.regexOnly || indexOf.has(loc)) return undefined;
      indexOf.set(loc, i);
      result.push({ symbols, symbolsLine: loc.startLine, errors: [] });
    }
    for (const err of stored.syntaxErrors) {
      const loc = findLocationAtLine(locationIndex as LocationEntry[], err.startRow);
      if (!loc) return undefined;
      result[indexOf.get(loc)!].errors.push(shiftError(err, -loc.startLine));
    }
    return result;
  }

  /**
   * Parse a single location and return its local-coordinate results.
   * For large locations (≥INCREMENTAL_LOC_THRESHOLD), retains the tree
   * for incremental re-parsing on subsequent edits.
   *
   * @param prev Optional previous parse result — if provided and the
   *   location has a retained tree, uses incremental parsing.
   */
  function parseLocationBlock(
    locText: string,
    docUri: string,
    locationName: string,
    prev?: PerLocationParseResult,
  ): PerLocationParseResult | null {
    let tree;

    // Try incremental parsing if the previous result retained a tree.
    if (prev?.tree && prev.text !== locText) {
      const oldTree = prev.tree;
      const edit = computeTreeEdit(prev.text, locText);
      if (edit) {
        oldTree.edit(edit);
        tree = tsParser.parseOnce(locText, 5_000_000, oldTree);
      }
      // Otherwise computeTreeEdit returned null because the suffix scan
      // hit the 100 KB cap — text differs but the edit region is huge.
      // tree stays undefined, triggering the full parse path below.
      //
      // parser.parse(text, oldTree) returns a new independent tree;
      // the old tree can be safely deleted (only when we actually re-parsed).
      if (tree !== oldTree) oldTree.delete();
      prev!.tree = undefined;   // prevent double-delete in fallback below
    }

    if (!tree) {
      // Full parse (first time, or incremental parse timed out).
      // prev.tree is already cleaned up by the incremental branch above
      // if we entered it, so no double-delete risk here.
      tree = perf.step('parse', () => tsParser.parseOnce(locText));
    }

    if (!tree) return null;

    let keepTree = false;
    try {
      const embedParseFn = settings.embeddedExec.enabled
        ? (t: string) => tsParser.parseOnce(t)
        : undefined;
      const parsed = tree;
      const { symbols: locSymbols, errors } = analyzeParsedLocation(
        parsed, docUri, locationName, locText, embedParseFn, (name, fn) => perf.step(name, fn),
      );
      // Short of memory, files go without semantic highlighting
      // (TextMate still colours them).
      const tokens = tightOnMemory() ? new Uint32Array(0)
        : perf.step('semantic tokens', () => Uint32Array.from(collectSemanticTokenTuples(parsed, undefined, embedParseFn)));
      const folds = perf.step('folding', () => Uint32Array.from(collectFoldLines(parsed)));

      keepTree = locText.length >= INCREMENTAL_LOC_THRESHOLD;

      return {
        text: locText,
        symbols: locSymbols,
        symbolsLine: 0,
        errors,
        tokens,
        folds,
        tree: keepTree ? tree : undefined,
        treeUsedAt: keepTree ? Date.now() : undefined,
      };
    } finally {
      // keepTree is only set once the result is built, so a throw frees the tree too.
      if (!keepTree) tree.delete();
    }
  }

  /**
   * O(1-location) incremental update for per-location parsed files.
   *
   * Uses the current location index (rebuilt cheaply by the fast tier)
   * and compares each location's text length against the cache to find
   * the single changed location.  Re-parses only that one location
   * (using the retained tree-sitter tree for incremental parsing) and
   * reuses all other cached results.
   *
   * Returns `true` on success.  Returns `false` when the edit can't
   * be handled incrementally (structural change, multiple locations
   * changed, renamed/added/deleted locations, etc.) — the caller
   * falls back to full `analyzeDocumentPerLocation`.
   */
  function tryIncrementalPerLocationUpdate(
    doc: TextDocument,
    text: string,
    prevState: DocumentState,
  ): boolean {
    const currentIndex = prevState.locationIndex;   // current (from fast tier)
    const prevCache = prevState.perLocationCache!;  // from last full analysis
    // See perLocationCacheKeys' doc comment: plain nameLower collides on
    // duplicate location names, which would otherwise wedge this
    // function into permanently returning false (`.size` mismatch) for
    // the rest of the file's editing session.
    const currentKeys = perLocationCacheKeys(currentIndex);

    // ── 1. Same number of locations? ──────────────────────────────
    if (currentIndex.length !== prevCache.size) return false;

    // ── 2. Find the changed location via length comparison ────────
    //    For insert/delete edits, the changed location will have a
    //    different text length.  This is O(N) integer comparisons,
    //    taking microseconds for 1200 locations.
    let affIdx = -1;
    for (let i = 0; i < currentIndex.length; i++) {
      const loc = currentIndex[i];
      const prev = prevCache.get(currentKeys[i]);
      if (!prev) return false;  // new or renamed location
      const locLen = loc.endOffset - loc.startOffset;
      if (locLen !== prev.text.length) {
        if (affIdx >= 0) return false;  // multiple locations changed
        affIdx = i;
      }
    }

    // All locations have the same length — could be an equal-length
    // substitution.  Fall back to full analysis (rare case).
    if (affIdx < 0) return false;

    // ── 3. Re-parse only the changed location ─────────────────────
    const affLoc = currentIndex[affIdx];
    const newLocText = text.slice(affLoc.startOffset, affLoc.endOffset);
    const prev = prevCache.get(currentKeys[affIdx])!;

    // Verify it actually changed (guard against hash collisions etc.)
    if (prev.text === newLocText) return false;

    const result = parseLocationBlock(newLocText, doc.uri, affLoc.name, prev);
    if (!result) return false;

    // ── 4. Update cache (shallow copy + replace affected entry) ───
    const newCache = new Map(prevCache);
    newCache.set(currentKeys[affIdx], result);

    // ── 5. Build DocumentSymbols ──────────────────────────────────
    const symbols = new DocumentSymbols(doc.uri);
    const allErrors: SyntaxError[] = [];
    for (let i = 0; i < currentIndex.length; i++) {
      const loc = currentIndex[i];
      const cached = newCache.get(currentKeys[i]);
      if (!cached) continue;

      // Unchanged locations on the same lines hand over their symbols
      // as they are; shifted or changed ones get a moved copy.
      newCache.set(currentKeys[i], placeLocation(symbols, loc, makeLocSymLoc(doc.uri, text, loc), cached));
      shiftErrors(cached.errors, loc.startLine, allErrors);
    }

    // Rebuild the document-wide global-bindings index so hover
    // "Possible values", chain-tail bridging, and project-wide
    // resolvers see writes from every location.  The per-location
    // path bypasses extractSymbols at the document level, so this
    // is the only place it gets called.
    symbols.rebuildGlobalBindings();

    // ── 6. Store state (semantic tokens are built lazily on request) ──

    documentStates.set(doc.uri, {
      locationIndex: currentIndex,
      symbols,
      cachedSemanticTokens: undefined,   // rebuilt lazily
      perLocationCache: newCache,
      rawText: text,
      propagation: prevState.propagation,
      // No whole-file tree to read them from: project re-diagnoses need them here.
      syntaxErrors: allErrors,
      suppressions: parseSuppressions(text, currentIndex),
    });

    // ── 7. Send diagnostics ───────────────────────────────────────
    if (settings.project.enabled && project.projectAggregates) {
      projectRebuildAndReanalyze(doc.uri);
    } else if (projectLoadPending) {
      deferredDiagnostics.add(doc.uri);
    } else {
      diagnoseFile(doc.uri);
    }

    // Tell VS Code to re-request semantic tokens.
    refreshSemanticTokens();

    return true;
  }

  function analyzeDocumentPerLocation(doc: TextDocument, text: string): void {
    // ── Try O(1-location) incremental update first ────────────────
    // Requires: fast tier already ran (locationIndex is current) and
    // a previous full analysis populated the perLocationCache.
    const prevState = documentStates.get(doc.uri);
    if (prevState?.perLocationCache && prevState.locationIndex.length > 0) {
      if (perf.phase('location update', () => tryIncrementalPerLocationUpdate(doc, text, prevState))) return;
    }

    perf.phase(
      'per-location analysis',
      () => analyzeAllLocations(doc, text, prevState),
      (n) => `${n} locations, ${formatChars(text.length)}`,
    );
  }

  // Every location parsed (or reused from the cache) and merged into the
  // document's symbols. Returns the number of locations.
  function analyzeAllLocations(doc: TextDocument, text: string, prevState: DocumentState | undefined): number {
    // ── Full analysis (initial load or structural change) ─────────
    const locationIndex = buildLocationIndex(text);
    const progress = { uri: doc.uri, locationIndex, parsedLocations: 0 };
    analysisInProgress = progress;
    trackFile(doc.uri, locationIndex);
    const label = doc.uri.split('/').pop() ?? doc.uri;
    log.log(`[QSP] Per-location parse: ${label} (${locationIndex.length} locations, ${Math.round(text.length / 1024)}kb)`);
    const symbols = new DocumentSymbols(doc.uri);
    const allErrors: SyntaxError[] = [];

    // ── Change detection: reuse unchanged locations ────────────────
    const prevCache = prevState?.perLocationCache;
    const newCache = new Map<string, PerLocationParseResult>();
    // See perLocationCacheKeys' doc comment: distinct keys even when
    // two locations share a name, so neither's cache entry (and its
    // retained tree, if any) is silently overwritten/leaked by the other.
    const cacheKeys = perLocationCacheKeys(locationIndex);
    // Opened from scratch: the analysis may be stored already, or worth storing.
    const analysisKey = prevCache ? undefined : project.analysisKey(doc.uri, text);
    const stored = analysisKey ? perf.step('stored analysis', () => storedLocations(analysisKey, prevState, locationIndex)) : undefined;
    let complete = true;

    for (const [i, loc] of locationIndex.entries()) {
      progress.parsedLocations = i;
      perf.atLocation(i);
      const locText = text.slice(loc.startOffset, loc.endOffset);
      const locLoc = makeLocSymLoc(doc.uri, text, loc);
      const cacheKey = cacheKeys[i];

      // Check if we can reuse the previous parse result —
      // simple text comparison: if the location's text is identical to what
      // we cached, the parse result is still valid.
      const prev = prevCache?.get(cacheKey);
      const canReuse = prev !== undefined && prev.text === locText;

      const known = stored?.[i];
      if (known) {
        // Taken as stored: no parse until a feature needs the tree or tokens.
        newCache.set(cacheKey, perf.step('copy into file', () => placeLocation(symbols, loc, locLoc, { text: locText, ...known })));
        shiftErrors(known.errors, loc.startLine, allErrors);
      } else if (canReuse && prev) {
        // Reuse cached result
        newCache.set(cacheKey, perf.step('copy into file', () => placeLocation(symbols, loc, locLoc, prev)));

        shiftErrors(prev.errors, loc.startLine, allErrors);
      } else {
        // Parse this location (incrementally if prev has a retained tree)
        const result = parseLocationBlock(locText, doc.uri, loc.name, prev);
        if (result) {
          newCache.set(cacheKey, perf.step('copy into file', () => placeLocation(symbols, loc, locLoc, result)));

          shiftErrors(result.errors, loc.startLine, allErrors);
        } else {
          // Tree-sitter failed for this location — fall back to regex
          complete = false;
          const locSymbols = symbols.addLocation(loc.name, locLoc);
          extractLocationSymbolsFromText(text, loc, locSymbols, doc.uri);
        }
      }
    }

    // Semantic tokens are rebuilt lazily on the first SemanticTokens
    // request (see lspFeatures.ts) — flattening tokens from every
    // location into a single merged `data` array is expensive memory-wise
    // for huge files (millions of token tuples) and matches the lazy
    // behavior of `tryIncrementalPerLocationUpdate`.

    // Clean up retained trees from the old cache that weren't carried
    // over to the new cache (deleted/renamed locations).
    if (prevCache) {
      for (const [key, entry] of prevCache) {
        if (!newCache.has(key) && entry.tree) {
          entry.tree.delete();
        }
      }
    }

    // Rebuild the document-wide global-bindings index (see
    // tryIncrementalPerLocationUpdate for rationale).
    perf.step('global bindings', () => symbols.rebuildGlobalBindings());
    progress.parsedLocations = locationIndex.length;
    // A file that stays open never reaches the project scan, the one other writer.
    const reusable = complete && symbols.locations.size === locationIndex.length;
    if (analysisKey && !stored && reusable && !tightOnMemory()) project.storeAnalysis(analysisKey, symbols, allErrors);

    // Store state
    documentStates.set(doc.uri, {
      locationIndex,
      symbols,
      cachedSemanticTokens: undefined,   // rebuilt lazily on first request
      perLocationCache: newCache,
      rawText: text,
      // No whole-file tree to read them from: project re-diagnoses need them here.
      syntaxErrors: allErrors,
      propagation: documentStates.get(doc.uri)?.propagation,
      suppressions: parseSuppressions(text, locationIndex),
    });
    // From here the file is in documentStates, so a report counts it there.
    analysisInProgress = undefined;
    perf.atLocation(-1);

    // Send diagnostics (pass pre-extracted errors to skip full-tree extraction)
    if (settings.project.enabled && project.projectAggregates) {
      projectRebuildAndReanalyze(doc.uri);
    } else if (projectLoadPending) {
      deferredDiagnostics.add(doc.uri);
    } else {
      diagnoseFile(doc.uri);
    }

    // Tell VS Code to re-request semantic tokens.
    refreshSemanticTokens();
    trackFile(undefined);
    return locationIndex.length;
  }

  // ── LSP feature handlers ────────────────────────────────────────────
  registerLspFeatures({
    connection,
    documents,
    documentStates,
    get settings() { return settings; },
    get projectAggregates() { return project.projectAggregates; },
    projectFileUris: project.projectFileUris,
    tsParser,
    collectCallTypesPerTarget: () => collectCallTypesPerTarget(documentStates),
    buildTokensFromCache: (locationIndex, cache, project, lines) => perf.phase(
      'semantic tokens',
      () => buildTokensFromCache(locationIndex, cache, locationTokens, project, lines),
      () => `${locationIndex.length} locations${lines ? `, lines ${lines.end - lines.start + 1}` : ''}`,
    ),
    buildFoldsFromCache: (locationIndex, cache) => perf.phase(
      'folding ranges',
      () => buildFoldsFromCache(locationIndex, cache, locationFolds),
      () => `${locationIndex.length} locations`,
    ),
    completeLocations,
  });

  // ── Performance diagnostics ───────────────────────────────────────
  // See performanceReport.ts: numbers and grammar node types only, so the
  // result can be shared for games whose text can't be.
  // Tell the recorder which file is being analysed, under pseudonyms.
  function trackFile(uri: string | undefined, locationIndex?: readonly LocationEntry[]): void {
    if (!perf.tracker) return;
    if (uri === undefined || !locationIndex) {
      perf.enterFile(undefined);
      return;
    }
    perf.enterFile(pseudonyms.file(uri), locationIndex.map((loc, i) => ({
      id: pseudonyms.location(uri, i, loc.name),
      chars: loc.endOffset - loc.startOffset,
      lines: loc.endLine - loc.startLine + 1,
    })));
    savePseudonyms();
  }

  // What each pseudonym stands for, next to the recorder's files. The
  // client keeps it on the user's machine, outside the report it packs.
  function savePseudonyms(): void {
    if (!host.recorder?.active || pseudonyms.changes === savedPseudonyms) return;
    savedPseudonyms = pseudonyms.changes;
    // The workspace tells the client which window's project a crashed
    // run belongs to; like the names, it never goes into a report.
    host.recorder.writeJson('names', { workspaceFolders: workspaceFolderUris, pseudonyms: pseudonyms.table() });
  }

  // A location's code with the game taken out (parser/anonymize.ts), for
  // a crash report the user chose to extend. `locations` carries the
  // crashed run's pseudonyms so the code matches its breadcrumbs.
  connection.onRequest('qsp/anonymizedLocation', async (params: { uri: string; name: string; locations?: Record<string, string> }) => {
    if (!tsParser.isReady) return undefined;
    let text = documents.get(params.uri)?.getText();
    if (text === undefined && fsProvider) {
      text = await fsProvider.readFile(fsProvider.uriToPath(params.uri), fileEncoding).catch(() => undefined);
    }
    if (text === undefined) return undefined;
    text = stripBom(text);
    const loc = buildLocationIndex(text).find(l => l.nameLower === params.name.toLowerCase());
    if (!loc) return undefined;
    const locText = text.slice(loc.startOffset, loc.endOffset);
    const tree = tsParser.parseOnce(locText);
    if (!tree) return undefined;
    try {
      return anonymizeCode(tree, locText, { locations: new Map(Object.entries(params.locations ?? {})) });
    } finally {
      tree.delete();
    }
  });

  function buildReport() {
    return buildPerformanceReport({
      states: documentStates,
      pseudonyms,
      openUris: new Set(documents.all().map(d => d.uri)),
      parser: tsParser.isReady ? 'full' : wasmLoader ? 'not loaded' : 'lite',
      projectMode: settings.project.enabled,
      embeddedExec: settings.embeddedExec.enabled,
      uptimeSeconds: (Date.now() - startedAt) / 1000,
      memory: perf.sampleMemory(),
      aggregates: project.projectAggregates,
      inProgress: analysisInProgress,
    });
  }
  connection.onRequest('qsp/performanceReport', () => perf.phase('performance report', buildReport));

  // Start listening
  documents.listen(connection);
  connection.listen();
}
