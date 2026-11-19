/**
 * QSP export / decode commands:
 *
 *   qsp.combineProject — combine all project .qsps/.qsrc files into
 *                         one .qsps file (sorted alphabetically by path).
 *   qsp.exportGame     — combine + encode to a binary .qsp game file.
 *   qsp.importGame     — decode a .qsp binary back to a .qsps text file.
 *
 * The qsp.runGame command (Node.js only) lives in runGame.ts.
 *
 * All commands run on the extension host (client side) and work on both
 * desktop and VS Code for Web.
 */

import * as vscode from 'vscode';
import {
  encodeTextToGame,
  decodeGameToText,
  parseTextBytes,
  isT2gError,
  T2gErrorCode,
} from './txt2gam';
import { getActiveQspEditor, qspGlob } from './shared';
import {
  ensureGameConfig,
  readGameConfig,
  collectOrderedUris,
  orderedProjectUris,
  resolveOutputUri,
  effectiveBuildMode,
  workspaceRoot,
  type GameConfig,
} from './gameConfig';
import { findOutputCollisions, perFileOutputPath } from '../common/buildPlan';
import { installedLibraries, withoutLibraries } from '../common/libraryConfig';
import { findLocationConflicts, locationConflictMessage } from '../common/locationConflicts';
import { joinSources, normalizeText } from '../common/projectFiles';
import * as logger from './logger';
import { findProjectFiles } from './projectExclude';

// UTF-8 BOM — matches what txt2gam CLI emits and what the server's
// decodeBuffer recognises at highest priority.
const UTF8_BOM = '\uFEFF';

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Read a file URI as text.
 *
 * Prefers the currently open editor's buffer (unsaved edits are
 * included) then falls back to `vscode.workspace.fs` for disk files.
 * Decoding of the raw bytes is done via txt2gam's BOM-aware parseText
 * so that UTF-16 and CP1251 files are handled correctly.
 */
export async function readFileAsText(
  uri: vscode.Uri,
  context: vscode.ExtensionContext,
): Promise<string> {
  // Prefer open editor buffer (may have unsaved changes)
  const openDoc = vscode.workspace.textDocuments.find(
    d => d.uri.toString() === uri.toString(),
  );
  if (openDoc) return openDoc.getText();

  const bytes = await vscode.workspace.fs.readFile(uri);
  const text  = await parseTextBytes(context.extensionUri, bytes, true);
  if (text === null) throw new Error(`Failed to decode file: ${uri.fsPath}`);
  return text;
}

/**
 * Collect all QSP source URIs for the project and sort them
 * alphabetically by their full string form (which sorts by path on
 * all platforms).  The sort order determines the location order in the
 * combined output, and therefore which location the QSP engine runs
 * first (it always starts at the first location).
 */
export async function collectProjectUris(glob: string): Promise<vscode.Uri[]> {
  const uris = await findProjectFiles(glob);
  uris.sort((a, b) => a.toString().localeCompare(b.toString()));
  return uris;
}

/**
 * Combine multiple .qsps files into a single text source (see
 * `joinSources` for the separators).
 */
export async function combineFiles(
  uris: vscode.Uri[],
  context: vscode.ExtensionContext,
): Promise<string> {
  const texts: string[] = [];
  for (const uri of uris) texts.push(await readFileAsText(uri, context));
  return joinSources(texts);
}

/**
 * The folder of the .qsp the player starts: the output file's in `single`
 * mode, the main source's (`mainUri`) in `perFile` mode. Libraries are
 * built into `libs/` there: `inclib` takes a path relative to the game.
 */
export function gameFolderUri(gameCfg: GameConfig, mainUri: vscode.Uri | undefined): vscode.Uri {
  const game = effectiveBuildMode(gameCfg) === 'single' || !mainUri ? resolveOutputUri(gameCfg) : mainUri;
  return vscode.Uri.joinPath(game, '..');
}

/** {@link gameFolderUri} for the project as it stands, without building it. */
export async function currentGameFolderUri(gameCfg: GameConfig, glob: string): Promise<vscode.Uri> {
  const uris = withoutLibraries(await orderedProjectUris(gameCfg, glob),
    u => vscode.workspace.asRelativePath(u, false), installedLibraries(gameCfg.libraries));
  return gameFolderUri(gameCfg, uris[0]);
}

