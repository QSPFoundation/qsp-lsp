/**
 * Scope and binding-visibility helpers for tree-sitter ASTs.
 *
 * These functions walk the tree-sitter parent chain to determine
 * lexical scope boundaries and whether a variable binding (definition)
 * is visible from a given consumer node.
 *
 * They are shared between the pre-walk (collectVariableBindings) and
 * the main walker in extractSymbols, and are also used directly by
 * variableBindings.ts for binding resolution.
 */


import type Parser from 'web-tree-sitter';

// ──────────────────────────────────────────────────────────────────────
// Local helpers — duplicates of items in extractSymbols.ts to keep this
// module self-contained and avoid circular imports.
// ──────────────────────────────────────────────────────────────────────

/** Statement names that dynamically evaluate code. */
const DYNAMIC_STMT_NAMES = new Set(['dynamic']);

/** Functions that dynamically evaluate code. */
const DYNAMIC_FUNC_NAMES = new Set(['dyneval']);

/** AST node types that can be direct containers of a function call or statement. */
const CONTAINER_NODE_TYPES = new Set([
  'statement',
  'na_func_call', 'ext_func_call', 'ml_func_call',
  'na_unary', 'ext_unary', 'ml_unary',
]);

/** AST child types that represent metadata rather than arguments. */
const META_CHILD_TYPES = new Set([
  'statement_name', 'function_name', 'type_prefix',
  'op_obj', 'op_loc', 'op_no', 'op_neg',
]);

