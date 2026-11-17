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
  findLocationAtLine,
  type DocumentSymbols,
  type LocationEntry,
  type SymbolLocation,
  type SyntaxError,
} from '../../parser';
import type { ProjectAggregates } from '../aggregation';
import { uriBasename } from '../helpers';
import { DiagnosticCtx, mapPush } from './diagnosticHelpers';

// ── Syntax errors ─────────────────────────────────────────────────────

function blockHolds(block: SymbolLocation, err: SyntaxError): boolean {
  const startsAfter = err.startRow > block.line || (err.startRow === block.line && err.startCol >= block.column);
  const endsBefore = err.endRow < block.endLine || (err.endRow === block.endLine && err.endCol <= block.endColumn);
  return startsAfter && endsBefore;
}

/** Tree-sitter parse errors, bucketed per location.  Surfaces ERROR nodes
 *  as diagnostics; locations with too many errors get a single aggregate
 *  warning instead (likely non-code content misidentified as QSP). */
export function checkSyntaxErrors(
  ctx: DiagnosticCtx,
  docUri: string,
  locationIndex: LocationEntry[],
  fileErrors: SyntaxError[] | undefined,
  symbols?: DocumentSymbols,
  /** The `{…}` blocks something runs (see SyntaxError.inStoredBlock). */
  blocksRun: readonly SymbolLocation[] = [],
): void {
  const maxPerLoc = ctx.settings.maxErrorsPerLocation;

  let syntaxErrors = fileErrors;
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
  const version = ctx.settings.syntaxVersion;
  for (const err of syntaxErrors) {
    if (endLines.has(err.startRow)) continue;
    if (err.versions && !err.versions.includes(version)) continue;
    // A block kept in a variable is text until something runs it: games
    // keep lists of words in them (`{ apple, pear }`). Running a block
    // doesn't run the blocks inside it, so the error's own block counts.
    if (err.inStoredBlock && !blocksRun.some(b => (err.storedBlock
      ? b.line === err.storedBlock.row && b.column === err.storedBlock.col
      : blockHolds(b, err)))) continue;
    const loc = findLocationAtLine(locationIndex, err.startRow);
    mapPush(buckets, loc ? loc.startLine : -1, err);
  }

  for (const [key, errs] of buckets) {
    if (errs.length <= maxPerLoc) {
      for (const err of errs) {
        // A block's errors get here only when it runs (`dynamic {…}`, or
        // a stored block something runs): then the game fails on them.
        ctx.push(
          DiagnosticSeverity.Error,
          {
            start: { line: err.startRow, character: err.startCol },
            end: { line: err.endRow, character: err.endCol },
          },
          err.message,
          { code: 'syntax' },
        );
      }
    } else {
      const loc = locationIndex.find(l => l.startLine === key);
      const line = loc ? loc.startLine : errs[0].startRow;
      ctx.push(
        DiagnosticSeverity.Warning,
        ctx.headerRange(line),
        `Location '${loc?.name ?? '?'}' has ${errs.length} syntax errors — only non-code content?`,
        { code: 'syntax', name: loc?.name },
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
  libraryOf: (uri: string) => string | undefined = () => undefined,
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
        { code: 'duplicateLocations', name: loc.name },
      );
    }
  }

  // Cross-file (project mode)
  if (projectAgg) {
    for (const loc of locationIndex) {
      const key = loc.nameLower;
      const otherFiles: string[] = [];
      let withLibrary = libraryOf(docUri) !== undefined;
      for (const [fileUri, names] of projectAgg.perFileLocNames) {
        if (fileUri === docUri) continue;
        if (!names.has(key)) continue;
        const library = libraryOf(fileUri);
        if (library !== undefined) withLibrary = true;
        otherFiles.push(library !== undefined ? `library '${library}'` : uriBasename(fileUri));
      }
      if (otherFiles.length > 0) {
        // INCLIB skips a library location whose name the game already has,
        // and nothing at run time says so.
        const consequence = withLibrary ? '; INCLIB keeps only the first one loaded, and the game will not build' : '';
        ctx.push(
          DiagnosticSeverity.Error,
          ctx.headerRange(loc.startLine),
          `Duplicate location name '${loc.name}' (also defined in ${otherFiles.join(', ')})${consequence}`,
          { code: 'duplicateLocations', name: loc.name },
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
          { code: 'unclosedLocations', name: loc.name },
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
          { code: 'maxLocationLines', name: loc.name },
        );
      }
    }
  }
}
