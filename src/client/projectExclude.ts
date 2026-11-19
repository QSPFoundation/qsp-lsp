// ── Files left out of the project, in the client ─────────────────────
//
// The build, the txt2gam.json wizard, Go to Location and the skeleton export
// find sources with `vscode.workspace.findFiles`, which knows nothing of
// `.qspignore`, `qsp.project.exclude` or the folders the language server
// skips. `findProjectFiles` leaves out the same files the server does
// (src/common/projectExclude.ts).

import * as vscode from 'vscode';
import { excludeMatcher, excludeRules, IGNORE_FILE_NAME, type ExcludeMatcher } from '../common/projectExclude';

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

/** Whether a file is left out of the project, by the rules of its workspace folder as they are now. */
export async function projectExcluder(): Promise<(uri: vscode.Uri) => boolean> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const matchers = new Map<string, ExcludeMatcher>(await Promise.all(folders.map(async folder => {
    const text = await readText(vscode.Uri.joinPath(folder.uri, IGNORE_FILE_NAME));
    const setting = vscode.workspace.getConfiguration('qsp', folder.uri).get<unknown[]>('project.exclude');
    return [folder.uri.toString(), excludeMatcher(excludeRules(text, setting))] as const;
  })));
  return uri => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const matcher = folder && matchers.get(folder.uri.toString());
    if (!folder || !matcher) return false;
    return matcher.file(uri.path.slice(folder.uri.path.replace(/\/+$/, '').length + 1));
  };
}

/** `vscode.workspace.findFiles(include)` without the files the project leaves out. */
export async function findProjectFiles(include: vscode.GlobPattern): Promise<vscode.Uri[]> {
  const [uris, excluded] = await Promise.all([vscode.workspace.findFiles(include), projectExcluder()]);
  return uris.filter(uri => !excluded(uri));
}