/** Get the first non-meta argument of a statement or function call. */
function getFirstArgNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (const child of node.children) {
    if (child.type === 'paren_args') {
      return child.namedChildren[0] ?? null;
    }
  }
  for (const child of node.namedChildren) {
    if (!META_CHILD_TYPES.has(child.type)) return child;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Scope classification
// ──────────────────────────────────────────────────────────────────────

/**
 * Node types that open a new lexical scope.  Note that `code_block` is
 * scope-forming only when it's not consumed as a string argument —
 * callers must filter consumed blocks out before calling this helper.
 */
export function isScopeForming(nodeType: string): boolean {
  switch (nodeType) {
    case 'act_block':
    case 'act_inline':
    case 'loop_block':
    case 'loop_inline':
    case 'if_block':
    case 'if_inline':
    case 'else_clause':
    case 'elseif_clause':
    case 'else_inline':
    case 'elseif_inline':
    case 'code_block':
      return true;
    default:
      return false;
  }
}

/**
 * Returns true for else/elseif branch nodes.  When `isBindingVisibleFrom`
 * walks up and crosses one of these, bindings whose `bindScopeId` is the
 * enclosing if_block (i.e. bindings in the *if-body*, not the else/elseif)
 * are NOT visible — they belong to a sibling branch, not the current one.
 */
export function isBranchNode(nodeType: string): boolean {
  switch (nodeType) {
    case 'else_clause':
    case 'elseif_clause':
    case 'else_inline':
    case 'elseif_inline':
      return true;
    default:
      return false;
  }
}

/**
 * Isolating scope boundaries — parent locals do NOT propagate across
 * them, and bindings inside them are NOT visible to consumers outside.
 *
 * `code_block` is isolating EXCEPT when it's the direct argument of a
 * `dynamic` / `dyneval` call, in which case it inherits the caller's
 * scope.  `isDynamicArgCodeBlock(node)` makes that determination.
 */
export function isIsolatingScope(nodeType: string): boolean {
  switch (nodeType) {
    case 'act_block':
    case 'act_inline':
    case 'code_block':
      return true;
    default:
      return false;
  }
}

/**
 * Return true when `node` is a `code_block` that appears as the direct
 * first argument of a `dynamic` / `dyneval` call — such blocks inherit
 * the caller's scope (non-isolating).
 */
export function isDynamicArgCodeBlock(node: Parser.SyntaxNode): boolean {
  if (node.type !== 'code_block') return false;
  // The container may be the direct parent (e.g. `dynamic { … }`) or
  // the grandparent when the call uses parentheses (e.g.
  // `dyneval({ … })`, where the parent is `paren_args`).
  let container = node.parent;
  if (!container) return false;
  if (container.type === 'paren_args') container = container.parent;
  if (!container) return false;
  if (!CONTAINER_NODE_TYPES.has(container.type)) return false;
  const nameNode = container.childForFieldName('name');
  const stmtName = nameNode?.text.toLowerCase() ?? '';
  if (!DYNAMIC_STMT_NAMES.has(stmtName) && !DYNAMIC_FUNC_NAMES.has(stmtName)) return false;
  // The first-arg must be this code_block itself (direct literal).
  const firstArg = getFirstArgNode(container);
  return firstArg?.id === node.id;
}

// ──────────────────────────────────────────────────────────────────────
// Scope ancestor walkers
// ──────────────────────────────────────────────────────────────────────

/**
 * Walk from `node` upward, returning the nearest ancestor whose type
 * is scope-forming AND not a consumed/deferred code block.  Returns
 * `null` when no such ancestor exists within `stopAt`.
 *
 * `isConsumed(nodeId)` — return true to skip a code_block that should
 * not count as a scope (e.g. consumed as a string arg, or not walked).
 */
export function findScopeAncestor(
  node: Parser.SyntaxNode,
  stopAt: Parser.SyntaxNode,
  isConsumed: (id: number) => boolean,
): Parser.SyntaxNode | null {
  let a: Parser.SyntaxNode | null = node.parent;
  while (a && a.id !== stopAt.id) {
    if (isScopeForming(a.type)) {
      if (a.type === 'code_block' && isConsumed(a.id)) {
        a = a.parent;
        continue;
      }
      return a;
    }
    a = a.parent;
  }
  return null;
}

/**
 * Walk from `node` upward, returning the nearest isolating-scope
 * ancestor (act_*, non-dynamic code_block).  Returns `null` when no
 * such ancestor exists within `stopAt`.
 */
export function findIsolationAncestor(
  node: Parser.SyntaxNode,
  stopAt: Parser.SyntaxNode,
  isConsumed: (id: number) => boolean,
): Parser.SyntaxNode | null {
  let a: Parser.SyntaxNode | null = node.parent;
  while (a && a.id !== stopAt.id) {
    if (isIsolatingScope(a.type)) {
      if (a.type === 'code_block') {
        if (isConsumed(a.id)) { a = a.parent; continue; }
        if (isDynamicArgCodeBlock(a)) { a = a.parent; continue; }
      }
      return a;
    }
    a = a.parent;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Binding visibility
// ──────────────────────────────────────────────────────────────────────

/**
 * Determine whether a binding with scope-ancestor `bindScopeId`,
 * isolation-ancestor `bindIsolId`, and `bindIsLocal` flag is visible
 * from a consumer at `consumerNode`.  Walks from the consumer upward.
 *
 * Visibility rules:
 *   • Global (non-local) bindings are visible EVERYWHERE — QSP stores
 *     them in a single flat namespace; isolation boundaries only
 *     affect `local` bindings.
 *   • For local bindings:
 *     – If we reach `bindScopeId` along the way, visible.
 *     – If we pass through an isolating scope (≠ bindScopeId and
 *       ≠ bindIsolId), blocked.
 *     – At the top level (reached `stopAt`), visible iff
 *       `bindScopeId === 0`.
 */
export function isBindingVisibleFrom(
  consumerNode: Parser.SyntaxNode,
  stopAt: Parser.SyntaxNode,
  bindScopeId: number,
  bindIsolId: number,
  bindIsLocal: boolean,
  isConsumed: (id: number) => boolean,
): boolean {
  // Globals: always visible.  (Shadowing by nested locals is handled
  // by the consumer picking the innermost visible binding — which in
  // our call-site resolver means every visible local binding is also
  // collected; the ambiguity rule disambiguates at the end.)
  if (!bindIsLocal) return true;

  // When the walk passes through an else/elseif branch node, any
  // binding whose scopeNodeId equals the DIRECTLY-CONTAINING if_block
  // (i.e. the if-body — a sibling branch) must be treated as not
  // visible.  We record the id of that specific if_block so that only
  // that scope is blocked; bindings in ENCLOSING scopes (a loop body
  // that wraps the whole if/else, for example) are still visible.
  let blockedScopeId = 0;  // 0 = nothing blocked

  let a: Parser.SyntaxNode | null = consumerNode.parent;
  while (a && a.id !== stopAt.id) {
    if (a.id === bindScopeId) {
      // Found the binding's scope anchor.  Block only when this is the
      // exact if_block whose if-body we must not reach from a sibling
      // branch.
      return a.id !== blockedScopeId;
    }
    if (isBranchNode(a.type) && a.parent) {
      // Record this else/elseif's direct parent (the if_block) as the
      // scope to block.  A later branch node at a different nesting
      // level will overwrite this with its own parent — which is the
      // correct thing to do (we only ever need to block the innermost
      // branch's direct parent at any point in the walk).
      blockedScopeId = a.parent.id;
    }
    if (isScopeForming(a.type)) {
      if (a.type === 'code_block' && (isConsumed(a.id) || isDynamicArgCodeBlock(a))) {
        a = a.parent;
        continue;
      }
      if (isIsolatingScope(a.type) && a.id !== bindScopeId && a.id !== bindIsolId) {
        return false;
      }
    }
    a = a.parent;
  }
  // Reached stopAt (location body) — visible iff binding is also top-level.
  return bindScopeId === 0;
}
