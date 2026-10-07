# Test Health — llm-toolkit
_Last measured: 2026-10-07 · branch develop@16d7ab1 (+ chore/ci-test-speed)_

Before this change the repo had **no `.github/workflows`**: every suite below ran only by hand.
The "~265 JS test files" in the fleet inventory were `node_modules` fixtures; the real JS suite is
39 Vitest files across the four pnpm packages.

| Metric | Before | After |
|---|---|---|
| CI PR wall-clock — critical path (warm / cold) | no CI | see PR / report (parallel `js` + 2 `rust` legs) |
| Main release build (warm / cold) | n.a. (no image; CLI/lib) | n.a. |
| CI acceptance test job (warm / cold) | no CI | see PR / report |
| Local full-suite runtime (uptime load) | JS 17s (load 28) · Rust skill-manage + claude-memory < 1s test time | same |
| Docker build (warm / cold) | n.a. | n.a. |
| Tests in acceptance / slow tier | 0 run in CI | JS 233 (+8 skipped) · Rust 11 + 31 / slow 0 |
| Async modules / total | n.a. (Vitest file-parallel) | n.a. |
| Coverage — acceptance pass (lines) | unmeasured | shared 57.9% · api 52.8% · cli 27.5% · web 27.9% · skill-manage 24.2% · claude-memory 93.8% |
| Coverage — full pass | = acceptance | = acceptance |
| Coverage gate | — | shared 52 · api 47 · cli 22 · web 22 · skill-manage 19 · claude-memory 88 |

Gates live in `packages/*/vitest.config.ts` (`coverage.thresholds.lines`) and the `rust` matrix
`min_lines` in `.github/workflows/ci.yml` (`cargo llvm-cov --fail-under-lines`).

## Hermeticity
`test/strip-provider-env.ts` is the first Vitest setup file in every package: it deletes
`*_API_KEY`, `*_BASE_URL`, `*_AUTH_TOKEN` and known provider-prefixed vars (ANTHROPIC, OPENAI,
OLLAMA, LITELLM, …) before any module copies them into config, so no test can reach a real model.
Verified locally with a shell carrying live provider keys.

## Caching status
- GitHub Actions: pnpm store ✅ (setup-node `cache: pnpm`) · cargo ✅ (Swatinem/rust-cache, per-workspace key) · develop-ref seeding ✅ (`push: develop`)
- Docker: n.a. (no image)

## Slow tests (tier: nightly)
None — full suite runs in acceptance.

## Test debt
| Item | Kind | Notes |
|---|---|---|
| `packages/api/src/__tests__/routes/memory.test.ts` (8 tests) | skipped | Self-skips without the napi addon (`pnpm build:memory-native`). Wiring would need a napi build leg in CI; the Rust core it wraps is covered by `rust (claude-memory)`. |
| `apps/macos` Swift tests (`make -C apps/macos test`, `test-kits`) | coverage gap | Need a macOS runner; not wired. |
| `crates/claude-memory-node` | coverage gap | napi cdylib, no Rust tests; exercised only via the skipped memory route suite. |
| cli / web line coverage < 30% | coverage gap | Ratchet the gates as tests are added. |
| `crates/claude-memory/tests/integration.rs` unused import `Error` | warning | Cosmetic. |

## Nightly
Not needed — no slow tier, no docker image, suite < 1 min.
