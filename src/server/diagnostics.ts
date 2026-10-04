/**
 * Diagnostic computation for QSP documents.
 *
 * Orchestrates domain-specific diagnostic passes.  Each domain module
 * is self-contained — it imports only the data it reasons about and
 * exports pure check functions that push into a shared `DiagnosticCtx`.
 *
 * No diagnostic pass mutates shared state beyond its own scope; the
 * orchestrator simply concatenates results.
 */


import type { TextDocument } from 'vscode-languageserver-textdocument';
import {
  type DocumentSymbols,
  type LocationEntry,
  type QspSymbol,
  type SymbolLocation,
  type SyntaxError,
} from '../parser';
import {
  type SymbolAggregates,
  type ProjectAggregates,
  buildFileAggregates,
} from './aggregation';

// ── Diagnostic passes ─────────────────────────────────────────────────

import { libraryIdOfUri } from '../common/libraryConfig';
import { argBlockRuns } from '../parser/argBlocks';
import { textStoredBlocks } from '../parser/storedBlocks';
import type { Suppressions } from '../common/suppressions';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver';
import { runNow, type Steps } from './slices';
import { DiagnosticCtx } from './diagnosticPasses/diagnosticHelpers';
import { checkSyntaxErrors, checkDuplicateLocations, checkLocationBounds } from './diagnosticPasses/structureDiagnostics';
import { checkLocationSymbols } from './diagnosticPasses/symbolDiagnostics';
import { checkVariables } from './diagnosticPasses/variableDiagnostics';
import { checkDynamicCalls } from './diagnosticPasses/dynamicDiagnostics';
import { checkPropagation } from './diagnosticPasses/propagationDiagnostics';

// ── Types (kept here — the public API entry point) ────────────────────

/** Diagnostic feature flags (mirrors QspSettings['diagnostics']). */
export interface DiagnosticSettings {
  duplicateLocations: boolean;
  duplicateLabels: boolean;
  duplicateActions: boolean;
  unreachableLabels: boolean;
  unclosedLocations: boolean;
  uninitializedVariables: boolean;
  unresolvedLocationRefs: boolean;
  unresolvedLabelRefs: boolean;
  unresolvedActionRefs: boolean;
  unresolvedObjectRefs: boolean;
  unusedLocations: boolean;
  unusedLabels: boolean;
  unusedVariables: boolean;
  unusedObjects: boolean;
  invalidFunctionPrefix: boolean;
  invalidBuiltinArgCount: boolean;
  deprecatedBuiltins: boolean;
  mixedVariablePrefixes: boolean;
  typeMismatch: boolean;
  mixedLocationCallTypes: boolean;
  inconsistentLocalPropagation: boolean;
  untrackedDynamicCalls: boolean;
  missingResultInFunctionCall: boolean;
  extraArgsToTargetWithoutArgs: boolean;
  shadowsCallFrameBuiltin: boolean;
  shadowsPropagatedLocal: boolean;
  maxErrorsPerLocation: number;
  maxLocationLines: number;
  /** At most this many diagnostics per file, the most severe first; 0 = all. */
  maxPerFile: number;
  /**
   * Not a user setting: lower-case URI prefixes of each workspace folder's
   * `libs/` (`libraryFolderPrefixes`), set by the server from its workspace
   * folders. Files there get errors only, and duplicates name the library.
   */
  libraryFolders?: readonly string[];
}

// ── Main entry point ──────────────────────────────────────────────────

/** Compute all diagnostics for a single document. */
export function computeDiagnostics(...args: Parameters<typeof diagnosticsSteps>): Diagnostic[] {
  return runNow(diagnosticsSteps(...args));
}

