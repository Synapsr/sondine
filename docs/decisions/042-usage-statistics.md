# 042 — Anonymous usage statistics, by consent, and a diagnostic the user sends

Status: Accepted — 2026-11-25 for its scope (Téo's « ok » to the four points
below); the rest is how it is built, reviewed by Codex Astra before the code.
Amends: [ADR 001](001-stack.md) (« No PostHog »), [ADR 002](002-local-only.md)
(« no telemetry »), `AGENTS.md` (priority 1 and Safety),
`docs/product-vision.md`, `CONTRIBUTING.md`.

## Context

Sondine is about to open to its first people. Its local spans and benchmarks
stay on each Mac, so nobody can say who tries it, what they use, or where they
stop. Téo wants as much data as possible without keeping anything of what
Sondine hears. His handbook asks every app for daily use, features and
activation; Sondine keeps conversations, so it cannot follow the handbook's
defaults (on by default, a stable device identifier, the hour of each event).
He agreed to this, and only this:

1. One question at the first launch, two equal buttons. Nothing leaves without
   a yes.
2. One report a day, made of counts: actions per feature, the onboarding step
   reached, errors by code, the version of Sondine and of macOS, a band of
   memory.
3. No identifier, no hour, no content, no name of a person, an app or a site.
   The Mac works out « installed for 7 days, active on 5 » itself, so retention
   needs nobody followed. The report goes through our Worker, which drops the
   IP before PostHog (EU).
4. « Send a diagnostic »: its content is shown whole before it is sent, and it
   works even after a no.

## Decision

### Consent

- Two answers, `yes` and `no`, kept with the version of the question
  (`settings`, `usage.consent`). No answer is a no. Only the window answers:
  the procedure is off MCP and no phone reaches it.
- Before an answer, and after a no, Sondine counts nothing and keeps nothing:
  the counter returns before it looks at a call, and no timer runs.
- Turning it off writes the no and deletes the counts, the active days and the
  reports waiting in one transaction, stops the timer, and aborts a report
  being sent. Each call remembers the consent it began under (a generation,
  moved by every answer), so one that ends after a no, or after a new yes, is
  not counted. A report already on its way may still arrive; nothing new
  leaves. What PostHog already holds cannot be found again.
- A field added to the report, or a finer value, is a new version of the
  question: a yes to an older one no longer holds, its counts are deleted, and
  Sondine asks again. A test pins the schema to the version. A name may join
  the closed lists without a new question only when it names a feature or a
  failure and neither a provider nor a choice few people make; « Voir ce qui
  est envoyé » shows it.

### The report, field by field

`packages/protocol/src/usage-report.ts`: one strict schema that the Mac and
the Worker share. Every string is one of a closed list, or digits in a fixed
shape; nothing is free text.

| Field        | What                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `v`          | `1`, the version of the report and of the question                                                                            |
| `id`         | a random UUID (v4) made for this report alone, so a retry is counted once; no two reports share one                           |
| `day`        | the Mac's calendar day it counts, `2026-11-24`                                                                                |
| `app`        | Sondine's version, `0.7.0`                                                                                                    |
| `macos`      | macOS, major and minor, `27.0`                                                                                                |
| `memory`     | a band, in GB: `lt16`, `16-31`, `32plus`                                                                                      |
| `installed`  | days since the first run, a band: `0`, `1`, `2-6`, `7-13`, `14-27`, `28-89`, `90plus`                                         |
| `activeDays` | active days among the last 7, this one included, 0 to 7; `null` until Sondine has been installed, and allowed to count, for 7 |
| `onboarding` | the first run's step reached: `welcome`, `statistics`, `permissions`, `model`, `voice`, `start`, or `done`                    |
| `actions`    | per surface (`desktop`, `mcp`, `mobile`), how often each event of the registry happened                                       |
| `errors`     | how often each code of the closed list happened                                                                               |

A count is one of 1, 2, 3, 5, 10, 20, 50, 100, 200, 500, rounded down: enough
to compare features, too coarse to recognize a day by its numbers.

