/**
 * QSP MCP server (out/mcp/main.js), loaded by the Node version check in
 * out/mcp/server.js — the path MCP configs point at.
 *
 * The workspace defaults to the current directory. The analysis cache lives
 * in the user's cache directory (src/mcp/cacheDir.ts; `--cache-dir <dir>`,
 * `--no-cache`). stdout carries the MCP protocol, so everything else goes to stderr.
 */
import * as fs from 'fs';
import * as path from 'path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { QspHost } from './qspHost';
import { mcpCacheDir } from './cacheDir';
import { wasmFromOutDir } from '../server/nodeHost';
import type { CreateT2gModule } from '../common/txt2gamCore';
import { createQspMcpServer } from './mcpServer';

// This bundle is out/mcp/main.js inside the extension, two levels below its package.json.
function extensionVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

function workspaceArg(argv: string[]): string {
  const i = argv.indexOf('--workspace');
  return path.resolve(i >= 0 && argv[i + 1] ? argv[i + 1] : process.cwd());
}

async function main(): Promise<void> {
  const verbose = process.argv.includes('--verbose');
  const log = (message: string) => { if (verbose) process.stderr.write(message + '\n'); };
  const workspace = workspaceArg(process.argv);
  // The WASM files live in out/, one level up from this bundle; it and the
  // grammar salt the cache keys, so an updated extension analyses afresh.
  const outDir = path.join(__dirname, '..');
  const host = new QspHost(workspace, wasmFromOutDir(outDir), log, mcpCacheDir(process.argv, workspace),
    [__filename, path.join(outDir, 'tree-sitter-qsp.wasm')]);
  await host.start();
  process.stderr.write(`[qsp-mcp] Ready: ${workspace}\n`);

  const server = createQspMcpServer(host, extensionVersion(), {
    loadTxt2gam: async () => {
      // vendor/txt2gam/txt2gam.js is bundled in (build:mcp aliases it); its
      // WASM is the one the client uses, in out/client.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const factory: CreateT2gModule = require('txt2gamJs');
      return factory({
        wasmBinary: new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'client', 'txt2gam.wasm'))),
        print: log,
        printErr: log,
      });
    },
  });
  await server.connect(new StdioServerTransport());
  const shutdown = () => { host.dispose(); process.exit(0); };
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`[qsp-mcp] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
