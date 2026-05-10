/**
 * Lint checks: reserved-word misuse, prefix-whitespace, function-name-as-lvalue.
 *
 * These are separate tree walks that detect PEG-level rules that tree-sitter's
 * lexical extraction cannot enforce on its own. Each function runs its own
 * full tree walk so they can be called in isolation (e.g. from tests).
 *
 * The main extractErrors pipeline uses a merged walk (runMergedLintPasses
 * in extractErrors.ts) for performance; these public exports are the
 * authoritative standalone versions.
 */
import type Parser from 'web-tree-sitter';
import { QSP_STATEMENTS } from './builtins';

/** A syntax error extracted from the parse tree. */
export interface SyntaxError {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  message: string;
  inCodeBlock?: boolean;
  /** True when the error is inside a <<>> string interpolation. */
  inInterpolation?: boolean;
}

// ── Reserved-word constants ──────────────────────────────────────────

// standardMarker keywords — block/assignment markers.
const RESERVED_MARKERS = [
  'end', 'while', 'step', 'else', 'elseif',
  'if', 'act', 'loop', 'local', 'set', 'let',
];

// binaryKeywordOperator — `and`, `or`, `mod`.
const RESERVED_BINARY_OPS = ['and', 'or', 'mod'];

// Single-word statementName entries (multi-word ones like `add obj`
// can't be identifiers anyway, asterisk-prefixed ones like `*clr` also
// can't). Kept lowercase; the lint does case-insensitive comparison.
const RESERVED_STATEMENT_NAMES = (QSP_STATEMENTS as ReadonlyArray<{ name: string }>)
  .map(s => s.name.toLowerCase())
  .filter(n => /^[a-z_][a-z_]*$/.test(n));

export const RESERVED_WORDS = new Set<string>([
  ...RESERVED_MARKERS,
  ...RESERVED_BINARY_OPS,
  ...RESERVED_STATEMENT_NAMES,
]);

// ── Orphan block marker detection ────────────────────────────────────

/**
 * Block-continuation keywords that should NEVER be flagged when they
 * appear as a bare `implicit_statement`. See `checkReservedWordMisuse`
 * for the full rationale.
 */
const ORPHAN_BLOCK_MARKERS = new Set(['end', 'else', 'elseif', 'while', 'step']);

export function isOrphanBlockMarker(varRef: Parser.SyntaxNode, lower: string): boolean {
  if (!ORPHAN_BLOCK_MARKERS.has(lower)) return false;
  let p: Parser.SyntaxNode | null = varRef.parent;
  while (p && p.type !== 'implicit_statement' && p.type !== 'assignment_statement'
      && p.type !== 'local_statement' && p.type !== 'variable_list') {
    p = p.parent;
  }
  return p?.type === 'implicit_statement';
}

// ── Lint pass 1: function-name-as-lvalue ─────────────────────────────

/**
 * Detect `<funcName> = <expr>` and `$<funcName> = <expr>` shapes that
 * silently parse as a comparison expression because the function name
 * is reserved and can't form a variable_ref.
 *
 * Tree shape (e.g. `$len = "a"` or `len('x') = 44`):
 *   implicit_statement
 *     na_binary
 *       na_func_call (prefix: type_prefix? name: function_name [args])  ← LHS
 *       op_cmp '='                                                      ← op
 *       <expr>                                                          ← RHS
 *
 * We flag when:
 *   - parent is `implicit_statement` (top-level expression-as-statement;
 *     this excludes `if len(x) = 5:` and `x = len(x) = 5` where QSP
 *     correctly treats the inner `=` as a comparison)
 *   - the binary operator's text is exactly `=` (not `<>`, `<=`, etc.)
 *   - LHS is a `na_func_call` (with or without args — QSP would try to
 *     parse the line as an assignment regardless and reject it)
 *
 * Errors inside code blocks / interpolations are tagged accordingly.
 */
