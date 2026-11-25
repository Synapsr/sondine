# 011 — Agent access through MCP

Status: Proposed — 2026-11-02

## Context

Téo's handbook makes every app agent-ready. Sondine's data is the most
sensitive on the machine; any process the user runs could connect to an
unauthenticated local endpoint.

## Decision

- MCP is off by default. Enabling it shows what agents will read and that
  they may forward it elsewhere.
- `sondine-mcp` is a small Swift stdio relay to core's socket
  `<data>/run/mcp.sock` (0600 in the 0700 run directory, both checked as
  this user's at listen: only this user can connect, so no peer check is
  added). Core runs the MCP server with the official TypeScript SDK; tools
  call the same oRPC procedures as the app.
- Each agent client gets its own token, created and revocable in Settings,
  scoped to read-only tools in release 1: an explicit list in
  `packages/api/src/agent-tools.ts`, so new MCP metadata never widens access
  by itself. Every call is logged locally and visible; the log keeps which
  tool and which episode, person or day, never the words searched or read.
- Tools read through the same deletion filter as exports: tombstoned
  content is never returned. An answer read before a deletion committed is
  withheld at the socket, right before it would leave.
- Timing: agent access is Téo's top priority after search, so it lands in M2
  with deletion ([ADR 014](014-feature-priorities.md)).
- No TCP port.
- Amended 2026-11-09 by [ADR 027](027-agent-chat.md): Sondine's own
  discussions reach the same edge with a key of their own (`sdc_`), held in
  core's memory and revoked with the discussion's session. Core also
  listens while one exists, even with agent access off; turning agent
  access off then closes the outside agents' sessions only. A discussion's
  calls show in the discussion, not in this log, and have their own cap
  (one session per key, at most 4 discussions with a CLI).
- Amended 2026-11-12 (Téo: « simplement setup le mcp, surtout pour les
  autres app/agents tel que Grok Bot »): Sondine writes its server into the
  config file of the agent apps it knows, takes it back on revoke, and gives
  any other app the server to paste. See "Apps Sondine connects" below.

## Consequences

- Threat model stated honestly: this protects against other users, browsers,
  and sandboxed apps; it does not protect against code already running as
  the user, which can read the data directory. Controls exist for consent,
  visibility, and revocation.

## M2 state (2026-11-07)

- Tools: `search_transcripts`, `get_day_overview`, `list_episodes`,
  `get_episode` (with `fromMs`/`toMs`, at most 30 min: the excerpt),
  `list_people`, `get_person` (pulled forward from M3: names exist since the
  voices slice; its newest 200 episodes by default, `limit` up to 500) and
  `get_status`. Diagnostics and every write stay off. `get_journal` and
  `list_commitments` joined them with the daily journal (ADR 028).
  Results are compact JSON; each wall-clock `…Ms` field gains a `…Local` twin
  in the Mac's time zone, and a result over 100,000 characters is refused
  with how to narrow it.
- Hello: the relay sends `{"v":1,"token":"sdn_…"}` and core answers one line
  (`ok`, or `unknown`, `revoked`, `disabled`, `busy`, `bad-hello`) before the
  socket becomes the MCP stream. 2 calls in flight per session, 1 MiB per
  message, 15 s per call. Outside agents may open any number of sessions
  (Téo, 2026-11-12: « pas de limite »; the cap of 4 refused new sessions
  while several agent threads were open); `busy` now only refuses a second
  session on one discussion key.
- Every `tools/call` is checked when it arrives (the agent still has access)
  and when its answer leaves (still has access, and the content generation
  has not moved: core bumps it in the same turn as a deletion, a forget, a
  person's deletion or renaming, a voice named or unnamed, or recognition
  turned off). A request id still open is refused, so every answer matches
  one request; a cancelled call frees its slot. Revoking closes the agent's
  sessions at once; its relay is refused on reconnect, and turning access
  off also drops connections still saying hello.
- The log records a tool name only if Sondine offers it (`unknown_tool`
  otherwise). Agents and the log stay listed with access off, so a key can
  be revoked without turning access back on.
