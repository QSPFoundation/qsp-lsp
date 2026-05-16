import {
  CodeActionKind,
  Connection,
  DidChangeWatchedFilesNotification,
  InitializeParams,
  InitializeResult,
  DidChangeConfigurationNotification,
  TextDocumentSyncKind,
  TextDocuments,
  SemanticTokensBuilder,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  buildLocationIndex,
  DocumentSymbols,
  LocationSymbols,
  extractErrors,
  extractSymbols,
  LocationEntry,
  QspTreeSitterParser,
  computeTreeEdit,
  type QspSymbol,
  type SyntaxError,
  type WasmLoader,
  type CursorValueEntry,
} from '../parser';
import { collectSemanticTokenTuples, SEMANTIC_TOKENS_LEGEND, GOTO_MODIFIER_BIT, NAMESPACE_TOKEN_TYPE } from './semanticTokens';
import {
  buildRegexSymbols,
  extractLocationSymbolsFromText,
  mergeActionsFromText,
  mergeLabelsFromText,
} from './regexFallback';
import { type SymbolAggregates, buildFileAggregates, collectCallTypesPerTarget as collectCallTypesPerTargetFromSymbols, isAggContributionStable } from './aggregation';
import { computeDiagnostics, type DiagnosticSettings } from './diagnostics';
import { registerLspFeatures, type DocumentState, type PerLocationParseResult } from './lspFeatures';
import { stripBom, shiftErrors, makeLocSymLoc, QSP_FILE_EXTENSIONS, type FsProvider } from './serverUtils';
import { ProjectModeService } from './projectMode';

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
 * Build (or reuse) the per-document SymbolAggregates cache used in
 * single-file (non-project) mode.  Replaces the implicit rebuild that
 * computeDiagnostics() does on every call — dominated by
 * `buildPropagatedLocals` on huge files.
 *
 * The cache lives on `state.aggCache` and is invalidated by a fresh
 * DocumentState (analyzeDocument creates a new object each parse).
 */
