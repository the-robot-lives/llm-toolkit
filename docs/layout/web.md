# packages/web — Browser UI

Vite + React + Tailwind SPA. Browser talks to `:3100` via Vite proxy in dev; the Mac host loads the API-served `dist`.

```
web/
├── src/
│   ├── components/
│   │   ├── Layout.tsx          # sidebar (Skills first in Library); hides chrome for Mac
│   │   └── MarkdownView.tsx
│   ├── hostBridge.ts           # Mac-host navigate / native-chrome flags
│   ├── context/HarnessContext.tsx
│   ├── hooks/useApi.ts
│   ├── pages/
│   │   ├── Explore.tsx         # / /search /browse
│   │   ├── Thread.tsx
│   │   ├── Edit.tsx
│   │   ├── Convert.tsx
│   │   ├── ContinueSession.tsx
│   │   ├── Datasets.tsx / DatasetDetail.tsx
│   │   ├── ArtifactBrowser.tsx # shared Skills/Agents/Commands/MCP catalog UI
│   │   ├── Skills.tsx          # /skills
│   │   ├── Agents.tsx          # /agents
│   │   ├── Commands.tsx        # /commands
│   │   ├── Mcp.tsx             # /mcp
│   │   ├── Prompts.tsx
│   │   ├── Tags.tsx
│   │   ├── Projects.tsx / ProjectDetail.tsx
│   │   ├── Settings.tsx
│   │   ├── SafetyWatch.tsx
│   │   └── StyleGuide.tsx
│   ├── services/sessionWorkflow.ts
│   ├── App.tsx
│   └── main.tsx
├── public/favicon.svg
├── index.html
├── package.json
├── vite.config.ts
└── vitest.config.ts
```
