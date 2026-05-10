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
  type SyntaxError,
  type QspTreeSitterParser,
} from '../parser';
import {
  type SymbolAggregates,
  type ProjectAggregates,
  buildFileAggregates,
} from './aggregation';

// ── Diagnostic passes ─────────────────────────────────────────────────

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
}

// ── Main entry point ──────────────────────────────────────────────────

/** Compute all diagnostics for a single document. */
export function computeDiagnostics(
  doc: TextDocument | null,
  docUri: string,
  locationIndex: LocationEntry[],
  diagnosticSettings: DiagnosticSettings,
  tsParser: QspTreeSitterParser,
  callTypesPerTarget: Map<string, { name: string; types: Set<string> }>,
  symbols?: DocumentSymbols,
  preExtractedErrors?: SyntaxError[],
  projectAgg?: ProjectAggregates | null,
  cachedFileAgg?: SymbolAggregates,
  projectDocs: DocumentSymbols[] = [],
): import('vscode-languageserver').Diagnostic[] {
  const ctx = new DiagnosticCtx(doc, diagnosticSettings);

  // ── Document-structure diagnostics ──────────────────────────────
  checkSyntaxErrors(ctx, docUri, locationIndex, tsParser, preExtractedErrors);
  if (diagnosticSettings.duplicateLocations) {
    checkDuplicateLocations(ctx, locationIndex, docUri, projectAgg);
  }
  if (diagnosticSettings.unclosedLocations || diagnosticSettings.maxLocationLines > 0) {
    checkLocationBounds(ctx, locationIndex);
  }

  if (!symbols) return ctx.results();

  // ── Aggregates ──────────────────────────────────────────────────
  let agg: SymbolAggregates;
  let allLocationDefs: Map<string, QspSymbol>;

  if (projectAgg) {
    agg = projectAgg;
    allLocationDefs = projectAgg.flatLocationDefs;
  } else if (cachedFileAgg) {
    agg = cachedFileAgg;
    allLocationDefs = symbols.locationDefs;
  } else {
    agg = buildFileAggregates(symbols, docUri);
    allLocationDefs = symbols.locationDefs;
  }

  const { definedActions, definedObjects, referencedObjects } = agg;
  const isProject = !!projectAgg;

  // Tree shared by variable dataflow passes (fetched once).
  const tree = (tsParser.isReady ? tsParser.getTree(docUri) : null) ?? undefined;

  // ── Per-location: symbol def/ref diagnostics ────────────────────
  for (const [, locSyms] of symbols.locations) {
    if (locSyms.hasErrors) continue;
    checkLocationSymbols(
      ctx, locSyms, allLocationDefs,
      definedActions, definedObjects, referencedObjects,
      callTypesPerTarget, isProject,
    );
  }

  // ── Variable dataflow diagnostics ────────────────────────────────
  checkVariables(ctx, symbols, agg, docUri, tree, projectDocs);

  // ── Dynamic/dyneval call diagnostics ────────────────────────────
  checkDynamicCalls(ctx, symbols);

  // ── Cross-location propagation diagnostics ──────────────────────
  checkPropagation(
    ctx, symbols, agg, locationIndex, allLocationDefs,
    projectAgg?.firstLocationKey,
  );

  return ctx.results();
}
