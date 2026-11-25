# 023 — Which web page a browser plays

Status: Accepted — 2026-11-09; amended 2026-11-10 (the link in Yab, Yab's
Chromium engine, and a page script on every site, below)

## Context

macOS says which app plays sound, never which tab: `system:other` regions
carry an attributed app (Yab, `dev.serafim.fast`), and a media episode reads
« Média · Yab ». Téo (2026-11-09) wants a YouTube video's episode to carry the
video's link, title and, ideally, where in the video each sentence was; then,
the same day, for every site: « Sondine doit savoir d'où vient le son du
navigateur, et s'en servir. Un film sur Netflix, ce n'est sans doute pas la
peine de l'écouter. »

Release 1 listed « guessing the website or tab behind browser audio » as a
non-goal, and ADR 004 says the tab is never inferred. That stays true: the
browser itself reports the tab that plays, nothing is guessed.

Ruled out: AppleScript (one Automation prompt per browser, and it cannot say
which tab is audible); macOS Now Playing / MediaRemote (a title without an
address, closed to third-party apps since macOS 15.4).

Browsers checked on Téo's Mac (2026-11-09):

- **Helium** (`net.imput.helium`, Chromium 0.21): loads unpacked extensions
  and reads native messaging host manifests from its profile,
  `~/Library/Application Support/net.imput.helium/NativeMessagingHosts`.
- **Yab** (`dev.serafim.fast` 0.47, WebKit pages with WKWebExtension, CEF
  for sites set to Chromium): « Charger l'extension non empaquetée » and the
  Chrome Web Store both work; it implements `isPlayingAudio` for
  extensions (tabs' `audible`), launches Chromium-style native hosts (it
  reads `~/Library/Application Support/Yab/Chromium/NativeMessagingHosts`
  and adopts the manifests of Chrome, Arc, Brave, Edge, Chromium and
  Vivaldi), and asks the user to approve « Talk to other apps on your Mac »
  when the extension is added. An unpacked extension gets a local id
  (`local-…`), so whether Yab checks `allowed_origins` against the id the
  manifest's key pins is not known yet.

## Decision

- **Extension** (`apps/browser-extension`, MV3): for the tabs that play
  sound, outside private windows, it reports their address and title, the
  whole set at each change and at least every minute while linked
  (amendment); on YouTube a content script reports the
  video's position, speed, length and whether an ad plays, at each play,
  pause, seek, wait or speed change (from 0.3.0 also the page's address, its
  title and whether it is heard, second amendment). Nothing else of the page. Permissions:
  `tabs`, `nativeMessaging`, `alarms`, and the content script on YouTube
  (from 0.4.0 a page script on every site, third amendment).
  No network call, no remote code: every build checks the scripts for
  `fetch`, sockets, XHR and dynamic imports. Built with WXT (Téo,
  2026-11-09: Chrome, Firefox and Safari stores at release): one manifest
  per browser, `dist/chrome-mv3` for the unpacked build Sondine ships, and
  store zips built apart (`pnpm zip`) without the manifest's `key`. That
  public key pins the unpacked id (`nnieeegenbmpfllllldjpkolkldjmmdb`); the
  stores' ids join the allowed ones when it is published. WXT's message
  announcing the content script to the page, which carries the id, is off.
- **Transport**: Chrome native messaging to `sondine-browser`
  (`Contents/Helpers`), a byte relay like `sondine-mcp` (ADR 011) under App
  Sandbox with the app group only. It names the browser that started it
  (its nearest ancestor inside an app bundle), turns native messages into
  JSON lines on core's socket `run/browser.sock` (0600, in the 0700 run
  directory) and hands core's one answer back. Core listens only while the
  user's switch is on. Wire format: `packages/protocol/src/browser-messages.ts`.
- **Switch**: Settings ▸ Navigateurs, « Savoir quelle page joue le son »,
  off by default: it needs the extension, and turning it on writes Sondine's
  host manifest into each installed browser's folder (Yab, Helium, Chrome,
  Chromium, Arc, Brave, Edge, Vivaldi); turning it off takes them back and
  closes every link. « Montrer l'extension dans le Finder » copies the
  unpacked extension into the data directory (refreshed at each start while
  the link is on) for « Charger l'extension non empaquetée ».
- **Storage**: `web_plays` (browser, site, page key, address, title, wall
  span; one row per page in a tab) and `web_play_marks` (a video's position
  at an instant). The site is the host without `www.`/`m.`; the page key is
  `youtube.com/watch?v=<id>` for a video, else host and path. YouTube's
  other pages in a tab that plays a video keep the video (the mini player).
