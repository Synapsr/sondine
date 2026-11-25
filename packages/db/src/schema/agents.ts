import { sql } from "drizzle-orm";
import {
  blob,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { oneOf } from "./check";
import { agentCallOutcomes } from "./enums";

/**
 * Agents the user connected through MCP (ADR 011). Only the sha256 of each
 * token is kept: the token itself is shown once, when the agent is added. A
 * revoked agent stays listed, so the call log still says who called.
 */
export const agentClients = sqliteTable(
  "agent_clients",
  {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    tokenHash: blob("token_hash", { mode: "buffer" }).notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    lastUsedAtMs: integer("last_used_at_ms"),
    revokedAtMs: integer("revoked_at_ms"),
  },
  (t) => [
    uniqueIndex("agent_clients_token_unique").on(t.tokenHash),
    check("agent_clients_name_check", sql`length(trim(${t.name})) between 1 and 60`),
    check("agent_clients_token_check", sql`length(${t.tokenHash}) = 32`),
  ],
);

/** One tool call of an agent, as Settings ▸ Agents lists it. Kept 30 days. */
export const agentCalls = sqliteTable(
  "agent_calls",
  {
    id: integer("id").primaryKey(),
    clientId: integer("client_id")
      .notNull()
      .references(() => agentClients.id, { onDelete: "cascade" }),
    atMs: integer("at_ms").notNull(),
    tool: text("tool").notNull(),
    /**
     * What the call was about, as JSON with no recorded content: an episode
     * or person id, a day, a word count. Search words are never kept.
     */
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    outcome: text("outcome", { enum: agentCallOutcomes }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    resultBytes: integer("result_bytes").notNull(),
  },
  (t) => [
    index("agent_calls_at_idx").on(t.atMs),
    index("agent_calls_client_idx").on(t.clientId, t.atMs),
    check("agent_calls_outcome_check", oneOf(t.outcome, agentCallOutcomes)),
    check("agent_calls_detail_check", sql`json_valid(${t.detail}) and length(${t.detail}) <= 200`),
  ],
);
