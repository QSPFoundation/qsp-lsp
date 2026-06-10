/**
 * QSP Language Client — shared utilities.
 *
 * Thin wrappers used by both features.ts and locationCommands.ts
 * to avoid circular imports.
 */
import * as vscode from 'vscode';
import { parseLocationBlocks, type LocationBlock } from '../common/locations';

/** Return the active QSP editor, or undefined (with a warning). */
export function getActiveQspEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'qsp') {
    vscode.window.showWarningMessage('Open a QSP file first');
    return undefined;
  }
  return editor;
}

/** Detect EOL style from a TextDocument. */
export function getEol(doc: vscode.TextDocument): string {
  return doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

/** Full-document range for replace-all edits. */
export function fullDocRange(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(
    new vscode.Position(0, 0),
    doc.lineAt(doc.lineCount - 1).range.end,
  );
}

/**
 * Find the location block at the cursor position.
 * Returns the parsed blocks, the current block (if any), and its index.
 */
export function getCurrentLocationBlock(
  doc: vscode.TextDocument,
  cursorLine: number,
): { blocks: LocationBlock[]; current: LocationBlock | undefined; index: number } {
  const blocks = parseLocationBlocks(doc.getText());
  const index = blocks.findIndex(b => cursorLine >= b.startLine && cursorLine <= b.endLine);
  return { blocks, current: index >= 0 ? blocks[index] : undefined, index };
}

/**
 * Build the glob pattern that matches every QSP source file in the workspace,
 * derived from the extension's language contribution (so it stays in sync
 * with the `languages[].extensions` array in package.json).
 */
export function qspGlob(context: vscode.ExtensionContext): string {
  const langDef = context.extension.packageJSON?.contributes?.languages
    ?.find((l: { id: string }) => l.id === 'qsp');
  const exts: string[] = langDef?.extensions ?? ['.qsps', '.qsrc'];
  const bare = exts.map((e: string) => e.replace(/^\./, ''));
  return bare.length === 1 ? `**/*.${bare[0]}` : `**/*.{${bare.join(',')}}`;
}
