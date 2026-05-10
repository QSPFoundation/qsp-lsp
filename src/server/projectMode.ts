/**
 * Project-mode service — manages multi-file workspace analysis.
 *
 * When qsp.project.enabled is true, all QSP source files in the
 * workspace are treated as parts of a single combined game file.
 * Cross-file diagnostics, completions, and navigation span all files.
 *
 * This class owns the mutable project-mode state (workspace folders,
 * aggregates, file URI set) and exposes lifecycle methods called by
 * the server's connection handlers in `common.ts`.
 */


import {
  FileChangeType,
  type Connection,
  type TextDocuments,
} from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import {
  buildLocationIndex,
  DocumentSymbols,
  LocationSymbols,
  extractSymbols,
  QspSymbolKind,
  type QspSymbol,
  type SymbolLocation,
  type LocationEntry,
  type QspTreeSitterParser,
} from '../parser';
import {
  buildRegexSymbols,
} from './regexFallback';
import {
  type ProjectAggregates,
  collectAggregates,
  buildPropagatedLocals,
  emptyAggregates,
} from './aggregation';
import type { DiagnosticSettings } from './diagnostics';
import type { DocumentState } from './lspFeatures';
import { computeDiagnostics } from './diagnostics';
import { stripBom, QSP_FILE_EXTENSIONS } from './serverUtils';

// ──────────────────────────────────────────────────────────────────────

export class ProjectModeService {
  /** Workspace root folders (populated on initialize). */
  workspaceFolders: string[] = [];

  /** Cached project aggregates (null when project mode is off). */
  projectAggregates: ProjectAggregates | null = null;

  /** URIs of all project files (both open and on-disk). */
  readonly projectFileUris = new Set<string>();

  constructor(
    private connection: Connection,
    private documents: TextDocuments<TextDocument>,
    private documentStates: Map<string, DocumentState>,
    private tsParser: QspTreeSitterParser,
  ) {}

  // ── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Scan workspace folders for QSP source files and populate
   * documentStates for non-open files by reading them from disk.
   */
  init(
    fsProvider: {
      readFile(filePath: string, encoding?: string): string;
      findFiles(dir: string, extensions: string[]): string[];
      pathToUri(filePath: string): string;
      uriToPath(uri: string): string;
    },
    fileEncoding: string,
    collectCallTypes: () => Map<string, { name: string; types: Set<string> }>,
    collectPeerDocs: (ownUri: string) => DocumentSymbols[],
    diagnosticsSettings: DiagnosticSettings,
  ): void {
    this.connection.console.log('[QSP] Initializing project mode...');
    this.projectFileUris.clear();

    // Discover all QSP files in workspace folders
    for (const folder of this.workspaceFolders) {
      const files = fsProvider.findFiles(folder, QSP_FILE_EXTENSIONS);
      for (const filePath of files) {
        const uri = fsProvider.pathToUri(filePath);
        this.projectFileUris.add(uri);

        // If not already open in editor, read from disk and analyze
        if (!this.documents.get(uri)) {
          try {
            const text = fsProvider.readFile(filePath, fileEncoding);
            this.analyzeFile(uri, text);
          } catch (e) {
            this.connection.console.error(`[QSP] Failed to read project file ${filePath}: ${e}`);
          }
        }
      }
    }

    // Also add all currently open documents
    for (const doc of this.documents.all()) {
      this.projectFileUris.add(doc.uri);
    }

    // Build aggregates and re-diagnose everything
    this.rebuildAndReanalyzeAll(diagnosticsSettings, collectCallTypes, collectPeerDocs);

    this.connection.console.log(
      `[QSP] Project mode initialized with ${this.projectFileUris.size} files`,
    );
  }

  /** Tear down project mode: clear non-open file states, clear aggregates. */
  teardown(): void {
    this.connection.console.log('[QSP] Tearing down project mode');

    // Clear diagnostics for non-open files
    for (const uri of this.projectFileUris) {
      if (!this.documents.get(uri)) {
        this.connection.sendDiagnostics({ uri, diagnostics: [] });
        this.documentStates.delete(uri);
      }
    }

    this.projectFileUris.clear();
    this.projectAggregates = null;
  }

