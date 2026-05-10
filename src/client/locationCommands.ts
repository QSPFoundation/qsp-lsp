/**
 * QSP Language Client — location manipulation commands.
 *
 * Location-editing commands: insert separator, sort, duplicate, delete,
 * rename, move, toggle comment, format. These operate on the active
 * editor's text via the pure helpers from `../common/locations`.
 */
import * as vscode from 'vscode';
import {
  parseLocationBlocks,
  reorderLocations,
} from '../common/locations';
import {
  getActiveQspEditor,
  getEol,
  fullDocRange,
  getCurrentLocationBlock,
} from './shared';

// ──────────────────────────────────────────────────────────────────────
// Insert separator
// ──────────────────────────────────────────────────────────────────────

export async function insertSeparatorCommand(): Promise<void> {
  const editor = getActiveQspEditor();
  if (!editor) return;

  const pos = editor.selection.active;
  const line = editor.document.lineAt(pos.line);

  await editor.edit((editBuilder) => {
    editBuilder.insert(
      new vscode.Position(line.lineNumber, line.text.length),
      '\n---',
    );
  });
}

// ──────────────────────────────────────────────────────────────────────
// Sort Locations
// ──────────────────────────────────────────────────────────────────────

export async function sortLocationsCommand(direction: 'asc' | 'desc' = 'asc'): Promise<void> {
  const editor = getActiveQspEditor();
  if (!editor) return;

  const doc = editor.document;
  const text = doc.getText();

  const blocks = parseLocationBlocks(text);
  if (blocks.length <= 1) {
    vscode.window.showInformationMessage('Nothing to sort — 0 or 1 locations');
    return;
  }

  // Keep the first location in place (it's the entry point in QSP —
  // moving it would change the game's behaviour), sort the rest.
  const restIndices = Array.from({ length: blocks.length - 1 }, (_, i) => i + 1);
  restIndices.sort((a, b) => {
    const cmp = blocks[a].name.toLowerCase().localeCompare(blocks[b].name.toLowerCase());
    return direction === 'desc' ? -cmp : cmp;
  });
  const newOrder = [0, ...restIndices];

  const newText = reorderLocations(text, newOrder);

  if (newText === text) {
    vscode.window.showInformationMessage('Locations are already sorted');
    return;
  }

  await editor.edit((editBuilder) => {
    editBuilder.replace(fullDocRange(doc), newText);
  });

  vscode.window.showInformationMessage(
    `Sorted ${blocks.length} locations (kept '${blocks[0].name}' as entry point)`
  );
}

// ──────────────────────────────────────────────────────────────────────
// Duplicate Location
// ──────────────────────────────────────────────────────────────────────

export async function duplicateLocationCommand(): Promise<void> {
  const editor = getActiveQspEditor();
  if (!editor) return;

  const doc = editor.document;
  const { current } = getCurrentLocationBlock(doc, editor.selection.active.line);
  if (!current) {
    vscode.window.showWarningMessage('Cursor is not inside a location');
    return;
  }

  const newName = await vscode.window.showInputBox({
    prompt: 'Name for the duplicate location',
    value: current.name + '_copy',
    validateInput: (v) => (v.trim() ? null : 'Name cannot be empty'),
  });
  if (!newName) return;

  // Replace the location name in the content
  const newContent = current.content.replace(
    /^#\s*.+$/m,
    `# ${newName}`
  );

  // Insert after the current location
  const eol = getEol(doc);
  const insertPos = new vscode.Position(current.endLine, doc.lineAt(current.endLine).text.length);

  await editor.edit((editBuilder) => {
    editBuilder.insert(insertPos, eol + newContent);
  });
}

// ──────────────────────────────────────────────────────────────────────
// Delete Location
// ──────────────────────────────────────────────────────────────────────