- **Grouping** (`grouping/5`, `grouping/6` since the amendment): a media region gets the page its app's
  browser reported at its wall midpoint (its app: the app track's, or the
  `system:other` attribution), when exactly one page played; two tabs at
  once give none (one track mixes them). A `system:other` region macOS
  named no app for takes the one page any browser played then (ADR 026:
  among browsers without a track of their own, which play nothing into
  `system:other`): several
  apps often hold their output open in silence (Téo's first YouTube video
  in Yab, 2026-11-09, had no attribution), while a browser reports only
  tabs that make sound. Media splits by page: two videos in a row are two
  episodes; a region with no page joins the episode going on (amendment). The episode keeps its `page_key`, and names the browser when
  macOS named no app. A late region joining a closed episode ignores pages.
- **Tabs in Yab**: a YouTube report's tab is the sender's when the
  extension lists it; otherwise the listed tab on the report's video, then
  the one listed YouTube tab, and core likewise gives a report to the one
  open play of its video. Yab's first test sent the page but no position;
  see the amendment for what Yab does to the link.
- **Window**: a media episode names its page, « YouTube · <titre> », a link
  that `episodes.openPage` opens in the default browser through main
  (`open-page`, http and https only), never in the window. On YouTube each
  sentence offers to open the video where it started: the latest mark
  before the sentence, moved at its speed (`positionAt`), nothing during an
  ad. Today's media rows name the page instead of the browser.
