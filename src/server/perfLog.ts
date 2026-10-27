// ── Performance log ──────────────────────────────────────────────────
//
// Times the analysis phases (parsing, symbols, project aggregates,
// diagnostics) and the memory around them, and writes one line per phase
// to the server log. The lines hold only counts, sizes, durations and
// memory, never file, location or variable names: users send them for
// games whose text they can't share.

/** Memory as the host sees it, in bytes. */
export interface MemorySample {
  heapUsed: number;
  /** The heap size at which the process dies with "JavaScript heap out of memory". */
  heapLimit?: number;
  rss?: number;
  /** Memory outside the JS heap: WASM (tree-sitter) and buffers. */
  external?: number;
}

import type { Steps } from './slices';

export type MemoryReader = () => MemorySample;

/** One location of a file being analysed, under its pseudonym. */
export interface TrackedLocation { id: string; chars: number; lines: number }

/**
 * Where the analysis is, for the recorder's breadcrumbs. Cheap enough to
 * call for every location and step; names are pseudonyms or the
 * extension's own phase and step names.
 */
export interface Tracker {
  phase(name: string | undefined): void;
  step(name: string | undefined): void;
  /** A file's analysis starts (or `undefined` when none is running). */
  file(id: string | undefined, locations?: readonly TrackedLocation[]): void;
  /** The analysis moved to the location at `index` in the current file. */
  location(index: number): void;
}

/**
 * The crash recorder: records the server's memory, heap and breadcrumbs
 * all the time, so a crash leaves a report (Node only; see
 * nodeRecorder.ts).
 */
export interface Recorder extends Tracker {
  start(dir: string): void;
  /** Write the final files, mark the run as ended cleanly, and stop; returns the names of this process's files. */
  stop(): Promise<string[]>;
  /** Whether recording is on in this process. */
  readonly active: boolean;
  /** Write `data` as `<base>-<pid>.json` into the recorder's directory. */
  writeJson(base: string, data: unknown): void;
}

/** What only some hosts (the Node server) can offer the transport-agnostic server. */
export interface ServerHost {
  memory?: MemoryReader;
  recorder?: Recorder;
  /** Disk cache of analysis results; absent where there is no file system. */
  analysisCache?: import('./serverUtils').AnalysisCacheStore;
  /** Threads for the project load's file analysis; absent where there are none. */
  analysisWorkers?: import('./serverUtils').AnalysisWorkers;
}

/** A phase at least this long is logged even without `qsp.debug.performanceLog`. */
export const SLOW_PHASE_MS = 1000;

const HEARTBEAT_MS = 1000;

// One per process: set by PerfLog.onHeartbeat.
let heartbeatHook: (() => void) | undefined;
let lastBeat = 0;

/**
 * Run the heartbeat hook if a second has passed since it last ran (the
 * crash recorder writes its report from it). Cheap enough for hot loops:
 * call it from loops that can run for long inside one step (the project
 * aggregates), which no timer interrupts.
 */
export function heartbeat(): void {
  if (!heartbeatHook) return;
  const now = performance.now();
  if (now - lastBeat < HEARTBEAT_MS) return;
  lastBeat = now;
  try {
    heartbeatHook();
  } catch {
    // Profiling must never break the analysis.
  }
}

interface StepTotal { ms: number; count: number }

const MB = 1024 * 1024;

