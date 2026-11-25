# @sondine/browser-extension

Sondine's browser extension (Manifest V3; built for Chromium browsers and
Firefox). macOS tells Sondine which app plays sound; the extension tells it
which tab. It reports, through the
browser's native messaging (host `app.sondine.browser`), the address and
title of each tab that plays sound and, on YouTube, where the video is. The
wire format is `packages/protocol/src/browser-messages.ts`.

## What it reads and sends

- Tabs that play sound and are heard: audible, not muted, outside private
  windows (the extension does not run there), on an http or https page. For
  each, its id, address (cut to 2048 characters) and title (cut to 300).
  The complete list goes out at each change, never twice the same.
- On YouTube (`www`, `m` and `music.youtube.com`), the video's id (from the
  address), position, length, speed, and whether an ad plays (the player's
  `ad-showing` class). Reports of a tab go out only while that tab is
  listed, and each page is asked again once a minute while its tab plays.
- On every page (YouTube's own script included), when something of it
  starts or stops being heard, and every 30 s while it is: its address, its
  title (`document.title`, the tab's) and whether it is heard, from its
  audio and video elements' state. Yab runs the extension in its Chromium
  engine, whose tabs API lists none of its WebKit tabs: the page says it
  itself. Nothing else of the page: no text, nothing typed; a silent page
  sends nothing and runs nothing but its listeners.
- Nothing leaves the Mac: the only connection is the native port to
  Sondine. The build fails if a bundle contains a network call.

## How it links

The service worker opens the native port when it starts, when a tab starts
playing, and each minute while the link is open or some tab plays (one
alarm). Core's first message answers: on `{"ok":true}` the worker sends the
hello, the audible list, then the last report of each listed YouTube tab (or
asks the page for one). While the link is up it reads the tabs every 20 s:
Yab never says when a tab starts or stops making sound, and a worker that
calls the tabs API stays loaded there. The list goes out at each change and
at least every minute (the hello says so: `refreshMs`), with what the read
found (tabs and audible ones, counts only); each heartbeat asks the listed
YouTube pages where their video is, and the worker answers every report.
A read that finds no tab at all while one is listed is not believed; a
closed tab leaves the list at once. On a refusal or a closed port it drops
the port and waits for the alarm. With no link and nothing playing it may
sleep, and the browser wakes it with the next tab event.

The unpacked build's manifest carries a `key` that pins its id to
`nnieeegenbmpfllllldjpkolkldjmmdb`, which Sondine's native host manifest
allows. The stores refuse a key: their builds go without it and get the
store's id. In Firefox the id is `browser@sondine.app`.

## Commands

```bash
pnpm --filter @sondine/browser-extension build          # dist/chrome-mv3: the unpacked extension Sondine ships
pnpm --filter @sondine/browser-extension build:firefox  # dist/firefox-mv3
pnpm --filter @sondine/browser-extension zip            # dist/*.zip: what the stores receive
pnpm --filter @sondine/browser-extension test
pnpm --filter @sondine/browser-extension typecheck
```

[WXT](https://wxt.dev) builds it (`wxt.config.ts`), from the three entries in
`entrypoints/`, into one classic, unminified script each (content scripts
cannot be modules), with each browser's manifest. Its hooks add the English
and French strings and the icons, cut from `apps/desktop/build/icon.icns`
with macOS's `iconutil` and `sips` (`scripts/assets.ts`), and fail the build
if a script does not parse as a classic script or calls the network
(`scripts/check-bundles.ts`). WXT reaches no network to build or zip, and
`wxt dev` opens no browser.

`zip` builds in WXT's `store` mode, without the key, into
`dist/chrome-mv3-store` and `dist/firefox-mv3-store`, then writes
`dist/sondine-<version>-chrome.zip` (Chrome Web Store),
`dist/sondine-<version>-firefox.zip` (Firefox Add-ons) and
`dist/sondine-<version>-sources.zip` (the sources Firefox's review asks
for). A plain `wxt zip` stops: the key would go with it.

To try it, load `dist/chrome-mv3` from the browser's extensions page
(developer mode, "Load unpacked"); in Firefox, `dist/firefox-mv3/manifest.json`
from `about:debugging` ("Load Temporary Add-on").

## Code

- `src/audible-tabs.ts`, `src/youtube-state.ts`, `src/page-state.ts`,
  `src/link.ts`: the logic, pure and unit-tested.
- `entrypoints/background.ts`, `entrypoints/youtube.content.ts`,
  `entrypoints/pages.content.ts`: the entries, wiring the browser's events
  to that logic. The content script
  stops when WXT's context ends (the extension went away, or a newer copy
  started); it tells the page nothing (`noScriptStartedPostMessage`).
  `test/service-worker.test.ts` and `test/content-script.test.ts` run the
  built scripts against fakes; `test/global-setup.ts` builds them with WXT
  once per run, as `build` and `zip` do.
- `src/extension-api.ts`: the browser APIs used, typed by hand. The code
  takes `chrome` (Helium and other Chromium browsers) or `browser` (Yab, on
  WKWebExtension), and does not rely on fields a browser may leave out.
- `src/limits.ts`: the protocol's limits, copied so no zod ships;
  `test/limits.test.ts` keeps them equal.
- `scripts/manifest.ts`: the manifest's keys for each build.
