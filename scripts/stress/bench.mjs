#!/usr/bin/env node
// ── Language server load test ────────────────────────────────────────
//
// Starts the built language server (out/server/nodeMain.js) on a project
// the way VS Code does (stdio, project mode, one file open) and reports
// how long the analysis takes and how much memory it uses. Pair it with
// scripts/stress/genGame.mjs.
//
//   node scripts/stress/bench.mjs <project dir> [--open <file>] [--graph] [--tokens]
//       [--edits N] [--edit-in string|value|call] [--heap-mb N] [--timeout S] [--json <out.json>]
//       [--max-seconds S] [--max-heap-mb N]
//
// --open     file to open like an editor tab (default: the largest one;
//            "none" opens nothing)
// --graph    also ask for the jump graph and report its size
// --tokens   ask for the open file's semantic tokens once its first
//            diagnostics are in, as VS Code does: the visible lines (a range
//            request) and the whole file, reporting when each answer came
// --probe    from the open on, ask for the open file's visible lines'
//            tokens every 100 ms until the end (edits too), and report how long the
//            answers waited (median, 90%, longest): how long the server
//            keeps requests waiting
// --edits N  then type N characters into the open file, reporting how
//            long each takes to be re-diagnosed: its diagnostics cleared,
//            then checked again, and how many other files were re-published
// --edit-in string  type inside a `pl '…'` string (text only) instead of
//            a `!` at the start of a line; value: a digit into a number
//            assigned to a variable (the code changes, its calls don't);
//            call: a whole `gs '<location>'` line after a `local` line, a
//            new call with locals in scope each time (the calls change)
// --heap-mb  the server's heap limit (Node's default otherwise)
// --crash    directory for the always-on crash recorder, as the extension
//            passes it (breadcrumbs, memory, trail, report)
// --cache    directory for the analysis cache, as the extension passes it;
//            run twice with the same one to compare a cold and a warm start
// --max-seconds / --max-heap-mb  exit with code 1 when exceeded (budgets)

import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    out[a.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const project = args._[0] && path.resolve(args._[0]);
if (!project || !fs.existsSync(project)) {
  console.error('usage: bench.mjs <project dir> [--open <file>|none] [--graph] [--tokens] [--probe] [--edits N] [--edit-in string|value|call] [--heap-mb N] [--crash <dir>] [--cache <dir>] [--timeout S] [--json out.json] [--max-seconds S] [--max-heap-mb N]');
  process.exit(2);
}
const server = path.join(root, 'out', 'server', 'nodeMain.js');
if (!fs.existsSync(server)) {
  console.error(`${server} is missing: run npm run build:server:node first`);
  process.exit(2);
}

const qspFiles = fs.readdirSync(project, { recursive: true })
  .map(f => path.join(project, String(f)))
  .filter(f => /\.(qsps|qsrc)$/i.test(f));
let openFile;
if (args.open !== 'none') {
  openFile = args.open ? path.resolve(project, args.open) : qspFiles.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
}

// ── Server process and memory ────────────────────────────────────────

const nodeArgs = args['heap-mb'] ? [`--max-old-space-size=${args['heap-mb']}`] : [];
const child = spawn(process.execPath, [...nodeArgs, server, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
const t0 = Date.now();
const elapsed = () => (Date.now() - t0) / 1000;
let peakRssMb = 0;
// `ps` gives the child's RSS on Linux and macOS; on Windows only the
// server's own report (at the end) has memory figures.
const canPs = process.platform !== 'win32';
const memTimer = setInterval(() => {
  if (!canPs) return;
  try {
    const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)]).toString().trim());
    if (kb > 0) peakRssMb = Math.max(peakRssMb, kb / 1024);
  } catch { /* the process is gone */ }
}, 500);
let stderr = '';
child.stderr.on('data', d => { stderr += d; });

// ── LSP over stdio ───────────────────────────────────────────────────

