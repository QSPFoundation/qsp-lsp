/**
 * Shared helpers for diagnostic passes.
 *
 * Each diagnostic pass takes a `DiagnosticCtx` carrying the push/range
 * helpers it needs, plus a subset of the full inputs.  This keeps every
 * pass self-documenting about which data it actually consumes.
 */


import {
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticTag,
  type Range,
} from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';

/**
 * Everything a diagnostic pass needs to emit diagnostics.
 * All the "how to build and push" infrastructure is here;
 * the "what to check" data is passed separately per pass.
 */
export class DiagnosticCtx {
  readonly doc: TextDocument | null;
  readonly settings: import('../diagnostics').DiagnosticSettings;
  private readonly _diagnostics: Diagnostic[];

  constructor(
    doc: TextDocument | null,
    settings: import('../diagnostics').DiagnosticSettings,
  ) {
    this.doc = doc;
    this.settings = settings;
    this._diagnostics = [];
  }

  /** Collect the built diagnostics. */
  results(): Diagnostic[] { return this._diagnostics; }

  /** Length of a line; reasonable fallback when `doc` is null. */
  lineLength(line: number): number {
    if (!this.doc) return 200;
    return this.doc.getText({
      start: { line, character: 0 },
      end: { line, character: Number.MAX_SAFE_INTEGER },
    }).length;
  }

  /** Range over a `SymbolLocation`-shaped value. */
  locRange(l: { line: number; column: number; endLine: number; endColumn: number }): Range {
    return {
      start: { line: l.line, character: l.column },
      end: { line: l.endLine, character: l.endColumn },
    };
  }

  /** Full-line range used for location-header diagnostics. */
  headerRange(line: number): Range {
    return {
      start: { line, character: 0 },
      end: { line, character: this.lineLength(line) },
    };
  }

  push(
    severity: DiagnosticSeverity,
    range: Range,
    message: string,
    unnecessary = false,
    deprecated = false,
  ): void {
    const d: Diagnostic = { severity, range, message, source: 'qsp' };
    const tags: DiagnosticTag[] = [];
    if (unnecessary) tags.push(DiagnosticTag.Unnecessary);
    if (deprecated) tags.push(DiagnosticTag.Deprecated);
    if (tags.length) d.tags = tags;
    this._diagnostics.push(d);
  }
}

/** Push `value` into the array stored at `key`, creating the array on first use. */
export function mapPush<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  let arr = map.get(key);
  if (!arr) { arr = []; map.set(key, arr); }
  arr.push(value);
}
