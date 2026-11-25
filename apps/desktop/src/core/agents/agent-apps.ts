import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";

// Apps on this Mac that Sondine connects by itself (ADR 011, amended
// 2026-11-12): it writes one MCP server entry into the app's own config file,
// naming the relay and holding the app's key, and takes that entry back when
// the key is revoked. Every other server and setting of the file stays as it
// was, and the file as it was before each write is kept beside it.

export type AgentAppId = "grok" | "claude" | "cursor";

export interface KnownAgentApp {
  readonly id: AgentAppId;
  /** The name its key takes in Settings ▸ Agents. */
  readonly name: string;
  /** A folder under the home folder that exists once the app was installed and opened. */
  readonly marker: string;
  /** Its config file, under the home folder. */
  readonly file: string;
  readonly format: "toml" | "json";
  /**
   * Other files, under the home folder, the app also loads `mcpServers` from;
   * a server there with the name of one in its own file gives way to it.
   */
  readonly alsoReads: readonly string[];
}

/**
 * Read on their Macs (2026-11-12): Grok (the Grok Bot app and the `grok` CLI
 * share `~/.grok`) declares `[mcp_servers.<name>]` with `command`, `args` and
 * `env`, and also loads `~/.claude.json` and `~/.cursor/mcp.json`, its own
 * file winning for a name spelled the same; Claude (the desktop app) and
 * Cursor declare `mcpServers` in JSON with the same three fields.
 */
export const KNOWN_AGENT_APPS: readonly KnownAgentApp[] = [
  {
    id: "grok",
    name: "Grok",
    marker: ".grok",
    file: ".grok/config.toml",
    format: "toml",
    alsoReads: [".claude.json", ".cursor/mcp.json"],
  },
  {
    id: "claude",
    name: "Claude",
    marker: "Library/Application Support/Claude",
    file: "Library/Application Support/Claude/claude_desktop_config.json",
    format: "json",
    alsoReads: [],
  },
  {
    id: "cursor",
    name: "Cursor",
    marker: ".cursor",
    file: ".cursor/mcp.json",
    format: "json",
    alsoReads: [],
  },
];

/** The relay an entry starts and the key it gives it. */
export interface RelayEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly token: string;
}

/** A server of an app's file that holds a Sondine key. */
export interface SondineEntry {
  readonly name: string;
  readonly token: string;
}

/**
 * Why Sondine leaves an app's file alone: it cannot read it (`unreadable`), a
 * server of that name is not Sondine's (`taken`), editing it would change
 * something else (`unsafe`), or the disk refused (`unwritable`).
 */
export type AppConfigProblem = "unreadable" | "taken" | "unsafe" | "unwritable";

export class AppConfigError extends Error {
  override readonly name = "AppConfigError";
  constructor(
    readonly problem: AppConfigProblem,
    message: string,
  ) {
    super(message);
  }
}

/** The line Sondine writes above its TOML entry. */
export const TOML_MARKER =
  "# Sondine: Settings ▸ Agents wrote this server and removes it when its key is revoked.";
/** The copy of the file as it was before Sondine's last write. */
export const BACKUP_SUFFIX = ".sondine-backup";

type Table = Record<string, unknown>;

const isTable = (value: unknown): value is Table =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

const serversKey = (app: KnownAgentApp) => (app.format === "toml" ? "mcp_servers" : "mcpServers");

/** `/Users/me/.grok/config.toml` → `~/.grok/config.toml`. */
export function displayPath(home: string, path: string): string {
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function installedAgentApps(home: string): KnownAgentApp[] {
  return KNOWN_AGENT_APPS.filter((app) => existsSync(join(home, app.marker)));
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new AppConfigError("unreadable", `Cannot read ${path}.`);
  }
}

