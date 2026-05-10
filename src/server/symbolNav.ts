/**
 * Symbol resolution and reference collection for LSP navigation features.
 *
 * Pure functions — no `Connection` dependency, directly unit-testable.
 * Shared between definition/reference/rename handlers.
 *
 * Exported:
 *   • `resolveDefinition`               — go-to-definition resolver
 *   • `collectAllReferences`            — unified reference collector
 *   • `resolvePrepareRename`            — rename preparation
 *   • `buildRenameEdit`                 — WorkspaceEdit from references
 *   • `findLabelHighlightsInLocation`   — label/jump highlight ranges
 *   • `collectProjectVariables`         — flatten per-location vars
 */
import {
  DocumentHighlight,
  DocumentHighlightKind,
} from 'vscode-languageserver';
import type {
  Location,
  Position,
  Range,
  TextEdit,
  WorkspaceEdit,
} from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import {
  findLocationAtLine,
  lookupBuiltin,
  QSP_VARIABLES,
} from '../parser';
import type {
  DocumentSymbols,
  LocationSymbols,
  QspSymbol,
  SymbolLocation,
} from '../parser';
import { buildFileAggregates } from './aggregation';
import type {
  ServerContext,
  DocumentState,
  ProjectVariableItem,
} from './featureTypes';

// ──────────────────────────────────────────────────────────────────────
// Module-level constants
// ──────────────────────────────────────────────────────────────────────

const BUILTIN_VAR_NAMES: ReadonlySet<string> = new Set(
  QSP_VARIABLES.map(v => v.name.toLowerCase()),
);

// ──────────────────────────────────────────────────────────────────────
// Coordinate helpers
// ──────────────────────────────────────────────────────────────────────

function symToRange(loc: SymbolLocation): Range {
  return {
    start: { line: loc.line, character: loc.column },
    end: { line: loc.endLine, character: loc.endColumn },
  };
}

function symToLocation(loc: SymbolLocation): Location {
  return { uri: loc.uri, range: symToRange(loc) };
}

// ──────────────────────────────────────────────────────────────────────
// Word-at-cursor
// ──────────────────────────────────────────────────────────────────────

const SPACED_STATEMENTS_RE = /(?:add obj|del obj|del act|mod obj|close all)/gi;

