/**
 * Variable classification utilities.
 *
 * Determine whether a variable_ref AST node is a definition (LHS of
 * plain `=` or local declaration), a compound-assignment LHS (`+=`, …),
 * whether it has a value-bearing RHS, and whether it is declared local.
 */


import type Parser from 'web-tree-sitter';
import { lookupFunctionReturnType } from './builtins';

/** Find a child with the given type via index-based access (no array alloc). */
function findNamedChildOfType(
  node: Parser.SyntaxNode,
  type: string,
): Parser.SyntaxNode | undefined {
  const n = node.namedChildCount;
  for (let i = 0; i < n; i++) {
    const c = node.namedChild(i);
    if (c && c.type === type) return c;
  }
  return undefined;
}

/**
 * True when `node` (any subtree) recursively contains a `variable_ref`
 * or `ml_variable_ref` whose lowercased base name equals `target`.
 * Used to detect self-referential plain-`=` assignments such as
 * `hp = hp + 5` or `$s = ucase($s)`.
 *
 * Reuses one `TreeCursor` for the whole descent instead of allocating
 * a fresh `SyntaxNode` per child via `namedChild(i)` — important on
 * large files where every assignment RHS gets scanned.  `target` must
 * already be lowercased; tree-sitter token text has no surrounding
 * whitespace so no `.trim()` is needed.
 */
