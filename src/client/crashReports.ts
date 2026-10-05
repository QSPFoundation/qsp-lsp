// ── Crash reports ────────────────────────────────────────────────────
//
// The language server always runs with the light crash recorder
// (src/server/nodeRecorder.ts), writing into this extension's global
// storage. When a server run ends without its recorder marking a clean
// stop and the recorder saw an anomaly before (the heap near its limit,
// the analysis stuck), its files become a crash report: a zip in the project's
// .qsp/crash-reports folder, with the table of what each pseudonym
// stands for saved beside it for the user only. The report holds
// numbers, pseudonyms and the extension's own function names; on the
// user's consent (qsp.crashReports.includeAnonymizedCode) it also gets
// the anonymized code of the location the server was stuck on.

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { State, type LanguageClient } from 'vscode-languageclient/node';
import { claimRun, isAlive, listRuns, packRun, pruneReports, removeRun, type CrashSummary, type RecordedRun } from './crashPackage';
import { unzip, zip, type ZipEntry } from './zip';
import * as logger from './logger';

const KEEP_REPORTS = 5;

/** What the server is started with; read again on every (re)start. */
export interface ServerLaunch {
  /** Where the crash recorder writes; undefined when it's off. */
  crashDir?: string;
  /** Where the analysis cache lives; undefined when it's off or no folder is open. */
  cacheDir?: string;
}

type IncludeCode = 'ask' | 'always' | 'never';

