# LLM Toolkit for macOS

Native Mac host for llm-toolkit. It starts or attaches to the local Hono
process (`:3100`) and loads the console the API itself serves. There is no
separate Vite/web connection and no connection sheet.

## Requirements

- macOS 14+
- Xcode / Swift 5.10+
- Node 18+ and pnpm 8+ (to run the local API + Vite console)

## Run

From this directory:

```bash
make run          # swift run LLMToolkit
make test         # route catalog + locator + launch-plan tests
make app          # assemble .build/LLM Toolkit.app
make install      # same as make install-osx from the repo root
```

From the toolkit root:

```bash
make install-osx  # build + copy /Applications/LLM Toolkit.app
make macos        # tests + debug build
make macos-run    # launch the Mac app without installing
```

`make install` is the CLI + completions path and does not install the .app.
`install-osx`, `install-macos`, `install/osx`, and `install/macos` are aliases.
Override the destination with `INSTALL_DIR=$HOME/Applications`.

On first launch the app probes `http://localhost:3100/api/health`. If that
is down it locates the checkout, builds the console into `packages/web/dist`
if needed, and starts `pnpm dev:api`. Override the checkout with
`LLM_TOOLKIT_ROOT` or Settings → Checkout.

## Console map (parity)

| Mac destination | Web route |
|---|---|
| Explore | `/`, `/search`, `/browse` |
| Safety Watch | `/safety-watch` |
| Thread / Edit / Convert / Continue | `/thread/:id`, `/edit`, `/convert`, `/continue` |
| Datasets / Dataset | `/datasets`, `/datasets/:name` |
| Prompts | `/prompts` |
| Skills | `/skills`, `/skills/:name` |
| Agents | `/agents`, `/agents/:name` |
| Commands | `/commands`, `/commands/:name` |
| MCP | `/mcp`, `/mcp/:name` |
| Tags | `/tags` |
| Projects / Project | `/projects`, `/projects/:slug` |
| Settings | `/settings` |
| Style Guide | `/style-guides`, `/style-guides/:slug` |

Merge (`SCR-08`) is not a web route yet, so it is not in the Mac app either.

Menus: **Go** (⌘1–⌘9), **Harness**, **Conversation** (edit/convert/continue/clone/archive), **Index**.

When *Use native Mac chrome* is on (default), the web sidebar/header hide and
the SwiftUI sidebar drives the same pages. Turn it off in Settings to see the
browser chrome unchanged.

## Branding

Timely-style generated art lives under `Assets/` and is compiled into the
bundle:

| Asset | Use |
|---|---|
| `Assets/LLMToolkitIcon-1024.png` | Dock / app icon master |
| `Resources/LLMToolkit.icns` | `CFBundleIconFile` |
| `WatchdogHero.png` | Connection pane banner |
| `WatchdogCompanion.png` | Sidebar + Settings mark |

```bash
make icon   # iconset + icns from the 1024 master
```

Prompt contracts: `Assets/*.media.prompt`.

## Layout

```
apps/macos/
├── Package.swift
├── Makefile
├── Info.plist
├── Sources/LLMToolkitKit/     # routes, prefs, locator, stamp, health, API, supervisor
├── Sources/LLMToolkit/        # SwiftUI app, WKWebView host, menus
└── Tests/LLMToolkitTests/
```
