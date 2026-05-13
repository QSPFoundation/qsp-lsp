/**
 * Shared utilities for the tree-sitter symbol walker.
 *
 * Types, constants, argument-parsing and string-manipulation helpers
 * used by the walker, binding collector, and extractors.  This module
 * is a pure leaf — it imports only external types and builtins.
 */


import type Parser from 'web-tree-sitter';
import { type SymbolLocation } from './symbolTable';
import type { LocationSymbols } from './locationSymbols';

// ── Constants ─────────────────────────────────────────────────────────

/** Statements that dynamically evaluate code — locals propagate into them. */
export const DYNAMIC_STMT_NAMES = new Set(['dynamic']);

/** Functions that dynamically evaluate code — locals propagate into them. */
export const DYNAMIC_FUNC_NAMES = new Set(['dyneval']);

/**
 * AST node types that can be direct containers of a function call or
 * statement.  The `*_unary` entries cover QSP's `obj` / `loc` prefix
 * operators (e.g. `obj 'sword'`, `loc {target}`) — these are not
 * statements, but their operand is treated like an arg #0 by the
 * extractors, so they share the same container plumbing.
 */
export const CONTAINER_NODE_TYPES = new Set([
  'statement',
  'na_func_call', 'ext_func_call', 'ml_func_call',
  'na_unary', 'ext_unary', 'ml_unary',
]);

/** AST child types that represent metadata rather than arguments. */
export const META_CHILD_TYPES = new Set([
  'statement_name', 'function_name', 'type_prefix',
  'op_obj', 'op_loc', 'op_no', 'op_neg',
]);

// ── Shared context for var-mediated dynamic/dyneval propagation ──────

export interface VarMediatedCtx {
  consumedCodeBlocks: Set<number>;
  deferredCodeBlocks: Set<number>;
  blockInboundLocals: Map<
    number,
    { node: Parser.SyntaxNode; locals: Map<string, import('./symbolTable').QspSymbol> }
  >;
  /**
   * Per-call-site resolved target code-blocks.  Key = tree-sitter node
   * id of the `dynamic` / `dyneval` call (its container stmt node).
   * Value = list of code-block nodes visible from that call site's
   * scope that the dynamic variable can hold.  May contain multiple
   * targets for sequential overwrites, cross-branch locals, or multiple
   * global assignments.
   */
  callSiteTargets: Map<number, Parser.SyntaxNode[]>;
}

// ── Text helpers ──────────────────────────────────────────────────────

/**
 * Replace line breaks (`\r` / `\n` runs) in a source snippet with single
 * spaces and trim ends, so the snippet renders as a single line in
 * hovers / one-line markdown bullets.  Spaces and tabs are preserved
 * verbatim — including indentation after a line continuation and any
 * runs of spaces inside string literals or location names — so visible
 * fidelity of user-authored text is kept.
 */
export function collapseNewlines(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

// ── Position helpers ──────────────────────────────────────────────────

/** Build a `SymbolLocation` covering a tree-sitter node within the given
 *  document.  Used pervasively to convert AST nodes into LSP-friendly
 *  line/column ranges. */
export function nodeLoc(node: Parser.SyntaxNode, docUri: string): SymbolLocation {
  return {
    uri: docUri,
    line: node.startPosition.row,
    column: node.startPosition.column,
    endLine: node.endPosition.row,
    endColumn: node.endPosition.column,
  };
}

/**
 * Pull a `(prefix, name)` pair out of a `variable_ref` / `ml_variable_ref`
 * node, rejecting cases where the identifier is missing.
 */
export function readVarRef(node: Parser.SyntaxNode): { prefix: string; name: string; key: string } | undefined {
  const nameNode = node.childForFieldName('name');
  if (!nameNode || nameNode.isMissing) return undefined;
  const name = nameNode.text.trim();
  if (!name) return undefined;
  const prefix = node.childForFieldName('prefix')?.text ?? '';
  return { prefix, name, key: (prefix + name).toLowerCase() };
}

// ── Argument helpers ───────────────────────────────────────────────────

/**
 * Look for a `paren_args` child via index-based access.  Avoids the
 * `.children` getter, which allocates an Array and one SyntaxNode
 * wrapper per child — these helpers are called per statement/call,
 * so the saving compounds on large files.
 */
function findParenArgs(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const n = node.childCount;
  for (let i = 0; i < n; i++) {
    const c = node.child(i);
    if (c && c.type === 'paren_args') return c;
  }
  return null;
}

/** Get the first non-meta argument of a statement or function call. */
export function getFirstArgNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const paren = findParenArgs(node);
  if (paren) return paren.namedChild(0);
  const n = node.namedChildCount;
  for (let i = 0; i < n; i++) {
    const c = node.namedChild(i);
    if (c && !META_CHILD_TYPES.has(c.type)) return c;
  }
  return null;
}

