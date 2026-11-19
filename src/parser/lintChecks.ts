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
import { ALL_BUILTINS, QSP_STATEMENTS } from './builtins';
import { forEachDescendant, parentOf } from './blockTrees';
import { SYNTAX_VERSIONS, isAtLeast, type SyntaxVersion } from '../common/syntaxVersion';

/** A syntax error extracted from the parse tree. */
export interface SyntaxError {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  message: string;
  /** The syntax versions it is an error in. Omitted = every version. */
  versions?: readonly SyntaxVersion[];
  inCodeBlock?: boolean;
  /** See extractErrors.ts. */
  inStoredBlock?: boolean;
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
// ALIAS and INSVAR are names in 5.9.5 (`alias = 1`); 5.9.6 reserves
// them, which the `unsupportedSyntax` diagnostic reports.
const RESERVED_STATEMENT_NAMES = QSP_STATEMENTS
  .filter(s => s.since !== '5.9.6')
  .map(s => s.name.toLowerCase())
  .filter(n => /^[a-z_][a-z_]*$/.test(n));

export const RESERVED_WORDS = new Set<string>([
  ...RESERVED_MARKERS,
  ...RESERVED_BINARY_OPS,
  ...RESERVED_STATEMENT_NAMES,
]);

// LOCAL, LOOP, SETVAR…: names in 5.7, which has no such statements.
const NEWER_THAN_57 = SYNTAX_VERSIONS.filter(v => isAtLeast(v, '5.9.5'));
const RESERVED_AFTER_57 = new Set(ALL_BUILTINS.filter(s => s.since === '5.9.5').map(s => s.name.toLowerCase()));

/** The versions in which `word` (lower case, in `RESERVED_WORDS`) can't name a variable. */
export function reservedWordVersions(word: string): readonly SyntaxVersion[] | undefined {
  return RESERVED_AFTER_57.has(word) ? NEWER_THAN_57 : undefined;
}

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
  let codeBlockDepth = 0;
  let interpolationDepth = 0;

  forEachDescendant(tree.rootNode, (n) => {
    const isCB = n.type === 'code_block';
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
  }, (n) => {
    if (n.type === 'code_block') codeBlockDepth--;
    if (n.type === 'string_interpolation') interpolationDepth--;
  });
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

  forEachDescendant(tree.rootNode, (node) => {
    if (node.type === 'identifier_text' && node.parent?.type === 'variable_ref') {
      const text = node.text.toLowerCase();
      if (RESERVED_WORDS.has(text) && !isOrphanBlockMarker(node.parent, text)) {
        // Tagged when nested inside a code_block, as the parser's own
        // errors are (extractErrors).
        let inCB = false, inIntp = false;
        for (let a: Parser.SyntaxNode | null = parentOf(node); a; a = parentOf(a)) {
          if (a.type === 'code_block') { inCB = true; }
          if (a.type === 'string_interpolation') { inIntp = true; }
        }
        errors.push({
          startRow: node.startPosition.row,
          startCol: node.startPosition.column,
          endRow: node.endPosition.row,
          endCol: node.endPosition.column,
          message: `'${node.text}' is a reserved keyword and cannot be used as a variable name`,
          versions: reservedWordVersions(text),
          inCodeBlock: inCB || undefined,
          inInterpolation: inIntp || undefined,
        });
      }
    }
  });
  return errors;
}

// ── Lint pass 3: prefix-whitespace detection ─────────────────────────

/**
 * Detect whitespace (or a line continuation) between a type prefix and
 * the variable/function name it qualifies.
 *
 * Per the PEG spec these are concatenations with no `ws` between:
 *   varNameWithPrefix          = typePrefix? varName
 *   funcNameWithPrefix         = typePrefix? functionName
 *
 * A blank after `@` / `@@` is QSP 5.9.6 syntax (`"@" ws userFunctionName`),
 * reported by the `unsupportedSyntax` diagnostic in 5.9.5 instead.
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
 *   `# _\nfoo` (line-continuation between prefix and name)
 *
 * Inside an ERROR region the prefix/name grouping is a recovery artifact
 * (the ERROR is already reported), so the check is skipped there.  An
 * `errorDepth` counter tracked along the single walk keeps this O(1) per
 * node — no per-node parent-chain walk / node allocation.
 */
