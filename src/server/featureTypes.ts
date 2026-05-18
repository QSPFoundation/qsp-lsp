/**
 * Types shared across the LSP feature handler modules.
 *
 * Centralizes interface definitions so individual feature modules
 * can import what they need without circular dependencies.
 */
import type {
  SemanticTokens,
} from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type {
  DocumentSymbols,
  LocationSymbols,
  LocationEntry,
  QspSymbol,
  QspTreeSitterParser,
  CursorValueEntry,
  PossibleValueEntry,
  SyntaxError,
} from '../parser';
import type {
  SymbolAggregates,
  ProjectAggregates,
} from './aggregation';

// ──────────────────────────────────────────────────────────────────────
// Per-location cache
// ──────────────────────────────────────────────────────────────────────

/** Per-location parse cache entry (only for large files). */
export interface PerLocationParseResult {
  text: string;
  symbols: LocationSymbols;
  errors: SyntaxError[];
  tokens: number[];
  hasErrors: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tree?: any;
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
  /** Cached call-types-per-target for THIS document. Lazily built. */
  cachedCallTypes?: Map<string, { name: string; types: Set<string> }>;
  /**
   * Cached `getCursorEntries` resolver results keyed by `QspSymbol`
   * object identity.  Symbols from unchanged locations retain their
   * object identity across incremental re-parses, so their resolver
   * results survive.  Only entries whose symbol objects changed
   * (the re-parsed location) need to be recomputed.
   * Uses WeakMap so stale symbol objects are automatically evicted by GC.
   */
  cachedCursorEntries?: WeakMap<QspSymbol, CursorValueEntry[] | null>;
  /**
   * True when the symbol positions (line/column) may be approximate
   * because the symbols were reused from a previous parse cycle
   * during the fast tier.
   */
  positionsApproximate?: boolean;
}

// ──────────────────────────────────────────────────────────────────────
// Settings + server context
// ──────────────────────────────────────────────────────────────────────

/** Settings shape the feature handlers need. */
export interface FeatureSettings {
  project: { enabled: boolean };
  embeddedExec: { enabled: boolean };
  semanticHighlighting: { enabled: boolean };
  hover: { possibleValues: boolean };
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
  buildTokensFromCache(
    locationIndex: LocationEntry[],
    cache: Map<string, PerLocationParseResult>,
    gotoTargets?: ReadonlySet<string>,
  ): SemanticTokens;
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
