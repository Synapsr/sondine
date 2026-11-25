import { transaction, type Database } from "./database";
import { int, intOrNull, oneOfValues, str, type Row } from "./rows";
import { agentCallOutcomes, type AgentCallOutcome } from "./schema/enums";

// Agents connected through MCP (ADR 011) and what they read. Access is off
// until the user turns it on; each agent holds its own token, of which only
// the sha256 is stored; revoking keeps the agent listed so its calls still
// say who made them. The call log is the user's view of what left Sondine:
// which tool, about which episode, person or day, never the words searched
// or read, so deleting a recording leaves nothing of it here.

const ENABLED_KEY = "agents.enabled";

/** Calls older than this are pruned. */
export const AGENT_CALL_RETENTION_MS = 30 * 86_400_000;
/** The log never holds more calls than this. */
export const AGENT_CALL_CAP = 5_000;
/** Fields of `agent_calls.detail`: ids, a day and counts, never recorded content. */
export interface AgentCallDetail {
  readonly episodeId?: number;
  readonly personId?: number;
  /** A local day, `YYYY-MM-DD`. */
  readonly day?: string;
  /** How many words a search had. */
  readonly words?: number;
  /** How many episodes, people or segments came back. */
  readonly results?: number;
}

export interface AgentClient {
  readonly id: number;
  readonly name: string;
  readonly createdAtMs: number;
  readonly lastUsedAtMs: number | null;
  readonly revokedAtMs: number | null;
}

export interface AgentCall {
  readonly id: number;
  readonly clientId: number;
  readonly clientName: string;
  readonly atMs: number;
  readonly tool: string;
  readonly detail: AgentCallDetail;
  readonly outcome: AgentCallOutcome;
  readonly durationMs: number;
  readonly resultBytes: number;
}

const CLIENT_COLUMNS = "id, name, created_at_ms, last_used_at_ms, revoked_at_ms";

function clientOf(row: Row): AgentClient {
  return {
    id: int(row, "id"),
    name: str(row, "name"),
    createdAtMs: int(row, "created_at_ms"),
    lastUsedAtMs: intOrNull(row, "last_used_at_ms"),
    revokedAtMs: intOrNull(row, "revoked_at_ms"),
  };
}

export function agentsEnabled(db: Database): boolean {
  const row = db.statement("SELECT value FROM settings WHERE key = ?").get(ENABLED_KEY);
  return row !== undefined && JSON.parse(str(row, "value")) === true;
}

