/**
 * QSP Language Server — Node.js entry point.
 * Used on desktop (macOS, Windows, Linux) and Android (Termux).
 * Communicates via stdio transport.
 */
import * as path from 'path';
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { createQspServer } from './common';
import { nodeAnalysisCacheStore } from './nodeCache';
import { fsProvider, wasmFromOutDir } from './nodeHost';
import { NodeRecorder, nodeMemory } from './nodeRecorder';
import { AnalysisWorkerPool } from './nodeWorkers';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// This bundle is out/server/nodeMain.js, the worker's out/server/analysisWorker.js.
const outDir = path.join(__dirname, '..');
const { wasmLoader, wasmDir } = wasmFromOutDir(outDir);
const workerScript = path.join(__dirname, 'analysisWorker.js');

createQspServer(connection, documents, wasmLoader, wasmDir, fsProvider, {
  memory: nodeMemory,
  recorder: new NodeRecorder(),
  analysisCache: nodeAnalysisCacheStore([__filename, workerScript, path.join(outDir, 'tree-sitter-qsp.wasm')]),
  analysisWorkers: new AnalysisWorkerPool(workerScript, outDir),
});
