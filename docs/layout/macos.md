# apps/macos — Native Mac host

SwiftUI app that hosts the API-served SPA in WKWebView (`:3100`). Same routes as the browser; native sidebar/menus when chrome is on.

```
macos/
├── Package.swift
├── Makefile                    # build / test / run / app / install-osx
├── Info.plist                  # com.noizu.llm-toolkit
├── README.md
├── Assets/                     # icon masters + media.prompt
├── Resources/                  # LLMToolkit.icns / iconset
├── scripts/generate-app-icon.sh
├── Sources/
│   ├── LLMToolkitKit/          # Testable core
│   │   ├── ConsoleRoute.swift  #   1:1 map of packages/web/src/App.tsx
│   │   ├── Harness.swift
│   │   ├── AppPreferences.swift
│   │   ├── ToolkitLocator.swift
│   │   ├── ToolkitRootStamp.swift
│   │   ├── HealthClient.swift
│   │   ├── ToolkitAPIClient.swift
│   │   └── ServerSupervisor.swift
│   └── LLMToolkit/             # App target
│       ├── LLMToolkitApp.swift
│       ├── AppModel.swift
│       ├── AppCommands.swift   # Go ⌘1–⌘9; Agents/Commands/MCP unnumbered
│       ├── Branding.swift
│       ├── Theme/Nocturne.swift
│       └── Views/
│           ├── ContentView.swift
│           ├── SidebarView.swift
│           ├── ConsoleWebView.swift
│           ├── ConnectionPane.swift
│           └── SettingsView.swift
└── Tests/LLMToolkitTests/
```

`hostBridge.ts` lets the host hide web chrome and drive navigate/harness. Install stamps checkout path into `Contents/Resources/toolkit-root.txt`.
