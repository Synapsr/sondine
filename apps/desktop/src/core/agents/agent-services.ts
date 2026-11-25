import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  ServiceFailure,
  type AgentApp,
  type AgentAppConnectResult,
  type AgentAppId,
  type AgentCallEntry,
  type AgentCreateResult,
  type AgentRevokeResult,
  type AgentsStatus,
  type AgentSummary,
} from "@sondine/api";
import {
  agentClient,
  agentClientByTokenHash,
  createAgentClient,
  getPerson,
  listAgentCalls,
  listAgentClients,
  loadEpisodeSummaries,
  pruneAgentCalls,
  removeAgentClient,
  revokeAgentClient,
  setAgentsEnabled,
  type AgentClient,
  type Database,
} from "@sondine/db";
import type { CoreConfigShape } from "../config";
import { log } from "../log";
import type { AgentAccessService } from "./agent-access";
import {
  AppConfigError,
  displayPath,
  installedAgentApps,
  jsonEntry,
  readSondineEntries,
  removeSondineEntries,
  serverNameFor,
  tomlEntry,
  writeSondineEntry,
  type KnownAgentApp,
  type RelayEntry,
  type SondineEntry,
} from "./agent-apps";
import { hashToken } from "./agent-host";

// Settings ▸ Agents (ADR 011): the switch, the agents and their keys, and the
// log of their calls. A key is made here and only its hash is stored. For the
// apps it knows (agent-apps.ts) Sondine writes the key into the app's own
// config file and takes it back on revoke; for Claude Code and Codex it gives
// a command, and for any other app the server to paste, both shown once.

/** Calls the settings list. */
const CALLS_SHOWN = 50;

/** A shell word that stays one word: single quotes, with its own quotes escaped. */
export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** The server's name: a development build's data lives apart, under its own name. */
export const serverBaseName = (relay: NonNullable<CoreConfigShape["agentRelay"]>) =>
  relay.socketArgument ? "sondine-dev" : "sondine";

/** What an entry starts: the relay, with the socket a development build gives it. */
export function relayEntry(
  token: string,
  relay: NonNullable<CoreConfigShape["agentRelay"]>,
  socketPath: string,
): RelayEntry {
  return {
    command: relay.path,
    args: relay.socketArgument ? ["--socket", socketPath] : [],
    token,
  };
}

export function agentSetup(
  token: string,
  relay: CoreConfigShape["agentRelay"],
  socketPath: string,
): AgentCreateResult["setup"] {
  if (relay === null) return null;
  const name = serverBaseName(relay);
  const entry = relayEntry(token, relay, socketPath);
  const target = [entry.command, ...entry.args].map(shellQuote).join(" ");
  return {
    claudeCode: `claude mcp add ${name} --transport stdio --scope user -e SONDINE_TOKEN=${token} -- ${target}`,
    codex: `codex mcp add ${name} --env SONDINE_TOKEN=${token} -- ${target}`,
    json: JSON.stringify({ mcpServers: { [name]: jsonEntry(entry) } }, null, 2),
    toml: tomlEntry(name, entry),
  };
}

const newToken = () => `sdn_${randomBytes(32).toString("base64url")}`;

