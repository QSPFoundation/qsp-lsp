/**
 * Error extraction from tree-sitter parse trees.
 *
 * Walks ERROR and MISSING nodes and produces human-readable diagnostics,
 * with refined multi-line error classification (unclosed strings, braces,
 * blocks).
 */
import type Parser from 'web-tree-sitter';
import {
  RESERVED_WORDS,
  isOrphanBlockMarker,
  checkFunctionNameAsLvalue,
  checkReservedWordMisuse,
  checkPrefixWhitespace,
} from './lintChecks';

export { checkFunctionNameAsLvalue, checkReservedWordMisuse, checkPrefixWhitespace };

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

/** Map raw tree-sitter node types to human-friendly descriptions. */
const FRIENDLY_NODE_NAMES: Record<string, string> = {
  // Identifiers / literals
  identifier_text: 'an identifier',
  identifier: 'an identifier',
  user_name: 'a user function or procedure name',
  function_name: 'a function name',
  statement_name: 'a statement',
  label_name: 'a label name',
  location_name: 'a location name',
  number_literal: 'a number',
  number: 'a number',
  string: 'a string',
  single_quoted_string: "a string ('...')",
  double_quoted_string: 'a string ("...")',
  raw_string: 'a string',
  expression: 'an expression',

  // Operators
  op_cmp: 'a comparison operator (=, <>, <, >, <=, >=)',
  op_arith: 'an arithmetic operator (+, -, *, /)',
  op_amp: "'&'",
  op_and: "'and'",
  op_or: "'or'",
  op_mod: "'mod'",
  op_no: "'no'",
  op_obj: "'obj'",
  op_loc: "'loc'",
  op_neg: "'-'",
  assignment_operator: 'an assignment operator (=, +=, -=, *=, /=)',

  // Keywords
  if_keyword: "'if'",
  elseif_keyword: "'elseif'",
  else_keyword: "'else'",
  end_keyword: "'end'",
  loop_keyword: "'loop'",
  while_keyword: "'while'",
  step_keyword: "'step'",
  act_keyword: "'act'",
  local_keyword: "'local'",
  set_keyword: "'set' or 'let'",

  // Punctuation
  ')': "')'",
  '(': "'('",
  ']': "']'",
  '[': "'['",
  '}': "'}'",
  '{': "'{'",
  ':': "':'",
  ',': "','",
  '=': "'='",
  "'": "a closing quote (')",
  '"': 'a closing quote (")',
};

function friendlyNodeName(type: string): string {
  if (type in FRIENDLY_NODE_NAMES) return FRIENDLY_NODE_NAMES[type];
  // Fall back: replace underscores with spaces so e.g. `paren_args` → `paren args`.
  return type.replace(/_/g, ' ');
}

/**
 * Context-aware message for a MISSING node. The default is just
 * `Expected <friendly name>`, but several cases get a clearer phrasing
 * by inspecting the parent chain:
 *   - `identifier_text` MISSING under a variable-name slot
 *     (variable_ref → variable_list → local/assignment_statement)
 *     → "Expected variable name" instead of "Expected an identifier".
 *   - `identifier_text` MISSING under a `user_func_call` /
 *     `user_call_statement` (i.e. just `@` or `@@` with nothing after)
 *     → "Expected user function name after '@'/'@@'".
 *   - `user_name` MISSING (same call sites) → same "Expected user
 *     function name…" message.
 */
function friendlyMissingMessage(node: Parser.SyntaxNode): string {
  const t = node.type;

  // Walk up to find a meaningful parent context.
  if (t === 'identifier_text' || t === 'user_name') {
    let p: Parser.SyntaxNode | null = node.parent;
    let depth = 0;
    while (p && depth < 5) {
      if (p.type === 'user_func_call' || p.type === 'ml_user_func_call') {
        return "Expected user function name after '@'";
      }
      if (p.type === 'user_call_statement') {
        return "Expected user function name after '@@'";
      }
      if (p.type === 'variable_list' || p.type === 'local_statement'
          || p.type === 'assignment_statement') {
        return 'Expected variable name';
      }
      p = p.parent;
      depth++;
    }
  }

  return `Expected ${friendlyNodeName(t)}`;
}

