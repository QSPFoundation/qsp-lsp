// ── QSP: Export Anonymized Skeleton ──────────────────────────────────
//
// The whole game with only its structure left (src/parser/skeleton.ts), for
// reproducing a problem of the analysis in a game that can't be shared.
// File names are game text too: the files become f01.qsps, f02.qsps… in
// build order (the first one starts the game), and libraries
// libs/lib01.qsps…, which the analysis treats as libraries by their place.
// The table of what each pseudonym stands for is written beside the
// skeleton's folder, not in it, and is never meant to be sent.

import * as vscode from 'vscode';
import type { BaseLanguageClient } from 'vscode-languageclient';
import { LIBRARY_FOLDER } from '../common/libraryConfig';
import { readFileAsText } from './exportCommands';
import { orderedProjectUris, readGameConfig } from './gameConfig';
import { qspGlob } from './shared';
import * as logger from './logger';

interface SkeletonResult {
  files: { uri: string; text: string }[];
  names: Record<string, string>;
}

/** Register **QSP: Export Anonymized Skeleton**. */
export function registerSkeletonExport(context: vscode.ExtensionContext, client: BaseLanguageClient): void {
  context.subscriptions.push(vscode.commands.registerCommand('qsp.exportAnonymizedSkeleton', () => exportSkeleton(context, client)));
}

async function exportSkeleton(context: vscode.ExtensionContext, client: BaseLanguageClient): Promise<void> {
  const glob = qspGlob(context);
  const all = await vscode.workspace.findFiles(glob);
  if (all.length === 0) {
    void vscode.window.showInformationMessage('QSP: no QSP files in the workspace to export.');
    return;
  }
  const uris = await sourcesInBuildOrder(all, glob);

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
    openLabel: 'Export Here',
    title: 'Folder to put the anonymized skeleton in (outside the workspace)',
    defaultUri: workspace ? vscode.Uri.joinPath(workspace, '..') : undefined,
  });
  if (!picked?.[0]) return;
  const parent = picked[0];
  // Inside the workspace, the analysis would read the skeleton as part of
  // the game: every location twice.
  if (vscode.workspace.getWorkspaceFolder(vscode.Uri.joinPath(parent, 'x'))) {
    void vscode.window.showWarningMessage('QSP: pick a folder outside the workspace for the skeleton.');
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const folder = vscode.Uri.joinPath(parent, `qsp-skeleton-${stamp}`);
  const namesFile = vscode.Uri.joinPath(parent, `qsp-skeleton-${stamp}.names.json`);

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'QSP: making the anonymized skeleton…' },
    async () => {
      const files = [];
      for (const uri of uris) files.push({ uri: uri.toString(), text: await readFileAsText(uri, context) });
      return client.sendRequest<SkeletonResult | null>('qsp/anonymizedSkeleton', { files });
    },
  ).then(r => r, (err: unknown) => {
    logger.log(`[Skeleton] ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  if (!result) {
    void vscode.window.showWarningMessage('QSP: could not make the skeleton: the language server has no parser loaded or did not answer.');
    return;
  }

  const paths = skeletonPaths(uris);
  const encoder = new TextEncoder();
  for (const [i, file] of result.files.entries()) {
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, paths[i]), encoder.encode('﻿' + file.text));
  }
  const files: Record<string, string> = {};
  paths.forEach((p, i) => { files[p] = vscode.workspace.asRelativePath(uris[i], true); });
  await vscode.workspace.fs.writeFile(namesFile, encoder.encode(JSON.stringify({ files, words: result.names }, null, 1)));

  const open = await vscode.window.showInformationMessage(
    `QSP: the anonymized skeleton of ${uris.length} file(s) is in ${folder.fsPath}. Names are replaced word by word, the letters of other text are x-es; `
    + `numbers, code and line breaks stay. Please look it over before sending. What the pseudonyms stand for is in ${namesFile.fsPath}: keep it, don't send it.`,
    'Open Folder',
  );
  if (open) await vscode.commands.executeCommand('revealFileInOS', folder);
}

// Build order where txt2gam.json or the mainFile setting gives one, the
// rest (libraries, files the build leaves out) after it.
async function sourcesInBuildOrder(all: vscode.Uri[], glob: string): Promise<vscode.Uri[]> {
  let ordered: vscode.Uri[] = [];
  try {
    ordered = await orderedProjectUris(await readGameConfig(), glob);
  } catch {
    // A broken txt2gam.json: alphabetical order.
  }
  const seen = new Set(ordered.map(u => u.toString()));
  const rest = all.filter(u => !seen.has(u.toString())).sort((a, b) => a.toString().localeCompare(b.toString()));
  return [...ordered, ...rest];
}

function skeletonPaths(uris: vscode.Uri[]): string[] {
  let game = 0;
  let lib = 0;
  const width = String(uris.length).length < 2 ? 2 : String(uris.length).length;
  const pad = (n: number) => String(n).padStart(width, '0');
  return uris.map(uri => {
    const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
    const ext = /\.[^./]+$/.exec(rel)?.[0] ?? '.qsps';
    if (new RegExp(`^${LIBRARY_FOLDER}/[^/]+\\.qsps$`, 'i').test(rel)) return `${LIBRARY_FOLDER}/lib${pad(++lib)}.qsps`;
    return `f${pad(++game)}${ext}`;
  });
}
