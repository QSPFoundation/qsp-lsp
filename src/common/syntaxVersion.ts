// ── QSP syntax version ───────────────────────────────────────────────
//
// Which QSP library the game targets. The grammar reads both (it accepts
// the newer constructs); the version decides which of them are errors and
// how values are typed. Pure: shared by the client, the server and the
// parser's builtin tables.

/** The `qsp.syntaxVersion` values: the last release and the library's master. */
export const SYNTAX_VERSIONS = ['5.9.5', '5.9.6'] as const;

export type SyntaxVersion = typeof SYNTAX_VERSIONS[number];

export const DEFAULT_SYNTAX_VERSION: SyntaxVersion = '5.9.5';

/** How a version is named in the UI: 5.9.6 isn't released, and its syntax still changes. */
export const SYNTAX_VERSION_LABELS: Readonly<Record<SyntaxVersion, string>> = {
  '5.9.5': '5.9.5',
  '5.9.6': '5.9.6 (dev)',
};

export function isSyntaxVersion(v: unknown): v is SyntaxVersion {
  return (SYNTAX_VERSIONS as readonly unknown[]).includes(v);
}