export async function deleteLocationCommand(): Promise<void> {
  const editor = getActiveQspEditor();
  if (!editor) return;

  const doc = editor.document;
  const { current } = getCurrentLocationBlock(doc, editor.selection.active.line);
  if (!current) {
    vscode.window.showWarningMessage('Cursor is not inside a location');
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Delete location '${current.name}'?`,
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') return;

  // Delete from start of location to end (including trailing newline)
  const startPos = new vscode.Position(current.startLine, 0);
  const endLine = Math.min(current.endLine + 1, doc.lineCount - 1);
  const endPos = current.endLine + 1 < doc.lineCount
    ? new vscode.Position(endLine, 0)
    : doc.lineAt(doc.lineCount - 1).range.end;

  await editor.edit((editBuilder) => {
    editBuilder.delete(new vscode.Range(startPos, endPos));
  });
}

// ──────────────────────────────────────────────────────────────────────
// Rename Location (delegates to LSP rename provider)
// ──────────────────────────────────────────────────────────────────────

export async function renameLocationCommand(): Promise<void> {
  const editor = getActiveQspEditor();
  if (!editor) return;

  const doc = editor.document;
  const { current } = getCurrentLocationBlock(doc, editor.selection.active.line);
  if (!current) {
    vscode.window.showWarningMessage('Cursor is not inside a location');
    return;
  }

  const newName = await vscode.window.showInputBox({
    prompt: `Rename location '${current.name}' to:`,
    value: current.name,
    validateInput: (v) => (v.trim() ? null : 'Name cannot be empty'),
  });
  if (!newName || newName === current.name) return;

  // Use the LSP rename provider — it uses tree-sitter parsed data to
  // find only the location header + references in location-specific
  // statements (gosub, goto, func, etc.), not every matching string.
  const headerLine = doc.lineAt(current.startLine).text;
  const headerMatch = headerLine.match(/^#\s*/);
  const nameCol = headerMatch ? headerMatch[0].length : 2;
  const namePos = new vscode.Position(current.startLine, nameCol);

  const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
    'vscode.executeDocumentRenameProvider',
    doc.uri,
    namePos,
    newName,
  );

  if (edit && edit.size > 0) {
    await vscode.workspace.applyEdit(edit);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Move Location Up / Down
// ──────────────────────────────────────────────────────────────────────

export async function moveLocationCommand(direction: 'up' | 'down'): Promise<void> {
  const editor = getActiveQspEditor();
  if (!editor) return;

  const doc = editor.document;
  const text = doc.getText();

  const { blocks, index: idx } = getCurrentLocationBlock(doc, editor.selection.active.line);
  if (idx < 0) {
    vscode.window.showWarningMessage('Cursor is not inside a location');
    return;
  }

  // Cannot move the first location (entry point), and cannot swap with it
  if (idx === 0) {
    vscode.window.showInformationMessage(
      'The first location is the entry point and cannot be moved'
    );
    return;
  }

  const targetIdx = direction === 'up' ? idx - 1 : idx + 1;

  // Cannot swap up into position 0 (entry point stays pinned)
  if (targetIdx === 0) {
    vscode.window.showInformationMessage(
      'Cannot move above the first location (entry point)'
    );
    return;
  }

  if (targetIdx < 0 || targetIdx >= blocks.length) return;

  // Build new order: swap idx and targetIdx
  const newOrder = blocks.map((_, i) => i);
  [newOrder[idx], newOrder[targetIdx]] = [newOrder[targetIdx], newOrder[idx]];

  const newText = reorderLocations(text, newOrder);

  if (newText === text) return;

  await editor.edit((editBuilder) => {
    editBuilder.replace(fullDocRange(doc), newText);
  });

  // Move cursor to the new position of the moved location
  const newBlocks = parseLocationBlocks(newText);
  if (newBlocks[targetIdx]) {
    const newLine = newBlocks[targetIdx].startLine;
    const newPos = new vscode.Position(newLine, 0);
    editor.selection = new vscode.Selection(newPos, newPos);
    editor.revealRange(
      new vscode.Range(newPos, newPos),
      vscode.TextEditorRevealType.InCenter,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────
// Toggle Comment
// ──────────────────────────────────────────────────────────────────────

export async function toggleCommentCommand(): Promise<void> {
  const editor = getActiveQspEditor();
  if (!editor) return;

  const doc = editor.document;
  const selection = editor.selection;

  const startLine = selection.start.line;
  const endLine = selection.end.line;

  const edits: vscode.TextEdit[] = [];
  let allCommented = true;

  // Check if all lines in selection are already comments
  for (let i = startLine; i <= endLine; i++) {
    const trimmed = doc.lineAt(i).text.trimStart();
    if (trimmed !== '' && !trimmed.startsWith('!')) {
      allCommented = false;
      break;
    }
  }

  for (let i = startLine; i <= endLine; i++) {
    const lineText = doc.lineAt(i).text;

    if (allCommented) {
      // Uncomment: remove leading "! " or "!"
      const match = lineText.match(/^(\s*)!\s?(.*)$/);
      if (match) {
        edits.push(vscode.TextEdit.replace(
          new vscode.Range(i, 0, i, lineText.length),
          match[1] + match[2],
        ));
      }
    } else {
      // Comment: add "! " after leading whitespace
      if (lineText.trim() === '') continue; // skip blank lines
      const indent = lineText.match(/^(\s*)/)?.[1] ?? '';
      const rest = lineText.slice(indent.length);
      edits.push(vscode.TextEdit.replace(
        new vscode.Range(i, 0, i, lineText.length),
        indent + '! ' + rest,
      ));
    }
  }

  if (edits.length > 0) {
    const edit = new vscode.WorkspaceEdit();
    edit.set(doc.uri, edits);
    await vscode.workspace.applyEdit(edit);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Format Location — format the location block under the cursor
// ──────────────────────────────────────────────────────────────────────

export async function formatLocationCommand(): Promise<void> {
  const editor = getActiveQspEditor();
  if (!editor) return;

  const doc = editor.document;
  const cursorLine = editor.selection.active.line;
  const { current } = getCurrentLocationBlock(doc, cursorLine);

  if (!current) {
    vscode.window.showWarningMessage('Cursor is not inside a QSP location');
    return;
  }

  // Select the full location range and ask VS Code to format that selection.
  // This delegates to our server-side onDocumentRangeFormatting handler.
  const range = new vscode.Range(
    new vscode.Position(current.startLine, 0),
    new vscode.Position(current.endLine, doc.lineAt(current.endLine).text.length),
  );

  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    'vscode.executeFormatRangeProvider',
    doc.uri,
    range,
    {
      tabSize: editor.options.tabSize as number,
      insertSpaces: editor.options.insertSpaces as boolean,
    },
  );

  if (edits && edits.length > 0) {
    const wsEdit = new vscode.WorkspaceEdit();
    wsEdit.set(doc.uri, edits);
    await vscode.workspace.applyEdit(wsEdit);
  }
}
