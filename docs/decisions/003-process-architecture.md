# 003 — Process architecture

Status: Proposed — 2026-11-02; amended 2026-11-25 (Sondine is in the Dock)

## Context

Capture must run all day under a tight budget and survive UI crashes. Heavy
models (up to 19 GB) must never share an address space with Electron. macOS
attributes microphone and system-audio permissions to the responsible
process. A review measured that Chromium keeps its GPU, network, and audio
service processes alive after the last window closes.

## Decision

- **`sondine-audio`** (Swift) owns capture, spool, energy gate, VAD, and
  regions. Main spawns it (TCC credits Sondine.app) and holds only its stdin;
  EOF means exit. Core talks to it over a private Unix socket (0600).
- **Electron main** is a thin supervisor: tray, windows, power events,
  spawning `sondine-audio`, brokering one MessagePort between renderer and
  core. It is not on the audio event path; for playback it only relays byte
  ranges from core to the window (architecture §11).
- **`core`** (utility process) runs the Effect shell (supervision,
  scheduler, scopes, retries, spans), owns the database, spawns engine
  workers, and serves oRPC and MCP. Domain logic in `packages/core` is plain
  TypeScript.
- **Renderer** exists only while a window is open.
- **Engine workers** read files and write results; core spawns them (they do
  not need capture permissions).
- No PCM streaming in release 1: near-live view reads spool commits.

## Consequences

- If main dies, the helper stops: capture has a gap, captured audio is safe
  (2 s commits). The M0 spike kept the child helper over an SMAppService
  agent (below).
- Chromium's helper processes are budgeted and excluded from capture.
- Development runs from a terminal credit the terminal for TCC; permission
  tests run on signed builds.

## M0 state

Spike, child helper or SMAppService agent (decided 2026-11-04): **child
helper**. An agent's one gain is to keep capturing when main dies, which is
exactly what the visible-stop requirement forbids: with the tray gone the user
can neither see nor stop the recording. An agent that exits with main gains
nothing over a child. It would also need its own permission story (launchd is
its responsible process, so whether TCC credits Sondine is unverified) and its
own update path (a running agent keeps the replaced bundle's code). The cost
of the child helper is that a crash of main stops capture until Sondine is
opened again; relaunching after a crash (a launch agent for Sondine.app itself
with `KeepAlive` on unsuccessful exit, together with the login item) is an M4
packaging item.

Spike, MessagePort brokering (decided): main brokers one `MessageChannelMain`
port per page and one for itself; after a core restart it brokers new ones
(`port.brokered`, `rpc.port-attached`).

Kill tests, 2026-11-04, on the fake HAL (development build, `--hal fake` with
its signal driver) and on the Developer ID build, real hardware:

- Helper (SIGKILL): main restarts it within 1 s; macOS credits the new helper
  to Sondine (`responsible=app.sondine`, allowed, no prompt). Core reconciles
  the spool after the new snapshot: both runs close at their last stored
  sample (`helper_exit`) and each track gets a `helper_exit` gap up to the
  next run (3.6 s). The helper writes PCM only when it commits, so a kill
  loses at most the 2 s in memory, inside that gap.
- Core (SIGKILL, 7 times): main restarts it within 1 s and it reconnects to
  the same helper, which buffered its events. Commits buffered while core was
  away arrive before the snapshot names their run, so the importer skipped
  them: without reconciliation each restart left 2 to 16 silent holes. Core
  now fills them from the manifests (no missing sample after any restart).
- Main (SIGKILL): the helper exits on end of stdin after a final commit; core
  and Chromium's services die with main. At the next launch core imports the
  commit it never saw, closes the runs (`helper_exit`) and records the gap up
  to the new runs (89 s on the fake HAL, the time Sondine was down).
- Repeated 2026-11-05 on Téo's Mac (MacBook Air M5), signed build `d1bb53a`,
  while capturing, 30 s apart, from Sondine's log and the helper's Core
  Audio log. Main, relaunched 10 s later: core closed the 2 runs, imported
  the 2 final commits and recorded 2 gaps; microphone and tap ran again 1 s
  after the launch. Helper: capturing again 2 s after the kill; 2 runs
  closed, 2 gaps. Core: restarted after 1 s, reconnected to the same helper
  session and imported the 2 commits buffered meanwhile, with no gap. No
  reconciliation problem in any of them.
- Clean quit (control): the helper sends its last commits and closes before
  acknowledging `shutdown`, but core closed the database as soon as it read the
  ack, so a run could stay open (the system track, in the first test; the
  integration test failed 3 times in 3 without the fix). Core now waits
  until every received event is imported (`Importer.drain`) before closing.
- Known limit: a quit while core is down (restarting or crash-looping) looks
  like a helper exit at the next launch, and the time Sondine was closed is
  recorded as an outage; the manifests have no close record to tell them
  apart (architecture §16).

## Amendment — 2026-11-25: in the Dock

Sondine was a menu bar app (`LSUIElement`, accessory policy): neither in the
Dock nor in ⌘Tab, and a launch opened nothing. Téo asked for its icon in the
Dock.

- **A regular app, by its Info.plist.** `LSUIElement` is gone from the main
  app and nothing sets its policy. Keeping `LSUIElement` and switching to
  `regular` at run time was measured against it, with a probe app on Electron
  45.2.1 and macOS 27.2 opened in the background: the app was still a
  `UIElement`, without a tile, 1.5 s after the launch, against 0.3 s at most
  without `LSUIElement`. `check-package.mjs` refuses the key on the main
  app and still requires it on the helper apps, which stay out of the Dock.
- **Closing the window changes nothing else**: the icon stays, listening goes
  on, the renderer exits. A click on the icon opens the window, or brings it
  to the front. The menu bar item and the island are unchanged.
- **The window opens when a person opens Sondine** (`launch.ts`), at launch
  or while it runs: macOS brings the app to the front within 5 s. Not when
  macOS opens it at login (`wasOpenedAtLogin`, or a process loginwindow
  opened: Electron's flag leaves out an app open at the last logout), nor in
  the background (the helper after a crash, `open -g`): no window, no focus.
  A script that restarts Sondine uses `open -g`, since macOS does not tell a
  plain `open` from a person.
- **The application menu is on screen while Sondine is in front**, so its
  items are translated (`app-menu.ts`).
- **Development stays an accessory app**: it runs as Electron.app, whose
  generic icon would join the Dock.

## Rejected

- Database in main: synchronous SQLite would block the main thread.
- Engines inside Electron (napi addons): a crash or a 19 GB model would take
  the app down.
- PCM relayed through main for live view in release 1: more moving parts for
  latency the user does not need yet.
