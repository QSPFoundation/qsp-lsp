/**
 * QSP "debug" adapter — a minimal inline Debug Adapter Protocol implementation
 * that hooks the standard VS Code F5 / Ctrl+F5 Run experience into qsp.runGame.
 *
 * When VS Code starts a launch session of type "qsp", this adapter:
 *   1. Responds to the DAP initialize + launch handshake immediately.
 *   2. Calls runGameCommand() to build and launch the player.
 *   3. Sends a "terminated" event so VS Code closes the session right away.
 *
 * There is no real debugger — the player runs as a detached process.
 * This file is only registered in nodeMain.ts (desktop); the browser entry
 * point does not register a debug adapter.
 */

import * as vscode from 'vscode';
import { runGameCommand } from './runGame';

// ── Minimal inline DebugAdapter ───────────────────────────────────────

class QspDebugAdapter implements vscode.DebugAdapter {
  private readonly _emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this._emitter.event;

  private _seq = 1;

  constructor(
    private readonly context: vscode.ExtensionContext,
  ) {}

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const msg = message as { type: string; command: string; seq: number };
    if (msg.type !== 'request') return;

    if (msg.command === 'initialize') {
      this._respond(msg.seq, 'initialize', {});
      this._send({ type: 'event', event: 'initialized' });

    } else if (msg.command === 'launch') {
      this._respond(msg.seq, 'launch', {});
      // runGameCommand resolves once the player process is spawned (non-blocking).
      // Terminate the session immediately after so there is no dangling debug UI.
      runGameCommand(this.context).finally(() => {
        this._send({ type: 'event', event: 'terminated' });
      });

    } else {
      // Acknowledge everything else (configurationDone, disconnect, etc.)
      this._respond(msg.seq, msg.command, {});
    }
  }

  private _respond(requestSeq: number, command: string, body: object): void {
    this._send({ type: 'response', request_seq: requestSeq, success: true, command, body });
  }

  private _send(msg: object): void {
    this._emitter.fire({ seq: this._seq++, ...msg } as vscode.DebugProtocolMessage);
  }

  dispose(): void {
    this._emitter.dispose();
  }
}

// ── Factory + Configuration Provider ────────────────────────────────

export function registerQspDebugAdapter(
  context: vscode.ExtensionContext,
): void {
  // Supply a launch config when there is no launch.json, so F5 just works.
  const provider: vscode.DebugConfigurationProvider = {
    provideDebugConfigurations(): vscode.DebugConfiguration[] {
      return [{ type: 'qsp', request: 'launch', name: 'Run QSP Game' }];
    },
    resolveDebugConfiguration(
      _folder: vscode.WorkspaceFolder | undefined,
      config: vscode.DebugConfiguration,
    ): vscode.DebugConfiguration {
      // If launched without any config (e.g. plain F5 with no launch.json),
      // fill in the required fields.
      if (!config.type && !config.request && !config.name) {
        config.type    = 'qsp';
        config.request = 'launch';
        config.name    = 'Run QSP Game';
      }
      return config;
    },
  };

  const factory: vscode.DebugAdapterDescriptorFactory = {
    createDebugAdapterDescriptor() {
      return new vscode.DebugAdapterInlineImplementation(
        new QspDebugAdapter(context),
      );
    },
  };

  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('qsp', provider),
    vscode.debug.registerDebugAdapterDescriptorFactory('qsp', factory),
  );
}
