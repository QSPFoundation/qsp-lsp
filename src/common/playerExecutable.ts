// ── Player executable ────────────────────────────────────────────────
//
// Pure helpers for the `playerExecutable` field of txt2gam.json. Kept free
// of `vscode` so they can be unit-tested; runGame.ts resolves the result
// against the workspace root and falls back to the VS Code setting.

/**
 * Pick the player for this OS from a txt2gam.json `playerExecutable` value:
 * either one path, or an object keyed by Node's `process.platform`
 * (`win32`, `darwin`, `linux`). The object form exists because txt2gam.json
 * is committed and shared, and a Windows path is useless on Linux.
 * Returns undefined for a missing, blank or malformed value, and for an
 * object with no entry for `platform`, so the caller can fall back.
 */
export function pickPlayerExecutable(value: unknown, platform: string): string | undefined {
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[platform]
    : value;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

/**
 * How a player path from txt2gam.json is resolved: `absolute` is used as is,
 * `command` is a bare name (no path separator) looked up on PATH, like the
 * setting allows, and `relative` is resolved against the workspace root so a
 * player shipped in the repository works from any checkout location.
 */
export function classifyPlayerPath(path: string): 'absolute' | 'command' | 'relative' {
  if (path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path)) return 'absolute';
  if (!/[\\/]/.test(path)) return 'command';
  return 'relative';
}

// ── Players ──────────────────────────────────────────────────────────

/** A player txt2gam.json names, for this OS. */
export interface PlayerChoice {
  name: string;
  /** As written: runGame.ts resolves it like `playerExecutable` (classifyPlayerPath). */
  executable: string;
  /** The player's arguments, `${game}` standing for the built .qsp. */
  args: string[];
}

/** What a player gets when txt2gam.json gives no arguments: the game alone. */
export const DEFAULT_PLAYER_ARGS = ['${game}'];

/**
 * The players txt2gam.json names for `platform`, the default one first:
 * its `players` list when there is one, otherwise `playerExecutable` alone.
 * An entry without a path for this OS, or with `args` that aren't a list
 * of strings, is left out. A player without a `name` is called by its
 * file's name.
 */
export function listPlayers(
  cfg: { players?: unknown; playerExecutable?: unknown } | undefined,
  platform: string,
): PlayerChoice[] {
  if (Array.isArray(cfg?.players)) {
    const players: PlayerChoice[] = [];
    for (const entry of cfg.players) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { name, executable, args } = entry as Record<string, unknown>;
      const path = pickPlayerExecutable(executable, platform);
      if (!path) continue;
      if (args !== undefined && !(Array.isArray(args) && args.every(a => typeof a === 'string'))) continue;
      players.push({
        name: typeof name === 'string' && name.trim() !== '' ? name.trim() : fileName(path),
        executable: path,
        args: (args as string[] | undefined) ?? DEFAULT_PLAYER_ARGS,
      });
    }
    return players;
  }
  const path = pickPlayerExecutable(cfg?.playerExecutable, platform);
  return path ? [{ name: fileName(path), executable: path, args: DEFAULT_PLAYER_ARGS }] : [];
}

/** The player called `name` (whatever its case), if there is one. */
export function findPlayer(players: readonly PlayerChoice[], name: string): PlayerChoice | undefined {
  const wanted = name.trim().toLowerCase();
  return players.find(p => p.name.toLowerCase() === wanted);
}

/** `args` with the built game's path for each `${game}`. */
export function playerArguments(args: readonly string[], gamePath: string): string[] {
  return args.map(a => a.split('${game}').join(gamePath));
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat|sh)$/i, '');
}
