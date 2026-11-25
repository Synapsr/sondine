# 045 — Sondine updates itself, with a yes

Status: Accepted — 2026-11-25 (Téo: « oui et faire les mise à jour
automatique »). Amends ADR 002 and ADR 010.

## Context

The update check asked `api.github.com`, which allows 60 requests an hour to
everyone behind one address. On Téo's Mac other tools use them up: 0.7.0 was
never seen. An office has the same problem. And a person had to download,
open a disk image and replace the app at each version.

## Consent

- One setting, « Mettre Sondine à jour automatiquement »: with a yes Sondine
  asks, downloads, checks and installs. Without it, it does nothing alone:
  « Vérifier maintenant » and the link to the release's page stay.
- Asked once, with two equal answers: after the statistics in the first run
  (the same step, so the steps the anonymous report names do not change), or
  in the sidebar for an install that had no such run.
- Someone who turned the earlier check on said yes to the check alone: it goes
  on, and nothing is downloaded, until they answer. A no ends both.
- Not asked where Sondine cannot replace itself (below).

## The check

- One GET of `sondine-mac.json`, a file of the newest release, at
  `github.com/<repository>/releases/latest/download/`. github.com redirects it
  to its storage: no API, no quota by address. `redirect: "manual"`, https
  only, at most five hops, and only to `github.com`,
  `release-assets.githubusercontent.com` (today's storage) and
  `objects.githubusercontent.com` (the one before, which GitHub still names).
- At most every other day once answered, across launches; six hours after no
  connection, since nothing was asked. A click asks at once.
- User agent `Sondine`; nothing of the person, the Mac, its macOS or the
  version installed. GitHub sees the IP address. A refusal (401, 403, 429, 451) is told from an answer Sondine cannot read.
- The file names the version, the oldest macOS, and the archive's size and
  sha256. It is not signed: it decides nothing but what to download. The
  app's own signature decides what is installed.

## Download, checks and install

- `core` downloads `Sondine-<version>-arm64.zip` from the same release, with
  the model downloads' code (`downloadFile`: pinned size and sha256, resumed
  by `Range`, synced, a hop limit), in the data directory's `updates` folder,
  which macOS keeps from other apps. Only when macOS says the network is
  neither expensive nor constrained (Low Data Mode), asked again every 30 s
  (`native/update.m`, a monitor that starts at the first download), and never
  during a call. A download that stops keeps its bytes; one that fails is asked for again an
  hour later or at the next launch, not at each look. It needs 2 GB free
  beyond the archive and the app, and unpacking stops below them.
- Checked after the download and again right before the install, with the
  tools of macOS: one `Sondine.app` in the archive; `codesign --verify --deep
  --strict` against identifier `app.sondine`, Apple's anchor, Developer ID and
  team `P5G8WAJ2G2`; the `notarized` requirement, from the ticket stapled to the app (no
  request: `--check-notarization` makes one); `Info.plist`'s identifier,
  version (the one announced, later than this one) and minimum macOS. A
  refusal deletes it, says why, and is not tried again alone: a click on
  « Vérifier maintenant », or another archive, is.
- **Nothing is cut.** It waits for: a call (muted or not), a dictation, an
  open recording or speech, a transcription, a phone's request or pairing,
  the journal, an agent's answer, a voice read, a model download, the player,
  any action of the window or an agent; and a Mac idle for 5 min, or locked.
  « Redémarrer et mettre à jour » (Settings, menu bar) skips only the idle
  wait. Looked at every 30 s while an update is ready, not otherwise.
- **Then** main starts a small `sh`, then runs the ordinary `shutdown()`: core
  asks the helper to commit and stop, imports what it sent and closes. With
  Sondine's processes gone, main asks `codesign` once more, and the new app and
  this one exchange places in one step (`renamex_np` with `RENAME_SWAP`): there
  is no moment without an app. The shell waits for main to go and calls
  `open -g`, or `open` when the window was in front; started first, it opens
  Sondine again whatever happens to main. The start gets the window (closed,
  behind or in front), its page, and the name of a file in the temporary
  folder, which main makes once core runs. The listening intent, a timed pause
  included, is in the database and is applied as at any launch.
- Between the last look and the shutdown there is a message from core to main:
  what starts in those milliseconds is cut as by any quit, and recovered as
  after one (a transcription is queued again, a phone sends again).
- The path, identifier and signature stay the same, so the permissions, the
  local network, the login item, and the browsers' and agents' manifests keep
  pointing at it.

## After

- « Sondine a été mise à jour en X » in the sidebar, with this version's
  section of the CHANGELOG, built into the app, until it is closed.