/**
 * Walk the tree and collect all ERROR and MISSING nodes.
 * Returns an array of SyntaxError with human-readable messages.
 *
 * Multi-line ERROR nodes (e.g. an entire location swallowed because
 * of an unclosed block/string/brace) are narrowed to the actual
 * problem line(s) instead of underlining the full span.
 */
export function extractErrors(tree: Parser.Tree): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const cursor = tree.walk();
  let codeBlockDepth = 0;
  let interpolationDepth = 0;

  function visit(): void {
    const node = cursor.currentNode;
    const isCodeBlock = node.type === 'code_block';
    // Track raw_code_block too: errors inside a comment's { … } region
    // are secondary (the outer comment is still valid).
    const isRawCodeBlock = node.type === 'raw_code_block';
    const isInterpolation = node.type === 'string_interpolation';
    if (isCodeBlock || isRawCodeBlock) codeBlockDepth++;
    if (isInterpolation) interpolationDepth++;

    if (node.isError) {
      const { diagnostics, summarized } = refineErrorNode(node);
      if (codeBlockDepth > 0) {
        for (const e of diagnostics) e.inCodeBlock = true;
      }
      if (interpolationDepth > 0) {
        for (const e of diagnostics) e.inInterpolation = true;
      }
      errors.push(...diagnostics);
      // If refinement produced a whole-subtree summary (unclosed string,
      // unclosed brace, unclosed block, missing colon on a keyword),
      // do NOT recurse — the inner MISSING/ERROR nodes are by-products
      // of the same root cause and reporting them too is just noise.
      // For the generic "Unexpected syntax" fallback we *do* recurse so
      // each child statement's error surfaces individually (and so the
      // threshold-collapse path can kick in for pathological files).
      if (summarized) {
        if (isCodeBlock || isRawCodeBlock) codeBlockDepth--;
        if (isInterpolation) interpolationDepth--;
        return;
      }
    } else if (node.isMissing) {
      errors.push({
        startRow: node.startPosition.row,
        startCol: node.startPosition.column,
        endRow: node.endPosition.row,
        endCol: node.endPosition.column,
        message: friendlyMissingMessage(node),
        inCodeBlock: codeBlockDepth > 0 || undefined,
        inInterpolation: interpolationDepth > 0 || undefined,
      });
    }

    // Recurse into children only if this subtree has errors
    if (node.hasError && cursor.gotoFirstChild()) {
      do { visit(); } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }

    if (isCodeBlock || isRawCodeBlock) codeBlockDepth--;
    if (isInterpolation) interpolationDepth--;
  }

  visit();
  cursor.delete();

  // Run the three additional lint passes (reserved-word misuse,
  // prefix-whitespace, function-name-as-lvalue) in a SINGLE shared tree
  // walk for performance. Public per-pass exports below remain so tests
  // (and external callers) can invoke each in isolation.
  errors.push(...runMergedLintPasses(tree));

  return errors;
}

/**
 * Single-pass version of `checkReservedWordMisuse` +
 * `checkPrefixWhitespace` + `checkFunctionNameAsLvalue`. Walks the tree
 * once with shared depth counters for `code_block` / `string_interpolation`
 * context, instead of three separate full-tree walks.
 *
 * Behaviour MUST match the union of the three public functions exactly;
 * the test suite still calls those public functions individually.
 */