- **Site rules** (now private zones, ADR 029: « Sites de films, séries et
  musique » and one zone per site): each site heard is listed with « Garder <site> »; « Ne
  pas garder » adds any site, typed as its name or an address on it. A
  site not kept cannot be left out at capture (the tap mixes every tab of
  a browser): when its episode closes, the grouping pass
  deletes it in the same transaction, before its job can run, as
  « Supprimer » would (tombstones, text, regions, the page's plays), then
  marks deleted the audio blocks of its tracks wholly inside the page's
  plays that no other region needs with its roll, under tombstones; the
  window, agents and the scrubber follow as for a user deletion. A rule
  applies to the episodes that close from then on; what is recorded stays.
  Left out by default (Téo, 2026-11-09, `DEFAULT_UNKEPT_SITES`), each listed
  from the start with its switch: films and series (Netflix, Prime Video,
  Disney+, Canal+, Apple TV) and music (Spotify, Deezer, YouTube Music,
  Apple Music, SoundCloud). Every other site is kept. A rule equal to the
  default is not stored, so a later release can change the defaults.
- **Deletion and retention**: a deleted episode takes its page's plays over
  its span; « forget the last minutes » takes the plays in the range; plays
  no episode met are pruned two days after they end. Logs never carry a
  site, an address or a title.

## Consequences

- A tab in a private window, a browser without the extension, or two tabs
  playing at once give media episodes as before (« Média · Yab »).
- DRM: Chromium plays Widevine content (Netflix in Helium) by decrypting
  audio in software into its normal output, so a process tap hears it;
  expected, not measured (no Netflix in Téo's history). WebKit's FairPlay
  (Netflix in Yab) is not verified. Where a tap hears nothing, there is no
  episode to keep or leave out, and the page is still recorded as played.
- A development build writes its manifest (pointing at the debug relay
  through a wrapper script) into the real browsers' folders, replacing the
  installed app's, unless `SONDINE_NATIVE_HOSTS_DIR` names a test folder. With
  the link off, a build removes only its own manifests and those that lead
  nowhere (2026-11-25: a development build started with the link off had taken
  the installed app's away).
- Stores: the Chrome Web Store serves Chrome and the browsers that install
  from it (Yab, Helium, Arc, Brave, Edge). The Firefox build exists
  (`gecko.id` `browser@sondine.app`, Firefox 140 ESR and later, no data
  collected) but is untested; Firefox also needs Sondine's host manifest
  under `~/Library/Application Support/Mozilla/NativeMessagingHosts` with
  `allowed_extensions`, and the relay to read Firefox's arguments (the
  manifest's path, then the extension's id). Its sources zip holds only the
  extension's package, whose build reads the protocol package and makes the
  icons from the app's `.icns` with macOS tools: committed icons would make
  it reproducible for a reviewer. Safari needs an app extension inside
  Sondine.app, whose messages reach the containing app rather than a relay:
  core then needs a link without a standing connection.
- The relay names a browser from its bundle's Info.plist, which App Sandbox
  lets it read under `/Applications` only: a browser installed in
  `~/Applications` connects without a name, and its plays are not kept.

## Amendment — 2026-11-10: the link in Yab

Téo (2026-11-10 14:05): « j'ai pas l'impression que l'extension est très
stable ». A YouTube video played in Yab from 13:51 and gave « 13:51 – en
cours », « Média · Yab », without its page, plus a one-minute episode of the
same video with its page (14:01:02–14:02:02). One play in `web_plays` that
day, 14:01:28 to 14:02:28, exactly 60 s, no position; two relays alive, both
connected to core; no log (the installed app sends core's output nowhere).

### What Yab does (Yab 0.47.7, measured 2026-11-10, Téo's tabs untouched)

- **No `tabs.onUpdated` for `audible`.** A 3 s tone in an agent tab, started
  by a click with no worker running, woke nothing: no worker load, no play.
  Only a read of the tabs sees a tab start or stop making sound. A worker
  started by any other tab event read Téo's playing tab as audible
  (14:01:28, 14:18:21): the pinned tab shared in every space is seen.
- **The one-minute alarm dropped the tab.** Both plays (14:01:28 and
  14:18:21) ended 60.1 s after they opened, by a `tabs` message without the
  tab, while the video played on. The alarm was then cleared (nothing
  listed), so nothing read the tabs again until the next tab event.
- **Two workers at once, and ports nobody holds.** WebKit unloads an
  extension's background page 30 s after its last event; its service worker
  runs on in the worker process while it holds a port it used in the last
  two minutes. At the alarm, WebKit loaded a second background page while
  the first worker still ran (system log: process 20477, the 14:18:21
  worker, still running at 14:19:21.5 when the new page loaded). The first
  worker sent the list without the tab; the second's port never carried a
  word: its relay stays connected to core for good. Relays 13:50:30,
  14:02:28 and 14:19:21 were still alive at 14:28; the one whose worker used
  its port closed 2 min 20 s after its last message, as WebKit says.
  Core refused new links once 8 relays were open.
- **Yab's shim** (`yab-shim.js`, prepended to the worker): a page's
  `runtime.sendMessage` that gets no answer makes the page ping the worker,
  and Yab starts the worker over when the ping goes unanswered; a worker
  that called `tabs.query` in the last 30 s is kept loaded (a fresh
  `yab.keep` port every 10 s). Yab loads its own copy of an unpacked
  extension (`~/Library/Application Support/Yab/Extensions/<id>`), copied
  when it is loaded: a new build reaches Yab only through « Recharger ».
- Why a worker's read misses a playing tab at the alarm is not settled from
  outside: a worker WebKit let go may read nothing, or Yab may say the tab is
  silent for a moment. The new trace records each read's counts (tabs,
  audible ones), so the next occurrence says which.
- No position came because the tab was never listed for more than a minute;
  whether reports reach the worker in Yab is now in the trace too
  (`media`, `marked`).

### Decision

- **Extension 0.2.0.** While the link is up the worker reads the tabs every
  20 s: a tab that starts playing is seen within 20 s with no event, and the
  worker stays loaded in Yab (and in Chrome, where each API call counts), so
  the alarm reaches the same worker rather than a second one. The list goes
  out at each change and at least every minute (`hello.refreshMs`, 60 s);
  each `tabs` message says what its read saw (`read`: cause, tabs, audible,
  counts only). The alarm stays on while the link is open, not only while a
  tab plays: it starts a worker the browser let go; after an open link is
  lost (Sondine restarted) it tries again at each alarm for 10 minutes,
  until Sondine answers or refuses (« not running » keeps trying). A read that finds no tab
  at all while a tab is listed is not believed; a closed tab leaves the list
  at once (`onRemoved`). Once a minute, whatever the list does meanwhile, the worker
  asks the listed YouTube pages where their video is, so a missed media
  event costs a minute of positions at most, and it answers each report, so
  Yab's page never takes it for gone.
- **Links of one browser share its plays.** A tab plays while any open
  link's latest list has it, with the address and title of the link heard
  last; a second link never duplicates a play, a link that closes ends only
  what no other link lists, and a play never ends before the latest list
  that had it (a stale link expiring does not undo a fresher one).
- **Core closes links with nobody behind them**: answered, a link that says
  nothing within 15 s (Yab's dead ports); a link that promised a refresh and
  stayed silent twice its period and 30 s more (its plays end at its last
  word). At 8 links, the one silent the longest (a minute at least) gives
  its place instead of the new one being refused. Closing a link ends its
  relay.
- **Trace.** `diagnostics/browser-link.jsonl` (two files of 256 KiB at
  most): links opened and closed with their reason, each hello's version
  and refresh, each read whose list or audible count changed (tab ids and
  counts), whether reports mark a play, plays opened and ended with their
  reason; a message the schema refuses by its issue's code only (a
  message's words may quote what the extension sent). Never a site, an
  address or a title.
- **Settings ▸ Navigateurs** shows each browser's link as it is: « Relié ·
  a parlé à 14:19 », « Relié · silencieux depuis 14:02 », « Pas relié · a
  parlé à 14:19 », « Pas de nouvelles de l'extension » (was « Extension pas
  encore connectée »), the number of links when there are several, and
  « Extension 0.1.0 : rechargez-la dans Yab pour passer à la 0.2.0 » when it
  is older than the one Sondine carries (part by part, never for a newer
  one).
- **Grouping `grouping/6`.** One media lane per source. A region whose known
  page differs from its episode's known page starts the next episode
  (`page-changed`), once the episode's speech before it has ended (an
  overlapping region joins, so a closed episode never changes with later
  input); a region with no page joins the episode going on,
  unless another app made it (`system:other` holds every app without a
  track). Two videos in a row stay two episodes; a video whose page is
  known for one minute is one episode with that page. Closed episodes keep
  their grouping (`grouping/5`): a pass regroups only regions no closed
  episode holds, so only an episode still open when the update starts is
  regrouped by the new rules. Téo's 13:51 and 14:01 episodes stay as they
  are.

### Measured (always-on path)

- Core: 4.6 µs to parse and apply a heartbeat with one tab (5,000 in a row,
  Téo's MacBook Air M5), once a minute per browser.
- Browser: two headless Helium 0.21 (Chromium 157) side by side on the same
  Mac, throwaway profiles, a stand-in native host answering `{"ok":true}`,
  no tab playing, 5 min after a 1 min warm-up: the whole browser used
  0.25 s of CPU with extension 0.1.0 and 0.27 s with 0.2.0, which read its
  tabs 15 times and sent 5 heartbeats. The difference is within `ps`'s
  0.01 s resolution, under 0.01 % of a core.
- Yab: not measured (only Téo can load the new build there). The worker
  stays loaded instead of being started again at each tab event and alarm
  (a WebKit process each time, 9 MB of footprint at launch per the system
  log), and Yab's shim opens a `yab.keep` port every 10 s while it does.

## Amendment — 2026-11-10 evening: Yab runs the extension in Chromium

Extension 0.2.0 was loaded in Yab at 15:14:41 and nothing improved: episode
1083 (15:31:46–15:32:23, a YouTube video in Yab) had no page, and no play
was recorded after 15:14.

### What the trace and Yab showed

- **The worker lives and reads.** Its link lived 3 h 01 min and sent 183
  messages (its heartbeats); every read found no audible tab.
- **It reads Yab's other engine.** Since Yab restarted at 15:14:26, the
  relay's parent is `YabCore` (Yab's Chromium engine, CEF), not the `yab`
  process that drives WebKit; Yab installed the unpacked extension into the
  Chromium profile of the « Personal » space, and WebKit has not loaded its
  copy's background once since. Chromium's `tabs.query({})` returned 1 tab
  at 15:14:41 and 2 at 18:16:41 while Téo had 15 open, all in WebKit; it
  went to 3 at the next heartbeat after an agent tab opened (agent tabs run
  in Chromium). Its tabs API lists only Chromium's tabs.
- Yab carries Chromium extensions' content scripts into WebKit pages (its
  « WebKit IPC … extension catalog » and « WebKit page message relay »), so
  a page can still speak to the worker. Whether ours does in Yab is what
  0.3.0's trace says (`read.pages`).

