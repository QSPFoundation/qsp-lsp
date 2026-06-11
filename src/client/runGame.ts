/**
 * qsp.runGame — Node.js (desktop) implementation.
 *
 * Builds the project to a temp .qsp file and launches the configured player.
 * This file is only imported by nodeMain.ts; the browser entry point registers
 * a stub that tells the user the command is unavailable on VS Code for Web.
 */

import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { encodeTextToGame } from './txt2gam';
import { getActiveQspEditor, qspGlob } from './shared';
import { collectProjectUris, combineFiles, normalizeText } from './exportCommands';

export async function runGameCommand(
  context: vscode.ExtensionContext,
): Promise<void> {
  const playerExe = vscode.workspace
    .getConfiguration('qsp.game')
    .get<string>('playerExecutable')
    ?.trim();

  if (!playerExe) {
    const open = 'Open Settings';
    const choice = await vscode.window.showErrorMessage(
      "No QSP player configured. Set 'qsp.game.playerExecutable' to the path of your player.",
      open,
    );
    if (choice === open) {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'qsp.game.playerExecutable',
      );
    }
    return;
  }

  const projectEnabled = vscode.workspace
    .getConfiguration('qsp')
    .get<boolean>('project.enabled', true);

  let sourceText: string;

  if (projectEnabled) {
    const glob = qspGlob(context);
    const uris = await collectProjectUris(glob);
    if (uris.length === 0) {
      vscode.window.showWarningMessage('No QSP source files found in the workspace.');
      return;
    }
    sourceText = await combineFiles(uris, context);
  } else {
    const editor = getActiveQspEditor();
    if (!editor) return;
    sourceText = normalizeText(editor.document.getText());
  }

  // Use configured password silently — no prompt for a run-and-test workflow.
  const password = vscode.workspace.getConfiguration('qsp.game').get<string>('password') || undefined;

  // Write to the OS temp directory so the file never appears in the workspace.
  const tempFile = path.join(os.tmpdir(), `.qsp-run-${Date.now()}.qsp`);
  const tempUri = vscode.Uri.file(tempFile);

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

      await vscode.workspace.fs.writeFile(tempUri, gameBytes);

      // execFile passes playerExe and qspPath as distinct argv entries —
      // spaces in both paths are handled correctly, no shell quoting needed.
      cp.execFile(playerExe, [tempUri.fsPath], (err) => {
        void vscode.workspace.fs.delete(tempUri);
        if (err) {
          vscode.window.showErrorMessage(`Failed to launch player: ${err.message}`);
        }
      });
    },
  );
}
