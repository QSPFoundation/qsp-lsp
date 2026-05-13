/**
 * Variable classification utilities.
 *
 * Determine whether a variable_ref AST node is a definition (LHS of
 * plain `=` or local declaration), a compound-assignment LHS (`+=`, …),
 * whether it has a value-bearing RHS, and whether it is declared local.
 */


import type Parser from 'web-tree-sitter';

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

/** Check if a variable_ref is the LHS of a compound assignment (`+=` / `-=` / `*=` / `/=`). */
export function isCompoundAssignmentLhs(varNode: Parser.SyntaxNode): boolean {
  const parent = varNode.parent;
  if (!parent) return false;
  if (parent.type === 'variable_list') {
    const grandparent = parent.parent;
    if (grandparent?.type === 'assignment_statement') {
      const opNode = findNamedChildOfType(grandparent, 'assignment_operator');
      return opNode !== undefined && opNode.text !== '=';
    }
  }
  return false;
}

/** Check if a variable_ref is on the LHS of a plain `=` assignment or in a local declaration. */
export function isVariableDefinition(varNode: Parser.SyntaxNode): boolean {
  const parent = varNode.parent;
  if (!parent) return false;

  if (parent.type === 'variable_list') {
    const grandparent = parent.parent;
    if (grandparent?.type === 'local_statement') return true;
    if (grandparent?.type === 'assignment_statement') {
      const opNode = findNamedChildOfType(grandparent, 'assignment_operator');
      return !opNode || opNode.text === '=';
    }
  }

  return false;
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
 *   `x += 1`            → n/a — `isVariableDefinition` returns false for compound ops
 */
export function variableDefinitionHasValue(varNode: Parser.SyntaxNode): boolean {
  const parent = varNode.parent;
  if (!parent) return false;

  const countRhsAfter = (stmt: Parser.SyntaxNode): number => {
    const total = stmt.namedChildCount;
    let seenList = false;
    let n = 0;
    for (let i = 0; i < total; i++) {
      const c = stmt.namedChild(i);
      if (!c) continue;
      if (!seenList) {
        if (c.type === 'variable_list') seenList = true;
        continue;
      }
      if (c.type === 'assignment_operator') continue;
      n++;
    }
    return seenList ? n : 0;
  };

  // Direct child of local_statement (single-var form, no list).
  if (parent.type === 'local_statement') {
    return countRhsAfter(parent) > 0;
  }

  if (parent.type !== 'variable_list') return false;
  const grandparent = parent.parent;
  if (!grandparent) return false;

  if (grandparent.type === 'assignment_statement') {
    return true;
  }

  if (grandparent.type === 'local_statement') {
    const rhsCount = countRhsAfter(grandparent);
    if (rhsCount === 0) return false;
    // Find this varNode's index among same-typed siblings in the
    // variable_list, without allocating an intermediate array.
    const sr = varNode.startPosition.row;
    const sc = varNode.startPosition.column;
    const total = parent.namedChildCount;
    let idx = -1;
    let seen = 0;
    for (let i = 0; i < total; i++) {
      const v = parent.namedChild(i);
      if (!v) continue;
      if (v.type !== 'variable_ref' && v.type !== 'ml_variable_ref') continue;
      if (v.startPosition.row === sr && v.startPosition.column === sc) {
        idx = seen;
        break;
      }
      seen++;
    }
    if (idx < 0) return false;
    return idx < rhsCount;
  }

  return false;
}

/** Check if a variable is declared with LOCAL. */
export function isLocalVariable(varNode: Parser.SyntaxNode): boolean {
  const parent = varNode.parent;
  if (!parent) return false;
  if (parent.type !== 'variable_list') return false;
  return parent.parent?.type === 'local_statement';
}