function getWordInfo(doc: TextDocument, pos: Position): { word: string; hasTypePrefix: boolean; range: Range } | null {
  const line = doc.getText({
    start: { line: pos.line, character: 0 },
    end: { line: pos.line, character: Number.MAX_SAFE_INTEGER },
  });

  let m: RegExpExecArray | null;
  SPACED_STATEMENTS_RE.lastIndex = 0;
  while ((m = SPACED_STATEMENTS_RE.exec(line)) !== null) {
    if (pos.character >= m.index && pos.character <= m.index + m[0].length) {
      return {
        word: m[0].toLowerCase(),
        hasTypePrefix: false,
        range: {
          start: { line: pos.line, character: m.index },
          end: { line: pos.line, character: m.index + m[0].length },
        },
      };
    }
  }

  const re = /[*$#%]?[\p{L}_][\p{L}\p{N}_.]*/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (pos.character >= start && pos.character <= end) {
      const raw = match[0];
      const range: Range = {
        start: { line: pos.line, character: start },
        end: { line: pos.line, character: end },
      };
      if (/^[$#%]/.test(raw)) return { word: raw.slice(1), hasTypePrefix: true, range };
      return { word: raw, hasTypePrefix: false, range };
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Search scope + lookups
// ──────────────────────────────────────────────────────────────────────

/**
 * Symbol kinds whose references never cross file boundaries. For these,
 * reference/definition lookups must use the current file's state only,
 * regardless of project mode — their identity is tied to per-file data
 * (e.g. a label's `scopeId` is a tree-sitter node id meaningful only in
 * the file where the parse tree was produced).
 */
const FILE_LOCAL_KINDS: ReadonlySet<string> = new Set(['label']);

function getSearchStates(ctx: ServerContext, currentState: DocumentState): DocumentState[] {
  if (ctx.settings.project.enabled) {
    const states: DocumentState[] = [];
    for (const uri of ctx.projectFileUris) {
      const st = ctx.documentStates.get(uri);
      if (st) states.push(st);
    }
    return states;
  }
  return [currentState];
}

/**
 * Search states scoped to the symbol's reach: file-local kinds resolve
 * only against the current file; everything else follows project mode.
 */
function getSearchStatesForSymbol(
  ctx: ServerContext,
  currentState: DocumentState,
  kind: string,
): DocumentState[] {
  if (FILE_LOCAL_KINDS.has(kind)) return [currentState];
  return getSearchStates(ctx, currentState);
}

function findActionDef(name: string, states: DocumentState[]): { def: SymbolLocation; symbol: QspSymbol } | undefined {
  const key = name.toLowerCase();
  for (const st of states) {
    for (const [, locSyms] of st.symbols.locations) {
      for (const act of locSyms.actions) {
        if (act.nameLower === key && act.definition) {
          return { def: act.definition, symbol: act };
        }
      }
    }
  }
  return undefined;
}

function findObjectDef(name: string, states: DocumentState[]): SymbolLocation | undefined {
  const key = name.toLowerCase();
  for (const st of states) {
    for (const [, locSyms] of st.symbols.locations) {
      const objSym = locSyms.objectRefs.get(key);
      if (objSym?.definition) return objSym.definition;
    }
  }
  return undefined;
}

function findLocationDef(ctx: ServerContext, name: string, currentState: DocumentState): QspSymbol | undefined {
  const key = name.toLowerCase();
  const local = currentState.symbols.locationDefs.get(key);
  if (local) return local;
  if (ctx.projectAggregates) {
    const projEntry = ctx.projectAggregates.locationDefs.get(key);
    if (projEntry) return projEntry.symbol;
  }
  return undefined;
}

function getOrBuildAgg(ctx: ServerContext, state: DocumentState, uri: string): import('./aggregation').SymbolAggregates {
  if (ctx.projectAggregates) return ctx.projectAggregates;
  if (state.aggCache) return state.aggCache;
  state.aggCache = buildFileAggregates(state.symbols, uri);
  return state.aggCache;
}

// ──────────────────────────────────────────────────────────────────────
// Symbol reference resolution
// ──────────────────────────────────────────────────────────────────────

function resolveSymbolRefs(
  state: DocumentState,
  sym: { kind: string; name: string; scopeId?: number },
  line: number,
): SymbolLocation[] {
  switch (sym.kind) {
    case 'action': return state.symbols.findActionReferences(sym.name);
    case 'object': return state.symbols.findObjectReferences(sym.name);
    case 'location': return state.symbols.findLocationReferences(sym.name);
    case 'label': {
      const loc = findLocationAtLine(state.locationIndex, line);
      if (!loc) return [];
      // `sym.scopeId` was captured by `findSymbolAtPosition` from the
      // label ref/def under the cursor, so we know the namespace to
      // search without a second hit-test pass.
      return state.symbols.findLabelReferences(sym.name, loc.name, sym.scopeId ?? 0);
    }
    default: return [];
  }
}

// ──────────────────────────────────────────────────────────────────────
// resolveDefinition
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve the "go to definition" target for a cursor position.
 * Returns a single Location, an array of Locations (ambiguous), or null.
 */
export function resolveDefinition(
  ctx: ServerContext,
  state: DocumentState,
  docUri: string,
  position: Position,
  doc: TextDocument,
): Location | Location[] | null {
  const curLoc = findLocationAtLine(state.locationIndex, position.line);
  const sym = state.symbols.findSymbolAtPosition(
    position.line, position.character, curLoc?.name,
  );
  if (sym) {
    switch (sym.kind) {
      case 'location': {
        const ld = findLocationDef(ctx, sym.name, state);
        if (ld?.definition) return symToLocation(ld.definition);
        break;
      }
      case 'action': {
        const actResult = findActionDef(sym.name, getSearchStates(ctx, state));
        if (actResult) return symToLocation(actResult.def);
        break;
      }
      case 'object': {
        const objDef = findObjectDef(sym.name, getSearchStates(ctx, state));
        if (objDef) return symToLocation(objDef);
        break;
      }
      case 'label': {
        if (curLoc) {
          const locSyms = state.symbols.getLocation(curLoc.name);
          // `sym.scopeId` is the scope of the matched label ref/def
          // under the cursor — pass it directly to resolve in the
          // correct namespace.
          const lbl = locSyms?.getLabel(sym.name, sym.scopeId ?? 0);
          if (lbl?.definition) return { uri: docUri, range: symToRange(lbl.definition) };
        }
        break;
      }
    }
  }

  const wi = getWordInfo(doc, position);
  if (!wi) return null;
  const word = wi.word;

  const locDef = findLocationDef(ctx, word, state);
  if (locDef?.definition) return symToLocation(locDef.definition);

  if (curLoc) {
    const locSyms = state.symbols.getLocation(curLoc.name);
    if (locSyms) {
      const varSym = locSyms.findVariableAtPosition(word.toLowerCase(), position.line, position.character);
      if (varSym) {
        if (!varSym.isLocal) {
          const agg = getOrBuildAgg(ctx, state, docUri);
          const locKey = curLoc.name.toLowerCase();
          const providers = agg.propagatedLocals.get(locKey)?.get(varSym.nameLower);
          if (providers && providers.length > 0) {
            const defs = providers
              .filter(p => p.sym.definition)
              .map(p => ({ uri: p.providerUri, range: symToRange(p.sym.definition!) }));
            if (defs.length === 1) return defs[0];
            if (defs.length > 1) return defs;
          }
        }

        if (varSym.definition) return { uri: docUri, range: symToRange(varSym.definition) };

        if (!varSym.isLocal) {
          const searchStates = getSearchStates(ctx, state);
          const defs: Location[] = [];
          const varNameLower = word.toLowerCase();
          for (const st of searchStates) {
            for (const [, ls] of st.symbols.locations) {
              const otherVar = ls.variables.get(varNameLower);
              if (otherVar?.definition) defs.push(symToLocation(otherVar.definition));
            }
          }
          if (defs.length === 1) return defs[0];
          if (defs.length > 1) return defs;
        }
      }

      const entry = locSyms.findLabelEntryAtPosition(position.line, position.character);
      const label = entry
        ? locSyms.labels.get(entry.namespace)?.get(entry.name)
        : locSyms.labels.get(0)?.get(word.toLowerCase());
      if (label?.definition) return { uri: docUri, range: symToRange(label.definition) };
    }
  }

  return null;
}

// ──────────────────────────────────────────────────────────────────────
// collectAllReferences
// ──────────────────────────────────────────────────────────────────────

/**
 * Collect every reference (including cross-file and propagated-local refs)
 * that should be returned for a given cursor position.
 */
export function collectAllReferences(
  ctx: ServerContext,
  state: DocumentState,
  docUri: string,
  position: Position,
  doc: TextDocument,
): SymbolLocation[] {
  const out: SymbolLocation[] = [];
  const curLoc = findLocationAtLine(state.locationIndex, position.line);
  const sym = state.symbols.findSymbolAtPosition(position.line, position.character, curLoc?.name);

  if (sym) {
    for (const st of getSearchStatesForSymbol(ctx, state, sym.kind)) {
      for (const r of resolveSymbolRefs(st, sym, position.line)) out.push(r);
    }
    if (out.length > 0) return out;
  }

  const wi = getWordInfo(doc, position);
  if (!wi) return out;
  const wordLower = wi.word.toLowerCase();

  const searchStates = getSearchStates(ctx, state);
  for (const st of searchStates) {
    for (const r of st.symbols.findLocationReferences(wi.word)) out.push(r);
  }

  const currentLocSyms = curLoc ? state.symbols.getLocation(curLoc.name) : undefined;
  const exactVarSym = currentLocSyms?.findVariableAtPosition(wordLower, position.line, position.character);

  const pushPropagatedTargetsOf = (localSym: QspSymbol) => {
    const agg = getOrBuildAgg(ctx, state, docUri);
    for (const [targetLoc, targetVars] of agg.propagatedLocals) {
      const providers = targetVars.get(localSym.nameLower);
      if (!providers?.some(p => p.sym === localSym)) continue;
      for (const st of searchStates) {
        const tLocSyms = st.symbols.getLocation(targetLoc);
        const tSym = tLocSyms?.findVariable(localSym.nameLower);
        if (tSym) for (const r of tSym.references) out.push(r);
      }
    }
  };

  const pushAllGlobalsWithName = () => {
    for (const st of searchStates) {
      for (const [, locSyms] of st.symbols.locations) {
        for (const v of locSyms.findAllVariables(wordLower)) {
          if (v.isLocal) continue;
          for (const r of v.references) out.push(r);
        }
      }
    }
  };

  if (exactVarSym?.isLocal) {
    for (const r of exactVarSym.references) out.push(r);
    if (exactVarSym.definition) pushPropagatedTargetsOf(exactVarSym);
  } else if (exactVarSym && !exactVarSym.isLocal) {
    const agg = getOrBuildAgg(ctx, state, docUri);
    const providers = curLoc
      ? agg.propagatedLocals.get(curLoc.name.toLowerCase())?.get(exactVarSym.nameLower)
      : undefined;
    if (providers && providers.length > 0) {
      for (const r of exactVarSym.references) out.push(r);
      for (const p of providers) {
        for (const r of p.sym.references) out.push(r);
        pushPropagatedTargetsOf(p.sym);
      }
    } else {
      pushAllGlobalsWithName();
    }
  } else {
    pushAllGlobalsWithName();
  }

  if (curLoc) {
    // Word-based fallback: derive the cursor's label namespace from a
    // ref/def under the caret if any, else default to root scope.
    const locSyms = state.symbols.getLocation(curLoc.name);
    const entry = locSyms?.findLabelEntryAtPosition(position.line, position.character);
    const scopeId = entry?.namespace ?? 0;
    for (const r of state.symbols.findLabelReferences(wi.word, curLoc.name, scopeId)) out.push(r);
  }

  return out;
}

// ──────────────────────────────────────────────────────────────────────
// resolvePrepareRename
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve the rename range for `onPrepareRename`. Returns null when the
 * cursor is on a builtin or a position with no renamable token.
 */
export function resolvePrepareRename(
  state: DocumentState | undefined,
  doc: TextDocument,
  position: Position,
): Range | null {
  if (state) {
    const curLoc = findLocationAtLine(state.locationIndex, position.line);
    const sym = state.symbols.findSymbolAtPosition(
      position.line, position.character, curLoc?.name,
    );
    if (sym) {
      const refs = resolveSymbolRefs(state, sym, position.line);
      for (const ref of refs) {
        if (ref.line === position.line &&
            position.character >= ref.column &&
            position.character <= ref.endColumn) {
          return symToRange(ref);
        }
      }
    }
  }

  const wi = getWordInfo(doc, position);
  if (!wi) return null;

  const word = doc.getText(wi.range);
  if (lookupBuiltin(word)) return null;

  if (/^[$#%]/.test(word)) {
    return {
      start: { line: wi.range.start.line, character: wi.range.start.character + 1 },
      end: wi.range.end,
    };
  }

  return wi.range;
}

// ──────────────────────────────────────────────────────────────────────
// buildRenameEdit
// ──────────────────────────────────────────────────────────────────────

/**
 * Build a WorkspaceEdit renaming every reference returned by
 * `collectAllReferences` to `newName`.
 */
export function buildRenameEdit(
  ctx: ServerContext,
  state: DocumentState,
  docUri: string,
  position: Position,
  doc: TextDocument,
  newName: string,
): WorkspaceEdit | null {
  const refs = collectAllReferences(ctx, state, docUri, position, doc);
  if (refs.length === 0) return null;

  const changes: Record<string, TextEdit[]> = {};
  for (const ref of refs) {
    const uri = ref.uri;
    if (!changes[uri]) changes[uri] = [];
    changes[uri].push({
      range: symToRange(ref),
      newText: newName,
    });
  }
  return { changes };
}

// ──────────────────────────────────────────────────────────────────────
// findLabelHighlightsInLocation
// ──────────────────────────────────────────────────────────────────────

/**
 * Compute document-highlight ranges for a jump / label when the cursor
 * lies on a label definition (`:name`) or a jump reference (`jump 'name'`).
 *
 * Returns `null` when the cursor is not on a label or jump.
 */
export function findLabelHighlightsInLocation(
  locSyms: LocationSymbols,
  line: number,
  col: number,
): DocumentHighlight[] | null {
  const entry = locSyms.findLabelEntryAtPosition(line, col);
  if (!entry) return null;

  const highlights: DocumentHighlight[] = [];
  for (const [sym, kind] of [
    [locSyms.labels.get(entry.namespace)?.get(entry.name), DocumentHighlightKind.Text],
    [locSyms.labelRefs.get(entry.namespace)?.get(entry.name), DocumentHighlightKind.Write],
  ] as [QspSymbol | undefined, DocumentHighlightKind][]) {
    if (!sym) continue;
    for (const ref of sym.references) {
      highlights.push(DocumentHighlight.create(
        {
          start: { line: ref.line, character: ref.column },
          end: { line: ref.endLine, character: ref.endColumn },
        },
        kind,
      ));
    }
  }
  return highlights.length > 0 ? highlights : null;
}

// ──────────────────────────────────────────────────────────────────────
// collectProjectVariables
// ──────────────────────────────────────────────────────────────────────

/**
 * Flatten per-location variable maps from one or more files into a single
 * de-duplicated, alphabetically sorted list suitable for `qsp/listVariables`.
 */
export function collectProjectVariables(
  filesSymbols: Iterable<DocumentSymbols>,
): ProjectVariableItem[] {
  // Globals across files are deduped by base name (first writer wins).
  // Locals are deduped by symbol identity \u2014 each owned QspSymbol is
  // a distinct declaration, even when two files reuse the same name
  // and scope id.
  const globalEntries = new Map<string, ProjectVariableItem>();
  const localEntries = new Map<QspSymbol, ProjectVariableItem>();
  const globalNames = new Set<string>();
  const pending = new Map<string, Array<{ sym: QspSymbol; item: ProjectVariableItem }>>();

  for (const symbols of filesSymbols) {
    for (const [, locSyms] of symbols.locations) {
      for (const sym of locSyms.ownedVariables) {
        const nameLower = sym.nameLower;
        if (BUILTIN_VAR_NAMES.has(nameLower)) continue;
        const loc = sym.definition ?? sym.references[0];
        if (!loc) continue;

        const item: ProjectVariableItem = {
          name: sym.name, uri: loc.uri, line: loc.line,
          isDefined: !!sym.definition, isLocal: sym.isLocal,
          prefixes: sym.prefixes ? [...sym.prefixes] : [],
        };

        if (!sym.isLocal) {
          if (globalEntries.has(nameLower)) continue;
          globalEntries.set(nameLower, item);
          globalNames.add(nameLower);
          const waiters = pending.get(nameLower);
          if (waiters) {
            for (const w of waiters) localEntries.set(w.sym, w.item);
            pending.delete(nameLower);
          }
        } else if (globalNames.has(nameLower)) {
          localEntries.set(sym, item);
        } else {
          let waiters = pending.get(nameLower);
          if (!waiters) { waiters = []; pending.set(nameLower, waiters); }
          waiters.push({ sym, item });
        }
      }
    }
  }

  const items = [...globalEntries.values(), ...localEntries.values()];
  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return items;
}
