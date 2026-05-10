/**
 * QSP Language Client — shared extension features.
 *
 * Provides VS Code-side commands and UI on top of the LSP:
 * - Status bar showing current location name
 * - "Go to Location" quick-pick command
 * - "New Location" command
 * - List / move / split multi-file commands
 * - Delegates simple location-editing to ./locationCommands.ts
 */
import * as vscode from 'vscode';
import type { BaseLanguageClient } from 'vscode-languageclient';
import {
  getActiveQspEditor,
  getCurrentLocationBlock,
} from './shared';

import {
  insertSeparatorCommand,
  sortLocationsCommand,
  duplicateLocationCommand,
  deleteLocationCommand,
  renameLocationCommand,
  moveLocationCommand,
  toggleCommentCommand,
  formatLocationCommand,
} from './locationCommands';

let statusBarItem: vscode.StatusBarItem;
let locBoundaryDecoration: vscode.TextEditorDecorationType;
let qspFileGlob: string;
let lspClient: BaseLanguageClient;

/**
 * Register extension-side features. Called from activate() in each entry point.
 */
export function registerExtensionFeatures(
  context: vscode.ExtensionContext,
  client: BaseLanguageClient,
): void {
  lspClient = client;

  // ── QSP file glob from language contribution ────────────────────────
  const langDef = context.extension.packageJSON?.contributes?.languages
    ?.find((l: { id: string }) => l.id === 'qsp');
  const exts: string[] = langDef?.extensions ?? ['.qsps', '.qsrc'];
  const bareExts = exts.map(e => e.replace(/^\./, ''));
  qspFileGlob = bareExts.length === 1
    ? `**/*.${bareExts[0]}`
    : `**/*.{${bareExts.join(',')}}`;

  // ── Status bar: current location ────────────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.command = 'qsp.goToLocation';
  statusBarItem.tooltip = 'Current QSP location (click to jump)';
  context.subscriptions.push(statusBarItem);

  locBoundaryDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightTextBackground'),
  });
  context.subscriptions.push(locBoundaryDecoration);

  // Update status bar + location boundary decorations on cursor/editor change
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateEditorState),
    vscode.window.onDidChangeTextEditorSelection(updateEditorState),
  );
  updateEditorState();

  // ── Commands ────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('qsp.goToLocation', goToLocationCommand),
    vscode.commands.registerCommand('qsp.newLocation', newLocationCommand),
    vscode.commands.registerCommand('qsp.insertSeparator', insertSeparatorCommand),
    vscode.commands.registerCommand('qsp.sortLocations', () => sortLocationsCommand('asc')),
    vscode.commands.registerCommand('qsp.sortLocationsDesc', () => sortLocationsCommand('desc')),
    vscode.commands.registerCommand('qsp.duplicateLocation', duplicateLocationCommand),
    vscode.commands.registerCommand('qsp.deleteLocation', deleteLocationCommand),
    vscode.commands.registerCommand('qsp.renameLocation', renameLocationCommand),
    vscode.commands.registerCommand('qsp.moveLocationUp', () => moveLocationCommand('up')),
    vscode.commands.registerCommand('qsp.moveLocationDown', () => moveLocationCommand('down')),
    vscode.commands.registerCommand('qsp.toggleComment', toggleCommentCommand),
    vscode.commands.registerCommand('qsp.formatLocation', formatLocationCommand),
    vscode.commands.registerCommand('qsp.listLocations', listLocationsCommand),
    vscode.commands.registerCommand('qsp.listObjects', listObjectsCommand),
    vscode.commands.registerCommand('qsp.listVariables', listVariablesCommand),
    vscode.commands.registerCommand('qsp.moveLocationsToFile', moveLocationsToFileCommand),
    vscode.commands.registerCommand('qsp.splitLocationsToFiles', splitLocationsToFilesCommand),
  );
}

// ──────────────────────────────────────────────────────────────────────
// Status bar
// ──────────────────────────────────────────────────────────────────────

function updateEditorState(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'qsp') {
    statusBarItem.hide();
    return;
  }

  const cursorLine = editor.selection.active.line;
  const { current } = getCurrentLocationBlock(editor.document, cursorLine);

  if (current) {
    statusBarItem.text = `$(symbol-namespace) ${current.name}`;
    statusBarItem.show();
  } else {
    statusBarItem.text = '$(symbol-namespace) (no location)';
    statusBarItem.show();
  }

  // ── Location header ↔ end separator highlighting ───────────────────
  const decorations: vscode.DecorationOptions[] = [];
  if (current && (cursorLine === current.startLine || cursorLine === current.endLine)) {
    decorations.push({ range: editor.document.lineAt(current.startLine).range });
    decorations.push({ range: editor.document.lineAt(current.endLine).range });
  }
  editor.setDecorations(locBoundaryDecoration, decorations);
}

