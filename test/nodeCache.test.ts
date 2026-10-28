/**
 * The analysis cache on disk.
 *
 * Why
 * ───
 * - A project that hasn't changed should open from stored results, so a
 *   stored value must come back whole: Maps, Sets, shared references.
 * - A cache must never make the analysis wrong or fail: a broken or
 *   half-written entry is a miss, and keys differ whenever any input does.
 * - It must not grow without bound: old and least recently used entries go.
 * - A value the format can't hold (cacheFormat.ts) is only not stored.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NodeAnalysisCache, analyserSalt, nodeAnalysisCacheStore } from '../src/server/nodeCache';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-cache-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const entries = () => fs.readdirSync(dir).sort();

describe('NodeAnalysisCache', () => {
  it('gives back what was stored, with Maps, Sets and shared references', async () => {
    const cache = new NodeAnalysisCache(dir);
    const shared = { name: 'Прихожая', line: 3 };
    const value = { byName: new Map([['прихожая', shared]]), refs: [shared, shared], seen: new Set(['счёт']) };
    const key = cache.key('file:///game/main.qsps', '# Прихожая\n---\n');
    cache.put(key, value);
    const back = cache.get(key) as typeof value;
    expect(back).toEqual(value);
    expect(back.refs[0]).toBe(back.refs[1]);
    expect(back.byName.get('прихожая')).toBe(back.refs[0]);
    expect(entries()).toEqual([`${key}.bin`]);
  });

  it('stores nothing, with a warning, for a value it can\'t hold', () => {
    const warnings: string[] = [];
    const cache = new NodeAnalysisCache(dir, { warn: m => warnings.push(m) });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const key = cache.key('cyclic');
    cache.put(key, cyclic);
    expect(cache.get(key)).toBeUndefined();
    expect(entries()).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it('misses on an unknown key, and keys differ whenever an input does', () => {
    const cache = new NodeAnalysisCache(dir);
    expect(cache.get(cache.key('a'))).toBeUndefined();
    const keys = [cache.key('ab', 'c'), cache.key('a', 'bc'), cache.key('abc'), cache.key('ab', 'c', ''), cache.key('ab', 'C')];
    expect(new Set(keys).size).toBe(keys.length);
    expect(cache.key('ab', 'c')).toBe(new NodeAnalysisCache(dir).key('ab', 'c'));
    expect(cache.key('x')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats a broken entry as a miss and deletes it', () => {
    const warnings: string[] = [];
    const cache = new NodeAnalysisCache(dir, { warn: m => warnings.push(m) });
    const key = cache.key('broken');
    fs.writeFileSync(path.join(dir, `${key}.bin`), 'not gzip');
    expect(cache.get(key)).toBeUndefined();
    expect(entries()).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(dir);
  });

  it('marks an entry used when it is read', async () => {
    const cache = new NodeAnalysisCache(dir);
    const key = cache.key('k');
    cache.put(key, 1);
    const file = path.join(dir, `${key}.bin`);
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    fs.utimesSync(file, old, old);
    cache.get(key);
    expect(Date.now() - fs.statSync(file).mtimeMs).toBeLessThan(60_000);
  });

  it('deletes old entries, stale temporary files, and the least recently used beyond the size limit', async () => {
    const cache = new NodeAnalysisCache(dir, { maxAgeMs: 5 * 24 * 3600 * 1000, maxBytes: 2500 });
    const now = Date.now();
    const write = (name: string, bytes: number, ageDays: number) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, Buffer.alloc(bytes));
      const t = new Date(now - ageDays * 24 * 3600 * 1000);
      fs.utimesSync(file, t, t);
    };
    write('old.bin', 10, 6);
    write('newest.bin', 1000, 0);
    write('newer.bin', 1000, 1);
    write('oldest-kept.bin', 1000, 2);
    write('leftover.123.abc.tmp', 10, 1);
    write('fresh.456.def.tmp', 10, 0);
    write('unrelated.txt', 10, 30);
    const result = cache.collectGarbage(now);
    expect(entries()).toEqual(['fresh.456.def.tmp', 'newer.bin', 'newest.bin', 'unrelated.txt']);
    expect(result).toEqual({ deleted: 3, keptBytes: 2000 });
  });

  it('keys depend on the analyser, so a rebuilt one never reads old results', () => {
    const bundle = path.join(dir, 'nodeMain.js');
    fs.writeFileSync(bundle, 'analyser v1');
    const v1 = analyserSalt([bundle]);
    fs.writeFileSync(bundle, 'analyser v2');
    const v2 = analyserSalt([bundle]);
    expect(v1).not.toBe(v2);
    expect(analyserSalt([path.join(dir, 'gone.wasm')])).not.toBe(analyserSalt([]));
    const cacheDir = path.join(dir, 'c');
    expect(new NodeAnalysisCache(cacheDir, { salt: v1 }).key('x')).not.toBe(new NodeAnalysisCache(cacheDir, { salt: v2 }).key('x'));
  });

  it('opens through the store, creating the folder', () => {
    const nested = path.join(dir, 'a', 'analysis-cache');
    const cache = nodeAnalysisCacheStore().open(nested, () => {});
    expect(fs.existsSync(nested)).toBe(true);
    expect(cache.get(cache.key('x'))).toBeUndefined();
  });
});
