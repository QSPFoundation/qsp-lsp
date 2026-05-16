/**
 * Document-structure diagnostics.
 *
 * Checks that reason about the layout of the document as a whole:
 * tree-sitter syntax errors, duplicate location names (in-file and
 * cross-file in project mode), unclosed locations, and oversized
 * locations that exceed the configured line limit.
 */


import { DiagnosticSeverity } from 'vscode-languageserver';
import {
  extractErrors,
  findLocationAtLine,
  type DocumentSymbols,
  type LocationEntry,
  type SyntaxError,
  type QspTreeSitterParser,
} from '../../parser';
import type { ProjectAggregates } from '../aggregation';
import { uriBasename } from '../helpers';
import { DiagnosticCtx, mapPush } from './diagnosticHelpers';

// ── Syntax errors ─────────────────────────────────────────────────────

/** Tree-sitter parse errors, bucketed per location.  Surfaces ERROR nodes
 *  as diagnostics; locations with too many errors get a single aggregate
 *  warning instead (likely non-code content misidentified as QSP). */
export function checkSyntaxErrors(
  ctx: DiagnosticCtx,
  docUri: string,
  locationIndex: LocationEntry[],
  tsParser: QspTreeSitterParser,
  preExtractedErrors?: SyntaxError[],
  symbols?: DocumentSymbols,
): void {
  const maxPerLoc = ctx.settings.maxErrorsPerLocation;

  let syntaxErrors: SyntaxError[] | null = preExtractedErrors ?? null;
  if (!syntaxErrors && tsParser.isReady) {
    const tree = tsParser.getTree(docUri);
    if (tree) syntaxErrors = extractErrors(tree);
  }
  if (!syntaxErrors) return;

  // Merge in errors from embedded `<a href="exec:CODE">` link bodies.
  // Positions on `embeddedExecErrors` are already in absolute source
  // coordinates (translated by extractEmbeddedExec; line-shifted by
  // LocationSymbols.copyWithLineShift on the per-location path).
  if (symbols) {
    let combined: SyntaxError[] | null = null;
    for (const [, locSyms] of symbols.locations) {
      if (locSyms.embeddedExecErrors.length === 0) continue;
      if (!combined) combined = syntaxErrors.slice();
      for (const e of locSyms.embeddedExecErrors) combined.push(e);
    }
    if (combined) syntaxErrors = combined;
  }

  const endLines = new Set<number>();
  for (let i = 0; i < locationIndex.length; i++) endLines.add(locationIndex[i].endLine);

  const buckets = new Map<number, SyntaxError[]>();
  for (const err of syntaxErrors) {
    if (endLines.has(err.startRow)) continue;
    const loc = findLocationAtLine(locationIndex, err.startRow);
    mapPush(buckets, loc ? loc.startLine : -1, err);
  }

  for (const [key, errs] of buckets) {
    if (errs.length <= maxPerLoc) {
      for (const err of errs) {
        ctx.push(
          (err.inCodeBlock || err.inInterpolation) ? DiagnosticSeverity.Information : DiagnosticSeverity.Error,
          {
            start: { line: err.startRow, character: err.startCol },
            end: { line: err.endRow, character: err.endCol },
          },
          err.message,
        );
      }
    } else {
      const loc = locationIndex.find(l => l.startLine === key);
      const line = loc ? loc.startLine : errs[0].startRow;
      ctx.push(
        DiagnosticSeverity.Warning,
        ctx.headerRange(line),
        `Location '${loc?.name ?? '?'}' has ${errs.length} syntax errors — only non-code content?`,
      );
    }
  }
}

// ── Duplicate location names ──────────────────────────────────────────

/** Duplicate location names within a single file, and cross-file in
 *  project mode. */
export function checkDuplicateLocations(
  ctx: DiagnosticCtx,
  locationIndex: LocationEntry[],
  docUri: string,
  projectAgg?: ProjectAggregates | null,
): void {
  // Within this file
  const locGroups = new Map<string, LocationEntry[]>();
  for (const loc of locationIndex) mapPush(locGroups, loc.nameLower, loc);
  for (const [, group] of locGroups) {
    if (group.length <= 1) continue;
    for (const loc of group) {
      const others = group.filter(g => g !== loc);
      const otherLines = others.map(g => g.startLine + 1).join(', ');
      ctx.push(
        DiagnosticSeverity.Error,
        ctx.headerRange(loc.startLine),
        `Duplicate location name '${loc.name}' (also at line ${otherLines})`,
      );
    }
  }

  // Cross-file (project mode)
  if (projectAgg) {
    for (const loc of locationIndex) {
      const key = loc.nameLower;
      const otherFiles: string[] = [];
      for (const [fileUri, names] of projectAgg.perFileLocNames) {
        if (fileUri === docUri) continue;
        if (names.has(key)) otherFiles.push(uriBasename(fileUri));
      }
      if (otherFiles.length > 0) {
        ctx.push(
          DiagnosticSeverity.Error,
          ctx.headerRange(loc.startLine),
          `Duplicate location name '${loc.name}' (also defined in ${otherFiles.join(', ')})`,
        );
      }
    }
  }
}

// ── Unclosed / oversized locations ────────────────────────────────────

/** Flag locations that are missing their `---` closer, or exceed the
 *  configured maximum line count. */
export function checkLocationBounds(
  ctx: DiagnosticCtx,
  locationIndex: LocationEntry[],
): void {
  const maxLines = ctx.settings.maxLocationLines;
  if (!ctx.settings.unclosedLocations && maxLines <= 0) return;

  for (const loc of locationIndex) {
    if (ctx.settings.unclosedLocations && ctx.doc) {
      const endLineText = ctx.doc.getText({
        start: { line: loc.endLine, character: 0 },
        end: { line: loc.endLine, character: Number.MAX_SAFE_INTEGER },
      }).trimStart();
      if (!endLineText.startsWith('--')) {
        ctx.push(
          DiagnosticSeverity.Error,
          ctx.headerRange(loc.startLine),
          `Location '${loc.name}' may not be properly closed with '---'`,
        );
      }
    }
    if (maxLines > 0) {
      const lineCount = loc.endLine - loc.startLine;
      if (lineCount > maxLines) {
        ctx.push(
          DiagnosticSeverity.Warning,
          ctx.headerRange(loc.startLine),
          `Location '${loc.name}' is ${lineCount} lines long (max ${maxLines})`,
        );
      }
    }
  }
}
