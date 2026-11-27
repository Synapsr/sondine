# Using Sondine Cloud

_What is built ([ADR 040](../../decisions/040-remote-compute.md), 2026-11-25; [ADR 047](../../decisions/047-cloud-billing.md), 2026-11-27). [docs/network.md](../../network.md) has the full list of what leaves and who keeps what._

Sondine Cloud does the **final transcription** for a Mac that cannot run Nemotron 3.5 Transcribe 30B. It is off until you turn it on, and needs no account. It opens in waves: the first has ten places, and the app shows the share already taken. Each place starts with **60 free minutes**, no card; then the Founder plan costs 19 € a month, VAT included, for 40 hours, and 10 more hours cost 10 €. It is an ordinary server of Synapsr's that also runs other services. It was measured from a 32 GB Mac; it has not been tried on a smaller Mac yet.

> **It is not zero data retention towards the people who run the server.** Your audio is sealed until it reaches the program, which keeps it in memory only and drops it once your Mac has the text. But anyone or any program that administers the server can technically read the audio and the text during the computation, and nothing proves to your Mac what the server runs. Software agents of Synapsr have administrator access to this server. We give our word not to read or listen to your data, and it trains no model. If that is not enough, use [your own machine](using-your-own-server.md) or stay on your Mac.

## What leaves your Mac

The audio of finished conversations: the speech, up to 1.5 s before and 0.8 s after it, and the short silences between. It holds the voices of the people you talk with and the names they say. iPhone recordings and imported files go too: the Mac's private zones do not cover them.

## What does not go to the server

- Any text, your daily journal (which goes to Anthropic if you chose Claude to write or check it), your dictations, and live text.
- Voice profiles, the names you gave voices, your people, your database, notes and files.
- Anything you deleted before it was sent.
- Recordings in a private zone that keeps no text ("Nothing", "Audio only"), even with "Transcribe now". A "Text only" zone is transcribed, so it is sent.

## What the others keep

- **The server's program, in memory:** the audio until it is transcribed, the text until your Mac has it, ten minutes at most.
- **The server's program, on disk, for your place:** a hash of its token, when it was made, when it was last charged for a transcription, the seconds transcribed in the period (the total for the trial). If you subscribe: a random reference of the place at Stripe and your Stripe customer and subscription identifiers, with which Synapsr can find in Stripe who paid. A trial never used and given back is erased; otherwise the place stays until the operator removes it, at your request.
- **The server's log:** the time and the kind of each event. No content, no duration, no place, no address.
- **Cloudflare**, which carries the connection: your IP address, the times and the sizes, never the content. It passes the address to the server, which keeps a salted hash of it in memory to limit trials per address.
- **Stripe**, if you pay, in your browser: your e-mail, billing address, card and, if you give it, your VAT number. Sondine never talks to Stripe.

## Turning it on and off

1. **Settings ▸ Transcription ▸ Sondine Cloud**, or the same choice in the first run of a Mac under 32 GB. The screen shows the share of places taken: for that, the app asks the server, and sends nothing else.
2. Read what leaves, then **Try 60 minutes free**. Sondine takes a place for you; if none is left, it says so and offers to tell you of the next wave.
3. In **Settings ▸ Transcription**, the Cloud's card shows your minutes or hours. **Subscribe**, **Add 10 h** and **Manage subscription** (card, invoices, cancellation) open Stripe's page in your browser; Sondine updates by itself once you have paid.

**This Mac** stops what is leaving and keeps your place. A subscription is cancelled in Stripe's portal, at the end of its period; your top-up hours stay usable after. A place is one person: a second Mac restored from your backup shares the same hours.

## Day to day

- **Offline, or the server busy:** conversations wait on the Mac and Sondine tries again less and less often (30 seconds to 15 minutes). "Transcribe now" tries at once. Retention keeps running: "Keep audio" protects a conversation.
- **Limits:** one request at a time for everyone, each in turn; 60 minutes for the trial, then 40 hours per paid period, plus your top-ups. Once they are used, conversations wait on the Mac and go as soon as hours come back.
- **Network:** about 115 MB per hour of audio, on any connection, metered ones included.
- **Deletion:** what is leaving stops within about a second. What already left cannot be called back; the server drops it when your Mac says so, or ten minutes after it last heard from your Mac or finished transcribing.
- **Dictations** go on on your Mac meanwhile, and the journal goes on where you chose.

## Later

A confidential cloud, where the hardware would prove to your Mac what the server runs, is **designed, not built** ([threat model](../threat-model.md)). Public opening waits for it. Nothing in that design describes the beta.
