import {
  EpisodeContext,
  ServiceFailure,
  type ApiServices,
  type ChatProvider,
  type JournalCitation,
  type JournalCommitment,
  type JournalConversation,
  type JournalLine,
  type JournalState,
  type JournalVoice,
} from "@sondine/api";
import {
  journalPending,
  journalSettings,
  loadJournalItems,
  setJournalMark,
  setJournalSettings,
  type Database,
  type JournalRange,
  type StoredJournalItem,
} from "@sondine/db";
import type { JournalWork } from "./journal-work";

// The journal's procedures (ADR 028): a day, the open commitments, and the
// user's word on a line. Agents read the first two through MCP; nothing
// here quotes a transcript but the sentences a line cites.

export interface JournalServiceDeps {
  readonly db: Database;
  readonly work: JournalWork;
  /** The user's Claude CLI as the journal would use it. */
  readonly claudeStatus: () => Promise<ChatProvider>;
  /** Local day bounds, as Today counts them. */
  readonly dayRange: (day: string | undefined) => JournalRange & { readonly day: string };
  /** The queue looks again now. */
  readonly wake: () => void;
  /** An agent's answer read before the user's word does not leave with the old line (ADR 011). */
  readonly contentChanged: () => void;
  readonly now?: () => number;
}

const DAY_MS = 86_400_000;

function voicesOf(item: StoredJournalItem): JournalVoice[] {
  return Object.entries(item.voices).map(([ref, voice]) => ({
    ref,
    name: voice.name,
    self: voice.self,
    ordinal: voice.ordinal,
    guess:
      voice.guess === null
        ? null
        : {
            person: {
              id: voice.guess.person.id,
              name: voice.guess.person.name,
              self: voice.guess.person.isSelf,
            },
            confidence: Math.max(0, Math.min(1, voice.guess.confidence)),
            recognized: voice.guess.recognized,
          },
  }));
}

function lineOf(item: StoredJournalItem): JournalLine {
  const voices = voicesOf(item);
  const byLabel = new Map(
    Object.entries(item.voices).map(([ref, voice]) => [
      voice.label,
      voices.find((v) => v.ref === ref),
    ]),
  );
  const citations: JournalCitation[] = item.citations.map((citation) => ({
    episodeId: citation.episodeId,
    segmentId: citation.segmentId,
    startMs: citation.startMs,
    endMs: citation.endMs,
    speaker: citation.speakerLabel === null ? null : (byLabel.get(citation.speakerLabel) ?? null),
    text: citation.text,
  }));
  return {
    itemId: item.itemId,
    markId: item.markId,
    episodeId: item.episodeId,
    text: item.text,
    voices,
    edited: item.edited,
    status: item.status,
    stale: item.stale,
    startMs: item.startMs,
    citations,
  };
}

function commitmentOf(item: StoredJournalItem): JournalCommitment {
  const line = lineOf(item);
  const voice = (ref: string | null) =>
    ref === null ? null : (line.voices.find((candidate) => candidate.ref === ref) ?? null);
  return {
    ...line,
    who: voice(item.whoRef),
    to: voice(item.toRef),
    due: item.due,
    dueText: item.dueText,
  };
}