export function subtreeReferencesVariable(
  node: Parser.SyntaxNode,
  target: string,
): boolean {
  const cursor = node.walk();
  let found = false;
  const visit = (): void => {
    const n = cursor.currentNode;
    if (n.type === 'variable_ref' || n.type === 'ml_variable_ref') {
      const nameNode = n.childForFieldName('name');
      if (nameNode && nameNode.text.toLowerCase() === target) {
        found = true;
        return;
      }
    }
    if (cursor.gotoFirstChild()) {
      do { visit(); if (found) return; } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  };
  visit();
  cursor.delete();
  return found;
}

/**
 * True when this `=`-assignment LHS is read-then-written from its
 * positionally-zipped RHS slot.  Caller is `classifyAssignmentLhs`,
 * which has already confirmed `parent` is a `variable_list` whose
 * `grandparent` is a plain-`=` `assignment_statement` with operator
 * node `opNode`.
 *
 * Positional zip: LHS at index `i` pairs with RHS element `i`; the
 * last LHS additionally absorbs every tail element.  Single-LHS
 * (one LHS, any RHS count) naturally falls out as "absorbs all RHS".
 * Examples:
 *   `hp = hp + 5`, `hp = hp, 5`     → single-LHS self-ref
 *   `a, b = a, 1`                   → true for `a`, false for `b`
 *   `a, b = 1, b + 2`               → false for `a`, true for `b` (tail)
 *   `a, b = b, a` (swap)            → false for both
 *   `a, %t = 1, %t, 3`              → true for `%t` (tail with self-ref)
 *
 * Indexed LHS (`arr[0] = arr[0] + 1`) qualifies by base-name match —
 * still a read-then-write of the same array.
 */
function isSelfRefLhs(
  varNode: Parser.SyntaxNode,
  parent: Parser.SyntaxNode,
  grandparent: Parser.SyntaxNode,
  opNode: Parser.SyntaxNode,
): boolean {
  const target = varNode.childForFieldName('name')?.text.toLowerCase();
  if (!target) return false;

  // Locate this LHS's zero-based index among the variable_list's
  // var-ref entries (and total var-ref count).  Identity comparison
  // works because tree-sitter reuses one wrapper per node within a walk.
  const varId = varNode.id;
  let lhsIdx = -1;
  let lhsCount = 0;
  const vlc = parent.namedChildCount;
  for (let i = 0; i < vlc; i++) {
    const v = parent.namedChild(i);
    if (!v || (v.type !== 'variable_ref' && v.type !== 'ml_variable_ref')) continue;
    if (v.id === varId) lhsIdx = lhsCount;
    lhsCount++;
  }
  if (lhsIdx < 0) return false;

  // Single pass over the statement: skip up to and including `opNode`,
  // then position-zip-check each post-op RHS element.  Non-last LHS
  // only checks its paired slot; last LHS checks the entire tail.
  const isLast = lhsIdx === lhsCount - 1;
  const total = grandparent.namedChildCount;
  let pastOp = false;
  let rhsIdx = -1;
  for (let i = 0; i < total; i++) {
    const c = grandparent.namedChild(i);
    if (!c) continue;
    if (!pastOp) {
      if (c.id === opNode.id) pastOp = true;
      continue;
    }
    rhsIdx++;
    if (rhsIdx < lhsIdx) continue;
    if (!isLast && rhsIdx > lhsIdx) break;
    if (subtreeReferencesVariable(c, target)) return true;
  }
  return false;
}

/** Check if a variable_ref is on the LHS of a plain `=` assignment or in a local declaration.
 *
 *  Self-referential plain-`=` assignments (`hp = hp + 5`) are NOT
 *  definitions — they are read-then-writes of an existing value.
 *  Callers that also need to know whether the LHS is a compound op
 *  should use {@link classifyAssignmentLhs} to avoid scanning twice.
 */
export function isVariableDefinition(varNode: Parser.SyntaxNode): boolean {
  return classifyAssignmentLhs(varNode) === 'definition';
}

/**
 * Combined LHS classifier for a `variable_ref` node.  Returns:
 *   • `'definition'` — plain-`=` assignment LHS OR `local …` declaration
 *   • `'compound'`   — explicit compound op (`+=`/etc.) OR self-referential plain `=`
 *     (`hp = hp + 5`, `a, b = a, 1` → `a`, `arr[0] = arr[0] + 1`, …)
 *   • `null`         — not an assignment LHS (i.e. a usage)
 *
 * Single entry point so callers needing the full trichotomy pay the
 * self-ref RHS scan at most once per LHS — important on huge files
 * where the variable-ref count dominates walk cost.
 */
export function classifyAssignmentLhs(
  varNode: Parser.SyntaxNode,
): 'definition' | 'compound' | null {
  const parent = varNode.parent;
  if (!parent || parent.type !== 'variable_list') return null;
  const grandparent = parent.parent;
  if (!grandparent) return null;
  if (grandparent.type === 'local_statement') return 'definition';
  if (grandparent.type !== 'assignment_statement') return null;
  const opNode = findNamedChildOfType(grandparent, 'assignment_operator');
  if (!opNode) return null;
  if (opNode.text !== '=') return 'compound';
  return isSelfRefLhs(varNode, parent, grandparent, opNode) ? 'compound' : 'definition';
}

/**
 * Returns true when `node` is an RHS expression that statically
 * yields a tuple value — and therefore unpacks across multiple LHS
 * slots in `local a, b, c = <node>` / `a, b, c = <node>`.  Covered
 * shapes:
 *   • tuple literals: `[1, 2]`, `(1, 2)`
 *   • `%`-prefixed variable/func calls: `%f`, `%foo(…)`
 *   • built-in calls whose engine-declared return type is `%`
 *     (e.g. `arrpack(…)`)
 *
 * Anything else (user calls without prefix, arithmetic, strings, …)
 * returns false — we fall back to positional zip and leave any
 * unmatched LHS as declaration-only.
 */
export function isTupleTypedRhs(node: Parser.SyntaxNode): boolean {
  switch (node.type) {
    case 'bracket_tuple':
    case 'paren_tuple':
    case 'tuple':
      return true;
    case 'variable_ref':
    case 'ml_variable_ref':
      return node.childForFieldName('prefix')?.text === '%';
    case 'na_func_call':
    case 'ext_func_call':
    case 'ml_func_call': {
      if (node.childForFieldName('prefix')?.text === '%') return true;
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return false;
      return lookupFunctionReturnType(nameNode.text.toLowerCase()) === '%';
    }
  }
  return false;
}

/**
 * Unwrap the `tuple` choice node (`tuple → bracket_tuple|paren_tuple`)
 * and return the inner literal node when present, or `null` when
 * `node` is not a tuple literal (e.g. it's an opaque `%`-typed
 * var-ref or function call).  Empty literals (`[]` / `()`) still
 * return the inner node — callers distinguish "empty literal" from
 * "opaque" via this `null` vs node distinction.
 */
export function tupleLiteralOf(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const inner = node.type === 'tuple' ? node.namedChild(0) : node;
  return (inner && (inner.type === 'bracket_tuple' || inner.type === 'paren_tuple'))
    ? inner : null;
}

/**
 * For a variable_ref recognised by `isVariableDefinition`, return
 * whether the surrounding statement actually binds a *value* to this
 * particular variable.
 *
 *   `x = 1`             → true
 *   `local x = 1`       → true
 *   `local x`           → false (declaration only — empty value)
 *   `local x, y = 1`    → true for x, false for y (positional zip)
 *   `local a, b, c = [1, 2]`  → true for a/b, false for c
 *   `local a, b, c = (1, 2)`  → true for a/b, false for c (same as above)
 *   `local a, b = %f`   → true for both (opaque tuple — element count unknown)
 *   `local a, %t = 1, 2, 3` → true for both (%t absorbs the 2,3 tail)
 *   `local a, %t = 1`   → true for a, false for %t (no tail to absorb)
 *   `local a, b, %t = 1` → true for a, false for b and %t
 *   `x += 1`            → n/a — `isVariableDefinition` returns false for compound ops
 */
export function variableDefinitionHasValue(varNode: Parser.SyntaxNode): boolean {
  const parent = varNode.parent;
  if (!parent) return false;

  const scanRhs = (stmt: Parser.SyntaxNode): { count: number; first: Parser.SyntaxNode | null } => {
    const total = stmt.namedChildCount;
    let seenList = false;
    let count = 0;
    let first: Parser.SyntaxNode | null = null;
    for (let i = 0; i < total; i++) {
      const c = stmt.namedChild(i);
      if (!c) continue;
      if (!seenList) {
        if (c.type === 'variable_list') seenList = true;
        continue;
      }
      if (c.type === 'assignment_operator') continue;
      if (count === 0) first = c;
      count++;
    }
    return seenList ? { count, first } : { count: 0, first: null };
  };

  // Direct child of local_statement (single-var form, no list).
  if (parent.type === 'local_statement') {
    return scanRhs(parent).count > 0;
  }

  if (parent.type !== 'variable_list') return false;
  const grandparent = parent.parent;
  if (!grandparent) return false;
  if (grandparent.type !== 'assignment_statement' && grandparent.type !== 'local_statement') {
    return false;
  }

  const { count: rhsCount, first: firstRhs } = scanRhs(grandparent);
  if (rhsCount === 0) return false;

  // Single pass: locate this varNode's index in the variable_list,
  // count total LHS vars, and capture the tail node — all from one
  // walk of `parent.namedChild(i)`.
  const sr = varNode.startPosition.row;
  const sc = varNode.startPosition.column;
  const vlc = parent.namedChildCount;
  let totalVars = 0;
  let idx = -1;
  for (let i = 0; i < vlc; i++) {
    const v = parent.namedChild(i);
    if (!v || (v.type !== 'variable_ref' && v.type !== 'ml_variable_ref')) continue;
    if (v.startPosition.row === sr && v.startPosition.column === sc) idx = totalVars;
    totalVars++;
  }
  if (idx < 0) return false;

  // Unified tuple semantics for `a, b, c = …` (with or without
  // `local`): pack RHS into a tuple, then zip element-wise — and the
  // LAST LHS greedily absorbs any tail.  A `%`-prefixed last LHS
  // follows the same rule: it's value-bearing only when at least one
  // RHS element remains for it to absorb (`local a, %t = 1` →
  // %t unassigned; `local a, %t = 1, 2` → %t=[2]).
  //   • Literal tuple → element count is statically known.
  //   • Opaque tuple (`%f`, `arrpack(…)`) → element count is
  //     unknown so we conservatively mark every LHS as
  //     value-bearing (suppresses spurious "uninitialised"
  //     warnings on slots that may legitimately be filled).
  let effectiveCount = rhsCount;
  if (rhsCount === 1 && totalVars > 1 && firstRhs && isTupleTypedRhs(firstRhs)) {
    const lit = tupleLiteralOf(firstRhs);
    if (lit) effectiveCount = lit.namedChildCount;
    else return true;            // opaque tuple → all LHS are value-bearing
  }
  // Last-LHS tail absorption: if there's any tail element at all
  // (effectiveCount > idx) the last LHS is value-bearing, even when
  // the tail is just one element.  This is the same as `idx <
  // effectiveCount`, so no separate branch is needed.
  return idx < effectiveCount;
}

/** Check if a variable is declared with LOCAL. */
export function isLocalVariable(varNode: Parser.SyntaxNode): boolean {
  const parent = varNode.parent;
  if (!parent) return false;
  if (parent.type !== 'variable_list') return false;
  return parent.parent?.type === 'local_statement';
}
