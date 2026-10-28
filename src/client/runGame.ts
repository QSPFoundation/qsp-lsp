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
import { buildProjectGame, normalizeText } from './exportCommands';
import { ensureGameConfig, readGameConfig, workspaceRoot, type GameConfig } from './gameConfig';
import {
  DEFAULT_PLAYER_ARGS, classifyPlayerPath, findPlayer, listPlayers, playerArguments, type PlayerChoice,
} from '../common/playerExecutable';
import * as logger from './logger';

/**
 * Build the game and open it in a player: the one txt2gam.json's `players`
 * calls `playerName`, or the default one.
 */
export async function runGameCommand(
  context: vscode.ExtensionContext,
  playerName?: string,
): Promise<void> {
  logger.show();
  logger.log('[Run] Starting...');
  const projectEnabled = vscode.workspace
    .getConfiguration('qsp')
    .get<boolean>('project.enabled', true);
  logger.log(`[Run] Project mode: ${projectEnabled}`);

  // Project mode builds through buildProjectGame; single-file mode encodes the active editor.
  let gameCfg: GameConfig | undefined;
  let sourceText = '';
  let outputUri: vscode.Uri | undefined;

  if (projectEnabled) {
    gameCfg = await ensureGameConfig(qspGlob(context));
    if (!gameCfg) return; // user cancelled setup
  } else {
    const editor = getActiveQspEditor();
    if (!editor) return;
    sourceText = normalizeText(editor.document.getText());
    const docUri = editor.document.uri;
    const baseName = docUri.path.split('/').pop()!.replace(/\.[^.]+$/, '') + '.qsp';
    const dirUri = docUri.with({ path: docUri.path.slice(0, docUri.path.lastIndexOf('/')) });
    outputUri = vscode.Uri.joinPath(dirUri, baseName);
  }

  const player = await resolvePlayer(gameCfg, playerName);
  if (!player) return; // cancelled, or no such player

  // Use configured password silently — no prompt for a run-and-test workflow.
  const password = vscode.workspace.getConfiguration('qsp.game').get<string>('password') || undefined;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Building game…' },
    async () => {
      // In perFile mode several .qsp files are written; the first in source
      // order holds the start location, so that's the one the player opens.
      let gameUri: vscode.Uri;
      try {
        if (gameCfg) {
          const written = await buildProjectGame(context, gameCfg, qspGlob(context), password);
          if (written.length === 0) {
            vscode.window.showWarningMessage('No QSP source files found in the workspace.');
            return;
          }
          gameUri = written[0];
        } else {
          logger.log(`[Run] Building: ${vscode.workspace.asRelativePath(outputUri!)}`);
          const gameBytes = await encodeTextToGame(context.extensionUri, sourceText, { password });
          await vscode.workspace.fs.writeFile(outputUri!, gameBytes);
          logger.log(`[Run] Written: ${vscode.workspace.asRelativePath(outputUri!)} (${Math.round(gameBytes.byteLength / 1024)}kb)`);
          gameUri = outputUri!;
        }
      } catch (err) {
        logger.log(`[Run] Build failed: ${err instanceof Error ? err.message : String(err)}`);
        vscode.window.showErrorMessage(
          `Build failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      // execFile passes the player and each argument as distinct argv
      // entries: spaces in paths are handled, no shell quoting needed.
      const args = playerArguments(player.args, gameUri.fsPath);
      logger.log(`[Run] Launching: ${player.executable} ${args.join(' ')}`);
      cp.execFile(player.executable, args, (err) => {
        if (err) {
          logger.log(`[Run] Launch failed: ${err.message}`);
          vscode.window.showErrorMessage(`Failed to launch player: ${err.message}`);
        }
      });
    },
  );
}

/**
 * Pick a player from txt2gam.json's `players` and run the game in it; with
 * one player or none, run the game as Run QSP Game does.
 */
export async function runGameInPlayerCommand(context: vscode.ExtensionContext): Promise<void> {
  const players = listPlayers(await readConfigForPlayers(), process.platform);
  let name: string | undefined;
  if (players.length > 1) {
    const picked = await vscode.window.showQuickPick(
      players.map((p, i) => ({ label: p.name, description: i === 0 ? 'default' : undefined, detail: p.executable })),
      { title: 'Run QSP Game in…', placeHolder: 'The players of txt2gam.json' },
    );
    if (!picked) return;
    name = picked.label;
  }
  await runGameCommand(context, name);
}

/**
 * Keep the `qsp.severalPlayers` context key (the editor's Run menu offers
 * Run QSP Game in… by it) in step with txt2gam.json.
 */
export function registerPlayersContext(context: vscode.ExtensionContext): void {
  const update = async () => {
    const several = listPlayers(await readConfigForPlayers(), process.platform).length > 1;
    await vscode.commands.executeCommand('setContext', 'qsp.severalPlayers', several);
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/txt2gam.json');
  watcher.onDidCreate(update);
  watcher.onDidChange(update);
  watcher.onDidDelete(update);
  context.subscriptions.push(watcher, vscode.workspace.onDidChangeWorkspaceFolders(update));
  void update();
}

async function readConfigForPlayers(): Promise<GameConfig | undefined> {
  try {
    return await readGameConfig();
  } catch (err) {
    logger.log(`[Run] Ignoring txt2gam.json for the players: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * The player to launch: the one of txt2gam.json's players called `name`,
 * or its first (`players`, else `playerExecutable`), then the
 * `qsp.game.playerExecutable` setting, then a file picker whose choice is
 * saved to the setting. Undefined when the picker is cancelled or there is
 * no player called `name`.
 */
async function resolvePlayer(projectCfg: GameConfig | undefined, name?: string): Promise<PlayerChoice | undefined> {
  // Single-file mode doesn't build from txt2gam.json, but a player named
  // there is still the project's player.
  const cfg = projectCfg ?? await readConfigForPlayers();
  const players = listPlayers(cfg, process.platform);
  const chosen = name === undefined ? players[0] : findPlayer(players, name);
  if (name !== undefined && !chosen) {
    const known = players.map(p => p.name).join(', ');
    logger.log(`[Run] No player called ${name} for ${process.platform} in txt2gam.json`);
    vscode.window.showErrorMessage(known
      ? `txt2gam.json has no player called "${name}" for this system: ${known}.`
      : `txt2gam.json has no player called "${name}" for this system.`);
    return undefined;
  }
  if (chosen) {
    const root = workspaceRoot();
    const executable = classifyPlayerPath(chosen.executable) === 'relative' && root
      ? vscode.Uri.joinPath(root, chosen.executable).fsPath
      : chosen.executable;
    logger.log(`[Run] Player (txt2gam.json): ${chosen.name}, ${executable}`);
    return { ...chosen, executable };
  }
  if (cfg?.players !== undefined || cfg?.playerExecutable !== undefined) {
    logger.log(`[Run] txt2gam.json names no usable player for ${process.platform}; using the setting`);
  }

  const fromSetting = vscode.workspace
    .getConfiguration('qsp.game')
    .get<string>('playerExecutable')
    ?.trim();
  if (fromSetting) {
    logger.log(`[Run] Player (setting): ${fromSetting}`);
    return { name: 'player', executable: fromSetting, args: DEFAULT_PLAYER_ARGS };
  }

  const picked = await vscode.window.showOpenDialog({
    title: 'Select QSP player executable',
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: 'Select player',
  });
  if (!picked || picked.length === 0) return undefined;

  const player = picked[0].fsPath;
  // Saved globally rather than to txt2gam.json: an absolute path picked on
  // this machine means nothing on another checkout.
  await vscode.workspace
    .getConfiguration('qsp.game')
    .update('playerExecutable', player, vscode.ConfigurationTarget.Global);
  logger.log(`[Run] Player executable saved: ${player}`);
  return { name: 'player', executable: player, args: DEFAULT_PLAYER_ARGS };
}
