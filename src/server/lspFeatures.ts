/**
 * LSP feature handler registration (completions, hover, definition,
 * references, rename, document symbols, semantic tokens, code actions,
 * folding, highlighting, formatting, custom requests).
 *
 * All shared state is accessed via the `ServerContext` interface (defined
 * in `featureTypes.ts`).  Pure helpers live in `hoverHelpers.ts`.
 */
import {
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  CompletionItem,
  CompletionItemKind,
  DocumentFormattingParams,
  FoldingRange,
  FoldingRangeKind,
  FoldingRangeParams,
  Hover,
  MarkupKind,
  Range,
  RenameParams,
  SemanticTokensParams,
  SemanticTokensRangeParams,
  SemanticTokensRequest,
  SemanticTokensRangeRequest,
  SymbolKind,
  TextDocumentPositionParams,
  TextEdit,
  WorkspaceEdit,
} from 'vscode-languageserver';
import type { DocumentSymbol } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import {
  ALL_BUILTINS,
  findBlockKeywordRanges,
  findLocationAtLine,
  lookupBuiltin,
  type DocumentSymbols,
  type QspSymbol,
  type SymbolLocation,
  getPossibleValuesAtCursor,
  resolvePossibleValuesInDocument,
  resolvePossibleValuesAcrossProject,
} from '../parser';
import type {
  SymbolAggregates,
} from './aggregation';
import { fileAggregates } from './aggregation';
import { buildLocationIndex } from '../common/locations';
import { formatLines, getWordInfo, inferIndentLevel, startsWithKeyword, uriBasename as basename } from './helpers';
import { locationNameCol } from './regexFallback';
import { perLocationCacheKeys } from './serverUtils';
import { buildSuppressionActions } from './suppressionActions';
import {
  detectEol,
  buildExtractToLocationEdit,
  buildWrapEdit,
  buildInlineToBlockEdit,
  isBlockKeywordLine,
} from './codeActions';
import {
  buildPossibleValuesLines,
  buildCallerLines,
  buildJumperLines,
  buildConsumedLocalsLine,
  buildUsedGlobalsSection,
} from './hoverHelpers';
import type { BuildPossibleValuesOptions } from './hoverHelpers';
import {
  resolveDefinition,
  resolvePrepareRename,
  collectAllReferences,
  buildRenameEdit,
  findLabelHighlightsInLocation,
  collectProjectVariables,
} from './symbolNav';
import type {
  DocumentState,
  FeatureSettings,
  ServerContext,
  PerLocationParseResult,
} from './featureTypes';
import type { ProjectVariableItem, TokenFacts } from './featureTypes';
import { textArgBlocks } from '../parser/argBlocks';
import { TextBlocks, locationNamedIn } from './textBlocks';
import { textStoredBlocks } from '../parser/storedBlocks';
import { buildJumpGraph, formatDynamicJumpStats, newDynamicJumpStats, type JumpGraphSource } from './jumpGraph';

// Re-export types that consumers need
export type {
  DocumentState,
  FeatureSettings,
  ServerContext,
  PerLocationParseResult,
  ProjectVariableItem,
};

// Re-export pure helpers used by tests
export {
  buildPossibleValuesLines,
  buildCallerLines,
  buildJumperLines,
  buildConsumedLocalsLine,
  buildUsedGlobalsSection,
  resolveDefinition,
  resolvePrepareRename,
  collectAllReferences,
  buildRenameEdit,
  findLabelHighlightsInLocation,
  collectProjectVariables,
};
export type { BuildPossibleValuesOptions };

// ──────────────────────────────────────────────────────────────────────

// Coordinate helpers (file-private)
// ──────────────────────────────────────────────────────────────────────

function symToRange(loc: SymbolLocation): Range {
  return {
    start: { line: loc.line, character: loc.column },
    end: { line: loc.endLine, character: loc.endColumn },
  };
}

function symToLocation(loc: SymbolLocation): import('vscode-languageserver').Location {
  return { uri: loc.uri, range: symToRange(loc) };
}

// ──────────────────────────────────────────────────────────────────────
// Document outline (textDocument/documentSymbol)
// ──────────────────────────────────────────────────────────────────────

/**
 * Build the outline tree for a document: one Namespace entry per
 * location, with label and `act` children.
 *
 * Invariant required by VS Code: `selectionRange` must be fully
 * contained in `range`.  Two traps guard against violating it:
 *   1. An unclosed location whose header sits on the last line of the
 *      file has `endLine === startLine`, so a `[startLine,0]–[endLine,0]`
 *      full range would be empty and exclude the name.  Extend the end
 *      to cover the selection in that case.
 *   2. The location name doesn't always start at column 2 — `#name`
 *      and `#   name` are both valid headers.  `locationNameCol`
 *      finds the real column from the document text when available.
 */
