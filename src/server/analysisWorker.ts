/**
 * QSP analysis worker thread (out/server/analysisWorker.js), started by
 * nodeWorkers.ts: analyses whole project files with its own tree-sitter
 * while the server's main thread answers requests. A file's analysis goes
 * back serialized as the analysis cache stores it (`v8.serialize` of
 * `CachedFileAnalysis`); the main thread revives it.
 */
import { parentPort, workerData } from 'worker_threads';
import * as v8 from 'v8';
import { QspTreeSitterParser, buildLocationIndex } from '../parser';
import { analyzeFileText } from './fileAnalysis';
import { wasmFromOutDir } from './nodeHost';

/** What the pool asks of a worker. */
export interface AnalysisRequest {
  id: number;
  uri: string;
  text: string;
  embeddedExec: boolean;
}

/** What a worker answers: the analysis serialized, or why there is none. */
export type AnalysisReply = { id: number; bytes: Uint8Array } | { id: number; error: string };

const port = parentPort!;
const { outDir } = workerData as { outDir: string };
const parser = new QspTreeSitterParser();
const { wasmLoader, wasmDir } = wasmFromOutDir(outDir);
const ready = parser.init(wasmLoader, wasmDir);

port.on('message', (request: AnalysisRequest) => {
  void ready.then(() => {
    const analysis = analyzeFileText(parser, request.uri, request.text, buildLocationIndex(request.text), request.embeddedExec);
    const serialized = v8.serialize(analysis);
    // Its own buffer, so it moves to the main thread instead of being copied.
    const bytes = serialized.byteOffset === 0 && serialized.byteLength === serialized.buffer.byteLength
      ? serialized : new Uint8Array(serialized);
    const reply: AnalysisReply = { id: request.id, bytes };
    port.postMessage(reply, [bytes.buffer as ArrayBuffer]);
  }).catch((err: unknown) => {
    const reply: AnalysisReply = { id: request.id, error: err instanceof Error ? err.message : String(err) };
    port.postMessage(reply);
  });
});
