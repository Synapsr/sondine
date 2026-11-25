import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDataDir, type TempDataDir } from "../../../test/support";
import {
  AppConfigError,
  BACKUP_SUFFIX,
  KNOWN_AGENT_APPS,
  TOML_MARKER,
  displayPath,
  installedAgentApps,
  readSondineEntries,
  removeSondineEntries,
  serverNameFor,
  tomlEntry,
  tomlString,
  type AgentAppId,
  type KnownAgentApp,
  writeSondineEntry,
} from "./agent-apps";

let data: TempDataDir;
let home: string;
beforeEach(() => {
  data = tempDataDir();
  home = join(data.dir, "home");
  mkdirSync(home);
});
afterEach(() => data.cleanup());

const app = (id: AgentAppId): KnownAgentApp => {
  const found = KNOWN_AGENT_APPS.find((known) => known.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};
const grok = app("grok");
const claude = app("claude");

const RELAY = "/Applications/Sondine Exp.app/Contents/Helpers/sondine-mcp";
const entry = (token: string) => ({ command: RELAY, args: [], token });
const TOKEN = `sdn_${"a".repeat(43)}`;

/** Grok's file as found on Téo's Mac, with a comment and another server. */
const GROK = `[cli]
installer = "internal"
auto_update = true

# Servers Téo added himself.
[mcp_servers.linear]
command = "npx"
args = ["-y", "mcp-remote", "https://mcp.linear.app/mcp"]

[ui]
yolo = false
`;

function place(relative: string, text: string, mode = 0o644): string {
  const path = join(home, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, { mode });
  return path;
}

const thrown = (run: () => unknown): AppConfigError => {
  try {
    run();
  } catch (error) {
    if (error instanceof AppConfigError) return error;
    throw error;
  }
  throw new Error("expected an AppConfigError");
};

describe("apps on this Mac", () => {
  it("are the ones whose folder exists", () => {
    expect(installedAgentApps(home)).toEqual([]);
    mkdirSync(join(home, ".grok"));
    mkdirSync(join(home, ".cursor"));
    expect(installedAgentApps(home).map((known) => known.id)).toEqual(["grok", "cursor"]);
    expect(displayPath(home, join(home, grok.file))).toBe("~/.grok/config.toml");
  });
});

describe("Grok's TOML file", () => {
  it("gains Sondine's server below the rest, and loses it to the byte", () => {
    const path = place(grok.file, GROK);
    const written = writeSondineEntry(home, grok, "sondine", entry(TOKEN));
    expect(written).toEqual({ path, backup: `${path}${BACKUP_SUFFIX}` });
    expect(readFileSync(path, "utf8")).toBe(
      `${GROK}\n${TOML_MARKER}\n[mcp_servers.sondine]\ncommand = "${RELAY}"\nargs = []\nenv = { SONDINE_TOKEN = "${TOKEN}" }\n`,
    );
    expect(readFileSync(`${path}${BACKUP_SUFFIX}`, "utf8")).toBe(GROK);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(readSondineEntries(home, grok)).toEqual([{ name: "sondine", token: TOKEN }]);

    expect(removeSondineEntries(home, grok, ["sondine"])).toEqual({
      path,
      backup: `${path}${BACKUP_SUFFIX}`,
    });
    expect(readFileSync(path, "utf8")).toBe(GROK);
    expect(readSondineEntries(home, grok)).toEqual([]);
    expect(removeSondineEntries(home, grok, ["sondine"])).toBeNull();
  });

  it("replaces its own server, wherever it sits and however the app rewrote it", () => {
    const rewritten = `[mcp_servers.sondine]
command = "/old/sondine-mcp"
args = []

[mcp_servers.sondine.env]
SONDINE_TOKEN = "sdn_old"

[ui]
yolo = false
`;
    const path = place(grok.file, rewritten);
    writeSondineEntry(home, grok, "sondine", entry(TOKEN));
    const text = readFileSync(path, "utf8");
    expect(text.startsWith("[ui]\nyolo = false\n\n")).toBe(true);
    expect(parseToml(text)).toMatchObject({
      ui: { yolo: false },
      mcp_servers: { sondine: { command: RELAY, env: { SONDINE_TOKEN: TOKEN } } },
    });
    removeSondineEntries(home, grok, ["sondine"]);
    expect(readFileSync(path, "utf8")).toBe("[ui]\nyolo = false\n");
  });

  it("keeps the comments that sit above the next table", () => {
    const text = `[mcp_servers.sondine]\ncommand = "/old"\nenv = { SONDINE_TOKEN = "sdn_old" }\n\n# Why yolo is off.\n[ui]\nyolo = false\n`;
    const path = place(grok.file, text);
    removeSondineEntries(home, grok, ["sondine"]);
    expect(readFileSync(path, "utf8")).toBe("# Why yolo is off.\n[ui]\nyolo = false\n");
  });

  it("replaces a link where the copy goes, rather than writing through it", () => {
    const path = place(grok.file, GROK);
    const elsewhere = place("elsewhere.txt", "keep me");
    symlinkSync(elsewhere, `${path}${BACKUP_SUFFIX}`);
    writeSondineEntry(home, grok, "sondine", entry(TOKEN));
    expect(readFileSync(elsewhere, "utf8")).toBe("keep me");
    expect(lstatSync(`${path}${BACKUP_SUFFIX}`).isSymbolicLink()).toBe(false);
    expect(readFileSync(`${path}${BACKUP_SUFFIX}`, "utf8")).toBe(GROK);
  });

  it("creates the file when Grok has none, readable by this user only", () => {
    mkdirSync(join(home, ".grok"));
    const written = writeSondineEntry(home, grok, "sondine", entry(TOKEN));
    expect(written.backup).toBeNull();
    expect(statSync(written.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(written.path, "utf8")).toBe(
      `${TOML_MARKER}\n${tomlEntry("sondine", entry(TOKEN))}`,
    );
  });

  it("leaves a server of that name that is not Sondine's", () => {
    const text = `${GROK}\n[mcp_servers.sondine]\ncommand = "/usr/local/bin/other"\n`;
    const path = place(grok.file, text);
    expect(thrown(() => writeSondineEntry(home, grok, "sondine", entry(TOKEN))).problem).toBe(
      "taken",
    );
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(existsSync(`${path}${BACKUP_SUFFIX}`)).toBe(false);
  });

  it("refuses an edit that would change anything else, and a file it cannot read", () => {
    const inline = `[mcp_servers]\nsondine = { command = "x", env = { SONDINE_TOKEN = "sdn_a" } }\n`;
    const path = place(grok.file, inline);
    expect(thrown(() => writeSondineEntry(home, grok, "sondine", entry(TOKEN))).problem).toBe(
      "unsafe",
    );
    expect(thrown(() => removeSondineEntries(home, grok, ["sondine"])).problem).toBe("unsafe");
    expect(readFileSync(path, "utf8")).toBe(inline);

    place(grok.file, "[cli\n");
    expect(thrown(() => readSondineEntries(home, grok)).problem).toBe("unreadable");
    place(grok.file, "mcp_servers = 3\n");
    expect(thrown(() => readSondineEntries(home, grok)).problem).toBe("unreadable");
  });

  it("writes through a symbolic link, which stays a link", () => {
    const target = place("dotfiles/grok.toml", GROK);
    mkdirSync(join(home, ".grok"));
    symlinkSync(target, join(home, grok.file));
    writeSondineEntry(home, grok, "sondine", entry(TOKEN));
    expect(lstatSync(join(home, grok.file)).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("[mcp_servers.sondine]");
  });

  it("quotes what TOML needs quoted", () => {
    const odd = 'a "b" \\ c\u0001';
    expect(parseToml(`x = ${tomlString(odd)}`)).toEqual({ x: odd });
    const table = tomlEntry("Sondine Exp", {
      command: odd,
      args: ["--socket", "/tmp/s"],
      token: TOKEN,
    });
    expect(parseToml(table)).toEqual({
      mcp_servers: {
        "Sondine Exp": {
          command: odd,
          args: ["--socket", "/tmp/s"],
          env: { SONDINE_TOKEN: TOKEN },
        },
      },
    });
  });
});

describe("Claude's JSON file", () => {
  it("keeps its other settings and servers, and its permissions", () => {
    const before = {
      preferences: { menuBarEnabled: true },
      mcpServers: { pencil: { command: "/Applications/Pen.app/mcp", args: ["--x"], env: {} } },
    };
    const path = place(claude.file, JSON.stringify(before), 0o600);
    writeSondineEntry(home, claude, "sondine", entry(TOKEN));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      ...before,
      mcpServers: {
        ...before.mcpServers,
        sondine: { command: RELAY, args: [], env: { SONDINE_TOKEN: TOKEN } },
      },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}${BACKUP_SUFFIX}`).mode & 0o777).toBe(0o600);
    removeSondineEntries(home, claude, ["sondine"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(before);
  });

  it("is left alone when it is not a JSON object", () => {
    place(claude.file, "[]");
    expect(thrown(() => writeSondineEntry(home, claude, "sondine", entry(TOKEN))).problem).toBe(
      "unreadable",
    );
  });
});

describe("the server's name", () => {
  it("follows the spelling of a Sondine server Grok also reads, so its own replaces it", () => {
    expect(serverNameFor(home, grok, "sondine")).toEqual({ name: "sondine", replaces: null });
    place(".claude.json", JSON.stringify({ mcpServers: { Sondine: { command: "node" } } }));
    expect(serverNameFor(home, grok, "sondine")).toEqual({
      name: "Sondine",
      replaces: join(home, ".claude.json"),
    });
    expect(serverNameFor(home, claude, "sondine")).toEqual({ name: "sondine", replaces: null });
  });
});
