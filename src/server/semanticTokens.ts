/**
 * Semantic tokens provider for QSP.
 *
 * Uses tree-sitter parse trees to provide precise semantic highlighting
 * that surpasses what the TextMate grammar can achieve.
 *
 * Token types and modifiers follow the VS Code standard.
 */
import type Parser from 'web-tree-sitter';
import {
  SemanticTokensBuilder,
  SemanticTokensLegend,
  SemanticTokenTypes,
  SemanticTokenModifiers,
} from 'vscode-languageserver';
import { isVariableDefinition } from '../parser';
import { EXEC_PROBE_RE, EXEC_LINK_RE, decodeDoubledQuotes } from '../parser/embeddedExec';
import { CONTROL_FLOW_STMT_NAMES } from '../parser/lookupTables';

/** Sub-parser used to lift `<a href="exec:…">` link bodies out of strings. */
export type SemanticParseFn = (text: string) => Parser.Tree | null;

// ──────────────────────────────────────────────────────────────────────
// Legend — the token types and modifiers we provide
// ──────────────────────────────────────────────────────────────────────

export const TOKEN_TYPES = [
  SemanticTokenTypes.namespace,     // 0  location names
  SemanticTokenTypes.variable,      // 1  variables
  SemanticTokenTypes.function,      // 2  built-in functions
  SemanticTokenTypes.keyword,       // 3  control flow keywords
  SemanticTokenTypes.string,        // 4  strings
  SemanticTokenTypes.number,        // 5  numbers
  SemanticTokenTypes.comment,       // 6  comments
  SemanticTokenTypes.operator,      // 7  operators
  SemanticTokenTypes.property,      // 8  labels
  SemanticTokenTypes.macro,         // 9  user calls @/@@
  SemanticTokenTypes.parameter,     // 10 type prefix ($ = string, # = numeric, % = tuple)
  SemanticTokenTypes.type,          // 11 statement names (pl, goto, etc.)
  SemanticTokenTypes.method,        // 12 function names
  SemanticTokenTypes.regexp,        // 13 string interpolation delimiters
  SemanticTokenTypes.decorator,     // 14 location header # and ---
  SemanticTokenTypes.enumMember,    // 15 note text after end/---
];

const MOD_DECL    = SemanticTokenModifiers.declaration;   // variable defs, labels, location headers
const MOD_DEF     = SemanticTokenModifiers.definition;    // location headers (paired with DECL)
const MOD_BUILTIN = SemanticTokenModifiers.defaultLibrary; // built-in statements and functions
/** Custom semantic token modifier: location is a goto/gt/xgoto/xgt target. */
const MOD_GOTO = 'goto' as SemanticTokenModifiers;
/** Custom semantic token modifier: statement breaks control flow (exit/goto/jump). */
const MOD_CONTROL_FLOW = 'controlFlow' as SemanticTokenModifiers;

export const TOKEN_MODIFIERS = [
  MOD_DECL,          // 0
  MOD_DEF,           // 1
  MOD_BUILTIN,       // 2
  MOD_GOTO,          // 3
  MOD_CONTROL_FLOW,  // 4
];

export const SEMANTIC_TOKENS_LEGEND: SemanticTokensLegend = {
  tokenTypes: TOKEN_TYPES,
  tokenModifiers: TOKEN_MODIFIERS,
};

const typeIndex = new Map(TOKEN_TYPES.map((t, i) => [t, i]));
const modIndex = new Map(TOKEN_MODIFIERS.map((m, i) => [m, i]));

/** Bit mask for the 'goto' modifier — used by buildTokensFromCache to patch cached tuples. */
export const GOTO_MODIFIER_BIT = 1 << TOKEN_MODIFIERS.indexOf(MOD_GOTO);
/** Token type index for namespace (location names). */
export const NAMESPACE_TOKEN_TYPE = typeIndex.get(SemanticTokenTypes.namespace) ?? 0;

function tokenType(t: SemanticTokenTypes): number {
  return typeIndex.get(t) ?? 0;
}

function tokenMod(...mods: SemanticTokenModifiers[]): number {
  let bits = 0;
  for (const m of mods) {
    const idx = modIndex.get(m);
    if (idx !== undefined) bits |= (1 << idx);
  }
  return bits;
}

// ──────────────────────────────────────────────────────────────────────
// Tree walker → semantic tokens
// ──────────────────────────────────────────────────────────────────────