export function makeAgentServices(options: {
  readonly db: Database;
  readonly access: AgentAccessService;
  readonly config: Pick<CoreConfigShape, "agentRelay" | "agentSocket">;
  /** The home folder whose apps' config files Sondine reads and writes. */
  readonly home: string;
  readonly now?: () => number;
}) {
  const { db, access, config, home } = options;
  const now = options.now ?? Date.now;

  const summary = (agent: AgentClient, connected: ReadonlySet<number>): AgentSummary => ({
    id: agent.id,
    name: agent.name,
    createdAtMs: agent.createdAtMs,
    lastUsedAtMs: agent.lastUsedAtMs,
    revokedAtMs: agent.revokedAtMs,
    connected: connected.has(agent.id),
  });

  const calls = (): AgentCallEntry[] => {
    pruneAgentCalls(db, now());
    const entries = listAgentCalls(db, { limit: CALLS_SHOWN });
    const episodes = loadEpisodeSummaries(db, [
      ...new Set(entries.flatMap((entry) => entry.detail.episodeId ?? [])),
    ]);
    return entries.map((entry) => {
      const { episodeId, personId, day, words, results } = entry.detail;
      return {
        id: entry.id,
        agentId: entry.clientId,
        agentName: entry.clientName,
        atMs: entry.atMs,
        tool: entry.tool,
        outcome: entry.outcome,
        durationMs: entry.durationMs,
        episodeId: episodeId ?? null,
        episodeStartedAtMs:
          episodeId === undefined ? null : (episodes.get(episodeId)?.startedAtMs ?? null),
        personId: personId ?? null,
        personName: personId === undefined ? null : (getPerson(db, personId)?.name ?? null),
        day: day ?? null,
        words: words ?? null,
        results: results ?? null,
      };
    });
  };

  /** The agent a key belongs to, revoked or not. */
  const owner = (token: string) => agentClientByTokenHash(db, hashToken(token));

  const apps = (): AgentApp[] => {
    const installed = installedAgentApps(home);
    return installed.map((app) => {
      const known = {
        id: app.id,
        name: app.name,
        path: displayPath(home, join(home, app.file)),
        sharedWith: installed
          .filter((other) => other.alsoReads.includes(app.file))
          .map((other) => other.name),
      };
      try {
        const live = readSondineEntries(home, app)
          .map((entry) => owner(entry.token))
          .find((agent) => agent !== null && agent.revokedAtMs === null);
        return { ...known, agentId: live?.id ?? null, problem: null };
      } catch (error) {
        const problem = error instanceof AppConfigError ? error.problem : "unreadable";
        return { ...known, agentId: null, problem };
      }
    });
  };

  const status = (): AgentsStatus => {
    const connected = access.connectedAgents();
    return {
      enabled: access.enabled(),
      listening: access.listening(),
      relayPath: config.agentRelay?.path ?? null,
      agents: listAgentClients(db).map((agent) => summary(agent, connected)),
      apps: apps(),
      calls: calls(),
    };
  };

  const revokeKey = (agentId: number) => {
    revokeAgentClient(db, agentId, now());
    access.closeSessions(agentId);
  };

  /**
   * Takes Sondine's servers holding this agent's key back from the apps'
   * files. A file it cannot read is reported only for the agent named after
   * that app, since any other key is unlikely to be there.
   */
  const takeBack = (agent: AgentClient) => {
    const removedFrom: string[] = [];
    const failed: AgentRevokeResult["failed"] = [];
    for (const app of installedAgentApps(home)) {
      const path = displayPath(home, join(home, app.file));
      try {
        const names = readSondineEntries(home, app)
          .filter((entry) => owner(entry.token)?.id === agent.id)
          .map((entry) => entry.name);
        if (names.length === 0) continue;
        if (removeSondineEntries(home, app, names) !== null) removedFrom.push(path);
        log.info("agents.app-entry-removed", { agentId: agent.id, app: app.id });
      } catch (error) {
        if (agent.name !== app.name) continue;
        const problem = error instanceof AppConfigError ? error.problem : "unwritable";
        log.warn("agents.app-entry-kept", { agentId: agent.id, app: app.id, problem });
        failed.push({ path, problem });
      }
    }
    return { removedFrom, failed };
  };

  const connectApp = (app: KnownAgentApp): AgentAppConnectResult => {
    const relay = config.agentRelay;
    if (relay === null) throw new ServiceFailure("invalid-input", "This build has no relay.");
    const file = join(home, app.file);
    const path = displayPath(home, file);
    let before: SondineEntry[];
    try {
      before = readSondineEntries(home, app);
    } catch (error) {
      if (!(error instanceof AppConfigError)) throw error;
      return { ok: false, path, problem: error.problem };
    }
    const { name, replaces } = serverNameFor(home, app, serverBaseName(relay));
    const token = newToken();
    const agent = createAgentClient(db, {
      name: app.name,
      tokenHash: hashToken(token),
      nowMs: now(),
    });
    // The other Sondine servers whose key this Mac's Sondine made: one per app.
    const replaced = before.filter((entry) => entry.name === name || owner(entry.token) !== null);
    let backup: string | null;
    try {
      backup = writeSondineEntry(
        home,
        app,
        name,
        relayEntry(token, relay, config.agentSocket),
        replaced.map((entry) => entry.name),
      ).backup;
    } catch (error) {
      // The key never left Sondine: it goes as if it had never been made.
      revokeAgentClient(db, agent.id, now());
      removeAgentClient(db, agent.id);
      if (!(error instanceof AppConfigError)) throw error;
      log.warn("agents.app-refused", { app: app.id, problem: error.problem });
      return { ok: false, path, problem: error.problem };
    }
    // The servers it replaced held the only copy of their keys.
    for (const entry of replaced) {
      const previous = owner(entry.token);
      if (previous !== null && previous.id !== agent.id && previous.revokedAtMs === null) {
        revokeKey(previous.id);
      }
    }
    log.info("agents.app-connected", { agentId: agent.id, app: app.id });
    return {
      ok: true,
      agent: summary(agent, access.connectedAgents()),
      path,
      serverName: name,
      backupPath: backup === null ? null : displayPath(home, backup),
      replaces: replaces === null ? null : displayPath(home, replaces),
    };
  };

  const existing = (agentId: number) => {
    const agent = agentClient(db, agentId);
    if (agent === null) throw new ServiceFailure("not-found", `No agent ${agentId}.`);
    return agent;
  };

  return {
    status,
    setEnabled(enabled: boolean): AgentsStatus {
      setAgentsEnabled(db, enabled, now());
      access.setEnabled(enabled);
      log.info("agents.enabled", { enabled });
      return status();
    },
    create(name: string): AgentCreateResult {
      const token = newToken();
      const agent = createAgentClient(db, { name, tokenHash: hashToken(token), nowMs: now() });
      log.info("agents.created", { agentId: agent.id });
      return {
        agent: summary(agent, access.connectedAgents()),
        token,
        setup: agentSetup(token, config.agentRelay, config.agentSocket),
      };
    },
    connectApp(appId: AgentAppId): AgentAppConnectResult {
      const app = installedAgentApps(home).find((known) => known.id === appId);
      if (app === undefined) throw new ServiceFailure("not-found", `${appId} is not on this Mac.`);
      return connectApp(app);
    },
    revoke(agentId: number): AgentRevokeResult {
      const agent = existing(agentId);
      revokeKey(agentId);
      log.info("agents.revoked", { agentId });
      const { removedFrom, failed } = takeBack(agent);
      return { status: status(), removedFrom, failed };
    },
    remove(agentId: number): AgentsStatus {
      if (existing(agentId).revokedAtMs === null) {
        throw new ServiceFailure("invalid-input", "Revoke this agent's access before removing it.");
      }
      removeAgentClient(db, agentId);
      log.info("agents.removed", { agentId });
      return status();
    },
  };
}
