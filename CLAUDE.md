# CLAUDE.md — QSPeak: QSP Language Support (VS Code extension + LSP)

## Architecture & Boundaries

```
src/client/   VS Code extension (the only layer allowed to import `vscode`)
              nodeMain.ts (desktop), browserMain.ts (vscode.dev), commands, txt2gam, debug adapter
src/server/   LSP server (vscode-languageserver). Transport-agnostic core in common.ts;
              nodeMain.ts = stdio + fs, browserMain.ts = Web Worker, regex "lite" mode (no tree-sitter);
              analysisWorker.ts = worker thread (own bundle) the project load analyses files in (nodeWorkers.ts)
src/parser/   Tree-sitter wrapper + symbol/scope/binding analysis. Pure: no server/client imports
src/common/   Shared pure helpers (location splitting, QSP string scanner, build plan, txt2gam calls)
src/mcp/      MCP server (stdio). out/mcp/server.js = ES5 Node-version check (src/mcp/server.js, keep it ES5),
              out/mcp/main.js = the server. Embeds the LSP server in-process and asks it over LSP;
              no `vscode` import. src/client/mcp.ts only registers it with VS Code
tree-sitter-qsp/grammar.js   Grammar source of truth (+ src/scanner.c external scanner)
qsp_grammar.peg              Ohm.js reference grammar that grammar.js was translated from. Not used by the build
syntaxes/qsp.tmLanguage.json TextMate grammar (instant coloring, separate from tree-sitter)
test/                        Vitest suites; tree-sitter-qsp/test/corpus/ = grammar corpus tests
```

Dependency direction: `client → (LSP protocol) → server → parser → common`, and `mcp → server → parser → common`.
Never the reverse.
Output bundles go to `out/` via esbuild. `out/`, `vendor/`, and generated `tree-sitter-qsp/src/*` are gitignored.

## Critical Invariants

**Parser generation boundary**
❌ Don't: edit `tree-sitter-qsp/src/parser.c`, `grammar.json`, `node-types.json` or the `.wasm` by hand (they're generated and gitignored).
✅ Do: edit `tree-sitter-qsp/grammar.js` (or `src/scanner.c`), then run `npm run build:grammar`, and `cd tree-sitter-qsp && npx tree-sitter test`.

❌ Don't: expect edits to `qsp_grammar.peg` to change parser behavior.
✅ Do: treat it as the spec. If you change semantics, update `grammar.js` and keep the `.peg` in sync.

❌ Don't: add a new statement keyword only in `grammar.js`.
✅ Do: also update `src/parser/builtins.ts` (hover/completion/arg counts), `src/parser/lookupTables.ts`,
   `syntaxes/qsp.tmLanguage.json`, and a corpus test in `tree-sitter-qsp/test/corpus/`.
   (grep an existing keyword such as `addobj` to find every place.)

**Client/server import boundary**
❌ Don't: `import * as vscode from 'vscode'` anywhere in `src/server`, `src/parser`, `src/common`.
✅ Do: keep `vscode` imports in `src/client/` only. The server talks through `vscode-languageserver` APIs.

❌ Don't: import `vscode` in `src/mcp/`, or add analysis logic there.
✅ Do: add what an MCP tool needs to the LSP server (a request, a diagnostic) and call it from `src/mcp/`,
   so agents and the editor always get the same answers.

❌ Don't: import `fs`/`path`/`node:*` in `src/server/common.ts` or `src/parser/`. The browser bundle will break.
✅ Do: put Node-specific code in `src/server/nodeMain.ts` and inject it (see the `FsProvider` pattern in `serverUtils.ts`).

**Case-insensitivity & Cyrillic**
❌ Don't: write grammar keywords as plain strings (`'goto'`) or compare names with `===` on raw text.
✅ Do: wrap keywords with `ci()`/`kw()`/`kwc()` in `grammar.js`, and key maps by `name.toLowerCase()`
   (see `locationSymbols.ts`, `walkHelpers.ts`).

❌ Don't: narrow `identifier_text` to `[A-Za-z_]` or use `\w` for QSP names. That drops Cyrillic (`$имя`, `# Локация`).
✅ Do: keep identifiers as negated character classes (current `identifier_text` regex), and add a test with Cyrillic names.