// ──────────────────────────────────────────────────────────────────────
// Go to Location — quick pick
// ──────────────────────────────────────────────────────────────────────

async function goToLocationCommand(): Promise<void> {
  const editor = getActiveQspEditor();
  if (!editor) return;

  const projectEnabled = vscode.workspace.getConfiguration('qsp').get<boolean>('project.enabled', true);

  interface LocItem extends vscode.QuickPickItem {
    uri: vscode.Uri;
    range: vscode.Range;
  }

  const items: LocItem[] = [];

  if (projectEnabled) {
    const uris = await vscode.workspace.findFiles(qspFileGlob);
    const results = await Promise.all(
      uris.map(async (uri) => {
        const syms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider', uri,
        );
        return { uri, syms: syms ?? [] };
      }),
    );
    for (const { uri, syms } of results) {
      const relativePath = vscode.workspace.asRelativePath(uri, false);
      for (const sym of syms) {
        items.push({
          label: sym.name,
          description: `${relativePath}:${sym.range.start.line + 1}`,
          uri,
          range: sym.selectionRange,
        });
      }
    }
  } else {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      editor.document.uri,
    );
    for (const sym of symbols ?? []) {
      items.push({
        label: sym.name,
        description: `Line ${sym.range.start.line + 1}`,
        uri: editor.document.uri,
        range: sym.selectionRange,
      });
    }
  }

  if (items.length === 0) {
    vscode.window.showInformationMessage('No locations found');
    return;
  }

  items.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Go to location…',
    matchOnDescription: true,
  });

  if (picked) {
    const doc = await vscode.workspace.openTextDocument(picked.uri);
    const target = await vscode.window.showTextDocument(doc);
    target.selection = new vscode.Selection(picked.range.start, picked.range.start);
    target.revealRange(picked.range, vscode.TextEditorRevealType.InCenter);
  }
}

// ──────────────────────────────────────────────────────────────────────
// New Location
// ──────────────────────────────────────────────────────────────────────

async function newLocationCommand(): Promise<void> {
  const editor = getActiveQspEditor();
  if (!editor) return;

  const name = await vscode.window.showInputBox({
    prompt: 'Location name',
    placeHolder: 'my_location',
    validateInput: (v) => (v.trim() ? null : 'Name cannot be empty'),
  });

  if (!name) return;

  const doc = editor.document;
  const lastLine = doc.lineCount - 1;
  const lastLineText = doc.lineAt(lastLine).text;

  const snippet = new vscode.SnippetString();
  if (lastLineText.trim() !== '') {
    snippet.appendText('\n');
  }
  snippet.appendText('\n');
  snippet.appendText(`# ${name}\n`);
  snippet.appendTabstop(0);
  snippet.appendText('\n---\n');

  const endPos = new vscode.Position(lastLine, lastLineText.length);
  editor.insertSnippet(snippet, endPos);
}

// ──────────────────────────────────────────────────────────────────────
// Navigate helper — open file and jump to line
// ──────────────────────────────────────────────────────────────────────

async function navigateTo(uri: vscode.Uri, line: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const ed = await vscode.window.showTextDocument(doc);
  const pos = new vscode.Position(line, 0);
  ed.selection = new vscode.Selection(pos, pos);
  ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

/**
 * Resolve the list of QSP file URIs from explorer context-menu arguments.
 *
 * VS Code explorer passes `(clickedUri, allSelectedUris)`.  When invoked
 * from the command palette both are undefined — fall back to the active editor.
 * Returns undefined when no files can be resolved.
 */
function resolveSourceUris(
  clickedUri?: vscode.Uri,
  selectedUris?: vscode.Uri[],
): vscode.Uri[] | undefined {
  if (selectedUris && selectedUris.length > 0) return selectedUris;
  if (clickedUri) return [clickedUri];
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === 'qsp') return [editor.document.uri];
  vscode.window.showWarningMessage('Open a QSP file first');
  return undefined;
}

// ── Shared location-pick type & parser ────────────────────────────────

interface LocationPick extends vscode.QuickPickItem {
  block: import('../common/locations').LocationBlock;
  sourceUri: vscode.Uri;
  gapBefore: string;
  indexInFile: number;
}

