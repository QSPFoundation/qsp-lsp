// ── One file's analysis ──────────────────────────────────────────────
//
// A file analysed one location at a time, like the editor does
// (locationAnalysis.ts): a closed file gets the symbols an open one does.
// Run by the project load on the main thread, or in a worker thread
// (analysisWorker.ts) and handed over in the analysis cache's form.

import {
  DocumentSymbols,
  type LocationEntry,
  type QspTreeSitterParser,
  type SyntaxError,
} from '../parser';
import { extractLocationSymbolsFromText } from './regexFallback';
import { analyzeParsedLocation } from './locationAnalysis';
import { makeLocSymLoc, shiftErrors } from './serverUtils';

/** What the analysis cache keeps for one project file, and what a worker hands over. */
export interface CachedFileAnalysis {
  symbols: DocumentSymbols;
  syntaxErrors: SyntaxError[];
}

/** How the caller follows the analysis: perf steps and the location being parsed. */
export interface FileAnalysisHooks {
  step?: <T>(name: string, fn: () => T) => T;
  /** Before each location, with its index. */
  atLocation?: (index: number) => void;
}

/** Analyse `text` location by location; `embeddedExec` also analyses the code of exec: links. */
export function analyzeFileText(
  parser: QspTreeSitterParser,
  uri: string,
  text: string,
  locationIndex: readonly LocationEntry[],
  embeddedExec: boolean,
  hooks: FileAnalysisHooks = {},
): CachedFileAnalysis {
  const step = hooks.step ?? (<T>(_name: string, fn: () => T) => fn());
  const symbols = new DocumentSymbols(uri);
  const syntaxErrors: SyntaxError[] = [];
  for (const [i, loc] of locationIndex.entries()) {
    hooks.atLocation?.(i);
    const locText = text.slice(loc.startOffset, loc.endOffset);
    const locLoc = makeLocSymLoc(uri, text, loc);
    const tree = step('parse', () => parser.parseOnce(locText));
    if (tree) {
      let parsed: ReturnType<typeof analyzeParsedLocation>;
      try {
        parsed = analyzeParsedLocation(
          tree, uri, loc.name, locText,
          embeddedExec ? (t) => parser.parseOnce(t) : undefined,
          step,
        );
      } finally {
        tree.delete();
      }
      shiftErrors(parsed.errors, loc.startLine, syntaxErrors);
      step('copy into file', () => symbols.addLocationFrom(loc.name, locLoc, parsed.symbols, loc.startLine));
    } else {
      // Tree-sitter failed (timeout) for this one location — fall
      // back to regex extraction for just that location.
      const locSymbols = symbols.addLocation(loc.name, locLoc);
      extractLocationSymbolsFromText(text, loc, locSymbols, uri);
    }
  }
  symbols.rebuildGlobalBindings();
  return { symbols, syntaxErrors };
}
