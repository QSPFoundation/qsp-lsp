// ── Crash packages ───────────────────────────────────────────────────
//
// What a server run leaves in the recorder directory (see
// src/server/nodeRecorder.ts), turned into a crash report: the run's
// files in a zip, with a summary on top. names-<pid>.json, the table of
// what each pseudonym stands for, stays out of the zip: it is saved next
// to it for the user alone. No vscode import, so it can be tested.

import * as fs from 'fs';
import * as path from 'path';
import type { ZipEntry } from './zip';

/** One server run found in the recorder directory. */
export interface RecordedRun {
  pid: number;
  /** It stopped normally (its recorder wrote clean-<pid>.json). */
  clean: boolean;
  /**
   * Its recorder saw something wrong still going on when it ended: an
   * uncaught exception, a breadcrumb (the heap past a threshold or
   * growing fast, the analysis stuck) in its last two minutes, or the
   * heap past half its limit at the last sample. A run that stopped
   * without a clean mark and without any of these was most likely killed
   * with its editor, not crashed: a heap that grew while a large game
   * loaded and then ran calmly for long is no crash.
   */
  anomalies: boolean;
  /** Its names file: the workspace it served and the pseudonym table. */
  names?: { workspaceFolders?: string[]; pseudonyms?: Record<string, string> };
}

/** What the crash report's summary says about where the run was. */
export interface CrashSummary {
  pid: number;
  startedAt?: string;
  /** Pseudonym of the file being analysed, if known. */
  file?: string;
  /** Pseudonym of the location being analysed, if known. */
  location?: string;
  step?: string;
  chars?: number;
  lines?: number;
  heapMB?: number;
  limitMB?: number;
  lastBreadcrumb?: Record<string, unknown>;
}

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

/** The runs recorded in `dir`. */
export function listRuns(dir: string): RecordedRun[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const pids = new Set<number>();
  for (const f of files) {
    const m = /^session-(\d+)\.json$/.exec(f);
    if (m) pids.add(Number(m[1]));
  }
  return [...pids].map(pid => ({
    pid,
    clean: files.includes(`clean-${pid}.json`),
    anomalies: files.includes(`breadcrumbs-${pid}.jsonl`) && endedBadly(dir, pid),
    names: readJson(path.join(dir, `names-${pid}.json`)),
  }));
}

// How long before a run's end a breadcrumb still says what ended it.
const RECENT_SECONDS = 120;

function endedBadly(dir: string, pid: number): boolean {
  let crumbs: { t?: number; kind?: string }[];
  try {
    crumbs = fs.readFileSync(path.join(dir, `breadcrumbs-${pid}.jsonl`), 'utf8')
      .split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as { t?: number; kind?: string });
  } catch {
    return true;
  }
  if (crumbs.some(c => c.kind === 'uncaught-exception' || c.kind === 'recorder-failed' || typeof c.t !== 'number')) return true;
  let last: string[] | undefined;
  try {
    last = fs.readFileSync(path.join(dir, `memory-${pid}.csv`), 'utf8').trim().split('\n').at(-1)?.split(',');
  } catch {
    // No samples: nothing tells the end was calm.
  }
  const [seconds, heapMB, limitMB] = (last ?? []).map(Number);
  if (!Number.isFinite(seconds)) return true;
  if (heapMB >= limitMB / 2) return true;
  return crumbs.some(c => c.t! >= seconds - RECENT_SECONDS);
}

/** Whether a process with this id is running. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Take a run for packing. Several VS Code windows share the directory;
 * renaming the session file lets exactly one of them have it.
 */
export function claimRun(dir: string, pid: number): boolean {
  try {
    fs.renameSync(path.join(dir, `session-${pid}.json`), path.join(dir, `session-${pid}.claimed`));
    return true;
  } catch {
    return false;
  }
}

/** Delete everything the run left. */
export function removeRun(dir: string, pid: number): void {
  for (const f of runFiles(dir, pid)) fs.rmSync(path.join(dir, f), { force: true });
}

function runFiles(dir: string, pid: number): string[] {
  try {
    return fs.readdirSync(dir).filter(f => f.includes(`-${pid}.`));
  } catch {
    return [];
  }
}

/**
 * The zip entries for a claimed run (everything but its names file) and
 * a summary of where it was when it stopped, which also goes in as
 * crash.json with `environment`.
 */
export function packRun(dir: string, pid: number, environment: Record<string, unknown>): { entries: ZipEntry[]; summary: CrashSummary } {
  const summary: CrashSummary = { pid };
  const session = readJson<{ startedAt?: string; heapLimitMB?: number }>(path.join(dir, `session-${pid}.claimed`));
  summary.startedAt = session?.startedAt;
  summary.limitMB = session?.heapLimitMB;

  let crumbs: Array<Record<string, unknown>> = [];
  try {
    crumbs = fs.readFileSync(path.join(dir, `breadcrumbs-${pid}.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
  } catch {
    // No anomaly was seen.
  }
  const last = crumbs.at(-1);
  if (last) {
    summary.lastBreadcrumb = last;
    const loc = last.location as { id?: string; chars?: number; lines?: number } | undefined;
    summary.location = loc?.id;
    summary.chars = loc?.chars;
    summary.lines = loc?.lines;
    summary.step = last.step as string | undefined;
    summary.file = last.file as string | undefined;
    summary.heapMB = last.heapMB as number | undefined;
  }
  if (!summary.location) {
    const trail = readJson<{ current?: { location?: string; step?: string } }>(path.join(dir, `trail-${pid}.json`));
    summary.location = trail?.current?.location;
    summary.step ??= trail?.current?.step;
  }
  try {
    const rows = fs.readFileSync(path.join(dir, `memory-${pid}.csv`), 'utf8').trim().split('\n');
    const lastRow = rows.at(-1)?.split(',');
    if (lastRow && rows.length > 1) summary.heapMB = Math.max(summary.heapMB ?? 0, Number(lastRow[1]));
  } catch {
    // No memory sample yet.
  }

  const entries: ZipEntry[] = [{ name: 'crash.json', data: Buffer.from(JSON.stringify({ environment, summary }, null, 2)) }];
  for (const f of runFiles(dir, pid)) {
    if (f.startsWith('names-')) continue;
    // Drop the pid from names inside the archive; there is one run per report.
    const name = f === `session-${pid}.claimed` ? 'session.json' : f.replace(`-${pid}.`, '.');
    entries.push({ name, data: fs.readFileSync(path.join(dir, f)) });
  }
  return { entries, summary };
}

/** Delete all but the newest `keep` reports (and their names files) in `reportsDir`. */
export function pruneReports(reportsDir: string, keep: number): void {
  let zips: string[];
  try {
    zips = fs.readdirSync(reportsDir).filter(f => /^crash-.*\.zip$/.test(f)).sort();
  } catch {
    return;
  }
  for (const old of zips.slice(0, Math.max(0, zips.length - keep))) {
    fs.rmSync(path.join(reportsDir, old), { force: true });
    fs.rmSync(path.join(reportsDir, old.replace(/\.zip$/, '.names.json')), { force: true });
  }
}
