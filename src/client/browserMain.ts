/**
 * QSP Language Client — Browser (Web Worker) entry point.
 * Used in VS Code Web / vscode.dev.
 * Creates the language server in a Web Worker and communicates via postMessage.
 */
import { ExtensionContext, Uri, window } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
} from 'vscode-languageclient/browser';
import { registerExtensionFeatures } from './features';

let client: LanguageClient;

export function activate(context: ExtensionContext): void {
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'qsp' },
      { scheme: 'untitled', language: 'qsp' },
    ],
    traceOutputChannel: window.createOutputChannel('QSP Language Server'),
  };

  const serverMain = Uri.joinPath(
    context.extensionUri,
    'out',
    'server',
    'browserMain.js'
  );

  const worker = new Worker(serverMain.toString(true));

  client = new LanguageClient(
    'qsp-lsp',
    'QSP Language Server',
    clientOptions,
    worker
  );

  // Register extension-side features (status bar, commands)
  registerExtensionFeatures(context, client);

  client.start();
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
