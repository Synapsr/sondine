import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_CALL_RETENTION_MS,
  type AgentCallDetail,
  agentClientByTokenHash,
  agentsEnabled,
  createAgentClient,
  listAgentCalls,
  listAgentClients,
  recordAgentCall,
  removeAgentClient,
  revokeAgentClient,
  setAgentsEnabled,
} from "./agents";
import { t0, tempDatabase, type TempDatabase } from "./test-helpers";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const hash = (token: string) => createHash("sha256").update(token).digest();

function call(clientId: number, atMs: number, detail: AgentCallDetail = { words: 2, results: 3 }) {
  recordAgentCall(temp.db, {
    clientId,
    atMs,
    tool: "search_transcripts",
    detail,
    outcome: "ok",
    durationMs: 12.4,
    resultBytes: 900,
  });
}

describe("agents", () => {
  it("is off until the user turns it on", () => {
    expect(agentsEnabled(temp.db)).toBe(false);
    setAgentsEnabled(temp.db, true, t0);
    expect(agentsEnabled(temp.db)).toBe(true);
    setAgentsEnabled(temp.db, false, t0 + 1);
    expect(agentsEnabled(temp.db)).toBe(false);
  });

  it("finds an agent by its token's hash, and keeps it listed once revoked", () => {
    const claude = createAgentClient(temp.db, {
      name: "  Claude Code ",
      tokenHash: hash("a"),
      nowMs: t0,
    });
    const codex = createAgentClient(temp.db, {
      name: "Codex",
      tokenHash: hash("b"),
      nowMs: t0 + 1,
    });
    expect(claude.name).toBe("Claude Code");
    expect(agentClientByTokenHash(temp.db, hash("a"))?.id).toBe(claude.id);
    expect(agentClientByTokenHash(temp.db, hash("c"))).toBeNull();

    // Removing needs a revoked agent.
    expect(removeAgentClient(temp.db, claude.id)).toBe(false);
    expect(revokeAgentClient(temp.db, claude.id, t0 + 2)).toBe(true);
    expect(revokeAgentClient(temp.db, claude.id, t0 + 3)).toBe(false);
    expect(agentClientByTokenHash(temp.db, hash("a"))?.revokedAtMs).toBe(t0 + 2);
    expect(listAgentClients(temp.db).map((client) => client.name)).toEqual([
      "Codex",
      "Claude Code",
    ]);

    call(claude.id, t0 + 10);
    expect(removeAgentClient(temp.db, claude.id)).toBe(true);
    expect(listAgentClients(temp.db).map((client) => client.id)).toEqual([codex.id]);
    expect(listAgentCalls(temp.db, { limit: 10 })).toEqual([]);
  });

  it("logs calls newest first, marks the agent used, and forgets calls after 30 days", () => {
    const claude = createAgentClient(temp.db, { name: "Claude", tokenHash: hash("a"), nowMs: t0 });
    // Only ids, days and counts are kept: text slipped in by mistake is dropped.
    call(claude.id, t0 + 1_000, {
      episodeId: 7,
      day: "2026-11-07",
      q: "secret",
    } as AgentCallDetail);
    call(claude.id, t0 + 2_000);
    const calls = listAgentCalls(temp.db, { limit: 10 });
    expect(calls.map((entry) => entry.atMs)).toEqual([t0 + 2_000, t0 + 1_000]);
    expect(calls[0]).toMatchObject({ clientName: "Claude", durationMs: 12, outcome: "ok" });
    expect(calls[1]?.detail).toEqual({ episodeId: 7, day: "2026-11-07" });
    expect(listAgentClients(temp.db)[0]?.lastUsedAtMs).toBe(t0 + 2_000);

    call(claude.id, t0 + 2_001 + AGENT_CALL_RETENTION_MS);
    expect(listAgentCalls(temp.db, { limit: 10, clientId: claude.id })).toHaveLength(1);
  });
});
