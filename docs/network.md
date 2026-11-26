# What leaves, to whom, and what they keep

The list every public text rests on (README, SECURITY, `docs/cloud`, the site's
privacy policy). Read from the code on 2026-11-25; a change that adds, removes
or widens a network use changes this page in the same commit, and the site's policy
(its own repository, ADR 043) before it is released.

## The Mac app

Nothing below happens before the user turns it on or asks for it. The window
of the packaged app has no network (a strict CSP); requests come from `core`,
or from a program named here. A development build also talks to its own
development server and, where Graphical's editor is installed (ADR 033), to
Graphical's site.

| What                                | When                                                                                                                                                                        | To whom                                                                                                                                | What goes                                                                                                                                                                                                                                                                                                                                                                 | What they keep                                                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Model download                      | A click on a model                                                                                                                                                          | Hugging Face (`huggingface.co` and its storage, `*.hf.co`), from third parties' conversions (`packages/engines/src/models/catalog.ts`) | An ordinary download: IP address, file asked for. Pinned URL and SHA-256                                                                                                                                                                                                                                                                                                  | Hugging Face's own logs                                                                                                |
| Update check                        | At most every other day once « Mettre Sondine à jour automatiquement » is on (or the earlier check was, until its owner answers), or a click; six hours after no connection | GitHub (`github.com`, and its storage: `release-assets.githubusercontent.com`, `objects.githubusercontent.com`)                        | One GET of the newest release's `sondine-mac.json`, redirected by GitHub: user agent `Sondine`, IP address, fetch's fixed headers (`Accept-Language: *`). Not the version installed                                                                                                                                                                                       | GitHub's own logs                                                                                                      |
| Update download (ADR 045)           | Once that same setting is on and a newer version exists, where Sondine can replace itself; not over a metered network or in Low Data Mode, not during a call                | The same hosts                                                                                                                         | One GET of the release's archive, resumed where it stopped; one that fails is asked for again an hour later, or at the next launch: the same headers, the version asked for. Pinned size and SHA-256; signature, team and notarization checked before it is installed                                                                                                     | GitHub's own logs                                                                                                      |
| iPhone sync                         | Once turned on: while pairing, while a phone is paired, and while one just revoked may still have to learn it                                                               | The paired phones, through `sondine-lan`                                                                                               | « Sondine » and four random characters by Bonjour on the local network; then, over pinned TLS 1.3, recordings in, and out what the phone asks to read (results, search, journal, tags, playback)                                                                                                                                                                          | The phone: results of its own recordings from the last 30 days                                                         |
| The same, through Tailscale         | Once « Autoriser par Tailscale » is on                                                                                                                                      | The same phones; Tailscale carries it                                                                                                  | The same, encrypted twice                                                                                                                                                                                                                                                                                                                                                 | Tailscale knows the two devices talk                                                                                   |
| Discussion with an agent (ADR 027)  | Once turned on, for each message                                                                                                                                            | Anthropic, by the user's own `claude` CLI and account                                                                                  | What the user writes, and what the agent reads in Sondine: transcripts, names of voices, journal, added context, files and images included; never audio                                                                                                                                                                                                                   | Set by the user's plan and settings with Anthropic; Sondine has no say in it                                           |
| Journal with Claude (ADR 028)       | Once chosen (« relu » or « écrit » by Claude)                                                                                                                               | Anthropic, the same way                                                                                                                | « Relu »: the sentences around each commitment. « Écrit »: the transcribed conversations                                                                                                                                                                                                                                                                                  | The same                                                                                                               |
| Agents over MCP (ADR 011)           | Once agent access is on and an app has a key                                                                                                                                | The connected app, on this Mac, by a local socket                                                                                      | Transcripts, names of voices, journal, tags, added context; never audio                                                                                                                                                                                                                                                                                                   | Whatever the app does: it usually forwards to its provider (Anthropic, OpenAI, xAI…)                                   |
| Transcription on the user's machine | Once its link is pasted and confirmed                                                                                                                                       | That machine (`sondine-compute`)                                                                                                       | Below                                                                                                                                                                                                                                                                                                                                                                     | Below                                                                                                                  |
| Transcription on the beta           | Once « Utiliser le cloud » is clicked in the dialog                                                                                                                         | `cloud.sondine.app`: Cloudflare, then a server of Synapsr's                                                                            | Below                                                                                                                                                                                                                                                                                                                                                                     | Below                                                                                                                  |
| Anonymous statistics (ADR 042)      | One report a day, once the user said yes; only from a release                                                                                                               | `stats.sondine.app`: Cloudflare, whose Worker of ours stores and logs nothing, then PostHog Cloud EU                                   | The counts of `docs/analytics.md` for one past day, with the versions, bands of memory and of age, and a random identifier made for that report alone. No content, name, hour or identifier of the Mac. The Worker does not read the IP address and sends PostHog a request of its own, in which Cloudflare names the site of its network the Mac reached (a city nearby) | Cloudflare sees the IP address and the time of the connection, under its own rules. PostHog keeps the report 12 months |
| Diagnostic (ADR 042)                | A click, after reading the whole text; also after a no                                                                                                                      | The contact address, from the user's own mail app (or where they paste it)                                                             | Versions, the Mac's processor and memory, permissions, models, the queue's state, errors by code, and the note the user writes; their e-mail address, as any mail                                                                                                                                                                                                         | Their mailbox and ours (below)                                                                                         |
| Links                               | A click (a licence, a release, `sondine.app/cloud`, a page heard in a browser)                                                                                              | The site, in the user's browser                                                                                                        | What any browser sends                                                                                                                                                                                                                                                                                                                                                    | The site's own                                                                                                         |
| Export, share                       | A click                                                                                                                                                                     | Where the user saves or shares it                                                                                                      | The text or the audio chosen                                                                                                                                                                                                                                                                                                                                              | —                                                                                                                      |

