// ── Target patterns ──────────────────────────────────────────────────
//
// What little can be said about a string expression without running the
// game: which parts are literal text, which come from a variable, and
// which can't be known. Written for the targets of jumps like
// `gt $next` or `gt 'room_' + n` and for the right-hand side of
// assignments, so the jump graph can turn the possible values of those
// variables into possible targets (targetResolver.ts).
//
//   'hall'             → [lit 'hall']
//   $next              → [var next]
//   'room_' + n        → [lit 'room_', var n]
//   "room_<<n>>"       → [lit 'room_', var n]
//   iif(x, 'a', 'b')   → [alt [[lit a], [lit b]]]
//   'r' + $str(n)      → [lit 'r', var n]     ($str, $trim, $lcase, $ucase pass their argument on)
//   $args[0]           → [var args, index 0]  (the location's first argument at its call sites)
//   func('pick')       → [result pick]        (what location `pick` leaves in `result`)
//   $curloc            → [var curloc]         (the location the code is in)
//   $mid($s, 1, 2)     → undefined (nothing to go on)

import type Parser from 'web-tree-sitter';
import { getNthArgNode } from './walkHelpers';
import { lookupBuiltin } from './builtins';

/** One piece of a string expression. */
export type TargetPart =
  | { lit: string }
  /**
   * Every value the variable (lowercase base name) may hold; any element
   * of an array unless `index` gives a constant one. `key` is a string key
   * written out, as storedBlocks.ts compares them: `'text`, or `^text`
   * for one that goes on with something worked out.
   */
  | { var: string; index?: number; key?: string }
  /** What the location (lowercase name) leaves in `result` when called as a function. */
  | { result: string }
  /**
   * A piece nothing is known about. `why` says what it was, for the
   * jump graph's statistics: a built-in function (`call:$mid`), a call of
   * a location (`user-call`) or a grammar node type, never a game name.
   */
  | { any: true; why?: string }
  | { alt: TargetPattern[] };

/** The pieces of a string expression, in order. */
export type TargetPattern = TargetPart[];

// Past these the expression is treated as unknown: patterns stay small,
// and nothing near a location name is this long or this involved.
const MAX_PARTS = 8;
const MAX_LITERAL = 100;
const MAX_DEPTH = 6;

const FUNC_CALLS = new Set(['na_func_call', 'ml_func_call', 'ext_func_call']);
const USER_CALLS = new Set(['user_func_call', 'ml_user_func_call']);
// Built-ins whose result is their argument, as far as a location name goes
// (names are compared ignoring case and surrounding spaces).
const PASS_THROUGH = new Set(['str', 'trim', 'lcase', 'ucase']);
const BINARIES = new Set(['na_binary', 'ml_binary', 'ext_binary']);
const VAR_REFS = new Set(['variable_ref', 'ml_variable_ref']);
const QUOTED = new Set(['single_quoted_string', 'double_quoted_string']);

/**
 * The pattern of a string expression, or undefined when it holds neither
 * literal text nor a variable (a function call, arithmetic, …). With
 * `keepUnknown`, such an expression gives a single unknown part saying
 * what it was instead, for statistics.
 */
export function targetPatternOf(node: Parser.SyntaxNode, keepUnknown = false): TargetPattern | undefined {
  const parts = partsOf(node, 0);
  if (parts.length > MAX_PARTS) return keepUnknown ? [{ any: true, why: 'too long' }] : undefined;
  if (!parts.some(isInformative)) return keepUnknown ? [parts.find(p => 'any' in p) ?? { any: true, why: node.type }] : undefined;
  return parts;
}

/**
 * Patterns of the arguments of a call (after the location name), or
 * undefined when none says anything. At most the first four.
 */
export function argPatternsOf(args: readonly Parser.SyntaxNode[]): Array<TargetPattern | undefined> | undefined {
  const out = args.slice(0, 4).map(a => {
    const p = targetPatternOf(a);
    return p ? share(p) : undefined;
  });
  return out.some(p => p !== undefined) ? out : undefined;
}

// A game passes and assigns the same few literals (`x = 0`, `$s = ''`,
// `gs 'go', 'hall'`) tens of thousands of times; patterns are never
// changed, so those share one.
const sharedLiterals = new Map<string, TargetPattern>();
const MAX_SHARED_LITERALS = 4096;

