/**
 * Doubled-quote interpolation re-parse pass.
 *
 * When a `<<…>>` body contains the host string's doubled-quote escape
 * (`''` in a '-quoted host, `""` in a "-quoted host), the grammar's
 * external scanner captures the whole body as one opaque
 * `interpolation_raw_body` token instead of letting the context-free
 * lexer mis-treat those quotes as host-string escapes.
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
import {
  INTP_BODY_SUB_COL,
  wrapInterpolationBody,
} from './embeddedReparse';

// ── Interpolation re-parse constants ─────────────────────────────────

/** Synthetic location name for sub-extraction. */
const INTP_SUB_LOC_NAME = '__intp__';

/**
 * Synthetic LHS variable inside the interpolation wrapper.  Lowercased
 * because variable identifiers fold to lowercase in QSP.  Filtered out
 * at merge time so it never pollutes host symbols.
 */
const INTP_SYNTHETIC_LHS = '_r_';

/** One-shot synthetic-LHS skip set (interned for hot-path reuse). */
const INTP_SKIP_VARS: ReadonlySet<string> = new Set([INTP_SYNTHETIC_LHS]);

// ── Predicate ────────────────────────────────────────────────────────

/**
 * Per-tree memo for {@link interpolationNeedsDecode}.  The predicate
 * is invoked from three passes (symbol walker, semantic tokens, this
 * module) on the same nodes; without a cache each call re-materializes
 * `intp.text` (UTF-8→UTF-16 allocation across the whole interpolation
 * span).  Keyed on `Tree` so entries are auto-released when the tree
 * is GC'd; keyed on stable per-tree `node.id` within.
 */
const decodeCache = new WeakMap<Parser.Tree, Map<number, boolean>>();

/**
 * True if `intp` is a `string_interpolation` whose inline parse is
 * corrupted by the enclosing string's doubled-quote escapes.  The
 * enclosing string's quote character is recovered by walking up the
 * parent chain to the first `single_quoted_string` /
 * `double_quoted_string` ancestor.  Result is memoized per tree.
 */
export function interpolationNeedsDecode(
  intp: Parser.SyntaxNode,
): boolean {
  if (intp.type !== 'string_interpolation') return false;
  let perTree = decodeCache.get(intp.tree);
  if (!perTree) decodeCache.set(intp.tree, perTree = new Map());
  const cached = perTree.get(intp.id);
  if (cached !== undefined) return cached;
  let p: Parser.SyntaxNode | null = intp.parent;
  while (p && p.type !== 'single_quoted_string' && p.type !== 'double_quoted_string') {
    p = p.parent;
  }
  // Check for the doubled-quote escape ANYWHERE in the interpolation
  // text — `<<` / `>>` delimiters cannot contain `''`, so scanning
  // the whole node text is equivalent to scanning the body.
  const result = p !== null
    && intp.text.includes(p.type === 'single_quoted_string' ? "''" : '""');
  perTree.set(intp.id, result);
  return result;
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

/**
 * Re-parse every doubled-quote interpolation tagged inside `locBlock`
 * and merge its symbols into `locSymbols`.
 *
 * Exported so {@link extractEmbeddedExec} can run the interpolation
 * pass over an `exec:` body's sub-tree: a `<<…>>` whose escapes were
 * NOT fully resolved by the host string's first decode (quadrupled
 * quotes) is tagged `needs-decode` by the sub-walker but would
 * otherwise be dropped, since the top-level interpolation pass only
 * visits the ORIGINAL tree's locations.  Running it on the exec
 * sub-tree leaves every ref in sub-tree coordinates so the exec
 * pass's own translator can project them the rest of the way to
 * source.
 */
export function processLocationInterpolations(
  locBlock: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
  parseFn: (text: string) => Parser.Tree | null,
): void {
  // Fast path: skip the cursor walk entirely unless the symbol walker
  // tagged a needs-decode interpolation in this location.  Most
  // documents have none, so this is a no-op for them.
  const hostScopes = locSymbols.interpolationHostScopes;
  if (hostScopes.size === 0) return;

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
    if (n.type === 'string_interpolation') {
      const hostScope = hostScopes.get(n.id);
      if (hostScope !== undefined) {
        // Tagged needs-decode: handle wholesale, don't descend — the
        // body is an opaque raw token with no children to walk anyway.
        processInterpolation(n, locSymbols, docUri, parseFn, allocScope, hostScope);
        return;
      }
      // Untagged (inline-parsed) interpolation: descend — a NESTED
      // interpolation inside an inner string with the opposite quote
      // may itself be tagged (e.g. `'<<len("hi <<f(""x"")>> bye")>>'`).
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

  // The body is the opaque raw token the external scanner produced.
  // Using the node (rather than slicing `intp.text`) stays correct
  // when the closing `>>` is MISSING (unterminated host string).
  const bodyNode = findNamedChildOfType(intp, 'interpolation_raw_body');
  if (!bodyNode) return;
  const innerBody = bodyNode.text;
  if (innerBody.length === 0) return;

  const { text: decoded, extra } = decodeDoubledQuotes(innerBody, hostQuote);

  // Wrap as the RHS of an assignment so the body parses as a single
  // expression.  `_r_=(BODY)` puts the body at column INTP_BODY_SUB_COL
  // on line 1 of the wrapped tree.
  const subTree = parseFn(wrapInterpolationBody(decoded));
  if (!subTree) return;

  const hostLoc = nodeLoc(intp, docUri);
  const translate = makeTranslator(
    bodyNode, decoded, /*decodedBodyStart*/ 0, /*bodyLen*/ decoded.length, extra, hostLoc,
    /*hostPrefixLen*/ 0,       // bodyNode starts AT the body, no `<<` to skip
    /*subBodyCol*/    INTP_BODY_SUB_COL,
  );

  try {
    // Surface syntax errors from the decoded body so users see
    // diagnostics for malformed interpolation expressions.  Run this
    // BEFORE the structural / location_block checks so even bodies so
    // broken that no `location_block` is produced (e.g. `<<''>>` →
    // decoded body `'`, an unclosed string) still get error feedback.
    collectEmbeddedErrors(subTree, translate, hostLoc, locSymbols);

    const subLocBlock = findNamedChildOfType(subTree.rootNode, 'location_block');
    if (!subLocBlock) return;

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
