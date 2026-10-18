/**
 * Types shared across the LSP feature handler modules.
 *
 * Centralizes interface definitions so individual feature modules
 * can import what they need without circular dependencies.
 */
import type {
  SemanticTokens,
} from 'vscode-languageserver';
import type Parser from 'web-tree-sitter';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { Suppressions } from '../common/suppressions';
import type {
  DocumentSymbols,
  LocationSymbols,
  LocationEntry,
  QspTreeSitterParser,
  PossibleValueEntry,
  SyntaxError,
  SymbolLocation,
} from '../parser';
import type {
  SymbolAggregates,
  ProjectAggregates,
  PropagationBase,
} from './aggregation';

// ──────────────────────────────────────────────────────────────────────
// Per-location cache
// ──────────────────────────────────────────────────────────────────────

/** What the semantic tokens of a location take from the other locations. */
export interface TokenFacts {
  /** Locations something jumps to with `goto`/`gt` (lower-case names). */
  gotoTargets: ReadonlySet<string>;
  /** The blocks of a location that are only text (arguments and blocks kept in variables nothing runs), where its symbols put them. */
  textBlocksOf(entry: PerLocationParseResult): readonly SymbolLocation[];
}

/** Per-location parse cache entry: one per location of an open document. */
export interface PerLocationParseResult {
  text: string;
  /**
   * The location's symbols, with line numbers counted from `symbolsLine`:
   * 0 as parsed, the location's start line once placed in a document.
   * The cache and the document share them, so a large file keeps one copy.
   */
  symbols: LocationSymbols;
  symbolsLine: number;
  /** In the location's own coordinates (its header is line 0), like `tokens`. */
  errors: SyntaxError[];
  /**
   * Semantic token tuples [line, char, length, type, modifiers, …],
   * packed: a large file holds millions of them, and a plain array of
   * numbers takes twice the memory. Undefined until asked for when the
   * location came from a stored analysis: opening the file parses nothing.
   */
  tokens?: Uint32Array;
  /**
   * Start and end lines, in pairs, of the blocks that fold, in the
   * location's own coordinates; made with the tokens, undefined like them.
   */
  folds?: Uint32Array;
  tree?: Parser.Tree;
  /** When `tree` was last used (Date.now()); trees idle for long are dropped. */
  treeUsedAt?: number;
}

// ──────────────────────────────────────────────────────────────────────
// Document state
// ──────────────────────────────────────────────────────────────────────

/** State for a single open document. */
export interface DocumentState {
  locationIndex: LocationEntry[];
  symbols: DocumentSymbols;
  cachedSemanticTokens?: { data: number[] };
  perLocationCache?: Map<string, PerLocationParseResult>;
  rawText?: string;
  /** Cached single-file aggregates (invalidated when the state object is replaced). */
  aggCache?: SymbolAggregates;
  /**
   * The propagation of locals behind the last single-file aggregates of
   * this document, carried over to the states that replace this one so an
   * edit can reuse it (fileAggregates).
   */
  propagation?: PropagationBase;
  /** Cached call-types-per-target for THIS document. Lazily built. */
  cachedCallTypes?: Map<string, { name: string; types: Set<string> }>;
  /**
   * True when the symbol positions (line/column) may be approximate
   * because the symbols were reused from a previous parse cycle
   * during the fast tier.
   */
  positionsApproximate?: boolean;
  /**
   * The file's syntax errors, in its coordinates: no tree holds them (a
   * closed project file's location trees are freed right after the scan,
   * an open file's are made only when needed).
   */
  syntaxErrors?: SyntaxError[];
  /**
   * Set while `symbols` are a complete analysis of the text with this
   * analysis cache key (see ProjectModeService.analysisKey), which has
   * these syntax errors: opening the file reuses them.
   */
  storedAnalysis?: { key: string; syntaxErrors: SyntaxError[] };
  /** The file's `!@qsp-ignore` comments, read from the text this state was built from. */
  suppressions?: Suppressions;
}

// ──────────────────────────────────────────────────────────────────────
// Settings + server context
// ──────────────────────────────────────────────────────────────────────

/** Settings shape the feature handlers need. */
export interface FeatureSettings {
  project: { enabled: boolean };
  embeddedExec: { enabled: boolean };
  semanticHighlighting: { enabled: boolean };
  hover: { possibleValues: boolean; maxItemsPerCategory: number };
}

/**
 * Shared server context — provides access to all mutable state and
 * helpers that the LSP feature handlers need.
 */
export interface ServerContext {
  connection: import('vscode-languageserver').Connection;
  documents: import('vscode-languageserver').TextDocuments<TextDocument>;
  documentStates: Map<string, DocumentState>;
  settings: FeatureSettings;
  projectAggregates: ProjectAggregates | null;
  projectFileUris: Set<string>;
  tsParser: QspTreeSitterParser;
  collectCallTypesPerTarget(): Map<string, { name: string; types: Set<string> }>;
  /**
   * Semantic tokens of a file parsed location by location, made for the
   * locations that have none yet; with `lines`, only of the locations
   * those lines touch. The lines of `text` outside every location are
   * comments.
   */
  buildTokensFromCache(
    locationIndex: LocationEntry[],
    cache: Map<string, PerLocationParseResult>,
    project?: TokenFacts,
    lines?: { start: number; end: number },
    text?: string,
  ): SemanticTokens;
  /** Fold ranges (start and end line) of a file parsed location by location, made for the locations that have none yet. */
  buildFoldsFromCache(locationIndex: LocationEntry[], cache: Map<string, PerLocationParseResult>): Array<{ startLine: number; endLine: number }>;
  /**
   * Make the missing tokens and fold ranges of `uri`'s locations a slice
   * at a time, so other requests are answered meanwhile; stops when
   * `cancel` is requested.
   */
  completeLocations(uri: string, cancel: import('vscode-languageserver').CancellationToken): Promise<void>;
}

// ──────────────────────────────────────────────────────────────────────
// Hover option types
// ──────────────────────────────────────────────────────────────────────

/** Options for `buildPossibleValuesLines`. */
export interface BuildPossibleValuesOptions {
  /**
   * Optional resolver for var-ref chain targets.  Given a lowercased
   * canonical key (e.g. `$g`), returns document/project-wide terminal
   * writes for that key.  When provided, var-ref entries are flattened
   * into one line per chain-target write.
   */
  expandVarRef?: (targetVarName: string) => readonly PossibleValueEntry[];
  /**
   * Override the default per-category cap (`DEFAULT_HOVER_MAX_ITEMS`).
   * Applied both to the number of distinct values and to the inline
   * location citations per value.
   */
  maxItems?: number;
}

// ──────────────────────────────────────────────────────────────────────
// Variable list item
// ──────────────────────────────────────────────────────────────────────

/** Variable entry returned by `collectProjectVariables`. */
export interface ProjectVariableItem {
  name: string;
  uri: string;
  line: number;
  isDefined: boolean;
  isLocal: boolean;
  prefixes: string[];
}
