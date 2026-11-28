# 049 — The flow lab: every journey's steps, on invented data, in development only

Status: Accepted — 2026-11-28 (Téo, for 0.12.0: « sur une app de test,
améliorer certains flows, l'UI… de l'onboarding jusqu'à la fin, et pouvoir
facilement rejouer des étapes, avec un petit HUD »). Builds on ADR 002, ADR
003, ADR 033 (a development-only tool beside the app), ADR 037, ADR 040, ADR 047.

## Context

Reaching a screen meant living the journey that leads to it: a fresh data
folder for the first run, a Cloud place for the subscription's screens, a
call for an open episode. The pieces existed apart: the fake audio hardware,
the protocol fake of the helper, `scripts/ux/seed.ts`, the fake Cloud
(`apps/compute/scripts/fake-cloud.ts`), the notch lab. Nothing put a step
back as it was, and a development app still shares the user's models folder,
home and agent, and may reach GitHub, Hugging Face or the Cloud.

## Decision

`pnpm --filter @sondine/desktop dev:lab` (`scripts/dev-lab.mjs`) starts the
**flow lab**: a development app of its own, with a HUD that moves between
the journeys' steps.

### Isolation

- One folder, `~/.sondine-flow-lab` (`SONDINE_FLOW_LAB_ROOT` to move it;
  short, as macOS limits a socket's path to 103 bytes): `data/` is the data
  folder (`SONDINE_DATA_DIR`, Chromium's profile inside), `home/` is the
  app's home (`HOME`, and main sets Electron's `home` and `appData` to it):
  models, agents' settings and browsers' manifests stay there. Sondine's
  group container and `Sondine Dev` are never opened.
- The protocol fake of the helper: no audio hardware, no permission prompt,
  a microphone that speaks every two seconds. What the permissions say comes
  from a file the lab writes (`SONDINE_FAKE_PERMISSIONS_FILE`).
- No network. Core reads `SONDINE_FLOW_LAB` (`core/flow-lab.ts`) only in a
  development build (`import.meta.env.DEV`) whose updates are blocked as
  development, and then: the Cloud is the lab's fake Cloud on 127.0.0.1,
  the models, updates and Cloud reach only 127.0.0.1 (anything else is
  refused and logged), the update check answers from the lab, and chat and
  the journal start the engines' fake `claude`
  (`packages/engines/test/fake-claude.ts`) or find none. Main starts no
  phone relay, opens no browser (`SONDINE_DEV_NO_BROWSER`, which now covers
  external links and the menu bar's release page too) and loads no theme
  editor. Statistics are already off outside a package.
- A model « present » is an empty file of the catalog's size (sparse on
  APFS) with its manifest: the launch check trusts a matching size, inode
  and mtime. Nothing is downloaded.

### Steps

`shared/flow-lab.ts` holds the catalog: journeys (first run, first listen,
daily use, people and voices, the agent, the Cloud, backup, update, iPhone,
the end), each cut into steps. A step names its data (empty, or the invented
days of `seed.ts`, now `main/flow-lab/invented-data.ts`), settings rows,
actions done through core as the user would (a Cloud trial place, the
Checkout asked for, the agent turned on, an update check), the fake Cloud's
scenario, the window's route, the clicks that open a screen only a click
opens, and its default situation: permissions, model, network, the Cloud's
wave, the agent, the Mac's size.

Putting a step back (`main/flow-lab/controller.ts`, development only): the
helper and core stop, the data folder is emptied (Chromium's profile stays),
the data is seeded, core and the helper start again (`CoreProcess.startAgain`),
the fake Cloud is reset, the actions run, and the window reloads on the
step's route. Main seeds while core is stopped: the database stays core's
whenever core runs.

### The HUD

`renderer/flow-lab/`, loaded only when main says it is the lab. Fixed over
the window, it changes nothing of the layout when folded; ⌃⌥⌘L folds and
unfolds it. It shows the journey and step, previous and next, a menu of
every step, replay, restart, the step's variants, and the language, theme
and window size. Not translated, like the design system page.

### Nothing in the published app

Production builds fold `import.meta.env.DEV` to false: the lab's code in
main, core, the preload and the renderer is left out. `test/build.check.ts`
fails if a bundle holds the lab's variables, channels or HUD. No oRPC
procedure is added; the HUD talks to main on its own IPC channel, as the
notch lab does.

## Consequences

- A screen is reached in seconds, the same each time, in both languages and
  modes, at three window sizes, for Téo's reviews and the captures.
- The lab plays no audio and transcribes nothing: no PCM, no real model.
  The agent cannot read conversations without the agent relay's Swift build.
  Pairing an iPhone live is not simulated (it needs the LAN relay and a
  client); a paired phone and its recording are.
- An update check in development finds the lab's version, while installing
  stays blocked as in any development build.
- A new step is a few lines in the catalog; a new kind of state is a new
  action in the controller.
