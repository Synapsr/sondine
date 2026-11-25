# 027 — Talking with an agent in Sondine

Status: Accepted — 2026-11-09

## Context

Téo (2026-11-09): « pouvoir discuter directement dans l'app avec un agent et
pouvoir sélectionner le modèle en fonction de notre subscription », taking
T3 Code's way of driving the providers he already pays for. Until now an
agent read Sondine only from outside, through MCP (ADR 011): Claude Code or
Codex, started by Téo in a terminal.

A discussion inside Sondine sends what the agent reads (transcripts, names,
context added to conversations) to the provider's cloud. That is Téo's
explicit choice, and it amends ADR 002: the rest of Sondine stays local.

What T3 Code does (studied 2026-11-09 at `pingdotgg/t3code` `ad9e871`, MIT;
no code copied):

- It finds `claude` and `codex` on the PATH of the user's login shell and
  keeps the user's own sign-in: no API key when a subscription is signed in.
- Claude runs through `@anthropic-ai/claude-agent-sdk` with the user's
  installed CLI: one CLI process per thread, prompts pushed into an open
  stream. Sign-in and models come from the CLI's `initialize` answer
  (`account`, `models` with their effort levels), without reaching a model.
- Codex runs as `codex app-server` (JSON lines over stdio): `initialize`,
  `account/read`, `model/list`, `thread/start`, `turn/start`,
  `turn/interrupt`; answers stream as `item/*` notifications.
- Both are coding agents there: shells, file edits and the user's own MCP
  servers stay on.

Measured on Téo's Mac (Claude Code 2.1.319 to 2.1.321, Codex CLI 0.144.4):

- `claude -p` in stream-json with `--tools ""`, `--strict-mcp-config`,
  `--setting-sources ""`, `--system-prompt`, `--disable-slash-commands`,
  `--no-session-persistence`, `--permission-mode dontAsk` and
  `--permission-prompts none` reports exactly the tools of its
  `--mcp-config`, and no memory, CLAUDE.md, skill or slash command; the
  model is never offered another tool. Its `initialize` answers in about
  150 ms with the account and the models. It hands its own environment to
  the MCP servers it starts, and exits when its input closes.
- `codex app-server` keeps tools Sondine cannot turn off, whatever the
  thread's overrides: with every feature it lists turned off and every MCP
  server of the user's configuration disabled by name, a thread still had
  `view_image` (reads any image on disk), sub-agents, `apply_patch`, and the
  tools of MCP servers that come from elsewhere than `config.toml` (Téo's
  browser `yab-browser`, `tippo`), all reachable from its JavaScript `exec`
  tool. Its tool set changes with each weekly release.
- Ephemeral `codex app-server` threads wrote no session file, and neither
  did the Claude flags above (no new file in `~/.codex/sessions`,
  `~/.codex/history.jsonl` or the projects folder of `CLAUDE_CONFIG_DIR`).
- Téo's interactive shell takes 21 s to start (`.zshrc`); a login shell
  (`zsh -lc`) takes about 4 s and already exports `CLAUDE_CONFIG_DIR`
  (a custom folder, where his sign-in is; `~/.claude` holds an expired one).