function formatMs(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / MB)} MB`;
}

/** Collects phase timings and writes them to the log. */
export class PerfLog {
  /** Log every phase, not just the slow ones (`qsp.debug.performanceLog`). */
  verbose = false;
  /** Told where the analysis is; see {@link Tracker}. */
  tracker: Tracker | undefined;
  private steps: Map<string, StepTotal> | undefined;
  private currentPhase: string | undefined;
  private currentStep: string | undefined;

  constructor(
    private readonly write: (line: string) => void,
    private readonly memory?: MemoryReader,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /**
   * Call `fn` about once a second while steps run. Long analyses are
   * synchronous loops that no timer interrupts; this is how the crash
   * recorder still gets a fresh report during them.
   */
  onHeartbeat(fn: (() => void) | undefined): void {
    heartbeatHook = fn;
    lastBeat = 0;
  }

  /** Current memory, or undefined where the host can't tell (the browser). */
  sampleMemory(): MemorySample | undefined {
    try {
      return this.memory?.();
    } catch {
      return undefined;
    }
  }

  /**
   * Run `fn` as the phase `name`: time it, break the time down by the
   * `step`s run inside it, and log it with the memory before and after.
   * `details` describes the work done, in numbers only. A phase inside
   * another also counts as a step of the outer one.
   */
  phase<T>(name: string, fn: () => T, details?: (result: T) => string): T {
    const outer = this.steps;
    this.steps = new Map();
    const outerPhase = this.enterPhase(name);
    const before = this.sampleMemory();
    const started = this.now();
    let result: T | undefined;
    let failed = false;
    try {
      result = fn();
      return result;
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      const ms = this.now() - started;
      const steps = this.steps;
      this.steps = outer;
      this.enterPhase(outerPhase);
      if (outer) addStep(outer, name, ms);
      this.report(name, ms, steps, before, failed ? 'failed' : details ? safeDetails(details, result as T) : '');
    }
  }

  /** `phase` for async work. Steps run while it awaits count towards it. */
  async phaseAsync<T>(name: string, fn: () => Promise<T>, details?: (result: T) => string): Promise<T> {
    const outer = this.steps;
    const steps = new Map<string, StepTotal>();
    this.steps = steps;
    const outerPhase = this.enterPhase(name);
    const before = this.sampleMemory();
    const started = this.now();
    let result: T | undefined;
    let failed = false;
    try {
      result = await fn();
      return result;
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      const ms = this.now() - started;
      this.steps = outer;
      this.enterPhase(outerPhase);
      if (outer) addStep(outer, name, ms);
      this.report(name, ms, steps, before, failed ? 'failed' : details ? safeDetails(details, result as T) : '');
    }
  }

  /** Add the time of `fn` to the enclosing phase's breakdown under `name`; just runs `fn` outside a phase. */
  step<T>(name: string, fn: () => T): T {
    const steps = this.steps;
    if (!steps) return fn();
    const outerStep = this.currentStep;
    this.currentStep = name;
    this.tracker?.step(name);
    const started = this.now();
    try {
      return fn();
    } finally {
      addStep(steps, name, this.now() - started);
      this.currentStep = outerStep;
      this.tracker?.step(outerStep);
      heartbeat();
    }
  }

  /**
   * `phase` for work in slices (slices.ts). Only the time its slices run
   * counts, and only the steps run inside them: what the server does
   * between slices (answering requests) is timed apart. When the work was
   * spread out, the line also gives the time from start to end.
   */
  *phaseSteps<T>(name: string, steps: Steps<T>, details?: (result: T) => string): Steps<T> {
    const own = new Map<string, StepTotal>();
    const before = this.sampleMemory();
    const started = this.now();
    let ms = 0;
    let outcome = 'cancelled';
    let result: T | undefined;
    try {
      for (;;) {
        // Set for this slice only: phases may run between slices.
        const outer = this.steps;
        const outerPhase = this.enterPhase(name);
        this.steps = own;
        const t = this.now();
        let r: IteratorResult<void, T>;
        try {
          r = steps.next();
        } catch (e) {
          outcome = 'failed';
          throw e;
        } finally {
          ms += this.now() - t;
          this.steps = outer;
          this.enterPhase(outerPhase);
        }
        if (r.done) {
          if (outer) addStep(outer, name, ms);
          result = r.value;
          outcome = details ? safeDetails(details, result) : '';
          return result;
        }
        yield;
      }
    } finally {
      // Closed early (cancelled): close the work too.
      steps.return(undefined as T);
      const wall = this.now() - started;
      const spread = wall - ms >= 1 ? `${formatMs(wall)} in all` : '';
      this.report(name, ms, own, before, [outcome, spread].filter(Boolean).join(', '));
    }
  }

  /** `step` for work in slices: adds the time its slices run to the enclosing phase. */
  *stepSteps<T>(name: string, steps: Steps<T>): Steps<T> {
    let ms = 0;
    let into: Map<string, StepTotal> | undefined;
    try {
      for (;;) {
        into ??= this.steps;
        const outerStep = this.currentStep;
        this.currentStep = name;
        this.tracker?.step(name);
        const t = this.now();
        let r: IteratorResult<void, T>;
        try {
          r = steps.next();
        } finally {
          ms += this.now() - t;
          this.currentStep = outerStep;
          this.tracker?.step(outerStep);
          heartbeat();
        }
        if (r.done) return r.value;
        yield;
      }
    } finally {
      steps.return(undefined as T);
      if (into) addStep(into, name, ms);
    }
  }

  /** Tell the tracker a file's analysis starts; see {@link Tracker.file}. */
  enterFile(id: string | undefined, locations?: readonly TrackedLocation[]): void {
    this.tracker?.file(id, locations);
  }

  /** Tell the tracker the analysis moved to the location at `index`. */
  atLocation(index: number): void {
    this.tracker?.location(index);
  }

  // Returns the phase it replaces, to restore on the way out.
  private enterPhase(name: string | undefined): string | undefined {
    const outer = this.currentPhase;
    this.currentPhase = name;
    this.tracker?.phase(name);
    return outer;
  }

  /** Log a one-off line (e.g. a reply size), always. */
  note(text: string): void {
    this.write(`[perf] ${text}`);
  }

  private report(name: string, ms: number, steps: Map<string, StepTotal>, before: MemorySample | undefined, details: string): void {
    const parts = [`[perf] ${name} ${formatMs(ms)}`];
    if (steps.size > 0) {
      const list = [...steps].sort((a, b) => b[1].ms - a[1].ms)
        .map(([step, t]) => `${step} ${formatMs(t.ms)}${t.count > 1 ? ` (${t.count}×)` : ''}`);
      parts.push(list.join(', '));
    }
    const after = this.sampleMemory();
    if (after) {
      const delta = before ? after.heapUsed - before.heapUsed : 0;
      let mem = `heap ${formatMb(after.heapUsed)}${before ? ` (${delta >= 0 ? '+' : '−'}${formatMb(Math.abs(delta))})` : ''}`;
      if (after.heapLimit) mem += ` of ${formatMb(after.heapLimit)}`;
      if (after.external !== undefined) mem += `, external ${formatMb(after.external)}`;
      if (after.rss !== undefined) mem += `, rss ${formatMb(after.rss)}`;
      parts.push(mem);
    }
    if (details) parts.push(details);
    if (this.verbose || ms >= SLOW_PHASE_MS) this.write(parts.join(' · '));
  }

}

function addStep(steps: Map<string, StepTotal>, name: string, ms: number): void {
  const t = steps.get(name);
  if (t) {
    t.ms += ms;
    t.count++;
  } else {
    steps.set(name, { ms, count: 1 });
  }
}

// A details callback that throws must not hide the phase line (or replace
// the phase's own exception).
function safeDetails<T>(details: (result: T) => string, result: T): string {
  try {
    return details(result);
  } catch {
    return '';
  }
}

/** Human-readable size of a text, e.g. `25.5 M chars`. Used in phase details. */
export function formatChars(chars: number): string {
  return chars >= 1_000_000 ? `${(chars / 1_000_000).toFixed(1)} M chars` : chars >= 1000 ? `${Math.round(chars / 1000)} K chars` : `${chars} chars`;
}
