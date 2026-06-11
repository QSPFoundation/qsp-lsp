/**
 * qsp.runGame — Node.js (desktop) implementation.
 *
 * Builds the project to a .qsp file in the workspace root and launches
 * the configured player. The output file stays in the workspace so that
 * relative resource paths (images, sounds, etc.) resolve correctly.
 * This file is only imported by nodeMain.ts; the browser entry point registers
 * a stub that tells the user the command is unavailable on VS Code for Web.
 */

import * as cp from 'child_process';
import * as vscode from 'vscode';
import { encodeTextToGame } from './txt2gam';
import { getActiveQspEditor, qspGlob } from './shared';
import { combineFiles, normalizeText } from './exportCommands';
import { ensureGameConfig, collectOrderedUris, resolveOutputUri } from './gameConfig';

export async function runGameCommand(
  context: vscode.ExtensionContext,
): Promise<void> {
  let playerExe = vscode.workspace
    .getConfiguration('qsp.game')
    .get<string>('playerExecutable')
    ?.trim();

  if (!playerExe) {
    const picked = await vscode.window.showOpenDialog({
      title: 'Select QSP player executable',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Select player',
    });
    if (!picked || picked.length === 0) return; // cancelled

    playerExe = picked[0].fsPath;

    // Persist so the user won't be asked again.
    await vscode.workspace
      .getConfiguration('qsp.game')
      .update('playerExecutable', playerExe, vscode.ConfigurationTarget.Global);
  }

  const projectEnabled = vscode.workspace
    .getConfiguration('qsp')
    .get<boolean>('project.enabled', true);

  let sourceText: string;
  let outputUri: vscode.Uri;

  if (projectEnabled) {
    const glob = qspGlob(context);
    const gameCfg = await ensureGameConfig(glob);
    if (!gameCfg) return; // user cancelled setup
    const uris = await collectOrderedUris(gameCfg, glob);
    if (uris.length === 0) {
      vscode.window.showWarningMessage('No QSP source files found in the workspace.');
      return;
    }
    sourceText = await combineFiles(uris, context);
    outputUri = resolveOutputUri(gameCfg);
  } else {
    const editor = getActiveQspEditor();
    if (!editor) return;
    sourceText = normalizeText(editor.document.getText());
    const docUri = editor.document.uri;
    const baseName = docUri.path.split('/').pop()!.replace(/\.[^.]+$/, '') + '.qsp';
    const dirUri = docUri.with({ path: docUri.path.slice(0, docUri.path.lastIndexOf('/')) });
    outputUri = vscode.Uri.joinPath(dirUri, baseName);
  }

  // Use configured password silently — no prompt for a run-and-test workflow.
  const password = vscode.workspace.getConfiguration('qsp.game').get<string>('password') || undefined;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Building game…' },
    async () => {
      let gameBytes: Uint8Array;
      try {
        gameBytes = await encodeTextToGame(context.extensionUri, sourceText, { password });
      } catch (err) {
        vscode.window.showErrorMessage(
          `Build failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      await vscode.workspace.fs.writeFile(outputUri, gameBytes);

      // execFile passes playerExe and qspPath as distinct argv entries —
      // spaces in both paths are handled correctly, no shell quoting needed.
      cp.execFile(playerExe, [outputUri.fsPath], (err) => {
        if (err) {
          vscode.window.showErrorMessage(`Failed to launch player: ${err.message}`);
        }
      });
    },
  );
}
