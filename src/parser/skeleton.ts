// ── Anonymized game skeletons ────────────────────────────────────────
//
// A whole game with nothing of it left but its structure, so that a game
// that breaks or slows the analysis can be reproduced and benchmarked by
// people who may not see it. Unlike the crash reports' code (anonymize.ts),
// which names whole names `var_0003`, a skeleton renames word by word,
// one pseudonym per word across the game, and keeps the separators and
// digits between words: `room_12` becomes `wabc_12` and the string
// `'room_'` becomes `'wabc_'`, so `gt 'room_' + n` still finds the
// locations it finds in the game. Spellings of a word that differ in case
// get the pseudonym in different cases.
//
// Two passes over every file: the first learns the words of the game's
// names (locations, variables, labels, user functions, and strings that
// name something: `gs 'hall'`, `addobj 'key'`, `killvar '$x'`), the second
// writes the skeleton. A string all of whose words are such words is a name
// too (`gs 'go', 'hall'`, `$to = 'hall'`) and gets their pseudonyms; any
// other text has its letters masked to `x` of the same length. Numbers,
// keywords, operators, quotes, braces, markup and line breaks stay, and code
// in strings (`<<…>>`, `exec:` links) is code: written as the analysis
// reads it. Text between locations keeps only its line breaks.

import type Parser from 'web-tree-sitter';
import { buildLocationIndex } from '../common/locations';
import { SUPPRESSIBLE_CODES, UNSUPPRESSIBLE_CODES } from '../common/diagnosticCodes';
import { KEEP_TYPES } from './anonymize';
import { blockStatements } from './blockTrees';
import { lookupBuiltin } from './builtins';
import { EXEC_LINK_RE, EXEC_PROBE_RE, isIdentifierStringContext, isRegexPatternString } from './embeddedExec';
import { decodeDoubledQuotes, INTP_WRAPPER_PREFIX, wrapInterpolationBody } from './embeddedReparse';

/** Parses a piece of QSP code, one location or more. */
export type SkeletonParseFn = (text: string) => Parser.Tree | null;

// Same shape as server/slices.ts' `Steps`: each `yield` is a point where
// the caller may pause.
type Steps<T> = Generator<void, T, undefined>;

const WORD = /[\p{L}\p{M}]+/gu;
const maskLetters = (s: string) => s.replace(/[\p{L}\p{M}]/gu, 'x');
const keepLines = (s: string) => s.replace(/[^\r\n]/g, '');

// A link's code is parsed as the body of a location of its own.
const EXEC_PREFIX = '# __exec__\n';
const EXEC_SUFFIX = '\n---\n';

const STRING_TYPES = new Set(['single_quoted_string', 'double_quoted_string']);
// `!@qsp-ignore codes: names` (common/suppressions.ts): the codes and names
// decide which diagnostics are shown, so they stay, the names renamed.
const IGNORE_RE = /^(!@qsp-ignore(?:-(?:location|file))?)(?![\w-])([^:\r\n]*)(?::([^\r\n]*))?/i;
const CODES = new Set([...SUPPRESSIBLE_CODES, ...UNSUPPRESSIBLE_CODES].map(c => c.toLowerCase()));

// The analysis looks for runs of stored code in a location's text,
// comments and strings included (storedBlocks.ts' runWordsOf): `dynamic`
// or `dyneval` and the names after it on its line.
const RUN_LINE = /dyn(?:amic|eval)[^\r\n]*/gi;

// Keywords that are no builtin's name.
const KEYWORDS = new Set(['and', 'or', 'no', 'mod', 'obj', 'loc', 'if', 'elseif', 'else', 'end', 'act', 'loop', 'while', 'step', 'local', 'set', 'let']);

// One spelling of a word in a pseudonym: the n-th spelling met gets the
// case of n's bits (`hall` → `wabc`, `Hall` → `Wabc`), so values that
// differ only in case stay different, and names, which QSP compares
// without case, still match.
function withCase(base: string, variant: number): string {
  if (variant === 0) return base;
  let out = '';
  for (let i = 0; i < base.length; i++) out += (variant >> i) & 1 ? base[i].toUpperCase() : base[i];
  return out;
}