export function buildOutlineSymbols(
  state: DocumentState,
  doc?: TextDocument,
): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];
  const text = doc?.getText();
  for (const loc of state.locationIndex) {
    // Fall back to column 1 (right after `#`) when the text isn't
    // available.
    const nameCol = text !== undefined ? locationNameCol(text, loc) : 1;
    const selectionRange: Range = {
      start: { line: loc.startLine, character: nameCol },
      end: { line: loc.startLine, character: nameCol + loc.name.length },
    };
    const locRange: Range = {
      start: { line: loc.startLine, character: 0 },
      end: loc.endLine > loc.startLine
        ? { line: loc.endLine, character: 0 }
        : selectionRange.end,
    };
    const children: DocumentSymbol[] = [];
    const locSyms = state.symbols.getLocation(loc.name);
    if (locSyms) {
      // Emit one outline entry per label definition site, including
      // duplicate names that live in distinct namespaces (e.g. an
      // act-internal `:foo` plus a root `:foo`).
      for (const label of locSyms.allLabelSymbols()) {
        for (const def of label.references) {
          const r = symToRange(def);
          children.push({ name: ':' + label.name, kind: SymbolKind.Key, range: r, selectionRange: r });
        }
      }
      for (const act of locSyms.actions) {
        if (act.definition) {
          children.push({
            name: 'act ' + act.name,
            kind: SymbolKind.Event,
            range: symToRange(act.blockRange ?? act.definition),
            selectionRange: symToRange(act.definition),
          });
        }
      }
    }
    symbols.push({
      name: loc.name, kind: SymbolKind.Namespace, range: locRange,
      selectionRange,
      children,
    });
  }
  return symbols;
}

// ──────────────────────────────────────────────────────────────────────
// cross-file lookups (file-private)
// ──────────────────────────────────────────────────────────────────────

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