interface FileMetadata {
  blockCount: number;
  trailing: string;
}

/**
 * Parse locations from a list of URIs into quick-pick items.
 */
async function parseLocationPicks(uris: vscode.Uri[]): Promise<{
  picks: LocationPick[];
  files: Map<string, FileMetadata>;
}> {
  const { parseLocationBlocks, computeLocationGaps } = await import('../common/locations');
  const picks: LocationPick[] = [];
  const files = new Map<string, FileMetadata>();
  const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
  const cursorLine = vscode.window.activeTextEditor?.selection.active.line ?? -1;

  for (const uri of uris) {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      const blocks = parseLocationBlocks(text);
      const { gapsBefore, trailing } = computeLocationGaps(text, blocks);
      const relativePath = vscode.workspace.asRelativePath(uri, false);
      const isActive = uri.toString() === activeUri;

      files.set(uri.toString(), { blockCount: blocks.length, trailing });

      for (let i = 0; i < blocks.length; i++) {
        picks.push({
          label: blocks[i].name,
          description: `${relativePath}:${blocks[i].startLine + 1}`,
          block: blocks[i],
          sourceUri: uri,
          gapBefore: gapsBefore[i],
          indexInFile: i,
          picked: isActive && cursorLine >= blocks[i].startLine && cursorLine <= blocks[i].endLine,
        });
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return { picks, files };
}

/**
 * Delete selected location picks from their source files.
 */
async function deleteLocationPicks(
  selected: readonly LocationPick[],
  skipUri?: string,
): Promise<void> {
  const { removeSelectedLocations } = await import('../common/locations');
  // Group selected picks by source file
  const bySource = new Map<string, { uri: vscode.Uri; indices: Set<number> }>();
  for (const sel of selected) {
    const key = sel.sourceUri.toString();
    if (key === skipUri) continue;
    let entry = bySource.get(key);
    if (!entry) {
      entry = { uri: sel.sourceUri, indices: new Set() };
      bySource.set(key, entry);
    }
    entry.indices.add(sel.indexInFile);
  }

  const wsEdit = new vscode.WorkspaceEdit();
  for (const { uri, indices } of bySource.values()) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const newText = removeSelectedLocations(doc.getText(), indices);
    wsEdit.replace(uri, fullDocRange(doc), newText);
  }
  if (wsEdit.size > 0) await vscode.workspace.applyEdit(wsEdit);
}

/** Full-document range for replace-all edits. */
function fullDocRange(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(
    new vscode.Position(0, 0),
    doc.lineAt(doc.lineCount - 1).range.end,
  );
}

// ── Navigable list with clipboard support ─────────────────────────────

interface NavigablePick extends vscode.QuickPickItem {
  targetUri: vscode.Uri;
  targetLine: number;
}

function showNavigableList(
  items: NavigablePick[],
  placeHolder: string,
): Promise<void> {
  const copyAll: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('clippy'),
    tooltip: 'Copy all to clipboard',
  };
  const copyOne: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('copy'),
    tooltip: 'Copy to clipboard',
  };

  const formatItem = (item: NavigablePick) =>
    [item.label, item.description, item.detail].filter(Boolean).join('\t');

  for (const item of items) item.buttons = [copyOne];

  return new Promise<void>((resolve) => {
    const qp = vscode.window.createQuickPick<NavigablePick>();
    qp.items = items;
    qp.placeholder = placeHolder;
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.buttons = [copyAll];

    qp.onDidAccept(async () => {
      const [sel] = qp.selectedItems;
      qp.dispose();
      if (sel) await navigateTo(sel.targetUri, sel.targetLine);
      resolve();
    });

    qp.onDidTriggerButton(async (btn) => {
      if (btn === copyAll) {
        const visible = qp.value
          ? (qp.items as NavigablePick[]).filter(i => {
              const v = qp.value.toLowerCase();
              return i.label.toLowerCase().includes(v)
                || (i.description?.toLowerCase().includes(v) ?? false)
                || (i.detail?.toLowerCase().includes(v) ?? false);
            })
          : items;
        const text = visible.map(formatItem).join('\n');
        await vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage(`Copied ${visible.length} item(s) to clipboard`);
      }
    });

    qp.onDidTriggerItemButton(async (e) => {
      await vscode.env.clipboard.writeText(formatItem(e.item));
      vscode.window.showInformationMessage('Copied to clipboard');
    });

    qp.onDidHide(() => {
      qp.dispose();
      resolve();
    });

    qp.show();
  });
}

