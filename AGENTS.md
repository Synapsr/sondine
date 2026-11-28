# Sondine

Always-on, local-only auditory memory for macOS, with an iPhone companion.
Open source under AGPL-3.0. Read `docs/product-vision.md` for scope and
`docs/architecture.md` for the system.

## Priorities

1. Local only: no cloud, no telemetry, no network except model downloads the
   user starts, the updates they said yes to (ADR 045), sync with paired
   phones on the local network, or through
   Tailscale once the user allows it (ADR 002, ADR 008), and the discussion
   with an agent the user turns on, through their own CLI (ADR 027), and the
   transcription on a compute server the user chooses (ADR 040), and one
   anonymous report of counts a day once the user said yes (ADR 042).
2. Light and fast: the always-on path has a measured budget. Any change that
   touches capture, VAD, or the background processes reports its effect.
3. Measured and tested: every pipeline stage reports quality and cost.
4. Swappable engines: product code depends on engine contracts in
   `packages/engines`, never on a specific model (ADR 005).

## Boundaries

- `native/` owns everything that touches audio hardware and Core ML. Audio
  never travels through oRPC, JSON, or base64; PCM moves on binary pipes or
  as files. Playback streams bytes from core through main to the window's
  audio element on the `sondine-media:` scheme, by bounded ranges, never
  cached (architecture §11).
- Electron main is a thin supervisor. Business logic and the database live in
  the `core` utility process. The renderer has no Node access.
- Every user action is one oRPC procedure in `packages/api`; the app calls it
  through TanStack Query.
- Wire formats shared with Swift live in `packages/protocol` with golden
  fixtures used by both sides.

## Commands

```bash
pnpm install        # also downloads Electron (apps/desktop postinstall)
pnpm dev            # desktop app (unsets ELECTRON_RUN_AS_NODE)
pnpm --filter @sondine/desktop dev:fake-hal  # real helper, fake audio hardware, no prompts
pnpm --filter @sondine/desktop dev:notch     # the notch lab: the island's flows on the real notch, no call needed
pnpm --filter @sondine/desktop dev:lab       # the flow lab (ADR 049): every journey's steps on invented data, a HUD (⌃⌥⌘L), no network
pnpm lint           # oxlint
pnpm format         # oxfmt (writes)
pnpm format:check
pnpm typecheck
pnpm test
pnpm check          # lint, format check, typecheck, tests; never writes
pnpm test:native    # Swift tests (native/, about 20 s warm), the Mac's import of a phone file Swift wrote, and iPhone sync end to end (about 70 s); not part of pnpm check
pnpm test:ios       # iPhone app (apps/ios): simulator build and a short UI test, about 2 min; not part of pnpm check
pnpm release:ios    # archive and upload to TestFlight; maintainer only, needs the App Store Connect key
pnpm bench          # sondine-bench CLI (apps/bench)
```

`pnpm check` must pass before a task is done.

## Conventions

- The decisions in `docs/decisions/` override general habits. A maintainer
  may also have a local handbook of defaults; follow it when it is present.
- Kebab-case file names. No `any`; prefer inference, narrowing, and
  `satisfies` over casts.
- Icons only through `packages/ui/src/icon`; never import an icon provider
  elsewhere. The committed Nucleo subset stays under 100 glyphs (ADR 009).
- Translations from day one (Paraglide JS, French and English).
- A user-visible change ships with a note in `changes/` (format in
  CONTRIBUTING.md; a changelog skill, where installed, writes it).
- Read the relevant decisions in `docs/decisions/` before structural work,
  and record new durable decisions there.

## UI

The theme lives in `graphical/` (ADR 033). Components live in `packages/ui`
and are shown on the dev-only design system page. Graphical's guide (GUI.md,
`gui/`), skills (`.agents/skills/`) and theme editor (`graphical/packages/`)
are not in the repository (ADR 041). Where they are present, follow GUI.md
and use the skills: graphical-ui for new or edited UI, which uses the
installed theme even when a request does not name Graphical;
graphical-import for an initial conversion and editor install;
graphical-adopt for the editor's « Copy for agent » batches, theme changes
and package updates. Read `packages/ui/CONVENTIONS.md`
before adding or changing a component; `pnpm --filter @sondine/ui test`
(class and icon checks included) must pass.

## Safety

- Never commit audio, transcripts, voice data, or corpora. Private benchmark
  data stays outside the repository.
- Never print or commit `.env*` contents or license keys
  (`NUCLEO_LICENSE_KEY`).
- Do not add a network call, a telemetry SDK, or a dependency that phones
  home. The anonymous report's fields are what the user said yes to: a field
  or a finer value needs a new version of the question (ADR 042), and the
  maintainer's agreement. A new procedure gets its rule in `USAGE_RULES`.
