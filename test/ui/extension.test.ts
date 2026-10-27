// UI tests: run inside a real VS Code (npm run test:ui, see .vscode-test.mjs)
// against a copy of test/ui/fixture. Unlike the Vitest suites, they cover
// the client, the language client wiring and the bundled server together.

import * as assert from 'node:assert';
import * as cp from 'node:child_process';
import { createHash } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as vscode from 'vscode';

const EXTENSION_ID = 'qsp.qsp-lsp';

// The server parses asynchronously (debounced, WASM loaded on start), so
// every LSP-backed check polls instead of asserting once.
async function waitFor<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 200));
  }
}

function fixtureUri(relPath: string): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root, 'the fixture workspace is not open');
  return vscode.Uri.joinPath(root, relPath);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

suite('QSP extension', () => {
  test('activates on a .qsps file and publishes a syntax error', async () => {
    const uri = fixtureUri('errors.qsps');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    assert.strictEqual(doc.languageId, 'qsp');

    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `${EXTENSION_ID} is not installed in the test host`);
    await waitFor('extension activation', () => (ext.isActive ? true : undefined));

    const errors = await waitFor('syntax diagnostics', () => {
      const found = vscode.languages.getDiagnostics(uri)
        .filter(d => d.severity === vscode.DiagnosticSeverity.Error);
      return found.length > 0 ? found : undefined;
    });
    // errors.qsps has `if x = 1` without the colon on line 2.
    const missingColon = errors.find(d => d.message.includes("Missing ':'"));
    assert.ok(missingColon, `no "Missing ':'" error; got: ${errors.map(d => d.message).join(' | ')}`);
    assert.strictEqual(missingColon.range.start.line, 1);
  });

  test('serves hover and completion for a builtin function', async () => {
    const uri = fixtureUri('main.qsps');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    // `len` in `x = len('abc')` on line 2.
    const onLen = new vscode.Position(1, 5);

    const hoverText = await waitFor('hover on len', async () => {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider', uri, onLen);
      const text = (hovers ?? [])
        .flatMap(h => h.contents)
        .map(c => (typeof c === 'string' ? c : c.value))
        .join('\n');
      return text.length > 0 ? text : undefined;
    });
    assert.match(hoverText, /len/i);

    const afterEquals = new vscode.Position(1, 4);
    const labels = await waitFor('completion items', async () => {
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider', uri, afterEquals);
      const names = (list?.items ?? [])
        .map(i => (typeof i.label === 'string' ? i.label : i.label.label).toLowerCase());
      return names.includes('len') ? names : undefined;
    });
    assert.ok(labels.includes('len'));
  });

  // Sticky Scroll keeps the headers of the blocks around the cursor at the
  // top; built from the folding ranges, an `if` is one of them too.
  test('Sticky Scroll is built from the folding ranges, which hold an if block', async () => {
    const model = vscode.workspace.getConfiguration('editor', { languageId: 'qsp' }).get('stickyScroll.defaultModel');
    assert.strictEqual(model, 'foldingProviderModel');

    const doc = await vscode.workspace.openTextDocument({ language: 'qsp', content: "# a\nif x = 1:\n  pl 'one'\n  pl 'two'\nend\n--- a ---\n" });
    await vscode.window.showTextDocument(doc);
    const starts = await waitFor('folding ranges', async () => {
      const ranges = await vscode.commands.executeCommand<vscode.FoldingRange[]>('vscode.executeFoldingRangeProvider', doc.uri);
      const lines = (ranges ?? []).map(r => r.start);
      return lines.includes(1) ? lines : undefined;
    });
    assert.ok(starts.includes(0), 'the location folds too');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  test('Combine Project Files writes the sources in txt2gam.json order', async () => {
    const root = vscode.workspace.workspaceFolders![0];
    const output = fixtureUri(`${root.name}.qsps`);
    assert.strictEqual(await exists(output), false, 'combined file left over from an earlier run');

    const done = vscode.commands.executeCommand('qsp.combineProject');
    // The save dialog is a quick input here (files.simpleDialog.enable in the
    // fixture settings) prefilled with the suggested path; accept it once it
    // shows up. Accepting before it opens is a harmless no-op.
    await waitFor('combined file', async () => {
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      return (await exists(output)) ? true : undefined;
    });
    await done;

    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(output));
    const start = text.indexOf('# start');
    const data = text.indexOf('# data');
    assert.ok(start >= 0 && data > start, 'main.qsps must come before data/data.qsps');
    assert.ok(text.includes("$name = 'Алиса'"), 'Cyrillic text must survive combining');
    assert.ok(!text.includes('# broken'), 'errors.qsps is not listed in txt2gam.json');
  });

  test('Copy MCP Server Config gives a command that starts the MCP server', async () => {
    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('qsp.copyMcpConfig');
    const { command, args, env } = (JSON.parse(await vscode.env.clipboard.readText()) as {
      mcpServers: { qsp: { command: string; args: string[]; env: Record<string, string> } };
    }).mcpServers.qsp;
    assert.strictEqual(command, process.execPath);
    assert.deepStrictEqual(args.slice(1), ['--workspace', vscode.workspace.workspaceFolders![0].uri.fsPath]);

    // Start it exactly as an agent would and complete the MCP handshake.
    const child = cp.spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        let out = '';
        let err = '';
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString();
          if (out.includes('\n')) resolve(out.split('\n')[0]);
        });
        child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
        child.on('exit', code => reject(new Error(`server exited with ${code}: ${err}`)));
        child.stdin.write(JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ui-test', version: '0' } },
        }) + '\n');
      });
      assert.strictEqual((JSON.parse(reply) as { result: { serverInfo: { name: string } } }).result.serverInfo.name, 'qsp');
    } finally {
      child.kill();
    }
  });

  test('QSP Locations shows in the Explorer and opens a location at its header', async () => {
    // The view exists only once qsp.hasSources is set, so focusing it proves both.
    await vscode.commands.executeCommand('qsp.locations.focus');
    await vscode.commands.executeCommand('qsp.locations.refresh');

    const uri = fixtureUri('data/data.qsps');
    await vscode.commands.executeCommand('qsp.locations.open', { uri: uri.toString(), name: 'data', line: 0 });
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'no editor after opening the location');
    assert.strictEqual(editor.document.uri.toString(), uri.toString());
    assert.strictEqual(editor.selection.active.line, 0);
  });

  test('a location command from the view acts on that location and puts the cursor there', async () => {
    // Start in another file, so the target file has to be opened by the command.
    await vscode.window.showTextDocument(fixtureUri('main.qsps'));
    const uri = fixtureUri('data/data.qsps');

    const done = vscode.commands.executeCommand('qsp.duplicateLocation', { uri: uri.toString(), name: 'data', line: 0 });
    // Accept the prefilled name ("data_copy") once the input box is up.
    await waitFor('the duplicate', async () => {
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.toString() === uri.toString() && editor.document.getText().includes('# data_copy') ? true : undefined;
    });
    await done;

    const editor = vscode.window.activeTextEditor!;
    assert.strictEqual(editor.document.lineAt(editor.selection.active.line).text, '# data_copy');
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  test('Show Jump Graph opens one graph tab beside the editor', async () => {
    const editor = await vscode.window.showTextDocument(fixtureUri('main.qsps'));
    await vscode.commands.executeCommand('qsp.showJumpGraph');
    await vscode.commands.executeCommand('qsp.showJumpGraph', { uri: fixtureUri('main.qsps').toString(), name: 'start', line: 0 });

    const graphTabs = await waitFor('the graph tab', () => {
      const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs)
        .filter(t => t.input instanceof vscode.TabInputWebview && t.label === 'QSP Jump Graph');
      return tabs.length > 0 ? tabs : undefined;
    });
    assert.strictEqual(graphTabs.length, 1, 'a second call must reuse the panel');
    assert.notStrictEqual(graphTabs[0].group.viewColumn, editor.viewColumn, 'the graph opens beside the editor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('QSP Libraries installs a library, refuses a clashing one, and the build keeps it separate', async () => {
    const files: Record<string, string> = {
      '/dialogs/dialogs.qsps': "# dialogs_init\n*pl 'Диалог'\n--- dialogs_init ---\n",
      // main.qsps already has a location named start.
      '/clash/clash.qsps': '# START\n--- START ---\n',
    };
    const entry = (id: string) => ({
      id, version: '1.0.0', file: `${id}/${id}.qsps`,
      sha256: createHash('sha256').update(files[`/${id}/${id}.qsps`]).digest('hex'),
    });
    files['/libraries.json'] = JSON.stringify({ schema: 1, libraries: [entry('dialogs'), entry('clash')] });
    const server = http.createServer((req, res) => {
      const body = files[req.url ?? ''];
      res.writeHead(body === undefined ? 404 : 200);
      res.end(body);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const settings = vscode.workspace.getConfiguration('qsp');
    try {
      await settings.update('libraries.sources', [`http://127.0.0.1:${port}/libraries.json`], vscode.ConfigurationTarget.Workspace);
      await settings.update('game.promptPassword', false, vscode.ConfigurationTarget.Workspace);
      const readConfig = async () => JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(fixtureUri('txt2gam.json'))));
      await vscode.commands.executeCommand('qsp.exportGame');
      const gameBefore = await vscode.workspace.fs.readFile(fixtureUri('fixture.qsp'));
      await vscode.workspace.fs.delete(fixtureUri('fixture.qsp'));

      await vscode.commands.executeCommand('qsp.libraries.install', { kind: 'available', id: 'dialogs' });
      assert.ok(await exists(fixtureUri('libs/dialogs.qsps')), 'the library file is installed');
      const installed = (await readConfig()).libraries?.installed;
      assert.deepStrictEqual(Object.keys(installed ?? {}), ['dialogs']);
      assert.strictEqual(installed.dialogs.sha256, entry('dialogs').sha256);
      assert.strictEqual((await readConfig()).outputFile, 'fixture.qsp', 'the rest of txt2gam.json is kept');

      await vscode.commands.executeCommand('qsp.libraries.install', { kind: 'available', id: 'clash' });
      assert.strictEqual(await exists(fixtureUri('libs/clash.qsps')), false, 'a clashing library is not written');
      assert.deepStrictEqual(Object.keys((await readConfig()).libraries.installed), ['dialogs']);

      await vscode.commands.executeCommand('qsp.exportGame');
      assert.ok(await exists(fixtureUri('fixture.qsp')), 'the game is built');
      assert.ok(await exists(fixtureUri('libs/dialogs.qsp')), 'the library is built into its own .qsp');
      // .qsp text is enciphered, so compare with the build from before the install.
      assert.deepStrictEqual(await vscode.workspace.fs.readFile(fixtureUri('fixture.qsp')), gameBefore,
        'the library is not folded into the game');

      // A game location named like the library's stops the build.
      await vscode.workspace.fs.delete(fixtureUri('fixture.qsp'));
      await vscode.workspace.fs.writeFile(fixtureUri('data/clash.qsps'), new TextEncoder().encode('# Dialogs_Init\n--- Dialogs_Init ---\n'));
      await vscode.commands.executeCommand('qsp.exportGame');
      assert.strictEqual(await exists(fixtureUri('fixture.qsp')), false, 'nothing is built while two locations share a name');
      await vscode.workspace.fs.delete(fixtureUri('data/clash.qsps'));
    } finally {
      server.close();
      await settings.update('libraries.sources', undefined, vscode.ConfigurationTarget.Workspace);
      await settings.update('game.promptPassword', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('the quick fix command turns a check off in the workspace settings', async () => {
    const config = () => vscode.workspace.getConfiguration('qsp.diagnostics');
    try {
      // Not awaited: the command then waits on its "Undo" notification.
      void vscode.commands.executeCommand('qsp.diagnostics.turnOff', 'unusedVariables');
      await waitFor('the setting', () => config().inspect('unusedVariables')?.workspaceValue === false ? true : undefined);
      void vscode.commands.executeCommand('qsp.diagnostics.turnOff', 'maxLocationLines');
      await waitFor('the numeric setting', () => config().inspect('maxLocationLines')?.workspaceValue === 0 ? true : undefined);
      void vscode.commands.executeCommand('qsp.diagnostics.turnOff', 'notACheck');
      await new Promise(r => setTimeout(r, 300));
      assert.strictEqual(config().inspect('notACheck')?.workspaceValue, undefined);
    } finally {
      await config().update('unusedVariables', undefined, vscode.ConfigurationTarget.Workspace);
      await config().update('maxLocationLines', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });
});

suite('QSP syntax version', () => {
  test('the workspace setting decides what is an error, and the picker command exists', async () => {
    assert.ok((await vscode.commands.getCommands(true)).includes('qsp.selectSyntaxVersion'));
    const uri = fixtureUri('syntax-version.qsps');
    await vscode.workspace.fs.writeFile(uri, Buffer.from('# version\nx = ?\npl x\n--- version ---\n'));
    const config = vscode.workspace.getConfiguration('qsp');
    try {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      const isVersionError = (d: vscode.Diagnostic) =>
        (typeof d.code === 'object' ? d.code.value : d.code) === 'unsupportedSyntax';
      await waitFor('the 5.9.5 error on ?', () =>
        vscode.languages.getDiagnostics(uri).some(isVersionError) ? true : undefined);

      await config.update('syntaxVersion', '5.9.6', vscode.ConfigurationTarget.Workspace);
      await waitFor('the error gone in 5.9.6', () =>
        vscode.languages.getDiagnostics(uri).some(isVersionError) ? undefined : true);
    } finally {
      await config.update('syntaxVersion', undefined, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await vscode.workspace.fs.delete(uri);
    }
  });
});
