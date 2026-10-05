#!/usr/bin/env node
// ── Anonymized game skeleton ─────────────────────────────────────────
//
// What **QSP: Export Anonymized Skeleton** makes, from the command line:
// the built language server (out/server/nodeMain.js) is asked for the
// skeleton of every .qsps/.qsrc file of a project (src/parser/skeleton.ts),
// and the files are written as f01.qsps, f02.qsps… (libraries as
// libs/lib01.qsps…), in the alphabetical order of their paths. Pair it with
// bench.mjs: a skeleton gives the same locations, jumps and diagnostics as
// the game it was made from.
//
//   node scripts/stress/skeleton.mjs <project dir> --out <dir> [--names <file>]
//
// --out    the skeleton's folder (created; must be outside the project)
// --names  where to write what each pseudonym stands for (default:
//          <out>.names.json beside the folder). Keep it; don't send it.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const argv = process.argv.slice(2);
const args = { _: [] };
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
  else args._.push(argv[i]);
}
const project = args._[0] && path.resolve(args._[0]);
if (!project || !fs.existsSync(project) || !args.out) {
  console.error('usage: skeleton.mjs <project dir> --out <dir> [--names <file>]');
  process.exit(2);
}
const outDir = path.resolve(args.out);
const namesFile = path.resolve(args.names ?? `${outDir}.names.json`);
const inside = (p) => {
  const rel = path.relative(project, p);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};
if (inside(outDir) || inside(namesFile)) {
  console.error('--out and --names must be outside the project: the analysis would read them as part of the game');
  process.exit(2);
}
const server = path.join(root, 'out', 'server', 'nodeMain.js');
if (!fs.existsSync(server)) {
  console.error(`${server} is missing: run npm run build:server:node first`);
  process.exit(2);
}

const rels = fs.readdirSync(project, { recursive: true })
  .map(f => String(f).replace(/\\/g, '/'))
  .filter(f => /\.(qsps|qsrc)$/i.test(f))
  .sort();
const width = Math.max(2, String(rels.length).length);
const pad = (n) => String(n).padStart(width, '0');
let game = 0;
let lib = 0;
const targets = rels.map(rel => (/^libs\/[^/]+\.qsps$/i.test(rel)
  ? `libs/lib${pad(++lib)}.qsps`
  : `f${pad(++game)}${path.extname(rel)}`));

// ── LSP over stdio ───────────────────────────────────────────────────

const child = spawn(process.execPath, [server, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
let nextId = 1;
const pending = new Map();
const send = (msg) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }));
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
};
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});
// A large game's answer is many megabytes: its chunks are joined once.
let chunks = [];
let have = 0;
let bodyLen;
child.stdout.on('data', chunk => {
  chunks.push(chunk);
  have += chunk.length;
  for (;;) {
    if (bodyLen === undefined) {
      const buf = Buffer.concat(chunks);
      const h = buf.indexOf('\r\n\r\n');
      if (h < 0) { chunks = [buf]; return; }
      bodyLen = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, h).toString())[1]);
      chunks = [buf.subarray(h + 4)];
      have = buf.length - h - 4;
    }
    if (have < bodyLen) return;
    const buf = Buffer.concat(chunks);
    const msg = JSON.parse(buf.subarray(0, bodyLen).toString());
    chunks = [buf.subarray(bodyLen)];
    have = buf.length - bodyLen;
    bodyLen = undefined;
    if (msg.id !== undefined && msg.method) {
      send({ id: msg.id, result: null });
    } else if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message)); else p?.resolve(msg.result);
    }
  }
});
child.on('exit', (code, signal) => {
  for (const p of pending.values()) p.reject(new Error(`the server exited (${signal ?? `code ${code}`})`));
});

// No workspace folder: the server analyses nothing but answers the request.
await request('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
send({ method: 'initialized', params: {} });
const started = Date.now();
const result = await request('qsp/anonymizedSkeleton', {
  files: rels.map(rel => ({ uri: pathToFileURL(path.join(project, rel)).href })),
});
send({ id: nextId++, method: 'shutdown' });
send({ method: 'exit' });
if (!result) {
  console.error('the server made no skeleton (no parser, or a file it could not read)');
  process.exit(1);
}

for (const [i, file] of result.files.entries()) {
  const target = path.join(outDir, targets[i]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '﻿' + file.text);
}
const files = Object.fromEntries(targets.map((t, i) => [t, rels[i]]));
fs.writeFileSync(namesFile, JSON.stringify({ files, words: result.names }, null, 1));
console.log(`${rels.length} file(s) in ${outDir} (${((Date.now() - started) / 1000).toFixed(1)} s), pseudonyms in ${namesFile}`);