**Non-blocking parsing & caching**
❌ Don't: run a full tree-sitter parse or diagnostics synchronously inside `onDidChangeContent`.
✅ Do: respect the two-tier debounce in `common.ts` (fast 150 ms index rebuild / tree 500 ms full parse).

❌ Don't: store derived data that outlives `DocumentState`, or reuse `aggCache`/`cachedCallTypes` after the state object is replaced.
✅ Do: hang caches off `DocumentState` (`featureTypes.ts`) so they get invalidated when the state is replaced. Reuse aggregates only through `reusePropagation`
   (`aggregation.ts`), which checks the locations' interfaces and swaps in the edited locations' symbols.

❌ Don't: parse a document as one tree. Every file, open or closed, is parsed one location at a time
   (`locationAnalysis.ts`, `analyzeAllLocations` in `common.ts`, `projectMode.analyzePerLocation`).
✅ Do: keep incremental edits proportional to one location's size (`perLocationCache`, `INCREMENTAL_LOC_THRESHOLD`),
   and make trees, tokens and fold ranges of a location only when a feature needs them.

❌ Don't: add a field to `LocationSymbols` (or the objects it holds) that stores positions, offsets or tree-sitter node ids
   without listing it in `locationInterface.ts`: an edit that only moves text would then look like an interface change,
   and every project file would be diagnosed again.
✅ Do: skip such fields there (`SKIPPED_KEYS`, or `SCOPE_KEYS` for offset-based scope keys), and keep
   `test/fileInterface.test.ts` checking that other files keep the diagnostics a full re-diagnosis gives them.

❌ Don't: add a synchronous loop over every location or file to the aggregates or diagnostics: on a large game
   it holds every request for seconds.
✅ Do: write it as a `Steps` generator (`src/server/slices.ts`) that `yield`s after each location or file, called with
   `yield*`; the server runs it a slice at a time (`runInSlices`). A generator called without `yield*` does nothing,
   and tsc doesn't catch it.

❌ Don't: assume tree-sitter is ready (browser mode, initial load).
✅ Do: guard with `tsParser.isReady` and fall back to `regexFallback.ts`.

**Code blocks** (`{…}`)
❌ Don't: read a `code_block`'s statements through `node.children` or a `TreeCursor`, find a node inside one with
   `descendantForPosition`/`descendantsOfType` on the outer tree, or climb out of one with `node.parent`. The grammar
   keeps a block's inside as one `block_body` token (QSP finds a block's end by its braces and quotes, whatever is inside),
   and the inside is a tree of its own.
