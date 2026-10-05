/**
 * Crash report packing (src/client/crashPackage.ts, src/client/zip.ts).
 *
 * Why
 * ───
 * - The names file maps pseudonyms to the game's real names: it must
 *   never end up in the zip the user sends.
 * - Several VS Code windows share the recorder directory; only one may
 *   report a crashed run, and a cleanly stopped run is no crash.
 * - The zip has to open in any unzip tool, so its CRCs and layout must
 *   be right.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { claimRun, isAlive, listRuns, packRun, pruneReports, removeRun } from '../src/client/crashPackage';
import { crc32, unzip as readZip, zip } from '../src/client/zip';

// Enough of a zip reader to check the writer: central directory → entries.
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = zlib.inflateRawSync(buf.subarray(dataStart, dataStart + size));
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-crashpkg-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const put = (name: string, data: string) => fs.writeFileSync(path.join(dir, name), data);

describe('zip', () => {
  it('writes an archive any reader can open, Cyrillic names included', () => {
    const big = Buffer.from('heap,'.repeat(10_000));
    const archive = zip([{ name: 'crash.json', data: Buffer.from('{"a":1}') }, { name: 'память.csv', data: big }]);
    const files = unzip(archive);
    expect([...files.keys()]).toEqual(['crash.json', 'память.csv']);
    expect(files.get('память.csv')!.equals(big)).toBe(true);
    expect(archive.length).toBeLessThan(big.length / 10);
  });

  // A report whose offer to add the code was passed by gets it later
  // (QSP: Add Anonymized Code to Crash Report): the archive is read back.
  it('reads back what it wrote, and stored files other tools write', () => {
    const entries = [{ name: 'crash.json', data: Buffer.from('{"summary":{}}') }, { name: 'память.csv', data: Buffer.from('heap,'.repeat(1000)) }];
    expect(readZip(zip(entries))).toEqual(entries);
    // Make the first entry stored: method 0, its data as it is.
    const plain = zip([{ name: 'a.txt', data: Buffer.from('x') }]);
    const asStored = Buffer.from(plain);
    asStored.writeUInt16LE(0, 8);
    const centralAt = asStored.readUInt32LE(asStored.length - 22 + 16);
    asStored.writeUInt16LE(0, centralAt + 10);
    const dataAt = 30 + 'a.txt'.length;
    const deflatedSize = asStored.readUInt32LE(18);
    const rebuilt = Buffer.concat([asStored.subarray(0, dataAt), Buffer.from('x'), asStored.subarray(dataAt + deflatedSize)]);
    rebuilt.writeUInt32LE(1, 18);
    const newCentral = centralAt - deflatedSize + 1;
    rebuilt.writeUInt32LE(1, newCentral + 20);
    rebuilt.writeUInt32LE(newCentral, rebuilt.length - 22 + 16);
    expect(readZip(rebuilt)).toEqual([{ name: 'a.txt', data: Buffer.from('x') }]);
    expect(() => readZip(Buffer.from('not a zip at all, just some text'))).toThrow(/not a zip/);
  });
});

describe('crash runs', () => {
  it('tells crashed runs from clean ones and packs a crash without the names file', () => {
    put('session-111.json', JSON.stringify({ mode: 'crash', startedAt: '2026-09-26T19:00:00Z', heapLimitMB: 4096 }));
    put('names-111.json', JSON.stringify({ workspaceFolders: ['file:///home/someone/Секретная_игра'], pseudonyms: { f01: 'file:///x/main.qsps', f01_l0007: 'Тайная_комната' } }));
    put('breadcrumbs-111.jsonl', [
      JSON.stringify({ t: 30, kind: 'heap-threshold', heapMB: 2100, percent: 50 }),
      JSON.stringify({ t: 80, kind: 'heap-growth', heapMB: 3500, step: 'symbols', file: 'f01', location: { id: 'f01_l0007', chars: 243000, lines: 4630 } }),
    ].join('\n') + '\n');
    put('memory-111.csv', 'seconds,heapUsedMB,heapLimitMB,rssMB\n85,3905,4096,4216\n');
    put('heap-near-limit-111.heapprofile', '{}');
    put('session-222.json', '{}');
    put('clean-222.json', '{}');
    // Killed with its editor: no clean mark, nothing unusual either.
    put('session-333.json', '{}');
    put('memory-333.csv', 'seconds,heapUsedMB,heapLimitMB,rssMB\n9000,183,4096,577\n');
    // Grew fast while a large game loaded, then ran calmly until it was killed.
    put('session-444.json', '{}');
    put('breadcrumbs-444.jsonl', JSON.stringify({ t: 90.7, kind: 'heap-growth', heapMB: 429, growthMB: 287 }) + '\n');
    put('memory-444.csv', 'seconds,heapUsedMB,heapLimitMB,rssMB\n1069.7,166,4192,472\n');
    // Killed while stuck: the stall breadcrumbs go on to its end.
    put('session-555.json', '{}');
    put('breadcrumbs-555.jsonl', JSON.stringify({ t: 400, kind: 'stall', heapMB: 300 }) + '\n');
    put('memory-555.csv', 'seconds,heapUsedMB,heapLimitMB,rssMB\n420,300,4096,600\n');

    const runs = listRuns(dir);
    expect(runs.find(r => r.pid === 222)!.clean).toBe(true);
    const crashed = runs.find(r => r.pid === 111)!;
    expect(runs.find(r => r.pid === 333)).toMatchObject({ clean: false, anomalies: false });
    expect(runs.find(r => r.pid === 444)).toMatchObject({ clean: false, anomalies: false });
    expect(runs.find(r => r.pid === 555)).toMatchObject({ clean: false, anomalies: true });
    expect(crashed).toMatchObject({ clean: false, anomalies: true, names: { workspaceFolders: ['file:///home/someone/Секретная_игра'] } });

    expect(claimRun(dir, 111)).toBe(true);
    expect(claimRun(dir, 111)).toBe(false);

    const { entries, summary } = packRun(dir, 111, { platform: 'test' });
    const names = entries.map(e => e.name).sort();
    expect(names).toEqual(['breadcrumbs.jsonl', 'crash.json', 'heap-near-limit.heapprofile', 'memory.csv', 'session.json']);
    expect(summary).toMatchObject({ file: 'f01', location: 'f01_l0007', chars: 243000, lines: 4630, step: 'symbols', heapMB: 3905, limitMB: 4096 });
    const all = Buffer.concat(entries.map(e => e.data)).toString('utf8');
    for (const secret of ['Тайная', 'Секретная', 'someone', 'main.qsps']) expect(all).not.toContain(secret);

    removeRun(dir, 111);
    expect(fs.readdirSync(dir).filter(f => f.includes('-111.'))).toEqual([]);
  });

  it('knows this process is alive and a made-up one is not', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(2 ** 22 + 12345)).toBe(false);
  });

  it('keeps only the newest reports', () => {
    for (const stamp of ['1', '2', '3', '4']) {
      put(`crash-${stamp}.zip`, 'z');
      put(`crash-${stamp}.names.json`, '{}');
    }
    pruneReports(dir, 2);
    expect(fs.readdirSync(dir).sort()).toEqual(['crash-3.names.json', 'crash-3.zip', 'crash-4.names.json', 'crash-4.zip']);
  });
});