// ──────────────────────────────────────────────────────────────────────
// List Locations — server-powered list with navigation
// ──────────────────────────────────────────────────────────────────────

async function listLocationsCommand(): Promise<void> {
  const editor = getActiveQspEditor();
  if (!editor) return;

  type LocInfo = { name: string; uri: string; line: number; endLine: number };
  const items = await lspClient.sendRequest<LocInfo[]>('qsp/listLocations', {
    uri: editor.document.uri.toString(),
  });

  if (items.length === 0) {
    vscode.window.showInformationMessage('No locations found');
    return;
  }

  const picks: NavigablePick[] = items.map(item => {
    const uri = vscode.Uri.parse(item.uri);
    const lineCount = item.endLine - item.line + 1;
    return {
      label: item.name,
      description: `${lineCount} line${lineCount !== 1 ? 's' : ''}`,
      detail: `${vscode.workspace.asRelativePath(uri, false)}:${item.line + 1}`,
      targetUri: uri,
      targetLine: item.line,
    };
  });

  await showNavigableList(picks, `All locations (${picks.length})`);
}

// ──────────────────────────────────────────────────────────────────────
// List Objects
// ──────────────────────────────────────────────────────────────────────

async function listObjectsCommand(): Promise<void> {
  const editor = getActiveQspEditor();
  if (!editor) return;

  type ObjInfo = { name: string; uri: string; line: number; isDefined: boolean };
  const items = await lspClient.sendRequest<ObjInfo[]>('qsp/listObjects', {
    uri: editor.document.uri.toString(),
  });

  if (items.length === 0) {
    vscode.window.showInformationMessage('No objects found');
    return;
  }

  const picks: NavigablePick[] = items.map(item => {
    const uri = vscode.Uri.parse(item.uri);
    return {
      label: item.name,
      description: item.isDefined ? 'added' : 'referenced only',
      detail: `${vscode.workspace.asRelativePath(uri, false)}:${item.line + 1}`,
      targetUri: uri,
      targetLine: item.line,
    };
  });

  await showNavigableList(picks, `All objects (${picks.length})`);
}

// ──────────────────────────────────────────────────────────────────────
// List Variables
// ──────────────────────────────────────────────────────────────────────

async function listVariablesCommand(): Promise<void> {
  const editor = getActiveQspEditor();
  if (!editor) return;

  type VarInfo = { name: string; uri: string; line: number; isDefined: boolean; isLocal: boolean; prefixes: string[] };
  const items = await lspClient.sendRequest<VarInfo[]>('qsp/listVariables', {
    uri: editor.document.uri.toString(),
  });

  if (items.length === 0) {
    vscode.window.showInformationMessage('No variables found');
    return;
  }

  const picks: NavigablePick[] = items.map(item => {
    const uri = vscode.Uri.parse(item.uri);
    const prefix = item.prefixes.length > 0
      ? item.prefixes.join(', ')
      : '';
    const scope = item.isLocal ? 'local' : 'global';
    const status = item.isDefined ? 'assigned' : 'used (never assigned)';
    return {
      label: item.name,
      description: `${scope} · ${status}${prefix ? ` · prefixes: ${prefix}` : ''}`,
      detail: `${vscode.workspace.asRelativePath(uri, false)}:${item.line + 1}`,
      targetUri: uri,
      targetLine: item.line,
    };
  });

  await showNavigableList(picks, `All variables (${picks.length})`);
}

// ──────────────────────────────────────────────────────────────────────
// Move Locations to File
// ──────────────────────────────────────────────────────────────────────