Not a network use: the browser extension (its only connection is the native
port to Sondine on the same Mac), capture, live text, dictations, voice
recognition, search. The audio helper and the model processes have no network
entitlement (ADR 010). macOS makes its own requests (signature checks, DNS).

The app asks for no account. iPhone sync makes a random identifier for the Mac
and a credential per phone, known to the paired phones only; a compute server
has a token per Mac.

## Transcription on a server (ADR 040)

- **What goes:** the audio of finished conversations, as raw 16 kHz PCM: the
  speech, up to 1.5 s before and 0.8 s after it, and the short silences
  between (other people's voices and the names they say included). With it,
  the model's SHA-256, the engine's version, the audio's length, an optional
  language, the time of the Mac's clock, and the place's token. iPhone
  recordings too, once on the Mac.
- **What does not:** text, voice profiles, names given to voices, the
  database, added context, the journal, dictations, traces, deleted passages,
  and any episode of a private zone that keeps no text, even on « Transcrire
  maintenant ». Zones do not cover imported files and iPhone recordings. Next to such a zone, no margin around the speech goes.
- **How:** Noise NK to the program's key, whatever carries it; plain HTTP to a
  machine of the user's, HTTPS to the beta.
- **Stopping:** deleting an episode, moving it under such a zone or choosing
  « Ce Mac » stops the upload within about a second. What already left cannot
  be called back: the server drops it when the Mac says so, or ten minutes
  after it last heard from the Mac or finished transcribing.
- **What the program keeps** (`apps/compute/src/clients.ts`, `sessions.ts`):
  - _In memory:_ the audio until transcribed, the text until the Mac has it
    (ten minutes at most), everything at most six hours. The program
    overwrites its audio buffers; the text, and what the engine's process and
    the graphics card free, is released without being erased byte by byte.
  - _On disk, per Mac or place:_ a hash of its token, whether it is a machine
    the owner added (with the name they gave), a place in the open beta, or an
    invited plan (`trial`, `founder`, `pro`) with its included and top-up
    seconds, when it was made, when it was last charged for a transcription,
    and the seconds transcribed (monthly and cumulative). The Mac asks for its
    erasure when the user gives the place back, once, without trying again.
    Otherwise it stays until the operator removes it or, in a full open beta,
    a newcomer takes a self-claimed beta place idle for 14 days.
  - _In its log:_ the time and one word (`beta-claimed`, `transcribed`,
    `failed` with an error code, `expired`), with no Mac, no duration, no
    address. The machine's journal keeps it as long as it is set to.
  - _For the beta:_ a salted hash of the address that claims places, in
    memory, to allow three a day.
- **Not zero data retention towards its administrators.** Someone with root,
  Docker or `sudo` on the machine, people or agents, can read the audio and
  the text while it works on them, and could change the program. Nothing
  proves to the Mac what the beta runs. Synapsr gives its word not to read or
  listen, and to train nothing on it.
- **Cloudflare**, for the beta: terminates HTTPS; sees the IP address, the
  times and the sizes, and forwards the address to the server; cannot read
  the sealed messages inside.

## The iPhone app

Talks only to the paired Mac (pinned TLS 1.3; Bonjour on the local network,
the Mac's Tailscale address if the Mac allows it). It sends recordings, their
names, tags, notes and deletions, the pairing request with the phone's name,
and searches; it reads the Mac's memory. Nothing of it goes to Synapsr. The
share sheet sends a recording wherever the user chooses. TestFlight: Apple
gives the developer a beta build's sessions and crashes, and the feedback the
tester sends; Sondine adds nothing to it. The app has no third-party code.

## sondine.app

| What                           | To whom                                                                                              | What goes                                                                   | What they keep                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Any page                       | Cloudflare (hosting and DNS)                                                                         | What any browser sends                                                      | Cloudflare's own logs                                                             |
| Any page                       | Umami, the maintainer's installation at `analytics.teogoulois.com`, only on `sondine.app` and `www.` | Page, referrer, language, screen size, browser, country; clicks named below | Those, with a visitor hash derived from the IP address and the browser; no cookie |
| `/cloud` (apps/cloud-waitlist) | Cloudflare, whose Worker stores nothing, then Discord, a private channel of the team's               | The e-mail typed and the page's language                                    | Discord keeps the message until someone deletes it                                |
| Mail to the contact address    | Cloudflare Email Routing, then the maintainer's mailbox (Gmail), from which answers are sent         | The message, and the answer                                                 | The mailbox, until deleted                                                        |
| Download, source               | GitHub                                                                                               | What any browser sends                                                      | GitHub's own logs                                                                 |

The site online before ADR 043's (March 2026) also posts its waitlist form to
a Google Sheet and its contact form to Discord, and reads its blog from Marble
on the server. The new one has none of the three.
