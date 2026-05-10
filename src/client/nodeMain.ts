/**
 * QSP Language Client — Node.js (desktop) entry point.
 * Spawns the language server as a child Node.js process with stdio transport.
 */
import * as path from 'path';
import { ExtensionContext, window } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';
import { registerExtensionFeatures } from './features';

let client: LanguageClient;

export function activate(context: ExtensionContext): void {
  const serverModule = context.asAbsolutePath(
    path.join('out', 'server', 'nodeMain.js')
  );

  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.stdio,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.stdio,
      options: {
        execArgv: ['--nolazy', '--inspect=6009'],
      },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'qsp' },
      { scheme: 'untitled', language: 'qsp' },
    ],
    traceOutputChannel: window.createOutputChannel('QSP Language Server'),
  };

  client = new LanguageClient(
    'qsp-lsp',
    'QSP Language Server',
    serverOptions,
    clientOptions
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