function parseDoc(app: KnownAgentApp, text: string | null): Table {
  if (text === null || text.trim() === "") return {};
  let doc: unknown;
  try {
    doc = app.format === "toml" ? parseToml(text) : JSON.parse(text);
  } catch {
    throw new AppConfigError("unreadable", `${app.file} is not valid ${app.format}.`);
  }
  if (!isTable(doc)) throw new AppConfigError("unreadable", `${app.file} is not a table.`);
  const servers = doc[serversKey(app)];
  if (servers !== undefined && !isTable(servers)) {
    throw new AppConfigError("unreadable", `${serversKey(app)} in ${app.file} is not a table.`);
  }
  return doc;
}

const serversOf = (app: KnownAgentApp, doc: Table): Table => {
  const servers = doc[serversKey(app)];
  return isTable(servers) ? servers : {};
};

/** The Sondine key a server holds, if it is a Sondine server. */
export function tokenOf(server: unknown): string | null {
  if (!isTable(server) || !isTable(server["env"])) return null;
  const token = server["env"]["SONDINE_TOKEN"];
  return typeof token === "string" && token.startsWith("sdn_") ? token : null;
}

export function readSondineEntries(home: string, app: KnownAgentApp): SondineEntry[] {
  const doc = parseDoc(app, readText(join(home, app.file)));
  return Object.entries(serversOf(app, doc)).flatMap(([name, server]) => {
    const token = tokenOf(server);
    return token === null ? [] : [{ name, token }];
  });
}

/**
 * The name Sondine's entry takes in this app: `base`, or the spelling a file
 * the app also reads gives a server of that name (any case), so that the
 * app's own entry replaces it rather than adding a second Sondine.
 */
export function serverNameFor(
  home: string,
  app: KnownAgentApp,
  base: string,
): { readonly name: string; readonly replaces: string | null } {
  for (const file of app.alsoReads) {
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(join(home, file), "utf8"));
    } catch {
      continue;
    }
    if (!isTable(doc) || !isTable(doc["mcpServers"])) continue;
    const name = Object.keys(doc["mcpServers"]).find(
      (key) => key.toLowerCase() === base.toLowerCase(),
    );
    if (name !== undefined) return { name, replaces: join(home, file) };
  }
  return { name: base, replaces: null };
}

// TOML: Sondine edits the text, so comments and every other line stay as the
// user or the app wrote them, then checks the result parses to the same
// document with only its own server changed.

/** A TOML basic string. */
export function tomlString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '"') out += '\\"';
    else if (char === "\\") out += "\\\\";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return `${out}"`;
}

const tomlKey = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key));

/** One server as a TOML table, the way Sondine writes it and shows it to copy. */
export function tomlEntry(name: string, entry: RelayEntry): string {
  return [
    `[mcp_servers.${tomlKey(name)}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(", ")}]`,
    `env = { SONDINE_TOKEN = ${tomlString(entry.token)} }`,
    "",
  ].join("\n");
}

/** One server as `mcpServers` JSON holds it. */
export function jsonEntry(entry: RelayEntry) {
  return { command: entry.command, args: [...entry.args], env: { SONDINE_TOKEN: entry.token } };
}