- Not replaced: the same version starts again, says so, and does not try that
  archive again alone. The new version does not run its core: the shell opens it
  three times, a minute each, then shows an alert that Sondine does not listen,
  with the release's page.
- **Never back on its own.** Each release's disk image stays on its page. An
  earlier version refuses a database a later one migrated (`migrate()`:
  « unknown to this build »): it changes nothing in it and does not listen.
  Without a migration between the two, going back works. The way out is the
  later version, whose data is whole.

## Where Sondine does not update itself

`updateTarget` (main): a development build; a build `release:mac` did not make,
or not signed by the team; an app not named `Sondine.app` (`Sondine Exp.app`
is a notarized release under another name, so the name decides); a translocated
app, or one this user cannot write or that is on another volume than the data
(« Déplacez Sondine dans Applications »).

## Compared

|                             | Who downloads              | What leaves                                                                                | Restart                                      | Notarization  | Adds                                                                        |
| --------------------------- | -------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------- | ------------- | --------------------------------------------------------------------------- |
| Electron autoUpdater 45.2.1 | main (Squirrel.Mac)        | CFNetwork's default user agent (app and system versions; not measured), its redirects      | ShipIt, `NSWorkspaceLaunchDefault`: in front | not looked at | a launchd job per app                                                       |
| electron-updater 6.8.11     | main                       | `x-user-staging-id`, an identifier kept per install, with each check (`AppUpdater.js:386`) | Squirrel's, through a server of 127.0.0.1    | not looked at | eight direct dependencies                                                   |
| Sparkle                     | its framework and XPC apps | Sparkle's own requests                                                                     | its own                                      | its own       | a framework, its helpers and entitlements, a bridge to it, a key of its own |
| **core, and an exchange**   | core                       | the two GETs above                                                                         | `open -g`, as it was                         | required      | one addon of two functions, one shell                                       |

An identifier kept per install is what ADR 002 forbids; a window that
comes in front of what the person does, or a restart Sondine does not hold, is
what this feature must not do. Squirrel also unpacks and checks the archive
while Sondine is stopped; here it is all done before, and what stops capture is
a rename.

## Releases

- `release:mac` writes, from the notarized and stapled app,
  `Sondine-<version>-arm64.zip` and `sondine-mac.json`, and reads them back
  (`scripts/update-files.mjs`). Both go in the release with the disk image: a
  published release without them is a check that fails (« une réponse que
  Sondine ne sait pas lire »).
- A test build (`SONDINE_UPDATE_FEED=http://127.0.0.1:<port>/sondine-mac.json
  pnpm build:mac`) reads that server and asks for no notarization.
  `build-mac.mjs` drops the variable from a release and `check-package.mjs
  --release` refuses the address in one.

## Statistics

No new field (ADR 042). `update_install_requested` and `update_note_closed` are
`never`: they leave no Mac, so the Worker's closed list does not change.
`update_check_set` keeps its name for the one setting. A refusal of GitHub's
counts as `update_bad_response`, as before; no failure of a download or an
install is counted.

## Measured

2026-11-25, on a second Mac (Apple M2, macOS 27.2.1, screen locked), two builds
signed with the Developer ID and a feed on that Mac. Listening was paused for an
hour throughout: macOS's microphone prompt had nobody to answer it, so no audio
was recorded there.

- A installs B by itself; the pause and its end are the same before and after;
  what the update replaced is deleted. From the helper's end to the next one's
  start: 2.2 and 2.3 s (two runs, sampled every 0.1 s), of which about 0.2 s from
  the quit to the exchange, the last `codesign` included. Opening the audio
  devices adds to it and was not measured.
- A window that was open comes back at the same place.
- Refused, nothing installed, nothing of it left on the disk: an ad-hoc
  signature, another developer's app, another app of the same team, a file
  changed after signing, a wrong sha256, an older app under a later number, an
  older number, a 403, an app not writable, `Sondine Exp.app`.
- A call row open in the database: no download; it goes on once it ends.
- Cut at 60 MB: resumed at byte 60,817,408. The app killed at 34.6 MB: resumed at
  33,554,432. 2.2 GB free where 2.8 are needed: `disk_full`, then installed once
  there was room. Main killed while Sondine stops: the same version opens again.
- The notarization check accepts the app published as 0.7.0, without
  `--check-notarization`, and refuses a build Apple never saw.
- CPU of every Sondine process over 5 min, paused: 0.64 and 0.58 s before,
  0.61 and 0.65 s with updates and no answer, 0.69 s while an update waits for a
  call (looked at every 30 s, one run). Memory unchanged (about 467 MB). Capture
  itself is not touched, and was not measured.

Not tried: a notarized version installing another from GitHub, a real call or
dictation, the microphone and system audio grants and the login item after an
update, a translocated app, a metered network, the alert on screen.