/** Register crash recording for the server and the packing of crashed runs. */
export function registerCrashReports(context: vscode.ExtensionContext, client: LanguageClient, launch: ServerLaunch): void {
  const recorderDir = vscode.Uri.joinPath(context.globalStorageUri, 'crash').fsPath;
  const applySetting = () => {
    const enabled = vscode.workspace.getConfiguration('qsp').get<boolean>('crashReports.enabled', true);
    if (enabled) fs.mkdirSync(recorderDir, { recursive: true });
    // Read at the next server start.
    launch.crashDir = enabled ? recorderDir : undefined;
  };
  applySetting();

  let collecting = false;
  const collect = async () => {
    if (collecting) return;
    collecting = true;
    try {
      for (const run of listRuns(recorderDir)) {
        if (run.clean) {
          removeRun(recorderDir, run.pid);
          continue;
        }
        if (isAlive(run.pid) || !belongsHere(run)) continue;
        if (!claimRun(recorderDir, run.pid)) continue;
        if (!run.anomalies) {
          removeRun(recorderDir, run.pid);
          logger.log(`Language server process ${run.pid} ended without shutting down, with nothing unusual recorded near its end; no crash report made.`);
          continue;
        }
        await report(run);
      }
    } finally {
      collecting = false;
    }
  };

  // Another window's crashed runs are for that window to report. A run
  // that died before it knew its workspace is taken by whichever window
  // looks first.
  const belongsHere = (run: RecordedRun): boolean => {
    const folders = run.names?.workspaceFolders;
    if (!folders || folders.length === 0) return true;
    const mine = new Set((vscode.workspace.workspaceFolders ?? []).map(f => f.uri.toString()));
    return folders.some(f => mine.has(f));
  };

  const report = async (run: RecordedRun) => {
    const environment = {
      extensionVersion: (context.extension.packageJSON as { version?: string }).version,
      vscodeVersion: vscode.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      totalMemoryMB: Math.round(os.totalmem() / 1048576),
    };
    const { entries, summary } = packRun(recorderDir, run.pid, environment);
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const reportsDir = reportsDirOf();
    fs.mkdirSync(reportsDir, { recursive: true });
    // Reports are for sending, not for the game's repository.
    const ignore = path.join(reportsDir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const zipPath = path.join(reportsDir, `crash-${stamp}.zip`);
    const namesPath = path.join(reportsDir, `crash-${stamp}.names.json`);
    fs.writeFileSync(zipPath, zip(entries));
    const pseudonyms = { ...(run.names?.pseudonyms ?? {}) };
    fs.writeFileSync(namesPath, JSON.stringify(pseudonyms, null, 2));
    removeRun(recorderDir, run.pid);
    pruneReports(reportsDir, KEEP_REPORTS);

    const includeCode = vscode.workspace.getConfiguration('qsp').get<IncludeCode>('crashReports.includeAnonymizedCode', 'ask');
    const canAddCode = summary.location !== undefined && pseudonyms[summary.location] !== undefined && includeCode !== 'never';
    let codeAdded = false;
    if (canAddCode && includeCode === 'always') codeAdded = await addCode(summary, pseudonyms, entries, zipPath, namesPath);

    const shown = folder ? path.relative(folder, zipPath) : zipPath;
    const buttons = ['Open Folder', ...(canAddCode && !codeAdded ? ['Add Anonymized Code'] : [])];
    const pick = await vscode.window.showWarningMessage(
      `QSP: the language server stopped unexpectedly${describe(summary)}. A crash report was saved to ${shown}. `
      + 'It holds numbers, neutral names like f01_l0007 and the extension\'s own function names, no game text'
      + `${codeAdded ? ', plus the anonymized code of that location' : ''}. `
      + 'The table of what the neutral names stand for is saved next to it and stays with you.',
      ...buttons,
    );
    if (pick === 'Add Anonymized Code') {
      if (await addCode(summary, pseudonyms, entries, zipPath, namesPath)) {
        const open = await vscode.window.showInformationMessage(
          `QSP: the anonymized code of ${summary.location} was added to the crash report. Names are replaced, the letters of strings and comments are x-es, `
          + 'numbers are 0. Please look it over before sending.',
          'Open Folder',
        );
        if (open) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(zipPath));
      } else {
        void vscode.window.showWarningMessage(`QSP: could not produce the anonymized code of ${summary.location}: the language server did not answer.`);
      }
    } else if (pick === 'Open Folder') {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(zipPath));
    }
  };

  const reportsDirOf = () => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return folder ? path.join(folder, '.qsp', 'crash-reports') : path.join(context.globalStorageUri.fsPath, 'crash-reports');
  };

  // The code comes from the running (restarted) server, anonymized with
  // the crashed run's pseudonyms so it matches its breadcrumbs.
  const addCode = async (
    summary: CrashSummary, pseudonyms: Record<string, string>, entries: ZipEntry[], zipPath: string, namesPath: string,
  ): Promise<boolean> => {
    const id = summary.location!;
    const fileId = id.split('_')[0];
    const uri = pseudonyms[fileId];
    const name = pseudonyms[id];
    if (!uri || !name) return false;
    const locations: Record<string, string> = {};
    for (const [pseudo, real] of Object.entries(pseudonyms)) {
      if (pseudo.startsWith(`${fileId}_l`)) locations[real.toLowerCase()] = pseudo;
    }
    let result: { text: string; names: Record<string, string> } | undefined;
    try {
      result = await client.sendRequest('qsp/anonymizedLocation', { uri, name, locations });
    } catch {
      result = undefined;
    }
    if (!result) return false;
    entries.push({ name: `anonymized-${id}.qsps`, data: Buffer.from(result.text) });
    fs.writeFileSync(zipPath, zip(entries));
    fs.writeFileSync(namesPath, JSON.stringify({ ...pseudonyms, ...result.names }, null, 2));
    return true;
  };

  // For a report whose offer to add the code was passed by: its table of
  // names is still beside it, and the location's code is read as it is now.
  const addCodeLater = async () => {
    const dir = reportsDirOf();
    const reports = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
      .filter(f => /^crash-.*\.zip$/.test(f) && fs.existsSync(path.join(dir, f.replace(/\.zip$/, '.names.json'))))
      .sort().reverse();
    if (reports.length === 0) {
      void vscode.window.showInformationMessage(`QSP: no crash report with its table of names in ${dir}.`);
      return;
    }
    const picked = await vscode.window.showQuickPick(reports, { placeHolder: 'Crash report to add the anonymized code to' });
    if (!picked) return;
    const zipPath = path.join(dir, picked);
    const namesPath = zipPath.replace(/\.zip$/, '.names.json');
    let entries: ZipEntry[];
    let summary: CrashSummary | undefined;
    let pseudonyms: Record<string, string>;
    try {
      entries = unzip(fs.readFileSync(zipPath));
      const crash = entries.find(e => e.name === 'crash.json');
      summary = crash ? (JSON.parse(crash.data.toString('utf8')) as { summary?: CrashSummary }).summary : undefined;
      pseudonyms = JSON.parse(fs.readFileSync(namesPath, 'utf8')) as Record<string, string>;
    } catch (err) {
      void vscode.window.showWarningMessage(`QSP: could not read ${picked}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (entries.some(e => e.name.startsWith('anonymized-'))) {
      // Made by an earlier version, which kept less of the structure.
      const replace = 'Replace';
      const answer = await vscode.window.showInformationMessage(`QSP: ${picked} already has the anonymized code. Replace it with the code as it is now?`, replace);
      if (answer !== replace) return;
      entries = entries.filter(e => !e.name.startsWith('anonymized-'));
    }
    if (!summary?.location || !pseudonyms[summary.location]) {
      void vscode.window.showInformationMessage(`QSP: ${picked} names no location the server was analysing.`);
      return;
    }
    if (await addCode(summary, pseudonyms, entries, zipPath, namesPath)) {
      const open = await vscode.window.showInformationMessage(
        `QSP: the anonymized code of ${summary.location} (as it is now) was added to ${picked}. Names are replaced, the letters of strings and comments are x-es, `
        + 'numbers are 0. Please look it over before sending.',
        'Open Folder',
      );
      if (open) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(zipPath));
    } else {
      void vscode.window.showWarningMessage(`QSP: could not produce the anonymized code of ${summary.location}: the language server did not answer, or the location is gone.`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('qsp.addAnonymizedCodeToCrashReport', addCodeLater),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('qsp.crashReports.enabled')) applySetting();
    }),
    // A crash shows as the client losing its running server; give the
    // dying process a moment to be gone before checking.
    client.onDidChangeState(e => {
      if (e.oldState === State.Running && e.newState !== State.Running) setTimeout(() => { void collect(); }, 2000);
    }),
  );
  // Runs that crashed while VS Code was closing, or in an earlier session.
  setTimeout(() => { void collect(); }, 5000);
}

function describe(s: CrashSummary): string {
  const what = s.location ?? s.file;
  const size = s.location && s.chars ? ` (${Math.round(s.chars / 1000)} K chars${s.lines ? `, ${s.lines} lines` : ''})` : '';
  const where = what ? ` while analysing ${what}${size}${s.step ? `, step ${s.step}` : ''}` : '';
  const heap = s.heapMB ? `, heap ${s.heapMB}${s.limitMB ? ` of ${s.limitMB}` : ''} MB` : '';
  return where + heap;
}
