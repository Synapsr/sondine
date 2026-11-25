import type { PHONE_ALL_ROUTES, PhoneMemoryRoute } from "@sondine/protocol";
import type { AgentToolName } from "./agent-tools";

/**
 * What a paired phone may call on core's phone socket (ADR 008), as
 * `AGENT_TOOLS` is for agents: core routes these names and nothing else, so
 * a new procedure never reaches a phone by itself. Each is
 * `POST /v1/<path>` with the bodies of `PHONE_ROUTES` (`packages/protocol`);
 * the upload, `PUT /v1/recordings/<id>/audio`, carries bytes, not JSON.
 *
 * - `pair`: the QR's token, without a credential; answered after the
 *   user's « Appairer ».
 * - `hello`: the start of a sync (clocks, the Mac's addresses and limits).
 * - `announce`: a recording to send, by id, length and SHA-256.
 * - `states`: where the phone's recordings stand on the Mac.
 * - `delete`: a deletion from the phone's outbox; the Mac's own deletion.
 * - `get`: a recording's result when its revision moved (M5.3), read as
 *   `episodes.get` and `journal.day` read it, withheld when a deletion
 *   lands meanwhile.
 * - `rename`: a name typed on the phone, from its outbox (M5.3).
 * - `note`: a note from its outbox, added as `context.add` adds one (M5.3).
 * - `tag`: a tag put on or taken off from its outbox, as `tags.set` does
 *   (version 2, ADR 039).
 * - `voice`: « C'est moi » from its outbox: a voice of its recording named
 *   as the user, as `speakers.name` does (version 2, ADR 039).
 * - `tags`: the Mac's tags, to offer on the phone (version 2, ADR 039).
 * - `forget`: « Oublier ce Mac » revokes the phone's credential.
 *
 * The reads of the Mac's memory (M5.4), live, through the procedures
 * agents' tools call (ADR 011), withheld when a deletion lands meanwhile:
 *
 * - `search`: `search.query`, the search agents call `search_transcripts`.
 * - `day`: `episodes.day`, as `get_day_overview`.
 * - `journal`: `journal.day`, as `get_journal`.
 * - `commitments`: `journal.commitments`, open ones, as `list_commitments`.
 * - `conversation`: `episodes.get`, an episode's text, as `get_episode`.
 *
 * Playback, `GET /v1/recordings/<id>/audio?g=<generation>` with a byte
 * range, is the episode's WAV as the window's player streams it, for the
 * phone's own recordings only.
 */
export const PHONE_PROCEDURES = [
  "pair",
  "hello",
  "announce",
  "states",
  "delete",
  "get",
  "rename",
  "note",
  "tag",
  "voice",
  "tags",
  "forget",
  "search",
  "day",
  "journal",
  "commitments",
  "conversation",
] as const satisfies readonly (keyof typeof PHONE_ALL_ROUTES)[];
export type PhoneProcedure = (typeof PHONE_PROCEDURES)[number];

/**
 * The agent's tool each memory read runs (ADR 011): the same procedure, its
 * deletion filter and withheld answers, so a phone reads nothing an agent
 * may not. Core calls these procedures in process.
 */
export const PHONE_MEMORY_READS = {
  search: "search_transcripts",
  day: "get_day_overview",
  journal: "get_journal",
  commitments: "list_commitments",
  conversation: "get_episode",
} as const satisfies Record<PhoneMemoryRoute, AgentToolName>;
