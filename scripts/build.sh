#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# QSP LSP — Build & Package Script
#
# Usage:
#   ./scripts/build.sh                 # build at current package.json version
#   ./scripts/build.sh 1.2.3           # set version to 1.2.3, then build
#   ./scripts/build.sh --check         # lint + test only (no package)
#
# The script will:
#   1. Optionally bump the version in package.json
#   2. Install dependencies (if needed)
#   3. Generate the tree-sitter parser + WASM
#   4. Run tree-sitter tests
#   5. Build server & client bundles
#   6. Type-check (tsc --noEmit)
#   7. Run vitest
#   8. Lint
#   9. Package the VSIX
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# ── Colours ──────────────────────────────────────────────────────────────────
red()   { printf '\033[1;31m%s\033[0m\n' "$*"; }
green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[1;34m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

# ── Helpers ──────────────────────────────────────────────────────────────────
step() { blue "── $* ──"; }
ok()   { green "✓ $*"; }
die()  { red "✗ $*" >&2; exit 1; }

# ── Parse args ───────────────────────────────────────────────────────────────
CHECK_ONLY=false
VERSION=""

for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=true ;;
    --help|-h)
      echo "Usage: $0 [VERSION] [--check]"
      echo ""
      echo "  VERSION    Semver version to set (e.g. 1.2.3)"
      echo "  --check    Run lint + tests only, skip build & package"
      exit 0
      ;;
    *)
      if [[ -z "$VERSION" && "$arg" != --* ]]; then
        VERSION="${arg#v}"
      else
        die "Invalid argument: $arg"
      fi
      ;;
  esac
done

# ── Version ──────────────────────────────────────────────────────────────────
# vsce package requires strict semver: MAJOR.MINOR.PATCH with optional
# -prerelease and +build metadata.  Validate up-front so we fail fast
# rather than partway through the build.
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'

if [[ -n "$VERSION" ]]; then
  if [[ ! "$VERSION" =~ $SEMVER_RE ]]; then
    die "Invalid version: '$VERSION' (expected semver like 1.2.3 or 1.2.3-rc.1)"
  fi
  step "Setting version to $VERSION"
  npm pkg set version="$VERSION"
  ok "package.json version → $VERSION"
else
  VERSION=$(node -p "require('./package.json').version")
  dim "Using existing version: $VERSION"
fi

# ── Dependencies ─────────────────────────────────────────────────────────────
if [[ ! -d node_modules ]]; then
  step "Installing dependencies"
  npm ci
  ok "Dependencies installed"
fi

# ── Grammar ──────────────────────────────────────────────────────────────────
step "Generating tree-sitter parser & WASM"
(
  cd tree-sitter-qsp
  npx tree-sitter generate
  npx tree-sitter build --wasm
  npx tree-sitter test
)
ok "Tree-sitter parser, WASM and tests OK"

# ── Tests & Lint ─────────────────────────────────────────────────────────────
step "Building bundles"
mkdir -p out
npm run build:server:node
npm run build:server:browser
npm run build:client:node
npm run build:client:browser
npm run build:copy-wasm
cp tree-sitter-qsp/tree-sitter-qsp.wasm out/
ok "Bundles built"

step "Type-checking"
npx tsc --noEmit
ok "Types OK"

step "Running tests"
npx vitest run
ok "Tests passed"

step "Linting"
npx eslint
ok "Lint passed"

if $CHECK_ONLY; then
  green ""
  green "═══════════════════════════════════════"
  green "  All checks passed (v$VERSION)"
  green "═══════════════════════════════════════"
  exit 0
fi

# ── Package ──────────────────────────────────────────────────────────────────
step "Packaging VSIX"
VSIX_FILE="qsp-lsp-${VERSION}.vsix"
npx @vscode/vsce package --no-dependencies -o "$VSIX_FILE"
ok "Packaged: $VSIX_FILE ($(du -h "$VSIX_FILE" | cut -f1))"

green ""
green "═══════════════════════════════════════"
green "  Build complete: $VSIX_FILE"
green "═══════════════════════════════════════"
