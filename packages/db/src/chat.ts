import { transaction, type Database } from "./database";
import { int, intOrNull, str, strOrNull, type Row } from "./rows";
import type { ChatRole } from "./schema/enums";

// Discussions with an agent (ADR 027): the switch (off by default), the
// provider, model and effort Téo last chose, and the discussions themselves,
// kept across launches. What each agent read is recorded (`chat_reads`) so a
// deletion erases exactly the discussions that may quote what went.

const ENABLED_KEY = "chat.enabled";
const CHOICE_KEY = "chat.choice";

export interface ChatChoice {
  readonly provider: string;
  readonly model: string;
  readonly effort: string | null;
}

const write = (db: Database, key: string, value: unknown, nowMs: number) =>
  db
    .statement(
      `INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
    )
    .run(key, JSON.stringify(value), nowMs);

export function chatEnabled(db: Database): boolean {
  const row = db.statement("SELECT value FROM settings WHERE key = ?").get(ENABLED_KEY);
  return row !== undefined && JSON.parse(str(row, "value")) === true;
}

export function setChatEnabled(db: Database, enabled: boolean, nowMs: number): void {
  write(db, ENABLED_KEY, enabled, nowMs);
}

export function chatChoice(db: Database): ChatChoice | null {
  const row = db.statement("SELECT value FROM settings WHERE key = ?").get(CHOICE_KEY);
  if (row === undefined) return null;
  const value: unknown = JSON.parse(str(row, "value"));
  if (typeof value !== "object" || value === null) return null;
  const { provider, model, effort } = value as Record<string, unknown>;
  if (typeof provider !== "string" || typeof model !== "string") return null;
  return { provider, model, effort: typeof effort === "string" ? effort : null };
}

export function setChatChoice(db: Database, choice: ChatChoice, nowMs: number): void {
  write(db, CHOICE_KEY, choice, nowMs);
}

export interface StoredChatDiscussion {
  readonly id: number;
  readonly title: string;
  readonly provider: string;
  readonly model: string;
  readonly effort: string | null;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  /** Where the user opened the agent, as stored (JSON); core checks its shape. */
  readonly focus: unknown;
  readonly limited: boolean;
}

export interface StoredChatMessage {
  readonly id: number;
  readonly role: ChatRole;
  readonly text: string;
  readonly atMs: number;
  readonly tools: readonly unknown[];
  readonly streaming: boolean;
  readonly stopped: boolean;
  readonly failure: { readonly code: string; readonly message: string } | null;
}

/** What one tool call returned of Sondine's content, by id. */
export interface ChatReads {
  readonly episodes: readonly number[];
  readonly people: readonly number[];
  readonly items: readonly number[];
}

const DISCUSSION_COLUMNS =
  "id, title, provider, model, effort, started_at_ms, updated_at_ms, focus, limited";

function discussionOf(row: Row): StoredChatDiscussion {
  return {
    id: int(row, "id"),
    title: str(row, "title"),
    provider: str(row, "provider"),
    model: str(row, "model"),
    effort: strOrNull(row, "effort"),
    startedAtMs: int(row, "started_at_ms"),
    updatedAtMs: int(row, "updated_at_ms"),
    focus: parseFocus(strOrNull(row, "focus")),
    limited: int(row, "limited") === 1,
  };
}

function parseFocus(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function messageOf(row: Row): StoredChatMessage {
  const failure = strOrNull(row, "failure");
  return {
    id: int(row, "id"),
    role: str(row, "role") === "user" ? "user" : "agent",
    text: str(row, "text"),
    atMs: int(row, "at_ms"),
    tools: JSON.parse(str(row, "tools")) as unknown[],
    streaming: int(row, "streaming") === 1,
    stopped: int(row, "stopped") === 1,
    failure: failure === null ? null : (JSON.parse(failure) as StoredChatMessage["failure"]),
  };
}

export function createChatDiscussion(
  db: Database,
  input: {
    readonly title: string;
    readonly provider: string;
    readonly model: string;
    readonly effort: string | null;
    readonly nowMs: number;
    /** Where the user opened the agent (ADR 037), stored as JSON; null for everything. */
    readonly focus?: unknown;
    readonly limited?: boolean;
  },
): number {
  const result = db
    .statement(
      `INSERT INTO chat_discussions (title, provider, model, effort, started_at_ms, updated_at_ms,
         focus, limited)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.title,
      input.provider,
      input.model,
      input.effort,
      input.nowMs,
      input.nowMs,
      input.focus == null ? null : JSON.stringify(input.focus),
      input.limited === true ? 1 : 0,
    );
  return Number(result.lastInsertRowid);
}

