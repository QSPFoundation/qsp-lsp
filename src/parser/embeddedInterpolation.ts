/**
 * Doubled-quote interpolation re-parse pass.
 *
 * When tree-sitter's lexer is inside a host string, it greedily eats
 * `''` / `""` as the OUTER string's escape token — even when those
 * bytes appear inside `<<…>>` where, semantically, they're meant to
 * open/close an inner string literal.  Result: `'<<f(''a'')>>'` parses
 * the inner `'a'` as an empty-string + ERROR pair.
 *
 * {@link interpolationNeedsDecode} flags such interpolations so the
 * main walker skips them and {@link extractEmbeddedInterpolations}
 * sub-parses the DECODED body as an expression and merges precise
 * symbols/refs back into the host location.
 *
 * Variable refs inside the decoded body are pinned to the host's
 * lexical scope (act / loop / if locals) — see `mergeIntoHost`'s
 * `varScopeOverride` parameter — matching how the inline-parse path
 * resolves non-doubled-quote interpolations.
 */

import type Parser from 'web-tree-sitter';
import type { DocumentSymbols } from './symbolTable';
import { hasStructuralErrors } from './extractErrors';
import { LocationSymbols } from './locationSymbols';
import { walkLocationBody } from './symbolWalker';
import { nodeLoc } from './walkHelpers';
import {
  collectEmbeddedErrors,
  decodeDoubledQuotes,
  findNamedChildOfType,
  makeScopeAllocator,
  makeTranslator,
  mergeIntoHost,
} from './embeddedShared';

// ── Interpolation re-parse constants ─────────────────────────────────

/** Wrap an interpolation body as the RHS of an assignment. */
const INTP_WRAPPER_PREFIX = '# __intp__\n_r_=(';
const INTP_WRAPPER_SUFFIX = ')\n---\n';

/** Synthetic location name for sub-extraction. */
const INTP_SUB_LOC_NAME = '__intp__';

/**
 * Synthetic LHS variable inside the interpolation wrapper.  Lowercased
 * because variable identifiers fold to lowercase in QSP.  Filtered out
 * at merge time so it never pollutes host symbols.
 */
const INTP_SYNTHETIC_LHS = '_r_';

/** Body sits at column = `INTP_WRAPPER_PREFIX.length - "# __intp__\n".length`. */
const INTP_BODY_SUB_COL = '_r_=('.length;

/** One-shot synthetic-LHS skip set (interned for hot-path reuse). */
const INTP_SKIP_VARS: ReadonlySet<string> = new Set([INTP_SYNTHETIC_LHS]);

// ── Predicate ────────────────────────────────────────────────────────

/**
 * True if `intp` is a `string_interpolation` whose inline parse is
 * corrupted by the enclosing string's doubled-quote escapes.  Fast
 * `indexOf` check on the interpolation's text — no tree traversal.
 *
 * The enclosing string's quote character is recovered by walking up
 * the parent chain to the first `single_quoted_string` /
 * `double_quoted_string` ancestor.
 */
export function interpolationNeedsDecode(
  intp: Parser.SyntaxNode,
): boolean {
  if (intp.type !== 'string_interpolation') return false;
  // Walk up to enclosing host string.
  let p: Parser.SyntaxNode | null = intp.parent;
  while (p && p.type !== 'single_quoted_string' && p.type !== 'double_quoted_string') {
    p = p.parent;
  }
  if (!p) return false;
  const hostQuote = p.type === 'single_quoted_string' ? "'" : '"';
  // Check for the doubled-quote escape ANYWHERE in the interpolation
  // text (which includes the `<<` / `>>` delimiters — those can't
  // contain `''` so it's the same as checking just the body).
  return intp.text.includes(hostQuote + hostQuote);
}

// ── Public entry point ───────────────────────────────────────────────

/**
 * Scan every `string_interpolation` node in `tree` for ones whose
 * inline parse is corrupted by the enclosing string's doubled-quote
 * escapes (see {@link interpolationNeedsDecode}), then sub-parse the
 * DECODED body as an expression and merge precise symbols/refs back
 * into the host location.
 *
 * The main {@link walkLocationBody} pass is expected to have SKIPPED
 * descent into these interpolations (via the same predicate) so the
 * symbols this function produces are net-new, not duplicates.
 *
 * `parseFn` is required; without it the pass is a no-op.
 * `reusedLocations` mirrors the exec pass's skip set.
 */