/** Callback that receives one semantic token at a time. */
type TokenSink = (line: number, char: number, length: number, type: number, modifiers: number) => void;


/**
 * Walk a tree-sitter parse tree and emit semantic tokens via a callback.
 * Shared core used by both buildSemanticTokens (builder) and
 * collectSemanticTokenTuples (flat array).
 *
 * When `parseFn` is supplied, single-line `<a href="exec:…">` link
 * bodies inside string literals are sub-parsed and their tokens are
 * emitted on top of the surrounding string tokens.  Returns `true`
 * when at least one exec body was emitted — a hint that callers may
 * need to sort the resulting stream because sub-tokens can land at
 * columns earlier than tokens emitted right before them.
 */
function emitSemanticTokens(
  tree: Parser.Tree,
  emit: TokenSink,
  gotoTargets?: ReadonlySet<string>,
  parseFn?: SemanticParseFn,
): boolean {
  let cursor = tree.walk();
  let emittedExecBody = false;

  function push(
    node: Parser.SyntaxNode,
    type: number,
    modifiers: number = 0,
    sink: TokenSink = emit,
  ): void {
    // Only emit for single-line spans (VS Code requires line-by-line tokens)
    const startLine = node.startPosition.row;
    const startChar = node.startPosition.column;
    const endLine = node.endPosition.row;
    const endChar = node.endPosition.column;

    if (startLine === endLine) {
      sink(startLine, startChar, endChar - startChar, type, modifiers);
    } else {
      // Multi-line token: emit a token for each line so the entire
      // span is coloured (e.g. multiline comments with '…', "…", {…}).
      const lines = node.text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const lineNo = startLine + i;
        const col = i === 0 ? startChar : 0;
        const len = i === 0
          ? lines[i].length
          : i === lines.length - 1
            ? endChar
            : lines[i].length;
        if (len > 0) {
          sink(lineNo, col, len, type, modifiers);
        }
      }
    }
  }

  function visit(): void {
    const node = cursor.currentNode;

    switch (node.type) {
      // ── Location structure ──────────────────────────────
      case 'location_name': {
        const isGotoTarget = gotoTargets?.has(node.text.toLowerCase()) ?? false;
        push(node, tokenType(SemanticTokenTypes.namespace),
          tokenMod(MOD_DECL, MOD_DEF)
          | (isGotoTarget ? tokenMod(MOD_GOTO) : 0));
        return;
      }

      // location_header and location_end: the # and -- markers plus
      // any surrounding whitespace/trailing text are coloured by TextMate
      // (punctuation.definition.location.*.qsp).  Only the named
      // location_name child gets a semantic token (above).
      case 'location_header':
      case 'location_end':
        if (cursor.gotoFirstChild()) {
          do { visit(); } while (cursor.gotoNextSibling());
          cursor.gotoParent();
        }
        return;

      // ── Keywords ────────────────────────────────────────
      case 'if_keyword':
      case 'elseif_keyword':
      case 'else_keyword':
      case 'end_keyword':
      case 'act_keyword':
      case 'loop_keyword':
      case 'while_keyword':
      case 'step_keyword':
      case 'set_keyword':
      case 'local_keyword':
        push(node, tokenType(SemanticTokenTypes.keyword));
        return;

      // ── Statement names (pl, goto, gosub, etc.) ─────────
      case 'statement_name':
        push(node, tokenType(SemanticTokenTypes.type),
          tokenMod(MOD_BUILTIN)
          | (CONTROL_FLOW_STMT_NAMES.has(node.text.toLowerCase()) ? tokenMod(MOD_CONTROL_FLOW) : 0));
        return;

      // ── Built-in function names ─────────────────────────
      case 'function_name':
        push(node, tokenType(SemanticTokenTypes.method),
          tokenMod(MOD_BUILTIN));
        return;

      // ── Variables ───────────────────────────────────────
      case 'variable_ref':
      case 'ml_variable_ref': {
        const prefix = node.childForFieldName('prefix');
        const name = node.childForFieldName('name');
        if (prefix) {
          push(prefix, tokenType(SemanticTokenTypes.parameter));
        }
        if (name) {
          // Check if this is a definition (LHS of assignment or local)
          const isDefn = isVariableDefinition(node);
          push(name, tokenType(SemanticTokenTypes.variable),
            isDefn ? tokenMod(MOD_DECL) : 0);
        }
        // Recurse only into subscript children (skip prefix/name to avoid duplicates)
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i)!;
          if (child.id !== prefix?.id && child.id !== name?.id && child.isNamed) {
            visitNode(child);
          }
        }
        return;
      }

      // ── Strings ─────────────────────────────────────────
      // Emit string tokens for literal parts; recurse into
      // interpolation children.  When the string contains
      // `<a href="exec:…">` link bodies, clip the string tokens
      // around each body and let the sub-parser fill it instead —
      // overlapping tokens would otherwise hide the sub-parser's
      // output.
      case 'single_quoted_string':
      case 'double_quoted_string': {
        const strType = tokenType(SemanticTokenTypes.string);
        const bodies = parseFn ? findExecBodies(node) : [];
        const strEmit = bodies.length > 0 ? clipStringEmit(emit, bodies, strType) : emit;

        if (node.childCount === 0) {
          push(node, strType, 0, strEmit);
        } else {
          let pos: { row: number; column: number } = node.startPosition;
          for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i)!;
            emitStringGap(pos, child.startPosition, strType, strEmit);
            if (child.isNamed) {
              // Named child (e.g. string_interpolation): recurse via the
              // ORIGINAL emit — interpolation tokens aren't strings and
              // don't intersect exec bodies.
              visitNode(child);
            } else {
              push(child, strType, 0, strEmit);
            }
            pos = child.endPosition;
          }
          emitStringGap(pos, node.endPosition, strType, strEmit);
        }
        for (const info of bodies) {
          emitExecBodyForInfo(info, parseFn!, emit, gotoTargets);
          emittedExecBody = true;
        }
        return;
      }

      // ── Numbers ─────────────────────────────────────────
      case 'number_literal':
        push(node, tokenType(SemanticTokenTypes.number));
        return;

      // ── Comments ────────────────────────────────────────
      case 'comment_statement':
        push(node, tokenType(SemanticTokenTypes.comment));
        return;

      case 'comment_text':
        push(node, tokenType(SemanticTokenTypes.comment));
        return;

      // ── Labels ──────────────────────────────────────────
      case 'label_name':
        push(node, tokenType(SemanticTokenTypes.property),
          tokenMod(MOD_DECL));
        return;

      // ── User calls (@name, @@name) ──────────────────────
      case 'user_name':
        push(node, tokenType(SemanticTokenTypes.macro));
        return;

      // ── Type prefix ─────────────────────────────────────
      case 'type_prefix':
        push(node, tokenType(SemanticTokenTypes.parameter));
        return;

      // ── Operators ───────────────────────────────────────
      case 'op_arith':    // +, -, *, /
      case 'op_neg':      // unary -
      case 'op_mod':      // mod
      case 'op_cmp':      // <>, !, <=, =<, >=, =>, =, <, >
      case 'op_and':
      case 'op_or':
      case 'op_no':
      case 'op_obj':
      case 'op_loc':
      case 'op_amp':      // &
      case 'assignment_operator':
        push(node, tokenType(SemanticTokenTypes.operator));
        return;

      // ── Note text (after end, ---) ──────────────────────
      case 'note_string':
        push(node, tokenType(SemanticTokenTypes.enumMember));
        return;

      // ── String interpolation ────────────────────────────
      // string_interpolation: <<expr>> with delimiters and expression children
      case 'string_interpolation': {
        // Children: "<<" (anon), expression (named), ">>" (anon)
        const interpType = tokenType(SemanticTokenTypes.regexp);
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i)!;
          if (child.isNamed) {
            visitNode(child);
          } else {
            push(child, interpType);
          }
        }
        return;
      }

      // ── Inter-location text ─────────────────────────────
      case 'inter_loc_text':
      case 'inter_loc_line':
        push(node, tokenType(SemanticTokenTypes.comment));
        return;
    }

    // Recurse
    if (cursor.gotoFirstChild()) {
      do { visit(); } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  }

  /**
   * Visit a specific node and its subtree, independent of the tree cursor.
   * Used when we need to manually recurse into children (e.g. inside strings).
   */
  function visitNode(node: Parser.SyntaxNode): void {
    // Use a separate cursor so we don't corrupt the outer cursor's
    // parent-chain / depth tracking (cursor.reset() loses that context).
    const outer = cursor;
    cursor = tree.walk();
    cursor.reset(node);
    visit();
    cursor.delete();
    cursor = outer;
  }

  /** Emit a semantic token for a gap between two positions (single-line). */
  function emitStringGap(
    start: { row: number; column: number },
    end: { row: number; column: number },
    type: number,
    sink: TokenSink = emit,
  ): void {
    if (start.row === end.row) {
      const len = end.column - start.column;
      if (len > 0) {
        sink(start.row, start.column, len, type, 0);
      }
    }
    // Multi-line gap: skip (TextMate handles as fallback)
  }

  visit();
  cursor.delete();
  return emittedExecBody;
}