### Decision

- **Extension 0.3.0: a YouTube page says it plays.** With each report the
  content script says the page's address and title (`document.title`, the
  tab's title) and whether its video is heard (playing, not muted, volume
  above 0), under an id of its own drawn above 2^30; it reports every 30 s
  while heard, at `volumechange` too, and says it went quiet when the page
  goes (`pagehide`). The worker lists such a page as a playing tab, under
  its own id, for 75 s after its last word, only while no read tab stands
  for it: where the tabs API knows the page's tab (its sender's id, or a
  read tab on its video), the read judges, a tab muted from the browser
  included. A page goes at once when it says it is quiet, or its tab
  closes or leaves YouTube, and with it its cached position. Core sees only
  the usual `tabs` and `media` messages; each read also says how many pages
  spoke (`read.pages`). Two tabs on one video, one read and one only by its
  page, are one: the second's positions join the first's play (rare, and
  the same page either way).
- Other sites stay unknown in Yab while it runs the extension in Chromium:
  only YouTube has a content script (question to Téo below).

### Measured

- The worker spends 3 µs on a page's report (10,000 in a row, M5), twice a
  minute while a video is heard; a still page sends nothing.
- Codex Astra's review of 0.3.0 (2026-11-10): four findings (a page and its
  read tab listed twice, a tab muted from the browser kept by its page, two
  tabs on one video sharing an identity, expired pages' positions kept),
  all fixed as above; an orphaned page script stops when the browser
  refuses its message.