- Tokens: `sdn_` and 32 random bytes; Sondine stores their sha256 only.
  Settings gives a `claude mcp add` or `codex mcp add` command holding the
  token, which the agent's own configuration then keeps; since 2026-11-12 it
  also writes the token into the known apps' files, or gives the server to
  paste (below).
- The relay runs under App Sandbox with the app group only (bundle id
  `app.sondine.mcp` from its embedded Info.plist), in `Contents/Helpers`.
  Development builds pass `--socket`; packaged ones always use the group
  container.

## Apps Sondine connects (2026-11-12)

Read on Téo's Mac: Grok (the Grok Bot app and the `grok` CLI 1.0.77 share
`~/.grok`) declares servers in `~/.grok/config.toml` as
`[mcp_servers.<name>]` with `command`, `args` and `env`, and also loads
those of `~/.claude.json` and `~/.cursor/mcp.json`; a name spelled the same
in its own file wins (measured with `grok inspect`), and names are
case-sensitive. Claude (the desktop app) keeps `mcpServers` in
`~/Library/Application Support/Claude/claude_desktop_config.json`, Cursor in
`~/.cursor/mcp.json`, both with the same three fields. The app named ChatGPT
there is OpenAI's Codex app (`com.openai.codex`), which reads Codex's own
configuration; Raycast keeps its servers in its own database, filled through
its « Install Server » command.

- **Known apps.** For Grok, Claude and Cursor, when their folder exists,
  Settings ▸ Agents offers « Connecter ». After a dialog that says what the
  agent can read and that what it reads goes to its model's provider (named
  when it is one company: xAI, Anthropic), Sondine creates a key named after
  the app, writes one server holding it (`sondine`, `sondine-dev` for a
  development build) and says what it wrote, where, and where the previous
  file was copied (`<file>.sondine-backup`, same permissions).
- **What it touches.** Only its own server. JSON is parsed and written back
  with every other key; TOML is edited as text, so comments and other lines
  stay, and the result must parse to the same document with only Sondine's
  server changed, or nothing is written (`unsafe`). A server of that name
  that is not Sondine's (no `sdn_` key in its `env`) is left alone
  (`taken`); a file Sondine cannot parse is left alone (`unreadable`). The
  write goes through a temporary file renamed over the real one (a symbolic
  link stays a link), keeping the file's permissions; a new file is 0600.
  Just before the rename Sondine reads the file again: if the app saved it
  meanwhile, Sondine starts over from the app's version (three tries). The
  temporary file and the copy are new files renamed into place, never
  written through an existing path. Comments right above the next table
  stay when Sondine's table goes.
- **Shared files.** Grok also loads `~/.cursor/mcp.json`: connecting Cursor
  while Grok is here gives Grok that key too, and the dialog says so. (Grok
  also loads `~/.claude.json`, where `claude mcp add --scope user` writes
  unless `CLAUDE_CONFIG_DIR` moves it; the Claude Code command predates this
  and does not say it.)
- **One key per app.** An app whose file holds a key with access is listed
  as connected, not offered again; connecting again replaces Sondine's
  server and revokes the key it held, since that file was its only copy.
- **Revoking** takes back every Sondine server holding that key from the
  known apps' files, found by hashing the key each server holds: no record of
  what was written is kept, the files are the record. If a file cannot be
  edited, the key is revoked anyway and Settings says to remove the server
  by hand. Removing a server Sondine wrote is not deleting the user's data.
- **No second Sondine.** When a file Grok also reads already declares a
  server named `sondine` in any case (Téo's `~/.claude.json` has `Sondine`,
  through his context tool), Sondine writes Grok's server under that exact
  spelling so Grok uses its own key; the dialog says so. Revoking Grok's key
  lets Grok fall back to that other server: it is not Sondine's to remove.
- **Claude Code and Codex** keep their commands (their CLIs own their
  configuration). **Any other app** gets the server to paste, as an
  `mcpServers` JSON object or a TOML `[mcp_servers.…]` table, with the relay
  and its key filled in, under the name the user gives the key.
- A key in an app's file is readable by whoever can read that file; it is
  useless without this user's access to the socket (above), and the relay
  only reaches the app group container.