/** `pattern`, or an equal one already in use when it is a single literal. */
export function share(pattern: TargetPattern): TargetPattern {
  const literal = literalOf(pattern);
  if (literal === undefined) return pattern;
  const shared = sharedLiterals.get(literal);
  if (shared) return shared;
  if (sharedLiterals.size < MAX_SHARED_LITERALS) sharedLiterals.set(literal, pattern);
  return pattern;
}

/** The literal value of a pattern that is one literal, else undefined. */
export function literalOf(pattern: TargetPattern): string | undefined {
  const p = pattern.length === 1 ? pattern[0] : undefined;
  return p && 'lit' in p ? p.lit : undefined;
}

function isInformative(p: TargetPart): boolean {
  if ('lit' in p || 'var' in p || 'result' in p) return true;
  return 'alt' in p && p.alt.some(a => a.some(isInformative));
}

const unknown = (why: string): TargetPattern => [{ any: true, why }];
// Reasons go into log lines users send us (CLAUDE.md): a function the
// game defines, or a mistyped one, is its text, so only built-ins are named.
const callReason = (fn: string) => `call:${lookupBuiltin(fn) ? fn : 'unknown'}`;

function partsOf(node: Parser.SyntaxNode, depth: number): TargetPattern {
  if (depth > MAX_DEPTH) return unknown('too deep');
  const t = node.type;
  if (t === 'string') {
    const inner = node.namedChild(0);
    return inner ? partsOf(inner, depth + 1) : unknown(t);
  }
  if (QUOTED.has(t)) return quotedParts(node, depth);
  if (t === 'number_literal') return [{ lit: node.text.trim() }];
  if (VAR_REFS.has(t)) {
    const name = node.childForFieldName('name')?.text;
    if (!name) return unknown(t);
    const index = node.childForFieldName('index');
    const at = index?.namedChildCount === 1 && index.namedChild(0)!.type === 'number_literal' ? Number(index.namedChild(0)!.text) : undefined;
    if (at !== undefined && Number.isInteger(at)) return [{ var: name.toLowerCase(), index: at }];
    const keyNode = index?.namedChildCount === 1 && index.namedChild(0)!.type === 'string' ? index.namedChild(0)! : undefined;
    const keyParts = keyNode ? partsOf(keyNode, depth + 1) : undefined;
    const first = keyParts?.[0];
    if (first && 'lit' in first) {
      return [{ var: name.toLowerCase(), key: (keyParts!.length === 1 ? "'" : '^') + first.lit.toLowerCase() }];
    }
    return [{ var: name.toLowerCase() }];
  }
  if (t === 'paren_expr' || t === 'paren_args') {
    const inner = node.namedChild(0);
    return inner && node.namedChildCount === 1 ? partsOf(inner, depth + 1) : unknown(t);
  }
  if (BINARIES.has(t)) {
    const op = node.namedChild(1);
    const concat = op?.type === 'op_amp' || (op?.type === 'op_arith' && op.text === '+');
    const left = node.namedChild(0), right = node.namedChild(2);
    // An operator's text names it; anything else in its place (an ERROR
    // node) is the game's text.
    if (!concat || !left || !right) return unknown(op?.type.startsWith('op_') ? `${op.type} ${op.text}`.trim() : op?.type ?? t);
    return join([...partsOf(left, depth + 1), ...partsOf(right, depth + 1)]);
  }
  if (FUNC_CALLS.has(t)) {
    const fn = node.childForFieldName('name')?.text.toLowerCase() ?? '';
    const first = getNthArgNode(node, 0);
    if (fn === 'iif') {
      const yes = getNthArgNode(node, 1), no = getNthArgNode(node, 2);
      if (!yes || !no) return unknown('call:iif');
      return [{ alt: [partsOf(yes, depth + 1), partsOf(no, depth + 1)] }];
    }
    if (PASS_THROUGH.has(fn) && first) return partsOf(first, depth + 1);
    // `$curloc` is a function in QSP; the resolver knows it as the location the code is in.
    if (fn === 'curloc') return [{ var: 'curloc' }];
    if (fn === 'func' && first) {
      const name = literalOf(partsOf(first, depth + 1));
      return name !== undefined ? [{ result: name.trim().toLowerCase() }] : unknown('call:func');
    }
    // Built-in names only: a user's @function is a location, and its name is game content.
    return unknown(callReason(fn));
  }
  if (USER_CALLS.has(t)) {
    const name = node.childForFieldName('name')?.text.trim();
    return name ? [{ result: name.toLowerCase() }] : unknown('user-call');
  }
  return unknown(t);
}