function runMergedLintPasses(tree: Parser.Tree): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const cursor = tree.walk();
  let codeBlockDepth = 0;
  let interpolationDepth = 0;

  function emitGap(opener: Parser.SyntaxNode, name: Parser.SyntaxNode, label: string): void {
    if (opener.endIndex === name.startIndex) return;
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
    const isCB = t === 'code_block' || t === 'raw_code_block';
    const isIntp = t === 'string_interpolation';
    if (isCB) codeBlockDepth++;
    if (isIntp) interpolationDepth++;

    // ── Pass 1: reserved-word misuse on variable_ref/identifier_text ──
    if (t === 'identifier_text' && n.parent?.type === 'variable_ref') {
      const text = n.text.toLowerCase();
      if (RESERVED_WORDS.has(text) && !isOrphanBlockMarker(n.parent, text)) {
        errors.push({
          startRow: n.startPosition.row,
          startCol: n.startPosition.column,
          endRow: n.endPosition.row,
          endCol: n.endPosition.column,
          message: `'${n.text}' is a reserved keyword and cannot be used as a variable name`,
          inCodeBlock: codeBlockDepth > 0 || undefined,
          inInterpolation: interpolationDepth > 0 || undefined,
        });
      }
    }

    // ── Pass 2: prefix-whitespace ─────────────────────────────────
    if (t === 'variable_ref' || t === 'ml_variable_ref'
        || t === 'na_func_call' || t === 'ext_func_call' || t === 'ml_func_call') {
      const prefix = n.childForFieldName('prefix');
      const name = n.childForFieldName('name');
      if (prefix && name) {
        const what = (t.endsWith('func_call')) ? 'type prefix and function name'
                                               : 'type prefix and variable name';
        emitGap(prefix, name, what);
      }
    } else if (t === 'user_func_call' || t === 'ml_user_func_call'
               || t === 'user_call_statement') {
      const name = n.childForFieldName('name');
      if (name) {
        let opener: Parser.SyntaxNode | null = null;
        for (let i = 0; i < n.childCount; i++) {
          const c = n.child(i)!;
          if (!c.isNamed && (c.type === '@' || c.type === '@@')) { opener = c; break; }
        }
        if (opener) emitGap(opener, name, `'${opener.type}' and user function name`);
      }
    }

    // ── Pass 3: function-name-as-lvalue ────────────────────────────
    if (t === 'na_binary' && n.parent?.type === 'implicit_statement') {
      let lhs: Parser.SyntaxNode | null = null;
      let op: Parser.SyntaxNode | null = null;
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i)!;
        if (!lhs) { lhs = c; continue; }
        if (!op && c.type === 'op_cmp') { op = c; break; }
      }
      if (lhs && op && op.text.trim() === '=' && lhs.type === 'na_func_call') {
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

/**
 * Check if a node has "structural" errors — errors outside code blocks
 * and string interpolations.  Errors inside those constructs don't affect
 * the reliability of the surrounding location's symbol analysis, so they
 * shouldn't suppress diagnostics like uninitialized-variable detection.
 */
export function hasStructuralErrors(node: Parser.SyntaxNode): boolean {
  const cursor = node.walk();

  function walk(): boolean {
    const n = cursor.currentNode;

    // Skip subtrees without errors entirely
    if (!n.hasError) return false;

    // Errors inside code blocks or interpolations are non-structural
    if (n.type === 'code_block' || n.type === 'string_interpolation') {
      return false;
    }

    // This node itself is an error → structural
    if (n.isError || n.isMissing) return true;

    // Recurse into children
    if (cursor.gotoFirstChild()) {
      do {
        if (walk()) { cursor.gotoParent(); return true; }
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
    return false;
  }

  const result = walk();
  cursor.delete();
  return result;
}

// ── String / brace node types used for error classification ─────────

const STRING_NODE_TYPES = new Set([
  'string', 'single_quoted_string', 'double_quoted_string',
]);

/** Block-opening keyword types that require a matching 'end'. */
const BLOCK_KEYWORDS = new Set([
  'act_keyword', 'if_keyword', 'loop_keyword',
]);

/** Keyword node types whose grammar rules require a trailing ':'. */
const COLON_KEYWORDS = new Set([
  'if_keyword', 'elseif_keyword', 'act_keyword', 'loop_keyword',
]);

/** Parents where a bare number where a varName is expected is a PEG-
 *  level violation (`varName = ~digit nonDelimiterChar+`). */
const VARNAME_PARENT_TYPES = new Set([
  'local_statement', 'assignment_statement', 'variable_list',
]);

/** Keyword types that introduce a variable slot directly after them. */
const VARNAME_LEAD_KEYWORDS = new Set([
  'local_keyword', 'set_keyword',
]);

/**
 * Detect the common "variable name can't start with a digit" case.
 *
 * Pattern A — ERROR directly under `local_statement`/`assignment_statement`/
 * `variable_list`, first named child is `number_literal`:
 *   `local i,7=5,8`  →  ERROR([number_literal 7]) inside local_statement
 *
 * Pattern B — ERROR sibling of a `local_keyword` / `set_keyword` lead-in
 * with a `number_literal` as a subsequent child:
 *   `local 7=9`  →  ERROR([local_keyword, <next token is number>])
 * Here the ERROR child is just the `local_keyword` itself; the stray
 * number ends up as a sibling `implicit_statement`, so we only flag
 * pattern A safely (pattern B's downstream "implicit_statement: 7=9"
 * is not very wrong on its own — it just means the number was
 * re-parsed as an expression; the extractor's fallback already
 * highlights `local` and the user sees the keyword span). To give a
 * clearer message when the ERROR is just `local_keyword` at EOL with
 * nothing else on the line, we emit a targeted "Expected variable
 * name" diagnostic.
 */
function detectInvalidVarNameError(node: Parser.SyntaxNode): SyntaxError | null {
  // Pattern A — number inside a varName slot.
  if (node.parent && VARNAME_PARENT_TYPES.has(node.parent.type)) {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i)!;
      if (c.type === 'number_literal') {
        return {
          startRow: c.startPosition.row,
          startCol: c.startPosition.column,
          endRow: c.endPosition.row,
          endCol: c.endPosition.column,
          message: `Invalid variable name '${c.text}' — names cannot start with a digit`,
        };
      }
    }
  }

  // Pattern B — ERROR contains only a lead-in keyword (`local`/`set`/`let`);
  // the next token on the line couldn't start a variable_ref.
  if (node.childCount >= 1) {
    const first = node.child(0)!;
    if (VARNAME_LEAD_KEYWORDS.has(first.type)) {
      const kw = first.text.trim().toLowerCase();
      return {
        startRow: node.startPosition.row,
        startCol: node.startPosition.column,
        endRow: node.endPosition.row,
        endCol: node.endPosition.column,
        message: `Expected a variable name after '${kw}'`,
      };
    }
  }

  return null;
}

/**
 * Set of operator-node types that can appear as the lone child of a
 * trailing-operator ERROR (e.g. `x = 1 +`  → ERROR(op_arith)).
 */
const OPERATOR_NODE_TYPES = new Set([
  'op_arith', 'op_cmp', 'op_amp', 'op_and', 'op_or', 'op_no',
  'op_neg', 'op_mod', 'op_obj', 'op_loc',
]);

/**
 * Heuristic phrasing for a stray operator node — prefer the operator's
 * literal text (`+`, `=`, `-`, ...) over the structural type name.
 */
function operatorDisplay(opNode: Parser.SyntaxNode): string {
  const txt = opNode.text.trim();
  return txt.length > 0 && txt.length <= 4 ? txt : opNode.type.replace(/^op_/, '');
}

/**
 * Detect targeted single-line ERROR shapes and produce a friendlier
 * message than the generic "Unexpected syntax: X" fallback. Returns
 * null when no specific pattern matches.
 *
 * Patterns handled:
 *   - Bare `@` / `@@` token: ERROR contains only the call marker, the
 *     trailing user_name was missing.
 *   - Trailing operator: ERROR contains only an operator node (e.g.
 *     `x = 1 +` → ERROR(op_arith)) — caller forgot the rhs operand.
 *   - Duplicate type prefix: ERROR contains only a `type_prefix` and
 *     the next sibling under the same parent already has a type_prefix
 *     (e.g. `$$x = 1` → ERROR($) + assignment with $x).
 */
function detectTargetedSingleLineError(node: Parser.SyntaxNode): SyntaxError | null {
  // Collect direct children once.
  const kids: Parser.SyntaxNode[] = [];
  for (let i = 0; i < node.childCount; i++) kids.push(node.child(i)!);

  // Pattern: bare `@` / `@@` — ERROR is exactly one anonymous call marker.
  if (kids.length === 1 && !kids[0].isNamed
      && (kids[0].type === '@' || kids[0].type === '@@')) {
    return {
      startRow: kids[0].startPosition.row,
      startCol: kids[0].startPosition.column,
      endRow: kids[0].endPosition.row,
      endCol: kids[0].endPosition.column,
      message: `Expected user function name after '${kids[0].type}'`,
    };
  }

  // Pattern: trailing operator — ERROR contains exactly one operator node.
  // Anonymous tokens at the leaves of an op_* node would still be wrapped
  // by the named op_* parent in tree-sitter's tree, so checking named
  // children is correct. We also accept the case where the only NAMED
  // child is an operator (e.g. `x = 1 +` → ERROR with op_arith child).
  //
  // Conservatism: only fire when the ERROR is *inside* a real statement
  // context (not directly under source_file, where tree-sitter recovery
  // can dump arbitrary tokens after a catastrophic parse failure and the
  // "operator" is just a leftover character — e.g. `-` from `---`).
  const namedKids = kids.filter(k => k.isNamed);
  if (namedKids.length === 1 && OPERATOR_NODE_TYPES.has(namedKids[0].type)
      && node.parent && node.parent.type !== 'source_file') {
    const op = namedKids[0];
    return {
      startRow: op.startPosition.row,
      startCol: op.startPosition.column,
      endRow: op.endPosition.row,
      endCol: op.endPosition.column,
      message: `Expected expression after '${operatorDisplay(op)}'`,
    };
  }

  // Pattern: duplicate type prefix — ERROR is just `type_prefix`, and
  // the immediate next sibling under the same parent contains a
  // variable_ref that itself starts with a type_prefix.
  if (namedKids.length === 1 && namedKids[0].type === 'type_prefix' && node.parent) {
    const parent = node.parent;
    let myIdx = -1;
    for (let i = 0; i < parent.childCount; i++) {
      const c = parent.child(i)!;
      // Tree-sitter creates a fresh wrapper on each child() call, so
      // compare by id (or position) rather than reference.
      if (c.id === node.id) { myIdx = i; break; }
    }
    const next = myIdx >= 0 && myIdx + 1 < parent.childCount ? parent.child(myIdx + 1) : null;
    if (next && containsLeadingTypePrefix(next)) {
      const prefix = namedKids[0].text;
      return {
        startRow: namedKids[0].startPosition.row,
        startCol: namedKids[0].startPosition.column,
        endRow: namedKids[0].endPosition.row,
        endCol: namedKids[0].endPosition.column,
        message: `Duplicate type prefix '${prefix}'`,
      };
    }
  }

  return null;
}

/**
 * Returns true if `node` contains a `variable_ref` whose first child is
 * a `type_prefix` (used to detect the second prefix in a `$$x` shape).
 */
function containsLeadingTypePrefix(node: Parser.SyntaxNode): boolean {
  const cursor = node.walk();
  let found = false;
  function visit(): void {
    const n = cursor.currentNode;
    if (n.type === 'variable_ref' && n.childCount > 0
        && n.child(0)?.type === 'type_prefix') {
      found = true;
      return;
    }
    if (cursor.gotoFirstChild()) {
      do { visit(); if (found) return; } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  }
  visit();
  cursor.delete();
  return found;
}

/**
 * Refine a tree-sitter ERROR node into one or more precise diagnostics.
 *
 * Tree-sitter ERROR nodes can span many lines when parsing goes off the
 * rails (unclosed string eats the rest of the location, missing 'end'
 * swallows everything, etc.).  Instead of highlighting the full span,
 * we inspect the ERROR node's *children* — tree-sitter still recovers
 * structure inside ERROR nodes — to classify the likely root cause:
 *
 *   1. Unclosed quote  — bare `'`/`"` or multi-line string child
 *   2. Unclosed brace  — bare `{` without matching `}`
 *   3. Unclosed block  — act/if/loop keyword without matching 'end'
 *   4. Fallback        — narrow to the first meaningful line
 *
 * Quote/brace problems are reported first because they corrupt parsing
 * and cause cascading false positives (e.g. a runaway string will also
 * make the enclosing act look unclosed).
 *
 * Returns `{ diagnostics, summarized }`:
 *   - `summarized: true` — the diagnostic(s) describe the whole subtree
 *     (unclosed X, missing ':'). The caller must NOT descend further;
 *     any inner MISSING/ERROR nodes are by-products of the same root
 *     cause and reporting them is just noise.
 *   - `summarized: false` — fallback "Unexpected syntax" that only
 *     points at the first problematic child. The caller should still
 *     descend so every child statement's own error surfaces.
 */
interface RefinedError {
  diagnostics: SyntaxError[];
  summarized: boolean;
}

function refineErrorNode(node: Parser.SyntaxNode): RefinedError {
  // ── Single-line errors are already well-scoped ────────────────────
  if (node.endPosition.row === node.startPosition.row) {
    // Check for block/clause keyword missing its mandatory ':'.
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (COLON_KEYWORDS.has(child.type)) {
        const kw = child.text.trim().toLowerCase();
        return { summarized: true, diagnostics: [{
          startRow: node.startPosition.row,
          startCol: node.startPosition.column,
          endRow: node.endPosition.row,
          endCol: node.endPosition.column,
          message: `Missing ':' after '${kw}'`,
        }] };
      }
    }
    // Invalid variable name: after `local`/`set`/`let`, or anywhere a
    // variable_ref slot is expected (inside local_statement,
    // assignment_statement, or variable_list), a bare number is the
    // most common PEG-level violation (`varName = ~digit ...`).
    const vnDiag = detectInvalidVarNameError(node);
    if (vnDiag) return { summarized: true, diagnostics: [vnDiag] };

    // Targeted single-line ERROR shapes — produce friendlier messages
    // than the generic "Unexpected syntax: X" fallback.
    const targeted = detectTargetedSingleLineError(node);
    if (targeted) return { summarized: true, diagnostics: [targeted] };

    return { summarized: false, diagnostics: [{
      startRow: node.startPosition.row,
      startCol: node.startPosition.column,
      endRow: node.endPosition.row,
      endCol: node.endPosition.column,
      message: `Unexpected syntax: ${node.text.length > 40 ? node.text.slice(0, 40) + '…' : node.text}`,
    }] };
  }

  // ── Multi-line: check for missing colon on ANY line ───────────────
  // Scan all COLON_KEYWORD children (if/elseif/act/loop). For each, look
  // for a ':' among siblings on the same line. First match without a
  // trailing ':' wins.
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (!COLON_KEYWORDS.has(child.type)) continue;
    const kwRow = child.startPosition.row;
    let hasColon = false;
    for (let j = i + 1; j < node.childCount; j++) {
      const sib = node.child(j)!;
      if (sib.startPosition.row > kwRow) break;
      if (sib.type === ':') { hasColon = true; break; }
    }
    if (!hasColon) {
      const kw = child.text.trim().toLowerCase();
      // Narrow to the keyword's line.
      const lineStartOffset = kwRow === node.startPosition.row ? node.startPosition.column : 0;
      return { summarized: true, diagnostics: [{
        startRow: kwRow,
        startCol: lineStartOffset,
        endRow: kwRow,
        endCol: child.endPosition.column + 80, // rough line span; LSP trims to line
        message: `Missing ':' after '${kw}'`,
      }] };
    }
  }

  // ── Multi-line: scan children once and collect evidence ───────────

  let firstQuoteEvidence: { child: Parser.SyntaxNode; index: number } | null = null;
  const unclosedBlocks: { child: Parser.SyntaxNode; index: number }[] = [];

  // Find the genuinely unclosed openers (`{`, `(`, `[`) and stray closers
  // (`}`, `)`, `]`) by stack-matching across the WHOLE ERROR subtree.
  // Recovery can nest a matching closer several levels deep inside
  // grandchild ERROR / implicit_statement nodes, so a shallow scan would
  // spuriously flag balanced delimiters. A deep walk finds the genuinely
  // mismatched ones.
  const { unclosed: unclosedDelims, stray: strayDelims } = findDelimiterMismatches(node);
  // The brace-only branch below treats an unclosed `{` specially
  // (it can swallow the rest of the file as one giant code block).
  const unclosedBrace = unclosedDelims.find(t => t.type === '{') ?? null;

  const endKeywordIndices: number[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;

    if (child.type === 'end_keyword') endKeywordIndices.push(i);

    if (!firstQuoteEvidence && !child.isNamed && (child.type === "'" || child.type === '"')) {
      firstQuoteEvidence = { child, index: i };
    }

    if (!firstQuoteEvidence && STRING_NODE_TYPES.has(child.type)
        && child.endPosition.row > child.startPosition.row) {
      firstQuoteEvidence = { child, index: i };
    }

    if (BLOCK_KEYWORDS.has(child.type)) {
      const hasEnd = endKeywordIndices.some(j => j > i);
      if (!hasEnd) unclosedBlocks.push({ child, index: i });
    }
  }

  // ── Prioritise: quote/brace > unclosed blocks > delimiter mismatches > fallback ──

  if (firstQuoteEvidence || unclosedBrace) {
    const results: SyntaxError[] = [];
    if (firstQuoteEvidence) {
      const { row, startCol, endCol } = lineSpan(node, firstQuoteEvidence.index);
      results.push({
        startRow: row, startCol, endRow: row, endCol,
        message: 'Unclosed string',
      });
    }
    if (unclosedBrace) {
      // Span from the unclosed `{` to end of its line. The `{` may be
      // buried inside a descendant (not necessarily an immediate child),
      // so we compute the span from the token itself rather than via
      // lineSpan() which expects a direct-child index.
      const row = unclosedBrace.startPosition.row;
      results.push({
        startRow: row,
        startCol: unclosedBrace.startPosition.column,
        endRow: row,
        endCol: unclosedBrace.startPosition.column + 1,
        message: "Unclosed '{'",
      });
    }
    return { summarized: true, diagnostics: results };
  }

  if (unclosedBlocks.length > 0) {
    return {
      summarized: true,
      diagnostics: unclosedBlocks.map(({ child, index }) => {
        const kwName = child.text.trim().toLowerCase();
        const { row, startCol, endCol } = lineSpan(node, index);
        return {
          startRow: row, startCol, endRow: row, endCol,
          message: `Unclosed '${kwName}' block — missing 'end'`,
        };
      }),
    };
  }

  // Unclosed `(` / `[` (the `{` case was handled above with strings).
  const unclosedParenBracket = unclosedDelims.find(t => t.type === '(' || t.type === '[');
  if (unclosedParenBracket) {
    const t = unclosedParenBracket;
    return { summarized: true, diagnostics: [{
      startRow: t.startPosition.row,
      startCol: t.startPosition.column,
      endRow: t.startPosition.row,
      endCol: t.startPosition.column + 1,
      message: `Unclosed '${t.type}'`,
    }] };
  }

  // Stray closer (`}`, `)`, `]`) at any depth.
  if (strayDelims.length > 0) {
    const t = strayDelims[0];
    return { summarized: true, diagnostics: [{
      startRow: t.startPosition.row,
      startCol: t.startPosition.column,
      endRow: t.startPosition.row,
      endCol: t.startPosition.column + 1,
      message: `Unmatched '${t.type}'`,
    }] };
  }

  // Targeted shapes can also surface in multi-line ERROR nodes when the
  // recovery span happens to extend across a trailing newline (e.g.
  // bare `@\n` produces an ERROR ending at the next row's column 0).
  const targetedML = detectTargetedSingleLineError(node);
  if (targetedML) return { summarized: true, diagnostics: [targetedML] };

  // ── Fallback: narrow to first non-location-header child ───────────
  // Not summarized — caller will descend and emit per-child errors too.
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === 'location_header') continue;
    const { row, startCol, endCol } = lineSpan(node, i);
    return { summarized: false, diagnostics: [{
      startRow: row, startCol, endRow: row,
      endCol: Math.max(endCol, startCol + 1),
      message: 'Unexpected syntax',
    }] };
  }

  // Last resort: first line of the ERROR node
  const nl = node.text.search(/\r?\n/);
  return { summarized: false, diagnostics: [{
    startRow: node.startPosition.row,
    startCol: node.startPosition.column,
    endRow: node.startPosition.row,
    endCol: node.startPosition.column + (nl >= 0 ? nl : Math.min(node.text.length, 80)),
    message: 'Unexpected syntax',
  }] };
}