```json
{
  "v": 1,
  "id": "5f0c2d5e-8f0b-4b7e-9a3a-2f1d7f7f5b10",
  "day": "2026-11-24",
  "app": "0.7.0",
  "macos": "27.0",
  "memory": "32plus",
  "installed": "7-13",
  "activeDays": 5,
  "onboarding": "done",
  "actions": {
    "desktop": {
      "conversation_opened": 5,
      "speaker_named": 1,
      "transcripts_searched": 2,
      "window_opened": 3
    },
    "mcp": { "transcripts_searched": 3 }
  },
  "errors": { "transcription_deadline": 1 }
}
```

Never in it: audio, text, a title, a search, a tag, a note, a file name; a
name of a person, an app, a site or a device; an account, an e-mail, a serial
number, an identifier of the Mac or the install; the time of anything; a
language, a country, a screen size; an error's message or stack; which zones,
apps, agents, servers or phones there are; how long or how much Sondine
listened.

### What is counted

- `ProcedureMeta.event` names every procedure. One oRPC middleware, in front
  of the whole router, counts a success with the surface its caller was given
  in core: the window and the menu bar (`desktop`, `rpc-host.ts`), agents and
  the discussion inside Sondine (`mcp`, `agent-tools.ts`), a paired phone's
  live reads (`mobile`, `phone-memory.ts`). A call without a surface is
  Sondine's own (the phone's background sync) and is not counted.
- The registry `USAGE_RULES` gives each event one rule, and a test fails when
  a procedure has none:
  - `action`: each success;
  - `read`: the same, but calls less than a minute apart are one (typing a
    search, a list read again after an edit). It looks at the clock, never at
    what was asked;
  - `remote`: a read the window repeats alone (polling); it counts from an
    agent or a phone only;
  - `never`: streams, previews, what the window calls on its own, and what
    would point to a handful of people (a place in the beta).
- Two gestures had no call of their own: `window_opened` (main says the window
  was brought forward) and `conversation_opened` (the window says a finished
  conversation is on screen, without saying which).
- **Active**: a day with an event under `desktop` or `mobile`. Sondine
  listening alone, and an agent reading, are not activity.
- **Activation**: `conversation_opened`. The user came back to something that
  was said. It is a count a day, not a first time: nothing follows a Mac from
  one day to the next.
- **Errors**: at the same middleware, the failures of Sondine's own
  (`api_helper_unavailable`, `api_helper_rejected`, `api_timeout`,
  `api_internal`); each failed attempt of a transcription or a journal pass,
  by its code; model downloads; the update check; and the crashes main sees
  (`helper_crashed`, `core_crashed`, `renderer_crashed`). Outside a call, a failure counts when it happens. A code outside the
  list counts as `…_other`. A crash of main takes the app with it: these are
  the child crashes Sondine saw, not a crash rate.

### Where it goes, and when

- Core decides, in `core/usage/`. A call counts for the calendar day it ends
  on. A day is closed at the first look of a later day, once: a clock set back
  adds nothing to a closed day. The report is frozen there, with its `id`, and
  waits for a random moment of the following day.
- With a yes, one look every 30 to 90 minutes, drawn at random, the first 2 to
  20 minutes after launch. A report past its moment goes at the next look. It
  is tried at most every 6 hours, and dropped 4 days after its day.
- One function sends, and reads the consent and the endpoint right before: one
  POST, no redirect, a generic user agent, 15 s. Anything but `204` is a
  failure; the answer is not read. There is no « send now ».
- The endpoint is compiled in by the release build only
  (`SONDINE_STATS_ENDPOINT`, which `release:mac` requires, under the marker
  `SONDINE_RELEASE` that it alone sets). Development,
  tests, CI, the fake hardware and any other build have none, and core ignores
  one outside a packaged app. Tests hold that no request leaves without an
  answer, after a no, under an older question, or without an endpoint.
