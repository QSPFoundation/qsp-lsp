/**
 * Shared test utilities for the QSP LSP test suite.
 *
 * Provides a single source-of-truth for parser initialization,
 * WASM path, and common extraction helpers so that individual
 * test files don't duplicate boilerplate.
 */
import * as path from 'path';
import * as fs from 'fs';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Diagnostic } from 'vscode-languageserver';
import { QspTreeSitterParser, extractSymbols } from '../src/parser/treeSitter';
import type { DocumentSymbols } from '../src/parser/symbolTable';
import { buildLocationIndex } from '../src/common/locations';
import { computeDiagnostics, type DiagnosticSettings } from '../src/server/diagnostics';
import { collectCallTypesPerTarget } from '../src/server/aggregation';
import type { LocationEntry } from '../src/common/locations';

/** Absolute path to the tree-sitter QSP grammar WASM. */
export const WASM_PATH = path.join(__dirname, '..', 'tree-sitter-qsp', 'tree-sitter-qsp.wasm');

/** Load WASM bytes — the loader callback expected by QspTreeSitterParser.init(). */
export const loadWasm = async (): Promise<Buffer> => fs.readFileSync(WASM_PATH);

/**
 * Create a new QspTreeSitterParser and initialize it.
 * Typical usage inside a describe block:
 *
 *   const parser = new QspTreeSitterParser();
 *   beforeAll(() => initParser(parser));
 */
export async function initParser(parser: QspTreeSitterParser): Promise<void> {
  await parser.init(loadWasm);
}

/**
 * Parse QSP source text and extract symbols in one step.
 * Returns the DocumentSymbols (and optionally the raw tree).
 */
export function parseAndExtract(
  parser: QspTreeSitterParser,
  code: string,
  uri = 'test://t',
): { symbols: DocumentSymbols; tree: ReturnType<QspTreeSitterParser['parse']> } {
  const tree = parser.parse(uri, code)!;
  const { symbols } = extractSymbols(tree, uri);
  return { symbols, tree };
}

// ──────────────────────────────────────────────────────────────────────
// Diagnostics — shared fixture for driving the real computeDiagnostics
// ──────────────────────────────────────────────────────────────────────

/** DiagnosticSettings with every check disabled; flip only what each test needs. */
export const ALL_DIAGS_OFF: DiagnosticSettings = {
  duplicateLocations: false,
  duplicateLabels: false,
  duplicateActions: false,
  unclosedLocations: false,
  uninitializedVariables: false,
  unresolvedLocationRefs: false,
  unresolvedLabelRefs: false,
  unresolvedActionRefs: false,
  unresolvedObjectRefs: false,
  unusedLocations: false,
  unusedLabels: false,
  unusedVariables: false,
  unusedObjects: false,
  invalidFunctionPrefix: false,
  invalidBuiltinArgCount: false,
  mixedVariablePrefixes: false,
  typeMismatch: false,
  mixedLocationCallTypes: false,
  inconsistentLocalPropagation: false,
  untrackedDynamicCalls: false,
  missingResultInFunctionCall: false,
  extraArgsToTargetWithoutArgs: false,
  shadowsCallFrameBuiltin: false,
  shadowsPropagatedLocal: false,
  maxErrorsPerLocation: 1000,
  maxLocationLines: 0,
};

/**
 * Parse QSP source and run the real `computeDiagnostics`.
 *
 * Every diagnostic check is disabled by default; callers pass `overrides`
 * to enable just the branches they care about. Returns the raw
 * `Diagnostic[]` array for fine-grained assertions.
 */
export function runDiagnostics(
  parser: QspTreeSitterParser,
  code: string,
  overrides: Partial<DiagnosticSettings> = {},
  uri = 'test://diag',
): Diagnostic[] {
  const doc = TextDocument.create(uri, 'qsp', 1, code);
  const tree = parser.parse(uri, code)!;
  const { symbols } = extractSymbols(tree, uri);
  const locationIndex = buildLocationIndex(code);
  const settings = { ...ALL_DIAGS_OFF, ...overrides };
  const callTypes = collectCallTypesPerTarget([symbols]);
  return computeDiagnostics(doc, uri, locationIndex, settings, parser, callTypes, symbols);
}

/** Diagnostics filtered by a substring match (case-sensitive) on the message. */
export function diagnosticsMatching(diags: Diagnostic[], needle: string): Diagnostic[] {
  return diags.filter(d => d.message.includes(needle));
}

/**
 * Parse a variable-centric diagnostic message into structured fields.
 *
 * Used by test suites that want to assert on `{ varName, locName, … }`
 * rather than raw diagnostic objects. Understands the four variable
 * diagnostic shapes emitted by `computeDiagnostics`:
 *
 * - `Variable 'X' is used but never assigned`
 * - `Variable 'X' is assigned but never read`
 * - `Variable 'X' is used with mixed type prefixes: <csv>`
 * - `Variable 'X' is propagated as local from <A> but not from <B> — …`
 */
export function parseVariableDiagnostic(
  locationIndex: LocationEntry[],
  d: Diagnostic,
): {
  varName: string;
  locName: string;
  line: number;
  severity: number | undefined;
  prefixes: string[];
  message: string;
} {
  const varName = d.message.match(/^Variable '([^']+)'/)?.[1] ?? '';
  const loc = locationIndex.find(
    l => d.range.start.line >= l.startLine && d.range.start.line <= l.endLine,
  );
  const mixMatch = d.message.match(/mixed type prefixes: (.+)$/);
  const prefixes = mixMatch
    ? mixMatch[1].split(', ').map(s => (s === '(none)' ? '' : s)).sort()
    : [];
  return {
    varName,
    locName: loc?.name ?? '',
    line: d.range.start.line,
    severity: d.severity,
    prefixes,
    message: d.message,
  };
}

/**
 * Multi-file counterpart to `runDiagnostics` — drives the real
 * `computeDiagnostics` once per file with a shared `callTypesPerTarget`
 * map built across all files.
 *
 * Useful for cross-file diagnostic branches such as
 * `mixedLocationCallTypes`. Does NOT build a full `ProjectAggregates`,
 * so branches that require project-mode (e.g. cross-file duplicate
 * locations via `projectAgg.perFileLocNames`) must use a more
 * elaborate fixture.
 */
export function runMultiFileDiagnostics(
  parser: QspTreeSitterParser,
  files: { uri: string; code: string }[],
  overrides: Partial<DiagnosticSettings> = {},
): { uri: string; diagnostics: Diagnostic[] }[] {
  const settings = { ...ALL_DIAGS_OFF, ...overrides };
  const perFile = files.map(({ uri, code }) => {
    const doc = TextDocument.create(uri, 'qsp', 1, code);
    const tree = parser.parse(uri, code)!;
    const { symbols } = extractSymbols(tree, uri);
    const locationIndex = buildLocationIndex(code);
    return { uri, code, doc, symbols, locationIndex };
  });
  const callTypes = collectCallTypesPerTarget(perFile.map(f => f.symbols));
  return perFile.map(({ uri, doc, symbols, locationIndex }) => ({
    uri,
    diagnostics: computeDiagnostics(doc, uri, locationIndex, settings, parser, callTypes, symbols),
  }));
}