/** « Limiter » on or off (ADR 037); false when the discussion is gone. */
export function setChatDiscussionLimited(
  db: Database,
  discussionId: number,
  limited: boolean,
): boolean {
  return (
    db
      .statement("UPDATE chat_discussions SET limited = ? WHERE id = ?")
      .run(limited ? 1 : 0, discussionId).changes > 0
  );
}

/** The provider, model and effort of the discussion's last message. */
export function setChatDiscussionChoice(
  db: Database,
  discussionId: number,
  choice: { readonly provider: string; readonly model: string; readonly effort: string | null },
  nowMs: number,
): void {
  db.statement(
    `UPDATE chat_discussions SET provider = ?, model = ?, effort = ?, updated_at_ms = ? WHERE id = ?`,
  ).run(choice.provider, choice.model, choice.effort, nowMs, discussionId);
}

/** Newest first. */
export function listChatDiscussions(db: Database, limit = 500): StoredChatDiscussion[] {
  return db
    .statement(
      `SELECT ${DISCUSSION_COLUMNS} FROM chat_discussions ORDER BY updated_at_ms DESC, id DESC LIMIT ?`,
    )
    .all(limit)
    .map(discussionOf);
}

export function chatDiscussion(db: Database, discussionId: number): StoredChatDiscussion | null {
  const row = db
    .statement(`SELECT ${DISCUSSION_COLUMNS} FROM chat_discussions WHERE id = ?`)
    .get(discussionId);
  return row === undefined ? null : discussionOf(row);
}

export function chatMessages(db: Database, discussionId: number): StoredChatMessage[] {
  return db
    .statement(
      `SELECT id, role, text, at_ms, tools, streaming, stopped, failure
       FROM chat_messages WHERE discussion_id = ? ORDER BY id`,
    )
    .all(discussionId)
    .map(messageOf);
}