/** {@link computeDiagnostics} in steps, about one per location of each pass (see slices.ts). */
export function* diagnosticsSteps(
  doc: TextDocument | null,
  docUri: string,
  locationIndex: LocationEntry[],
  diagnosticSettings: DiagnosticSettings,
  callTypesPerTarget: Map<string, { name: string; types: Set<string> }>,
  symbols?: DocumentSymbols,
  /** The file's syntax errors; undefined without a parser (regex-only symbols). */
  syntaxErrors?: SyntaxError[],
  projectAgg?: ProjectAggregates | null,
  cachedFileAgg?: SymbolAggregates,
  projectDocs: DocumentSymbols[] = [],
  suppressions?: Suppressions,
): Steps<Diagnostic[]> {
  const libraryFolders = diagnosticSettings.libraryFolders ?? [];
  const libraryOf = (uri: string) => libraryIdOfUri(uri, libraryFolders);
  const ctx = new DiagnosticCtx(doc, diagnosticSettings, libraryOf(docUri) !== undefined, suppressions);

  // A mistyped `!@qsp-ignore` silences nothing, so say so where it is written.
  for (const p of suppressions?.problems ?? []) {
    ctx.push(
      DiagnosticSeverity.Warning,
      { start: { line: p.line, character: p.startCol }, end: { line: p.line, character: p.endCol } },
      p.message,
      { code: 'suppression' },
    );
  }

  // ── Aggregates ──────────────────────────────────────────────────
  let agg: SymbolAggregates | undefined;
  let allLocationDefs: Map<string, QspSymbol> | undefined;
  if (projectAgg) {
    agg = projectAgg;
    allLocationDefs = projectAgg.flatLocationDefs;
  } else if (symbols) {
    agg = cachedFileAgg ?? buildFileAggregates(symbols, docUri);
    allLocationDefs = symbols.locationDefs;
  }

  // Blocks passed as arguments are text unless the callee runs them, and
  // blocks kept in variables unless something may run the variable.
  const runArgBlocks: SymbolLocation[] = [];
  if (symbols) {
    const textBlocks = textStoredBlocks(symbols.locations.values(), agg?.runVariables);
    const locationNamed = (name: string) =>
      symbols.locations.get(name) ?? projectDocs.find(d => d.locations.has(name))?.locations.get(name);
    for (const [, locSyms] of symbols.locations) {
      for (const b of locSyms.argBlocks) (argBlockRuns(b, locationNamed) ? runArgBlocks : textBlocks).push(b.loc);
    }
    ctx.textBlocks = textBlocks;
  }

  // ── Document-structure diagnostics ──────────────────────────────
  checkSyntaxErrors(ctx, docUri, locationIndex, syntaxErrors, symbols,
    [...runArgBlocks, ...(symbols && agg ? blocksRun(symbols, agg, docUri) : [])]);
  if (diagnosticSettings.duplicateLocations) {
    checkDuplicateLocations(ctx, locationIndex, docUri, projectAgg, libraryOf);
  }
  if (diagnosticSettings.unclosedLocations || diagnosticSettings.maxLocationLines > 0) {
    checkLocationBounds(ctx, locationIndex);
  }

  if (!symbols) return ctx.results();

  if (!agg || !allLocationDefs) return ctx.results();
  const { definedActions, definedObjects, referencedObjects } = agg;
  const isProject = !!projectAgg;

  // ── Per-location: symbol def/ref diagnostics ────────────────────
  for (const [, locSyms] of symbols.locations) {
    yield;
    if (locSyms.hasErrors) continue;
    checkLocationSymbols(
      ctx, locSyms, allLocationDefs,
      definedActions, definedObjects, referencedObjects,
      callTypesPerTarget, isProject, agg.hasRegexOnlyLocations, agg.namedInText,
    );
  }

  // ── Variable dataflow diagnostics ────────────────────────────────
  yield* checkVariables(ctx, symbols, agg, docUri, projectDocs);

  // ── Dynamic/dyneval call diagnostics ────────────────────────────
  checkDynamicCalls(ctx, symbols);

  // ── Cross-location propagation diagnostics ──────────────────────
  yield* checkPropagation(
    ctx, symbols, agg, locationIndex, allLocationDefs,
    projectAgg?.firstLocationKey,
  );

  return ctx.results();
}

// The `{…}` blocks of this file that something runs: a `dynamic` or
// `dyneval` of a variable holding one, here or in another location.
function blocksRun(symbols: DocumentSymbols, agg: SymbolAggregates, docUri: string): SymbolLocation[] {
  const blocks: SymbolLocation[] = [];
  for (const [, locSyms] of symbols.locations) {
    for (const d of locSyms.resolvedDynamicBlocks) blocks.push(...d.blockLocs);
  }
  for (const [, dispatches] of agg.crossLocationDispatches) {
    for (const d of dispatches) {
      for (const c of d.candidates) {
        if (c.providerUri === docUri && c.binding.value.kind === 'code-block') blocks.push(c.binding.value.blockRange);
      }
    }
  }
  return blocks;
}
