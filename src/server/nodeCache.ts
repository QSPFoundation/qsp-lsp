// ── Analysis cache on disk (Node) ────────────────────────────────────
//
// One file per entry, named by its key: the value in the cache's format
// (cacheFormat.ts), gzipped: a 12.8 M-character file's analysis is 35 MB, and
// 13.5 MB gzipped, for 0.2 s to unpack.
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
import * as zlib from 'zlib';
import { decodeValue, encodeParts, encodeValue } from './cacheFormat';
import type { AnalysisCache, AnalysisCacheStore } from './serverUtils';

/** Bumped when the layout of entries changes, so old ones are never misread. */
const FORMAT = 'qsp-analysis-cache-2';
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

  has(key: string): boolean {
    return fs.existsSync(this.file(key));
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
      const value = decodeValue(zlib.gunzipSync(bytes));
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
    let bytes: Uint8Array;
    try {
      bytes = encodeValue(value);
    } catch (err) {
      this.warn(`[QSP] Could not store an analysis result: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.write(key, bytes);
  }

  putSerialized(key: string, parts: readonly Uint8Array[]): void {
    this.write(key, parts.length === 1 ? parts[0] : encodeParts(parts));
  }

  private write(key: string, bytes: Uint8Array): void {
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