export function addChatMessage(
  db: Database,
  input: {
    readonly discussionId: number;
    readonly role: ChatRole;
    readonly text: string;
    readonly atMs: number;
    readonly streaming: boolean;
  },
): number {
  return transaction(db, () => {
    const result = db
      .statement(
        `INSERT INTO chat_messages (discussion_id, role, text, at_ms, streaming)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.discussionId, input.role, input.text, input.atMs, input.streaming ? 1 : 0);
    db.statement("UPDATE chat_discussions SET updated_at_ms = ? WHERE id = ?").run(
      input.atMs,
      input.discussionId,
    );
    return Number(result.lastInsertRowid);
  });
}

/** An answer that ended: its text, its reads, and whether it was stopped or failed. */
export function finishChatMessage(
  db: Database,
  messageId: number,
  input: {
    readonly text: string;
    readonly tools: readonly unknown[];
    readonly stopped: boolean;
    readonly failure: { readonly code: string; readonly message: string } | null;
  },
): void {
  db.statement(
    `UPDATE chat_messages SET text = ?, tools = ?, stopped = ?, failure = ?, streaming = 0
     WHERE id = ?`,
  ).run(
    input.text,
    JSON.stringify(input.tools),
    input.stopped ? 1 : 0,
    input.failure === null ? null : JSON.stringify(input.failure),
    messageId,
  );
}

/** Answers left streaming by a core that stopped: they end as stopped. */
export function settleInterruptedChatMessages(db: Database): number {
  return Number(
    db.statement("UPDATE chat_messages SET streaming = 0, stopped = 1 WHERE streaming = 1").run()
      .changes,
  );
}

/** Deletes a discussion with its messages and reads; false when it did not exist. */
export function deleteChatDiscussion(db: Database, discussionId: number): boolean {
  return (
    Number(db.statement("DELETE FROM chat_discussions WHERE id = ?").run(discussionId).changes) > 0
  );
}

/**
 * Records what a call returned: each episode at its current input
 * generation, people and items that exist. The first generation read stays:
 * a later read of a changed episode does not make the earlier answers, which
 * may quote the older words, fresh again.
 */
export function recordChatReads(db: Database, discussionId: number, reads: ChatReads): void {
  transaction(db, () => {
    const episode = db.statement(
      `INSERT INTO chat_reads (discussion_id, kind, ref_id, generation)
       SELECT ?, 'episode', id, input_generation FROM episodes WHERE id = ?
       ON CONFLICT (discussion_id, kind, ref_id) DO NOTHING`,
    );
    const person = db.statement(
      `INSERT INTO chat_reads (discussion_id, kind, ref_id)
       SELECT ?, 'person', id FROM people WHERE id = ?
       ON CONFLICT (discussion_id, kind, ref_id) DO NOTHING`,
    );
    const item = db.statement(
      `INSERT INTO chat_reads (discussion_id, kind, ref_id)
       SELECT ?, 'item', id FROM context_items WHERE id = ?
       ON CONFLICT (discussion_id, kind, ref_id) DO NOTHING`,
    );
    for (const id of new Set(reads.episodes)) episode.run(discussionId, id);
    for (const id of new Set(reads.people)) person.run(discussionId, id);
    for (const id of new Set(reads.items)) item.run(discussionId, id);
  });
}

/**
 * Discussions that read something since deleted or changed: an episode gone
 * or at another input generation (a passage deleted, regrouped), a person
 * or an item of context gone.
 */
export function staleChatDiscussions(db: Database): number[] {
  return db
    .statement(
      `SELECT DISTINCT r.discussion_id AS id FROM chat_reads r
       LEFT JOIN episodes e ON r.kind = 'episode' AND e.id = r.ref_id
       LEFT JOIN people p ON r.kind = 'person' AND p.id = r.ref_id
       LEFT JOIN context_items c ON r.kind = 'item' AND c.id = r.ref_id
       WHERE (r.kind = 'episode' AND (e.id IS NULL OR e.input_generation IS NOT r.generation))
          OR (r.kind = 'person' AND p.id IS NULL)
          OR (r.kind = 'item' AND c.id IS NULL)
       ORDER BY r.discussion_id`,
    )
    .all()
    .map((row) => int(row, "id"));
}

/** Discussions that read any of these episodes (a person's, before they go). */
export function chatDiscussionsReading(db: Database, episodeIds: readonly number[]): number[] {
  const ids = [...new Set(episodeIds)];
  if (ids.length === 0) return [];
  const found = new Set<number>();
  const statement = db.statement(
    "SELECT discussion_id AS id FROM chat_reads WHERE kind = 'episode' AND ref_id = ?",
  );
  for (const id of ids) for (const row of statement.all(id)) found.add(int(row, "id"));
  return [...found].toSorted((a, b) => a - b);
}

/** How many reads a discussion holds (diagnostics and tests). */
export function chatReadCount(db: Database, discussionId: number): number {
  const row = db
    .statement("SELECT count(*) AS n FROM chat_reads WHERE discussion_id = ?")
    .get(discussionId);
  return row === undefined ? 0 : (intOrNull(row, "n") ?? 0);
}
