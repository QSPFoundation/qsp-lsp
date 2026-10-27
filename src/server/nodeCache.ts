// ── Analysis cache on disk (Node) ────────────────────────────────────
//
// One file per entry, named by its key: `gzip(v8.serialize(value))`. v8's
// format keeps Maps, Sets and shared references, which the symbol tables are
// full of; gzip makes a 16 MB table about 2.4 MB, for ~30 ms to unpack.
//
// Like gopls' file cache and clangd's index shards: an entry is written to a
// temporary file and renamed into place, so a reader never sees half of one;
// one that can't be read counts as a miss and is deleted; reading an entry
// marks it used, and entries unused for a month, or the oldest beyond the
// size limit, are deleted when the cache is opened.
//
// The entries hold the game's names and text. They stay on this machine and
// never go into crash reports or any zip (see CLAUDE.md).

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as v8 from 'v8';
import * as zlib from 'zlib';
import type { AnalysisCache, AnalysisCacheStore } from './serverUtils';

/** Bumped when the layout of entries changes, so old ones are never misread. */
const FORMAT = 'qsp-analysis-cache-1';
const ENTRY_EXT = '.bin';
const TMP_EXT = '.tmp';

export interface NodeCacheOptions {
  /**
   * Part of every key: a hash of the analyser itself (the server bundle and
   * the grammar), so a rebuilt analyser never reads results of the old one,
   * even while the version number stays the same during development.
   */
  salt?: string;
  /** Entries unused for longer are deleted on open. */
  maxAgeMs?: number;
  /** Past this many bytes in all, the least recently used entries are deleted on open. */
  maxBytes?: number;
  /** Reports failures that are worth a line in the log (never names). */
  warn?: (message: string) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The cache in one directory. */
export class NodeAnalysisCache implements AnalysisCache {
  private readonly maxAgeMs: number;
  private readonly maxBytes: number;
  private readonly warn: (message: string) => void;
  private readonly salt: string;

  constructor(private readonly dir: string, options: NodeCacheOptions = {}) {
    this.maxAgeMs = options.maxAgeMs ?? 30 * DAY_MS;
    this.maxBytes = options.maxBytes ?? 500 * 1024 * 1024;
    this.warn = options.warn ?? (() => {});
    this.salt = options.salt ?? '';
    fs.mkdirSync(dir, { recursive: true });
  }

  key(...parts: string[]): string {
    const hash = createHash('sha256').update(FORMAT).update(`\0${this.salt}`);
    // Lengths first, so ("ab", "c") and ("a", "bc") can't share a key.
    for (const part of parts) hash.update(`\0${part.length}\0`).update(part);
    return hash.digest('hex');
  }

  private file(key: string): string {
    return path.join(this.dir, key + ENTRY_EXT);
  }

  get(key: string): unknown {
    const file = this.file(key);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      return undefined;
    }
    try {
      const value = compactDeserialized(v8.deserialize(zlib.gunzipSync(bytes)));
      // The modification time is the "last used" the clean-up goes by.
      const now = new Date();
      try { fs.utimesSync(file, now, now); } catch { /* another process removed it: fine */ }
      return value;
    } catch {
      this.warn('[QSP] Dropped an unreadable analysis cache entry');
      try { fs.unlinkSync(file); } catch { /* already gone */ }
      return undefined;
    }
  }

  put(key: string, value: unknown): void {
    this.putSerialized(key, v8.serialize(value));
  }

