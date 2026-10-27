// ── Where the MCP server keeps its analysis cache ────────────────────
//
// VS Code gives the editor's server a storage folder per workspace; the MCP
// server runs on its own, so it uses the user's cache directory, one folder
// per game, named by a hash of the game's path (src/server/nodeCache.ts says
// what the entries hold: they stay on this machine).

import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';

/** The user's cache directory, as each platform has it. */
export function userCacheBase(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  if (env.XDG_CACHE_HOME) return env.XDG_CACHE_HOME;
  if (platform === 'win32') return env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches');
  return path.join(home, '.cache');
}

/**
 * The cache directory for `workspace` from the command line: `--cache-dir <dir>`,
 * none with `--no-cache`, else a folder of its own under the user's cache.
 */
export function mcpCacheDir(argv: readonly string[], workspace: string, base = userCacheBase()): string | undefined {
  if (argv.includes('--no-cache')) return undefined;
  const i = argv.indexOf('--cache-dir');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  const id = createHash('sha256').update(path.resolve(workspace)).digest('hex').slice(0, 16);
  return path.join(base, 'qsp-lsp', 'mcp', id);
}