const HEADER = /^\s*\[\[?\s*(.+?)\s*\]\]?\s*(?:#.*)?$/;

/** The dotted key of a table header, or null when it is not one Sondine can read. */
function keyPath(raw: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  const skipSpace = () => {
    while (raw[i] === " " || raw[i] === "\t") i += 1;
  };
  while (i < raw.length) {
    skipSpace();
    if (raw[i] === '"') {
      let end = i + 1;
      while (end < raw.length && raw[end] !== '"') end += raw[end] === "\\" ? 2 : 1;
      if (end >= raw.length) return null;
      try {
        const part: unknown = JSON.parse(raw.slice(i, end + 1));
        if (typeof part !== "string") return null;
        parts.push(part);
      } catch {
        return null;
      }
      i = end + 1;
    } else if (raw[i] === "'") {
      const end = raw.indexOf("'", i + 1);
      if (end < 0) return null;
      parts.push(raw.slice(i + 1, end));
      i = end + 1;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(raw.slice(i));
      if (bare === null) return null;
      parts.push(bare[0]);
      i += bare[0].length;
    }
    skipSpace();
    if (i < raw.length) {
      if (raw[i] !== ".") return null;
      i += 1;
    }
  }
  return parts;
}

/** Blank and comment lines. */
const NOTE = /^\s*(?:#.*)?$/;

/**
 * The comments that end a removed table's lines: they sit right above the
 * next table and belong to it.
 */
function notesAbove(lines: readonly string[]): string[] {
  let start = lines.length;
  while (start > 0 && NOTE.test(lines[start - 1] ?? "")) start -= 1;
  while (start < lines.length && (lines[start] ?? "").trim() === "") start += 1;
  return lines.slice(start);
}

/** The text without the tables of these servers (and Sondine's line above them). */
export function withoutTomlServers(text: string, names: ReadonlySet<string>): string {
  const kept: string[] = [];
  let dropped: string[] = [];
  let inside = false;
  let separated = false;
  for (const line of text.split("\n")) {
    const header = HEADER.exec(line);
    if (header !== null) {
      const path = keyPath(header[1] ?? "");
      const ours = path !== null && path.length >= 2 && path[0] === "mcp_servers";
      const removed = ours && names.has(path[1] ?? "");
      if (removed && !inside) {
        while (kept.at(-1)?.trimEnd() === TOML_MARKER) kept.pop();
        separated = false;
        while (kept.length > 0 && kept.at(-1)?.trim() === "") {
          kept.pop();
          separated = true;
        }
      } else if (!removed && inside) {
        if (separated && kept.length > 0) kept.push("");
        kept.push(...notesAbove(dropped));
      }
      inside = removed;
      dropped = [];
    }
    if (inside) dropped.push(line);
    else kept.push(line);
  }
  const out = kept.join("\n");
  return out !== "" && text.endsWith("\n") && !out.endsWith("\n") ? `${out}\n` : out;
}

/** A parsed document as plain values (the parser's tables have no prototype). */
function plain(value: unknown): unknown {
  if (value instanceof Date) return { date: value.toISOString() };
  if (typeof value === "bigint") return { integer: value.toString() };
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, plain(inner)]));
  }
  return value;
}

/** Throws `unsafe` unless `next` parses to `expected`. */
function checkToml(app: KnownAgentApp, next: string, expected: Table): void {
  let actual: unknown;
  try {
    actual = parseToml(next);
  } catch {
    throw new AppConfigError("unsafe", `Sondine's edit would break ${app.file}.`);
  }
  const servers = expected["mcp_servers"];
  if (isTable(servers) && Object.keys(servers).length === 0 && isTable(actual)) {
    if (!("mcp_servers" in actual)) delete expected["mcp_servers"];
  }
  if (!isDeepStrictEqual(plain(actual), plain(expected))) {
    throw new AppConfigError(
      "unsafe",
      `Sondine's edit would change more than its server in ${app.file}.`,
    );
  }
}

// Files: the text goes to a new temporary file renamed over the real one (a
// symbolic link at the path keeps pointing at it), with the same permissions,
// and only if the file still holds what Sondine read: an app saving it
// meanwhile makes Sondine start over from its version. The text it replaces
// is copied beside the path the app reads, the same way.

/** The file changed between Sondine's read and its write. */
class FileMoved extends Error {}