### Question to Téo

1. Every site in Yab: a content script on all sites would let any page say
   it plays (Netflix and Spotify zones in Yab need it), at the price of the
   browser's « lire et modifier toutes vos données sur tous les sites »
   permission and a script in every page. Recommended: yes, the same
   report as YouTube (address, title, heard or not), nothing else of the
   page.

## Amendment — 2026-11-10 night: a page script on every site

Téo answered the question above (21:56): « oui je suis d'accord, tant que ça
peut nous permettre une meilleure UI et UX ». The broader access must show
in the app, not only in the data.

### Decision

- **Extension 0.4.0: every page says when it is heard.** A page script runs
  in the top frame of every http and https page but YouTube's (whose own
  script says the same and the video's position). It listens to the media
  events of the page's audio and video elements (play, playing, pause,
  ended, emptied, volume) and, when the page starts or stops being heard,
  and every 30 s while it is, says the page's address, its title and that
  it is heard, under its own page id; and that it is no longer heard when
  the page goes (`pagehide`). A page never heard says nothing; a silent
  page runs nothing (no timer, no observer), only its listeners, and once
  it stopped being heard it reads and says nothing more until it is heard
  again. It reads nothing else of the page. The worker takes these words as it takes
  YouTube's (second amendment): the read judges a tab the tabs API knows.
- **Permissions**: the page script's matches (`http://*/*`, `https://*/*`)
  give the extension access to every site; browsers say it « can read and
  change all your data on all websites ». Settings ▸ Navigateurs says what
  it reads (a page's address, its title, whether the sound is heard, and on
  YouTube where the video is and whether an ad plays) and what it never
  reads (the page's content, what is typed, a page that has not played
  sound), and why the browser words its access so.
- **Rules**: such a page is a play like any other: sites not kept by
  default (`DEFAULT_UNKEPT_SITES`, « Sites de films, séries et musique »)
  and site zones (ADR 029) apply to its episodes, and the trace never holds
  its address or title. A media episode names its page whatever the site
  (« site · titre »).
- **Limits**: sound from an element outside the page's document (an
  `Audio` object never added to it) or from Web Audio alone is not heard;
  nor are frames (an embedded player in another site's frame). Spotify's
  web player may be such a case: not checked.

### Measured

- The page script (14.7 kB unminified, mostly WXT's context) evaluates in
  19 µs median, 32 µs at the 95th percentile, in a page with two silent
  media elements (500 runs in Node's V8, M5); then nothing runs until a
  media event. A heard page sends a message every 30 s; the worker spends
  3 µs on each (second amendment).
- Headless Helium 0.21 with a stand-in native host and `--mute-audio`
  (nothing reached the speakers), a local page playing a tone: the page's
  word reached the worker (`read.pages: 1`); Chromium knows that tab, so its
  read judged it (silent, the browser's sound muted) and listed nothing.
- In Yab: to be read in the trace once Téo reloads the extension
  (`read.pages` while a page plays).
- Codex Astra's review of 0.4.0: a silent page could still send its new
  address after a pause, and Settings said « rien des pages muettes » too
  broadly; both fixed (a page reads nothing once silent; Settings names
  YouTube's ad state and « une page qui n'a pas joué de son »).

### « Ne plus garder <site> » (Téo's yes, 22:11)

- A media episode with a page has « Ne plus garder <site> » in its « ⋯ »
  menu while the site is kept: it adds the site's zone at « Rien » (ADR
  029), or turns on the site's zone there is and sets it to « Rien ». From
  then on what the site plays is deleted when its episode closes, before
  any transcription; an episode still open that goes on hearing it goes
  with it. Recordings already closed stay. The toast says so and offers
  « Annuler », which puts back what was. The zone is in Settings ▸
  Confidentialité like any other.
