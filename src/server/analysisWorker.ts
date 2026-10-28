/**
 * QSP analysis worker thread (out/server/analysisWorker.js), started by
 * nodeWorkers.ts: analyses whole project files with its own tree-sitter
 * while the server's main thread answers requests. A file's analysis goes
 * back in the analysis cache's format (`encodeValue` of `CachedFileAnalysis`);
 * the main thread revives it.
 */
import { parentPort, workerData } from 'worker_threads';
import { QspTreeSitterParser, buildLocationIndex } from '../parser';
import { encodeValue } from './cacheFormat';
import { analyzeFileText } from './fileAnalysis';
import { wasmFromOutDir } from './nodeHost';

/** What the pool asks of a worker. */
export interface AnalysisRequest {
  id: number;
  uri: string;
  text: string;
  embeddedExec: boolean;
  /** Only these locations of the file's location index (see AnalysisWorkers.analyze). */
  locations?: { from: number; to: number };
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
    let locationIndex = buildLocationIndex(request.text);
    if (request.locations) locationIndex = locationIndex.slice(request.locations.from, request.locations.to);
    const analysis = analyzeFileText(parser, request.uri, request.text, locationIndex, request.embeddedExec);
    // In a buffer of its own, which moves to the main thread instead of being copied.
    const bytes = encodeValue(analysis);
    const reply: AnalysisReply = { id: request.id, bytes };
    port.postMessage(reply, [bytes.buffer as ArrayBuffer]);
  }).catch((err: unknown) => {
    const reply: AnalysisReply = { id: request.id, error: err instanceof Error ? err.message : String(err) };
    port.postMessage(reply);
  });
});