- `apps/stats`, a Cloudflare Worker at `stats.sondine.app`: POST only, 16 KB
  at most, the strict schema, a recent day, a rate limit per Cloudflare
  location (never per IP: the Worker does not read it), no log. It builds a
  new request whose only headers are its own, to PostHog's EU capture v1
  (`/i/v1/analytics/events`): one event, `usage_reported`, timestamped at noon
  UTC of `day`, with the report's `id` as event and distinct id, options
  `process_person_profile: false` and `disable_skew_correction: true`, and
  `$geoip_disable: true`. The
  time it gives PostHog is the date alone, which PostHog would otherwise keep
  to the millisecond (`$sent_at`). It answers 204 only when PostHog says it took that
  event. A retry carries the same id, name and timestamp, which PostHog merges
  (later, not at once: queries count distinct ids).
- PostHog's project also discards IPs, has no GeoIP, and is Sondine's alone.
  Its free plan keeps events 12 months.

### The diagnostic

Settings ▸ Advanced ▸ « Envoyer un diagnostic » writes a text from a closed
list: versions, the Mac's processor and memory, permissions, models and their
problem codes, the state of the queue, errors by code over 7 days. No span,
log line, message, path or name. The whole text is on screen, with an optional
note the user writes. « Ouvrir un mail » hands exactly that to the user's mail
app, addressed to the contact; « Copier » copies it. Sondine uploads nothing
and has no server for it: a mail the user sends carries their address, and
stays in their mailbox and ours. The public issue page is linked, never filled
in.

## Limits, said plainly

- **Few users.** A rare combination (an old macOS, little memory, an agent
  used a lot) can point to someone we know, and days that share a rare
  combination can be guessed to be one Mac. No identifier ties reports
  together, and the bands are wide, but correlation stays possible.
- **The connection has an IP.** Cloudflare ends it and sees the IP and the
  time, as any host does, under its own rules. Our Worker neither reads nor
  passes it on, and PostHog sees an address of Cloudflare's.
  Checked 2026-11-25, with Téo's yes, on a temporary copy of the Worker (the
  code of production, in the same zone, with an invented report and token),
  its one request sent to an echo at httpbin.org, hosted at AWS as PostHog is,
  asked for every header. Of the Mac, over IPv4: no address, in any header or
  as the source, no country, language or user agent, nor any header a client
  may add (`X-Forwarded-For`, `X-Real-IP`, `True-Client-IP`, a cookie…); the
  addresses that arrive are Cloudflare's. Cloudflare adds `Cf-Worker:
  sondine.app`, and a `Cf-Ray` that ends with the code of the Cloudflare site
  the Mac reached (`CDG`, Paris): a city nearby, in transit. The control event
  PostHog stored has none of it. Limits: a copy, not the Worker itself; IPv6
  was not tried (that Mac has none). This check was due before the first
  release that has the endpoint, and was made a few hours after it (0.7.0).
- **The moment a report arrives** is known to Cloudflare and PostHog. It is
  drawn at random, but a Mac that slept sends after it wakes.
- **It is not retention in the usual sense.** It is the recent activity of the
  Macs that still report: an uninstalled Mac is absent, not inactive. Two Macs
  of one person are two; a day Sondine did not run has no report.
- **Those who say yes are not everyone**, and the endpoint is public and the
  code open: anyone can send false reports.
- **No way back** for a report already received: we cannot find which are
  yours. They go after 12 months.
- A process running as the user can read the counts on this Mac, as it can
  read Sondine's data.

## Consequences

- The always-on path: nothing without a yes. With one, one timer (about one
  wakeup an hour, next to 0.5 a second for `core` today), and one small write a
  minute at most while the user acts.
  Audio, VAD and the helper are untouched.
- The Worker refuses names it does not know: it is deployed before a release
  that adds one, and a name once released stays in the list.
- PostHog's free plan has one project per organization, and Téo's first is
  another product's: Sondine has an organization of its own, in the EU. The development Worker
  has no token and forwards nothing.

## Rejected

- On by default with an opt-out, or a stable anonymous device id (handbook):
  Sondine hears private conversations.
- `posthog-node` in the app: it would reach PostHog from the user's IP, with
  the hour of each event, and is a dependency that phones home.
- A limit per IP in the Worker, or a hash of the IP or of the Mac.
- Exact days since install: a number that grows by one a day is an identifier.
- `active` as a field: `actions` already says it.