  /**
   * Analyze a project file that isn't open in the editor.
   * Creates a DocumentState from the raw text.
   */
  analyzeFile(uri: string, text: string): void {
    const locationIndex = buildLocationIndex(text);
    let symbols: DocumentSymbols;

    if (this.tsParser.isReady) {
      const tree = this.tsParser.parseOnce(text);
      if (tree) {
        const result = extractSymbols(tree, uri);
        symbols = result.symbols;
        tree.delete();
      } else {
        symbols = buildRegexSymbols(uri, locationIndex, text);
      }
    } else {
      symbols = buildRegexSymbols(uri, locationIndex, text);
    }

    this.documentStates.set(uri, {
      locationIndex,
      symbols,
      cachedSemanticTokens: undefined,
    });
  }

  // ── Aggregate management ────────────────────────────────────────────

  /** Build a minimal QspSymbol for a location that is in locationIndex
   *  but not yet in symbols.locationDefs (fast-tier window). */
  private placeholderLocationDef(uri: string, loc: LocationEntry): QspSymbol {
    const col = 1; // '#' prefix (spaces before name are optional)
    const symLoc: SymbolLocation = {
      uri, line: loc.startLine, column: col,
      endLine: loc.startLine, endColumn: col + loc.name.length,
    };
    return {
      name: loc.name,
      nameLower: loc.nameLower,
      kind: QspSymbolKind.Location,
      definition: symLoc,
      references: [symLoc],
      isLocal: false,
    };
  }

  /**
   * Rebuild the complete project aggregates from all known files.
   * Returns the new `ProjectAggregates` and stores it on `this.projectAggregates`.
   *
   * @param collectCallTypes — callback that builds the merged call-type map
   *   from all open document states (defined in `common.ts` to avoid circular imports).
   */
  rebuildAggregates(
    collectCallTypes: () => Map<string, { name: string; types: Set<string> }>,
  ): ProjectAggregates {
    const agg: ProjectAggregates = {
      locationDefs: new Map(),
      ...emptyAggregates(),
      firstLocationKey: undefined,
      flatLocationDefs: new Map(),
      perFileLocNames: new Map(),
      callTypesPerTarget: new Map(),
    };

    // Determine the "first" location across the entire project
    // (for unused-location exemption). Use a deterministic order:
    // sort file URIs, first location in the first file wins.
    const sortedUris = [...this.projectFileUris].sort();
    for (const uri of sortedUris) {
      const state = this.documentStates.get(uri);
      if (state && state.locationIndex.length > 0) {
        agg.firstLocationKey = state.locationIndex[0].nameLower;
        break;
      }
    }

    for (const uri of this.projectFileUris) {
      const state = this.documentStates.get(uri);
      if (!state) continue;

      // Build per-file location name set (for cross-file duplicate detection)
      const names = new Set<string>();
      for (const loc of state.locationIndex) {
        names.add(loc.nameLower);
      }
      agg.perFileLocNames.set(uri, names);

      // Location defs — driven by locationIndex (always fresh) rather
      // than symbols.locationDefs which may lag during the fast tier.
      for (const loc of state.locationIndex) {
        const key = loc.nameLower;
        if (!agg.locationDefs.has(key)) {
          const sym = state.symbols.locationDefs.get(key)
            ?? this.placeholderLocationDef(uri, loc);
          agg.locationDefs.set(key, { uri, symbol: sym });
        }
        // Duplicates are detected in computeDiagnostics
      }

      collectAggregates(state.symbols.locations.values(), agg);
    }

    // Build transitive propagated-locals from the call graph
    {
      const allLocs: { locName: string; locSyms: LocationSymbols; uri: string }[] = [];
      for (const uri of this.projectFileUris) {
        const state = this.documentStates.get(uri);
        if (!state) continue;
        for (const [, locSyms] of state.symbols.locations) {
          allLocs.push({ locName: locSyms.locationName, locSyms, uri });
        }
      }
      buildPropagatedLocals(allLocs, agg);
    }

    // Build the flat map once (used by computeDiagnostics)
    for (const [key, entry] of agg.locationDefs) {
      agg.flatLocationDefs.set(key, entry.symbol);
    }

    // Build call-type aggregation once (used by semantic tokens + diagnostics)
    agg.callTypesPerTarget = collectCallTypes();

    this.projectAggregates = agg;
    return agg;
  }

