/**
 * Shared utility functions for the QSP language server.
 *
 * These are pure helpers that operate on text and AST data,
 * independent of the LSP connection lifecycle or document state.
 */


import { type LocationEntry, type SyntaxError } from '../parser';
import { locationNameCol } from './regexFallback';
import { type SymbolLocation } from '../parser';

/**
 * File-system provider for project mode.
 * Only available in the Node.js server — browser has no direct FS access.
 */
export interface FsProvider {
  /** Read a file as text, decoded according to the given encoding. */
  readFile(filePath: string, encoding?: string): string;
  /** List all files matching glob patterns in a directory (recursive). */
  findFiles(dir: string, extensions: string[]): string[];
  /** Convert a file path to a URI string. */
  pathToUri(filePath: string): string;
  /** Convert a URI string to a file path. */
  uriToPath(uri: string): string;
}

/**
 * File extensions recognised as QSP source files.
 * Must stay in sync with contributes.languages[].extensions in package.json.
 */
export const QSP_FILE_EXTENSIONS = ['.qsps', '.qsrc'];

/** Strip a UTF-8 BOM (U+FEFF) from the start of a string if present. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

/** Shift local-coordinate errors to absolute coordinates. */
export function shiftErrors(errors: SyntaxError[], lineOffset: number, out: SyntaxError[]): void {
  for (const err of errors) {
    out.push({ ...err, startRow: err.startRow + lineOffset, endRow: err.endRow + lineOffset });
  }
}

/** Build the `SymbolLocation` for a location header, used by both the
 *  full-tree and per-location analysis paths. */
export function makeLocSymLoc(uri: string, text: string, loc: LocationEntry): SymbolLocation {
  const nameCol = locationNameCol(text, loc);
  return {
    uri,
    line: loc.startLine,
    column: nameCol,
    endLine: loc.startLine,
    endColumn: nameCol + loc.name.length,
  };
}