- The Claude Agent SDK is not open source (its license points to
  Anthropic's commercial terms): bundling it would put a proprietary library
  inside Sondine's AGPL build.

A design review by Codex `gpt-6-astra` (2026-11-09) found that a tripwire watching
events can only detect, not prevent; that the first draft wrote the relay's
key to a file; that discussions bypassed the agents' session cap; that a
relay could start before the socket listened; and that Anthropic's terms on
using a subscription from another product need Téo's reading. Each is
answered below.

## Decision

### Off by default, and what leaves

- **Off by default.** Settings ▸ « Discussion avec un agent » turns it on,
  after a dialog that says what leaves the Mac: what Téo writes and what the
  agent reads to answer (transcripts, names of voices, context added to
  conversations, files and images included) goes to Anthropic with his
  Claude subscription; the agent only reads; what was sent cannot be called
  back, even by deleting the conversation later; nothing is sent without a
  message from him. Turning it off ends every discussion at once.
- **Nothing leaves without Téo.** While the switch is on, the CLI runs only
  for a discussion he writes in (and ends after 10 minutes without a
  message), and briefly to say who is signed in and which models exist.
  A model is reached only for a message he sent.
- **Read-only, through the agent tools only.** The agent reads Sondine with
  the tools of `AGENT_TOOLS` (ADR 011), through the same MCP edge as outside
  agents: the same procedures, the same deletion filter, an answer withheld
  when anything was deleted while it was read. It writes nothing, plays no
  audio, exports nothing.
- **No other tool, no other destination.** The provider's built-in tools
  (shell, files, web, images, memory, plugins, sub-agents) and the user's
  own MCP servers are off, enforced by the CLI's flags; the session starts in
  an empty private folder and the provider writes no session to disk.
  Sondine itself opens no connection: the CLI Téo signed in to does. A
  transcript that tries to steer the agent can only make it read more of
  Sondine, and only to the provider Téo agreed to.

### Providers

- Contract in `packages/engines` (`src/assistants/contract.ts`, ADR 005):
  `AssistantProvider` with `detect` (installed, version, the folder holding
  its sign-in, which account and plan, models with their effort levels) and
  `open` (a session: `send`, `interrupt`, `close`, normalized events: text
  deltas, tool call started and ended, turn ended or failed, session failed,
  with errors classified as `signed-out`, `usage-limit`, `context-full`,
  `unavailable`, `crashed`, `refused-tool`, `protocol`). Product code knows
  no provider.
- **Claude**: the user's `claude` CLI, driven over its headless interface
  (`-p --input-format stream-json --output-format stream-json
  --include-partial-messages`) with the flags measured above,
  `--allowedTools` set to Sondine's tools, `--settings
  {"disableAllHooks":true}`, and Sondine's system prompt. No SDK is bundled.
  Sign-in and models come from the `initialize` control request, as the
  official SDKs and T3 Code do; `interrupt` stops a turn, and a CLI that
  has not stopped 5 s later is ended. These two control messages are what
  the SDKs send, not a documented CLI contract: a CLI that refuses them, or
  is older than 2.1.319, shows as "unsupported". The `default` model is an
  alias: Sondine lists the named model it resolves to.
- **Codex is not offered yet.** Its built-in tools cannot all be turned off
  (above). A Sondine-only Codex folder (`CODEX_HOME`) with its own ChatGPT
  sign-in would remove Téo's MCP servers and plugins but still leave
  `view_image`; Téo chose to wait for a Codex option that removes built-in
  tools. The adapter written and measured on 2026-11-09 is kept on the
  branch `t3/agent-chat-codex`.
- **Tripwire.** Whatever the flags, a session stops at the first sign of a
  tool that is not Sondine's: an `init` listing another tool or MCP server,
  or none at all, a `tool_use` naming another tool, a content block of a
  kind Sondine does not know. It detects; it cannot promise to stop a tool
  already running. For Claude the flags enforce, the tripwire backs them up.
- **Environment.** The CLI gets an allowlisted environment: `HOME`, `USER`,
  `LOGNAME`, `TMPDIR`, `LANG`, `SHELL` from Sondine, and `PATH`, `LANG`,
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME` from the login shell (`$SHELL -lc`,
  10 s; `-ilc`, 30 s, only when a CLI is not found), found once and
  remembered until « Vérifier à nouveau ». Never `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `NODE_OPTIONS` or `ELECTRON_RUN_AS_NODE`, so a
  subscription is used rather than a key. It also gets
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`,
  `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`,
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `ENABLE_CLAUDEAI_MCP_SERVERS=false` and
  the IDE auto-connect switches off. Settings shows the account, the plan,
  the version and the folder the sign-in was read from; a CLI signed in
  with an API key is labelled « facturé à l'usage ».
- The CLI and its relay run in their own process group, ended as a group;
  each session's working folder is an empty 0700 folder under the user's
  temporary folder (outside the app group container, where macOS would ask
  Téo about another app's data), emptied at every start of core.
- Other providers T3 Code supports (OpenCode, Cursor, generic ACP agents)
  come later, and only those whose built-in tools can be turned off.

### Tools reach Sondine through the MCP edge

- Each session gets a key of its own (`sdc_` and 32 random bytes), held in
  core's memory only and revoked with the session. The CLI receives it in
  its environment and hands it to `sondine-mcp` (the ADR 011 relay): never
  on a command line or in a file.
- Core listens on `run/mcp.sock` while agent access is on **or** a
  discussion holds a key, and a session starts its CLI only once the socket
  listens. The agent host tells the two kinds apart by the key: an `sdn_`
  key needs agent access on (as before), an `sdc_` key needs the discussion
  switch on and its session alive. One MCP session per discussion key; at
  most 4 discussions keep a CLI at once (the least recently used idle one
  ends for a new one), apart from outside agents' sessions (no cap since
  2026-11-12, ADR 011). Every call is
  checked when it arrives and when its answer leaves, exactly as for
  outside agents.
- A discussion's calls are not in Settings ▸ Agents' log: the discussion
  shows each one where it happened (« A cherché « devis » · 2
  conversations », « A lu une conversation » with a link to open it).

### Discussions

- A discussion is the provider, model and effort of its last message, Téo's
  messages, the agent's answers and what each answer read. Changing the
  model starts a new CLI session, told what was said before. Answers cite
  conversations as links (`sondine://episode/<id>?t=<ms>`) that open the
  conversation at that time; the window renders a small Markdown subset as
  React elements, never HTML, and shows any other address as text.
- Discussions are kept across launches (Téo, 2026-11-10), in the database:
  `chat_discussions`, `chat_messages` (an answer's reads as JSON), and
  `chat_reads`, what each agent read: every episode its answers carried, at
  its input generation, every person and item of context. The edge finds
  them in each answer by shape (an episode summary, any `episodeId`, a
  person, an item of context beside a context kind), wide rather than
  narrow, including what an answer refused for its size still said. When
  anything is deleted (the `Status.deletions` count moves), the discussions
  with a read whose row is gone, or whose episode's input generation moved
  since the first read (a passage deleted, the episode regrouped; a later
  read does not make it fresh again), are erased with their messages
  (secure delete), their CLI ended and the window's copies dropped; the
  list says how many. A person deleted or merged into another also erases
  the discussions that read any of that person's episodes, since a journal
  names voices without ids. Core checks again at every start, for a
  deletion it stopped before following. A discussion that read an episode
  still open may go at the next deletion, since grouping moves its
  generation: erring that way keeps no deleted word. Discussion ids are
  never reused. Each discussion can be deleted by hand; turning the switch
  off ends every session and keeps them.
- An answer that was streaming when core stopped is kept as stopped, with
  what had been stored (the text streamed in memory is lost with core).
- Stop works while a session is still starting (the message then never
  leaves); a session that fails to start releases its key; sessions still
  starting count against the cap; a model change starts the new session
  before ending the old one, and a queued stop of the socket is dropped if
  a key appeared meanwhile.
- Turning the switch off, or quitting, ends every session.

### For the daily journal (ADR 028)

The journal runs a local text engine. Using a subscription instead would be
a provider session with no tool and one prompt, under this decision's switch
and dialog. ADR 028's `TextEngine` asks for output following a JSON schema;
an adapter over `AssistantProvider` would add Claude's structured output
then.

## Consequences

- ADR 002 gains one network use, owned by the user's own CLI, off by
  default. The no-WAN soak runs with the switch off; a packet capture with
  it on is a manual test.
- Sondine depends on a CLI it does not ship. A CLI update can change flags
  or events: detection checks a minimum version, the tripwire stops unknown
  tools and kinds of content, and other unknown events are ignored.
- The relay must exist for a discussion to read Sondine (as for agents);
  without it Settings says so and the box is off.
- Anthropic's Agent SDK overview, as the review read it, asks third-party
  products not to offer claude.ai sign-in or its rate limits without
  approval. Sondine offers no sign-in: it drives Téo's own CLI, signed in by
  him, on his Mac, as T3 Code does. Téo accepts this use for himself
  (below).

## Téo's answers (2026-11-10)

- The agent only reads, for now: no action, even confirmed.
- Discussions are kept across launches, erased with what they read, each
  deletable (above).
- Codex waits until it lets its built-in tools be removed; no Sondine-only
  ChatGPT sign-in.
- Driving his own Claude Code CLI with his subscription from Sondine is a
  use he accepts for himself.

## Rejected

- Bundling `@anthropic-ai/claude-agent-sdk`: proprietary inside an AGPL
  build.
- In-process tools through the SDK's private `mcp_message` control
  messages: a second edge to keep in step with ADR 011's.
- Codex with overrides on the user's `CODEX_HOME`: measured above, it keeps
  other tools and other MCP servers.
- The relay's key in a 0600 file or on the command line: the CLI's
  environment reaches the relay without either.
- A Sondine-side API key field: Téo uses subscriptions; a key would also
  bill differently without saying so.