async function moveLocationsToFileCommand(
  clickedUri?: vscode.Uri,
  selectedUris?: vscode.Uri[],
): Promise<void> {
  const sourceUris = resolveSourceUris(clickedUri, selectedUris);
  if (!sourceUris) return;

  const { buildMoveTargetContent, sanitizeLocationName } = await import('../common/locations');

  const { picks, files } = await parseLocationPicks(sourceUris);

  if (picks.length === 0) {
    vscode.window.showInformationMessage('No locations found in the selected file(s)');
    return;
  }

  picks.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

  const selected = await vscode.window.showQuickPick(picks, {
    placeHolder: 'Select locations to move…',
    canPickMany: true,
    matchOnDescription: true,
  });
  if (!selected || selected.length === 0) return;

  const sourceDir = vscode.Uri.joinPath(sourceUris[0], '..');
  const defaultName = selected.length === 1
    ? sanitizeLocationName(selected[0].block.name, new Set()) + '.qsps'
    : 'moved.qsps';
  const targetUri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(sourceDir, defaultName),
    filters: { 'QSP Source': ['qsps', 'qsrc'] },
    title: 'Move locations to…',
  });
  if (!targetUri) return;

  const targetStr = targetUri.toString();

  let existingContent = '';
  try {
    const bytes = await vscode.workspace.fs.readFile(targetUri);
    existingContent = new TextDecoder().decode(bytes);
  } catch {
    // File doesn't exist yet — fine
  }

  let newContent = buildMoveTargetContent(
    selected.map(s => ({ content: s.block.content, gapBefore: s.gapBefore })),
    existingContent,
  );

  // Append trailing text from each source file whose last block is being moved
  const lastSelectedIndex = new Map<string, number>();
  for (const sel of selected) {
    const key = sel.sourceUri.toString();
    if (key === targetStr) continue;
    const prev = lastSelectedIndex.get(key);
    if (prev === undefined || sel.indexInFile > prev) {
      lastSelectedIndex.set(key, sel.indexInFile);
    }
  }
  for (const [key, maxIdx] of lastSelectedIndex) {
    const meta = files.get(key);
    if (meta && meta.trailing.trim() && maxIdx === meta.blockCount - 1) {
      newContent = newContent.trimEnd() + '\n' + meta.trailing.replace(/\r?\n$/, '') + '\n';
    }
  }

  await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(newContent));

  await deleteLocationPicks(selected, targetStr);

  const targetDoc = await vscode.workspace.openTextDocument(targetUri);
  await vscode.window.showTextDocument(targetDoc);

  vscode.window.showInformationMessage(
    `Moved ${selected.length} location(s) to ${vscode.workspace.asRelativePath(targetUri)}`,
  );
}

// ──────────────────────────────────────────────────────────────────────
// Split Locations into Files
// ──────────────────────────────────────────────────────────────────────

async function splitLocationsToFilesCommand(
  clickedUri?: vscode.Uri,
  selectedUris?: vscode.Uri[],
): Promise<void> {
  const sourceUris = resolveSourceUris(clickedUri, selectedUris);
  if (!sourceUris) return;

  const { buildSplitFileContent, sanitizeLocationName } = await import('../common/locations');

  const { picks, files } = await parseLocationPicks(sourceUris);

  if (picks.length === 0) {
    vscode.window.showInformationMessage('No locations found in the selected file(s)');
    return;
  }

  picks.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

  const selected = await vscode.window.showQuickPick(picks, {
    placeHolder: 'Select locations to split into files…',
    canPickMany: true,
    matchOnDescription: true,
  });
  if (!selected || selected.length === 0) return;

  const sourceDir = vscode.Uri.joinPath(sourceUris[0], '..');
  const folders = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: sourceDir,
    title: `Split ${selected.length} location(s) into folder…`,
  });
  if (!folders || folders.length === 0) return;
  const targetFolder = folders[0];

  const usedNames = new Set<string>();
  let created = 0;

  const lastSelectedIndex = new Map<string, number>();
  for (const sel of selected) {
    const key = sel.sourceUri.toString();
    const prev = lastSelectedIndex.get(key);
    if (prev === undefined || sel.indexInFile > prev) {
      lastSelectedIndex.set(key, sel.indexInFile);
    }
  }

  for (const sel of selected) {
    const ext = sel.sourceUri.path.endsWith('.qsrc') ? '.qsrc' : '.qsps';
    const safeName = sanitizeLocationName(sel.block.name, usedNames);

    const key = sel.sourceUri.toString();
    const meta = files.get(key)!;
    const isLastSelected = sel.indexInFile === lastSelectedIndex.get(key);
    const isLastInFile = sel.indexInFile === meta.blockCount - 1;
    const trailing = isLastSelected && isLastInFile ? meta.trailing : null;

    const content = buildSplitFileContent(sel.block.content, sel.gapBefore, trailing);

    const fileUri = vscode.Uri.joinPath(targetFolder, safeName + ext);
    await vscode.workspace.fs.writeFile(
      fileUri,
      new TextEncoder().encode(content),
    );
    created++;
  }

  await deleteLocationPicks(selected);

  vscode.window.showInformationMessage(
    `Split ${created} location(s) into ${vscode.workspace.asRelativePath(targetFolder)}/`,
  );
}
