import type { ChatFocus } from "@sondine/api";
import type { ChatReads } from "@sondine/db";

// The optional limit of a discussion (ADR 037): the user may keep the agent
// to the conversation, day or person it opened on. Core enforces it twice.
// Before a call, a tool that ranges over everything (search, the lists of
// people and commitments, another day or person) is refused: even its counts
// would tell what exists elsewhere. After it, the answer's reads (`readsOf`)
// must all fall inside the focus, or the answer is withheld whole, so nothing
// of it leaves for the agent. Without a limit the agent reads everything, as
// ADR 027 allows.

export interface EpisodeFacts {
  /** Its local day, YYYY-MM-DD. */
  readonly day: string;
  /** The people named or recognized in it. */
  readonly people: readonly number[];
}

export interface LimitLookups {
  /** Null when the episode is gone. */
  readonly episode: (episodeId: number) => Promise<EpisodeFacts | null>;
  /** The episode a context item belongs to; null when it is gone. */
  readonly itemEpisode: (itemId: number) => number | null;
  readonly selfId: () => number | null;
}

/** What the agent is told when an answer is withheld. */
export function limitText(limit: ChatFocus): string {
  const where =
    limit.kind === "episode"
      ? `the conversation with episodeId ${limit.episodeId} (read it with get_episode)`
      : limit.kind === "day"
        ? `the day ${limit.day} (read it with get_day_overview, then get_episode)`
        : `the person with personId ${limit.personId} (read them with get_person, then get_episode)`;
  return `The user limited this discussion to ${where}. This answer reached outside it, so Sondine withheld it. Answer from inside the limit, or tell the user the question needs more.`;
}

/** Tools that read no recorded content: allowed whatever the limit (status carries live text). */
const CONTENT_FREE = new Set([
  "get_capture_health",
  "list_spans",
  "pause_listening",
  "resume_listening",
  "request_permission",
]);

/** Tools whose answer is one episode or item: checked on what they return. */
const ONE_THING = new Set(["get_episode", "get_context_item", "request_analysis"]);

/** Tools about one day; `day` defaults to today. */
const ONE_DAY = new Set(["get_day_overview", "list_episodes", "get_journal"]);

/**
 * Whether a tool may run at all under the limit, from its name and arguments;
 * `today` is the local day a missing `day` means.
 */
export function toolAllowed(limit: ChatFocus, tool: string, args: unknown, today: string): boolean {
  if (CONTENT_FREE.has(tool) || ONE_THING.has(tool)) return true;
  const input = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  if (ONE_DAY.has(tool)) {
    const day = typeof input["day"] === "string" ? input["day"] : today;
    return limit.kind === "day" && day === limit.day;
  }
  if (tool === "get_person") return limit.kind === "person" && input["personId"] === limit.personId;
  // search_transcripts, list_people, list_commitments, and any tool added later.
  return false;
}

export async function withinLimit(
  limit: ChatFocus,
  reads: ChatReads,
  lookups: LimitLookups,
): Promise<boolean> {
  const episodes = new Set(reads.episodes);
  for (const itemId of reads.items) {
    const episodeId = lookups.itemEpisode(itemId);
    if (episodeId === null) return false;
    episodes.add(episodeId);
  }
  const met = new Set<number>();
  for (const episodeId of episodes) {
    const facts = await lookups.episode(episodeId);
    if (facts === null || !inside(limit, episodeId, facts)) return false;
    for (const personId of facts.people) met.add(personId);
  }
  // A person read must be one of the conversations' people, the user, or the person limited to:
  // a list of everyone the user met is outside any limit.
  const self = lookups.selfId();
  return reads.people.every(
    (personId) =>
      met.has(personId) ||
      personId === self ||
      (limit.kind === "person" && personId === limit.personId),
  );
}

function inside(limit: ChatFocus, episodeId: number, facts: EpisodeFacts): boolean {
  switch (limit.kind) {
    case "episode":
      return episodeId === limit.episodeId;
    case "day":
      return facts.day === limit.day;
    case "person":
      return facts.people.includes(limit.personId);
  }
}
