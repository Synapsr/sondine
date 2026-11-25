# Using Sondine Cloud (beta)

_What is built ([ADR 040](../../decisions/040-remote-compute.md), 2026-11-25). [docs/network.md](../../network.md) has the full list of what leaves and who keeps what._

Sondine Cloud does the **final transcription** for a Mac that cannot run Nemotron 3.5 Transcribe 30B. It is off until you turn it on, free during the beta, and needs no account. It is one ordinary server of Synapsr's with a few places: **five for now**, ten planned. It was measured from a 32 GB Mac; it has not been tried on a smaller Mac yet.

> **The beta is not zero data retention towards the people who run it.** Your audio is sealed until it reaches the program, which keeps it in memory only and drops it once your Mac has the text. But whoever administers the server, a person or a program with those rights, can technically read the audio and the text while it works on them, and nothing proves to your Mac what the server runs. We give our word not to read or listen, and that your data trains no model. If that is not enough, use [your own machine](using-your-own-server.md) or stay on your Mac.

## What leaves your Mac

The audio of finished conversations: the speech, up to 1.5 s before and 0.8 s after it, and the short silences between. It holds the voices of the people you talk with and the names they say. iPhone recordings and imported files go too: the Mac's private zones do not cover them.

## What does not go to the server

- Any text, your daily journal (which goes to Anthropic if you chose Claude to write or check it), your dictations, and live text.
- Voice profiles, the names you gave voices, your people, your database, notes and files.
- Anything you deleted before it was sent.
- Recordings in a private zone that keeps no text ("Nothing", "Audio only"), even with "Transcribe now". A "Text only" zone is transcribed, so it is sent.

## What the others keep

- **The server's program, in memory:** the audio until it is transcribed, the text until your Mac has it, ten minutes at most.
- **The server's program, on disk, for your place:** a hash of its token, when it was made, when it was last charged for a transcription, and the seconds transcribed in the last month it was used. Giving your place back asks the server to erase it; if that fails, or otherwise, it stays until the operator removes it or, when the beta is full, a newcomer takes a place idle for 14 days.
- **The server's log:** the time and the kind of each event. No content, no duration, no place, no address.
- **Cloudflare**, which carries the connection: your IP address, the times and the sizes, never the content. It passes the address to the server, which keeps a salted hash of it in memory to limit how many places one address takes.

## Turning it on and off

1. **Settings ▸ Transcription ▸ Cloud (beta)**, or the same choice in the first run of a Mac under 32 GB.
2. Read what leaves, then **Use the cloud**. Sondine takes a place for you; if none is left, it says so.

**This Mac** stops what is leaving and keeps your place. **Give my beta place back** erases the place on your Mac and asks the server, once, to erase it: do it while online.

## Day to day

- **Offline, or the server busy:** conversations wait on the Mac and Sondine tries again less and less often (30 seconds to 15 minutes). "Transcribe now" tries at once. Retention keeps running: "Keep audio" protects a conversation.
- **Limits:** one request at a time for everyone, each in turn, and 40 hours of audio a month per place.
- **Network:** about 115 MB per hour of audio, on any connection, metered ones included.
- **Deletion:** what is leaving stops within about a second. What already left cannot be called back; the server drops it when your Mac says so, or ten minutes after it last heard from your Mac or finished transcribing.
- **Dictations** go on on your Mac meanwhile, and the journal goes on where you chose.

## Later

A confidential cloud, where the hardware would prove to your Mac what the server runs, is **designed, not built** ([threat model](../threat-model.md)). Public opening waits for it. Nothing in that design describes the beta.