/** Get the nth (0-indexed) non-meta argument. */
export function getNthArgNode(node: Parser.SyntaxNode, n: number): Parser.SyntaxNode | null {
  const paren = findParenArgs(node);
  if (paren) return paren.namedChild(n);
  const count = node.namedChildCount;
  let i = 0;
  for (let k = 0; k < count; k++) {
    const c = node.namedChild(k);
    if (c && !META_CHILD_TYPES.has(c.type)) {
      if (i === n) return c;
      i++;
    }
  }
  return null;
}

export function isSingleArgCall(node: Parser.SyntaxNode): boolean {
  const paren = findParenArgs(node);
  if (paren) return paren.namedChildCount === 1;
  const count = node.namedChildCount;
  let seen = 0;
  for (let i = 0; i < count; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type !== 'function_name' && c.type !== 'type_prefix') {
      if (++seen > 1) return false;
    }
  }
  return seen === 1;
}

export function hasInterpolation(node: Parser.SyntaxNode): boolean {
  const n = node.namedChildCount;
  for (let i = 0; i < n; i++) {
    const c = node.namedChild(i);
    if (c && c.type === 'string_interpolation') return true;
  }
  return false;
}

/** Count positional args of a statement / function call (excludes meta children). */
export function countCallArgs(node: Parser.SyntaxNode): number {
  const paren = findParenArgs(node);
  if (paren) return paren.namedChildCount;
  const n = node.namedChildCount;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const c = node.namedChild(i);
    if (c && !META_CHILD_TYPES.has(c.type)) count++;
  }
  return count;
}

/**
 * Count extra positional args of a `user_call_statement` /
 * `user_call_function` (i.e. args after the `user_name`).  When the
 * call uses `paren_args`, those args don't include the name; without
 * parens, the `user_name` child sits among the namedChildren and must
 * be subtracted. None of the `META_CHILD_TYPES` ever appear directly
 * under a user-call node, so we only need to filter out `user_name`.
 */
export function countUserCallExtraArgs(node: Parser.SyntaxNode): number {
  const paren = findParenArgs(node);
  if (paren) return paren.namedChildCount;
  const n = node.namedChildCount;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const c = node.namedChild(i);
    if (c && c.type !== 'user_name') count++;
  }
  return count;
}

// ── String utilities ──────────────────────────────────────────────────

/**
 * Convenience for callers holding a statement / function-call node:
 * returns the string (or `code_block`) sitting *directly* as arg #0,
 * or `null` otherwise.
 *
 * Does NOT recurse into expressions — `setvar 'a' + 'b', …`,
 * `setvar $iif(…), …`, and `setvar $nm, …` all return `null`.  If
 * the caller already holds the arg node, prefer `findDirectString`.
 */
export function findStringInFirstArg(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (!CONTAINER_NODE_TYPES.has(node.type)) return null;
  const firstArg = getFirstArgNode(node);
  return firstArg ? findDirectString(firstArg) : null;
}

/**
 * Returns `node` itself if it's a string literal (single/double-quoted)
 * or a `code_block`, or — for a `string` wrapper — its first quoted
 * child.  Strings containing interpolation (`<<…>>`) are rejected.
 * Returns `null` for anything else (including expressions, variable
 * refs, function calls).  Strictly node-local: never recurses.
 */
export function findDirectString(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.type === 'single_quoted_string' || node.type === 'double_quoted_string') {
    return hasInterpolation(node) ? null : node;
  }
  if (node.type === 'code_block') return node;
  if (node.type === 'string') {
    const n = node.namedChildCount;
    for (let i = 0; i < n; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'single_quoted_string' || child.type === 'double_quoted_string') {
        return hasInterpolation(child) ? null : child;
      }
    }
  }
  return null;
}

export function stripQuotes(s: string): string {
  s = s.trim();
  if (s.length >= 2 && (
    (s[0] === "'" && s[s.length - 1] === "'") ||
    (s[0] === '"' && s[s.length - 1] === '"') ||
    (s[0] === '{' && s[s.length - 1] === '}')
  )) {
    return s.slice(1, -1);
  }
  return s;
}

export function isQuotedText(rawText: string): boolean {
  if (rawText.length < 2) return false;
  const first = rawText[0];
  const last = rawText[rawText.length - 1];
  return (first === "'" && last === "'") ||
         (first === '"' && last === '"') ||
         (first === '{' && last === '}');
}

/** Returns raw inner text + byte range of inner text in the source document. */
export function extractQuotedRefCore(
  stringNode: Parser.SyntaxNode,
  docUri: string,
): { rawText: string; inner: string; loc: SymbolLocation } {
  const rawText = stringNode.text;
  const inner = stripQuotes(rawText);
  const isQuoted = isQuotedText(rawText);
  const loc: SymbolLocation = {
    ...nodeLoc(stringNode, docUri),
    column: stringNode.startPosition.column + (isQuoted ? 1 : 0),
    endColumn: stringNode.endPosition.column - (isQuoted ? 1 : 0),
  };
  return { rawText, inner, loc };
}