/**
 * Build a SemanticTokensBuilder result from a tree-sitter parse tree.
 * Used for full-file (non-per-location) mode.
 *
 * `parseFn`, when supplied, enables semantic highlighting inside
 * `<a href="exec:…">` link bodies embedded in string literals.
 */
export function buildSemanticTokens(
  tree: Parser.Tree,
  gotoTargets?: ReadonlySet<string>,
  parseFn?: SemanticParseFn,
): { data: number[] } {
  const builder = new SemanticTokensBuilder();
  const tuples = collectSemanticTokenTuples(tree, gotoTargets, parseFn);
  for (let i = 0; i < tuples.length; i += 5) {
    builder.push(tuples[i], tuples[i + 1], tuples[i + 2], tuples[i + 3], tuples[i + 4]);
  }
  return builder.build();
}

/**
 * Collect semantic tokens as a flat tuple array [line, char, len, type, mod, ...],
 * sorted by (line, char) so they can be fed straight into a
 * `SemanticTokensBuilder` (which delta-encodes and requires ascending
 * order).  Sorting here lets sub-token sources (e.g. embedded `exec:`
 * link bodies) emit at any column without interleaving carefully with
 * the surrounding string tokens.
 *
 * Positions are tree-local (line 0 = root of the tree).
 * Used for per-location caching in large files.
 *
 * `parseFn`, when supplied, enables semantic highlighting inside
 * `<a href="exec:…">` link bodies embedded in string literals.
 */