export function setAgentsEnabled(db: Database, enabled: boolean, nowMs: number): void {
  db.statement(
    `INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
  ).run(ENABLED_KEY, JSON.stringify(enabled), nowMs);
}

export function createAgentClient(
  db: Database,
  input: { readonly name: string; readonly tokenHash: Buffer; readonly nowMs: number },
): AgentClient {
  const row = db
    .statement(
      `INSERT INTO agent_clients (name, token_hash, created_at_ms) VALUES (?, ?, ?)
       RETURNING ${CLIENT_COLUMNS}`,
    )
    .get(input.name.trim(), input.tokenHash, input.nowMs);
  if (row === undefined) throw new Error("agent_clients insert returned no row");
  return clientOf(row);
}

/** The agent a token belongs to, revoked or not; null for a token Sondine never gave. */
export function agentClientByTokenHash(db: Database, tokenHash: Buffer): AgentClient | null {
  const row = db
    .statement(`SELECT ${CLIENT_COLUMNS} FROM agent_clients WHERE token_hash = ?`)
    .get(tokenHash);
  return row === undefined ? null : clientOf(row);
}

export function agentClient(db: Database, id: number): AgentClient | null {
  const row = db.statement(`SELECT ${CLIENT_COLUMNS} FROM agent_clients WHERE id = ?`).get(id);
  return row === undefined ? null : clientOf(row);
}

/** Agents with access first, newest first; then the revoked ones. */
export function listAgentClients(db: Database): AgentClient[] {
  return db
    .statement(
      `SELECT ${CLIENT_COLUMNS} FROM agent_clients
       ORDER BY revoked_at_ms IS NOT NULL, created_at_ms DESC, id DESC`,
    )
    .all()
    .map(clientOf);
}

/** Revokes an agent's token; false when there is no such agent or it was already revoked. */
export function revokeAgentClient(db: Database, id: number, nowMs: number): boolean {
  const result = db
    .statement("UPDATE agent_clients SET revoked_at_ms = ? WHERE id = ? AND revoked_at_ms IS NULL")
    .run(nowMs, id);
  return Number(result.changes) > 0;
}

/** Deletes a revoked agent and its calls; an agent with access must be revoked first. */
export function removeAgentClient(db: Database, id: number): boolean {
  const result = db
    .statement("DELETE FROM agent_clients WHERE id = ? AND revoked_at_ms IS NOT NULL")
    .run(id);
  return Number(result.changes) > 0;
}

export interface AgentCallInput {
  readonly clientId: number;
  readonly atMs: number;
  readonly tool: string;
  readonly detail: AgentCallDetail;
  readonly outcome: AgentCallOutcome;
  readonly durationMs: number;
  readonly resultBytes: number;
}

/** Keeps the detail's known fields, so nothing else can be logged by mistake. */
function cleanDetail(detail: AgentCallDetail): AgentCallDetail {
  const out: Record<string, number | string> = {};
  for (const key of ["episodeId", "personId", "words", "results"] as const) {
    const value = detail[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) out[key] = value;
  }
  if (typeof detail.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(detail.day))
    out["day"] = detail.day;
  return out;
}

/** Logs one call, marks the agent used, and prunes the log to 30 days and 5,000 calls. */
export function recordAgentCall(db: Database, call: AgentCallInput): void {
  transaction(db, () => {
    db.statement(
      `INSERT INTO agent_calls (client_id, at_ms, tool, detail, outcome, duration_ms, result_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      call.clientId,
      call.atMs,
      call.tool,
      JSON.stringify(cleanDetail(call.detail)),
      call.outcome,
      Math.max(0, Math.round(call.durationMs)),
      call.resultBytes,
    );
    db.statement(
      "UPDATE agent_clients SET last_used_at_ms = max(coalesce(last_used_at_ms, 0), ?) WHERE id = ?",
    ).run(call.atMs, call.clientId);
    pruneAgentCalls(db, call.atMs);
  });
}

/** Drops calls older than 30 days and beyond the newest 5,000; returns how many went. */
export function pruneAgentCalls(db: Database, nowMs: number): number {
  const old = db
    .statement("DELETE FROM agent_calls WHERE at_ms < ?")
    .run(nowMs - AGENT_CALL_RETENTION_MS);
  const extra = db
    .statement(
      `DELETE FROM agent_calls WHERE id IN (
         SELECT id FROM agent_calls ORDER BY at_ms DESC, id DESC LIMIT -1 OFFSET ?)`,
    )
    .run(AGENT_CALL_CAP);
  return Number(old.changes) + Number(extra.changes);
}

/** The latest calls, newest first, optionally of one agent. */
export function listAgentCalls(
  db: Database,
  options: { readonly limit: number; readonly clientId?: number | undefined },
): AgentCall[] {
  const rows =
    options.clientId === undefined
      ? db
          .statement(
            `SELECT c.*, a.name AS client_name FROM agent_calls c
             JOIN agent_clients a ON a.id = c.client_id
             ORDER BY c.at_ms DESC, c.id DESC LIMIT ?`,
          )
          .all(options.limit)
      : db
          .statement(
            `SELECT c.*, a.name AS client_name FROM agent_calls c
             JOIN agent_clients a ON a.id = c.client_id
             WHERE c.client_id = ? ORDER BY c.at_ms DESC, c.id DESC LIMIT ?`,
          )
          .all(options.clientId, options.limit);
  return rows.map((row) => ({
    id: int(row, "id"),
    clientId: int(row, "client_id"),
    clientName: str(row, "client_name"),
    atMs: int(row, "at_ms"),
    tool: str(row, "tool"),
    detail: cleanDetail(JSON.parse(str(row, "detail")) as AgentCallDetail),
    outcome: oneOfValues(row, "outcome", agentCallOutcomes),
    durationMs: int(row, "duration_ms"),
    resultBytes: int(row, "result_bytes"),
  }));
}