export function extractQuotedRefInfo(
  stringNode: Parser.SyntaxNode,
  docUri: string,
): { name: string; loc: SymbolLocation } {
  const { inner, loc } = extractQuotedRefCore(stringNode, docUri);
  const leadingSpaces = inner.length - inner.trimStart().length;
  const trailingSpaces = inner.length - inner.trimEnd().length;
  return {
    name: inner.trim(),
    loc: {
      ...loc,
      column: loc.column + leadingSpaces,
      endColumn: loc.endColumn - trailingSpaces,
    },
  };
}

export function extractExactQuotedRefInfo(
  stringNode: Parser.SyntaxNode,
  docUri: string,
): { name: string; loc: SymbolLocation } {
  const { inner, loc } = extractQuotedRefCore(stringNode, docUri);
  return { name: inner, loc };
}

// ── Consumed code-block tracking ──────────────────────────────────────

/**
 * Record a code_block that has been consumed as an argument (string arg
 * to goto/killvar/… or direct arg to dynamic/dyneval).  For dynamic blocks,
 * merges caller-site locals into every target deferred block's inbound set
 * so the deferred walker injects them into the block's synthetic scope.
 */
export function markConsumedCodeBlock(
  node: Parser.SyntaxNode,
  ctx: VarMediatedCtx,
  locSymbols: LocationSymbols,
  scopeId: number,
  docUri: string,
): void {
  const nameNode = node.childForFieldName('name');
  const stmtName = nameNode?.text.toLowerCase() ?? '';
  const isDynamic = DYNAMIC_STMT_NAMES.has(stmtName) || DYNAMIC_FUNC_NAMES.has(stmtName);

  const s = findStringInFirstArg(node);
  if (s && s.type === 'code_block') {
    if (isDynamic) {
      locSymbols.dynamicCodeBlocks.set(s.id, locSymbols.getLocalsInScope(scopeId));
      // Track the inline block for the missing-result and missing-args
      // diagnostics (always exactly one target).
      locSymbols.resolvedDynamicBlocks.push({
        kind: DYNAMIC_FUNC_NAMES.has(stmtName) ? 'dyneval' : 'dynamic',
        callLoc: nodeLoc(node, docUri),
        blockLocs: [nodeLoc(s, docUri)],
        argCount: Math.max(0, countCallArgs(node) - 1),
      });
    } else {
      ctx.consumedCodeBlocks.add(s.id);
    }
    return;
  }

  // Var-mediated dynamic/dyneval: first arg is a bare variable_ref.
  if (!isDynamic) return;
  const firstArg = getFirstArgNode(node);
  if (!firstArg) return;

  const callLoc: SymbolLocation = nodeLoc(node, docUri);

  if (firstArg.type !== 'variable_ref' && firstArg.type !== 'ml_variable_ref') {
    locSymbols.untrackedDynamicVarCalls.push({
      loc: callLoc, varName: firstArg.text.trim(), reason: 'complex-expression',
    });
    return;
  }
  if (firstArg.childForFieldName('index')) {
    locSymbols.untrackedDynamicVarCalls.push({
      loc: callLoc, varName: firstArg.text.trim(), reason: 'complex-expression',
    });
    return;
  }
  const vRef = readVarRef(firstArg);
  if (!vRef) return;
  const varName = vRef.prefix + vRef.name;
  const varLower = vRef.name.toLowerCase();

  const targets = ctx.callSiteTargets.get(node.id);
  if (!targets || targets.length === 0) return;

  // Track every candidate target so the missing-result and missing-args
  // diagnostics can apply universal-quantification logic over the
  // resolvable target set (warn iff EVERY target fails the contract).
  // For single-target dispatches the array has one entry; for sequential
  // overwrites of a same-scope local, cross-branch local writes, or
  // multiple global assignments (multiple-assignments via
  // bindingCollector), all candidates are listed.
  locSymbols.resolvedDynamicBlocks.push({
    kind: DYNAMIC_FUNC_NAMES.has(stmtName) ? 'dyneval' : 'dynamic',
    callLoc,
    blockLocs: targets.map(t => nodeLoc(t, docUri)),
    argCount: Math.max(0, countCallArgs(node) - 1),
  });

  const callerLocals = locSymbols.getLocalsInScope(scopeId);
  const localsSnapshot = new Map<string, import('./symbolTable').QspSymbol>();
  for (const [baseName] of callerLocals) {
    const sym = locSymbols.findLocalInScope(baseName, scopeId);
    if (sym) localsSnapshot.set(baseName, sym);
  }

  locSymbols.dynamicVarCalls.push({
    loc: callLoc, varName, varBaseName: varLower,
    localNames: Array.from(localsSnapshot.keys()),
  });

  for (const blockNode of targets) {
    let entry = ctx.blockInboundLocals.get(blockNode.id);
    if (!entry) {
      entry = { node: blockNode, locals: new Map() };
      ctx.blockInboundLocals.set(blockNode.id, entry);
    }
    for (const [name, sym] of localsSnapshot) {
      if (!entry.locals.has(name)) entry.locals.set(name, sym);
    }
  }
}
