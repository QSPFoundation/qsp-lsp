# QSPeak: QSP Language Support

Full-featured [QSP (Quest Soft Player)](https://qsp.org) language support for Visual Studio Code, powered by a Language Server Protocol (LSP) server and [tree-sitter](https://tree-sitter.github.io/) grammar.

## Installation

- **VS Code Marketplace**: search for *QSPeak* in the Extensions view, or run `code --install-extension QSPFoundation.qsp-lsp`.
- **From a release**: download `qsp-lsp-<version>.vsix` from [GitHub Releases](https://github.com/QSPFoundation/qsp-lsp/releases) and run **Extensions: Install from VSIX…**.

This extension replaces **QSP (official)** (`QSPFoundation.qsp-official`) and **qsp-ext**: they declare the same `qsp` language, so uninstall or disable them, or files get two sets of highlighting and commands.

Requires VS Code 1.85 or later. On [vscode.dev](https://vscode.dev) the extension runs in a lighter mode without the tree-sitter parser. What changed in each version is in [CHANGELOG.md](CHANGELOG.md).

## Features

### Syntax Highlighting
- **TextMate grammar** — instant coloring of locations, keywords, strings, variables, operators, labels, and comments
- **Tree-sitter semantic highlighting** — precise, context-aware token coloring (e.g. goto-targeted location names get a distinct style)

### IntelliSense
- **Completions** — built-in statements & functions, keywords, location names, variables, and user functions
- **Hover** — documentation tooltips for built-in functions/statements, location definitions, variable values, and dynamic call locals
- **Signature help** — parameter hints for built-in functions

### Navigation
- **Go to Definition** — jump to location definitions, variable assignments, labels, and actions
- **Find All References** — find all uses of a location, variable, label, action, or object
- **Document Symbols** — outline view with locations, labels, acts, and actions (Ctrl+Shift+O)
- **Document Highlights** — highlight all occurrences of a variable or label under the cursor
- **Go to Location** — quick-pick to jump to any location across the file or project (Ctrl+Shift+L)
- **Folding and Sticky Scroll** — locations, `act`, `if` (each `elseif`/`else` branch too), `loop` and the part under each label fold, and Sticky Scroll keeps the ones around the top line pinned at the top of the editor; click a pinned line to jump to it. **Go to Parent Fold** (`editor.gotoParentFold`, no key by default) moves the cursor to the start of the block it is in.
  VS Code keeps at most 5000 folding regions per file (`editor.foldingMaximumRegions`). Past that it drops whole nesting levels, the deepest first, until the rest fits, and says so in the status bar: in a large single-file game (around a thousand locations or more) the `act` and `if` blocks inside locations stop folding, and Sticky Scroll and Go to Parent Fold lose them too. Splitting the game into several files keeps each under the limit.

### Editing
- **New Location** — insert a new `# name … ---` block
- **Insert Separator** — `---` separator (Ctrl+Shift+-)
- **Sort Locations** — sort A→Z or Z→A
- **Duplicate Location** — quick-pick to copy a location
- **Delete Location** — remove a location with confirmation
- **Rename Location** — rename a location and update all references
- **Move Location Up/Down** — reorder locations in the file (Alt+Up / Alt+Down)
- **Toggle Comment** — toggle `!` comments (Ctrl+/)
- **Format Location** — format the current location (Ctrl+Shift+F)
- **Snippets** — `loc`, `if`, `ife`, `act`, `loop`, `gs`, `gt`, `pl`, and more

### Build & Run
- **Export QSP Game** (toolbar button) — combine all source files and encode them to a binary `.qsp` game file using [txt2gam](https://github.com/QSPFoundation/txt2gam). In project mode the output path is read from `txt2gam.json`; in single-file mode a save dialog is shown. Supports game passwords.
- **Run QSP Game** (toolbar button / `F5`) — export the game to a `.qsp` file and immediately launch it with the configured player executable.
- **Import QSP Game** — decode a binary `.qsp` file back to a `.qsps` text source. Supports game passwords.
- **Combine Project Files** — merge all source files into a single `.qsps` file without binary encoding; useful for inspection or diff.
- **`txt2gam.json`** — optional per-workspace build config committed alongside source files:
  ```json
  {
    "outputFile": "mygame.qsp",
    "files": [
      "intro.qsps",
      "chapters/*.qsps",
      "ending.qsps"
    ]
  }
  ```
  `outputFile` is relative to the workspace root (default: `<folder name>.qsp`). `files` controls the order in which source files are combined (each entry is a glob). If `files` is missing, **Run** and **Export** add it: they list the workspace's `.qsps`/`.qsrc` files with the main file first (see below), so the build order is always written down.
- **Main file** — the file the game starts from: in a combined build its first location is the start location, in a `perFile` build its `.qsp` is the one **Run QSP Game** opens. It is chosen in this order:
  1. `"mainFile"` in `txt2gam.json`, a regular expression searched case-insensitively in each source's workspace-relative path, e.g. `"^main\\.qsps$"`. The first match in build order wins.
  2. The `qsp.game.mainFile` setting, same format.
  3. Otherwise the first file in `files` order. When the setup wizard creates `txt2gam.json`, it asks for the main file with a list; if the list is dismissed, or `qsp.game.mainFileStrategy` is `root`, the first file from the workspace root is used instead. Either way the chosen file is saved as `mainFile`, so `txt2gam.json` always shows which file is the main one.

  A configured pattern that is invalid or matches no source file stops the build with an error.
- **Player** — **Run QSP Game** launches `"playerExecutable"` from `txt2gam.json` if it is set, otherwise the `qsp.game.playerExecutable` setting; with neither, it asks for the player once and saves it to the setting. In `txt2gam.json` a path with a `/` or `\` is relative to the workspace root (so a player kept in the repository works in any checkout), a bare name such as `qspgui` is looked up on `PATH`, and an absolute path is used as is. Since `txt2gam.json` is usually shared, it can hold one path per OS; an OS without an entry falls back to the setting:
  ```json
  "playerExecutable": {
    "win32": "tools/qspgui/qspgui.exe",
    "linux": "/usr/bin/qspgui",
    "darwin": "/Applications/QSP.app/Contents/MacOS/qspgui"
  }
  ```
- **Several players** — `"players"` in `txt2gam.json` lists players in place of `"playerExecutable"`, the default one first. Each has a `name`, an `executable` written as `playerExecutable` is (one path, or one per OS), and `args`, where `${game}` stands for the built `.qsp` (the game alone when `args` is missing). **Run QSP Game** and **F5** open the first player; **QSP: Run QSP Game in…** (also in the editor's Run menu when there are two or more) asks which. A launch configuration opens the one it names with `"player"`, so each player can have its own entry in the **F5** list (**Add Configuration…** writes one per player):
  ```json
  "players": [
    { "name": "qspgui", "executable": { "win32": "tools/qspgui/bin/qspgui.exe", "linux": "tools/qspgui/AppRun" } },
    { "name": "qSpider", "executable": { "win32": "tools/qspider/qSpider.exe", "linux": "tools/qspider/AppRun" }, "args": ["--file", "${game}"] }
  ]
  ```
  ```json
  { "type": "qsp", "request": "launch", "name": "Run QSP Game in qSpider", "player": "qSpider" }
  ```
  A player with no path for the current OS is left out of the list.
- **Separate module builds** — set `"buildMode": "perFile"` in `txt2gam.json` (or the `qsp.game.buildMode` setting) to build each source file into its own `.qsp` next to it instead of one combined game: `main.qsps` → `main.qsp`, `data.qsps` → `data.qsp`. `outputFile` is not used in this mode. **Run QSP Game** starts the main file's `.qsp` (see above), and the game loads the other modules itself with `INCLIB 'data.qsp'`. When it creates `txt2gam.json` in this mode, the setup wizard writes `buildMode` instead of `outputFile`. A `.qsp` whose content hasn't changed is not rewritten. The `txt2gam.json` value overrides the setting. Two sources that would produce the same `.qsp` (e.g. `a.qsps` and `a.qsrc` in one folder) are reported as an error, and nothing is written if any file fails to build.
- **Libraries** — a library is one `.qsps` file that the game loads with `INCLIB` and drops with `FREELIB`. The ones listed under `"libraries"` in `txt2gam.json` live in `libs/` and are always built into a `.qsp` of their own in `libs/` beside the game's `.qsp`, in either build mode, and never into the game's: with `"outputFile": "build/game.qsp"`, `libs/dialogs.qsps` → `build/libs/dialogs.qsp`, loaded with `INCLIB 'libs/dialogs.qsp'`.
  ```json
  "libraries": {
    "installed": {
      "dialogs": { "version": "1.0.0", "sha256": "…", "catalog": "https://…/libraries.json" }
    }
  }
  ```
- **Same-named locations stop the build** — the player reaches only one location of each name (`INCLIB` skips a library location the game already has), so **Run**, **Export** and the MCP `qsp_build` write nothing and list every place a name is defined, across the game and its libraries.

### QSP Locations view
A **QSP Locations** section in the Explorer side bar lists every location of the project (in project mode) or of the active file:
- **Group by file** (folders and files as in the project, locations in source order) or **Show as list** (all locations alphabetically, with their file), switched with the button in the section header.
- The start location — the first location of the main file — has a ▶ icon; locations with errors or warnings show the counts.
- Click a location to open it. The location under the cursor is selected as you move through the code (`qsp.locations.followCursor`).
- Right-click for **Find References**, **Rename**, **Duplicate** and **Delete**.

### Jump Graph
**QSP: Show Jump Graph** (the graph button in the editor title bar, `Ctrl+K J`, or **Show in Jump Graph** on a location in QSP Locations) opens a graph of who jumps to or calls whom in a tab beside the editor:
- **Around location** shows the locations up to 1–3 steps away from one location, in either direction; **whole project** shows everything; **by file** shows one box per file with the number of jumps between files on the arrows (click a file to open it into its locations, click again to fold it). With **Follow cursor**, the graph centres on the location you are editing; in the whole-project and by-file views it selects that location instead of redrawing.
- **Hubs**: locations that many others jump to or call (an inventory, shared functions) tangle the graph, so by default those with 20 or more callers are hidden. Their callers get a `↗N` mark, and the hidden hubs are listed above the graph; click one to centre on it. The threshold is in the toolbar.
- **Find location** in the toolbar selects a location in the graph, or centres the graph on it if it isn't drawn. Hovering a location fades everything but its neighbours.
- Arrows are styled by kind: `goto`/`xgoto` (solid), `gosub` and `@` calls as statements (dashed), `func`/`@` in expressions (dotted), `desc` (thin). Each kind can be hidden.
- The start location is marked with ▶. Locations nothing jumps to are dashed; a target no file defines is shown in red.
- A jump whose target is an expression (`gt $next`, `gt 'room_' + n`, `gt "room_<<n>>"`, `gt iif(x, 'a', 'b')`) gets a **possible** arrow (yellow, dotted) to each location its variables' known values name: the nearest write before the jump in its own location (`$loc = 'forest'` … `gt $loc`; every arm of an `if` just before it counts), else the nearest writes before the jumps and calls into the location (`$to = 'forest'` then `gt 'road'`, and `gt $to` in road), otherwise `$next = 'hall'` anywhere in the project (or in the same location for a `local`), chains like `$a = $b`, numbers for `'room_' + n` or `'room_' + $str(n)`, `$curloc` (`$back = $curloc` … `gt $back`), `$args[0]` from the arguments at the location's calls (`gs 'go', 'hall'`), and `func('pick')` from what `pick` puts in `result`. An unknown part is matched against location names (`'room_' + $f(x)` → every `room_…`), but a jump that could go to more than 20 locations is left unknown. Nothing is run, so values computed at run time are not seen: when some are, the jump also goes to a **?** node; hover it to see the expressions. Possible arrows count for reachability and can be hidden. The server log gets a `[jump graph]` line with how many dynamic jumps were resolved and, for the rest, why not (counts only, no names).
- Click a location to open it, double-click to centre on it, double-click empty space to zoom in there, click an arrow to open where the jump is written. Hover shows files, lines and the calls.
- Large graphs: up to about 80 locations the graph is drawn in layers; above that a force layout places the nodes, a slice at a time, so the panel stays usable (about 2 s for 1000 locations). Past 5000 arrows only the arrows of the location under the pointer, or the selected one, are drawn: tens of thousands at once are an unreadable tangle and made the panel crawl. Locations keep their places when the graph is redrawn after an edit, and a dragged location stays where you put it. The layout and drawing times are written to **QSP: Show Language Server Log**.

### Libraries
- **QSP Libraries** view in the Explorer: install, update and remove libraries — `.qsps` files a game loads with `INCLIB` — from `libraries.json` catalogs listed in `qsp.libraries.sources`. A library goes to `libs/<id>.qsps` and into `txt2gam.json`. Each one is checked against its catalog's checksum and against the game's location names before anything is written. Afterwards the view offers the `INCLIB` line to insert.
- Each build encodes every installed library into its own `libs/<id>.qsp` beside the game's `.qsp`; a location name used twice across the game and its libraries stops the build. Files in `libs/` show errors only.
- The catalog format and the marks in the view: [LIBRARIES.md](LIBRARIES.md).

### Multi-File Operations
- **List All Locations** — browse all locations across the file or project
- **List All Objects** — browse all objects (addobj) with their definition location
- **List All Variables** — browse all variables with usage summaries
- **Move Locations to File** — select locations and move them to another QSP file
- **Split Locations into Files** — select locations and create one `.qsps` file per location

### Analysis Status
- The `{}` item next to **QSP** in the status bar shows what the language server is doing: a spinner while it starts, loads the project (with a file count) or analyzes a large file, then **Ready** with the project size.
- It also warns about degraded modes: **Limited mode** when the tree-sitter parser failed to load (regex-only analysis), and **Reduced analysis** when the server ran short of memory (past 70% of its ~4 GB heap) and, rather than crash, stopped tracking locals passed between locations (and the checks built on them) and semantic highlighting until it restarts. Click it (or run **QSP: Show Language Server Log**) for the server log.

### Analysis Cache
A project opens faster the second time: the language server keeps each file's analysis on disk and reads it back instead of parsing the file again, as long as the file, the extension and the settings that shape the analysis are the same (a file that changed is analysed again). The diagnostics the project had last time are shown at once and replaced a few seconds later, when the cross-file analysis has checked them again. On a 20 MB game of 600 locations in 10 files, diagnostics now appear after 5.4 s instead of 36 s, and the full check ends at 16.7 s. The cache lives in VS Code's storage for this workspace, not in the project, takes about as much space as the game's sources, and cleans up entries unused for a month or beyond 500 MB. Turn it off with `qsp.cache.enabled`, or delete it with **QSP: Clear Analysis Cache**. The MCP server keeps a cache of its own ([MCP.md](MCP.md)). Not in VS Code for the Web, which analyses without tree-sitter.

### Performance Diagnostics
For large games (hundreds of locations, tens of megabytes), every analysis phase longer than a second (parsing, symbols, project aggregates, diagnostics) writes a `[perf]` line to **QSP: Show Language Server Log** with its time, a breakdown by step, and the heap before and after. Turn on `qsp.debug.performanceLog` to log every phase. The lines hold only numbers, never file, location or variable names. The server runs on VS Code's own runtime, whose heap is capped near 4 GB.

### Crash Reports
If the language server stops unexpectedly (for example it runs out of memory on a very large game), the extension saves a crash report to `.qsp/crash-reports/` in the project (the folder gets its own `.gitignore`, and the last five reports are kept) and tells you where the analysis was, e.g. *while analysing f01_l0007 (243 K chars, 4630 lines), step symbols, heap 3905 of 4096 MB*. The server records all the time, lightly: memory about every second, breadcrumbs when something looks wrong (the heap passing 50/70/85% of its limit, growing fast on one location, the analysis stuck on one location), the last locations it went through, and a heap sample near the limit. A server that was simply closed along with the editor gets no report, unless something was going wrong when it ended (the heap past half its limit, the analysis stuck or the heap growing fast in its last two minutes, an uncaught error). Turn it off with `qsp.crashReports.enabled`.
- Files and locations appear in the report only under neutral names (`f01`, `f01_l0007`). What they stand for is saved next to the report (`crash-….names.json`) for you, and is not part of it.
- With your consent (`qsp.crashReports.includeAnonymizedCode`: ask by default) the report can also carry the **anonymized code** of the location the server was stuck on: names become `var_0003`/`loc_0012`, the letters of strings and comments become x-es (their quotes, braces, markup, `exec:` links and `<<…>>` code stay), numbers 0. It keeps the structure that made the analysis fail, so the problem can be reproduced without the game. If you passed the offer by, **QSP: Add Anonymized Code to Crash Report** adds it to a saved report later, from the location as it is then (the table of names beside the report says which one it was).

### Anonymized Skeleton
When the analysis is slow or wrong on a game you can't share, **QSP: Export Anonymized Skeleton…** writes a copy of the whole game with only its structure left, to a folder you pick outside the workspace. Names are replaced word by word, one pseudonym per word across the game (`room_12` → `wabc_12`, and the string `'room_'` → `'wabc_'`, so `gt 'room_' + n` still finds its locations); a string made only of such words (`gs 'go', 'hall'`) is renamed too. Other text keeps its length with letters as x-es; numbers, code, the code in `<<…>>` and `exec:` links, `!@qsp-ignore` comments and line breaks stay. Files become `f01.qsps`, `f02.qsps`… in build order, libraries `libs/lib01.qsps`…. The analysis finds in it the same locations, jumps and diagnostics as in the game. What the pseudonyms and files stand for is saved beside the folder (`qsp-skeleton-….names.json`): keep it, don't send it. Look the skeleton over before sending it. From the command line: `npm run stress:skeleton -- <project> --out <folder>`. Not in VS Code for the Web.

### MCP Server (AI agents)
The extension ships an [MCP](https://modelcontextprotocol.io) server that lets AI agents work with a QSP project through the same analysis the editor uses, instead of plain text search.

See [MCP.md](MCP.md) for what each tool does and how to connect agents.

**Tools** (names are case-insensitive, lines are 1-based):
- **Reading the project:**
  - `qsp_list_locations`, `qsp_get_location`: list locations or get one's source.
  - `qsp_find_references`: where a location, variable or object is defined and used.
  - `qsp_diagnostics`: errors and warnings of the project or one file.
  - `qsp_check_code`: diagnostics of code that isn't saved yet.
  - `qsp_lookup_builtin`: documentation of a builtin. The whole reference is also the `qsp://builtins` resource.
  - `qsp_list_variables`, `qsp_list_objects`: every variable or object in the project.
- **`qsp_build`**: builds the `.qsp` like **Export QSP Game**, following `txt2gam.json`. It is never interactive: the password comes from the `qsp.game.password` setting.
- **`qsp_rename`, `qsp_format_location`**: rename a location, variable or object across the project, or format one location. Both only show the changes unless called with `apply: true`.

**In VS Code** (1.101+), the server is offered to agents such as Copilot agent mode automatically; turn it off with `qsp.mcp.enabled`.

**Other agents** (Cline, Claude Code, Cursor, Claude Desktop, …): run **QSP: Copy MCP Server Config** and paste the JSON into the agent's MCP configuration. The config starts the server with VS Code's own runtime, so no separate Node.js is needed; it points at the installed VS Code and extension versions, so copy it again after updating either. To start the server with your own Node.js instead, use Node.js 18 or newer, e.g. for Claude Code:
```
claude mcp add qsp -- node <extension folder>/out/mcp/server.js --workspace .
```
If the agent reports "Connection closed", its log shows the server's stderr: an older Node.js is reported there by name and version.

The server reads the files on disk: save files open in the editor before asking an agent to rename or format, and a file changed on disk after the analysis is not overwritten.

### Project Mode
- When `qsp.project.enabled` is true, all `.qsps`/`.qsrc` files in the workspace are treated as one combined game
- Cross-file diagnostics: duplicate locations, unresolved references, variable dataflow
- Cross-file completions, go-to-definition, and navigation

### Diagnostics
- **Syntax errors** from tree-sitter parsing
- **Duplicate locations** — within a file or across the project
- **Duplicate labels & actions** — scope-aware, only flags same-scope duplicates
- **Unclosed locations** — missing `---` closer
- **Uninitialized variables** — used but never assigned, chain-aware
- **Unresolved references** — location, label, action, and object refs
- **Unused definitions** — locations, labels, variables, and objects
- **Invalid function prefix** — built-in called with incompatible `$`/`#`/`%`
- **Invalid argument count** — built-in called with too few/many args
- **Mixed variable prefixes** — variable accessed with inconsistent `$`/`#`/`%`
- **Type mismatch** — assigning a string value to a `%` variable, etc.
- **Mixed location call types** — location called inconsistently (mix of func/gosub/goto/desc)
- **Inconsistent local propagation** — variable behaves as local or global depending on caller
- **Untracked dynamic calls** — `dynamic`/`dyneval` whose first argument can't be pinned to a single code block (complex expression, multiple global assignments, or multiple local code-block bindings across distinct scopes)
- **Embedded `exec:` analysis** — full symbol extraction and lint coverage for QSP code embedded in HTML `<a href="exec:…">` links inside displayed strings
- **Embedded `<<…>>` analysis** — interpolation bodies are parsed inline by the grammar; bodies corrupted by host doubled-quote escapes (e.g. `'<<f(''a'')>>'`) are decoded and re-parsed in a post-pass so diagnostics still fire
- **Missing `result` in function call** — function-style call (`@loc`, `func`, or `dyneval` block) that never assigns `result`
- **Extra args to target without `args`** — call passes extra positional arguments but the target location or inline code block never reads the `args` variable; the extras are silently discarded

#### Ignoring a finding in the code
When a finding is intended, silence it where it is with a QSP comment (the player ignores it). Checks are named by their code, the name of their `qsp.diagnostics.*` setting; after `:` you can name the variables, locations, labels, actions or objects it applies to (case and the `$`/`#`/`%` prefix don't matter):

- `!@qsp-ignore uninitializedVariables: счёт` on a line of its own: the next line with code.
- `*pl счёт & !@qsp-ignore uninitializedVariables` after `&`: this line.
- `!@qsp-ignore-location unusedVariables`: the whole location it is in.
- `!@qsp-ignore-file unresolvedLocationRefs: map`: the whole file.

Several directives can be stacked above one line; blank lines and notes between them and the code are skipped. Without a check name, every check is silenced there. A misspelled check name is reported and silences nothing. Syntax errors and duplicate location names can't be silenced: the game and the build can't work with them. To turn a check off for the whole workspace, set `qsp.diagnostics.<code>` to `false`.

The quick fix menu (**Ctrl+.** or the light bulb) on a diagnostic writes these comments for you: **Ignore … on this line**, **Ignore … in location …**, or **Turn off … checks in this workspace**, which sets the setting in `.vscode/settings.json` and offers **Undo**.
- **Shadows call-frame built-in** — `local args` / `local result` is unnecessary: both are already per-call-frame variables, so the `local` keyword has no effect at a location's top level and merely hides the outer value inside a nested scope
- **Shadows propagated local** — `local x` in a callee re-declares a name that one or more callers already propagate as a local

### Status Bar
- Shows the current location name at cursor position
- Click to open the Go to Location quick-pick

## Supported File Extensions

| Extension | Description |
|-----------|-------------|
| `.qsps`   | QSP source text file |
| `.qsrc`   | QSP source text file |

## Commands

| Command | Keybinding | Description |
|---------|-----------|-------------|
| QSP: Go to Location… | `Ctrl+Shift+L` | Quick-pick to jump to a location |
| QSP: New Location | — | Insert a new location block at end of file |
| QSP: Insert Location Separator | `Ctrl+Shift+-` | Insert `---` at cursor |
| QSP: Sort Locations (A → Z) | — | Sort all locations alphabetically |
| QSP: Sort Locations (Z → A) | — | Sort all locations reverse alphabetically |
| QSP: Duplicate Location… | — | Quick-pick a location to duplicate |
| QSP: Delete Location | — | Quick-pick a location to delete |
| QSP: Rename Location… | — | Rename a location via input box |
| QSP: Move Location Up | `Alt+Up` | Move the current location up |
| QSP: Move Location Down | `Alt+Down` | Move the current location down |
| QSP: Toggle Comment | `Ctrl+/` | Toggle `!` line comments |
| QSP: Format Location | `Ctrl+Shift+F` | Format the current location |
| QSP: List All Locations | — | Navigable list of all locations |
| QSP: List All Objects | — | Navigable list of all objects |
| QSP: List All Variables | — | Navigable list of all variables |
| QSP: Move Locations to File… | — | Select locations to move to another file |
| QSP: Split Locations into Files… | — | Split locations into individual `.qsps` files |
| QSP: Export QSP Game… | — | Combine source files and encode to a binary `.qsp` |
| QSP: Run QSP Game | `F5` | Export game and launch with the configured player |
| QSP: Import QSP Game… | — | Decode a `.qsp` binary back to `.qsps` text |
| QSP: Combine Project Files… | — | Merge all source files into a single `.qsps` file |

## Settings

### General

| Setting | Default | Description |
|---------|---------|-------------|
| `qsp.project.enabled` | `true` | Enable project mode: treat all `.qsps`/`.qsrc` files as one combined game |
| `qsp.syntaxVersion` | `5.9.5` | The QSP library the game is written for: `5.9.5` (the last release) or `5.9.6` (the library's development version). Constructs of a newer version are errors. Also picked from the `QSP 5.9.5` status bar item and saved in the workspace settings |
| `qsp.trace.server`    | `off`  | Traces LSP communication (`off`, `messages`, `verbose`) |
| `qsp.semanticHighlighting.enabled` | `true` | Enable semantic token highlighting (requires tree-sitter) |
| `qsp.locations.followCursor` | `true` | Select the location under the cursor in the QSP Locations view. |
| `qsp.mcp.enabled` | `true` | Offer the QSP MCP server to AI agents in VS Code (1.101+). |
| `qsp.game.playerExecutable` | — | Path to the QSP player executable used by Run Game. Set once and persisted globally. `playerExecutable` or `players` in `txt2gam.json` override it. |
| `qsp.game.mainFile` | — | Regular expression for the main file, searched in workspace-relative paths (e.g. `^main\.qsps$`). Overridden by `mainFile` in `txt2gam.json` |
| `qsp.game.mainFileStrategy` | `ask` | How the setup wizard picks the main file when none is configured: `ask` shows a list (dismiss → root files first), `root` puts root files first without asking |
| `qsp.game.buildMode` | `single` | `single` builds one combined `.qsp`; `perFile` builds each source into its own `.qsp` next to it. Overridden by `buildMode` in `txt2gam.json` |
| `qsp.cache.enabled` | `true` | Keep analysis results on disk so an unchanged project opens without being analysed again (next server start) |
| `qsp.libraries.sources` | `[]` | URLs of `libraries.json` catalogs for the **QSP Libraries** view; the first catalog wins when two offer the same library. |
| `qsp.game.password` | — | Default game password for export/import (leave blank for no password) |
| `qsp.game.promptPassword` | `true` | Prompt for a password before each export |

### Diagnostics

All diagnostic checks are enabled by default. Set to `false` to disable a specific check. Each diagnostic shows its check's name as its code (e.g. `qsp(uninitializedVariables)` in the Problems panel), the same name as its setting; syntax errors have the code `syntax`.

| Setting | Default | Description |
|---------|---------|-------------|
| `qsp.diagnostics.duplicateLocations` | `true` | Report duplicate location names |
| `qsp.diagnostics.duplicateLabels` | `true` | Warn about duplicate labels within the same location |
| `qsp.diagnostics.duplicateActions` | `true` | Info about duplicate act statements |
| `qsp.diagnostics.unreachableLabels` | `true` | Warn about labels that are not at the start of a line (unreachable at runtime) |
| `qsp.diagnostics.unclosedLocations` | `true` | Error about locations not closed with `---` |
| `qsp.diagnostics.uninitializedVariables` | `true` | Warn about variables used but never assigned |
| `qsp.diagnostics.unresolvedLocationRefs` | `true` | Warn about refs to undefined locations |
| `qsp.diagnostics.unresolvedLabelRefs` | `true` | Warn about jump targets not defined in the location |
| `qsp.diagnostics.unresolvedActionRefs` | `true` | Warn about refs to undefined actions |
| `qsp.diagnostics.unresolvedObjectRefs` | `true` | Warn about refs to objects not added |
| `qsp.diagnostics.unusedLocations` | `true` | Hint about locations defined but never called |
| `qsp.diagnostics.unusedLabels` | `true` | Hint about labels defined but never jumped to |
| `qsp.diagnostics.unusedVariables` | `true` | Hint about variables assigned but never read |
| `qsp.diagnostics.unusedObjects` | `true` | Hint about objects added but never referenced |
| `qsp.diagnostics.invalidFunctionPrefix` | `true` | Warn when function called with wrong type prefix |
| `qsp.diagnostics.unsupportedSyntax` | `true` | Error on constructs the chosen `qsp.syntaxVersion` doesn't have: in 5.9.5 `?`, `INSVAR`, `ARRKEY`, `ALIAS`, unary plus, a space after `@`, a tab before the `_` that joins lines; in 5.9.6 a name with `\ ; ^ @ ?` in it, or a variable named `alias` |
| `qsp.diagnostics.systemVariablePrefix` | `true` | Warn when a system variable is written with a prefix of another type than it holds (`$usehtml`, `fname`): QSP 5.9.5 ignores such a value. Off for `qsp.syntaxVersion` 5.9.6, which converts it |
| `qsp.diagnostics.invalidBuiltinArgCount` | `true` | Warn when built-in called with wrong arg count |
| `qsp.diagnostics.deprecatedBuiltins` | `true` | Warn about outdated built-ins (e.g. `ADDQST` instead of `INCLIB`) and strike them through |
| `qsp.diagnostics.mixedVariablePrefixes` | `true` | Info when variable uses inconsistent type prefixes |
| `qsp.diagnostics.typeMismatch` | `true` | Info when assigning wrong type to a variable |
| `qsp.diagnostics.mixedLocationCallTypes` | `true` | Info when location is called inconsistently (mix of func/gosub/goto/desc) |
| `qsp.diagnostics.inconsistentLocalPropagation` | `true` | Warn when local propagation varies by caller |
| `qsp.diagnostics.untrackedDynamicCalls` | `true` | Info when dynamic call can't be statically resolved |
| `qsp.diagnostics.missingResultInFunctionCall` | `true` | Warn when `@loc` / `func` / `dyneval` block never assigns `result` |
| `qsp.diagnostics.extraArgsToTargetWithoutArgs` | `true` | Info when call passes extra args but target never reads `args` |
| `qsp.diagnostics.shadowsCallFrameBuiltin` | `true` | Info on unnecessary `local args` / `local result` declarations |
| `qsp.diagnostics.shadowsPropagatedLocal` | `true` | Info when `local x` in a callee shadows a propagated-in local |
| `qsp.diagnostics.maxErrorsPerLocation` | `20` | Max syntax errors reported per location |
| `qsp.diagnostics.maxLocationLines` | `500` | Max lines per location (0 = unlimited) |

## QSP Language Basics

QSP files are organized into **locations** — named blocks delimited by `#` and `---`:

```qsp
# start
pl 'Hello, world!'
act 'Go north':
  goto 'room1'
end
---

# room1
$name = 'Player'
pl 'Welcome, <<$name>>'
---
```

Key concepts:
- **`$`** prefix → string variable (`$name`)
- **`#`** prefix → numeric variable (`#count`)
- **`%`** prefix → tuple variable (`%arr`)
- **`!`** — line comment
- **`&`** — statement separator (multiple statements on one line)
- **`<<expr>>`** — string interpolation

## Development

Building, testing and the rules for changes are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MPL-2.0](LICENSE). The extension bundles third-party libraries under their own licenses, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