let nextId = 1;
const pending = new Map();
function send(msg) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }));
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}
function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const perfLines = [];
const listeners = new Set();
// Chunks are kept apart until a whole message is in: concatenating on
// every chunk is quadratic, and a large project's diagnostics can make
// messages of many megabytes.
let inChunks = [];
let inLen = 0;
let bodyLen;   // set once the current message's header has been read
child.stdout.on('data', chunk => {
  inChunks.push(chunk);
  inLen += chunk.length;
  for (;;) {
    if (bodyLen === undefined) {
      if (inChunks.length > 1) inChunks = [Buffer.concat(inChunks)];
      const buf = inChunks[0];
      const h = buf ? buf.indexOf('\r\n\r\n') : -1;
      if (h < 0) return;
      bodyLen = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, h).toString())[1]);
      inChunks[0] = buf.subarray(h + 4);
      inLen -= h + 4;
    }
    if (inLen < bodyLen) return;
    const all = inChunks.length > 1 ? Buffer.concat(inChunks) : inChunks[0];
    const body = all.subarray(0, bodyLen);
    const rest = all.subarray(bodyLen);
    inChunks = rest.length > 0 ? [rest] : [];
    inLen = rest.length;
    bodyLen = undefined;
    onMessage(JSON.parse(body.toString()));
  }
});

// The latest analysis status: "ready" may come before anyone waits for it.
let lastStatus;

function onMessage(msg) {
  if (msg.method === 'qsp/analysisStatus') lastStatus = msg.params;
  if (process.env.BENCH_DEBUG && msg.method) {
    const extra = msg.method === 'qsp/analysisStatus' ? JSON.stringify(msg.params).slice(0, 200)
      : msg.method === 'textDocument/publishDiagnostics' ? `${msg.params.diagnostics.length} diagnostics` : '';
    console.log(`${elapsed().toFixed(1).padStart(6)}s <- ${msg.method} ${extra}`);
  }
  if (msg.id !== undefined && msg.method) {
    // Requests from the server: settings, capability registration.
    let result = null;
    if (msg.method === 'workspace/configuration') {
      result = msg.params.items.map(item => (item.section === 'qsp' ? { debug: { performanceLog: true } } : {}));
    }
    send({ id: msg.id, result });
    return;
  }
  if (msg.id !== undefined) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p?.reject(new Error(msg.error.message)); else p?.resolve(msg.result);
    return;
  }
  if (msg.method === 'window/logMessage' && /\[(perf|jump graph)\]/.test(msg.params.message)) {
    perfLines.push(`${elapsed().toFixed(1).padStart(6)}s ${msg.params.message}`);
    console.log(perfLines.at(-1));
  }
  for (const l of listeners) l(msg);
}

function waitFor(pred, timeoutS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(l); reject(new Error(`timed out after ${timeoutS} s`)); }, timeoutS * 1000);
    const l = msg => {
      const v = pred(msg);
      if (v) { clearTimeout(timer); listeners.delete(l); resolve(v); }
    };
    listeners.add(l);
  });
}

// ── The run ──────────────────────────────────────────────────────────

const timeoutS = Number(args.timeout ?? 900);
const results = { project: path.basename(project), files: qspFiles.length, chars: 0, openFile: openFile && path.basename(openFile) };
// A crash out of memory aborts the process: no exit code, a signal.
child.on('exit', (code, signal) => {
  if (results.done) return;
  console.error(`\nserver exited (${signal ?? `code ${code}`}) after ${elapsed().toFixed(1)} s`);
  const oom = /heap out of memory/i.test(stderr);
  if (oom) console.error('JavaScript heap out of memory');
  results.crashed = { code, signal, seconds: elapsed(), outOfMemory: oom };
  finish(1);
});

const openUri = openFile && pathToFileURL(openFile).href;
const projectUri = pathToFileURL(project).href;

await request('initialize', {
  processId: process.pid,
  rootUri: projectUri,
  workspaceFolders: [{ uri: projectUri, name: path.basename(project) }],
  capabilities: { workspace: { configuration: true, workspaceFolders: true } },
  initializationOptions: {
    crashDir: args.crash ? path.resolve(args.crash) : undefined,
    cacheDir: args.cache ? path.resolve(args.cache) : undefined,
  },
});
send({ method: 'initialized', params: {} });

const firstDiagnostics = openUri
  ? waitFor(m => m.method === 'textDocument/publishDiagnostics' && m.params.uri === openUri && elapsed(), timeoutS)
  : Promise.resolve(undefined);
let openText;
if (openFile) {
  openText = fs.readFileSync(openFile, 'utf8');
  send({ method: 'textDocument/didOpen', params: { textDocument: { uri: openUri, languageId: 'qsp', version: 1, text: openText } } });
}
for (const f of qspFiles) results.chars += fs.statSync(f).size;

