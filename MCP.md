# QSP MCP server: tools overview

The QSP extension includes an [MCP](https://modelcontextprotocol.io) server. It gives AI agents the same understanding of a QSP project that the editor has: agents see the project's structure and diagnostics instead of plain text search.

- **VS Code 1.101+:** agents such as Copilot agent mode get the server automatically. Turn it off with the `qsp.mcp.enabled` setting.
- **Other agents** (Cline, Claude Code, Cursor, Claude Desktop): run **QSP: Copy MCP Server Config** and paste the result into the agent's MCP settings. See [Connecting other agents](#connecting-other-agents).

In every tool, names of locations, variables and objects are case-insensitive, and line numbers start at 1.

## Understanding the project

| Tool | What it does |
|---|---|
| `qsp_list_locations` | Lists every location with its file and line range. An optional `filter` keeps only names that contain the given text. |
| `qsp_get_location` | Returns the full source of one location, from its `# name` header to its `---` line. |
| `qsp_find_references` | For a location, variable or object, finds where it is defined and every place it is used: `gt`/`goto`/`gosub`/`xgoto` jumps, `@` calls, reads and writes, `addobj`/`delobj`. |
| `qsp_list_variables` | Lists the project's variables, whether each is local, and where it is first defined or used. |
| `qsp_list_objects` | Lists the inventory objects the project adds or refers to. |
| `qsp_lookup_builtin` | Returns the signature and description of a QSP statement, function or system variable. |

## Checking code

| Tool | What it does |
|---|---|
| `qsp_diagnostics` | Returns the errors and warnings that the editor shows, for the whole project or for one file. |
| `qsp_check_code` | Checks QSP code that isn't saved anywhere and returns its diagnostics. This lets an agent validate code before writing it to a file. Code without a `# name` header is checked as the body of a location. |

## Building and editing

| Tool | What it does |
|---|---|
| `qsp_build` | Builds the `.qsp` game with txt2gam the same way **Export QSP Game** does: file order, main file and output come from `txt2gam.json` and the `qsp.game.*` settings. In `single` mode the whole project becomes one game file; in `perFile` mode each source file becomes its own `.qsp`. Libraries listed in `txt2gam.json` are always built into `.qsp` files of their own. Output files whose content wouldn't change are not rewritten. Nothing is written when two locations share a name; the error lists every place. |
| `qsp_rename` | Renames a location, variable or object across the whole project, like the editor's **Rename**. |
| `qsp_format_location` | Re-indents one location, like the editor's **Format**. |

Both edit tools only show the proposed changes unless they are called with `apply: true`. When they apply changes:
- each file keeps its encoding, BOM and line endings;
- a file that changed on disk since the analysis is not overwritten.

`qsp_build` never asks questions: the game password comes from the `qsp.game.password` setting.

## Resources

- `qsp://builtins` — the complete reference of QSP builtins, as Markdown.

## Connecting other agents

**QSP: Copy MCP Server Config** copies a config like this:

```json
{
  "mcpServers": {
    "qsp": {
      "command": "<path to VS Code's runtime>",
      "args": ["<extension folder>/out/mcp/server.js", "--workspace", "<your project folder>"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

It starts the server with VS Code's own runtime, so no separate Node.js is needed. The paths point at the installed VS Code and extension versions: copy the config again after updating either.

To start the server with your own Node.js instead, use Node.js 18 or newer, for example in Claude Code:

```
claude mcp add qsp -- node <extension folder>/out/mcp/server.js --workspace .
```

If the agent reports `MCP error -32000: Connection closed`, the server stopped before it could answer. The agent's MCP log shows the server's stderr; a Node.js older than 18 is reported there by version and path.

## Notes

- **The server keeps an analysis cache,** as the editor does: an unchanged project file is read back instead of analysed again, so the next start of the server is faster (a 7 MB game: ready after 1.6 s instead of 9.7 s). It lives in the user's cache directory (`~/.cache/qsp-lsp/mcp/` on Linux, `~/Library/Caches/qsp-lsp/mcp/` on macOS, `%LOCALAPPDATA%\qsp-lsp\mcp\` on Windows, or under `$XDG_CACHE_HOME`), a folder per project, never in the project. `--cache-dir <folder>` puts it elsewhere, `--no-cache` or `"qsp.cache.enabled": false` in the project's `.vscode/settings.json` turns it off. Entries unused for a month, or beyond 500 MB, are deleted.
- **The server only sees files on disk.** Save files that are open in the editor before asking an agent to rename or format them.
- **Diagnostics cover every project file.** This includes files that are not open in the editor.
