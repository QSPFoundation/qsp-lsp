# QSP libraries

A library is one `.qsps` file of locations that a game loads when it needs them, with `INCLIB`, and drops with
`FREELIB`. The **QSP Libraries** view in the Explorer installs libraries from two kinds of sources: GitHub
repositories, whose latest release holds the libraries, and `libraries.json` catalogs.

## For game authors

1. Add a source to the `qsp.libraries.sources` setting: a repository that publishes its libraries in releases,
   `https://github.com/<user>/<repo>`, or the URL of a catalog,
   `https://raw.githubusercontent.com/<user>/<repo>/main/libraries.json`.
2. In **QSP Libraries**, click the download button next to a library (or run **QSP: Add Library**). The view
   downloads it and checks its checksum. It also checks that none of its locations has the same name as one in
   the game or in another installed library. Only then does it write `libs/<id>.qsps` and add the library to
   `txt2gam.json`. Libraries it requires are installed along with it.
3. Add the lines the view offers (**Insert at Cursor** or **Copy**) to the game. Usually that is an
   `INCLIB 'libs/<id>.qsp'` and a call to the library's start location.

Every build encodes each library into `libs/<id>.qsp` in the folder of the game's `.qsp` (the `outputFile` of
`txt2gam.json`, or the main file's `.qsp` in the `perFile` mode), and never into the game's `.qsp`: `INCLIB` finds a
library by its path from the game.

**Duplicate names stop the build.** If two locations share a name anywhere in the game and its libraries, the
build writes nothing and lists every place. A player reaches only one location of a given name: `INCLIB` skips a
library location whose name the game already has, and says nothing.

**Marks in the view:**
- an update arrow: the catalog has a newer version;
- a pencil: the file was changed by hand (an update asks before replacing it);
- a red mark: the file is missing (the build stops until you update or remove the library).

Files in `libs/` show errors only. Warnings about a library's unused locations or variables are left out: they
are not yours to fix.

## For library authors: GitHub releases

The simplest way to publish: attach the built `.qsps` to a GitHub release. Game authors add
`https://github.com/<user>/<repo>` to their sources, and the view reads the repository's latest release (not a
draft or a pre-release):

- every attached `.qsps` is a library, named by its file (`dialogs.qsps` is `dialogs`, installed as
  `libs/dialogs.qsps`);
- the release's tag is its version (`v1.2.0` is `1.2.0`): a new release offers the update;
- GitHub's SHA-256 of each attached file is its checksum, so there is nothing to compute by hand.

To give names, descriptions, usage lines or requirements, attach a `libraries.json` (the format below) to the same
release. Its `file` is the name of an attached file, and `version` and `sha256` may be left out: they default to the
tag and to GitHub's checksum.

The built `.qsps` then lives in the release, not in the repository. If you keep a copy in the repository anyway,
list its folder in a `.qspignore` file at the repository's root (`_export/`), or put it in a folder whose name
starts with a dot: the analysis leaves it out, and its locations aren't reported twice.

A release can be made by CI: on a pushed tag, join the library's sources into one `.qsps` and attach it, e.g.
with `gh release create "$GITHUB_REF_NAME" dialogs.qsps`.

Limits:
- GitHub answers 60 requests an hour without signing in; the view makes one per repository each time it loads the
  catalogs. Signed in to GitHub in VS Code (the Accounts menu), the limit is 5000. Only public repositories work.
- In vscode.dev, files of releases can't be downloaded: GitHub doesn't allow it from a web page. Use a
  `libraries.json` on `raw.githubusercontent.com` there.
- Files attached before mid-2025 have no checksum on GitHub: attach them again, or give `sha256` in a
  `libraries.json`.

## For library authors: `libraries.json`

```json
{
  "schema": 1,
  "libraries": [
    {
      "id": "dialogs",
      "name": "Dialogs",
      "description": { "en": "Dialog boxes with choices", "ru": "Диалоги с выбором" },
      "version": "1.2.0",
      "file": "dialogs/dialogs.qsps",
      "sha256": "<SHA-256 of the file, 64 hex digits>",
      "usage": "inclib 'libs/dialogs.qsp'\ngs 'dialogs_init'",
      "requires": ["utils"]
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `schema` | no | Catalog format; this extension reads `1` and refuses newer ones. |
| `id` | yes | File name in the game: `libs/<id>.qsps`. Latin letters, digits, `_`, `-`, `.`. |
| `name` | no | Shown in the view (defaults to `id`). |
| `description` | no | A string (English) or text per language; the editor's language is shown, else English. |
| `version` | yes, except in a release | Compared part by part (`1.10` is newer than `1.9`) to offer updates. In a release, defaults to its tag. |
| `file` | yes | The `.qsps`, relative to `libraries.json` (or a full URL). |
| `sha256` | yes, except in a release | Checksum of the file's bytes; a download that doesn't match is refused. In a release, defaults to GitHub's checksum of the attached file. |
| `usage` | no | Lines to add to the game; defaults to `inclib 'libs/<id>.qsp'`. |
| `requires` | no | Ids of libraries, from any configured catalog, installed first. |

Suggestions for a library repository:
- Start every location name with the library's id (`dialogs_…`). Then libraries can't clash with each other or,
  likely, with games.
- Recompute `sha256` whenever a file changes (`sha256sum dialogs/dialogs.qsps`). In CI, check that the sums
  match and that no two libraries share a location name.
- Keep entries with problems out: the view skips them and says why in **QSP Libraries** and in the extension's
  log.
