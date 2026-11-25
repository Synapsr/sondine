import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLAUDE_LOCKED_ARGUMENTS,
  claudeSessionArguments,
  createClaudeProvider,
  versionAtLeast,
} from "./claude.ts";
import type { AssistantEvent, AssistantSessionOptions } from "./contract.ts";

// The Claude adapter against test/fake-claude.ts, started through a small
// shell launcher as the real `claude` would be.

const fake = resolve(import.meta.dirname, "../../test/fake-claude.ts");
let dir: string;
let launcher: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sondine-claude-test-"));
  launcher = join(dir, "claude");
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(launcher, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const provider = (mode: string, extra: Record<string, string> = {}) =>
  createClaudeProvider({
    locate: async () => ({
      executable: launcher,
      env: { PATH: process.env["PATH"] ?? "", HOME: dir, FAKE_CLAUDE_MODE: mode, ...extra },
    }),
    detectTimeoutMs: 5_000,
  });

const session = (tools = true): AssistantSessionOptions => ({
  model: "opus",
  effort: "low",
  instructions: "You are Sondine's assistant.",
  workingDirectory: dir,
  tools: tools
    ? {
        server: {
          name: "sondine",
          command: "/A/sondine-mcp",
          args: [],
          env: { SONDINE_TOKEN: "sdc_secret" },
        },
        names: ["search_transcripts", "get_episode"],
      }
    : null,
});

/** Runs one message; the events until the turn or the session ends. */
async function turn(
  mode: string,
  text: string,
  options: { interruptAfterMs?: number; extra?: Record<string, string> } = {},
) {
  const events: AssistantEvent[] = [];
  const open = provider(mode, options.extra).open(session(), (event) => events.push(event));
  open.send(text);
  if (options.interruptAfterMs !== undefined) {
    setTimeout(() => open.interrupt(), options.interruptAfterMs);
  }
  for (let waited = 0; waited < 8_000; waited += 10) {
    if (
      events.some((e) => e.type === "turn-ended" || e.type === "turn-failed" || e.type === "failed")
    )
      break;
    await new Promise((wait) => setTimeout(wait, 10));
  }
  // A late `failed` after an interrupt.
  await new Promise((wait) => setTimeout(wait, 30));
  await open.close();
  return events;
}

// Each test starts real processes: a loaded Mac needs more than vitest's 5 s.
describe("Claude adapter", { timeout: 30_000 }, () => {
  it("runs the CLI with nothing of the user's: no tool, setting, hook, command or session on disk", () => {
    const args = claudeSessionArguments(session());
    for (const flag of [
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
    ]) {
      expect(args).toContain(flag);
    }
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--permission-prompts") + 1]).toBe("none");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(
      "mcp__sondine__search_transcripts,mcp__sondine__get_episode",
    );
    // The relay's key never reaches the command line.
    expect(args.join(" ")).not.toContain("sdc_secret");
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1]!)).toEqual({
      mcpServers: { sondine: { type: "stdio", command: "/A/sondine-mcp", args: [] } },
    });
    expect(CLAUDE_LOCKED_ARGUMENTS).toContain("--no-session-persistence");
  });

  it("says who is signed in and which models exist", async () => {
    const status = await provider("normal").detect();
    expect(status).toMatchObject({
      provider: "claude",
      state: "ready",
      version: "2.1.400",
      home: `${dir}/.claude`,
      account: { email: "teo@example.com", plan: "Claude Max", billing: "subscription" },
    });
    // `default` is an alias of Opus: Opus is kept, as the default.
    expect(
      status.models.map((model) => [model.id, model.efforts, model.defaultEffort, model.isDefault]),
    ).toEqual([
      ["opus", ["low", "medium", "high"], "high", true],
      ["haiku", [], null, false],
    ]);
    expect((await provider("signed-out").detect()).state).toBe("signed-out");
    expect((await provider("old").detect()).state).toBe("unsupported");
    const missing = createClaudeProvider({ locate: async () => ({ executable: null, env: {} }) });
    expect((await missing.detect()).state).toBe("missing");
  });

  it("streams an answer with its tool call, and hands the key to the CLI's environment only", async () => {
    const record = join(dir, "record.json");
    const events = await turn("normal", "Quand doit-on se rappeler ?", {
      extra: { FAKE_CLAUDE_RECORD: record },
    });
    expect(events.filter((e) => e.type !== "text")).toEqual([
      {
        type: "tool-started",
        callId: "toolu_1",
        tool: "search_transcripts",
        input: { text: "Quand doit-on se rap" },
      },
      { type: "tool-ended", callId: "toolu_1", ok: true },
      { type: "turn-ended", reason: "complete" },
    ]);
    const text = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
    expect(text).toBe("Vous devez rappeler jeudi.");
    const seen = JSON.parse(readFileSync(record, "utf8")) as {
      token: string;
      args: string[];
      cwd: string;
    };
    expect(seen.token).toBe("sdc_secret");
    expect(seen.args.join(" ")).not.toContain("sdc_secret");
  });

  it("stops a session that offers another tool or an unknown kind of content", async () => {
    for (const mode of ["rogue", "odd-block"]) {
      const events = await turn(mode, "hello");
      expect(events.at(-1), mode).toMatchObject({
        type: "failed",
        failure: { code: "refused-tool" },
      });
    }
  });

  it("stops a turn on interrupt, and ends a CLI that does not stop", async () => {
    const stopped = await turn("normal", "hello", { interruptAfterMs: 1 });
    expect(stopped.find((e) => e.type === "turn-ended")).toEqual({
      type: "turn-ended",
      reason: "interrupted",
    });
    const stubborn = await turn("stubborn", "hello", { interruptAfterMs: 50 });
    expect(
      stubborn.filter((e) => e.type === "turn-ended" || e.type === "failed").map((e) => e.type),
    ).toEqual(["turn-ended", "failed"]);
  });

  it("says when the CLI is signed out", async () => {
    const events = await turn("signed-out", "hello");
    expect(events.at(-1)).toMatchObject({ type: "turn-failed", failure: { code: "signed-out" } });
  });

  it("compares versions", () => {
    expect(versionAtLeast("2.1.319", "2.1.319")).toBe(true);
    expect(versionAtLeast("2.10.0", "2.1.319")).toBe(true);
    expect(versionAtLeast("2.1.300", "2.1.319")).toBe(false);
    expect(versionAtLeast("unknown", "2.1.319")).toBe(false);
  });
});
