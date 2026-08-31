# Installation & Running

## Prerequisites

- **Node.js** >= 18
- **pnpm** >= 8 — install via `npm install -g pnpm` or `corepack enable`

## Install

```bash
cd Portfolio/Apps/AI/llm-toolkit   # or this checkout
pnpm install
# or:
make install                       # deps + launcher on PATH + completions
```

This installs all workspace dependencies across the four packages (`api`, `cli`, `web`, `shared`).

### macOS app

The native Mac host lives at `apps/macos` and is not part of `make install`
(that target is the CLI launcher + completions, and must stay valid without
Swift). After the JS stack is installed:

```bash
make install-osx        # build LLM Toolkit.app and copy it to /Applications
make macos              # swift test + debug build
make macos-run          # launch without installing
```

`make install-osx` (`install-macos`, `install/osx`, and `install/macos` are
aliases) is the binplace step. Override the destination with
`INSTALL_DIR=$HOME/Applications`. Requires macOS 14+ and Swift 5.10+. See
`apps/macos/README.md`.

## Development

### Run everything

Open separate terminals (or use a multiplexer):

```bash
# Terminal 1 — API server (Hono on tsx, auto-reloads)
pnpm dev:api

# Terminal 2 — Web UI (Vite, hot reload)
pnpm dev:web

# Terminal 3 — CLI (Ink, auto-reloads)
pnpm dev:cli
```

### Run a single package

```bash
pnpm --filter @llm-toolkit/api dev
pnpm --filter @llm-toolkit/web dev
pnpm --filter @llm-toolkit/cli dev
```

## Build

```bash
pnpm build          # Build all packages
```

Or individually:

```bash
pnpm --filter @llm-toolkit/api build
pnpm --filter @llm-toolkit/web build
pnpm --filter @llm-toolkit/cli build
```

## Test

```bash
pnpm test           # Run tests across all packages
```

Or individually:

```bash
pnpm --filter @llm-toolkit/api test
pnpm --filter @llm-toolkit/web test
pnpm --filter @llm-toolkit/cli test
```

The web package also supports watch mode:

```bash
pnpm --filter @llm-toolkit/web test:watch
```

## Type Checking

```bash
pnpm typecheck      # Type-check all packages (tsc --noEmit)
```

## Clean

```bash
pnpm clean          # Remove dist/ directories from all packages
```

## Packages

| Package | Path | Description |
|---------|------|-------------|
| `@llm-toolkit/api` | `packages/api/` | TypeScript API server (Hono + tsx) |
| `@llm-toolkit/cli` | `packages/cli/` | Interactive CLI (Ink — React for terminals) |
| `@llm-toolkit/web` | `packages/web/` | React frontend (Vite + Tailwind) |
| `@llm-toolkit/shared` | `packages/shared/` | Shared types and utilities |

## CLI Usage

After building, run the CLI directly:

```bash
npx tsx packages/cli/bin.ts
```

Or link it locally:

```bash
pnpm --filter @llm-toolkit/cli link --global
llm-toolkit
```

## Shell Completions

```bash
make install-completions   # or just `make install`, which runs this too
```

Installs bash completion to
`${XDG_DATA_HOME:-~/.local/share}/bash-completion/completions/llm-toolkit`
and zsh completion to
`${XDG_DATA_HOME:-~/.local/share}/zsh/site-functions/_llm-toolkit`. Add the
zsh site-functions dir to `fpath` before `compinit` runs (the target prints
this line if `.zshrc` doesn't already have it):

```zsh
fpath=(~/.local/share/zsh/site-functions $fpath)
```
