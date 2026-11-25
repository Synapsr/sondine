# 041 — Publishing the source under Synapsr

Status: Accepted — 2026-11-24 (Téo's answers: he holds the copyright, a new
history, a CLA, Graphical's tools ignored by git, `Synapsr/sondine` with the
releases in it). Publication itself waits for Téo's explicit go. Builds on ADR 002
(the update check), ADR 009 (icons and fonts in a public repository), ADR 010
(signing) and ADR 033 (Graphical).

## Context

Sondine has been AGPL-3.0 from its first commit, but its repository,
`teo-goulois/sondine`, is private. Téo asked on 2026-11-24 to prepare its
publication under his GitHub organization, Synapsr. Releases are already
public, in `teo-goulois/sondine-releases`, which the installed apps read.

An audit of the tree and of `main`'s history (406 commits, the only branch
on GitHub) on 2026-11-24 found:

- No secret: gitleaks 8.30.1 over every commit reports 98 hits, all test
  vectors (bytes 0 to 31, pairing tokens of fixtures) and the browser
  extension's public key. No `.env` file, `.p8`, `.p12` or key was ever
  committed; `apps/desktop/.env.example` holds names only.
- No audio, model or database file was ever committed.
- Real first names of people Téo recorded, quotes and private events in a
  few tests, decisions and benchmark reports, in the tree and in older
  commits.
- The Graphical editor's package (`graphical/packages/editor-1.0.4.tgz`) and
  Graphical's skills and guide, which Graphical's site sells without stating a
  license for redistribution.
- The Mac's real Tailscale address in four tests.
- The Nucleo subset is allowed: the Standard License lets a project include
  up to 100 icons in public source files with the copyright notice
  (nucleoapp.com/license, « Public projects »). The repository has 69.
- Dependencies are permissive (MIT, ISC, Apache-2.0, BSD, MPL-2.0 for
  lightningcss at build time, CC-BY-4.0 for caniuse-lite data), all
  compatible with AGPL-3.0; the app's runtime dependencies are MIT,
  Apache-2.0 and 0BSD.

The update check fetches
`api.github.com/repos/teo-goulois/sondine-releases/releases/latest` with
`redirect: "error"` (`apps/desktop/src/core/updates/update-check.ts`). GitHub
answers a moved repository with a 301 to its new location, so transferring
`sondine-releases` would silently end update notices for every installed
version up to 0.7.0.

A second audit on 2026-11-25, of what changed since and then of the whole tree,
found the same false alerts (32 in the tree, the compute server's public key
among them), no audio, database or Graphical tool, and a few real traces, now
invented: a product's name as a demo tag, a machine's name, a recorded sentence,
a call and an episode told by their date or number.

## Decision

- **Real data stays out.** Tests, fixtures, captures, decisions and
  benchmark reports use invented names and words; a benchmark report gives
  numbers and invented examples, never a recorded sentence or a recorded
  person's name. The tree is cleaned before publication.
- **Copyright** stays Téo Goulois's, as `NOTICE` says. Synapsr hosts.
- **A new history.** The public repository, `Synapsr/sondine`, starts from
  one commit of the cleaned tree. `teo-goulois/sondine` is archived and stays
  private: rewriting it in place would leave the old commits readable by
  their hash on GitHub.
- **Contributions** need the agreement in `CLA.md`: the contributor keeps
  their copyright and lets Téo license the project under other terms, which a
  future cloud may need. The agreement is a checkbox in each pull request, for
  that contribution only (French law voids a global grant of future works),
  with no bot, so no third-party service or secret.
- **CI** runs `pnpm check` on macOS for pushes to `main` and pull requests,
  with no secret, so forks run it unchanged. It skips private repositories,
  where macOS minutes are paid; there `pnpm check` runs locally. Native and
  iPhone tests stay local (`pnpm test:native`, `pnpm test:ios`).
- **Releases live in `Synapsr/sondine`.** A separate repository was only
  needed while the source was private. GitHub's `releases/latest` is then
  always a desktop release: anything else (the ONNX Runtime archive, an
  iPhone build) is published with `--latest=false`, because the app reads
  `sondine-mac.json` (ADR 045) from the latest release, and the versions up to
  0.7.0 refuse a latest tag that is not `desktop-v…`.
- **No transfer of `sondine-releases`.** In this order: make
  `Synapsr/sondine` public; publish there a bridge version that reads it,
  0.8.0, later than the last one published, 0.7.0 (an equal version is not
  announced); publish its disk image, alone, in
  `teo-goulois/sondine-releases`, as its latest; check that a 0.7.0 announces it and that the bridge version's own
  check answers; then archive
  the old repository, kept public. Its API and downloads still answer, for the
  older apps and for the ONNX Runtime archive `native/Package.swift` pins.
- **Graphical's theme is public, its tools are not.** Graphical states no
  license for redistributing its files, so Téo asked. Its author answered on
  2026-11-24 that the theme and its generated files are fine, and asked
  for the editor and the skill files to be in `.gitignore` if easy. The guide
  (`GUI.md`, `gui/`), not named in the answer, is ignored with them. They
  stay on the machines that have them and do not follow into a new checkout
  or worktree.
- **Public identity.** `teo.goulois.dev@gmail.com` is the address of the code
  of conduct and the author of the first public commit.

## Consequences

- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
  issue and pull request templates and `.github/workflows/check.yml` exist.
- `AGENTS.md` names no private path; the maintainer's handbook and changelog
  skill are optional.
- `pnpm test` compiles the translations itself: a turbo cache hit on
  `typecheck` left them missing on a fresh checkout.
- The first public commit holds the source repository's links
  (`.github/ISSUE_TEMPLATE/config.yml`).
- The bridge version is 0.8.0. It changes `apps/desktop/src/shared/updates.ts`
  (`RELEASES_REPO`, with its tests), ADR 010, `README.md` and `SECURITY.md`. It
  is published only once the repository is public: a private one answers 404.