  putSerialized(key: string, bytes: Uint8Array): void {
    // All synchronous: the project load keeps the main thread busy, so
    // background writes would wait for its end and be lost if the editor
    // closed then; ~50 ms per entry at gzip level 1 is the price.
    const tmp = path.join(this.dir, `${key}.${process.pid}.${Math.random().toString(36).slice(2)}${TMP_EXT}`);
    try {
      fs.writeFileSync(tmp, zlib.gzipSync(bytes, { level: 1 }));
      fs.renameSync(tmp, this.file(key));
    } catch (err) {
      // A full disk or a read-only folder costs only the speed-up.
      try { fs.unlinkSync(tmp); } catch { /* never written */ }
      this.warn(`[QSP] Could not store an analysis result: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Delete leftovers of interrupted writes, entries unused for `maxAgeMs`,
   * and the least recently used beyond `maxBytes`. Returns what was deleted.
   */
  collectGarbage(now = Date.now()): { deleted: number; keptBytes: number } {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return { deleted: 0, keptBytes: 0 };
    }
    let deleted = 0;
    const remove = (file: string) => {
      try { fs.unlinkSync(file); deleted++; } catch { /* already gone */ }
    };
    const entries: Array<{ file: string; size: number; used: number }> = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      let stat: fs.Stats;
      try { stat = fs.statSync(file); } catch { continue; }
      if (!stat.isFile()) continue;
      if (name.endsWith(TMP_EXT)) {
        // Another window may be writing it right now; an hour-old one isn't.
        if (now - stat.mtimeMs > 60 * 60 * 1000) remove(file);
      } else if (name.endsWith(ENTRY_EXT)) {
        if (now - stat.mtimeMs > this.maxAgeMs) remove(file);
        else entries.push({ file, size: stat.size, used: stat.mtimeMs });
      }
    }
    entries.sort((a, b) => b.used - a.used);
    let keptBytes = 0;
    for (const e of entries) {
      if (keptBytes + e.size > this.maxBytes) remove(e.file);
      else keptBytes += e.size;
    }
    return { deleted, keptBytes };
  }
}

/**
 * A copy of a value just read back by `v8.deserialize` that takes the memory
 * a fresh one does. Maps and Sets are fixed in place; an object shared in
 * `value` has one copy, shared the same way, and a cycle stays a cycle.
 * - v8 writes every occurrence of a string out in full: a read-back analysis
 *   held a copy of its file's URI for each position and of each name for
 *   each use. Equal strings become one.
 * - v8 writes a holey array (`.map()` makes them) element by element, and
 *   reads it back with room for 16. Arrays are copied to their length.
 * - v8 reads an object back with room for 4 fields inside it, the rest in a
 *   separate array. Plain objects are made again from a literal of their keys.
 * A 12.8 M-character file's analysis takes 212 MB read back this way, 230 MB
 * fresh and 293 MB with strings interned alone; this takes 1.2 s, that 1 s.
 */
export function compactDeserialized<T>(value: T): T {
  const strings = new Map<string, string>();
  const intern = (s: string) => {
    const known = strings.get(s);
    if (known !== undefined) return known;
    strings.set(s, s);
    return s;
  };
  // Each copied object or array is marked with its copy, which is cheaper
  // than a Map of millions of them; Maps and Sets are kept, and fixed in place.
  const copyOf = Symbol('copy');
  const kept = new Set<object>();
  const stack: object[] = [];
  const fix = (v: unknown): unknown => {
    if (typeof v === 'string') return intern(v);
    if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v)) return v;
    const marked = v as { [copyOf]?: object };
    const copyable = Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype;
    const done = copyable ? marked[copyOf] : kept.has(v) ? v : undefined;
    if (done !== undefined) return done;
    const copy = Array.isArray(v) ? v.slice() : copyable ? copyObject(v) : v;
    if (copyable) marked[copyOf] = copy;
    else kept.add(v);
    stack.push(copy);
    return copy;
  };
  const root = fix(value);
  while (stack.length > 0) {
    const o = stack.pop()!;
    if (Array.isArray(o)) {
      for (let i = 0; i < o.length; i++) o[i] = fix(o[i]);
    } else if (o instanceof Map) {
      // Rebuilt, in the same order: a key can only be swapped that way, and
      // whether a string is already the interned one can't be told.
      const entries = [...o];
      o.clear();
      for (const [k, v] of entries) o.set(fix(k), fix(v));
    } else if (o instanceof Set) {
      const items = [...o];
      o.clear();
      for (const v of items) o.add(fix(v));
    } else {
      const record = o as Record<string, unknown>;
      for (const key in record) record[key] = fix(record[key]);
    }
  }
  return root as T;
}

// One maker per list of keys, found by walking a tree of the keys: no
// allocation per object. Generated, because only an object literal that
// names its keys gets them all inside the object.
interface MakerNode { next: Map<string, MakerNode>; make?: (o: object) => object }
const makers: MakerNode = { next: new Map() };
let makerCount = 0;
const MAX_MAKERS = 1000;

function copyObject(o: object): object {
  let node = makers;
  for (const key in o) {
    let next = node.next.get(key);
    if (next === undefined) {
      next = { next: new Map() };
      node.next.set(key, next);
    }
    node = next;
  }
  if (node.make === undefined) {
    const keys = Object.keys(o);
    // `__proto__` in a literal would set the prototype instead.
    if (makerCount >= MAX_MAKERS || keys.includes('__proto__')) return o;
    const fields = keys.map(k => `${JSON.stringify(k)}: o[${JSON.stringify(k)}]`).join(', ');
    node.make = new Function('o', `return { ${fields} };`) as (o: object) => object;
    makerCount++;
  }
  return node.make(o);
}

/** Hash of the files the analysis results depend on; a missing one counts by its name. */
export function analyserSalt(files: readonly string[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    try {
      hash.update(fs.readFileSync(file));
    } catch {
      hash.update(`missing:${path.basename(file)}`);
    }
  }
  return hash.digest('hex');
}

/**
 * Opens caches for the server; a directory that can't be used means no cache.
 * `analyserFiles` (the server bundle, the grammar) salt every key.
 */
export function nodeAnalysisCacheStore(analyserFiles: readonly string[] = []): AnalysisCacheStore {
  return {
    open(dir, warn) {
      const cache = new NodeAnalysisCache(dir, { warn, salt: analyserSalt(analyserFiles) });
      // Off the startup path: listing a large cache folder takes a moment.
      setTimeout(() => cache.collectGarbage(), 30_000).unref?.();
      return cache;
    },
  };
}