export function checkFunctionNameAsLvalue(tree: Parser.Tree): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const cursor = tree.walk();
  let codeBlockDepth = 0;
  let interpolationDepth = 0;

  function visit(): void {
    const n = cursor.currentNode;
    const isCB = n.type === 'code_block' || n.type === 'raw_code_block';
    const isIntp = n.type === 'string_interpolation';
    if (isCB) codeBlockDepth++;
    if (isIntp) interpolationDepth++;

    if (n.type === 'na_binary' && n.parent?.type === 'implicit_statement') {
      // Children: LHS, op, RHS (may also include extras-as-named like
      // line_continuation_ext in rare cases — find the operator by type).
      let lhs: Parser.SyntaxNode | null = null;
      let op: Parser.SyntaxNode | null = null;
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i)!;
        if (!lhs) { lhs = c; continue; }
        if (!op && c.type === 'op_cmp') { op = c; break; }
      }
      if (lhs && op && op.text.trim() === '='
          && lhs.type === 'na_func_call') {
        const fnName = lhs.childForFieldName('name');
        const display = fnName ? fnName.text : lhs.text;
        errors.push({
          startRow: lhs.startPosition.row,
          startCol: lhs.startPosition.column,
          endRow: lhs.endPosition.row,
          endCol: lhs.endPosition.column,
          message: `'${display}' is a reserved function name and cannot be assigned to`,
          inCodeBlock: codeBlockDepth > 0 || undefined,
          inInterpolation: interpolationDepth > 0 || undefined,
        });
      }
    }

    if (cursor.gotoFirstChild()) {
      do { visit(); } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }

    if (isCB) codeBlockDepth--;
    if (isIntp) interpolationDepth--;
  }

  visit();
  cursor.delete();
  return errors;
}

// ── Lint pass 2: reserved-word misuse ────────────────────────────────

/**
 * Reserved-word misuse detector.
 *
 * Per the PEG spec, `varName = ~(keyword delimiterChar) ~digit
 * nonDelimiterChar+` — i.e. NO keyword may be used as a variable name,
 * at either the read or write side. Tree-sitter's `word:` keyword
 * extraction only reserves a word at parse states where it actually
 * contests with `identifier_text`, so several categories slip through:
 *
 *   category                 reserved by tree-sitter?
 *   ───────────────────────  ────────────────────────────────────────
 *   functionName             ✓ (competes in expression positions)
 *   statementName (lvalue)   ✓ (parses as `statement <name> = 1`)
 *   statementName (rvalue)   ✗ — `x = play` parses as read of var `play`
 *   binaryKeywordOperator    ✗ — `and = 1` / `x = and` parse as var
 *   unaryKeywordOperator     ✓ (greedy-eaten as unary, MISSING operand)
 *   standardMarker (end,     ✗ — never contests, silently parses as var
 *     while, step, else,
 *     elseif, if, act, loop,
 *     local, set, let)
 *
 * This pass walks every `identifier_text` leaf whose parent is a
 * `variable_ref` and flags the ones whose lowercased text is a reserved
 * keyword per the PEG spec. It catches:
 *   • standardMarker used as variable (both lvalue and rvalue)
 *   • statementName used as rvalue (`x = play`)
 *   • binaryKeywordOperator used as variable (`and = 1`, `x = and`)
 *
 * The categories already covered at the grammar level (functionName,
 * unaryKeywordOperator, statementName-as-lvalue) don't need additional
 * linting — they surface as parse errors or reroutes on their own.
 */
