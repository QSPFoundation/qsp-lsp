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

const CONTROL_FLOW_STMTS = new Set(['exit', 'goto', 'gt', 'xgoto', 'xgt', 'jump']);

/** Callback that receives one semantic token at a time. */
type TokenSink = (line: number, char: number, length: number, type: number, modifiers: number) => void;


/**
 * Walk a tree-sitter parse tree and emit semantic tokens via a callback.
 * Shared core used by both buildSemanticTokens (builder) and
 * collectSemanticTokenTuples (flat array).
 */
function emitSemanticTokens(tree: Parser.Tree, emit: TokenSink, gotoTargets?: ReadonlySet<string>): void {
  let cursor = tree.walk();

  function push(
    node: Parser.SyntaxNode,
    type: number,
    modifiers: number = 0,
  ): void {
    // Only emit for single-line spans (VS Code requires line-by-line tokens)
    const startLine = node.startPosition.row;
    const startChar = node.startPosition.column;
    const endLine = node.endPosition.row;
    const endChar = node.endPosition.column;

    if (startLine === endLine) {
      emit(startLine, startChar, endChar - startChar, type, modifiers);
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
          emit(lineNo, col, len, type, modifiers);
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
          | (CONTROL_FLOW_STMTS.has(node.text.toLowerCase()) ? tokenMod(MOD_CONTROL_FLOW) : 0));
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
      // Emit string tokens for the literal parts and recurse into
      // interpolation children so variables/expressions get highlighted.
      case 'single_quoted_string':
      case 'double_quoted_string': {
        const strType = tokenType(SemanticTokenTypes.string);
        const childCount = node.childCount;
        if (childCount === 0) {
          // No children (no interpolation) — emit the whole string
          push(node, strType);
          return;
        }
        // Walk children: emit string tokens for literal gaps and
        // anonymous children (quotes), recurse into named children.
        let pos = { row: node.startPosition.row, column: node.startPosition.column };
        for (let i = 0; i < childCount; i++) {
          const child = node.child(i)!;
          // Emit string token for literal text gap before this child
          emitStringGap(pos, child.startPosition, strType);
          if (child.isNamed) {
            // Named child (e.g. string_interpolation) — recurse
            visitNode(child);
          } else {
            // Anonymous child (quotes, literal text) — emit as string
            push(child, strType);
          }
          pos = { row: child.endPosition.row, column: child.endPosition.column };
        }
        // Emit string token for literal text after the last child
        emitStringGap(pos, node.endPosition, strType);
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
  ): void {
    if (start.row === end.row) {
      const len = end.column - start.column;
      if (len > 0) {
        emit(start.row, start.column, len, type, 0);
      }
    }
    // Multi-line gap: skip (TextMate handles as fallback)
  }

  visit();
  cursor.delete();
}

/**
 * Build a SemanticTokensBuilder result from a tree-sitter parse tree.
 * Used for full-file (non-per-location) mode.
 */
export function buildSemanticTokens(tree: Parser.Tree, gotoTargets?: ReadonlySet<string>): { data: number[] } {
  const builder = new SemanticTokensBuilder();
  emitSemanticTokens(tree, (l, c, len, t, m) => builder.push(l, c, len, t, m), gotoTargets);
  return builder.build();
}

/**
 * Collect semantic tokens as a flat tuple array [line, char, len, type, mod, ...].
 * Positions are tree-local (line 0 = root of the tree).
 * Used for per-location caching in large files.
 */
export function collectSemanticTokenTuples(tree: Parser.Tree, gotoTargets?: ReadonlySet<string>): number[] {
  const tuples: number[] = [];
  emitSemanticTokens(tree, (l, c, len, t, m) => { tuples.push(l, c, len, t, m); }, gotoTargets);
  return tuples;
}

/** Check if a variable_ref node is on the definition side. */
