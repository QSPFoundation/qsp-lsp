// ── Analysis worker threads (Node) ───────────────────────────────────
//
// Like clangd's background index: the project load analyses files in a few
// threads at once (analysisWorker.ts), each with its own tree-sitter, and
// the main thread only revives the results, so it keeps answering requests.
// Threads start on the first file and stop when the load is done: each holds
// its own copy of the grammar and its analysis heap.

import * as os from 'os';
import * as v8 from 'v8';
import { Worker } from 'worker_threads';
import { compactDeserialized } from './nodeCache';
import type { AnalysisWorkers } from './serverUtils';
import type { AnalysisReply, AnalysisRequest } from './analysisWorker';

/**
 * Threads for a machine with `cpus` cores: one core stays with the main
 * thread, and more than four bring little (memory grows with each, and the
 * main thread revives every result).
 */
export function workerCount(cpus = os.availableParallelism?.() ?? os.cpus().length): number {
  return Math.max(0, Math.min(4, cpus - 1));
}

interface Job {
  request: AnalysisRequest;
  resolve: (result: { bytes: Uint8Array; read: () => unknown }) => void;
  reject: (err: Error) => void;
}

interface Thread {
  worker: Worker;
  job: Job | undefined;
}

/** A pool of `size` analysis threads running `script` (out/server/analysisWorker.js). */
export class AnalysisWorkerPool implements AnalysisWorkers {
  private readonly threads: Thread[] = [];
  private readonly queue: Job[] = [];
  private nextId = 0;

  constructor(
    private readonly script: string,
    /** The extension's out/ directory, where the WASM files are. */
    private readonly outDir: string,
    private readonly size = workerCount(),
  ) {}

  analyze(uri: string, text: string, embeddedExec: boolean): Promise<{ bytes: Uint8Array; read: () => unknown }> {
    if (this.size < 1) return Promise.reject(new Error('no worker threads on this machine'));
    return new Promise((resolve, reject) => {
      this.queue.push({ request: { id: this.nextId++, uri, text, embeddedExec }, resolve, reject });
      this.dispatch();
    });
  }

  dispose(): void {
    for (const thread of this.threads.splice(0)) {
      thread.job?.reject(new Error('worker threads stopped'));
      void thread.worker.terminate();
    }
    for (const job of this.queue.splice(0)) job.reject(new Error('worker threads stopped'));
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      let thread = this.threads.find(t => !t.job);
      if (!thread && this.threads.length < this.size) thread = this.start();
      if (!thread) return;
      thread.job = this.queue.shift()!;
      thread.worker.postMessage(thread.job.request);
    }
  }

  private start(): Thread {
    const thread: Thread = { worker: new Worker(this.script, { workerData: { outDir: this.outDir } }), job: undefined };
    thread.worker.on('message', (reply: AnalysisReply) => {
      const job = thread.job;
      if (!job || job.request.id !== reply.id) return;
      thread.job = undefined;
      if ('error' in reply) job.reject(new Error(reply.error));
      else job.resolve({ bytes: reply.bytes, read: () => compactDeserialized(v8.deserialize(reply.bytes)) });
      this.dispatch();
    });
    // A thread that dies (out of memory, a crash in the grammar) takes only
    // its file with it; the caller analyses that one itself.
    const fail = (err: Error) => {
      const i = this.threads.indexOf(thread);
      if (i < 0) return;
      this.threads.splice(i, 1);
      thread.job?.reject(err);
      thread.job = undefined;
      this.dispatch();
    };
    thread.worker.on('error', fail);
    thread.worker.on('exit', (code) => fail(new Error(`worker thread exited with code ${code}`)));
    this.threads.push(thread);
    return thread;
  }
}
