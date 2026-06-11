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
  resolveOutputUri,
} from './gameConfig';

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
async function readFileAsText(
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
  const uris = await vscode.workspace.findFiles(glob);
  uris.sort((a, b) => a.toString().localeCompare(b.toString()));
  return uris;
}

/**
 * Combine multiple .qsps files into a single text source.
 *
 * Files are separated by a blank line so that the last `---` of one
 * file and the first `#` of the next are never on the same line.
 * Each file's content has a trailing newline guaranteed.
 */
export async function combineFiles(
  uris: vscode.Uri[],
  context: vscode.ExtensionContext,
): Promise<string> {
  const parts: string[] = [];
  for (const uri of uris) {
    let text = normalizeText(await readFileAsText(uri, context));
    // Ensure the file ends with a newline
    if (!text.endsWith('\n')) text += '\n';
    parts.push(text);
  }
  // Join with a blank line between files
  return parts.join('\n');
}

/** Strip BOM and normalise line endings to LF. */
export function normalizeText(text: string): string {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

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
  const doc = await vscode.workspace.openTextDocument(saveUri);
  await vscode.window.showTextDocument(doc);
}

// ── qsp.exportGame ────────────────────────────────────────────────────

export async function exportGameCommand(
  context: vscode.ExtensionContext,
): Promise<void> {
  const projectEnabled = vscode.workspace
    .getConfiguration('qsp')
    .get<boolean>('project.enabled', true);

  let sourceText: string;
  let saveUri: vscode.Uri;

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
    saveUri = resolveOutputUri(gameCfg);
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
        const gameBytes = await encodeTextToGame(context.extensionUri, sourceText, { password });
        await vscode.workspace.fs.writeFile(saveUri, gameBytes);
        vscode.window.showInformationMessage(
          `Exported to ${vscode.workspace.asRelativePath(saveUri)}`,
        );
      } catch (err) {
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
      vscode.window.showErrorMessage(
        `Failed to import game: ${err instanceof Error ? err.message : String(err)}`,
      );
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

  const doc = await vscode.workspace.openTextDocument(saveUri);
  await vscode.window.showTextDocument(doc);
}