// One probe in flight at a time, the next 100 ms after its answer, as an
// editor asks again when the user scrolls.
let probing = Boolean(args.probe && openUri);
const probeWaits = [];
const probeLoop = (async () => {
  while (probing) {
    const asked = Date.now();
    await request('textDocument/semanticTokens/range', {
      textDocument: { uri: openUri }, range: { start: { line: 0, character: 0 }, end: { line: 60, character: 0 } },
    }).catch(() => undefined);
    probeWaits.push(Date.now() - asked);
    if (probeWaits.at(-1) >= 500) console.log(`${elapsed().toFixed(1).padStart(6)}s probe waited ${probeWaits.at(-1)} ms`);
    await new Promise(r => setTimeout(r, 100));
  }
})();

try {
  results.firstDiagnosticsSeconds = await firstDiagnostics;
  let tokensDone = Promise.resolve();
  if (args.tokens && openUri) {
    const asked = elapsed();
    const answered = (kind) => (r) => {
      results.tokens ??= {};
      results.tokens[kind] = { seconds: elapsed() - asked, tokens: (r?.data?.length ?? 0) / 5 };
    };
    const range = { start: { line: 0, character: 0 }, end: { line: 60, character: 0 } };
    tokensDone = Promise.all([
      request('textDocument/semanticTokens/range', { textDocument: { uri: openUri }, range }).then(answered('range')),
      request('textDocument/semanticTokens/full', { textDocument: { uri: openUri } }).then(answered('full')),
    ]);
  }
  const isReady = (st) => st && st.configured && st.busyUris.length === 0 && st.parser !== 'starting'
    && (!st.project || st.project.state === 'ready');
  results.readySeconds = isReady(lastStatus) ? elapsed()
    : await waitFor(m => m.method === 'qsp/analysisStatus' && isReady(m.params) && elapsed(), timeoutS);
  console.log(`\nready after ${results.readySeconds.toFixed(1)} s`);
  await tokensDone;

  if (args.graph) {
    const started = Date.now();
    const graph = await request('qsp/jumpGraph', { uri: projectUri });
    results.graph = {
      seconds: (Date.now() - started) / 1000,
      nodes: graph.nodes.length, edges: graph.edges.length, unresolved: graph.unresolved.length,
      possible: graph.edges.filter(e => e.kind === 'possible').length,
      megabytes: JSON.stringify(graph).length / 1e6,
    };
  }

  const edits = Number(args.edits ?? 0);
  if (edits > 0 && openText) {
    // Type into the middle of the file, one character at a time, waiting
    // for the diagnostics of each edit like a user pausing between keys.
    // --edit-in string types inside the first string literal from there
    // on (game text: no symbol changes), otherwise a `!` at a line's start.
    const lines = openText.split('\n');
    let line = Math.floor(lines.length / 2);
    let character = 0;
    let text = '!';
    if (args['edit-in'] === 'string') {
      while (line < lines.length - 1 && !/^\s*\*?pl\s+'/i.test(lines[line])) line++;
      character = lines[line].indexOf("'") + 1;
      text = 'x';
    } else if (args['edit-in'] === 'value') {
      while (line < lines.length - 1 && !/=\s*\d/.test(lines[line])) line++;
      character = lines[line].search(/=\s*\d/) + 1;
      text = '1';
    } else if (args['edit-in'] === 'call') {
      while (line < lines.length - 1 && !/^\s*local\s/i.test(lines[line])) line++;
      line++;
      // A location from the start of the file, far from this one.
      const target = /^#\s*(.+?)\s*$/m.exec(openText)?.[1] ?? 'start';
      text = `gs '${target.replace(/'/g, "''")}'\n`;
    }
    const latencies = [];
    const settled = [];
    const republished = [];
    for (let i = 0; i < edits; i++) {
      const started = Date.now();
      const done = waitFor(m => m.method === 'textDocument/publishDiagnostics' && m.params.uri === openUri, 120);
      // The open file's first publish after the edit is the full one;
      // the other files' come in the same run.
      const others = new Set();
      let openPublishes = 0;
      const full = waitFor(m => {
        if (m.method !== 'textDocument/publishDiagnostics') return false;
        if (m.params.uri !== openUri) { others.add(m.params.uri); return false; }
        return ++openPublishes === 1;
      }, 300);
      send({
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri: openUri, version: 2 + i },
          contentChanges: [{ range: { start: { line, character }, end: { line, character } }, text }],
        },
      });
      await done;
      latencies.push(Date.now() - started);
      await full;
      settled.push(Date.now() - started);
      await new Promise(r => setTimeout(r, 500));
      republished.push(others.size);
    }
    settled.sort((a, b) => a - b);
    results.editsSettled = { medianMs: settled[Math.floor(settled.length / 2)], maxMs: settled.at(-1), republishedFiles: republished };
    latencies.sort((a, b) => a - b);
    results.edits = { count: edits, medianMs: latencies[Math.floor(latencies.length / 2)], maxMs: latencies.at(-1) };
  }

  probing = false;
  await probeLoop;
  if (probeWaits.length > 0) {
    const sorted = [...probeWaits].sort((a, b) => a - b);
    results.probe = { count: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)], p90Ms: sorted[Math.floor(sorted.length * 0.9)], maxMs: sorted.at(-1) };
  }
  results.report = await request('qsp/performanceReport');
  finish(0);
} catch (e) {
  console.error(`\n${e.message}`);
  results.error = e.message;
  finish(1);
}

