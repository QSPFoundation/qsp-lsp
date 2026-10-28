# Contributing to QSPeak

## Building and testing

```bash
# Install dependencies
npm install

# Build everything (grammar WASM + server + client)
npm run build

# Watch mode
npm run watch

# Run tests
npm test

# UI tests: run inside a downloaded VS Code (needs a display; use xvfb-run on a headless Linux)
npm run test:ui
```

Debug configurations are in `.vscode/launch.json` (open this repository in VS Code, then **Run and Debug**):
- **Run Extension** (**F5**) — builds the bundles and opens an Extension Development Host on `examples/`.
- **Run Extension (Web)** — the same with the browser bundle, as on vscode.dev.
- **Attach to Language Server** — attaches to the server on port 6009; **Extension + Language Server** starts both.
- **UI Tests** — runs `test/ui` under the debugger.

## Before a pull request

- Run `npm run check`: what CI runs (grammar tests, bundles, type-check, tests, lint, third-party notices). `npm run release` also packages the VSIX.
- Add a line to `CHANGELOG.md` under **Unreleased** for what users notice.
- After a dependency change, run `node scripts/thirdPartyNotices.mjs`; CI checks `THIRD_PARTY_NOTICES.md`.

## Commits

- One line in the imperative, about 50–72 characters (`Add the Jump Graph panel`), with no body or trailers. The details go in the pull request description, what users notice in `CHANGELOG.md`.
- One logical change per commit, each passing `npm run check` on its own.
- A linear history: update a branch with `git rebase`, never merge; pull requests are integrated by rebase or fast-forward.

## The code base

The architecture, the invariants the code relies on and its conventions are in [CLAUDE.md](CLAUDE.md) (it also guides AI coding agents working in this repository); planned work, with what is known of it, is in [TODO.md](TODO.md).
