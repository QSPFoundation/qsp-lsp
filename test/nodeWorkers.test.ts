/**
 * Analysis worker threads (src/server/nodeWorkers.ts, analysisWorker.ts):
 * a file analysed in a thread is the file analysed on the main thread, and a
 * project loaded with threads, or with threads that fail, has the
 * diagnostics of one loaded without them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSync } from 'esbuild';
import { AnalysisWorkerPool, workerCount } from '../src/server/nodeWorkers';
import { analyzeFileText } from '../src/server/fileAnalysis';
import { QspHost } from '../src/mcp/qspHost';
import { QspTreeSitterParser, buildLocationIndex, reviveDocumentSymbols } from '../src/parser';
import { initParser, loadWasm, WASM_PATH } from './testHelpers';

// The worker bundle built from the sources, beside the WASM files it loads,
// laid out as the extension's out/ is.
let outDir: string;
let script: string;

beforeAll(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-workers-'));
  fs.mkdirSync(path.join(outDir, 'server'));
  script = path.join(outDir, 'server', 'analysisWorker.js');
  buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'server', 'analysisWorker.ts')],
    bundle: true, outfile: script, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent',
  });
  fs.copyFileSync(WASM_PATH, path.join(outDir, 'tree-sitter-qsp.wasm'));
  fs.copyFileSync(require.resolve('web-tree-sitter/tree-sitter.wasm'), path.join(outDir, 'server', 'tree-sitter.wasm'));
});

afterAll(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

const game = (n: number) => [
  `# комната_${n}`,
  `x = ${n} & $имя = 'Комната ${n}'`,
  `act 'дальше': gt 'комната_${n + 1}'`,
  "*pl '<a href=\"exec:gs ''общая''\">общая</a>'",
  'if x = 1',
  '--- комната_' + n + ' ---',
  '',
].join('\n');

describe('workerCount', () => {
  it('leaves a core to the main thread and stops at four', () => {
    expect([1, 2, 3, 5, 16].map(n => workerCount(n))).toEqual([0, 1, 2, 4, 4]);
  });
});

describe('AnalysisWorkerPool', () => {
  it('gives the analysis the main thread makes, for more files than threads', async () => {
    const parser = new QspTreeSitterParser();
    await initParser(parser);
    const pool = new AnalysisWorkerPool(script, outDir, 2);
    try {
      const texts = [1, 2, 3, 4, 5].map(game);
      const results = await Promise.all(texts.map((t, i) => pool.analyze(`file:///g${i}.qsps`, t, true)));
      texts.forEach((t, i) => {
        const uri = `file:///g${i}.qsps`;
        const here = analyzeFileText(parser, uri, t, buildLocationIndex(t), true);
        const there = results[i].read() as typeof here;
        expect(reviveDocumentSymbols(there.symbols)).toBeDefined();
        expect(there.syntaxErrors).toEqual(here.syntaxErrors);
        expect(there.syntaxErrors.length).toBeGreaterThan(0);
        expect(there.symbols).toEqual(here.symbols);
      });
    } finally {
      pool.dispose();
    }
  }, 60_000);

  it('rejects when its threads can\'t start, and with no threads at all', async () => {
    const broken = new AnalysisWorkerPool(path.join(outDir, 'missing.js'), outDir, 1);
    await expect(broken.analyze('file:///a.qsps', game(1), true)).rejects.toThrow();
    broken.dispose();
    await expect(new AnalysisWorkerPool(script, outDir, 0).analyze('file:///a.qsps', game(1), true)).rejects.toThrow();
  });
});

describe('a project loaded in worker threads', () => {
  async function diagnostics(dir: string, workers?: AnalysisWorkerPool) {
    const host = new QspHost(dir, { wasmLoader: loadWasm }, () => {}, undefined, [], workers);
    await host.start();
    const all = [...host.allDiagnostics()].map(([uri, list]) => [path.basename(uri), list] as const).sort(([a], [b]) => a.localeCompare(b));
    host.dispose();
    return all;
  }

  it('has the diagnostics of one loaded on the main thread, even when the threads fail', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-workers-game-'));
    try {
      for (let n = 1; n <= 6; n++) fs.writeFileSync(path.join(dir, `part${n}.qsps`), game(n));
      const here = await diagnostics(dir);
      expect(here.flatMap(([, l]) => l).length).toBeGreaterThanOrEqual(6);
      expect(await diagnostics(dir, new AnalysisWorkerPool(script, outDir, 3))).toEqual(here);
      expect(await diagnostics(dir, new AnalysisWorkerPool(path.join(outDir, 'missing.js'), outDir, 3))).toEqual(here);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('a large file in a part per thread', () => {
  // Past SPLIT_MIN_CHARS: split between the threads, closed or opened.
  const big = Array.from({ length: 700 }, (_, n) => game(n) + `! ${'x'.repeat(1500)}\n`).join('');

  it('has the diagnostics of the file analysed in one go, closed and opened', async () => {
    expect(big.length).toBeGreaterThan(1_000_000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-workers-big-'));
    try {
      fs.writeFileSync(path.join(dir, 'big.qsps'), big);
      const run = async (workers?: AnalysisWorkerPool) => {
        const host = new QspHost(dir, { wasmLoader: loadWasm }, () => {}, undefined, [], workers);
        await host.start();
        const closed = host.allDiagnostics().get([...host.allDiagnostics().keys()].find(u => u.endsWith('big.qsps'))!);
        const opened = await host.checkText(big);
        host.dispose();
        return { closed, opened };
      };
      const here = await run();
      expect(here.closed!.length).toBeGreaterThanOrEqual(700);
      const there = await run(new AnalysisWorkerPool(script, outDir, 3));
      expect(there.closed).toEqual(here.closed);
      expect(there.opened).toEqual(here.opened);
      expect(there.opened.length).toBeGreaterThanOrEqual(700);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
