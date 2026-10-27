// ── Syntax version item ──────────────────────────────────────────────
//
// `QSP 5.9.5` at the bottom right while a QSP file is open: the library
// version the game is written for (`qsp.syntaxVersion`). Clicking it picks
// another; the server re-checks every file when the setting changes.

import * as vscode from 'vscode';
import {
  DEFAULT_SYNTAX_VERSION,
  SYNTAX_VERSIONS,
  SYNTAX_VERSION_LABELS,
  isSyntaxVersion,
  type SyntaxVersion,
} from '../common/syntaxVersion';

const DETAILS: Readonly<Record<SyntaxVersion, string>> = {
  '5.9.5': 'The last release (November 2025). Constructs of 5.9.6 are errors.',
  '5.9.6': 'The library in development: ?, INSVAR, ARRKEY, ALIAS, unary plus, COUNTOBJ with a name, '
    + 'variables without a prefix hold any type, \\ ; ^ @ ? end a name.',
};

function currentVersion(): SyntaxVersion {
  const v = vscode.workspace.getConfiguration('qsp').get('syntaxVersion');
  return isSyntaxVersion(v) ? v : DEFAULT_SYNTAX_VERSION;
}

/** Create the status bar item and the `qsp.selectSyntaxVersion` command. */
export function registerSyntaxVersion(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem('qsp.syntaxVersion', vscode.StatusBarAlignment.Right, 99);
  item.name = 'QSP Syntax Version';
  item.command = 'qsp.selectSyntaxVersion';

  const render = () => {
    const version = currentVersion();
    item.text = `QSP ${SYNTAX_VERSION_LABELS[version]}`;
    item.tooltip = `QSP syntax version: ${SYNTAX_VERSION_LABELS[version]}. Click to change.`;
    if (vscode.window.activeTextEditor?.document.languageId === 'qsp') item.show();
    else item.hide();
  };

  context.subscriptions.push(
    item,
    vscode.window.onDidChangeActiveTextEditor(render),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('qsp.syntaxVersion')) render();
    }),
    vscode.commands.registerCommand('qsp.selectSyntaxVersion', async () => {
      const current = currentVersion();
      const picked = await vscode.window.showQuickPick(
        SYNTAX_VERSIONS.map((version) => ({
          label: SYNTAX_VERSION_LABELS[version],
          description: version === current ? 'current' : undefined,
          detail: DETAILS[version],
          version,
        })),
        { title: 'QSP syntax version', placeHolder: 'The QSP library the game is written for' },
      );
      if (!picked || picked.version === current) return;
      // A game is written for one library, so the choice belongs to its
      // folder; with no folder open there is nowhere else to keep it.
      const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      await vscode.workspace.getConfiguration('qsp').update('syntaxVersion', picked.version, target);
    }),
  );
  render();
}
