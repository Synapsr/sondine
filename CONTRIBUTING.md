# Contributing to Sondine

Thank you for your interest. Sondine records what people say, so the bar for
privacy, cost and tests is high. Read [AGENTS.md](AGENTS.md) (the rules every
change follows, for people and coding agents alike),
[docs/product-vision.md](docs/product-vision.md) and
[docs/architecture.md](docs/architecture.md) before a large change. For
anything structural, open an issue first so we agree on the approach.

## Set up

You need:

- a Mac with Apple Silicon and macOS 27;
- Node 24.11 or later and pnpm 12 (`corepack enable` picks the version from
  `package.json`);
- Xcode with Swift 6.4, for `native/` and the iPhone app.

```bash
pnpm install                         # also downloads Electron
pnpm check                           # what CI runs; never writes
native/scripts/fetch-models.sh       # the VAD and voice models, sha256-checked, git-ignored
(cd native && swift build -c release && swift build)
pnpm dev                             # the desktop app, with real capture
pnpm --filter @sondine/desktop dev:fake-hal   # the real helper on fake audio hardware, no prompts
```

No account, key or secret is needed for any of this. The speech and text
models are downloaded from the app's first run, from their publishers.
Development finds speech.cpp, which transcribes, once the ad-hoc build below has
staged it, or where `SONDINE_SPEECH_BINARY` points; the journal needs a
`llama-server` at `SONDINE_TEXT_SERVER`, as the staged one does not start without
a Developer ID. Without them, development captures and groups, and the rest waits.

## What you can do without a Developer ID

Sondine's releases are signed with the maintainer's Apple Developer ID and
notarized. Its data folder lives in an app group container that only builds
signed by that team can open (ADR 010 and ADR 013). Without that identity:

- **You can** run the app in development with real capture (`pnpm dev`: the
  helper runs unsandboxed and macOS credits your terminal), run every test
  (`pnpm check`, `pnpm test:native`, `pnpm test:ios` on a simulator), use the
  bench, and package an ad-hoc signed app to check packaging:
  `SONDINE_SIGN_IDENTITY=- pnpm --filter @sondine/desktop build:mac`.
- **You cannot** capture audio from a packaged ad-hoc build (it uses a
  fallback folder its sandboxed helper cannot reach, on purpose), notarize, or
  publish a release or a TestFlight build. Those are the maintainer's.
- The Nucleo icon subset (`packages/ui/src/icon/nucleo/`) is generated from a
  licensed install. If your change needs a new icon, say which one in the pull
  request and a maintainer adds it. Never add an icon from another set.

## Making a change

- Keep the boundaries in AGENTS.md: audio never travels as JSON, product code
  depends on engine contracts, every user action is one oRPC procedure.
- No new network call, telemetry or dependency that phones home. The one
  report Sondine sends is anonymous, daily and opt-in
  ([ADR 042](docs/decisions/042-usage-statistics.md)): a development build, a
  test or a build of yours sends nothing, and its fields do not grow without a
  decision. A new procedure gets its rule in
  `packages/protocol/src/usage-events.ts`. A change to
  capture, voice activity detection or the background processes reports its
  measured cost in the pull request.
- Never commit audio, transcripts, voice data, corpora, `.env` files or keys.
  Use invented data in tests, fixtures and screenshots
  (`pnpm --filter @sondine/desktop ux:shots` captures the window on invented
  data).
- Every string the user reads goes through Paraglide (`apps/desktop/messages`)
  in English and French.
- A structural choice gets a decision record in `docs/decisions/`.
- `pnpm check` must pass. Run `pnpm test:native` when you touch `native/`.

### Changelog notes

A change a user would notice (a new capability, a visible improvement, a bug
they could hit) ships with a note in `changes/<slug>.md`, in the same commit.
Refactors, dependencies, CI and tests get none.

```md
---
type: new # new, improved or fixed
---

## Tag your recordings

Give any recording your own words to find it again. One to three sentences,
benefit first, in the user's words; the title says what they can do now.
```

At release, the notes are assembled into [CHANGELOG.md](CHANGELOG.md) and
deleted.

## Pull requests

- One subject per pull request, with a description of what changes for the
  user and how you checked it.
- Contributions are published under the project's license (AGPL-3.0-only),
  and need your agreement to the [Contributor License Agreement](CLA.md): you
  keep your copyright, and you let Téo Goulois license the project under other
  terms as well. Check the box in each pull request; every other author of its
  commits writes « I have read CLA.md and I agree to it. » in a comment.
  Nothing is merged without it.
- Be kind: this project follows its [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
