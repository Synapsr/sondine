# 001 — Initial stack

Status: Proposed — 2026-11-02

## Context

Sondine is rebuilt from zero as an open-source, local-only Electron app for
macOS with an iPhone companion. Téo's handbook gives the defaults; the
product constraints (always-on capture, heavy local models, no cloud) and
Téo's explicit choices override them. Versions were checked on 2026-11-02
(npm, release pages, runtime probes).

## Decision

| Layer              | Choice                                                                                                                       | Pin                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Monorepo           | Turborepo + pnpm, hand-rolled                                                                                                | turbo 2.11.10, pnpm 12.16.1                                           |
| Lint / format      | Oxlint (type-aware) + Oxfmt                                                                                                  | 1.90.0 / 0.75.0                                                       |
| Language           | TypeScript 7 (`tsc`)                                                                                                         | 7.0.2                                                                 |
| Desktop shell      | Electron, built with electron-vite, packaged with electron-builder                                                           | 45.2.1 / 6.0.0 / 26.18.x                                              |
| Renderer           | React, Vite, TanStack Router, TanStack Query, TanStack Hotkeys, Tailwind v4, Base UI, Motion, Paraglide JS                   | 19.3.1, 8.3.5, 1.170.x, 5.105.0, 0.20.0, 4.3.3, 1.9.0, 14.9.0, 2.29.3 |
| Backend logic      | Effect v4 as the core process shell (supervision, scheduler, resources, retries, spans); domain logic stays plain TypeScript | 4.1.1                                                                 |
| API                | oRPC procedures, MessagePort for the app; MCP through a small bridge on the official MCP server SDK                          | oRPC 1.16.1, `@modelcontextprotocol/server` 2.4.0                     |
| Database           | SQLite through `node:sqlite` (Electron's Node 24, FTS5 compiled in) with Drizzle ORM                                         | drizzle-orm 1.0.0-rc.5 (exact)                                        |
| Native             | Swift 6 package: capture helper, Core ML / Apple engine worker, meter                                                        | —                                                                     |
| ML runtimes        | FluidAudio (Core ML, offline mode), speech.cpp `worker`, llama.cpp `llama-server`                                            | pinned by commit and sha256                                           |
| Mobile (release 2) | A SwiftUI app for iPhone (amended 2026-11-10 by ADR 031; first: Expo, SDK 58)                                                | iOS 27, Swift 6.4                                                     |
| Target             | macOS 27, Apple silicon, 32 GB (the only tested configuration)                                                               | —                                                                     |
| Tests              | Vitest, `@effect/vitest`, Swift Testing                                                                                      | 5.0.5                                                                 |

## Consequences

- **No Better-T-Stack scaffold.** Its current schema has no Electron option
  and its `oxlint` addon writes a `check` that modifies files. The iPhone
  app is not Expo any more (ADR 031), so nothing is scaffolded for it.
- **No PostHog in the app.** The handbook requires usage analytics; Sondine is
  local-only, so it has no analytics SDK and no identifier. Local performance
  spans serve engineering decisions. Amended 2026-11-25 by
  [ADR 042](042-usage-statistics.md): with the user's yes, one anonymous
  report of counts a day reaches PostHog (EU) through a Worker of ours.
- **No Better Auth.** There are no accounts. Paired phones use a device
  credential (ADR 008).
- **Drizzle 1.0 is a release candidate**, required for the `node:sqlite`
  driver. It is pinned exactly; the fallback is better-sqlite3 13 with
  Drizzle 0.45 stable.
- **TypeScript 7 has no compiler API yet.** Tools that need it run through
  `@typescript/typescript6` side by side. Effect editor support comes from
  `@effect/tsgo`.
- **TanStack Hotkeys is beta.** Wrapped behind the app's shortcut registry so
  it can be replaced.
- **Electron's shell exports `ELECTRON_RUN_AS_NODE=1` on Téo's machine.** Dev
  scripts unset it.
- **oRPC's MCP adapter is still v2 beta.** The bridge stays small until it is
  stable.

## Rejected

- Tauri or a native Swift app: Téo asked for Electron. The always-on path is
  native anyway (ADR 003).
- better-sqlite3 as the default: a native module to sign and rebuild, for no
  feature node:sqlite lacks.
- Electron Forge: requires `node-linker=hoisted` with pnpm.
