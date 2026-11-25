import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { oneOf } from "./check";
import { chatReadKinds, chatRoles } from "./enums";

/**
 * Discussions with an agent (ADR 027): kept across launches, each deletable,
 * and erased when something they read is deleted (`chat_reads`).
 */
export const chatDiscussions = sqliteTable(
  "chat_discussions",
  {
    /** Never reused: a link to an erased discussion must not open a newer one. */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Téo's first message, shortened. */
    title: text("title").notNull(),
    /** The provider, model and effort of the last message. */
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    effort: text("effort"),
    startedAtMs: integer("started_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    /**
     * Where the user opened the agent (ADR 037): `{ kind: "episode" | "day" |
     * "person", ... }` as JSON, or null for everything.
     */
    focus: text("focus", { mode: "json" }).$type<Record<string, unknown>>(),
    /** « Limiter »: the agent's tools read only within `focus` (core enforces it). */
    limited: integer("limited", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    index("chat_discussions_updated_idx").on(t.updatedAtMs),
    check("chat_discussions_focus_check", sql`${t.focus} is null or json_valid(${t.focus})`),
    check("chat_discussions_title_check", sql`length(${t.title}) between 1 and 200`),
  ],
);

/** One message; an agent's answer holds the reads it made (`tools`, JSON). */
export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: integer("id").primaryKey(),
    discussionId: integer("discussion_id")
      .notNull()
      .references(() => chatDiscussions.id, { onDelete: "cascade" }),
    role: text("role", { enum: chatRoles }).notNull(),
    text: text("text").notNull(),
    atMs: integer("at_ms").notNull(),
    tools: text("tools", { mode: "json" })
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'`),
    /** An answer still coming; one left so by a core that stopped is marked stopped at start. */
    streaming: integer("streaming", { mode: "boolean" }).notNull().default(false),
    stopped: integer("stopped", { mode: "boolean" }).notNull().default(false),
    failure: text("failure", { mode: "json" }).$type<{ code: string; message: string }>(),
  },
  (t) => [
    index("chat_messages_discussion_idx").on(t.discussionId, t.id),
    check("chat_messages_role_check", oneOf(t.role, chatRoles)),
    check("chat_messages_tools_check", sql`json_valid(${t.tools})`),
    check("chat_messages_failure_check", sql`${t.failure} is null or json_valid(${t.failure})`),
  ],
);

/**
 * What a discussion's agent read: an episode at its input generation, a
 * person, an item of context. A deletion erases the discussions with a read
 * whose row is gone or, for an episode, whose generation moved.
 */
export const chatReads = sqliteTable(
  "chat_reads",
  {
    discussionId: integer("discussion_id")
      .notNull()
      .references(() => chatDiscussions.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: chatReadKinds }).notNull(),
    refId: integer("ref_id").notNull(),
    /** An episode's `input_generation` when read; null for people and items. */
    generation: integer("generation"),
  },
  (t) => [
    primaryKey({ columns: [t.discussionId, t.kind, t.refId] }),
    index("chat_reads_ref_idx").on(t.kind, t.refId),
    check("chat_reads_kind_check", oneOf(t.kind, chatReadKinds)),
  ],
);
