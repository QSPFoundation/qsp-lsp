/**
 * Shared client-side output channel for QSP build/run workflow logging.
 *
 * The channel ("QSP") is created lazily on first use and persists for
 * the lifetime of the extension.  Call `show()` at the start of a
 * user-visible operation so the panel opens automatically.
 *
 * Server-side logging uses `connection.console.log` (visible in the
 * "QSP Language Server" trace channel) and is separate from this channel.
 */

import * as vscode from 'vscode';

let _channel: vscode.OutputChannel | undefined;

function channel(): vscode.OutputChannel {
  if (!_channel) _channel = vscode.window.createOutputChannel('QSP');
  return _channel;
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

/** Append a timestamped line to the QSP output channel. */
export function log(msg: string): void {
  channel().appendLine(`[${timestamp()}] ${msg}`);
}

/** Show the QSP output channel in the panel (reveals, doesn't steal focus). */
export function show(): void {
  channel().show(true);
}

/** Dispose the channel (called from extension deactivate). */
export function dispose(): void {
  _channel?.dispose();
  _channel = undefined;
}
