/**
 * Minimal Web Worker type stubs for the browser entry points.
 *
 * We don't include the full "webworker" or "dom" lib to avoid polluting
 * the Node.js server code with browser globals.  These declarations
 * provide just enough for the browser bootstrapping files to compile.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Web Worker constructor (used by client/browserMain.ts). */
declare class Worker {
  constructor(scriptURL: string | URL, options?: { type?: string; name?: string });
  postMessage(message: any, transfer?: any[]): void;
  terminate(): void;
  onmessage: ((ev: any) => any) | null;
  onerror: ((ev: any) => any) | null;
}

/**
 * Global scope inside a Web Worker (used by server/browserMain.ts).
 * Declared as `any` because the real DedicatedWorkerGlobalScope is
 * large and we only need it to satisfy the `self as unknown as Worker` cast.
 */
declare const self: any;