/**
 * Build the project's .qsp file(s) according to its build mode and write
 * the ones whose content changed. The main file (`mainFile` pattern) is
 * moved to the front first. Returns every output file in that order,
 * written or already up to date, so the first one is
 * the game the player should start; an empty array means there were no
 * source files. Throws with a user-facing message on failure, before
 * anything is written: every file is encoded first so one bad file can't
 * leave a mix of fresh and stale .qsp modules behind.
 */
export async function buildProjectGame(
  context: vscode.ExtensionContext,
  gameCfg: GameConfig,
  glob: string,
  password: string | undefined,
): Promise<vscode.Uri[]> {
  // Installed libraries are built into .qsp files of their own, whatever
  // the `files` list says: the game loads them with `inclib`.
  const libraries = installedLibraries(gameCfg.libraries);
  const uris = withoutLibraries(
    await orderedProjectUris(gameCfg, glob), u => vscode.workspace.asRelativePath(u, false), libraries);
  if (uris.length === 0) return [];
  const mode = effectiveBuildMode(gameCfg);
  logger.log(`[Build] ${uris.length} source file(s), ${libraries.length} librar${libraries.length === 1 ? 'y' : 'ies'}, build mode: ${mode}, main file: ${vscode.workspace.asRelativePath(uris[0])}`);

  const texts: string[] = [];
  for (const uri of uris) texts.push(await readFileAsText(uri, context));
  const root = workspaceRoot();
  const libraryTexts: string[] = [];
  for (const lib of libraries) {
    try {
      libraryTexts.push(await readFileAsText(vscode.Uri.joinPath(root!, lib.sourcePath), context));
    } catch {
      throw new Error(`The library "${lib.id}" is listed in txt2gam.json, but ${lib.sourcePath} can't be read. `
        + 'Install it again from the QSP Libraries view, or remove it there.');
    }
  }
  const conflicts = locationConflictMessage(findLocationConflicts([
    ...uris.map((uri, i) => ({ relPath: vscode.workspace.asRelativePath(uri), text: normalizeText(texts[i]) })),
    ...libraries.map((lib, i) => ({ relPath: lib.sourcePath, text: normalizeText(libraryTexts[i]) })),
  ]));
  if (conflicts) throw new Error(conflicts);

  const outputs: { uri: vscode.Uri; bytes: Uint8Array }[] = [];
  const gameFolder = gameFolderUri(gameCfg, uris[0]);
  if (mode === 'single') {
    outputs.push({
      uri: resolveOutputUri(gameCfg),
      bytes: await encodeTextToGame(context.extensionUri, joinSources(texts), { password }),
    });
  } else {
    const byPath = new Map(uris.map(u => [u.path, u]));
    const collisions = findOutputCollisions([...byPath.keys()]);
    if (collisions.length > 0) {
      const list = collisions.map(c => {
        const sources = c.sources.map(s => vscode.workspace.asRelativePath(byPath.get(s)!)).join(' + ');
        const output = vscode.workspace.asRelativePath(byPath.get(c.sources[0])!.with({ path: c.output }));
        return `${sources} → ${output}`;
      }).join('; ');
      throw new Error(`Several source files would be built into the same .qsp: ${list}`);
    }
    for (const [i, uri] of uris.entries()) {
      const rel = vscode.workspace.asRelativePath(uri);
      try {
        const text = normalizeText(texts[i]);
        outputs.push({
          uri: uri.with({ path: perFileOutputPath(uri.path) }),
          bytes: await encodeTextToGame(context.extensionUri, text, { password }),
        });
      } catch (err) {
        throw new Error(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  for (const [i, lib] of libraries.entries()) {
    try {
      outputs.push({
        uri: vscode.Uri.joinPath(gameFolder, lib.outputPath),
        bytes: await encodeTextToGame(context.extensionUri, normalizeText(libraryTexts[i]), { password }),
      });
    } catch (err) {
      throw new Error(`${lib.sourcePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // txt2gam output is deterministic for the same text and password, so a
  // file whose bytes already match the new build is left untouched (its
  // mtime too). Comparing bytes rather than timestamps stays correct after
  // a password change and for unsaved editor buffers.
  for (const { uri, bytes } of outputs) {
    const rel = vscode.workspace.asRelativePath(uri);
    const onDisk = await compareWithDisk(uri, bytes);
    if (onDisk === 'same') {
      logger.log(`[Build] Unchanged: ${rel}`);
      continue;
    }
    await vscode.workspace.fs.writeFile(uri, bytes);
    logger.log(`[Build] Written (${onDisk}): ${rel} (${Math.round(bytes.byteLength / 1024)}kb)`);
  }
  return outputs.map(o => o.uri);
}

async function compareWithDisk(uri: vscode.Uri, bytes: Uint8Array): Promise<'same' | 'changed' | 'new'> {
  let existing: Uint8Array;
  try {
    existing = await vscode.workspace.fs.readFile(uri);
  } catch {
    return 'new';
  }
  if (existing.byteLength !== bytes.byteLength) return 'changed';
  for (let i = 0; i < bytes.byteLength; i++) {
    if (existing[i] !== bytes[i]) return 'changed';
  }
  return 'same';
}

export { normalizeText };

/** Return the workspace name or a fallback. */
function workspaceName(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) return folders[0].name;
  return 'game';
}

// ── qsp.combineProject ────────────────────────────────────────────────

export async function combineProjectCommand(
  context: vscode.ExtensionContext,
): Promise<void> {
  logger.show();
  logger.log('[Combine] Starting combine project...');
  const projectEnabled = vscode.workspace
    .getConfiguration('qsp')
    .get<boolean>('project.enabled', true);

  let combinedText: string;
  let suggestName: string;

  if (projectEnabled) {
    const glob = qspGlob(context);
    const cfg = await readGameConfig();
    const uris = await collectOrderedUris(cfg, glob);
    if (uris.length === 0) {
      vscode.window.showWarningMessage('No QSP source files found in the workspace.');
      return;
    }
    logger.log(`[Combine] Found ${uris.length} source file(s)`);
    combinedText = await combineFiles(uris, context);
    suggestName  = workspaceName() + '.qsps';
  } else {
    const editor = getActiveQspEditor();
    if (!editor) return;
    combinedText = normalizeText(editor.document.getText());
    suggestName = 'combined.qsps';
  }

  const folders = vscode.workspace.workspaceFolders;
  const defaultUri = folders && folders.length > 0
    ? vscode.Uri.joinPath(folders[0].uri, suggestName)
    : vscode.Uri.file(suggestName);

  const saveUri = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { 'QSP source': ['qsps', 'qsrc'] },
    title: 'Save combined .qsps file',
  });
  if (!saveUri) return;

  // Write UTF-8 with BOM
  const content = UTF8_BOM + combinedText;
  await vscode.workspace.fs.writeFile(saveUri, Buffer.from(content, 'utf8'));
  logger.log(`[Combine] Written: ${vscode.workspace.asRelativePath(saveUri)} (${Math.round(content.length / 1024)}kb)`);
  const doc = await vscode.workspace.openTextDocument(saveUri);
  await vscode.window.showTextDocument(doc);
}

// ── qsp.exportGame ────────────────────────────────────────────────────

export async function exportGameCommand(
  context: vscode.ExtensionContext,
): Promise<void> {
  logger.show();
  logger.log('[Export] Starting export...');
  const projectEnabled = vscode.workspace
    .getConfiguration('qsp')
    .get<boolean>('project.enabled', true);

  // Project mode builds through buildProjectGame; single-file mode encodes the active editor.
  let gameCfg: GameConfig | undefined;
  let sourceText = '';
  let saveUri: vscode.Uri | undefined;

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
    const defaultUri = vscode.Uri.joinPath(dirUri, baseName);
    const picked = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'QSP game': ['qsp'] },
      title: 'Export to game file',
    });
    if (!picked) return;
    saveUri = picked;
  }

  const cfg = vscode.workspace.getConfiguration('qsp.game');
  const cfgPassword = cfg.get<string>('password') || undefined;
  const promptPassword = cfg.get<boolean>('promptPassword', true);

  let password: string | undefined = cfgPassword;
  if (promptPassword) {
    const pw = await vscode.window.showInputBox({
      prompt: 'Enter the game password (leave empty for no password):',
      password: true,
      value: cfgPassword ?? '',
    });
    if (pw === undefined) return; // cancelled
    password = pw || undefined;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Exporting game…' },
    async () => {
      try {
        let written: vscode.Uri[];
        if (gameCfg) {
          written = await buildProjectGame(context, gameCfg, qspGlob(context), password);
          if (written.length === 0) {
            vscode.window.showWarningMessage('No QSP source files found in the workspace.');
            return;
          }
        } else {
          const gameBytes = await encodeTextToGame(context.extensionUri, sourceText, { password });
          await vscode.workspace.fs.writeFile(saveUri!, gameBytes);
          logger.log(`[Export] Written: ${vscode.workspace.asRelativePath(saveUri!)} (${Math.round(gameBytes.byteLength / 1024)}kb)`);
          written = [saveUri!];
        }
        vscode.window.showInformationMessage(written.length === 1
          ? `Exported to ${vscode.workspace.asRelativePath(written[0])}`
          : `Exported ${written.length} files`);
      } catch (err) {
        logger.log(`[Export] Failed: ${err instanceof Error ? err.message : String(err)}`);
        vscode.window.showErrorMessage(
          `Export failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}

// ── qsp.importGame ────────────────────────────────────────────────────

export async function importGameCommand(
  context: vscode.ExtensionContext,
  /** URI from explorer context-menu — undefined when invoked from palette. */
  clickedUri?: vscode.Uri,
): Promise<void> {
  logger.show();
  logger.log('[Import] Starting import...');
  let gameUri = clickedUri;
  if (!gameUri) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { 'QSP game': ['qsp'] },
      title: 'Select .qsp file to decode',
    });
    if (!picked || picked.length === 0) return;
    gameUri = picked[0];
  }

  const gameBytes = await vscode.workspace.fs.readFile(gameUri);
  logger.log(`[Import] Decoding: ${vscode.workspace.asRelativePath(gameUri)} (${Math.round(gameBytes.byteLength / 1024)}kb)`);
  /**
   * Try to decode with the given password.
   * Returns the text on success, or re-throws T2gError for the caller to handle.
   */
  const tryDecode = (password: string | undefined): Promise<string> =>
    decodeGameToText(context.extensionUri, gameBytes, { password });

  /**
   * Prompt the user for a password and try decoding.
   * Returns the text, or undefined if the user cancelled or the password was wrong again.
   */
  const promptAndDecode = async (message: string): Promise<string | undefined> => {
    const pw = await vscode.window.showInputBox({
      prompt: message,
      password: true,
      placeHolder: 'Leave empty for no password',
    });
    if (pw === undefined) return undefined; // cancelled
    try {
      return await tryDecode(pw || undefined);
    } catch (err) {
      const msg = isT2gError(err, T2gErrorCode.WRONG_PASSWORD)
        ? 'The password is incorrect.'
        : `Failed to import game: ${err instanceof Error ? err.message : String(err)}`;
      logger.log(`[Import] Failed: ${msg}`);
      vscode.window.showErrorMessage(msg);
      return undefined;
    }
  };

  const cfgPassword = vscode.workspace.getConfiguration('qsp.game').get<string>('password') || undefined;

  let text: string | undefined;
  try {
    // First attempt: configured password (or default).
    text = await tryDecode(cfgPassword);
  } catch (err) {
    if (!isT2gError(err, T2gErrorCode.WRONG_PASSWORD)) {
      const msg = `Failed to import game: ${err instanceof Error ? err.message : String(err)}`;
      logger.log(`[Import] Failed: ${msg}`);
      vscode.window.showErrorMessage(msg);
      return;
    }
    // Wrong password — always prompt the user.
    text = await promptAndDecode('The game file is password-protected. Enter the password:');
    if (text === undefined) return;
  }

  // Suggest saving next to the source .qsp
  const fileName = gameUri.path.split('/').pop()!.replace(/\.qsp$/i, '') + '.qsps';
  const defaultUri = vscode.Uri.joinPath(gameUri, '..', fileName);

  const saveUri = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { 'QSP source': ['qsps', 'qsrc'] },
    title: 'Save decoded .qsps file',
  });
  if (!saveUri) return;

  // Write UTF-8 with BOM
  const content = UTF8_BOM + normalizeText(text);
  await vscode.workspace.fs.writeFile(saveUri, Buffer.from(content, 'utf8'));
  logger.log(`[Import] Saved: ${vscode.workspace.asRelativePath(saveUri)}`);

  const doc = await vscode.workspace.openTextDocument(saveUri);
  await vscode.window.showTextDocument(doc);
}
