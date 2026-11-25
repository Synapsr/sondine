import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentClientByTokenHash,
  listAgentClients,
  openDatabase,
  type OpenedDatabase,
} from "@sondine/db";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrationsDir, tempDataDir, type TempDataDir } from "../../../test/support";
import { makeAgentAccess } from "./agent-access";
import { readSondineEntries, KNOWN_AGENT_APPS } from "./agent-apps";
import { hashToken } from "./agent-host";
import { agentSetup, makeAgentServices } from "./agent-services";

let data: TempDataDir;
let db: OpenedDatabase;
let home: string;
let agents: ReturnType<typeof makeAgentServices>;
const RELAY = "/Applications/Sondine Exp.app/Contents/Helpers/sondine-mcp";
const grok = KNOWN_AGENT_APPS[0]!;

beforeEach(() => {
  data = tempDataDir();
  db = openDatabase(join(data.dir, "sondine.db"), { migrationsFolder: migrationsDir });
  home = join(data.dir, "home");
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(join(home, ".grok", "config.toml"), "[ui]\nyolo = false\n");
  agents = makeAgentServices({
    db,
    access: makeAgentAccess(true),
    config: {
      agentSocket: data.config().agentSocket,
      agentRelay: { path: RELAY, socketArgument: false },
    },
    home,
  });
});
afterEach(() => {
  db.close();
  data.cleanup();
});

const grokFile = () => readFileSync(join(home, ".grok", "config.toml"), "utf8");

describe("connecting an app", () => {
  it("makes the app's key and writes it into the app's file, which status then reads", () => {
    expect(agents.status().apps).toEqual([
      {
        id: "grok",
        name: "Grok",
        path: "~/.grok/config.toml",
        agentId: null,
        sharedWith: [],
        problem: null,
      },
    ]);
    const result = agents.connectApp("grok");
    if (!result.ok) throw new Error(result.problem);
    expect(result).toMatchObject({
      agent: { name: "Grok", revokedAtMs: null },
      path: "~/.grok/config.toml",
      serverName: "sondine",
      backupPath: "~/.grok/config.toml.sondine-backup",
      replaces: null,
    });
    const [entry] = readSondineEntries(home, grok);
    expect(agentClientByTokenHash(db, hashToken(entry?.token ?? ""))?.id).toBe(result.agent.id);
    expect(parseToml(grokFile())).toMatchObject({
      ui: { yolo: false },
      mcp_servers: { sondine: { command: RELAY, args: [] } },
    });
    expect(agents.status().apps[0]?.agentId).toBe(result.agent.id);
  });

  it("keeps one key per app: connecting again revokes the key it replaced", () => {
    const first = agents.connectApp("grok");
    const second = agents.connectApp("grok");
    if (!first.ok || !second.ok) throw new Error("not connected");
    expect(readSondineEntries(home, grok)).toHaveLength(1);
    const listed = listAgentClients(db);
    expect(listed.find((agent) => agent.id === first.agent.id)?.revokedAtMs).not.toBeNull();
    expect(listed.find((agent) => agent.id === second.agent.id)?.revokedAtMs).toBeNull();
  });

  it("takes the name Grok also reads elsewhere, and leaves one Sondine server in its file", () => {
    const first = agents.connectApp("grok");
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { Sondine: { command: "node", args: ["context.ts"] } } }),
    );
    const second = agents.connectApp("grok");
    if (!first.ok || !second.ok) throw new Error("not connected");
    expect(second).toMatchObject({ serverName: "Sondine", replaces: "~/.claude.json" });
    expect(readSondineEntries(home, grok).map((entry) => entry.name)).toEqual(["Sondine"]);
    expect(
      listAgentClients(db).find((agent) => agent.id === first.agent.id)?.revokedAtMs,
    ).not.toBeNull();
  });

  it("takes its server back when the key is revoked, and only that one", () => {
    const connected = agents.connectApp("grok");
    if (!connected.ok) throw new Error(connected.problem);
    const other = agents.create("Codex");
    const kept = agents.revoke(other.agent.id);
    expect(kept.removedFrom).toEqual([]);
    expect(readSondineEntries(home, grok)).toHaveLength(1);

    const revoked = agents.revoke(connected.agent.id);
    expect(revoked).toMatchObject({ removedFrom: ["~/.grok/config.toml"], failed: [] });
    expect(grokFile()).toBe("[ui]\nyolo = false\n");
    expect(revoked.status.apps[0]?.agentId).toBeNull();
  });

  it("says when the file could not be edited, and leaves no key behind", () => {
    writeFileSync(join(home, ".grok", "config.toml"), '[mcp_servers.sondine]\ncommand = "x"\n');
    expect(agents.connectApp("grok")).toEqual({
      ok: false,
      path: "~/.grok/config.toml",
      problem: "taken",
    });
    expect(listAgentClients(db)).toEqual([]);
    writeFileSync(join(home, ".grok", "config.toml"), "[ui\n");
    expect(agents.connectApp("grok")).toMatchObject({ ok: false, problem: "unreadable" });
    expect(agents.status().apps[0]?.problem).toBe("unreadable");
  });

  it("reports a file it could not take the key back from, for the app's own key", () => {
    const connected = agents.connectApp("grok");
    if (!connected.ok) throw new Error(connected.problem);
    writeFileSync(join(home, ".grok", "config.toml"), "[ui\n");
    expect(agents.revoke(connected.agent.id)).toMatchObject({
      removedFrom: [],
      failed: [{ path: "~/.grok/config.toml", problem: "unreadable" }],
    });
    expect(listAgentClients(db)[0]?.revokedAtMs).not.toBeNull();
  });

  it("says which other app also loads an app's file", () => {
    mkdirSync(join(home, ".cursor"));
    expect(agents.status().apps.map((app) => [app.name, app.sharedWith])).toEqual([
      ["Grok", []],
      ["Cursor", ["Grok"]],
    ]);
  });

  it("refuses an app that is not on this Mac", () => {
    expect(() => agents.connectApp("cursor")).toThrow("not on this Mac");
    expect(existsSync(join(home, ".cursor"))).toBe(false);
  });
});

describe("the server to paste", () => {
  it("is the same relay and key as JSON, TOML and both commands", () => {
    const token = `sdn_${"b".repeat(43)}`;
    const setup = agentSetup(token, { path: RELAY, socketArgument: false }, "/unused");
    expect(JSON.parse(setup?.json ?? "")).toEqual({
      mcpServers: { sondine: { command: RELAY, args: [], env: { SONDINE_TOKEN: token } } },
    });
    expect(parseToml(setup?.toml ?? "")).toEqual({
      mcp_servers: { sondine: { command: RELAY, args: [], env: { SONDINE_TOKEN: token } } },
    });
    expect(setup?.codex).toBe(
      `codex mcp add sondine --env SONDINE_TOKEN=${token} -- '/Applications/Sondine Exp.app/Contents/Helpers/sondine-mcp'`,
    );
    const dev = agentSetup(
      token,
      { path: "/repo/sondine-mcp", socketArgument: true },
      "/d/mcp.sock",
    );
    expect(parseToml(dev?.toml ?? "")).toEqual({
      mcp_servers: {
        "sondine-dev": {
          command: "/repo/sondine-mcp",
          args: ["--socket", "/d/mcp.sock"],
          env: { SONDINE_TOKEN: token },
        },
      },
    });
    expect(agentSetup(token, null, "/unused")).toBeNull();
  });
});