export function extractEmbeddedInterpolations(
  tree: Parser.Tree,
  docUri: string,
  symbols: DocumentSymbols,
  parseFn?: (text: string) => Parser.Tree | null,
  reusedLocations?: ReadonlySet<string>,
): void {
  if (!parseFn) return;

  const root = tree.rootNode;
  const rootCount = root.namedChildCount;
  for (let i = 0; i < rootCount; i++) {
    const locBlock = root.namedChild(i);
    if (!locBlock || locBlock.type !== 'location_block') continue;

    const header = findNamedChildOfType(locBlock, 'location_header');
    if (!header) continue;
    const nameNode = findNamedChildOfType(header, 'location_name');
    if (!nameNode) continue;

    const locName = nameNode.text.trim();
    if (reusedLocations?.has(locName.toLowerCase())) continue;

    const locSymbols = symbols.getLocation(locName);
    if (!locSymbols) continue;

    processLocationInterpolations(locBlock, locSymbols, docUri, parseFn);
  }
}

function processLocationInterpolations(
  locBlock: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
  parseFn: (text: string) => Parser.Tree | null,
): void {
  // Same per-host scope allocator strategy as exec — needed because
  // {@link mergeIntoHost} unconditionally allocates a scope, even
  // though for interpolations no locals end up bound to it.
  const allocScope = makeScopeAllocator(locSymbols);

  const cursor = locBlock.walk();
  try {
    visit(cursor);
  } finally {
    cursor.delete();
  }

  function visit(c: Parser.TreeCursor): void {
    const n = c.currentNode;
    if (n.type === 'string_interpolation' && interpolationNeedsDecode(n)) {
      // Look up the host scope captured by `symbolWalker` when it
      // skipped descent here.  Falls back to 0 (location top) if the
      // walker didn't visit this node — should not happen for
      // well-formed inputs but keeps behaviour predictable.
      const hostScope = locSymbols.interpolationHostScopes.get(n.id) ?? 0;
      processInterpolation(n, locSymbols, docUri, parseFn, allocScope, hostScope);
      return; // do not descend — sub-parse handled it
    }
    if (c.gotoFirstChild()) {
      do { visit(c); } while (c.gotoNextSibling());
      c.gotoParent();
    }
  }
}

function processInterpolation(
  intp: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
  parseFn: (text: string) => Parser.Tree | null,
  allocScope: () => number,
  hostScope: number,
): void {
  // Recover host quote from enclosing string (interpolation predicate
  // already proved this ancestor exists).
  let host: Parser.SyntaxNode | null = intp.parent;
  while (host && host.type !== 'single_quoted_string' && host.type !== 'double_quoted_string') {
    host = host.parent;
  }
  if (!host) return;
  const hostQuote = host.type === 'single_quoted_string' ? "'" : '"';

  // Body bytes are everything between `<<` and `>>`.  Tree-sitter
  // guarantees `intp.text` starts with `<<` and ends with `>>`.
  const raw = intp.text;
  if (raw.length < 4) return;
  const innerBody = raw.slice(2, -2);
  if (innerBody.length === 0) return;

  const { text: decoded, extra } = decodeDoubledQuotes(innerBody, hostQuote);

  // Wrap as the RHS of an assignment so the body parses as a single
  // expression.  `_r_=(BODY)` puts the body at column INTP_BODY_SUB_COL
  // on line 1 of the wrapped tree.
  const wrapped = INTP_WRAPPER_PREFIX + decoded + INTP_WRAPPER_SUFFIX;
  const subTree = parseFn(wrapped);
  if (!subTree) return;

  const hostLoc = nodeLoc(intp, docUri);
  const translate = makeTranslator(
    intp, decoded, /*decodedBodyStart*/ 0, extra, hostLoc,
    /*hostPrefixLen*/ 2,       // skip `<<`
    /*subBodyCol*/    INTP_BODY_SUB_COL,
  );

  try {
    const subLocBlock = findNamedChildOfType(subTree.rootNode, 'location_block');
    if (!subLocBlock) return;

    // Surface syntax errors from the decoded body so users see
    // diagnostics for malformed interpolation expressions.
    collectEmbeddedErrors(subTree, translate, hostLoc, locSymbols);

    if (hasStructuralErrors(subLocBlock)) return;

    const subSyms = new LocationSymbols(INTP_SUB_LOC_NAME);
    walkLocationBody(subLocBlock, subSyms, docUri);

    // Merge, filtering out the synthetic `_r_` LHS we injected so it
    // doesn't surface as a stray host-level variable.  Variable refs
    // are pinned to `hostScope` — the scope active at the
    // interpolation's lexical position in the host — so they resolve
    // against host locals (act/loop/if bodies) like the inline parse
    // does for non-doubled-quote interpolations.
    mergeIntoHost(subSyms, locSymbols, translate, allocScope, INTP_SKIP_VARS, hostScope);
  } finally {
    subTree.delete();
  }
}
