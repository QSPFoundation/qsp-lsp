/**
 * Pure builders for `textDocument/codeAction` edits.
 *
 * All functions are stateless: they take a `TextDocument` (read-only)
 * and the user's selection / cursor and return a `WorkspaceEdit`.
 * No closures over server state, no LSP connection access.  This makes
 * them easy to unit-test and easy to reuse from quick-fix paths.
 */
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  Range,
  TextEdit,
  WorkspaceEdit,
} from 'vscode-languageserver';
import { buildBlockReplacement } from './helpers';

/** Detect a document's line-ending convention by inspecting its first newline. */
export function detectEol(doc: TextDocument): string {
  const text = doc.getText();
  const idx = text.indexOf('\n');
  return idx > 0 && text[idx - 1] === '\r' ? '\r\n' : '\n';
}

/**
 * Replace `range` with `gosub 'extracted'` and append a new
 * `# extracted` location at the end of the document containing `body`.
 */
export function buildExtractToLocationEdit(
  doc: TextDocument,
  range: Range,
  body: string,
): WorkspaceEdit {
  const newLocName = 'extracted';
  const firstLine = doc.getText({
    start: { line: range.start.line, character: 0 },
    end: { line: range.start.line, character: Number.MAX_SAFE_INTEGER },
  });
  const indent = firstLine.match(/^(\s*)/)?.[1] ?? '';
  const replacement = `${indent}gosub '${newLocName}'`;
  const eol = detectEol(doc);
  const lastLine = doc.lineCount - 1;
  const lastLineText = doc.getText({
    start: { line: lastLine, character: 0 },
    end: { line: lastLine, character: Number.MAX_SAFE_INTEGER },
  });
  const newLocation = `${eol}${eol}# ${newLocName}${eol}${body}${eol}---`;
  return {
    changes: {
      [doc.uri]: [
        TextEdit.replace(range, replacement),
        TextEdit.insert({ line: lastLine, character: lastLineText.length }, newLocation),
      ],
    },
  };
}

/**
 * Wrap `selectedText` in a block construct (`act`/`if`/`loop`) at the
 * indentation level of `range.start`.
 */
export function buildWrapEdit(
  doc: TextDocument,
  range: Range,
  keyword: string,
  selectedText: string,
): WorkspaceEdit {
  const firstLine = doc.getText({
    start: { line: range.start.line, character: 0 },
    end: { line: range.start.line, character: Number.MAX_SAFE_INTEGER },
  });
  const indent = firstLine.match(/^(\s*)/)?.[1] ?? '';
  const innerIndent = indent + '  ';
  const eol = detectEol(doc);
  const lines = selectedText.split(/\r?\n/);
  const reindented = lines
    .map(l => l.trim() === '' ? '' : innerIndent + l.trimStart())
    .join(eol);

  let wrapped: string;
  switch (keyword) {
    case 'act':
      wrapped = `${indent}act 'action':${eol}${reindented}${eol}${indent}end`;
      break;
    case 'if':
      wrapped = `${indent}if 1:${eol}${reindented}${eol}${indent}end`;
      break;
    case 'loop':
      wrapped = `${indent}loop while 1:${eol}${reindented}${eol}${indent}end`;
      break;
    default:
      wrapped = selectedText;
  }

  return {
    changes: {
      [doc.uri]: [TextEdit.replace(range, wrapped)],
    },
  };
}

/**
 * Heuristically detect whether the line `lineNum` in `doc` opens a block
 * construct that already has a matching `end` somewhere within the next
 * `maxLine` lines.  Used to gate the inline→block code action.
 */
export function isBlockKeywordLine(doc: TextDocument, lineNum: number, maxLine: number): boolean {
  const endLine = Math.min(doc.lineCount - 1, maxLine);
  const chunk = doc.getText({
    start: { line: lineNum, character: 0 },
    end: { line: endLine, character: Number.MAX_SAFE_INTEGER },
  });
  const lines = chunk.split(/\r?\n/);
  const baseLine = lines[0];
  const baseIndent = baseLine.length - baseLine.trimStart().length;

  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t === '') continue;
    const indent = lines[i].length - t.length;
    if (/^end\b/i.test(t) && indent <= baseIndent) return true;
    if (/^(#|--)/.test(t)) return false;
  }
  return false;
}

/**
 * Convert an inline `if cond: body` / `act 'name': body` / etc. on
 * `lineNum` into a multi-line block form.  Returns `null` when the
 * line is not a recognised inline construct.
 */
export function buildInlineToBlockEdit(
  doc: TextDocument,
  lineNum: number,
  lineText: string,
): WorkspaceEdit | null {
  const eol = detectEol(doc);
  const replacement = buildBlockReplacement(lineText, eol);
  if (!replacement) return null;

  return {
    changes: {
      [doc.uri]: [TextEdit.replace(
        { start: { line: lineNum, character: 0 }, end: { line: lineNum, character: lineText.length } },
        replacement,
      )],
    },
  };
}