/**
 * Compute the column span covering a child and all subsequent siblings
 * on the same line.
 */
function lineSpan(
  parent: Parser.SyntaxNode,
  childIndex: number,
): { row: number; startCol: number; endCol: number } {
  const child = parent.child(childIndex)!;
  const row = child.startPosition.row;
  let endCol = child.endPosition.row === row
    ? child.endPosition.column
    : child.startPosition.column + 1;
  for (let j = childIndex + 1; j < parent.childCount; j++) {
    const sib = parent.child(j)!;
    if (sib.startPosition.row !== row) break;
    if (sib.endPosition.row === row) endCol = sib.endPosition.column;
  }
  return { row, startCol: child.startPosition.column, endCol };
}

/**
 * Walk all descendants of `node` in source order, stack-matching paired
 * delimiters (`{}`, `()`, `[]`) at the lexical level. Returns:
 *   - `unclosed`: every opener that has no matching closer (e.g. `{` w/o `}`)
 *   - `stray`:    every closer encountered with an empty stack (e.g. `}` w/o `{`)
 *
 * Tree-sitter error recovery can tuck the matching closer several levels
 * deep inside grandchild ERROR/implicit_statement nodes, so a shallow
 * immediate-children scan reports false "Unclosed X" when the delimiters
 * are actually balanced at that position. A deep stack-based match finds
 * the genuinely-unclosed openers and stray closers.
 *
 * Tokens inside `string` / `single_quoted_string` / `double_quoted_string`
 * subtrees are skipped — their internal characters are not delimiter
 * tokens but string content (`'(' '[' '{'` inside a string don't open
 * anything). `string_interpolation` content IS scanned so that broken
 * `<<...>>` expressions still surface their own delimiter mismatches.
 */