export function checkReservedWordMisuse(tree: Parser.Tree): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const cursor = tree.walk();

  function visit(): void {
    const node = cursor.currentNode;
    if (node.type === 'identifier_text' && node.parent?.type === 'variable_ref') {
      const text = node.text.toLowerCase();
      if (RESERVED_WORDS.has(text) && !isOrphanBlockMarker(node.parent, text)) {
        // Demote to Information when nested inside a code_block or
        // raw_code_block — the enclosing braces signal that the inner
        // text might be raw / non-syntactic, so treat the lint as a
        // non-blocking hint (mirrors the parser-error demotion in
        // extractErrors / diagnostics.ts).
        let inCB = false, inIntp = false;
        for (let a: Parser.SyntaxNode | null = node.parent; a; a = a.parent) {
          if (a.type === 'code_block' || a.type === 'raw_code_block') { inCB = true; }
          if (a.type === 'string_interpolation') { inIntp = true; }
        }
        errors.push({
          startRow: node.startPosition.row,
          startCol: node.startPosition.column,
          endRow: node.endPosition.row,
          endCol: node.endPosition.column,
          message: `'${node.text}' is a reserved keyword and cannot be used as a variable name`,
          inCodeBlock: inCB || undefined,
          inInterpolation: inIntp || undefined,
        });
      }
    }
    if (cursor.gotoFirstChild()) {
      do { visit(); } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  }

  visit();
  cursor.delete();
  return errors;
}

// ── Lint pass 3: prefix-whitespace detection ─────────────────────────

/**
 * Detect whitespace (or a line continuation) between a type prefix and
 * the variable/function name it qualifies, and between `@` / `@@` and
 * the user-call name.
 *
 * Per the PEG spec these are concatenations with no `ws` between:
 *   varNameWithPrefix          = typePrefix? varName
 *   funcNameWithPrefix         = typePrefix? functionName
 *   userCallStatementNoArgs    = "@@" userStatementName
 *   userFunctionCallEmptyArgs  = "@"  userFunctionName ws "(" mws ")"
 *
 * Tree-sitter's `extras` (matching `[ \t]+` and `line_continuation_ext`)
 * silently swallows whitespace between any sequence elements at the rule
 * level. We compensate by inspecting byte offsets: prefix.endIndex must
 * equal name.startIndex when both are present.
 *
 * Examples this catches:
 *   `# foo = 1` — '#' parses as type_prefix, 'foo' becomes a variable
 *     reference (silent: looks like an identifier, not a new location)
 *   `$ name = 1`, `% t = 1`
 *   `@ foo`, `@@ foo`
 *   `# _\nfoo` (line-continuation between prefix and name)
 */
export function checkPrefixWhitespace(tree: Parser.Tree): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const cursor = tree.walk();

  /** Emit an error for the gap between two adjacent tokens. */
  function emitGap(opener: Parser.SyntaxNode, name: Parser.SyntaxNode, label: string): void {
    if (opener.endIndex === name.startIndex) return; // no gap
    errors.push({
      startRow: opener.endPosition.row,
      startCol: opener.endPosition.column,
      endRow: name.startPosition.row,
      endCol: name.startPosition.column,
      message: `No whitespace allowed between ${label}`,
    });
  }

  function visit(): void {
    const n = cursor.currentNode;
    const t = n.type;

    // Variables / functions that carry a `prefix` field.
    if (t === 'variable_ref' || t === 'ml_variable_ref'
        || t === 'na_func_call' || t === 'ext_func_call' || t === 'ml_func_call') {
      const prefix = n.childForFieldName('prefix');
      const name = n.childForFieldName('name');
      if (prefix && name) {
        const what = (t.endsWith('func_call')) ? 'type prefix and function name'
                                               : 'type prefix and variable name';
        emitGap(prefix, name, what);
      }
    }

    // User calls (@ / @@). The marker is an anonymous token; the name
    // is exposed via the `name` field.
    else if (t === 'user_func_call' || t === 'ml_user_func_call'
             || t === 'user_call_statement') {
      const name = n.childForFieldName('name');
      if (name) {
        // Find the '@' or '@@' opener among unnamed children.
        let opener: Parser.SyntaxNode | null = null;
        for (let i = 0; i < n.childCount; i++) {
          const c = n.child(i)!;
          if (!c.isNamed && (c.type === '@' || c.type === '@@')) { opener = c; break; }
        }
        if (opener) {
          const what = `'${opener.type}' and user function name`;
          emitGap(opener, name, what);
        }
      }
    }

    if (cursor.gotoFirstChild()) {
      do { visit(); } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  }

  visit();
  cursor.delete();
  return errors;
}