// The statement or function `node` is an argument of.
function callNameOf(node: Parser.SyntaxNode): string | undefined {
  let owner = node.parent;
  if (owner?.type === 'paren_args') owner = owner.parent;
  return owner?.childForFieldName('name')?.text.toLowerCase();
}

/** Learns a game's names, then writes each of its files as a skeleton. */
export class GameSkeleton {
  // Lowercase word → its pseudonym ('' until the first pass is over) and
  // its spellings, each with the case variant of the pseudonym it gets.
  private readonly words = new Map<string, { base: string; spellings: Map<string, number> }>();
  private width = 0;
  private next = 0;
  private writing = false;

  constructor(private readonly parse: SkeletonParseFn) {}

  /** The first pass over one file: learns the words of its names. Every file goes through it before {@link writeSteps}. */
  *learnSteps(text: string): Steps<void> {
    if (this.writing) throw new Error('every file is learnt before the first is written');
    for (const part of locationParts(text)) {
      if (!part.code) continue;
      this.location(part.text, false);
      yield;
    }
  }

  /** The second pass: one file's skeleton. */
  *writeSteps(text: string): Steps<string> {
    if (!this.writing) this.seal();
    let out = '';
    for (const part of locationParts(text)) {
      if (!part.code) {
        out += keepLines(part.text);
        continue;
      }
      out += this.location(part.text, true);
      yield;
    }
    return out;
  }

  /** Pseudonym → the word it stands for. It stays with the user; it never goes into a skeleton. */
  names(): Record<string, string> {
    const names: Record<string, string> = {};
    for (const { base, spellings } of this.words.values()) {
      for (const [spelling, variant] of spellings) if (base) names[withCase(base, variant)] = spelling;
    }
    return names;
  }

  // Pseudonyms of one length for the whole game: `w` and letters, which
  // never read as a keyword.
  private seal(): void {
    this.writing = true;
    this.width = 3;
    while (26 ** this.width < this.words.size * 2) this.width++;
    for (const word of this.words.values()) word.base = this.nextBase();
  }

  private nextBase(): string {
    for (;;) {
      let n = this.next++;
      let letters = '';
      for (let i = 0; i < this.width; i++, n = Math.floor(n / 26)) letters = String.fromCharCode(97 + (n % 26)) + letters;
      const p = `w${letters}`;
      if (!lookupBuiltin(p) && !KEYWORDS.has(p)) return p;
    }
  }

  private learn(name: string): void {
    for (const w of name.match(WORD) ?? []) this.word(w);
  }

  private word(w: string): string {
    const lower = w.toLowerCase();
    let word = this.words.get(lower);
    if (!word) {
      // Met only in the second pass (it shouldn't happen): a new pseudonym.
      word = { base: this.writing ? this.nextBase() : '', spellings: new Map() };
      this.words.set(lower, word);
    }
    let variant = word.spellings.get(w);
    if (variant === undefined) word.spellings.set(w, variant = word.spellings.size);
    return withCase(word.base, variant);
  }

  private rename(name: string): string {
    return name.replace(WORD, w => this.word(w));
  }

  // Text: letters masked, but a run line's `dynamic` stays, and the names
  // after it get their pseudonyms.
  private maskText(text: string): string {
    if (!/dyn(?:amic|eval)/i.test(text)) return maskLetters(text);
    let out = '';
    let pos = 0;
    for (const m of text.matchAll(RUN_LINE)) {
      out += maskLetters(text.slice(pos, m.index)) + m[0].slice(0, 7)
        + m[0].slice(7).replace(WORD, w => (this.words.has(w.toLowerCase()) ? this.word(w) : maskLetters(w)));
      pos = m.index + m[0].length;
    }
    return out + maskLetters(text.slice(pos));
  }