export function collectSemanticTokenTuples(
  tree: Parser.Tree,
  gotoTargets?: ReadonlySet<string>,
  parseFn?: SemanticParseFn,
): number[] {
  const tuples: number[] = [];
  const emittedExecBody = emitSemanticTokens(
    tree, (l, c, len, t, m) => { tuples.push(l, c, len, t, m); }, gotoTargets, parseFn,
  );
  // Tree-walk emission is naturally (line, char)-sorted; only exec
  // body sub-tokens can land at columns earlier than tokens emitted
  // just before them.  Skip the sort entirely otherwise.
  const n = tuples.length / 5;
  if (!emittedExecBody || n < 2) return tuples;

  const idx = new Array<number>(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => {
    const dl = tuples[a * 5] - tuples[b * 5];
    return dl !== 0 ? dl : tuples[a * 5 + 1] - tuples[b * 5 + 1];
  });
  // Identity permutation: nothing actually moved; return as-is.
  let moved = false;
  for (let i = 0; i < n; i++) { if (idx[i] !== i) { moved = true; break; } }
  if (!moved) return tuples;

  const out = new Array<number>(tuples.length);
  for (let i = 0; i < n; i++) {
    const k = idx[i] * 5;
    const j = i * 5;
    out[j]     = tuples[k];
    out[j + 1] = tuples[k + 1];
    out[j + 2] = tuples[k + 2];
    out[j + 3] = tuples[k + 3];
    out[j + 4] = tuples[k + 4];
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Embedded `exec:` link body highlighting
// ──────────────────────────────────────────────────────────────────────
//
// `<a href="exec:CODE">…</a>` link bodies inside QSP strings are
// executable QSP code.  To highlight them as code (not as string):
//   1. `findExecBodies` discovers single-line body ranges in a string.
//   2. The string handler uses `clipStringEmit` to drop the host
//      `string` token inside each body range (no overlap, no string
//      colour bleeding through).
//   3. `emitExecBodyForInfo` sub-parses each body and emits tokens at
//      the precise source positions.
// Multi-line bodies are left to the surrounding `string` colour.

/** Synthetic wrapper that turns a body into a parseable location.
 *  The body sits at line 1, column 0 of the wrapper. */
const WRAP_HEADER = '# __exec__\n';
const WRAP_FOOTER = '\n---\n';

/** A single single-line `exec:` body inside a host string. */
interface ExecBodyInfo {
  /** Source row of the body. */
  row: number;
  /** Source column of the first raw body character (inclusive). */
  startCol: number;
  /** Source column just past the last raw body character (exclusive). */
  endCol: number;
  /** Decoded body text (after `''`/`""` escape collapse). */
  decoded: string;
  /** Decoded→raw column shift map; `null` when no escapes were present. */
  extra: number[] | null;
}

/** Scan a host string for embedded `exec:` link bodies, in source order. */
function findExecBodies(stringNode: Parser.SyntaxNode): ExecBodyInfo[] {
  const raw = stringNode.text;
  if (raw.length < 2 || !EXEC_PROBE_RE.test(raw)) return [];
  const hostQuote = raw[0];
  if (hostQuote !== "'" && hostQuote !== '"') return [];

  const inner = raw.slice(1, -1);
  const stringStart = stringNode.startPosition;
  const out: ExecBodyInfo[] = [];

  // `matchAll` keeps the global regex's `lastIndex` untouched across
  // calls, removing the leading/trailing reset dance.
  for (const m of inner.matchAll(EXEC_LINK_RE)) {
    const rawBody = m[2];
    if (!rawBody || rawBody.includes('\n')) continue;
    // `d` flag: m.indices[2] is the body's offset within `inner`;
    // `+ 1` accounts for the opening quote stripped from `raw → inner`.
    const innerOffset = m.indices![2]![0] + 1;
    const bodyPos = offsetToSourcePos(raw, innerOffset, stringStart);
    const { text: decoded, extra } = decodeDoubledQuotes(rawBody, hostQuote);
    out.push({
      row: bodyPos.row,
      startCol: bodyPos.column,
      endCol: bodyPos.column + rawBody.length,
      decoded,
      extra,
    });
  }
  return out;
}

/**
 * Wrap `baseEmit` so that tokens of `stringType` are clipped around
 * `bodies` — the portion of any string token that falls inside a body
 * range is dropped; the surrounding parts are emitted as separate
 * tokens.  Other token types pass through.  `bodies` must be sorted
 * by `(row, startCol)`, which `findExecBodies` guarantees.
 */
function clipStringEmit(
  baseEmit: TokenSink,
  bodies: ReadonlyArray<ExecBodyInfo>,
  stringType: number,
): TokenSink {
  return (line, char, length, type, modifiers) => {
    if (type !== stringType) {
      baseEmit(line, char, length, type, modifiers);
      return;
    }
    const end = char + length;
    let cursor = char;
    for (const r of bodies) {
      if (r.row !== line || r.endCol <= cursor || r.startCol >= end) continue;
      if (r.startCol > cursor) {
        baseEmit(line, cursor, r.startCol - cursor, type, modifiers);
      }
      cursor = Math.min(r.endCol, end);
      if (cursor >= end) return;
    }
    if (cursor < end) baseEmit(line, cursor, end - cursor, type, modifiers);
  };
}

/** Sub-parse a single exec body and emit its tokens at the precise
 *  source positions covered by `info`. */
function emitExecBodyForInfo(
  info: ExecBodyInfo,
  parseFn: SemanticParseFn,
  emit: TokenSink,
  gotoTargets: ReadonlySet<string> | undefined,
): void {
  const subTree = parseFn(WRAP_HEADER + info.decoded + WRAP_FOOTER);
  if (!subTree) return;
  try {
    const { row, startCol, decoded, extra } = info;
    // Body sits at (line=1, column=0) in the wrapper; project back.
    const project: TokenSink = (line, char, length, type, modifiers) => {
      if (line !== 1 || char < 0 || char > decoded.length) return;
      const d2 = Math.min(char + length, decoded.length);
      const srcCol = startCol + char + (extra ? extra[char] : 0);
      const srcEnd = startCol + d2   + (extra ? extra[d2]   : 0);
      if (srcEnd > srcCol) emit(row, srcCol, srcEnd - srcCol, type, modifiers);
    };
    emitSemanticTokens(subTree, project, gotoTargets);
  } finally {
    subTree.delete();
  }
}

/** Convert an offset within `text` to an absolute source position,
 *  starting from `base`.  Newlines reset the column and advance the row. */
function offsetToSourcePos(
  text: string,
  offset: number,
  base: { row: number; column: number },
): { row: number; column: number } {
  let row = base.row;
  let col = base.column;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) { row++; col = 0; }
    else col++;
  }
  return { row, column: col };
}

/** Check if a variable_ref node is on the definition side. */
