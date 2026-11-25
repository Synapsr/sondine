import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLAUDE_LOCKED_ARGUMENTS } from "./claude.ts";
import { claudeTextArguments, createClaudeTextEngine } from "./claude-text.ts";

// The journal's Claude engine against test/fake-claude.ts, started through a
// small shell launcher as the real `claude` would be.

const fake = resolve(import.meta.dirname, "../../test/fake-claude.ts");
let dir: string;
let launcher: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sondine-claude-text-test-"));
  launcher = join(dir, "claude");
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(launcher, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const engine = (mode: string, extra: Record<string, string> = {}) =>
  createClaudeTextEngine({
    locate: async () => ({
      executable: launcher,
      env: { PATH: process.env["PATH"] ?? "", HOME: dir, FAKE_CLAUDE_MODE: mode, ...extra },
    }),
    model: "haiku",
    effort: "low",
    workDirectory: dir,
    requestDeadlineMs: 5_000,
  });

const request = {
  id: "journal-1-0",
  system: "Sort the commitments.",
  user: "[1] 10:00 P1: je t'envoie le devis demain",
  schema: { type: "object", properties: { count: { type: "integer" } } },
  maxOutputTokens: 512,
};

describe("the journal on the user's Claude", () => {
  it("runs the CLI locked down, with the instructions, the schema and the model", () => {
    const args = claudeTextArguments({ model: "haiku", effort: null }, request);
    expect(args.slice(0, CLAUDE_LOCKED_ARGUMENTS.length)).toEqual([...CLAUDE_LOCKED_ARGUMENTS]);
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(value("--tools")).toBe("");
    expect(value("--mcp-config")).toBe('{"mcpServers":{}}');
    expect(value("--system-prompt")).toBe("Sort the commitments.");
    expect(JSON.parse(value("--json-schema") ?? "")).toEqual(request.schema);
    expect(args).not.toContain("--effort");
    // What was said goes as the message, never as an argument.
    expect(args.join(" ")).not.toContain("devis");
  });

  it("answers with the structured output, its tokens and the model that wrote it", async () => {
    const record = join(dir, "record.json");
    const result = await engine("text", { FAKE_CLAUDE_RECORD: record }).generate(request);
    expect(JSON.parse(result.text)).toEqual({ count: request.user.length });
    expect(result.stop).toBe("complete");
    expect(result.metrics).toMatchObject({ promptTokens: 42, outputTokens: 7, computeMs: 1_200 });
    expect(result.provenance.config).toEqual({ model: "claude-haiku-test", effort: "low" });
    const recorded = JSON.parse(readFileSync(record, "utf8")) as { args: string[]; cwd: string };
    expect(recorded.args).toContain("--json-schema");
    expect(realpathSync(recorded.cwd)).toBe(realpathSync(dir));
  });

  it("stops a request when the CLI offers another tool or server, answers oddly, or refuses it", async () => {
    for (const mode of ["rogue", "server", "odd-block"]) {
      await expect(engine(mode).generate(request)).rejects.toMatchObject({
        code: "rejected",
        reason: "tool",
      });
    }
    await expect(engine("signed-out").generate(request)).rejects.toMatchObject({
      code: "rejected",
    });
  });

  it("sends nothing when cancelled or unloaded while the CLI is being found", async () => {
    const record = join(dir, "record-cancelled.json");
    let release = () => undefined as void;
    const slow = createClaudeTextEngine({
      locate: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          executable: launcher,
          env: {
            PATH: process.env["PATH"] ?? "",
            HOME: dir,
            FAKE_CLAUDE_MODE: "text",
            FAKE_CLAUDE_RECORD: record,
          },
        };
      },
      model: "haiku",
      effort: null,
      workDirectory: dir,
    });
    const controller = new AbortController();
    const pending = slow.generate(request, { signal: controller.signal });
    controller.abort();
    release();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    const unloaded = slow.generate(request);
    await slow.unload();
    release();
    await expect(unloaded).rejects.toMatchObject({ code: "cancelled" });
    expect(existsSync(record)).toBe(false);
  });

  it("ends the CLI when the request is cancelled", async () => {
    const stubborn = engine("stubborn");
    const controller = new AbortController();
    const pending = stubborn.generate(request, { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(stubborn.state()).toBe("ready");
    expect(stubborn.pid()).toBeUndefined();
  });
});