  private isName(text: string): boolean {
    let any = false;
    for (const w of text.match(WORD) ?? []) {
      if (!this.words.has(w.toLowerCase())) return false;
      any = true;
    }
    return any;
  }

  // A name: learnt in the first pass, renamed in the second.
  private name(text: string, write: boolean): string {
    if (!write) {
      this.learn(text);
      return '';
    }
    return this.rename(text);
  }

  private location(text: string, write: boolean): string {
    const tree = this.parse(text);
    if (!tree) return write ? maskLetters(text) : '';
    try {
      return this.span(tree.rootNode, text, 0, text.length, write, undefined);
    } finally {
      tree.delete();
    }
  }

  // The code of `text` from `start` to `end`, `root` its tree. `quote` is
  // the quote of the string the code stands in, if any.
  private span(
    root: Parser.SyntaxNode, text: string, start: number, end: number,
    write: boolean, quote: string | undefined,
  ): string {
    let out = '';
    let pos = start;
    // What lies between nodes (spaces, `&`, braces, hidden tokens) has its
    // letters masked.
    const gap = (to: number) => {
      if (write && to > pos) out += this.maskText(text.slice(pos, to));
      pos = Math.max(pos, to);
    };
    const emit = (node: Parser.SyntaxNode, replacement: string) => {
      gap(node.startIndex);
      if (write) out += replacement;
      pos = node.endIndex;
    };

    const visit = (node: Parser.SyntaxNode): void => {
      if (node.startIndex >= end || node.endIndex <= start) return;
      if (node.startIndex < start || node.endIndex > end) {
        // Around the code: a wrapper's statement, or a leaf it cuts.
        if (node.childCount > 0) {
          for (const child of node.children) visit(child);
        } else {
          const from = Math.max(start, node.startIndex);
          gap(from);
          const to = Math.min(end, node.endIndex);
          if (write) out += this.maskText(text.slice(from, to));
          pos = to;
        }
        return;
      }
      const type = node.type;
      if (STRING_TYPES.has(type)) {
        emit(node, this.string(node, text, write));
        return;
      }
      switch (type) {
        case 'comment_statement':
          emit(node, this.comment(node.text, write));
          return;
        case 'inter_loc_text':
          emit(node, keepLines(node.text));
          return;
        case 'label_name':
        case 'location_name':
        case 'user_name':
          emit(node, this.name(node.text, write));
          return;
        case 'identifier_text':
          // A system variable, or a keyword where a name should be
          // (`dynamic'…'`, an error the skeleton keeps).
          emit(node, lookupBuiltin(node.text) ? node.text : this.name(node.text, write));
          return;
        case 'number_literal':
          emit(node, node.text);
          return;
        case 'interpolation_raw_body':
          // Doubled quotes the inline parse can't read: parsed decoded.
          emit(node, quote ? this.reparsed(node.text, quote, wrapInterpolationBody, INTP_WRAPPER_PREFIX.length, write) : this.maskText(node.text));
          return;
      }
      if (type === 'code_block') {
        // A block passed where a name goes is its text (`gs {room}`).
        if (isIdentifierStringContext(node) && !/^dyn(?:amic|eval)$/.test(callNameOf(node) ?? '')) {
          emit(node, this.name(node.text, write));
          return;
        }
        for (const child of blockStatements(node)) visit(child);
        return;
      }
      if (node.childCount > 0) {
        for (const child of node.children) visit(child);
        return;
      }
      emit(node, !node.isNamed || KEEP_TYPES.has(type) || type.endsWith('_keyword') ? node.text : this.maskText(node.text));
    };

    visit(root);
    gap(end);
    return out;
  }

