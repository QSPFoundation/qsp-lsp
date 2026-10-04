/**
 * What other files can see of a location, as a hash.
 *
 * Another file's diagnostics read a location only through the project
 * aggregates and the peer symbol tables, which are made from its symbols;
 * the positions in them never reach another file's diagnostics (the lines
 * a message lists are of call sites in the same file). So the hash covers
 * the location's symbols without positions: an edit that only moves things
 * (game text, comments, new lines) keeps it, and the other files keep their
 * diagnostics. Anything else changes it, which is safe: they are checked
 * again.
 */
import type { LocationSymbols } from './locationSymbols';

// Positions, the file's URI (the same in every position), and what isn't
// analysis: the hash itself, a cache, tree-sitter node ids. A binding's
// statement text too: only hover shows it, read from the symbols as they
// are, and what the value means is in `value` (editing a word list kept in
// a variable changed nothing else, yet had every file diagnosed again).
const SKIPPED_KEYS = new Set([
  'line', 'column', 'endLine', 'endColumn', 'callColumn',
  'startRow', 'startCol', 'endRow', 'endCol',
  'uri', 'interfaceHash', 'localsInScopeCache', 'interpolationHostScopes', 'dynamicCodeBlocks',
  'stmtText',
  // What a location passes as arguments matters to its own file only;
  // what it runs of its arguments (`runsArgs`) is what callers see. The
  // same for the blocks it keeps in variables, against what it runs
  // (`runsVariables`).
  'argBlocks', 'storedBlocks',
]);
// Scope keys are made from offsets in the location (scopeKeyOf), so they
// change with any edit before them. Only which ones are equal matters:
// each is replaced by its number in the order they are met.
const SCOPE_KEYS = new Set(['scopeKey', 'isolationKey', 'initialScopeKey']);

const TAG_UNDEFINED = 1;
const TAG_NULL = 2;
const TAG_FALSE = 3;
const TAG_TRUE = 4;
const TAG_INT = 5;
const TAG_NUMBER = 6;
const TAG_STRING = 7;
const TAG_ARRAY = 8;
const TAG_MAP = 9;
const TAG_SET = 10;
const TAG_OBJECT = 11;
const TAG_SEEN = 12;
const TAG_END = 13;

// Key names are hashed once; a number per key keeps the walk from reading
// every key's characters in each of millions of objects.
const keyHashes = new Map<string, number>();

function stringHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** The hash of what other files can see of `loc` (see the module comment). */
export function locationInterfaceHash(loc: LocationSymbols): string {
  // Two independent 32-bit lanes: 64 bits, so equal hashes of different
  // interfaces are out of reach in practice.
  let h1 = 0x9e3779b9;
  let h2 = 0x85ebca6b;
  const feed = (n: number) => {
    h1 = Math.imul(h1 ^ n, 0x01000193);
    h2 = Math.imul(h2 ^ n, 0x5bd1e995);
    h2 ^= h2 >>> 15;
  };
  const strings = new Map<string, number>();
  const feedString = (s: string) => {
    feed(TAG_STRING);
    // Names come up again and again; long texts mostly once.
    if (s.length <= 64) {
      let h = strings.get(s);
      if (h === undefined) {
        h = stringHash(s);
        strings.set(s, h);
      }
      feed(h);
      feed(s.length);
      return;
    }
    feed(s.length);
    for (let i = 0; i < s.length; i++) feed(s.charCodeAt(i));
  };
  const scopes = new Map<number, number>();
  const scopeNumber = (key: unknown): number => {
    if (typeof key !== 'number') return -1;
    let n = scopes.get(key);
    if (n === undefined) {
      n = scopes.size;
      scopes.set(key, n);
    }
    return n;
  };
  // An object met again is fed by the order it was first met in, which
  // keeps sharing (one symbol under two keys) and ends any cycle.
  const seen = new Map<object, number>();

  const walk = (v: unknown): void => {
    switch (typeof v) {
      case 'undefined': feed(TAG_UNDEFINED); return;
      case 'boolean': feed(v ? TAG_TRUE : TAG_FALSE); return;
      case 'string': feedString(v); return;
      case 'number':
        if ((v | 0) === v) { feed(TAG_INT); feed(v); } else { feed(TAG_NUMBER); feedString(String(v)); }
        return;
      case 'object': break;
      default: feedString(String(v)); return;
    }
    if (v === null) { feed(TAG_NULL); return; }
    const first = seen.get(v);
    if (first !== undefined) { feed(TAG_SEEN); feed(first); return; }
    seen.set(v, seen.size);
    if (Array.isArray(v)) {
      feed(TAG_ARRAY);
      feed(v.length);
      for (const item of v) walk(item);
    } else if (v instanceof Map) {
      feed(TAG_MAP);
      feed(v.size);
      for (const [k, item] of v) { walk(k); walk(item); }
    } else if (v instanceof Set) {
      feed(TAG_SET);
      feed(v.size);
      for (const item of v) walk(item);
    } else {
      feed(TAG_OBJECT);
      const record = v as Record<string, unknown>;
      for (const key in record) {
        const item = record[key];
        // An absent key and one set to undefined are the same symbols
        // (a copy made by spreading adds the latter).
        if (item === undefined || SKIPPED_KEYS.has(key)) continue;
        let kh = keyHashes.get(key);
        if (kh === undefined) {
          kh = stringHash(key);
          keyHashes.set(key, kh);
        }
        feed(kh);
        if (SCOPE_KEYS.has(key)) feed(scopeNumber(item));
        else if (key === 'scopePath' && Array.isArray(item)) walkScopePath(item);
        else walk(item);
      }
    }
    feed(TAG_END);
  };
  // Triplets [scope key, flags, key of the branch's parent] (scopeUtils.ts).
  const walkScopePath = (path: readonly unknown[]) => {
    feed(TAG_ARRAY);
    feed(path.length);
    for (let i = 0; i < path.length; i++) feed(i % 3 === 1 ? (path[i] as number) | 0 : scopeNumber(path[i]));
  };

  walk(loc);
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** `loc`'s interface hash, made once and kept on it (copies keep it too). */
export function locationInterface(loc: LocationSymbols): string {
  return loc.interfaceHash ??= locationInterfaceHash(loc);
}