/** Writes `text` to a temporary file only this call created, next to `target`. */
function freshFile(target: string, text: string, mode: number): string {
  const temporary = `${target}.sondine-${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, text, { mode, flag: "wx" });
  chmodSync(temporary, mode);
  return temporary;
}

function replaceFile(path: string, text: string, previous: string | null): string | null {
  const real = existsSync(path) ? realpathSync(path) : path;
  let temporary: string | null = null;
  try {
    mkdirSync(dirname(real), { recursive: true });
    const mode = previous === null ? 0o600 : statSync(real).mode & 0o777;
    temporary = freshFile(real, text, mode);
    if (readText(real) !== previous) throw new FileMoved();
    let backup: string | null = null;
    if (previous !== null) {
      backup = `${path}${BACKUP_SUFFIX}`;
      renameSync(freshFile(backup, previous, mode), backup);
    }
    renameSync(temporary, real);
    temporary = null;
    return backup;
  } catch (error) {
    if (error instanceof FileMoved || error instanceof AppConfigError) throw error;
    throw new AppConfigError("unwritable", `Cannot write ${path}.`);
  } finally {
    if (temporary !== null && existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Reads, edits and writes the file, again from the app's version if it saved meanwhile. */
function editFile(
  path: string,
  edit: (previous: string | null) => string | null,
): WriteOutcome | null {
  for (let attempt = 1; ; attempt += 1) {
    const previous = readText(path);
    const next = edit(previous);
    if (next === null) return null;
    try {
      return { path, backup: replaceFile(path, next, previous) };
    } catch (error) {
      if (!(error instanceof FileMoved)) throw error;
      if (attempt === 3) throw new AppConfigError("unwritable", `${path} keeps changing.`);
    }
  }
}

export interface WriteOutcome {
  readonly path: string;
  /** The copy of the file before this write; null when the file was new. */
  readonly backup: string | null;
}

/**
 * Writes Sondine's server under `name`, replacing a Sondine server of that
 * name and removing the Sondine servers named in `replacing`; refuses
 * (`taken`) when a server of that name is not Sondine's.
 */
export function writeSondineEntry(
  home: string,
  app: KnownAgentApp,
  name: string,
  entry: RelayEntry,
  replacing: readonly string[] = [],
): WriteOutcome {
  const path = join(home, app.file);
  const written = editFile(path, (previous) => {
    const doc = parseDoc(app, previous);
    const servers = serversOf(app, doc);
    const existing = servers[name];
    if (existing !== undefined && tokenOf(existing) === null) {
      throw new AppConfigError("taken", `${app.file} already has a server named ${name}.`);
    }
    const gone = replacing.filter((other) => other !== name && tokenOf(servers[other]) !== null);
    if (app.format === "json") {
      const remaining: Table = { ...servers };
      for (const other of gone) delete remaining[other];
      remaining[name] = jsonEntry(entry);
      doc["mcpServers"] = remaining;
      return `${JSON.stringify(doc, null, 2)}\n`;
    }
    const base = withoutTomlServers(previous ?? "", new Set([name, ...gone])).replace(/\s+$/, "");
    const next = `${base === "" ? "" : `${base}\n\n`}${TOML_MARKER}\n${tomlEntry(name, entry)}`;
    const remaining: Table = { ...servers };
    for (const other of gone) delete remaining[other];
    remaining[name] = {
      command: entry.command,
      args: [...entry.args],
      env: { SONDINE_TOKEN: entry.token },
    };
    doc["mcp_servers"] = remaining;
    checkToml(app, next, doc);
    return next;
  });
  if (written === null) throw new AppConfigError("unwritable", `Nothing to write to ${path}.`);
  return written;
}

/** Removes these Sondine servers; null when the file holds none of them. */
export function removeSondineEntries(
  home: string,
  app: KnownAgentApp,
  names: readonly string[],
): WriteOutcome | null {
  return editFile(join(home, app.file), (previous) => {
    const doc = parseDoc(app, previous);
    const remaining: Table = { ...serversOf(app, doc) };
    const present = names.filter((name) => tokenOf(remaining[name]) !== null);
    if (previous === null || present.length === 0) return null;
    for (const name of present) delete remaining[name];
    doc[serversKey(app)] = remaining;
    if (app.format === "json") return `${JSON.stringify(doc, null, 2)}\n`;
    const next = withoutTomlServers(previous, new Set(present));
    checkToml(app, next, doc);
    return next;
  });
}