function findActionDef(name: string, states: DocumentState[]):
  { def: SymbolLocation; symbol: QspSymbol } | undefined {
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

/** Lazily build or reuse aggregates. */
function getOrBuildAgg(ctx: ServerContext, state: DocumentState, uri: string): SymbolAggregates {
  if (ctx.projectAggregates) return ctx.projectAggregates;
  return fileAggregates(state, uri);
}

// ──────────────────────────────────────────────────────────────────────
// Main registration function
// ──────────────────────────────────────────────────────────────────────

/**
 * Register all LSP feature handlers on the given connection.
 */
export function registerLspFeatures(ctx: ServerContext): void {
  const { connection, documents, documentStates, tsParser } = ctx;

  // ==================== COMPLETIONS ======================================

  const BUILTIN_COMPLETIONS: CompletionItem[] = ALL_BUILTINS.map(builtin => ({
    label: builtin.name,
    kind: builtin.kind === 'variable'
      ? CompletionItemKind.Variable
      : CompletionItemKind.Function,
    detail: builtin.signature ?? builtin.description,
    documentation: {
      kind: MarkupKind.Markdown,
      value: `**${builtin.name}** — ${builtin.description}${builtin.signature ? `\n\n\`${builtin.signature}\`` : ''}`,
    },
  }));

  connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const items: CompletionItem[] = [...BUILTIN_COMPLETIONS];

    const state = documentStates.get(params.textDocument.uri);
    if (!state) return items;

    const addedLocs = new Set<string>();
    const addedVars = new Set<string>();
    const searchStates = getSearchStates(ctx, state);
    const currentLoc = findLocationAtLine(state.locationIndex, params.position.line);
    const currentLocName = currentLoc?.name;

    for (const st of searchStates) {
      const isOtherFile = st !== state;
      for (const loc of st.locationIndex) {
        if (addedLocs.has(loc.nameLower)) continue;
        addedLocs.add(loc.nameLower);
        const fileLabel = isOtherFile ? ` [${basename(st.symbols.uri)}]` : '';
        items.push({
          label: loc.name,
          kind: CompletionItemKind.Module,
          detail: `Location (line ${loc.startLine + 1})${fileLabel}`,
        });
      }
      for (const [, locSyms] of st.symbols.locations) {
        for (const sym of locSyms.ownedVariables) {
          if (sym.isLocal && (isOtherFile || locSyms.locationName !== currentLocName)) continue;
          if (addedVars.has(sym.nameLower)) continue;
          addedVars.add(sym.nameLower);
          items.push({
            label: sym.name,
            kind: CompletionItemKind.Variable,
            detail: `${sym.isLocal ? 'local ' : ''}variable`,
          });
        }
      }
    }

    if (currentLocName) {
      const agg = getOrBuildAgg(ctx, state, params.textDocument.uri);
      const propVars = agg.propagatedLocals.get(currentLocName.toLowerCase());
      if (propVars) {
        for (const [varName, providers] of propVars) {
          if (addedVars.has(varName)) continue;
          addedVars.add(varName);
          const providerNames = providers.map(p => p.providerLoc).join(', ');
          items.push({
            label: providers[0].sym.name,
            kind: CompletionItemKind.Variable,
            detail: `local variable (from ${providerNames})`,
          });
        }
      }
    }
    return items;
  });

  connection.onCompletionResolve(item => item);

  // ==================== HOVER ====================

  connection.onHover((params): Hover | null => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const uri = params.textDocument.uri;
    const state = documentStates.get(uri);
    if (new TextBlocks(documentStates, runVariablesOf).holds(uri, params.position.line, params.position.character)) return null;

    function getAgg(): SymbolAggregates {
      return getOrBuildAgg(ctx, state!, uri);
    }

    if (state) {
      const curLoc = findLocationAtLine(state.locationIndex, params.position.line);
      const sym = state.symbols.findSymbolAtPosition(
        params.position.line, params.position.character, curLoc?.name,
      );
      if (sym) {
        let hoverText: string | null = null;
        switch (sym.kind) {
          case 'action': {
            const actResult = findActionDef(sym.name, getSearchStates(ctx, state));
            if (actResult) {
              const fileInfo = actResult.def.uri !== uri ? ` [${basename(actResult.def.uri)}]` : '';
              hoverText = `**Action** \`${sym.name}\` — defined at line ${actResult.def.line + 1}${fileInfo}`;
            } else { hoverText = `**Action** \`${sym.name}\``; }
            break;
          }
          case 'object': {
            const objDef = findObjectDef(sym.name, getSearchStates(ctx, state));
            if (objDef) {
              const fileInfo = objDef.uri !== uri ? ` [${basename(objDef.uri)}]` : '';
              hoverText = `**Object** \`${sym.name}\` — added at line ${objDef.line + 1}${fileInfo}`;
            } else { hoverText = `**Object** \`${sym.name}\``; }
            break;
          }
          case 'location': {
            const locDef = findLocationDef(ctx, sym.name, state);
            if (locDef) {
              const fInfo = locDef.definition?.uri && locDef.definition.uri !== uri
                ? ` [${basename(locDef.definition.uri)}]` : '';
              const locLines: string[] = [];
              if (curLoc) {
                const curLocSyms = state.symbols.getLocation(curLoc.name);
                const locRef = curLocSyms?.locationRefs.get(sym.name.toLowerCase());
                if (locRef) {
                  const ref = locRef.references.find(r =>
                    r.line <= params.position.line && r.endLine >= params.position.line &&
                    (r.line < params.position.line || r.column <= params.position.character) &&
                    (r.endLine > params.position.line || r.endColumn >= params.position.character),
                  );
                  if (ref?.localsInScope && ref.localsInScope.size > 0) {
                    const localsList = [...ref.localsInScope.keys()].map(l => `\`${l}\``).join(', ');
                    locLines.push(`This call passes locals: ${localsList}`, '');
                  }
                }
              }
              locLines.push(`**Location** \`${locDef.name}\` — line ${(locDef.definition?.line ?? 0) + 1}${fInfo}`);
              const hoverMax = ctx.settings.hover.maxItemsPerCategory;
              buildCallerLines(documentStates, locDef.name.toLowerCase(), '**Called from:**', uri, locLines, hoverMax);
              buildJumperLines(documentStates, locDef.name.toLowerCase(), '**Navigated from:**', uri, locLines, hoverMax);
              buildConsumedLocalsLine(documentStates, getAgg(), locDef.name.toLowerCase(), '**Consumes locals:**', locLines);
              buildUsedGlobalsSection(documentStates, getAgg(), locDef.name.toLowerCase(), '**Uses globals:**', locLines, hoverMax);
              hoverText = locLines.join('\n');
            }
            break;
          }
          case 'label': {
            if (curLoc) {
              const locSyms = state.symbols.getLocation(curLoc.name);
              // `sym.scopeId` is the namespace of the label ref/def
              // under the cursor (set by `findSymbolAtPosition`).
              const label = locSyms?.getLabel(sym.name, sym.scopeId ?? 0);
              if (label?.definition) {
                hoverText = `**Label** \`:${sym.name}\` — line ${label.definition.line + 1}`;
              }
            }
            if (!hoverText) hoverText = `**Label** \`:${sym.name}\``;
            break;
          }
        }
        if (hoverText) return { contents: { kind: MarkupKind.Markdown, value: hoverText } };
      }
    }

    const wi = getWordInfo(doc, params.position);
    if (!wi) return null;
    const builtin = lookupBuiltin(wi.word, wi.hasTypePrefix);
    if (builtin) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: [
            `**${builtin.name}** *(${builtin.kind})*`,
            '', builtin.description, '',
            '```qsp', builtin.signature ?? builtin.name, '```',
          ].join('\n'),
        },
      };
    }

    if (state) {
      const currentLoc = findLocationAtLine(state.locationIndex, params.position.line);
      if (currentLoc) {
        const locSyms = state.symbols.getLocation(currentLoc.name);
        if (locSyms) {
          const varSym = locSyms.findVariableAtPosition(
            wi.word.toLowerCase(), params.position.line, params.position.character,
          );
          if (varSym) {
            const lines: string[] = [];
            const prefixLabel = varSym.prefixes && varSym.prefixes.size > 0
              ? [...varSym.prefixes].join(', ') : '';
            const locKey = currentLoc.name.toLowerCase();
            const propProviders = !varSym.isLocal
              ? getAgg().propagatedLocals.get(locKey)?.get(varSym.nameLower)
              : undefined;
            const isPropagatedIn = !!(propProviders && propProviders.length > 0);

            const typeLabel = varSym.isLocal
              ? `**Local variable** \`${varSym.name}\``
              : isPropagatedIn
                ? `**Local variable** \`${varSym.name}\` *(propagated)*`
                : `**Global variable** \`${varSym.name}\``;
            lines.push((prefixLabel ? `${typeLabel} · Prefixes: ${prefixLabel}` : typeLabel) + '  ');

            // Partition refs into definitions vs usages.  Definitions
            // are plain `=` LHS, `local` decls, and append writes
            // (`$arr[] = …`).  Everything else (reads + compound-op
            // LHS like `x += 1`, `hp = hp + 5`) counts as a usage.
            let defCount = 0;
            let usageCount = 0;
            for (const r of varSym.references) {
              if (r.isDefinition) defCount++;
              else usageCount++;
            }

            // Format `(N definitions, M usages)`.  When exactly one
            // definition exists, fold the line number into it.  Returns
            // empty string when the variable has no refs at all (which
            // shouldn't happen here, but guard anyway).
            const formatCounts = (
              defs: number, uses: number,
              soleDefLoc?: { uri: string; line: number },
            ): string => {
              const parts: string[] = [];
              if (defs > 0) {
                if (defs === 1 && soleDefLoc) {
                  const f = soleDefLoc.uri !== uri ? ` [${basename(soleDefLoc.uri)}]` : '';
                  parts.push(`1 definition (line ${soleDefLoc.line + 1}${f})`);
                } else {
                  parts.push(`${defs} definitions`);
                }
              }
              if (uses > 0) {
                parts.push(`${uses} usage${uses !== 1 ? 's' : ''}`);
              }
              return parts.join(', ');
            };

            const defLoc = varSym.definition
              ? { uri: varSym.definition.uri, line: varSym.definition.line }
              : undefined;

            // For non-local, non-propagated-in globals, also show the
            // project-wide aggregate so the user can see how widely
            // the variable is used outside the current location.
            const isGlobal = !varSym.isLocal && !isPropagatedIn;
            if (isGlobal) {
              let totalDefs = 0;
              let totalUsages = 0;
              let firstDef: { uri: string; line: number } | undefined;
              for (const [docUri, st] of documentStates) {
                for (const [, ls] of st.symbols.locations) {
                  const v = ls.variables.get(varSym.nameLower);
                  if (!v || v.isLocal) continue;
                  for (const r of v.references) {
                    if (r.isDefinition) totalDefs++;
                    else totalUsages++;
                  }
                  if (!firstDef && v.definition) {
                    firstDef = { uri: docUri, line: v.definition.line };
                  }
                }
              }
              const total = formatCounts(totalDefs, totalUsages, firstDef);
              if (total) lines.push(`Total refs: ${total}  `);
            }
            const here = formatCounts(defCount, usageCount, defLoc);
            if (here) lines.push(`Location \`${currentLoc.name}\` refs: ${here}`);

            if (isPropagatedIn) {
              const total = propProviders!.length;
              const unit = total === 1 ? 'location' : 'locations';
              lines.push('', `**Propagated from (${total} ${unit}):**`);
              const shown = Math.min(total, ctx.settings.hover.maxItemsPerCategory);
              for (let i = 0; i < shown; i++) {
                const p = propProviders![i];
                const fInfo = p.providerUri !== uri ? ` [${basename(p.providerUri)}]` : '';
                const defLine = p.sym.definition ? ` — line ${p.sym.definition.line + 1}` : '';
                lines.push(`- \`${p.providerLoc}\`${defLine}${fInfo}`);
              }
              if (total > shown) lines.push(`- *…and ${total - shown} more*`);
            }

            if (varSym.isLocal && varSym.definition) {
              const targets: string[] = [];
              for (const [targetLoc, targetVars] of getAgg().propagatedLocals) {
                if (targetVars.get(varSym.nameLower)?.some(p => p.sym === varSym)) targets.push(targetLoc);
              }
              if (targets.length > 0) {
                const total = targets.length;
                const unit = total === 1 ? 'location' : 'locations';
                lines.push('', `**Propagated to (${total} ${unit}):**`);
                const shown = Math.min(targets.length, ctx.settings.hover.maxItemsPerCategory);
                for (let i = 0; i < shown; i++) lines.push(`- \`${targets[i]}\``);
                if (targets.length > shown) lines.push(`- *…and ${targets.length - shown} more*`);
              }
            }

            if (!varSym.isLocal && !isPropagatedIn) {
              const otherDefs: { locName: string; uri: string; line: number }[] = [];
              const varNameLower = wi.word.toLowerCase();
              for (const [docUri, st] of documentStates) {
                for (const [, ls] of st.symbols.locations) {
                  if (docUri === uri && ls.locationName.toLowerCase() === currentLoc.name.toLowerCase()) continue;
                  const otherVar = ls.variables.get(varNameLower);
                  if (otherVar?.definition) otherDefs.push({ locName: ls.locationName, uri: docUri, line: otherVar.definition.line });
                }
              }
              if (otherDefs.length > 0) {
                const total = otherDefs.length;
                const unit = total === 1 ? 'location' : 'locations';
                const headerBase = varSym.definition ? 'Also defined in' : 'Defined in';
                lines.push('', `**${headerBase} (${total} ${unit}):**`);
                const shown = Math.min(otherDefs.length, ctx.settings.hover.maxItemsPerCategory);
                for (let i = 0; i < shown; i++) {
                  const d = otherDefs[i];
                  const fInfo = d.uri !== uri ? ` [${basename(d.uri)}]` : '';
                  lines.push(`- \`${d.locName}\` — line ${d.line + 1}${fInfo}`);
                }
                if (otherDefs.length > shown) lines.push(`- *…and ${otherDefs.length - shown} more*`);
              }
            }

            // dynamic/dyneval propagation
            {
              const pos = params.position;
              for (const dvc of locSyms.dynamicVarCalls) {
                const l = dvc.loc;
                const inside =
                  (pos.line > l.line || (pos.line === l.line && pos.character >= l.column)) &&
                  (pos.line < l.endLine || (pos.line === l.endLine && pos.character <= l.endColumn));
                if (!inside) continue;
                if (dvc.varBaseName !== varSym.nameLower) continue;
                lines.push('');
                if (dvc.localNames.length === 0) {
                  lines.push('*No caller locals propagate into the referenced code block(s).*');
                } else {
                  const total = dvc.localNames.length;
                  const unit = total === 1 ? 'variable' : 'variables';
                  lines.push(
                    `**Propagated into dynamic block (${total} ${unit}):** `
                    + dvc.localNames.map(n => `\`${n}\``).join(', '),
                  );
                }
                break;
              }
            }

            // Possible values
            if (ctx.settings.hover.possibleValues) {
              let tree: ReturnType<typeof ctx.tsParser.parseOnce> = null;
              let lineOffset = 0;
              let tempTree = false;
              if (state.perLocationCache) {
                // Keyed like the cache's writers (see perLocationCacheKeys'
                // doc comment) — plain nameLower would only ever find the
                // FIRST of two same-named locations' cached tree.
                const cacheKey = perLocationCacheKeys(state.locationIndex)[state.locationIndex.indexOf(currentLoc)];
                const cached = state.perLocationCache.get(cacheKey);
                if (cached?.tree) { tree = cached.tree; cached.treeUsedAt = Date.now(); lineOffset = currentLoc.startLine; }
                else {
                  const locText = state.rawText?.slice(currentLoc.startOffset, currentLoc.endOffset);
                  if (locText) { tree = ctx.tsParser.parseOnce(locText); lineOffset = currentLoc.startLine; tempTree = true; }
                }
              }
              if (tree) try {
                const key = varSym.nameLower;
                const projectDocs: DocumentSymbols[] = [];
                for (const [otherUri, st] of documentStates) {
                  if (otherUri === uri) continue;
                  projectDocs.push(st.symbols);
                }
                const entries = getPossibleValuesAtCursor(
                  state.symbols, getAgg(), tree,
                  params.position.line - lineOffset, params.position.character, key,
                  { projectDocs: projectDocs.length ? projectDocs : undefined, hoverMode: true },
                );
                const expandVarRef = (targetKey: string) =>
                  projectDocs.length > 0
                    ? resolvePossibleValuesAcrossProject(
                        (function *() { yield state!.symbols; yield* projectDocs; })(), targetKey)
                    : resolvePossibleValuesInDocument(state!.symbols, targetKey);
                for (const ln of buildPossibleValuesLines(entries, uri, { expandVarRef, maxItems: ctx.settings.hover.maxItemsPerCategory })) {
                  lines.push(ln);
                }
              } finally {
                if (tempTree) tree.delete();
              }
            }

            return { contents: { kind: MarkupKind.Markdown, value: lines.join('\n') } };
          }
        }
      }

      const locDef = findLocationDef(ctx, wi.word, state);
      if (locDef) {
        const fileInfo = locDef.definition?.uri && locDef.definition.uri !== uri
          ? ` [${basename(locDef.definition.uri)}]` : '';
        const lines: string[] = [];
        lines.push(`**Location** \`${locDef.name}\` — line ${(locDef.definition?.line ?? 0) + 1}${fileInfo}`);
        const hoverMax = ctx.settings.hover.maxItemsPerCategory;
        buildCallerLines(documentStates, locDef.name.toLowerCase(), '**Called from:**', uri, lines, hoverMax);
        buildJumperLines(documentStates, locDef.name.toLowerCase(), '**Navigated from:**', uri, lines, hoverMax);
        buildConsumedLocalsLine(documentStates, getAgg(), locDef.name.toLowerCase(), '**Consumes locals:**', lines);
        buildUsedGlobalsSection(documentStates, getAgg(), locDef.name.toLowerCase(), '**Uses globals:**', lines, hoverMax);
        return { contents: { kind: MarkupKind.Markdown, value: lines.join('\n') } };
      }
    }
    return null;
  });

  // ==================== GO TO DEFINITION ====================

  connection.onDefinition((params): import('vscode-languageserver').Location | import('vscode-languageserver').Location[] | null => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const state = documentStates.get(params.textDocument.uri);
    if (!state) return null;
    const text = new TextBlocks(documentStates, runVariablesOf);
    if (text.holds(params.textDocument.uri, params.position.line, params.position.character)) return null;
    const found = resolveDefinition(ctx, state, params.textDocument.uri, params.position, doc);
    if (!found) return null;
    const kept = (Array.isArray(found) ? found : [found]).filter(l => !text.holds(l.uri, l.range.start.line, l.range.start.character));
    return kept.length === 0 ? null : Array.isArray(found) ? kept : kept[0];
  });

  // ==================== REFERENCES ====================

  connection.onReferences((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const state = documentStates.get(params.textDocument.uri);
    if (!state) return [];
    const text = new TextBlocks(documentStates, runVariablesOf);
    if (text.holds(params.textDocument.uri, params.position.line, params.position.character)) return [];
    return text.outside(collectAllReferences(ctx, state, params.textDocument.uri, params.position, doc))
      .map(symToLocation);
  });

  // ==================== DOCUMENT SYMBOLS ====================

  connection.onDocumentSymbol((params) => {
    const state = documentStates.get(params.textDocument.uri);
    if (!state) return [];
    return buildOutlineSymbols(state, documents.get(params.textDocument.uri));
  });

  // ==================== RENAME ====================

  connection.onPrepareRename((params): Range | null => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const state = documentStates.get(params.textDocument.uri);
    if (new TextBlocks(documentStates, runVariablesOf).holds(params.textDocument.uri, params.position.line, params.position.character)) return null;
    return resolvePrepareRename(state, doc, params.position);
  });

  connection.onRenameRequest((params: RenameParams): WorkspaceEdit | null => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const state = documentStates.get(params.textDocument.uri);
    if (!state) return null;
    const text = new TextBlocks(documentStates, runVariablesOf);
    if (text.holds(params.textDocument.uri, params.position.line, params.position.character)) return null;
    return buildRenameEdit(ctx, state, params.textDocument.uri, params.position, doc, params.newName, text);
  });

  // ==================== SEMANTIC TOKENS ====================

  // Only aggregates already worked out: a request must not wait for them,
  // and without them every block kept in a variable stays code.
  function runVariablesOf(uri: string): ReadonlySet<string> | undefined {
    return ctx.projectAggregates?.runVariables ?? documentStates.get(uri)?.aggCache?.runVariables;
  }

  function tokenFactsNow(uri: string): TokenFacts {
    const callTypes = ctx.projectAggregates?.callTypesPerTarget ?? ctx.collectCallTypesPerTarget();
    const gotoTargets = new Set<string>();
    for (const [key, entry] of callTypes) {
      if (entry.types.has('goto')) gotoTargets.add(key);
    }
    const locationNamed = locationNamedIn(documentStates);
    const run = runVariablesOf(uri);
    return {
      gotoTargets,
      textBlocksOf: (entry) => [...textArgBlocks([entry.symbols], locationNamed), ...textStoredBlocks([entry.symbols], run)],
    };
  }

  connection.onRequest(SemanticTokensRequest.type, async (params: SemanticTokensParams, cancel) => {
    if (!ctx.settings.semanticHighlighting.enabled) return { data: [] };
    const uri = params.textDocument.uri;
    const before = documentStates.get(uri);
    if (before?.perLocationCache && !before.cachedSemanticTokens) {
      await ctx.completeLocations(uri, cancel);
      if (cancel.isCancellationRequested) return null;
    }
    const state = documentStates.get(uri);
    if (state?.cachedSemanticTokens) return state.cachedSemanticTokens;

    if (state?.perLocationCache && state.locationIndex) {
      const tokens = ctx.buildTokensFromCache(state.locationIndex, state.perLocationCache, tokenFactsNow(uri));
      state.cachedSemanticTokens = tokens;
      return tokens;
    }
    // Regex-only symbols (no parser): TextMate colours the file.
    return { data: [] };
  });

  connection.onRequest(SemanticTokensRangeRequest.type, (params: SemanticTokensRangeParams) => {
    if (!ctx.settings.semanticHighlighting.enabled) return { data: [] };
    const state = documentStates.get(params.textDocument.uri);
    if (state?.cachedSemanticTokens) return state.cachedSemanticTokens;
    if (state?.perLocationCache && state.locationIndex) {
      const lines = { start: params.range.start.line, end: params.range.end.line };
      return ctx.buildTokensFromCache(state.locationIndex, state.perLocationCache, tokenFactsNow(params.textDocument.uri), lines);
    }
    return { data: [] };
  });

  // ==================== CODE ACTIONS ====================

  connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const range = params.range;
    const actions: CodeAction[] = [];
    const quickFixState = documentStates.get(params.textDocument.uri);
    actions.push(...buildSuppressionActions(
      doc, params.context.diagnostics,
      quickFixState?.locationIndex ?? buildLocationIndex(doc.getText()), detectEol(doc),
    ));
    const hasSelection = range.start.line !== range.end.line || range.start.character !== range.end.character;

    if (hasSelection) {
      const selectedText = doc.getText(range);
      const trimmed = selectedText.trim();
      if (trimmed.length > 0) {
        actions.push(
          { title: 'Extract to new location', kind: CodeActionKind.RefactorExtract, edit: buildExtractToLocationEdit(doc, range, trimmed) },
          { title: 'Wrap in act...end', kind: CodeActionKind.Refactor, edit: buildWrapEdit(doc, range, 'act', selectedText) },
          { title: 'Wrap in if...end', kind: CodeActionKind.Refactor, edit: buildWrapEdit(doc, range, 'if', selectedText) },
          { title: 'Wrap in loop...end', kind: CodeActionKind.Refactor, edit: buildWrapEdit(doc, range, 'loop', selectedText) },
        );
      }
    }

    const line = doc.getText({
      start: { line: range.start.line, character: 0 },
      end: { line: range.start.line, character: Number.MAX_SAFE_INTEGER },
    });
    const trimmed = line.trimStart();
    const lower = trimmed.toLowerCase();
    const state = documentStates.get(params.textDocument.uri);
    const cursorLoc = state ? findLocationAtLine(state.locationIndex, range.start.line) : undefined;
    const locEndLine = cursorLoc?.endLine ?? doc.lineCount - 1;

    if (!isBlockKeywordLine(doc, range.start.line, locEndLine)) {
      const kw = (['if', 'act', 'loop'] as const).find(k => startsWithKeyword(lower, k)) ?? null;
      if (kw) {
        const edit = buildInlineToBlockEdit(doc, range.start.line, line);
        if (edit) actions.push({ title: `Convert to block ${kw}...end`, kind: CodeActionKind.Refactor, edit });
      }
    }

    if (state) {
      const loc = cursorLoc ?? findLocationAtLine(state.locationIndex, range.start.line);
      if (loc) {
        const text = doc.getText();
        const eol = detectEol(doc);
        const allLines = text.split(/\r?\n/);
        const locLines = allLines.slice(loc.startLine, loc.endLine + 1);
        const formatted = formatLines(locLines, 0, { eol });
        const original = locLines.join(eol);
        if (formatted !== original) {
          actions.push({
            title: `Format Location '${loc.name}'`,
            kind: CodeActionKind.Source,
            edit: {
              changes: {
                [doc.uri]: [TextEdit.replace(
                  { start: { line: loc.startLine, character: 0 }, end: { line: loc.endLine, character: allLines[loc.endLine].length } },
                  formatted,
                )],
              },
            },
          });
        }
      }
    }
    return actions;
  });

  // ==================== FOLDING RANGES ====================

  connection.onFoldingRanges(async (params: FoldingRangeParams, cancel) => {
    const uri = params.textDocument.uri;
    if (documentStates.get(uri)?.perLocationCache) {
      await ctx.completeLocations(uri, cancel);
      if (cancel.isCancellationRequested) return null;
    }
    const doc = documents.get(uri);
    if (!doc) return [];
    const ranges: FoldingRange[] = [];
    const state = documentStates.get(uri);

    if (state) {
      for (const loc of state.locationIndex) {
        if (loc.endLine > loc.startLine) {
          ranges.push({ startLine: loc.startLine, endLine: loc.endLine, kind: FoldingRangeKind.Region });
        }
      }
    }

    const text = doc.getText();
    const lines = text.split(/\r?\n/);

    const blocks = state?.perLocationCache
      ? ctx.buildFoldsFromCache(state.locationIndex, state.perLocationCache)
      : undefined;
    if (blocks) {
      for (const b of blocks) ranges.push({ ...b, kind: FoldingRangeKind.Region });
    } else {
      // Regex-only symbols (no parser): match block keywords with `end`.
      const blockStack: { keyword: string; line: number }[] = [];
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimStart();
        const lower = trimmed.toLowerCase();
        if (startsWithKeyword(lower, 'act', 'if', 'loop') && lower.includes(':')) {
          blockStack.push({ keyword: lower.split(/\s/)[0], line: i });
        } else if (startsWithKeyword(lower, 'end') && blockStack.length > 0) {
          const open = blockStack.pop()!;
          if (i > open.line) ranges.push({ startLine: open.line, endLine: i, kind: FoldingRangeKind.Region });
        }
      }
    }

    // Comment folding
    {
      let commentStart: number | null = null;
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimStart();
        if (trimmed.startsWith('!')) {
          if (commentStart === null) commentStart = i;
        } else {
          if (commentStart !== null && i - 1 > commentStart) {
            ranges.push({ startLine: commentStart, endLine: i - 1, kind: FoldingRangeKind.Comment });
          }
          commentStart = null;
        }
      }
      if (commentStart !== null && lines.length - 1 > commentStart) {
        ranges.push({ startLine: commentStart, endLine: lines.length - 1, kind: FoldingRangeKind.Comment });
      }
    }

    return ranges;
  });

  // ==================== BLOCK KEYWORD HIGHLIGHTING ====================

  connection.onDocumentHighlight((params) => {
    if (!tsParser.isReady) return null;
    const uri = params.textDocument.uri;
    if (new TextBlocks(documentStates, runVariablesOf).holds(uri, params.position.line, params.position.character)) return null;
    const state = documentStates.get(uri);
    let tree: ReturnType<typeof tsParser.parseOnce> = null;
    let lineOffset = 0;
    let tempTree = false;

    if (state?.perLocationCache) {
      const loc = findLocationAtLine(state.locationIndex, params.position.line);
      if (loc) {
        // Keyed like the cache's writers — see perLocationCacheKeys' doc
        // comment (plain nameLower would only find the first of two
        // same-named locations' cached tree).
        const cacheKey = perLocationCacheKeys(state.locationIndex)[state.locationIndex.indexOf(loc)];
        const cached = state.perLocationCache.get(cacheKey);
        if (cached?.tree) { tree = cached.tree; cached.treeUsedAt = Date.now(); lineOffset = loc.startLine; }
        else {
          const locText = state.rawText?.slice(loc.startOffset, loc.endOffset);
          if (locText) { tree = tsParser.parseOnce(locText); lineOffset = loc.startLine; tempTree = true; }
        }
      }
    }
    if (!tree) return null;

    try {
      const ranges = findBlockKeywordRanges(tree, params.position.line - lineOffset, params.position.character);
      if (ranges.length > 0) {
        return ranges.map(r => ({
          range: {
            start: { line: r.startLine + lineOffset, character: r.startCol },
            end: { line: r.endLine + lineOffset, character: r.endCol },
          },
          kind: 1, // DocumentHighlightKind.Text
        }));
      }
    } finally {
      if (tempTree && tree) tree.delete();
    }

    if (!state) return null;
    const locEntry = findLocationAtLine(state.locationIndex, params.position.line);
    if (!locEntry) return null;
    const locSyms = state.symbols.locations.get(locEntry.nameLower);
    if (!locSyms) return null;
    return findLabelHighlightsInLocation(locSyms, params.position.line, params.position.character);
  });

  // ==================== DOCUMENT FORMATTING ====================

  connection.onDocumentFormatting((params: DocumentFormattingParams): TextEdit[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const text = doc.getText();
    const eol = detectEol(doc);
    const lines = text.split(/\r?\n/);
    const trailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
    const inputLines = trailingNewline ? lines.slice(0, -1) : lines;
    const formatted = formatLines(inputLines, 0, { tabSize: params.options.tabSize ?? 2, useTabs: params.options.insertSpaces === false, eol });
    const formattedWithEol = trailingNewline ? formatted + eol : formatted;
    const normalised = inputLines.join(eol);
    const normalisedWithEol = trailingNewline ? normalised + eol : normalised;
    if (formattedWithEol === normalisedWithEol) return [];
    return [TextEdit.replace(
      { start: { line: 0, character: 0 }, end: { line: doc.lineCount, character: 0 } },
      formattedWithEol,
    )];
  });

  // ==================== RANGE FORMATTING ====================

  connection.onDocumentRangeFormatting((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const text = doc.getText();
    const eol = detectEol(doc);
    const allLines = text.split(/\r?\n/);
    const startLine = params.range.start.line;
    const endLine = Math.min(params.range.end.line, allLines.length - 1);
    const rangeLines = allLines.slice(startLine, endLine + 1);
    const baseIndent = inferIndentLevel(allLines, startLine);
    const formatted = formatLines(rangeLines, baseIndent, { tabSize: params.options.tabSize ?? 2, useTabs: params.options.insertSpaces === false, eol });
    if (formatted === rangeLines.join(eol)) return [];
    return [TextEdit.replace(
      { start: { line: startLine, character: 0 }, end: { line: endLine, character: allLines[endLine].length } },
      formatted,
    )];
  });

  // ==================== CUSTOM REQUESTS: LISTS ====================

  connection.onRequest('qsp/listLocations', (params: { uri: string }) => {
    const items: { name: string; uri: string; line: number; endLine: number }[] = [];
    const uris = ctx.settings.project.enabled ? ctx.projectFileUris : new Set([params.uri]);
    for (const uri of uris) {
      const state = documentStates.get(uri);
      if (!state) continue;
      for (const loc of state.locationIndex) {
        items.push({ name: loc.name, uri, line: loc.startLine, endLine: loc.endLine });
      }
    }
    items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return items;
  });

  connection.onRequest('qsp/listObjects', (params: { uri: string }) => {
    const seen = new Map<string, { name: string; uri: string; line: number; isDefined: boolean }>();
    const uris = ctx.settings.project.enabled ? ctx.projectFileUris : new Set([params.uri]);
    for (const uri of uris) {
      const state = documentStates.get(uri);
      if (!state) continue;
      for (const [, locSyms] of state.symbols.locations) {
        for (const [key, obj] of locSyms.objectRefs) {
          if (seen.has(key)) continue;
          const loc = obj.definition ?? obj.references[0];
          if (!loc) continue;
          seen.set(key, { name: obj.name, uri: loc.uri, line: loc.line, isDefined: !!obj.definition });
        }
      }
    }
    const objItems = [...seen.values()];
    objItems.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return objItems;
  });

  connection.onRequest('qsp/listVariables', (params: { uri: string }) => {
    const uris = ctx.settings.project.enabled ? ctx.projectFileUris : [params.uri];
    const states: DocumentSymbols[] = [];
    for (const uri of uris) {
      const st = documentStates.get(uri);
      if (st) states.push(st.symbols);
    }
    return collectProjectVariables(states);
  });

  // Who jumps to or calls whom; see jumpGraph.ts. Same scope as the lists above.
  // How its dynamic jumps resolved goes to the log (counts and reasons,
  // no names), once per change: it tells which idioms of a game the
  // resolver misses without anyone having to share the game.
  let loggedStats: string | undefined;
  connection.onRequest('qsp/jumpGraph', (params: { uri: string }) => {
    const uris = ctx.settings.project.enabled ? ctx.projectFileUris : [params.uri];
    const sources: JumpGraphSource[] = [];
    for (const uri of uris) {
      const st = documentStates.get(uri);
      if (st) sources.push({ uri, symbols: st.symbols, locationIndex: st.locationIndex });
    }
    const stats = newDynamicJumpStats();
    const graph = buildJumpGraph(sources, stats);
    const line = formatDynamicJumpStats(stats);
    if (line && line !== loggedStats) {
      loggedStats = line;
      connection.console.log(line);
    }
    return graph;
  });
}