export function makeJournalServices(deps: JournalServiceDeps): ApiServices["journal"] {
  const { db, work } = deps;
  const now = deps.now ?? Date.now;

  const stateOf = (range: JournalRange): JournalState => {
    const settings = journalSettings(db);
    const engine = work.engine();
    // A day the user asked to write again counts what it still has to.
    const counts =
      engine === null
        ? { pending: 0, failed: 0 }
        : journalPending(db, work.configKey(), work.requestedRange(range) ?? range);
    const writing = work.current();
    return {
      installed: engine !== null,
      enabled: settings.enabled,
      language: settings.language,
      pending: counts.pending,
      failed: counts.failed,
      writing:
        writing !== null &&
        db
          .statement(
            "SELECT 1 AS present FROM episodes WHERE id = ? AND started_at_ms >= ? AND started_at_ms < ?",
          )
          .get(writing, range.fromMs, range.toMs) !== undefined,
      requested: work.isRequested(range),
      writer: settings.writer,
      claudePaused: work.claudePaused(),
    };
  };

  const episodeRows = (ids: readonly number[]) =>
    new Map(
      db
        .statement(
          `SELECT id, started_at_ms, ended_at_ms, context FROM episodes
           WHERE id IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(ids))
        .map((row) => [
          Number(row["id"]),
          {
            startedAtMs: Number(row["started_at_ms"]),
            endedAtMs: row["ended_at_ms"] === null ? null : Number(row["ended_at_ms"]),
            context: EpisodeContext.safeParse(row["context"]).data ?? null,
          },
        ]),
    );

  return {
    day: async (input) => {
      const range = deps.dayRange(input.day);
      const items = loadJournalItems(db, range);
      const conversations = new Map<number, JournalLine[]>();
      for (const item of items) {
        if (item.kind !== "event" || item.status === "dismissed") continue;
        const lines = conversations.get(item.episodeId) ?? [];
        lines.push(lineOf(item));
        conversations.set(item.episodeId, lines);
      }
      const episodes = episodeRows([...conversations.keys()]);
      const listed: JournalConversation[] = [];
      for (const [episodeId, lines] of conversations) {
        const episode = episodes.get(episodeId);
        if (episode === undefined) continue;
        listed.push({ episodeId, ...episode, lines });
      }
      listed.sort((a, b) => a.startedAtMs - b.startedAtMs);
      return {
        day: range.day,
        state: stateOf(range),
        conversations: listed,
        commitments: items.filter((item) => item.kind === "commitment").map(commitmentOf),
      };
    },
    commitments: async (input) => {
      const beforeMs = input.beforeMs ?? now();
      const fromMs = beforeMs - input.days * DAY_MS;
      const items = loadJournalItems(db, { fromMs, toMs: beforeMs, kind: "commitment" }).filter(
        (item) =>
          input.status === "all"
            ? true
            : input.status === "done"
              ? item.status === "done"
              : item.status === "open",
      );
      // Newest conversation first, as the window counts them: by their start.
      const starts = episodeRows([...new Set(items.map((item) => item.episodeId))]);
      const startOf = (item: StoredJournalItem) =>
        starts.get(item.episodeId)?.startedAtMs ?? item.startMs;
      const ordered = items.toSorted(
        (a, b) => startOf(b) - startOf(a) || b.episodeId - a.episodeId || b.startMs - a.startMs,
      );
      const last = input.limit === undefined ? undefined : ordered[input.limit - 1];
      if (last === undefined || ordered.length === input.limit) {
        return { commitments: ordered.map(commitmentOf), nextBeforeMs: fromMs };
      }
      // Cut after the conversations that start in the last kept one's
      // millisecond: the next page, before it, skips none and repeats none.
      const boundary = startOf(last);
      const kept = ordered.filter((item) => startOf(item) >= boundary);
      return { commitments: kept.map(commitmentOf), nextBeforeMs: boundary };
    },
    mark: async (input) => {
      const result = setJournalMark(
        db,
        { itemId: input.itemId, markId: input.markId },
        input.change,
        now(),
      );
      if (!result.ok) {
        throw new ServiceFailure("not-found", "this line changed since: read the journal again");
      }
      deps.contentChanged();
      return { markId: result.markId };
    },
    request: async (input) => {
      const range = deps.dayRange(input.day);
      work.request(range, input.rewrite === true);
      deps.wake();
      return stateOf(range);
    },
    settings: async (input) => {
      const settings = setJournalSettings(
        db,
        {
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(input.language === undefined ? {} : { language: input.language }),
          ...(input.writer === undefined ? {} : { writer: input.writer }),
        },
        now(),
      );
      if (input.enabled === true || input.writer !== undefined) deps.wake();
      return settings;
    },
    claude: () => deps.claudeStatus(),
  };
}
