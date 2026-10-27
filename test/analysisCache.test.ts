/**
 * The analysis cache end to end: a real language server on a project on
 * disk, analysed without a cache, then with an empty one, then from it.
 *
 * Why
 * ───
 * - A cache may only make opening faster: what the editor shows must be the
 *   same with results read back from disk as with a fresh analysis, across
 *   files (cross-file references, duplicates), with Cyrillic names, exec:
 *   links, syntax errors of closed files, !@qsp-ignore comments, and the
 *   variable checks that need the scopes symbols keep for them.
 * - A file that changed is analysed again; the others still come from the cache.
 * - An unchanged project shows the diagnostics it had last time before the
 *   seconds-long aggregates; any change to its files means none are shown.
 * - The propagation of locals, the seconds of those aggregates, is read
 *   back when no location changed what it reads.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { QspHost } from '../src/mcp/qspHost';
import type { Connection, TextDocuments } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { ProjectModeService } from '../src/server/projectMode';
import { NodeAnalysisCache } from '../src/server/nodeCache';
import { collectCallTypesPerTarget } from '../src/server/aggregation';
import { PerfLog } from '../src/server/perfLog';
import type { DocumentState } from '../src/server/featureTypes';
import { initParser, loadWasm } from './testHelpers';

const FILES: Record<string, string> = {
  'main.qsps': [
    '# Прихожая',
    "gs 'Кухня', 1",
    "gt 'нет_такой'",
    '*pl счёт',
    "*pl '<a href=\"exec:gt ''Кухня''\">на кухню</a>'",
    '--- Прихожая ---',
    '',
  ].join('\n'),
  'rooms/kitchen.qsps': [
    '# Кухня',
    'local счёт = args[0]',
    "$имя = 'Алиса'",
    '!@qsp-ignore unusedVariables',
    'никто = 1',
    '--- Кухня ---',
    '',
    '# прихожая',
    '--- прихожая ---',
    '',
    // A read whose value comes through `б = а` from a never assigned
    // `а`: found only with the scopes symbols keep for the checks.
    '# начало',
    'б = а',
    '--- начало ---',
    '',
    '# конец',
    '*pl б',
    '--- конец ---',
    '',
  ].join('\n'),
  'broken.qsps': '# Сломано\nif x = 1\n  *pl 1\n--- Сломано ---\n',
};

async function analyse(dir: string, cacheDir?: string, analyserFiles: readonly string[] = []) {
  const log: string[] = [];
  const host = new QspHost(dir, { wasmLoader: loadWasm }, m => log.push(m), cacheDir, analyserFiles);
  await host.start();
  const diagnostics = [...host.allDiagnostics()]
    .map(([uri, list]) => [path.relative(dir, new URL(uri).pathname), list] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  host.dispose();
  return { diagnostics, cacheLine: log.find(l => l.includes('Analysis cache:')) };
}

describe('analysis cache', () => {
  it('gives the same diagnostics as a fresh analysis, and re-analyses only changed files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-cache-e2e-'));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-cache-dir-'));
    try {
      for (const [rel, text] of Object.entries(FILES)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text);
      }
      const fresh = await analyse(dir);
      expect(fresh.diagnostics.flatMap(([, l]) => l).length).toBeGreaterThan(3);
      const kitchen = fresh.diagnostics.find(([file]) => file === 'rooms/kitchen.qsps')![1];
      const readLine = FILES['rooms/kitchen.qsps'].split('\n').indexOf('*pl б');
      expect(kitchen.some(d => d.code === 'uninitializedVariables' && d.range.start.line === readLine)).toBe(true);
      expect(fresh.cacheLine).toBeUndefined();

      const cold = await analyse(dir, cacheDir);
      expect(cold.cacheLine).toMatch(/0 of 3 project files read from it, 3 analysed$/);
      // Three files and the project's diagnostics.
      expect(fs.readdirSync(cacheDir).filter(f => f.endsWith('.bin'))).toHaveLength(4);

      const warm = await analyse(dir, cacheDir);
      expect(warm.cacheLine).toMatch(/3 of 3 project files read from it, 0 analysed; stored diagnostics shown first$/);
      expect(cold.diagnostics).toEqual(fresh.diagnostics);
      expect(warm.diagnostics).toEqual(fresh.diagnostics);

      fs.appendFileSync(path.join(dir, 'broken.qsps'), "# Новая\ngt 'Прихожая'\n--- Новая ---\n");
      const changed = await analyse(dir, cacheDir);
      expect(changed.cacheLine).toMatch(/2 of 3 project files read from it, 1 analysed$/);
      expect(changed.diagnostics).toEqual((await analyse(dir)).diagnostics);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  }, 60_000);
});

// The propagation of locals across the project is stored too (a large game
// spends seconds on it); read back, it must give the aggregates a fresh one
// gives, and a change to what it reads must miss it.
describe('analysis cache of the MCP server', () => {
  it('is salted by the analyser, and off when the workspace turns qsp.cache.enabled off', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-cache-mcp-'));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-cache-dir-'));
    const analyser = path.join(cacheDir, '..', `${path.basename(cacheDir)}-bundle.js`);
    try {
      fs.writeFileSync(path.join(dir, 'game.qsps'), FILES['broken.qsps']);
      fs.writeFileSync(analyser, 'v1');
      expect((await analyse(dir, cacheDir, [analyser])).cacheLine).toMatch(/0 of 1 project files read from it/);
      expect((await analyse(dir, cacheDir, [analyser])).cacheLine).toMatch(/1 of 1 project files read from it/);
      // A rebuilt analyser reads none of the old one's results.
      fs.writeFileSync(analyser, 'v2');
      expect((await analyse(dir, cacheDir, [analyser])).cacheLine).toMatch(/0 of 1 project files read from it/);

      fs.mkdirSync(path.join(dir, '.vscode'));
      fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'), '{ "qsp.cache.enabled": false }');
      expect((await analyse(dir, cacheDir, [analyser])).cacheLine).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.rmSync(analyser, { force: true });
    }
  });
});

describe('analysis cache: the propagation of locals', () => {
  const PROJECT: Record<string, string> = {
    'file:///game/main.qsps': "# старт\nlocal шаг = 1\nlocal $путь = 'лес'\ngs 'помощь', шаг\nx = @считать(шаг)\n---\n# второй\nlocal шаг = 2\ngs 'помощь'\n---\n",
    'file:///game/forest.qsps': "# помощь\npl шаг, $путь\nшаг = args[0]\ngs 'считать'\n---\n# считать\nresult = шаг + 1\n---\n",
  };

  async function aggregatesOf(files: Record<string, string>, cacheDir?: string) {
    const parser = new QspTreeSitterParser();
    await initParser(parser);
    const states = new Map<string, DocumentState>();
    const connection = { console: { log() {}, error() {}, warn() {}, info() {} }, sendDiagnostics() {} } as unknown as Connection;
    const documents = { get: () => undefined, all: () => [] } as unknown as TextDocuments<TextDocument>;
    const service = new ProjectModeService(connection, documents, states, parser);
    if (cacheDir) service.analysisCache = new NodeAnalysisCache(cacheDir);
    service.propagationCacheMinMs = 0;
    const steps: string[] = [];
    service.perf = new PerfLog(line => steps.push(line));
    service.perf.verbose = true;
    for (const [uri, text] of Object.entries(files)) {
      service.projectFileUris.add(uri);
      service.analyzeFile(uri, text);
    }
    service.perf.phase('aggregates', () => service.rebuildAggregates(() => collectCallTypesPerTarget([...states.values()].map(s => s.symbols))));
    const line = steps.find(l => l.includes('aggregates'))!;
    return { agg: service.projectAggregates, propagated: /[·,] propagation \d/.test(line), read: /propagation cache read/.test(line) };
  }

  it('reads it back instead of propagating, the same as a fresh one', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-cache-prop-'));
    try {
      const fresh = await aggregatesOf(PROJECT);
      expect(fresh.agg!.propagatedLocals.size).toBeGreaterThan(0);
      expect((await aggregatesOf(PROJECT, cacheDir)).propagated).toBe(true);
      const back = await aggregatesOf(PROJECT, cacheDir);
      expect(back.propagated).toBe(false);
      expect(back.agg).toEqual(fresh.agg);

      // A location that now passes `шаг` from another scope: a different key.
      const changed = { ...PROJECT, 'file:///game/main.qsps': PROJECT['file:///game/main.qsps'].replace("local шаг = 1\n", "if 1: local шаг = 1\n") };
      const after = await aggregatesOf(changed, cacheDir);
      expect(after.propagated).toBe(true);
      expect(after.agg).toEqual((await aggregatesOf(changed)).agg);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