export function checkPrefixWhitespace(tree: Parser.Tree): SyntaxError[] {
  const errors: SyntaxError[] = [];
  let errorDepth = 0;

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

  forEachDescendant(tree.rootNode, (n) => {
    const t = n.type;
    if (n.isError) errorDepth++;

    // Variables / functions that carry a `prefix` field.
    if (t === 'variable_ref' || t === 'ml_variable_ref'
        || t === 'na_func_call' || t === 'ext_func_call' || t === 'ml_func_call') {
      const prefix = n.childForFieldName('prefix');
      const name = n.childForFieldName('name');
      if (prefix && name && errorDepth === 0) {
        const what = (t.endsWith('func_call')) ? 'type prefix and function name'
                                               : 'type prefix and variable name';
        emitGap(prefix, name, what);
      }
    }
  }, (n) => {
    if (n.isError) errorDepth--;
  });
  return errors;
}

// ── Line continuation inside brackets ────────────────────────────────

/**
 * Whether a line continuation (` _` and a line break) is inside `(…)` or
 * `[…]`. QSP 5.9 joins lines only where no bracket is open: inside brackets
 * the line break is a blank, and `_` a variable named `_` (checked on the
 * 5.9.5 and 5.9.6 libraries: `max(1, _⏎ 2)` is "Unknown action"). QSP 5.7 is
 * the reverse: there ` _` is the only way to break a line inside brackets
 * (see `lineBreaksInBrackets`). A block's code is joined again when it runs,
 * so the climb stops at the block.
 */
export function isContinuationInBrackets(node: Parser.SyntaxNode): boolean {
  for (let p = node.parent; p; p = p.parent) {
    let depth = 0;
    for (let i = 0; i < p.childCount; i++) {
      const c = p.child(i)!;
      if (c.startIndex >= node.startIndex) break;
      if (c.type === '(' || c.type === '[') depth++;
      else if (c.type === ')' || c.type === ']') depth--;
    }
    if (depth > 0) return true;
  }
  return false;
}

/** The error for a line continuation inside brackets, on its `_`. */
export function continuationInBracketsError(node: Parser.SyntaxNode): SyntaxError {
  const { row, column } = node.startPosition;
  return {
    startRow: row,
    startCol: column,
    endRow: row,
    endCol: column + 1,
    message: "Inside brackets '_' doesn't join lines: QSP reads it as a variable named '_'. Break the line without it",
    versions: NEWER_THAN_57,
  };
}

const ONLY_57: readonly SyntaxVersion[] = ['5.7.0'];

/**
 * The node types with `(` or `[` among their own tokens (in grammar.js,
 * through the hidden rules they take in). Looked up first, since reading a
 * node's position costs more than all else the lint walk does with it.
 */
export const BRACKET_HOLDERS: ReadonlySet<string> = new Set([
  'statement', 'user_call_statement', 'user_func_call', 'ml_user_func_call', 'na_func_call', 'ext_func_call',
  'ml_func_call', 'paren_expr', 'paren_args', 'bracket_tuple', 'paren_tuple', 'array_index',
]);

/** Whether `node` has brackets of its own, (…) or […], across lines. */
export function opensBracketsAcrossLines(node: Parser.SyntaxNode): boolean {
  if (!BRACKET_HOLDERS.has(node.type)) return false;
  if (node.startPosition.row === node.endPosition.row || node.hasError) return false;
  for (let i = 0; i < node.childCount; i++) {
    const t = node.child(i)!.type;
    if (t === '(' || t === '[') return true;
  }
  return false;
}

/**
 * Line breaks inside the brackets of `node` (see `opensBracketsAcrossLines`)
 * with no ` _` before them: an error in QSP 5.7 ("Syntax error", "Bracket
 * not found"), which joins lines there only with ` _`. The grammar keeps
 * such a line break in a hidden token, so it is a gap between two tokens on
 * different lines; ` _` ends on the next line and leaves none. A string or
 * block that spans lines counts as one token. Covers the brackets inside
 * too, so call it for the outermost ones only.
 */