function buildOrReuseFileAgg(state: DocumentState, uri: string): SymbolAggregates {
  if (state.aggCache) return state.aggCache;
  state.aggCache = buildFileAggregates(state.symbols, uri);
  return state.aggCache;
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

/** Build merged semantic tokens from per-location caches. */
function buildTokensFromCache(
  locationIndex: LocationEntry[],
  cache: Map<string, PerLocationParseResult>,
  gotoTargets?: ReadonlySet<string>,
) {
  const builder = new SemanticTokensBuilder();
  for (const loc of locationIndex) {
    const cached = cache.get(loc.nameLower);
    if (!cached) continue;
    const tuples = cached.tokens;
    const isGoto = gotoTargets?.has(loc.nameLower) ?? false;
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
): void {
  const documentStates = new Map<string, DocumentState>();
  const tsParser = new QspTreeSitterParser();

  // ── User settings ──────────────────────────────────────────────────
  // QspSettings is the full configuration shape; the diagnostics half
  // is owned by ./diagnostics so adding a flag in one place compiles
  // everywhere it's used.
  interface QspSettings {
    project: { enabled: boolean };
    embeddedExec: { enabled: boolean };
    diagnostics: DiagnosticSettings;
    semanticHighlighting: { enabled: boolean };
    hover: { possibleValues: boolean };
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
    },
    semanticHighlighting: { enabled: true },
    hover: { possibleValues: true },
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
    const pick = <T>(v: unknown, def: T): T => typeof v === typeof def ? v as T : def;

    const dd = defaultSettings.diagnostics;
    const diagnostics = { ...dd } as Record<string, unknown>;
    for (const key of Object.keys(dd) as (keyof DiagnosticSettings)[]) {
      diagnostics[key] = pick(d?.[key], dd[key]);
    }
    return {
      project: { enabled: pick(proj?.enabled, defaultSettings.project.enabled) },
      embeddedExec: { enabled: pick(emb?.enabled, defaultSettings.embeddedExec.enabled) },
      diagnostics: diagnostics as unknown as DiagnosticSettings,
      semanticHighlighting: { enabled: pick(sem?.enabled, defaultSettings.semanticHighlighting.enabled) },
      hover: { possibleValues: pick(hov?.possibleValues, defaultSettings.hover.possibleValues) },
    };
  }

  /** VS Code's files.encoding setting — used when reading non-open project files. */
  let fileEncoding = 'utf8';

  connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
    // Capture workspace folders for project mode. Only populated when a
    // filesystem provider is available (i.e. Node.js server, not browser)
    // — project mode is a no-op otherwise.
    if (fsProvider && params.workspaceFolders) {
      project.workspaceFolders = params.workspaceFolders.map(f => fsProvider.uriToPath(f.uri));
    }

    // Initialize tree-sitter in the background (non-blocking)
    if (wasmLoader) {
      try {
        await tsParser.init(wasmLoader, wasmDir);
        connection.console.log('[QSP] Tree-sitter parser initialized');

        // Re-analyze all open documents now that tree-sitter is ready
        for (const doc of documents.all()) {
          analyzeDocument(doc);
        }
      } catch (e) {
        connection.console.error(`[QSP] Tree-sitter init failed: ${e}`);
      }
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
        },
        codeActionProvider: {
          codeActionKinds: [
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
    connection.client.register(DidChangeConfigurationNotification.type, undefined);

    // Register file watcher for project mode
    if (fsProvider) {
      connection.client.register(DidChangeWatchedFilesNotification.type, {
        watchers: QSP_FILE_EXTENSIONS.map(ext => ({ globPattern: `**/*${ext}` })),
      });
    }

    // Read initial settings and potentially start project mode
    Promise.all([
      connection.workspace.getConfiguration({ section: 'qsp' }),
      connection.workspace.getConfiguration({ section: 'files' }),
    ]).then(([qspConfig, filesConfig]) => {
      fileEncoding = filesConfig?.encoding ?? 'utf8';
      settings = parseSettingsFromConfig(qspConfig as Record<string, unknown> | undefined);
      project.embeddedExecEnabled = settings.embeddedExec.enabled;
      if (settings.project.enabled) {
        project.init(fsProvider!, fileEncoding, () => collectCallTypesPerTarget(documentStates), (ownUri: string) => collectPeerDocs(documentStates, ownUri), settings.diagnostics);
      }
    });
  });

  connection.onDidChangeWatchedFiles((params) => {
    if (!settings.project.enabled) return;
    for (const change of params.changes) {
      project.handleFileChange(
        change.uri, change.type, fsProvider, fileEncoding,
        settings.diagnostics,
        () => collectCallTypesPerTarget(documentStates),
        (ownUri: string) => collectPeerDocs(documentStates, ownUri),
      );
    }
  });

  connection.onDidChangeConfiguration((_change) => {
    Promise.all([
      connection.workspace.getConfiguration({ section: 'qsp' }),
      connection.workspace.getConfiguration({ section: 'files' }),
    ]).then(([qspConfig, filesConfig]) => {
      fileEncoding = filesConfig?.encoding ?? 'utf8';
      const prevProjectEnabled = settings.project.enabled;
      settings = parseSettingsFromConfig(qspConfig as Record<string, unknown> | undefined);
      project.embeddedExecEnabled = settings.embeddedExec.enabled;
      // Re-analyze all open documents with new settings
      for (const doc of documents.all()) {
        analyzeDocument(doc);
      }

      // Handle project mode toggling
      if (settings.project.enabled && !prevProjectEnabled) {
        project.init(fsProvider!, fileEncoding, () => collectCallTypesPerTarget(documentStates), (ownUri: string) => collectPeerDocs(documentStates, ownUri), settings.diagnostics);
      } else if (!settings.project.enabled && prevProjectEnabled) {
        project.teardown();
        // Re-analyze open documents without project aggregates
        for (const doc of documents.all()) {
          analyzeDocument(doc);
        }
      } else if (settings.project.enabled) {
        projectRebuildAndReanalyze();
      }
    });
  });

  // ==================== PROJECT MODE ====================
  const project = new ProjectModeService(connection, documents, documentStates, tsParser);

  // Helper: rebuild aggregates + re-diagnose all project files.
  const projectRebuildAndReanalyze = () =>
    project.rebuildAndReanalyzeAll(
      settings.diagnostics,
      () => collectCallTypesPerTarget(documentStates),
      (ownUri: string) => collectPeerDocs(documentStates, ownUri),
    );

  // ==================== DOCUMENT SYNC ====================

  documents.onDidOpen((event: { document: TextDocument }) => {
    // In project mode, add to project file set
    if (settings.project.enabled) {
      project.projectFileUris.add(event.document.uri);
    }
    analyzeDocument(event.document);
  });

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
      const latest = documents.get(uri);
      if (latest) analyzeDocument(latest);
    }, DEBOUNCE_TREE_MS));
  });

  documents.onDidClose((event: { document: TextDocument }) => {
    const uri = event.document.uri;
    const ft = fastTimers.get(uri);
    if (ft) { clearTimeout(ft); fastTimers.delete(uri); }
    const tt = treeTimers.get(uri);
    if (tt) { clearTimeout(tt); treeTimers.delete(uri); }
    // Clean up retained per-location trees before discarding state.
    const state = documentStates.get(uri);
    if (state?.perLocationCache) {
      for (const entry of state.perLocationCache.values()) {
        if (entry.tree) { entry.tree.delete(); entry.tree = undefined; }
      }
    }
    documentStates.delete(uri);
    tsParser.removeTree(uri);

    // In project mode, re-read the file from disk so its symbols remain
    // in the project aggregates (the editor no longer holds the text).
    if (settings.project.enabled && fsProvider && project.projectFileUris.has(uri)) {
      try {
        const filePath = fsProvider.uriToPath(uri);
        const text = fsProvider.readFile(filePath, fileEncoding);
        project.analyzeFile(uri, text);
        projectRebuildAndReanalyze();
      } catch {
        // File may have been deleted — that's fine, the watcher handles it
      }
    } else {
      // Clear any diagnostics we previously published for this URI so
      // they don't linger in the Problems panel after the editor closes
      // the document.  In project mode the file is still part of the
      // project and projectRebuildAndReanalyze re-publishes accurate
      // diagnostics, so we skip the clear there.
      connection.sendDiagnostics({ uri, diagnostics: [] });
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
    });

    // Clear stale diagnostics immediately so the user doesn't see
    // warnings/errors with outdated line numbers while the tree tier
    // debounce is pending.  The tree tier will send fresh diagnostics
    // once tree-sitter re-parses the document.
    connection.sendDiagnostics({ uri: doc.uri, diagnostics: [] });

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
      if (changed) {
        project.rebuildAggregates(() => collectCallTypesPerTarget(documentStates));
        setTimeout(() => {
          const liveAgg = project.projectAggregates;
          if (!liveAgg || !settings.project.enabled) return;
          for (const uri of project.projectFileUris) {
            if (uri === doc.uri) continue;
            const st = documentStates.get(uri);
            if (!st) continue;
            const otherDoc = documents.get(uri);
            const d = computeDiagnostics(
              otherDoc ?? null, uri, st.locationIndex,
              settings.diagnostics, tsParser,
              liveAgg.callTypesPerTarget ?? collectCallTypesPerTarget(documentStates),
              st.symbols, undefined, liveAgg,
              undefined,
              collectPeerDocs(documentStates, uri),
            );
            connection.sendDiagnostics({ uri, diagnostics: d });
          }
        }, 0);
      }
    }
  }

  // ── Per-location parsing threshold ─────────────────────────────────
  // Files above this byte count use per-location parsing instead of the
  // single full-document tree.  This avoids O(n²+) GLR explosion and
  // keeps incremental edits O(single_location_size).
  const PER_LOCATION_BYTE_THRESHOLD = 500_000; // 500 KB

  // Locations above this size keep their tree-sitter tree in memory
  // for incremental re-parsing (avoids ~1s full parse for 200KB locations).
  const INCREMENTAL_LOC_THRESHOLD = 50_000; // 50 KB

  function analyzeDocument(doc: TextDocument): void {
    const text = stripBom(doc.getText());

    if (text.length >= PER_LOCATION_BYTE_THRESHOLD && tsParser.isReady) {
      analyzeDocumentPerLocation(doc, text);
      return;
    }

    analyzeDocumentFullTree(doc, text);
  }

  function analyzeDocumentFullTree(doc: TextDocument, text: string): void {
    const locationIndex = buildLocationIndex(text);
    let symbols: DocumentSymbols;

    // Get previous state for incremental symbol extraction
    const previousState = documentStates.get(doc.uri);

    // Use tree-sitter for symbol extraction if available
    let treeHasErrors = false;
    let reusedLocationNames = new Set<string>();
    if (tsParser.isReady) {
      const tree = tsParser.parse(doc.uri, text);
      if (tree) {
        // Reuse previous symbols for unchanged locations (incremental only)
        const prevSymbols = tsParser.wasLastParseIncremental
          ? previousState?.symbols : undefined;
        const result = extractSymbols(
          tree, doc.uri, prevSymbols, tsParser.lastEdit,
          settings.embeddedExec.enabled ? (t) => tsParser.parseOnce(t) : undefined,
        );
        symbols = result.symbols;
        reusedLocationNames = result.reusedLocations;
        treeHasErrors = tree.rootNode.hasError;
      } else {
        symbols = buildRegexSymbols(doc.uri, locationIndex, text);
      }
    } else {
      symbols = buildRegexSymbols(doc.uri, locationIndex, text);
    }

    // Regex backfill: only when tree-sitter had parse errors.
    //
    // Why guard on treeHasErrors?  The regex locationIndex treats every
    // `#` at line-start as a location header, but inside a location body
    // `#var` (array-count operator) is valid code, not a header.
    // Tree-sitter's grammar knows the difference.  When the tree is
    // error-free, tree-sitter symbols are authoritative — running the
    // merge would risk injecting phantom locations from regex
    // false-positives.
    //
    // When tree-sitter DOES have errors, some location_block nodes end
    // up inside ERROR nodes (missed entirely by extractSymbols) or have
    // ERROR sub-nodes that swallow their act_block/label children.
    // The regex index is more resilient in that case — we bridge the
    // gap here so the Outline view stays complete during mid-edit.
    if (treeHasErrors) {
      for (const loc of locationIndex) {
        // Skip locations reused from a previous incremental parse —
        // they already contain merge results from the previous cycle.
        if (reusedLocationNames.has(loc.nameLower)) continue;

        const existing = symbols.getLocation(loc.name);
        if (!existing) {
          // Location completely missed by tree-sitter — add it with
          // regex-extracted actions and labels.
          const locSymbols = symbols.addLocation(loc.name, makeLocSymLoc(doc.uri, text, loc));
          extractLocationSymbolsFromText(text, loc, locSymbols, doc.uri);
        } else if (existing.hasErrors) {
          // Tree-sitter found the location but ERROR sub-nodes
          // swallowed some children — merge regex results with
          // what tree-sitter found.  We keep TS's good actions
          // (it's more accurate for valid syntax) and add only
          // regex-found actions on lines TS missed.
          mergeActionsFromText(text, loc, existing, doc.uri);
          mergeLabelsFromText(text, loc, existing, doc.uri);
        }
      }
    }

    // Invalidate semantic token cache — tokens are built lazily on request.
    // Carry the cursor-entry resolver cache from the previous state: symbol
    // objects from locations that weren't changed by tree-sitter's incremental
    // re-parse retain their identity, so their cached resolver results survive.
    const prevCursorEntries = documentStates.get(doc.uri)?.cachedCursorEntries;
    const cursorEntries: WeakMap<QspSymbol, CursorValueEntry[] | null> =
      prevCursorEntries ?? new WeakMap();
    documentStates.set(doc.uri, { locationIndex, symbols, cachedSemanticTokens: undefined, cachedCursorEntries: cursorEntries });

    // In project mode, rebuild aggregates and re-diagnose all files
    if (settings.project.enabled && project.projectAggregates) {
      projectRebuildAndReanalyze();
    } else {
      // Send diagnostics for this file only
      const state = documentStates.get(doc.uri)!;
      const fileAgg = buildOrReuseFileAgg(state, doc.uri);
      const diagnostics = computeDiagnostics(
        doc, doc.uri, locationIndex, settings.diagnostics, tsParser,
        collectCallTypesPerTarget(documentStates), symbols,
        undefined, undefined, fileAgg,
        collectPeerDocs(documentStates, doc.uri),
      );
      connection.sendDiagnostics({ uri: doc.uri, diagnostics });
    }

    // Tell VS Code to re-request semantic tokens — a prior request may
    // have been served with stale cached tokens (wrong line positions)
    // before the tree-sitter re-parse completed.
    connection.languages.semanticTokens.refresh();
  }

  // ── Per-location analysis for large files ──────────────────────────
  //
  // Instead of parsing the entire 5MB+ document as one tree-sitter tree
  // (which can take 20s+ for GLR with error recovery), we parse each
  // QSP location independently (~4KB average, ~1-5ms each).  On edits,
  // only the changed location is re-parsed; all others reuse cached
  // symbols/errors/tokens with adjusted line numbers.
  //
  // This reduces the per-edit cost from ~1.2s (incremental full-tree)
  // to ~10-40ms (single location re-parse + merge + diagnostics).

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
      tree = tsParser.parseOnce(locText);
    }

    if (!tree) return null;

    try {
      const embedParseFn = settings.embeddedExec.enabled
        ? (t: string) => tsParser.parseOnce(t)
        : undefined;
      const result = extractSymbols(
        tree, docUri, undefined, undefined,
        embedParseFn,
      );
      const errors = extractErrors(tree);
      const tokens = collectSemanticTokenTuples(tree, undefined, embedParseFn);

      // extractSymbols wraps the location in a DocumentSymbols with one entry.
      // Get the LocationSymbols for the single location_block.
      let locSymbols: LocationSymbols | undefined;
      for (const [, ls] of result.symbols.locations) {
        locSymbols = ls;
        break; // only one location in per-location tree
      }

      // If extractSymbols found no location (e.g. entire tree is ERROR),
      // create an empty LocationSymbols so we still cache the result.
      if (!locSymbols) {
        locSymbols = new LocationSymbols(locationName);
        locSymbols.hasErrors = true;
      }

      const keepTree = locText.length >= INCREMENTAL_LOC_THRESHOLD;

      return {
        text: locText,
        symbols: locSymbols,
        errors,
        tokens,
        hasErrors: tree.rootNode.hasError,
        tree: keepTree ? tree : undefined,
      };
    } finally {
      // If we're NOT keeping the tree, delete it.
      if (locText.length < INCREMENTAL_LOC_THRESHOLD) {
        tree.delete();
      }
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

    // ── 1. Same number of locations? ──────────────────────────────
    if (currentIndex.length !== prevCache.size) return false;

    // ── 2. Find the changed location via length comparison ────────
    //    For insert/delete edits, the changed location will have a
    //    different text length.  This is O(N) integer comparisons,
    //    taking microseconds for 1200 locations.
    let affIdx = -1;
    for (let i = 0; i < currentIndex.length; i++) {
      const loc = currentIndex[i];
      const prev = prevCache.get(loc.nameLower);
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
    const prev = prevCache.get(affLoc.nameLower)!;

    // Verify it actually changed (guard against hash collisions etc.)
    if (prev.text === newLocText) return false;

    const result = parseLocationBlock(newLocText, doc.uri, affLoc.name, prev);
    if (!result) return false;

    // ── 4. Update cache (shallow copy + replace affected entry) ───
    const newCache = new Map(prevCache);
    newCache.set(affLoc.nameLower, result);

    // ── 5. Build DocumentSymbols ──────────────────────────────────
    const symbols = new DocumentSymbols(doc.uri);
    const allErrors: SyntaxError[] = [];
    const prevSymbols = prevState.symbols;

    for (let i = 0; i < currentIndex.length; i++) {
      const loc = currentIndex[i];
      const cached = newCache.get(loc.nameLower);
      if (!cached) continue;

      // For unchanged locations, reuse previous absolute-coordinate
      // symbols when the line number hasn't shifted (avoids deep copy).
      if (i !== affIdx) {
        const prevDef = prevSymbols.locationDefs.get(loc.nameLower);
        if (prevDef?.definition?.line === loc.startLine) {
          const prevLS = prevSymbols.getLocation(loc.name);
          if (prevLS) {
            symbols.locations.set(loc.nameLower, prevLS);
            symbols.locationDefs.set(loc.nameLower, prevDef);

            shiftErrors(cached.errors, loc.startLine, allErrors);
            continue;
          }
        }
      }

      // Changed location or shifted locations: build from local coords
      const locLoc = makeLocSymLoc(doc.uri, text, loc);
      symbols.addLocationFrom(loc.name, locLoc, cached.symbols, loc.startLine);

      shiftErrors(cached.errors, loc.startLine, allErrors);
    }

    // Rebuild the document-wide global-bindings index so hover
    // "Possible values", chain-tail bridging, and project-wide
    // resolvers see writes from every location.  The per-location
    // path bypasses extractSymbols at the document level, so this
    // is the only place it gets called.
    symbols.rebuildGlobalBindings();

    // ── 6. Store state (semantic tokens are built lazily on request) ──

    // Reuse the previous aggregate cache when the changed location's
    // contribution to the call graph and global variables is unchanged.
    // This avoids re-running buildPropagatedLocals (O(N) over all locs)
    // on every single-location keystroke for large files.
    const prevLocSyms = prevState.symbols.getLocation(affLoc.name);
    const aggCache = (prevState.aggCache && prevLocSyms && isAggContributionStable(prevLocSyms, result.symbols))
      ? prevState.aggCache
      : undefined;

    // Carry the resolver cache across incremental updates.  Unchanged
    // locations reuse the same QspSymbol objects, so their cached
    // resolver results remain valid.  The re-parsed location's new
    // symbol objects will naturally miss the WeakMap and be computed
    // fresh.  Stale entries from old symbol objects are GC'd automatically.
    const cachedCursorEntries: WeakMap<QspSymbol, CursorValueEntry[] | null> =
      prevState.cachedCursorEntries ?? new WeakMap();

    documentStates.set(doc.uri, {
      locationIndex: currentIndex,
      symbols,
      cachedSemanticTokens: undefined,   // rebuilt lazily
      perLocationCache: newCache,
      rawText: text,
      aggCache,
      cachedCursorEntries,
    });

    // ── 7. Send diagnostics ───────────────────────────────────────
    if (settings.project.enabled && project.projectAggregates) {
      projectRebuildAndReanalyze();
    } else {
      const state = documentStates.get(doc.uri)!;
      const fileAgg = buildOrReuseFileAgg(state, doc.uri);
      const diagnostics = computeDiagnostics(
        doc, doc.uri, currentIndex, settings.diagnostics, tsParser,
        collectCallTypesPerTarget(documentStates), symbols,
        allErrors, undefined, fileAgg,
        collectPeerDocs(documentStates, doc.uri),
      );
      connection.sendDiagnostics({ uri: doc.uri, diagnostics });
    }

    // Tell VS Code to re-request semantic tokens.
    connection.languages.semanticTokens.refresh();

    return true;
  }

  function analyzeDocumentPerLocation(doc: TextDocument, text: string): void {
    // ── Try O(1-location) incremental update first ────────────────
    // Requires: fast tier already ran (locationIndex is current) and
    // a previous full analysis populated the perLocationCache.
    const prevState = documentStates.get(doc.uri);
    if (prevState?.perLocationCache && prevState.locationIndex.length > 0) {
      if (tryIncrementalPerLocationUpdate(doc, text, prevState)) return;
    }

    // ── Full analysis (initial load or structural change) ─────────
    const locationIndex = buildLocationIndex(text);
    const symbols = new DocumentSymbols(doc.uri);
    const allErrors: SyntaxError[] = [];

    // ── Change detection: reuse unchanged locations ────────────────
    const prevCache = prevState?.perLocationCache;
    const newCache = new Map<string, PerLocationParseResult>();

    for (const loc of locationIndex) {
      const locText = text.slice(loc.startOffset, loc.endOffset);
      const locLoc = makeLocSymLoc(doc.uri, text, loc);

      // Check if we can reuse the previous parse result —
      // simple text comparison: if the location's text is identical to what
      // we cached, the parse result is still valid.
      const prev = prevCache?.get(loc.nameLower);
      const canReuse = prev !== undefined && prev.text === locText;

      if (canReuse && prev) {
        // Reuse cached result
        newCache.set(loc.nameLower, prev);

        // Add symbols with line shift from local → absolute coordinates.
        // In per-location trees the header is always at local line 0,
        // so the shift equals the location's absolute start line.
        symbols.addLocationFrom(loc.name, locLoc, prev.symbols, loc.startLine);

        shiftErrors(prev.errors, loc.startLine, allErrors);
      } else {
        // Parse this location (incrementally if prev has a retained tree)
        const result = parseLocationBlock(locText, doc.uri, loc.name, prev);
        if (result) {
          newCache.set(loc.nameLower, result);

          // Add symbols (local coords) with line shift to absolute
          symbols.addLocationFrom(loc.name, locLoc, result.symbols, loc.startLine);

          shiftErrors(result.errors, loc.startLine, allErrors);
        } else {
          // Tree-sitter failed for this location — fall back to regex
          const locSymbols = symbols.addLocation(loc.name, locLoc);
          extractLocationSymbolsFromText(text, loc, locSymbols, doc.uri);
        }
      }
    }

    // Semantic tokens are rebuilt lazily on the first SemanticTokens
    // request (see lspFeatures.ts) — flattening tokens from every
    // location into a single merged `data` array is expensive memory-wise
    // for huge files (millions of token tuples) and matches the lazy
    // behavior of both `analyzeDocumentFullTree` and
    // `tryIncrementalPerLocationUpdate`.

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
    symbols.rebuildGlobalBindings();

    // Store state
    documentStates.set(doc.uri, {
      locationIndex,
      symbols,
      cachedSemanticTokens: undefined,   // rebuilt lazily on first request
      perLocationCache: newCache,
      rawText: text,
    });

    // Send diagnostics (pass pre-extracted errors to skip full-tree extraction)
    if (settings.project.enabled && project.projectAggregates) {
      projectRebuildAndReanalyze();
    } else {
      const state = documentStates.get(doc.uri)!;
      const fileAgg = buildOrReuseFileAgg(state, doc.uri);
      const diagnostics = computeDiagnostics(
        doc, doc.uri, locationIndex, settings.diagnostics, tsParser,
        collectCallTypesPerTarget(documentStates), symbols,
        allErrors, undefined, fileAgg,
        collectPeerDocs(documentStates, doc.uri),
      );
      connection.sendDiagnostics({ uri: doc.uri, diagnostics });
    }

    // Tell VS Code to re-request semantic tokens.
    connection.languages.semanticTokens.refresh();
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
    buildTokensFromCache,
  });

  // Start listening
  documents.listen(connection);
  connection.listen();
}
