# SCR-45 — Promo / Download Page (powertoys.therobotlives.com)

- **id**: SCR-45
- **name**: Promo / Download Page
- **surface**: marketing (static site)
- **type**: primary
- **category**: Discovery
- **status**: implemented — Elixir **Hologram app** at
  `Portfolio/WebApps/Brand/powertoys.therobotlives.com/app/` (route `/`,
  SSR-first, no commands — donate is an external Stripe Payment Link). The
  earlier static prototype under the same project's `site/` is kept as a
  frozen design reference and will drift from the live page.

## Purpose

Public open-source promotion + downloads page for llm-toolkit, hosted at
`powertoys.therobotlives.com` (first product under the "Power Toys" umbrella;
more tools will join the site later). Drives three conversions:

1. **View source** → `github.com/the-robot-lives/llm-toolkit`
2. **Get LLM Toolkit** → install instructions (clone + `make install`, `make install-osx`, `pnpm dev`)
3. **Donate** → Stripe Payment Link (pay-what-you-want)

## Design

Nocturne (80%) + Minimal Tech (20%) — dark-only, per `design/style-guide.md`.
Tokens mirror `packages/web/tailwind.config.js` (void/canvas/surface ramp,
Plasma Cyan `#06B6D4` accent, Inter + JetBrains Mono). Logo assets reused from
`design/logos/claude-assist-*`.

## Sections

| Section | Contents |
|---|---|
| Header (sticky) | Logo, anchor nav, donate button |
| Hero | Tagline, CTAs (Get / View source / Donate), fact chips (local-first, MIT, v0.0.1), kawaii mascot |
| Capabilities | Bento grid (8 cards): search (FTS5 + vectors), thread viewer, non-destructive edit, **harness transfer (move conversations Claude ↔ Codex)**, **AI-assisted revise**, **user-controlled compact**, datasets, **one control plane (skills + commands + MCPs)** |
| Robot interstitial A | Parallax scene: "context archaeology" — kawaii robot digging through JSONL archives (ambient CSS keyframe layers, scroll-linked caption only, reduced-motion safe) |
| Install | 3-step cards: clone+`make install`, macOS app, run from source |
| Robot interstitial B | Parallax scene: "packing your bags" — robot juggling provider-labeled suitcases |
| Quickstart | Terminal block: `recent`, `search`, `list`, `skill list` |
| Donate | Stripe payment link CTA (heartbeat-glow button) |
| Footer | GitHub / Issues / Donate, "more tools coming soon — the robots are building", MIT |

Design direction: Nocturne + Plasma Cyan base, **cute-ified** — original kawaii
vector robots, chunkier radii, idle animations (bob/blink/antenna pulse), all
gated by `prefers-reduced-motion`. Parallax technique follows the
therobotplans.com family pattern (ambient layers on their own clock; never
scroll-couple the robot).

## Notes

- Donation is a Stripe **Payment Link** (`custom_unit_amount`, min $1) — no
  backend on this site. Link shared with the elixirgenai.dev donate button.
- Deploy pattern follows `elixirgenai.dev` (nginx static image → helm →
  argocd); see site project `README.md` for the deploy checklist. Explicit
  Cloudflare A record required (wildcard CNAME alone routes to derobot.is).