✅ Do: go in with `blockStatements`, `forEachDescendant`, `descendantsOfType` or `descendantAt`, and up with `parentOf`
   (`src/parser/blockTrees.ts`). A stored block that isn't code is a string (`isTextBlock`): no symbols, and its syntax
   errors are shown only when something runs it (`blocksRun` in `diagnostics.ts`). So is a block nothing can run
   (`isNeverRunBlock`: an array key, an operand of `=`), a block passed as an argument unless the callee runs its
   `$args[N]` (`argBlocks.ts`), and a block kept in a variable unless something may run the variable (`storedBlocks.ts`:
   `dynamic`/`dyneval` lines, followed through copies and call arguments in the aggregates' `runVariables`). Both are
   decided with the other locations' symbols, in `diagnostics.ts`, the token builder and, for hover, definition,
   references, rename and highlights, `textBlocks.ts`; the aggregates still count the words in them.

**Performance data and crash reports users send us**
❌ Don't: put real file, location, variable, object or action names, or any game text, into `[perf]` log lines,
   `qsp/performanceReport` (`performanceReport.ts`), the crash recorder's files (`nodeRecorder.ts`), crash report zips
   (`src/client/crashPackage.ts`), anonymized code (`src/parser/anonymize.ts`) or skeletons (`src/parser/skeleton.ts`).
   Users send these for games whose content they can't share.
✅ Do: counts, sizes, durations, memory, grammar node types, the extension's own function names, and pseudonyms
   (`f01`, `f01_l0007`, `var_0003` from `pseudonyms.ts` / `anonymize.ts`, `wabc` from `skeleton.ts`). The pseudonym → name
   table (`names-<pid>.json`, `crash-*.names.json`, `qsp-skeleton-*.names.json`) stays on the user's machine and never goes
   into a zip or a skeleton's folder. Keep `test/performanceReport.test.ts`, `test/crashPackage.test.ts`,
   `test/anonymize.test.ts` and `test/skeleton.test.ts` checking that no name leaks. To reproduce a user's game, ask for
   its skeleton (**QSP: Export Anonymized Skeleton**, `npm run stress:skeleton`), or generate one of the same shape:
   `npm run stress:gen -- --shape report.json`.

**Analysis cache** (`src/server/nodeCache.ts`, used by `projectMode.analyzeFileNow`, for open files by `analyzeAllLocations` in `common.ts`,
and for the propagation of locals by `projectMode.rebuildAggregates`, keyed by the locations' interfaces)
❌ Don't: leave out of a cache key anything the cached result depends on (text, URI, a setting that changes it),
   or let cache entries, their keys or the cache path reach `[perf]` lines, crash reports or zips: entries hold the game's text and names.
✅ Do: build keys with `AnalysisCache.key(...)` over every input; the analyser itself (server bundle, grammar) already salts
   every key, so a rebuild never reads old results. Keep `test/analysisCache.test.ts` checking that results read from
   the cache equal a fresh analysis.

❌ Don't: put a cycle, a `Date`, an `Error` or a function into a cached value, or expect a class instance to come back
   with its methods. The format (`cacheFormat.ts`, also what worker threads hand over) refuses the first, so nothing is stored.
✅ Do: keep cached values to plain objects, arrays, Maps, Sets, typed arrays and primitives, and give instances their
   prototype back on read (`reviveDocumentSymbols`).

**Browser tooling (Playwright)**
❌ Don't: ship Playwright or its browser binaries in the `.vsix`, or add them to `dependencies`.
✅ Do: keep it dev-only (`devDependencies` at most, or installed in a scratch directory), with browsers in
   Playwright's default cache (`~/.cache/ms-playwright`), outside the repo. Use it only for local/CI verification
   (see the `jump-graph-visual-check` skill).

❌ Don't: return a Cytoscape object from a `page.evaluate` callback (`() => node.emit('tap')` returns the element).
   Playwright tries to serialize it with the whole graph and renderer, and the page dies with "V8 javascript OOM",
   which looks like a bug in the extension.
✅ Do: use a block body that returns nothing or plain data: `() => { node.emit('tap'); }`.

**Comments** (explain WHY, not WHAT; if unsure whether a comment is obvious, keep it and list it for review)
❌ Don't: restate the next line or the TS signature.
   `// increment counter` above `counter++`; `// takes a string, returns a number` above `parse(input: string): number`.
✅ Do: say what the code can't — a non-obvious choice, a library workaround, a QSP rule, a side effect or ordering dependency.
   e.g. the `parser.reset()` note in `treeSitter.ts` (web-tree-sitter resumes a halted parse unless reset).

❌ Don't: leave changelog notes (authors, dates, "fixed by X") or commented-out code without a reason.
✅ Do: put history in the commit subject and CHANGELOG.md; a TODO/FIXME must say why (and link an issue if there is one).

**Commit messages** (the maintainer's rule: a tidy, one-line history)
❌ Don't: write a commit body, bullet lists or trailers (`Co-Authored-By:` and the like), or merge commits into `unstable`/`main`.
✅ Do: one line, imperative, about 50–72 characters (`Add the Jump Graph panel`); explain the change in the PR
   description or CHANGELOG.md instead. Rebase instead of merging (see **Commits**).

## Build & Verification Commands

| Task | Command |
|---|---|
| Full build (txt2gam fetch + grammar WASM + 4 bundles) | `npm run build` |
| Grammar only (generate + wasm + copy to `out/`) | `npm run build:grammar` |
| Grammar corpus tests | `cd tree-sitter-qsp && npx tree-sitter test` |
| Unit tests (Vitest) | `npm test` (single file: `npx vitest run test/variables.test.ts`) |
| UI tests (real VS Code, @vscode/test-cli) | `npm run test:ui` (headless Linux: `xvfb-run -a npm run test:ui`) |
| MCP server bundle | `npm run build:mcp` (run: `node out/mcp/server.js --workspace <dir> [--verbose]`) |
| Stress game (synthetic QSP project) | `npm run stress:gen -- --out <dir> [--locations 1000] [--chars 26000] [--files 1] [--shape report.json]` |
| Anonymized skeleton of a real project (needs the server bundle) | `npm run stress:skeleton -- <project> --out <dir> [--names <file>]` |
| Load test the server on a project | `npm run build:server:node && npm run bench:stress -- <dir> [--graph] [--edits 5] [--json out.json]` |
| Everything CI runs (no packaging) | `npm run check` (= `scripts/build.sh --check`) |
| Third-party notices (after a dependency change; CI checks it) | `node scripts/thirdPartyNotices.mjs` |
| Package VSIX | `npm run release` (optional version: `bash scripts/build.sh 1.2.3`) |

Notes:
- `npm run build` needs network the first time (`scripts/fetchTxt2gam.mjs` downloads into `vendor/`).
- `build:grammar` copies the WASM to `out/`, so create `out/` first if it's missing (`build.sh` does `mkdir -p out`).
- CI (`.github/workflows/ci.yml`) runs `scripts/build.sh --check` on Node 22 and 24. Dev tooling (vitest 5, vsce 4) needs Node ≥ 22.12; the bundles still target node18 for VS Code ^1.85.
- `test/ui/` runs inside VS Code against a temp copy of `test/ui/fixture/` (see `.vscode-test.mjs`); Vitest excludes it.
  The first run downloads VS Code into `.vscode-test/`.

Before finishing any change: `npx tsc --noEmit && npm test && npm run lint`.
For grammar changes, also run the corpus tests above.

## Refactoring Guidelines

- **Tests first.** Test files mirror the module they cover (e.g. `variableBindings.ts` → `test/variableBindings.test.ts`).
  Use `test/testHelpers.ts`; for end-to-end LSP behavior use `test/lspE2E.test.ts`.
- **Keep `src/parser/` pure.** Functions take a tree/text and return data. No settings, connection, or timers.
- **Diagnostics go in passes.** Add a new check to the matching file in `src/server/diagnosticPasses/`,
  add a `qsp.diagnostics.<name>` toggle in `package.json` `contributes.configuration`, and wire it into `DiagnosticSettings`.
- **Both bundles must build.** After touching `src/server` or `src/common`, run `npm run build:server:browser`
  to catch accidental Node imports.
- **Embedded code** (`exec:` links, `<<expr>>` interpolation) is re-parsed via `embeddedExec.ts` / `embeddedInterpolation.ts`.
  Symbol and position changes need to handle offset mapping there as well.
- **Project mode** (`projectMode.ts`) merges symbols across files. Cross-file features must work in
  single-file mode and in project mode.
- **Semantic tokens:** if you change `SEMANTIC_TOKENS_LEGEND`, update `semanticTokenScopes` in `package.json` too.
- Match the existing style: section banners and comments as described in **Comments** below, `_`-prefixed unused args.
- Don't commit `out/`, `vendor/`, `*.vsix`, or generated tree-sitter sources.

## Comments

Content rules are in **Critical Invariants → Comments**. Style:
- Section banners: use `// ── Name ───` in new code. Leave existing `// ==== NAME ====` banners and unnamed dividers as they are.
- `/** */` JSDoc on exported functions, classes and public interface members. Internal helpers get `//` or nothing,
  unless the logic is non-obvious. Applies to new code only — existing JSDoc on internal helpers stays.
- `//` for single-line notes, not `/* */`. No comment directly above `return` unless it explains the returned expression.

## Commits

- **Subject only.** One line in the imperative (`Fix …`, `Add …`, `Keep …`), no body, no trailers, no attribution lines.
  What the change does in detail belongs in the PR description; what users notice belongs in CHANGELOG.md.
- **One logical change per commit**, building and passing `npm run check` on its own.
- **Linear history.** Update a branch with `git rebase`, not `git merge`; integrate it by fast-forward or rebase,
  never with a merge commit.
- Commit only when asked; never push (the maintainer pushes and tags releases).