export function lineBreaksInBrackets(node: Parser.SyntaxNode): SyntaxError[] {
  const errors: SyntaxError[] = [];
  let depth = 0;
  let last: Parser.SyntaxNode | null = null;
  const token = (tok: Parser.SyntaxNode) => {
    if (depth > 0 && last && tok.startPosition.row > last.endPosition.row) {
      // On the last thing before the break: `max(1,` gets it on the comma.
      const end = last.endPosition;
      errors.push({
        startRow: end.row,
        startCol: last.startPosition.row === end.row ? last.startPosition.column : Math.max(0, end.column - 1),
        endRow: end.row,
        endCol: end.column,
        message: "In QSP 5.7 a line breaks inside brackets only after ' _': end this line with it",
        versions: ONLY_57,
      });
    }
    last = tok;
  };
  const tokens = (n: Parser.SyntaxNode) => {
    if (n.childCount === 0 || n.type === 'code_block' || n.type === 'string') { token(n); return; }
    for (let i = 0; i < n.childCount; i++) tokens(n.child(i)!);
  };
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)!;
    if (c.type === ')' || c.type === ']') {
      token(c);
      depth = Math.max(0, depth - 1);
    } else if (c.type === '(' || c.type === '[') {
      token(c);
      depth++;
    } else if (depth > 0) {
      tokens(c);
    } else {
      last = c;
    }
  }
  return errors;
}

/** Line breaks inside brackets that QSP 5.7 doesn't take (see `lineBreaksInBrackets`). */
export function checkLineBreaksInBrackets(tree: Parser.Tree): SyntaxError[] {
  const errors: SyntaxError[] = [];
  // How many brackets being looked into hold the node; a block's code
  // starts again from none.
  let inside = 0;
  const outside: number[] = [];
  forEachDescendant(tree.rootNode, (n) => {
    if (n.type === 'code_block') { outside.push(inside); inside = 0; return; }
    if (inside > 0 || opensBracketsAcrossLines(n)) {
      if (inside === 0) errors.push(...lineBreaksInBrackets(n));
      inside++;
    }
  }, (n) => {
    if (n.type === 'code_block') inside = outside.pop()!;
    else if (inside > 0) inside--;
  });
  return errors;
}

// ── Fields of a record ───────────────────────────────────────────────

/**
 * Fields named twice in a record literal (`[x: 1, $X: 2]`): QSP 5.9.6
 * stops with "Duplicate field name". It compares names whatever their case
 * and prefix; a name given as text counts as the text (`'x'` is `x`), and
 * one built when the code runs (`'<<$k>>'`) isn't known here.
 */
export function duplicateFields(tuple: Parser.SyntaxNode): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < tuple.namedChildCount; i++) {
    const item = tuple.namedChild(i)!;
    if (item.type !== 'tuple_field') continue;
    const nameNode = item.childForFieldName('name');
    const name = nameNode ? fieldNameText(nameNode) : undefined;
    if (name === undefined || !nameNode) continue;
    if (seen.has(name)) {
      errors.push({
        startRow: nameNode.startPosition.row,
        startCol: nameNode.startPosition.column,
        endRow: nameNode.endPosition.row,
        endCol: nameNode.endPosition.column,
        message: `Field '${nameNode.text}' is already in this record: QSP stops with 'Duplicate field name'`,
        versions: ONLY_596,
      });
    }
    seen.add(name);
  }
  return errors;
}

const ONLY_596: readonly SyntaxVersion[] = ['5.9.6'];

// A `field_name`'s name in lower case; undefined when it is built as the code runs.
function fieldNameText(node: Parser.SyntaxNode): string | undefined {
  const inner = node.namedChild(0);
  if (!inner) return undefined;
  if (inner.type === 'identifier_text') return inner.text.toLowerCase();
  const quoted = inner.namedChild(0);
  if (!quoted || quoted.namedChildCount > 0) return undefined;
  const quote = quoted.text[0];
  return quoted.text.slice(1, -1).split(quote + quote).join(quote).toLowerCase();
}

/** Fields named twice in record literals (see `duplicateFields`). */
export function checkDuplicateFields(tree: Parser.Tree): SyntaxError[] {
  const errors: SyntaxError[] = [];
  forEachDescendant(tree.rootNode, (n) => {
    if (n.type === 'bracket_tuple') errors.push(...duplicateFields(n));
  });
  return errors;
}

/** Line continuations inside `(…)` or `[…]` (see `isContinuationInBrackets`). */
export function checkContinuationInBrackets(tree: Parser.Tree): SyntaxError[] {
  const errors: SyntaxError[] = [];
  forEachDescendant(tree.rootNode, (n) => {
    if (n.type === 'line_continuation_ext' && isContinuationInBrackets(n)) errors.push(continuationInBracketsError(n));
  });
  return errors;
}
