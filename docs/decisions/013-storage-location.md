# 013 — Storage location

Status: Proposed — 2026-11-02

## Context

Sondine is not sandboxed, so `~/Library/Application Support` is readable by
every process the user runs. Since macOS 15, app group containers are covered
by app data protection prompts.

## Decision

- Database, WAL, spool, chunks, archives, exemplar clips, and sockets live in
  the app group container `<TEAMID>.app.sondine`. Main asks macOS for it at
  each launch (`containerURLForSecurityApplicationGroupIdentifier`, through a
  small Node-API addon) and passes the path to core and to `sondine-audio`:
  macOS refuses an unsandboxed app that builds the path itself, silently, and
  the request also covers the processes main starts. Builds not signed by team
  P5G8WAJ2G2 never touch the container.
- Model weights live outside it (`~/Library/Application Support/Sondine/models`):
  they are not sensitive and the bench shares them. The sandboxed helper reads
  that folder through a read-only exception
  (`temporary-exception.files.home-relative-path.read-only`) and cannot read
  the app bundle, so main copies the bundled VAD model there, checked by
  sha256 at each launch, and points the helper at the copy.
- The container is excluded from Time Machine and cloud backup by default;
  Settings offers an explicit encrypted local export.
- Development builds run as Electron.app, which is not entitled to the
  group, and use `~/Library/Application Support/Sondine Dev`. Unsigned and
  ad-hoc packaged builds fall back to `~/Library/Application Support/Sondine`.

## Consequences

- Moving the data directory is a migration with a verified copy.

## Measured (M0)

- 2026-11-03, Developer ID build on Téo's Mac (`sondine-audio self-test
  sandbox`): the system creates the group container when the sandboxed helper
  starts; a file and a Unix socket work there. `Contents/Resources` of the app
  and `~/Library/Application Support/Sondine/models` are denied (EPERM)
  without the exception; with it, the model is readable and the folder not
  writable.
- 2026-11-03, first launch of the signed app: main's `mkdir` in the container
  failed with EPERM and no prompt (`TCC denied
  kTCCServiceSystemPolicyAppDataDetailed`, "user interaction not allowed").
  A probe app signed like Sondine, unsandboxed, confirmed the rule: refused
  before asking `NSFileManager` for the container, allowed after, and a child
  process with its own signing identifier is allowed only when started by the
  app that asked.
- 2026-11-04, signed app with the addon: main gets the container path with no
  prompt, core opens `sondine.db` there, and the sandboxed helper serves its
  socket there and connects to core, with no sandbox denial in the system log.

## Ad-hoc builds (decided 2026-11-04)

- Unsigned and ad-hoc packaged builds use the fallback directory, which the
  sandboxed helper cannot reach, so they do not capture: main does not start
  the helper and the menu bar says capture is unavailable. They exist to check
  packaging. Capture work runs in development (`pnpm dev`, an unsandboxed
  helper credited to the terminal) or on a Developer ID build.
- Rejected: an unsandboxed helper for local builds (a build whose helper can
  reach the network would ship by mistake one day, and `check-package` could no
  longer hold every packaged helper to the sandbox), and a home-relative
  read-write exception for the fallback (wider sandbox for every build, and
  ad-hoc signatures change at each build, so permission tests on them reset
  anyway).
