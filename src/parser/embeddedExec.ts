/**
 * Embedded `exec:` link scanner.
 *
 * QSP games render strings as HTML when `usehtml=1`.  Links of the
 * form `<a href="exec:CODE">…</a>` cause `CODE` to run as QSP at click
 * time, in the player's current call frame — so they behave like
 * deferred `act` bodies: scope-isolating, with no inbound local
 * propagation from the host string's location.
 *
 * For each renderable string in the tree we:
 *   1. Regex-extract `<a href="exec:BODY">` anchor bodies.
 *   2. Decode the host string's doubled-quote escapes.
 *   3. Sub-parse each BODY as QSP source via `parseFn` (wrapped in a
 *      throw-away `# __exec__ … ---` location header/footer).
 *   4. Run the standard {@link walkLocationBody} extractor on the
 *      sub-tree's synthetic location_block, into a fresh
 *      {@link LocationSymbols}.
 *   5. Merge the resulting variables, labels, refs, action defs, and
 *      warnings into the host `LocationSymbols`, rewriting every
 *      `SymbolLocation` to point at the host string node and grafting
 *      sub-scope locals into a fresh isolated scope of the host.
 *
 * Because step 4 uses the same extractor that runs on top-level
 * location bodies, the embedded code gets:
 *   • full variable tracking (definitions, reads, type prefixes),
 *   • location refs (`gs`, `gt`, `func`, `desc`, `@`, `@@`, …),
 *   • object refs / definitions (`addobj`, `delobj`, `modobj`, `obj`),
 *   • action refs / definitions (`act`, `delact`),
 *   • label / jump tracking,
 *   • all the lint warnings (prefix mismatch, arg-count, deprecation),
 * and every existing diagnostic pass (unused-vars, unresolved refs,
 * etc.) fires on it automatically because the symbols land in the
 * host's `LocationSymbols`.
 *
 * Positions for every merged entry are translated back to precise
 * source spans inside the host string body — single-line bodies
 * inside single-line host strings get true per-token ranges; bodies
 * spanning multiple lines fall back to the host string's full span.
 *
 * Strings in identifier positions (location names, file paths, var
 * names, etc.) are skipped — they never reach the HTML renderer.
 *
 * The shared sub-parse / position-translate / merge machinery lives
 * in `embeddedShared.ts` and is also used by `embeddedInterpolation.ts`.
 */

import type Parser from 'web-tree-sitter';
import type { DocumentSymbols } from './symbolTable';
import { hasStructuralErrors } from './extractErrors';
import { LocationSymbols } from './locationSymbols';
import type { SymbolLocation } from './symbolTypes';
import { walkLocationBody } from './symbolWalker';
import { nodeLoc } from './walkHelpers';
import {
  collectEmbeddedErrors,
  decodeDoubledQuotes,
  findNamedChildOfType,
  type LocTranslator,
  makeScopeAllocator,
  makeTranslator,
  mergeIntoHost,
} from './embeddedShared';

// ── Skip table: strings that never reach the HTML renderer ────────────

/** Calls where ALL string args are identifiers/paths/images. */
const SKIP_ALL_ARGS = new Set<string>([
  'modobj', 'mod obj',
  'addobj', 'add obj',
  'delobj', 'del obj',
  'resetobj',
  'delact', 'del act',
]);

/** Call names whose first string arg is a location/path/var identifier. */
const SKIP_ARG0 = new Set<string>([
  // Location refs
  'goto', 'gt', 'xgoto', 'xgt', 'gosub', 'gs', 'jump',
  // Path refs
  'play', 'close', 'view', 'opengame', 'savegame', 'openqst',
  'inclib', 'addqst',
  // Variable-name refs
  'setvar', 'killvar', 'sortarr', 'scanstr', 'unpackarr', 'menu',
  // Dynamic-code arg (handled by the dynamic-block pass)
  'dynamic',
]);

/** Function names whose first arg is a location/var-name identifier. */
const SKIP_ARG0_FN = new Set<string>([
  // Location-ref functions
  'func', 'desc', 'loc', 'isplay',
  // Variable-name functions
  'arrsize', 'arrtype', 'arritem', 'arrpack', 'arrpos', 'arrcomp',
  // Dynamic-code arg
  'dyneval',
]);

/** Calls where both arg0 AND arg1 are var-name identifiers. */
const SKIP_ARG0_AND_ARG1 = new Set<string>(['copyarr']);

/** Regex-pattern arg index by function name. */
const REGEX_PATTERN_ARG: ReadonlyMap<string, number> = new Map([
  ['strcomp', 1], ['strfind', 1], ['strpos', 1], ['arrcomp', 1], ['scanstr', 2],
]);

