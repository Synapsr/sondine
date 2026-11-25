# 002 — Local only, no telemetry without a yes

Status: Proposed — 2026-11-02

## Context

Sondine records private conversations of the user and of people around them.
Téo's top constraint is "local only". Voice profiles are biometric data.

## Decision

- No cloud service, account, relay, push service, or telemetry.
- Network use is limited to: model downloads the user starts (pinned URL and
  sha256), update checks the user starts or opts into (GitHub Releases,
  signature verified), and LAN traffic with phones the user paired
  (release 2). Nothing else.
- Native children run under a kernel sandbox that denies outbound network,
  and a test proves it (ADR 010). Main and core enforce the rule by policy and
  review; a no-WAN soak (packet capture) verifies the whole app.
- FluidAudio runs in offline mode with files from Sondine's model manager.
  Vendor telemetry stays disabled. Apple's Private Cloud Compute model is
  forbidden.
- Local agents reach Sondine only through the MCP relay, off until the user
  enables it (ADR 011). Enabling it warns that agents may forward what they
  read elsewhere.
- Amended 2026-11-09 by [ADR 027](027-agent-chat.md), at Téo's request: a
  discussion with an agent inside Sondine sends what Téo writes, and what
  the agent reads through Sondine's read-only agent tools, to the provider
  of his subscription (Anthropic). It is off by default and turned on in
  Settings after a dialog that says what leaves; nothing is sent without a
  message from Téo; the traffic is the user's own CLI's (Claude Code,
  signed in by him), never Sondine's; the CLI gets no other tool, writes no
  session to disk and reports no telemetry. Everything else stays local.
- Amended 2026-11-10 by [ADR 008](008-mobile-lan-sync.md), on Téo's answer
  (« pk pas »): a paired phone may also reach the Mac through Tailscale,
  off by default (« Autoriser par Tailscale »), under the same pairing,
  pinned TLS and credential. Sondine never calls Tailscale's service; its
  packets, encrypted twice, may then pass through Tailscale's relays, and
  Tailscale's coordination server knows the two devices talk. The iPhone
  app is installed through TestFlight (ADR 031): iOS reports a beta
  build's sessions and crashes to its developer, Sondine sends nothing.
- Amended 2026-11-24 by [ADR 040](040-remote-compute.md), at Téo's request: the
  final transcription may run on a compute server, a machine of the user's or
  a beta of Synapsr's with a few places. It is off by default, chosen in
  Settings after a dialog that says what leaves and who could read it; the
  audio of finished episodes goes sealed for that server's key, never an
  episode of a private zone that keeps no text. Nothing reaches a server
  before that choice, and no agent or phone can make it.
- Amended 2026-11-25 by [ADR 042](042-usage-statistics.md), at Téo's request:
  with the user's yes to one question, Sondine sends one anonymous report a
  day, made of counts, with no identifier, hour, content or name. Without it
  nothing is counted or kept. A diagnostic leaves only as a mail the user
  reads and sends from their own app.
- Amended 2026-11-25 by [ADR 045](045-automatic-updates.md), at Téo's request:
  with the user's yes to one question, Sondine asks GitHub at most every other
  day, downloads a newer version, checks it (team, identifier, notarization,
  version) and installs it when nothing is cut. Without it, Sondine asks only
  on a click and downloads nothing. From 2026-11-08 to 0.7.0 the check was one
  GET of GitHub's API, once a day once opted into, and Sondine downloaded
  nothing.
- Data lives in the app group container (ADR 013), excluded from cloud
  backup, with explicit local export and deletion.
- Recording stays visible (tray state), pausable in one click, and any range
  can be deleted (M2). Per-app exclusion and a one-gesture "forget the last
  N minutes" come later (ADR 014).

## Consequences

- Product decisions rely on local spans and benchmarks, and since ADR 042 on
  the counts of those who agreed to share them.
- Gated weights and licenses that forbid redistribution are downloaded by the
  user's explicit action, never bundled.
