# 029 — Private zones: what Sondine listens to, transcribes and keeps

Status: Accepted — 2026-11-09 (Téo's answers at the end: « Ce réseau »
without Location, and last; durations by type; a gesture to keep a
recording's audio). Amended 2026-11-14: « Garder les 2 dernières minutes »,
the same gesture over the last two minutes (below).

## Context

Plan.md « Later » 3: rules by app, Wi-Fi network or time of day, and a
retention by kind (traces, moments, conversations; audio apart from text).
Téo (2026-11-09) wants more: « repenser la façon pour avoir un truc beaucoup
plus global, permissif, mais en même temps simple à comprendre. On peut
s'inspirer de LookAway. »

Today six places decide whether Sondine listens, transcribes and keeps, each
in its own words:

- **Pause** (menu bar): 15 min, 1 h or until resumed (`capture.paused`,
  `capture.pause-deadline`, architecture §11).
- **Forget** (menu bar, sidebar): the last 5, 15 or 60 minutes.
- **Sites** (Settings ▸ Navigateurs): a site not kept is deleted when its
  episode closes, before any transcription; films, series and music are left
  out by default (`browser.sites`, ADR 023).
- **Dictation apps** (Settings ▸ Dictées): which apps count as dictation
  (`dictation.apps`, ADR 020). A classification, not a privacy rule.
- **When to transcribe** (the « why it waits » panel): on power and idle
  (`analysis.waitFor`, ADR 016). Téo keeps these rules (2026-11-06).
- **Audio retention** (ADR 015): speech audio 30 days after its episode
  closes, archived audio capped at 20 GiB. Not built: retention archives
  speech out of the 24 h spool and never expires the archive (1.6 GB on
  Téo's Mac on 2026-11-09, since 2026-11-04).

The helper has carried `excludedBundleIds` since M0 (an app out of every tap,
never named in front), but core always sends `[]`. Since ADR 026 every app
playing sound has its own tap, so an excluded app is truly not captured. An
excluded app in a call, though, is not reported as a call at all
(`capture-engine.swift`, `updateCalls()`): the microphone would keep the
user's side as in-person speech.

### What others do (2026-11-09)

- **LookAway** (docs, changelog, the 2.4.10 bundle on Téo's Mac): Smart
  Pause reads « Automatically pause LookAway during » followed by switches
  named by activity (Meetings or Calls, Video playback, Deep focus apps,
  Screen recording or sharing, Calendar events, a Focus); the mechanism sits
  behind « Options… ». Every switch has one outcome (hold, then resume on its
  own) and any one active wins. Lists come filled. The menu bar always says
  why (« On a Call », « Sharing », « Locked »), with a way to ignore it once.
  Permissions: Calendars only, asked from its own switch; no Wi-Fi rule.
- **Screenpipe**: « Record Audio While Locked » off by default; per-range
  schedules; « Storage policy »: keep everything, « drop video + audio, keep
  text », or delete everything, after 7 to 90 days.
- **Microsoft Recall**: « Apps to filter », « Websites to filter », a
  storage cap and « Maximum storage duration » (30 to 180 days, unlimited).
- **Granola**: keeps no audio; enabling or changing transcript
  auto-deletion starts a one-week cooldown.
- **macOS Focus**: « Add Schedule » by Time, Location (needs Location
  Services) or App; third-party apps can add a Focus filter.

## Decision

### One model

**By default Sondine keeps everything. Each private zone takes something
away; several zones add up. The user's own gesture on a recording comes
first.**

Every recording ends up with:

- **what is kept**: audio and text, text only, audio only, or nothing;
- **how long its audio stays**: by type (below);
- **when it goes whole**: never by default.

Each zone takes away the audio, the text, or both, or sets a time after which
the recording goes. What is kept is what no zone took away; with nothing
left, nothing is kept (« Texte seul » and « Audio seul » together keep
nothing). Times take the shortest. A zone never keeps more; only a gesture
does: « Garder l'audio » on a recording keeps its audio past every duration,
zone and the disk cap, until the user says « Ne plus garder » (Téo,
2026-11-09).

Layers, read top to bottom: gestures (pause, forget, « Supprimer »,
« Transcrire maintenant », « Garder l'audio », « Garder les 2 dernières
minutes »), then zones, then the durations by type, then the disk cap (the
oldest audio goes first; text stays).

### Zones

A zone is a situation and an outcome. Situations, named by what happens:

| Situation                                            | Known from                                                  | Permission |
| ---------------------------------------------------- | ----------------------------------------------------------- | ---------- |
| **Une app**: its sound, its calls, its dictations    | the helper's process catalog (ADR 026)                      | none       |
| **Un site**                                          | the browser extension, while the link is on (ADR 023)       | none       |
| **Ce réseau**                                        | the router's signature in SystemConfiguration               | none       |
| **Des horaires**: days, from–to, past midnight       | a wall-clock timer to the next boundary                     | none       |
| **Appels et réunions** (built in, off)               | the helper's calls (ADR 007)                                | none       |
| **Écran verrouillé ou éteint** (built in, off)       | the helper's lock, screen saver and display sleep (ADR 022) | none       |
| **Sites de films, séries et musique** (built in, on) | ADR 023's ten sites, each with its switch                   | none       |
| **La nuit**, 23:00–7:00 (built in, off)              | hours                                                       | none       |

Outcomes, one menu, labelled by what happens:

| Outcome                  | Takes away        | Shown under the row                                                   |
| ------------------------ | ----------------- | --------------------------------------------------------------------- |
| **Rien**                 | audio and text    | « Pas enregistré », or « Effacé à la fin, avant toute transcription » |
| **Texte seul**           | audio             | « L'audio est effacé une fois transcrit »                             |
| **Audio seul**           | text              | « Jamais transcrit »                                                  |
| **Effacé après 7 jours** | all, after 7 days |                                                                       |
| **Effacé après 1 jour**  | all, after 1 day  |                                                                       |

A new zone starts at « Rien ». A row is an icon, the situation with one line
of detail, the outcome's menu and a switch; « Retirer » ends the menu.

### Which recordings a zone touches

A recording that touches a zone while the zone is on takes its outcome: they
share 250 ms, or all of a shorter recording, so one that only meets a zone at
its edge (a hold stops capture as its situation starts) is not taken. Every
span of a zone counts: one whose outcome changed while it was recorded takes
both. Zones
only take away, so a conversation that started before 23:00 and goes on into
« La nuit » loses for all of it what the zone takes. A hold stops capture, so
it cuts the recording there. What decides is stored, never a snapshot: when
each zone was on and with which outcome (`privacy_zone_spans`), when the
screen was away and which network the Mac was on (`situation_spans`, from
the helper), the calls, the apps an episode heard and its page. A split, a
merge, a late region or a new grouping version gives the same answer, and a
merge keeps the stricter of the two, as « Ne pas identifier » does
(architecture §6).

- **App**: the recording heard the app (its track, a call it made, a
  dictation to it, `system:other` attributed to it); an app zone on a call
  app covers the whole call, microphone included.
- **Site**: the recording's page is on the site (ADR 023).
- **Ce réseau**, **Écran verrouillé ou éteint**: the recording overlaps a
  situation span while the zone was on.
- **Appels et réunions**: the recording is a call.
- **Des horaires**: the recording overlaps the hours, on the Mac's clock,
  while the zone was on.

### How each outcome is enforced

At the earliest stage that can, and checked again at every later one.

- **Not captured.** For an app zone at « Rien »: the app goes in
  `excludedBundleIds` (never tapped, never named in front), and while it is
  in a call or listens to the microphone (a dictation app), the microphone
  is held, until 10 s after. Network, hours, screen and calls at « Rien »
  hold capture (microphone and Mac sound) while they last. The helper
  decides holds itself from the zones in its `config`: triggers are tracked
  apart from what it reports (an excluded app's call is still seen), capture
  opens only when the user's intent allows it, the device is there and no
  hold applies (checked before every open, unmute, retry and reconnect), and
  the helper applies its config before it opens anything, as today. At a
  hold's start it drops the microphone samples after the trigger that are
  not committed yet. Protocol 5 below.
- **Deleted at close, before any job.** A site (one browser tap mixes every
  tab), through ADR 023's path (`dropUnkeptEpisodes`).
- **No text.** Live text, final jobs and compare-and-publish all read the
  episode's zones: a recording a zone keeps from text is never transcribed,
  not even provisionally, and publish refuses text it may not keep.
  « Transcrire maintenant » still works (a gesture). Voice exemplars are
  never taken from a recording whose audio a zone takes away.
- **No audio, once transcribed.** When the final transcript is published,
  the recording's audio blocks are marked deleted in the same transaction
  (playback and exports read silence at once), then scrubbed from spool and
  archive by the existing machinery (within about 20 min, architecture
  §15). A 2 s block shared with a kept neighbour goes too: the neighbour
  loses up to 2 s of roll, not text. A recording still untranscribed 7 days
  after it ended loses its audio anyway.
- **Effacé après N jours.** The retention pass deletes the recording through
  the same coordinator as « Supprimer » (tombstones, secure-delete of the
  text, history, exports and agents refused, the player told). Corrections
  and context go with it, as with « Supprimer ». This amends ADR 006 and
  ADR 015, which keep text until the user deletes it: a zone the user set
  is the user deleting, on a schedule.

### Durations

Text stays until the user or a zone deletes it. Audio stays, from the
recording's end:

| Type          | Audio   |
| ------------- | ------- |
| Appels        | 90 days |
| Conversations | 90 days |
| Moments       | 30 days |
| Traces        | 7 days  |
| Médias        | 7 days  |
| Dictées       | 7 days  |

Settings shows one line (« l'audio 7 à 90 jours selon le type ») and « Par
type » folded, with the audio duration and an optional « Effacé après » per
type. A type follows the episode as shown (`context`, `size`, and the user's
« Type ▸ »), which amends ADR 007 (« thresholds never affect retention ») on
purpose. Retranscription never restarts a clock. Audio still waiting for its
first transcript when its time is up waits for it at most 7 more days.

A duration changed later applies to what is kept, past included, and says
first how much would go now. Zones apply from the moment they are on.

### A zone is never a pause

A hold never writes `capture.paused`: it ends on its own. The helper keeps
three things apart in its protocol: the user's pause, the active holds (each
with its zone and occurrence), and what actually captures. The menu bar says
why: « N'écoute pas : la nuit, jusqu'à 7:00 », « N'écoute pas : appel Zoom »,
and every other hold still active. « Écouter quand même » lifts one
occurrence of one hold until it ends (7:00, the end of that call, leaving
the network, unlocking); it never touches the pause and survives sleep and
reconnection within the occurrence. Settings writes and measurement scripts
change zones only, never the listening intent.

### Helper protocol 5

- `config` gains `holds`: `calls` and `screen` (booleans), `schedule` (days
  and minutes on the Mac's clock, past midnight allowed), `networks` (keyed
  hashes), `networkKey` (the per-install key) and `lifted` (hold occurrences
  the user lifted). `excludedBundleIds` keeps its meaning and also holds the
  microphone while an excluded app is in a call or listens, until 10 s
  after.
- `situation` (on change and in a snapshot): whether the screen is away, and
  the keyed hashes of the networks the Mac is on.
- `holds` (on change and in a snapshot): every active hold, with its
  occurrence id, reason, scope (`all` or `microphone`), start, and whether it
  was lifted.
- A run a hold ends closes with `held` (stored as `stopped`, like
  `excluded`); the hold itself is in core's status, not in `paused`.

### Ce réseau, without Location

Since macOS 14 the Wi-Fi name and BSSID need Location Services (CoreWLAN;
`SSID_STR` in SystemConfiguration reads empty on Téo's Mac, macOS 27.2), and
macOS 27 empties the ARP table for apps. The network's signature is still
readable: each service in `State:/Network/Service/*/IPv4` (and `IPv6`)
carries `NetworkSignature` (the router's address and hardware address, or
the IPv6 prefix and router hardware address), behind a VPN too.

« Ce réseau » stores the keyed hashes (a random key per install) of every
signature the Mac reads on the network the user is on (IPv4 and IPv6, so a
new IPv6 prefix from the provider still finds it), under a name they type
(« Bureau »); no raw signature reaches the database or a log. The helper
subscribes to changes of those keys on its run loop. Unknown or unreadable
network: the zone is off, and Settings says so. A router replaced, or a
failover to another router, is another network; a phone's hotspot travels
with the phone. The key is undocumented and may go the way of the ARP
table: then « Ce réseau » offers Location instead (question 1).

### Screen sharing

No public API says the screen is shared (only the private
`CGSIsScreenWatcherPresent`), and sharing changes nothing that is recorded:
not a zone. The notch island's window gets `sharingType = .none`, so it never
appears in a share or a recording. The menu bar's « Marie ? » cannot be kept
out of a capture by Electron and stays.

### Settings

Settings ▸ « Confidentialité », after « Ouverture »: one line for the
default (« Audio et texte · l'audio 30 jours », « Par type » folded), then
the zones, then « Ajouter une zone » (« Une app… »: the apps heard, latest
first, then « Autre app… »; « Un site… »; « Ce réseau »; « Des
horaires… »). Navigateurs keeps the extension's link; its site list moves
here. Dictées keeps which apps count as dictation. A recording a zone
changed says so in one line (« Zone Zoom : audio effacé une fois
transcrit »).

### Migration

- `capture.paused` and its deadline: untouched; nothing here writes them.
- `browser.sites`, in one idempotent transaction, with a fixture per case:
  a site not kept becomes a site zone at « Rien »; a default site kept stays
  a switch off inside « Sites de films, séries et musique »; rules equal to
  the default stay unstored. With the browser link off, nothing changes
  (sites act only on reported pages).
- ADR 015: audio recorded before the update keeps at least 30 days from it,
  whatever its type, so no install loses audio sooner than 30 days after it.
- `dictation.apps`, `analysis.waitFor`, `live.enabled`, identity rules:
  unchanged.

### Cost

Nothing new polls. Apps, calls, listens and the screen come from listeners
the helper already has; hours are one timer to the next boundary, checked
again at wake (no wake assertion); the network is one SystemConfiguration
notification; expiry joins the 10-minute retention pass with an indexed
query. Holds stop IO, so a zone at « Rien » saves energy. See « Measured ».

## « Garder les 2 dernières minutes » (amended 2026-11-14)

Plan.md « Later » 1, ADR 015's « moments the user keeps ». One gesture keeps
what the Mac captured in the two minutes before it, from the menu bar
(« Garder les 2 dernières minutes », above « Effacer »), **⌃⌥⌘K** from any app,
or the sidebar's pause menu; all three call `episodes.keepRecent`, never
offered to agents.

- **What is kept: audio, not an episode.** For every run of a microphone or
  the Mac's sound over those two minutes (never a phone recording or an
  imported file, ADR 032), its samples then go in `kept_audio` with origin
  `moment`, speech or not, placed by the run's own block times, including
  what an open run has not committed yet (at most 10 s after its last block,
  and only while blocks keep coming). So it holds through whatever becomes of
  that audio: the spool archives what a kept range reaches instead of
  dropping it after 24 h (`planArchive`), the region still open and the
  episode not closed yet are kept once they close, and a split, a merge or a
  new grouping finds the range where the audio is.
- **What it keeps a recording from losing**: the same as « Garder l'audio ».
  A recording a kept range reaches keeps its audio past every duration, the
  disk cap, « Effacé après » by type or by zone, a zone's « Texte seul », and
  a site at « Rien » deleting it at close. Gestures come first: the user
  pressed it while that audio was heard.
- **What it does not override.** A zone's hold wins by itself: nothing was
  recorded, so nothing is kept. A zone that keeps the text from being made
  still does (« Transcrire maintenant » remains the gesture for that). A later
  gesture wins over it: « Effacer les N dernières minutes », « Supprimer », or
  « Ne plus garder » in the recording's « ⋯ », which releases the moment with
  the recording's speech (a region still open, to its end).
- **Nothing captured** (paused, held, erased, a gap such as the disk full,
  Sondine off): nothing is written and the menu bar says « Rien d'enregistré
  à garder ». Listening started or stopped part-way: what exists is kept, and
  the menu bar says how much (« Gardé : 45 s »), counted from the blocks
  present or archived, never from the runs' bounds alone. A clock set forward
  since a run started finds nothing of that run in the window: it keeps
  nothing there rather than audio still to come.
- **Shown**: the recordings it reaches read « Gardé à 14:32 » (the gesture's
  time) in Today, the conversation going on and the recording's page, beside
  « Audio gardé, au-delà de toute durée »; `Status.kept` grows with each
  gesture that kept something, so every window reads its recordings again,
  the menu bar's gesture included. Sondine has no names for
  recordings, so the moment keeps that label; naming recordings is a
  separate feature. Two minutes of silence reach no recording: they are kept,
  and nothing shows them.
- **Cost**: nothing runs until the gesture. Then one transaction over the
  runs open or with a block in the window (indexed by block time), and two
  indexed lookups per run; the spool pass reads `kept_audio` by run and
  sample, as it reads speech regions. About 3.8 MB per track for two minutes
  of 16 kHz PCM.

## Measured

- **Network signature**, 2026-11-09, Téo's Mac (macOS 27.2, Wi-Fi with a
  VPN in front): `NetworkSignature` and its hash are readable from a
  terminal and from a probe under App Sandbox with no other entitlement (an
  ad-hoc signed binary with a bundle id), giving the same hash; `SSID_STR`
  reads empty and the BSSID redacted. 2026-11-10, the signed, sandboxed
  helper of `d719f69` (`sondine-audio self-test network`): store readable,
  2 networks (the Wi-Fi's IPv4 and IPv6 signatures).
- **Listening for network changes**, same Mac, 590 s: a probe subscribed to
  `State:/Network/Service/.*/IPv4` on its run loop against the same probe
  not subscribed, sampled with `sondine-meter` every second: both 0 CPU,
  0 idle and 0 interrupt wakeups, 0 energy; footprint 2.20 MB against
  2.13 MB. The network did not change during the run.
- **The helper with protocol 5**, 2026-11-10, Téo's Mac, release builds on
  the fake HAL (`serve --hal fake`, Silero, microphone and `system:other`
  recording), side by side for 3 min with the build before it (0b5acba),
  sampled every second with `sondine-meter` (the first 5 s left out). The
  new one had zones on that held nothing: calls, hours on Wednesdays, a
  network the Mac was not on, with the install key (so it watched and hashed
  the networks). CPU 3.36 s against 3.33 s (1.92 % against 1.91 %), 4.52 mW
  both, idle wakeups 0.41/s against 0.35/s, interrupt wakeups 48.1/s against
  47.9/s; footprint 27.6 MB against 28.3 MB on average, 33.5 MB against
  33.3 MB at most. Within the run-to-run noise: the zones add nothing that
  runs while nothing changes.
- **Holds on the fake HAL** (`native/Tests/SondineCaptureTests/private-zones-tests.swift`):
  an excluded app's call and a dictation app's listen hold the microphone
  (10 s after for a call) and stay unreported; a call, the screen away, a
  night window (across midnight, across the October DST change, and after a
  time zone change) and a network (10 s after leaving it, 60 s after a wake)
  hold everything; a lifted occurrence captures until it ends; a resume
  during a hold opens nothing; sleep ends no occurrence. A hold cuts the
  microphone's run at its trigger, to the IO cycle: what the ring held after
  it is dropped, and what had already reached the 2 s commit buffer is
  stored as silence.

## Considered

- **One outcome for every zone** (LookAway): « hold » is LookAway's only
  outcome; Sondine also needs « texte seul », « audio seul » and shorter
  times. Kept one menu per zone instead, with « Rien » first.
- **Ordered levels, the most discreet wins**: « texte seul » and « audio
  seul » are not on one scale. Taking things away adds up instead.
- **A free « when… then… » builder** (Shortcuts, Hazel): every rule becomes
  a small program to read.
- **Text and audio durations per type in front** (first draft, twelve
  menus): folded behind « Par type ».
- **Snapshotting zones when a recording closes** (first draft): a
  conversation that starts at the office and ends elsewhere, or a zone
  switched on halfway, had no clear answer.
- **Wi-Fi names with Location**: a list of names, and networks added before
  going there; but a recorder asking for the user's position costs trust.
- **macOS Focus filters** (LookAway does it): Focus already starts by time,
  place and app, with the system's permission. Needs an App Intents
  extension in an Electron app, and was reported broken on macOS 26.5.
  Later.
- **Calendar events** (EventKit): « private » meetings. Later.
- **Categories** (Screenpipe: password managers, banking, health): later, as
  built-in app lists.

## Limits

- An app left out still reaches the microphone through the speakers.
  Later: treat it like Sondine's own playback (ADR 020).
- A site is known only from the extension: two tabs at once, a private
  window or a disconnected extension give no site, so no site zone. Full
  protection is an app zone on the browser.
- A meeting where the user never takes the microphone is not a call: it is
  the app's media (an app zone covers it).
- Holding the microphone for an excluded app's call drops anything else said
  in the room meanwhile.
- Holds start one listener notification after their trigger (52 ms median
  for a new process, ADR 004; not a bound); uncommitted samples after the
  trigger are dropped, committed ones are not.
- Phone recordings (release 2) follow types only: started by hand, they
  are a gesture, which comes before zones, hours included (amended
  2026-11-10 by ADR 032).

## Téo's answers (2026-11-09)

1. « Ce réseau » without Location; « vraiment pas le plus important »: it
   comes last.
2. Durations by type as above, and « avoir la possibilité de garder un
   audio »: « Garder l'audio » on a recording.