interface DelimiterMismatches {
  unclosed: Parser.SyntaxNode[];
  stray: Parser.SyntaxNode[];
}

const OPEN_DELIMS = new Set(['{', '(', '[']);
const CLOSE_DELIMS = new Set(['}', ')', ']']);
const MATCH_DELIM: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
const SKIP_DELIM_SCAN_TYPES = new Set([
  'string', 'single_quoted_string', 'double_quoted_string', 'raw_string',
]);

function findDelimiterMismatches(node: Parser.SyntaxNode): DelimiterMismatches {
  const stack: Parser.SyntaxNode[] = [];
  const stray: Parser.SyntaxNode[] = [];
  const cursor = node.walk();
  function visit(): void {
    const n = cursor.currentNode;
    // Skip into string subtrees — their content isn't lexical delimiters.
    if (SKIP_DELIM_SCAN_TYPES.has(n.type)) return;
    if (!n.isNamed) {
      if (OPEN_DELIMS.has(n.type)) stack.push(n);
      else if (CLOSE_DELIMS.has(n.type)) {
        const want = MATCH_DELIM[n.type];
        if (stack.length > 0 && stack[stack.length - 1].type === want) stack.pop();
        else stray.push(n);
      }
    }
    if (cursor.gotoFirstChild()) {
      do { visit(); } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  }
  // Descend into children of the root ERROR node (the root itself is named).
  if (cursor.gotoFirstChild()) {
    do { visit(); } while (cursor.gotoNextSibling());
    cursor.gotoParent();
  }
  cursor.delete();
  return { unclosed: stack, stray };
}