function finish(code) {
  if (results.done) return;
  results.done = true;
  clearInterval(memTimer);
  results.peakRssMb = canPs ? Math.round(peakRssMb) : undefined;
  const mem = results.report?.memory;
  const heapMb = mem ? Math.round(mem.heapUsed / 1048576) : undefined;
  results.perf = perfLines;

  console.log('\n── Summary ─────────────────────────────');
  console.log(`project        ${results.files} files, ${(results.chars / 1e6).toFixed(1)} MB`);
  if (results.firstDiagnosticsSeconds) console.log(`first diags    ${results.firstDiagnosticsSeconds.toFixed(1)} s (${results.openFile})`);
  if (results.readySeconds) console.log(`ready          ${results.readySeconds.toFixed(1)} s`);
  if (heapMb !== undefined) console.log(`heap at end    ${heapMb} MB of ${Math.round(mem.heapLimit / 1048576)} MB`);
  if (results.peakRssMb) console.log(`peak rss       ${results.peakRssMb} MB`);
  if (results.graph) console.log(`jump graph     ${results.graph.nodes} nodes, ${results.graph.edges} edges (${results.graph.possible} possible), ${results.graph.unresolved} unresolved, ${results.graph.megabytes.toFixed(1)} MB in ${results.graph.seconds.toFixed(1)} s`);
  for (const [kind, t] of Object.entries(results.tokens ?? {})) {
    console.log(`tokens ${kind.padEnd(7)} ${t.seconds.toFixed(1)} s after asking, ${t.tokens} tokens`);
  }
  if (results.probe) console.log(`probe waits    median ${results.probe.medianMs} ms, 90% ${results.probe.p90Ms} ms, max ${results.probe.maxMs} ms (${results.probe.count})`);
  if (results.edits) console.log(`edits          median ${results.edits.medianMs} ms, max ${results.edits.maxMs} ms (${results.edits.count})`);
  if (results.editsSettled) {
    const { medianMs, maxMs, republishedFiles } = results.editsSettled;
    console.log(`edits checked  median ${medianMs} ms, max ${maxMs} ms, other files re-published: ${republishedFiles.join(', ')}`);
  }
  if (results.crashed) console.log(`CRASHED        after ${results.crashed.seconds.toFixed(1)} s${results.crashed.outOfMemory ? ' (heap out of memory)' : ''}`);

  const over = [];
  if (args['max-seconds'] && !(results.readySeconds <= Number(args['max-seconds']))) over.push(`ready > ${args['max-seconds']} s`);
  if (args['max-heap-mb'] && !(heapMb <= Number(args['max-heap-mb']))) over.push(`heap > ${args['max-heap-mb']} MB`);
  if (over.length > 0) console.log(`OVER BUDGET    ${over.join(', ')}`);

  if (args.json) fs.writeFileSync(args.json, JSON.stringify(results, null, 2));

  const exitCode = code || (over.length > 0 ? 1 : 0);
  if (child.exitCode === null && child.signalCode === null) {
    request('shutdown').catch(() => {}).finally(() => send({ method: 'exit' }));
    setTimeout(() => { child.kill(); process.exit(exitCode); }, 3000).unref();
    child.on('exit', () => process.exit(exitCode));
  } else {
    process.exit(exitCode);
  }
}