// 'text' / "text", with <<expr>> interpolations and doubled quotes.
function quotedParts(node: Parser.SyntaxNode, depth: number): TargetPattern {
  const raw = node.text;
  const quote = raw[0];
  if (raw.length < 2 || (quote !== "'" && quote !== '"')) return unknown(node.type);
  const unescape = (s: string) => s.split(quote + quote).join(quote);
  const parts: TargetPattern = [];
  let cursor = 1;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c || c.type !== 'string_interpolation') continue;
    const at = raw.indexOf(c.text, cursor);
    if (at < 0) return unknown(node.type);
    if (at > cursor) parts.push({ lit: unescape(raw.slice(cursor, at)) });
    const expr = c.namedChild(0);
    if (expr?.type === 'interpolation_raw_body') parts.push(...rawBodyParts(unescape(expr.text), 0));
    else parts.push(...(expr ? partsOf(expr, depth + 1) : unknown(c.type)));
    cursor = at + c.text.length;
  }
  if (raw.length - 1 > cursor) parts.push({ lit: unescape(raw.slice(cursor, raw.length - 1)) });
  if (parts.length === 0) parts.push({ lit: '' });
  return join(parts);
}

// The body of a `<<…>>` that holds its host's quote doubled
// (`'<<''room_'' + $n>>'`, common in older games): the grammar leaves it
// as one token, so its simple forms are read here, already unescaped.
// Terms joined by + or &: a quoted string, a number, a variable (with a
// constant index), $str/$trim/$lcase/$ucase of one of those, $curloc.
function rawBodyParts(body: string, depth: number): TargetPattern {
  const why = 'interpolation_raw_body';
  const terms = splitTopLevel(body.trim());
  if (!terms || depth > MAX_DEPTH) return unknown(why);
  const parts: TargetPattern = [];
  for (const raw of terms) {
    const term = raw.trim();
    const q = term[0];
    if ((q === "'" || q === '"') && term.length >= 2 && term.endsWith(q)) {
      parts.push({ lit: term.slice(1, -1).split(q + q).join(q) });
      continue;
    }
    if (/^\d+$/.test(term)) {
      parts.push({ lit: term });
      continue;
    }
    const call = /^\$?(\w+)\s*\((.*)\)$/s.exec(term);
    if (call) {
      const fn = call[1].toLowerCase();
      parts.push(...(PASS_THROUGH.has(fn) ? rawBodyParts(call[2], depth + 1) : unknown(callReason(fn))));
      continue;
    }
    const v = /^\$?([^\s\[\]()+\-*/&=<>!,'"@]+)(?:\[\s*(\d+)\s*\])?$/.exec(term);
    if (v) {
      const name = v[1].toLowerCase();
      parts.push(v[2] !== undefined ? { var: name, index: Number(v[2]) } : { var: name });
      continue;
    }
    parts.push(...unknown(why));
  }
  return join(parts);
}

// `a + 'b' & c` → ['a', "'b'", 'c'], outside quotes and parentheses; an
// operator other than + or & at the top level gives undefined.
function splitTopLevel(text: string): string[] | undefined {
  const terms: string[] = [];
  let depth = 0, start = 0, quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        if (text[i + 1] === quote) i++;
        else quote = '';
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '(' || ch === '[') {
      depth++;
    } else if (ch === ')' || ch === ']') {
      depth--;
    } else if (depth === 0 && (ch === '+' || ch === '&')) {
      terms.push(text.slice(start, i));
      start = i + 1;
    } else if (depth === 0 && '-*/=<>,'.includes(ch)) {
      return undefined;
    }
  }
  if (quote || depth !== 0) return undefined;
  terms.push(text.slice(start));
  return terms.some(t => t.trim() === '') ? undefined : terms;
}

// Merge neighbouring literals and unknowns; too long a literal becomes unknown.
function join(parts: TargetPattern): TargetPattern {
  const out: TargetPattern = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if ('lit' in p && last && 'lit' in last) out[out.length - 1] = { lit: last.lit + p.lit };
    else if ('any' in p && last && 'any' in last) continue;
    else out.push(p);
  }
  return out.map(p => ('lit' in p && p.lit.length > MAX_LITERAL ? { any: true, why: 'long text' } : p));
}
