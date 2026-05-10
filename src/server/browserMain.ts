/**
 * QSP Language Server — Browser entry point.
 * Used in VS Code Web / vscode.dev.
 * Communicates via postMessage in a Web Worker.
 *
 * Tree-sitter is not loaded in the browser for now — the server runs
 * in "lite" mode using regex-based analysis. Full tree-sitter support
 * in the browser requires a separate WASM bundling strategy.
 */
import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createConnection,
  TextDocuments,
} from 'vscode-languageserver/browser';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { createQspServer } from './common';

const messageReader = new BrowserMessageReader(self as unknown as Worker);
const messageWriter = new BrowserMessageWriter(self as unknown as Worker);

const connection = createConnection(messageReader, messageWriter);
const documents = new TextDocuments(TextDocument);

// No wasmLoader → server runs without tree-sitter (lite mode)
createQspServer(connection, documents);