// ── HTML anchor scanning ─────────────────────────────────────────────

/** Cheap case-insensitive probe for `exec:` substring. */
export const EXEC_PROBE_RE = /exec:/i;

/**
 * Match `<a ...href="exec:CODE"...>` (or single-quoted attribute).
 * `(?:[^>]*?\s)?` requires whitespace before `href` so that custom
 * attributes like `data-href` aren't misidentified.
 *
 * The `d` flag exposes per-group `indices`, letting callers locate
 * the body's exact offset within the match without a second regex.
 *
 * Capture groups:
 *   [1] — the host quote character (`"` or `'`).
 *   [2] — the raw exec body (may contain doubled-quote escapes if the
 *         host string uses the same quote).
 */
export const EXEC_LINK_RE =
  /<a\s(?:[^>]*?\s)?href\s*=\s*(["'])\s*exec:([\s\S]*?)\1[^>]*>/gid;

/** Wrap an exec body so it parses as the body of a location. */
const WRAPPER_PREFIX = '# __exec__\n';
const WRAPPER_SUFFIX = '\n---\n';

/** Synthetic location name used for the throw-away sub-extraction. */
const SUB_LOC_NAME = '__exec__';

// Re-export the doubled-quote decoder for callers that scanned the
// `exec:` body without sub-parsing it (e.g. semantic tokens).
export { decodeDoubledQuotes } from './embeddedShared';

// ── Classifier ────────────────────────────────────────────────────────

/**
 * Returns true when `s` sits in a position where its text is never
 * HTML-rendered — e.g. as an action/object name, a location-ref
 * argument, a file path, or an array subscript.
 */
export function isIdentifierStringContext(s: Parser.SyntaxNode): boolean {
  let owner: Parser.SyntaxNode | null = s.parent;
  if (owner && owner.type === 'string') owner = owner.parent;
  if (!owner) return false;

  const argHolder = owner;
  if (owner.type === 'paren_args') owner = owner.parent;
  if (!owner) return false;

  if (argHolder.type === 'array_index' || owner.type === 'array_index') return true;

  if (owner.type === 'act_block' || owner.type === 'act_inline'
      || owner.type === 'act_statement') {
    return true;
  }

  const nameLower = getCallNameLower(owner);
  if (!nameLower) return false;

  if (SKIP_ALL_ARGS.has(nameLower)) return true;

  const argIdx = positionalArgIndex(argHolder, s);
  if (argIdx < 0) return false;

  if (argIdx === 0) {
    if (SKIP_ARG0.has(nameLower)) return true;
    if (SKIP_ARG0_FN.has(nameLower)) return true;
    if (SKIP_ARG0_AND_ARG1.has(nameLower)) return true;
  }
  if (argIdx === 1 && SKIP_ARG0_AND_ARG1.has(nameLower)) return true;

  if (REGEX_PATTERN_ARG.get(nameLower) === argIdx) return true;

  return false;
}

function getCallNameLower(owner: Parser.SyntaxNode): string | null {
  switch (owner.type) {
    case 'statement':
    case 'na_func_call':
    case 'ext_func_call':
    case 'ml_func_call':
    case 'user_call_statement':
    case 'user_func_call':
    case 'ml_user_func_call': {
      const n = owner.childForFieldName('name');
      return n ? n.text.toLowerCase() : null;
    }
    default:
      return null;
  }
}

function positionalArgIndex(
  argHolder: Parser.SyntaxNode,
  target: Parser.SyntaxNode,
): number {
  if (argHolder.type === 'paren_args') {
    const n = argHolder.namedChildCount;
    for (let i = 0; i < n; i++) {
      const c = argHolder.namedChild(i);
      if (c && (c.id === target.id || c.id === target.parent?.id)) return i;
    }
    return -1;
  }

  const n = argHolder.namedChildCount;
  let argIdx = 0;
  for (let i = 0; i < n; i++) {
    const c = argHolder.namedChild(i);
    if (!c) continue;
    if (isHeaderField(c.type)) continue;
    if (c.id === target.id || c.id === target.parent?.id) return argIdx;
    argIdx++;
  }
  return -1;
}

function isHeaderField(type: string): boolean {
  return type === 'statement_name' || type === 'function_name'
      || type === 'type_prefix' || type === 'user_name';
}

// ── Public entry point ────────────────────────────────────────────────

/**
 * Scan every renderable string literal in `tree` for embedded `exec:`
 * hyperlinks and merge their fully-extracted symbols into the matching
 * host `LocationSymbols`.
 *
 * `parseFn` is used to sub-parse each link body as QSP source.  When
 * omitted, the pass is a no-op.
 *
 * Locations listed in `reusedLocations` are skipped because their
 * embedded refs were already extracted and shifted by `extractSymbols`.
 */
export function extractEmbeddedExec(
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

    processLocation(locBlock, locSymbols, docUri, parseFn);
  }
}

function processLocation(
  locBlock: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
  parseFn: (text: string) => Parser.Tree | null,
): void {
  const allocScope = makeScopeAllocator(locSymbols);

  const cursor = locBlock.walk();
  try {
    visit(cursor);
  } finally {
    cursor.delete();
  }

  function visit(c: Parser.TreeCursor): void {
    const n = c.currentNode;
    if (n.type === 'single_quoted_string' || n.type === 'double_quoted_string') {
      processString(n, locSymbols, docUri, parseFn, allocScope);
      return; // don't descend into string content
    }
    if (c.gotoFirstChild()) {
      do { visit(c); } while (c.gotoNextSibling());
      c.gotoParent();
    }
  }
}

function processString(
  s: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
  parseFn: (text: string) => Parser.Tree | null,
  allocScope: () => number,
): void {
  const raw = s.text;
  if (raw.length < 2 || !EXEC_PROBE_RE.test(raw)) return;
  if (isIdentifierStringContext(s)) return;

  const hostQuote = raw[0];
  if (hostQuote !== "'" && hostQuote !== '"') return;

  // Decode the host string's doubled-quote escapes once.  We also
  // build a `decoded → raw` shift map (`extra[d]` = number of escape
  // pairs collapsed strictly before decoded position `d`) so we can
  // project sub-tree positions back to RAW source positions later.
  const inner = raw.slice(1, -1);
  const { text: decoded, extra } = decodeDoubledQuotes(inner, hostQuote);
  const hostLoc = nodeLoc(s, docUri);

  // `matchAll` returns a fresh iterator and never mutates the regex's
  // `lastIndex`, so the global flag on EXEC_LINK_RE stays safe across
  // concurrent / re-entrant calls.
  for (const m of decoded.matchAll(EXEC_LINK_RE)) {
    const body = m[2];
    if (!body) continue;

    // `d` flag: m.indices[2] is [bodyStart, bodyEnd] in `decoded`.
    const decodedBodyStart = m.indices![2]![0];

    // Build a position translator.  Single-line bodies inside
    // single-line host strings get precise per-token ranges; anything
    // multi-line falls back to the full host span (which is the
    // pre-existing behaviour and remains valid for diagnostics).
    const translate = makeTranslator(
      s, body, decodedBodyStart, extra, hostLoc,
      /*hostPrefixLen*/ 1,    // opening quote
      /*subBodyCol*/    0,    // exec wrapper puts body at col 0 of line 1
    );

    subParseAndMerge(body, translate, hostLoc, locSymbols, docUri, parseFn, allocScope);
  }
}

function subParseAndMerge(
  body: string,
  translate: LocTranslator,
  hostLoc: SymbolLocation,
  hostSyms: LocationSymbols,
  docUri: string,
  parseFn: (text: string) => Parser.Tree | null,
  allocScope: () => number,
): void {
  const wrapped = WRAPPER_PREFIX + body + WRAPPER_SUFFIX;
  const subTree = parseFn(wrapped);
  if (!subTree) return;
  try {
    const subLocBlock = findNamedChildOfType(subTree.rootNode, 'location_block');
    if (!subLocBlock) return;

    // Surface tree-sitter syntax errors from the embedded body as
    // host-level diagnostics with proper source coordinates.  Errors
    // are emitted regardless of severity so the user sees red squiggles
    // inside the `exec:` text the same way they do at top level.
    collectEmbeddedErrors(subTree, translate, hostLoc, hostSyms);

    // Skip bodies that fail to parse cleanly: a partial parse would
    // emit garbage refs / variables.  The user simply gets no
    // exec-body diagnostics for that link until they fix the syntax.
    if (hasStructuralErrors(subLocBlock)) return;

    // Run the standard extractor against the wrapped body so the
    // embedded code gets the same symbol tracking that top-level
    // location bodies receive.
    const subSyms = new LocationSymbols(SUB_LOC_NAME);
    walkLocationBody(subLocBlock, subSyms, docUri, /*inDeferredExecution*/ true);

    mergeIntoHost(subSyms, hostSyms, translate, allocScope);
  } finally {
    subTree.delete();
  }
}