  // ── Diagnostics ─────────────────────────────────────────────────────

  /**
   * Re-diagnose all project files using the current project aggregates.
   */
  reanalyzeAll(
    diagnosticsSettings: DiagnosticSettings,
    collectCallTypes: () => Map<string, { name: string; types: Set<string> }>,
    collectPeerDocs: (ownUri: string) => DocumentSymbols[],
    getDoc: (uri: string) => TextDocument | undefined,
  ): void {
    if (!this.projectAggregates) return;

    const callTypes = this.projectAggregates.callTypesPerTarget ?? collectCallTypes();

    for (const uri of this.projectFileUris) {
      const state = this.documentStates.get(uri);
      if (!state) continue;

      const doc = getDoc(uri);
      const diagnostics = computeDiagnostics(
        doc ?? null,
        uri,
        state.locationIndex,
        diagnosticsSettings,
        this.tsParser,
        callTypes,
        state.symbols,
        undefined,
        this.projectAggregates,
        undefined,
        collectPeerDocs(uri),
      );
      this.connection.sendDiagnostics({ uri, diagnostics });
    }
  }

  /** Convenience: rebuild aggregates then re-diagnose everything. */
  rebuildAndReanalyzeAll(
    diagnosticsSettings: DiagnosticSettings,
    collectCallTypes: () => Map<string, { name: string; types: Set<string> }>,
    collectPeerDocs: (ownUri: string) => DocumentSymbols[],
  ): void {
    this.rebuildAggregates(collectCallTypes);
    this.reanalyzeAll(
      diagnosticsSettings, collectCallTypes, collectPeerDocs,
      uri => this.documents.get(uri),
    );
  }

  // ── File watcher handling ───────────────────────────────────────────

  /**
   * Handle a file change from the file watcher (project mode).
   * Re-reads the file from disk if not open in editor, rebuilds
   * aggregates, and re-diagnoses all project files.
   */
  handleFileChange(
    uri: string,
    changeType: number,
    fsProvider: {
      readFile(filePath: string, encoding?: string): string;
      uriToPath(uri: string): string;
    } | undefined,
    fileEncoding: string,
    diagnosticsSettings: DiagnosticSettings,
    collectCallTypes: () => Map<string, { name: string; types: Set<string> }>,
    collectPeerDocs: (ownUri: string) => DocumentSymbols[],
  ): void {
    if (changeType === FileChangeType.Deleted) {
      // File deleted — remove from project
      this.projectFileUris.delete(uri);
      if (!this.documents.get(uri)) {
        this.connection.sendDiagnostics({ uri, diagnostics: [] });
        this.documentStates.delete(uri);
      }
    } else {
      // Created or changed
      this.projectFileUris.add(uri);

      const openDoc = this.documents.get(uri);
      if (!openDoc && fsProvider) {
        // File not open in editor — re-read from disk
        try {
          const filePath = fsProvider.uriToPath(uri);
          const text = fsProvider.readFile(filePath, fileEncoding);
          this.analyzeFile(uri, text);
        } catch (e) {
          this.connection.console.error(`[QSP] Failed to read project file: ${e}`);
          return;
        }
      } else if (openDoc) {
        // File IS open in editor.  The watcher fires as soon as the file
        // is saved to disk, which may be BEFORE the 150 ms fast-tier
        // debounce has had a chance to call analyzeDocumentFast and
        // refresh documentStates.  If we call rebuildProjectAggregates()
        // below with the stale pre-debounce documentState, cross-file
        // duplicate detection will use the old locationIndex and report
        // false positives.  Refresh the locationIndex from the open
        // document's current content right now so the aggregate rebuild
        // is accurate.
        const text = stripBom(openDoc.getText());
        const locationIndex = buildLocationIndex(text);
        const prevState = this.documentStates.get(uri);
        if (prevState) {
          this.documentStates.set(uri, { ...prevState, locationIndex });
        }
      }
    }

    this.rebuildAndReanalyzeAll(diagnosticsSettings, collectCallTypes, collectPeerDocs);
  }
}