  // A quoted string: its interpolations and `exec:` links are code, the
  // rest a name or masked text.
  private string(node: Parser.SyntaxNode, text: string, write: boolean): string {
    const raw = node.text;
    const q = raw[0];
    const closed = raw.length >= 2 && raw.endsWith(q);
    const innerStart = node.startIndex + 1;
    const innerEnd = node.endIndex - (closed ? 1 : 0);

    interface Hole { start: number; end: number; code: () => string }
    const holes: Hole[] = [];
    if (EXEC_PROBE_RE.test(raw)) {
      for (const m of raw.matchAll(EXEC_LINK_RE)) {
        const [mStart, mEnd] = m.indices![0];
        const [bStart, bEnd] = m.indices![2];
        const linkQuote = m[1];
        const body = raw.slice(bStart, bEnd);
        holes.push({
          start: node.startIndex + mStart,
          end: node.startIndex + mEnd,
          code: () => {
            const code = this.reparsed(body, q, (d) => EXEC_PREFIX + d + EXEC_SUFFIX, EXEC_PREFIX.length, write);
            return `<a href=${linkQuote}exec:${code}${linkQuote}>`;
          },
        });
      }
    }
    const inLink = (n: Parser.SyntaxNode) => holes.some(h => n.startIndex >= h.start && n.endIndex <= h.end);
    for (const child of node.children) {
      if (child.type !== 'string_interpolation' || inLink(child)) continue;
      holes.push({
        start: child.startIndex,
        end: child.endIndex,
        code: () => this.span(child, text, child.startIndex, child.endIndex, write, q),
      });
    }
    holes.sort((a, b) => a.start - b.start);

    const pieces: string[] = [];
    let pos = innerStart;
    for (const h of holes) {
      pieces.push(text.slice(pos, Math.max(pos, h.start)));
      pos = Math.max(pos, h.end);
    }
    pieces.push(text.slice(pos, Math.max(pos, innerEnd)));

    const whole = pieces.join('');
    const regex = isRegexPatternString(node);
    const named = isIdentifierStringContext(node) && !regex;
    if (!write) {
      if (named) this.learn(whole);
      for (const h of holes) h.code();
      return '';
    }
    const asName = named || this.isName(whole);
    const piece = (s: string) => (asName ? this.rename(s)
      // A pattern keeps its escapes (`\d`, `\w`).
      : regex ? s.replace(/(?<!\\)[\p{L}\p{M}]/gu, 'x')
      : this.maskText(s));
    let out = q + piece(pieces[0]);
    holes.forEach((h, i) => { out += h.code() + piece(pieces[i + 1]); });
    return out + (closed ? q : '');
  }

  // Code a string holds with its quote doubled: decoded, parsed alone
  // (wrapped to parse as the analysis parses it), and encoded again.
  private reparsed(
    raw: string, quote: string, wrap: (decoded: string) => string, offset: number, write: boolean,
  ): string {
    const decoded = decodeDoubledQuotes(raw, quote).text;
    const wrapped = wrap(decoded);
    const tree = this.parse(wrapped);
    if (!tree) return write ? maskLetters(raw) : '';
    try {
      const code = this.span(tree.rootNode, wrapped, offset, offset + decoded.length, write, undefined);
      return code.split(quote).join(quote + quote);
    } finally {
      tree.delete();
    }
  }

  private comment(text: string, write: boolean): string {
    const m = IGNORE_RE.exec(text);
    if (!m) return write ? this.maskText(text) : '';
    const names = m[3] !== undefined ? this.name(m[3], write) : '';
    if (!write) return '';
    const codes = m[2].replace(/[\p{L}\p{M}\w-]+/gu, w => (CODES.has(w.toLowerCase()) ? w : maskLetters(w)));
    return m[1] + codes + (m[3] !== undefined ? ':' + names : '') + this.maskText(text.slice(m[0].length));
  }
}

// A file in order: its locations (code) and the text around them.
function* locationParts(text: string): Generator<{ text: string; code: boolean }> {
  let pos = 0;
  for (const loc of buildLocationIndex(text)) {
    if (loc.startOffset > pos) yield { text: text.slice(pos, loc.startOffset), code: false };
    yield { text: text.slice(loc.startOffset, loc.endOffset), code: true };
    pos = loc.endOffset;
  }
  if (pos < text.length) yield { text: text.slice(pos), code: false };
}
