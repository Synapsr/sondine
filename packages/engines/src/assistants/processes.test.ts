import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assistantEnvironment,
  findExecutable,
  makeLocator,
  parseLoginOutput,
} from "./processes.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sondine-processes-test-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MARKER = "__sondine_login_environment__";

describe("assistant processes", () => {
  it("reads the login shell's values between its markers, whatever the shell printed around them", () => {
    const output = `Welcome!\n${MARKER}PATH=/opt/homebrew/bin:/usr/bin\0LANG=fr_FR.UTF-8\0CLAUDE_CONFIG_DIR=/Users/t/.config/claude\0CODEX_HOME=\0SECRET=x\0${MARKER}bye`;
    expect(parseLoginOutput(output)).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      LANG: "fr_FR.UTF-8",
      CLAUDE_CONFIG_DIR: "/Users/t/.config/claude",
    });
    expect(parseLoginOutput("no markers")).toEqual({});
  });

  it("gives the CLIs an allowlisted environment: never an API key", () => {
    const env = assistantEnvironment(
      {
        HOME: "/Users/t",
        USER: "t",
        PATH: "/usr/bin:relative",
        ANTHROPIC_API_KEY: "sk-ant",
        OPENAI_API_KEY: "sk-oai",
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--inspect",
      },
      { PATH: "/Users/t/.local/bin:/usr/bin", CLAUDE_CONFIG_DIR: "/Users/t/.config/claude" },
    );
    expect(env).toEqual({
      HOME: "/Users/t",
      USER: "t",
      CLAUDE_CONFIG_DIR: "/Users/t/.config/claude",
      PATH: "/Users/t/.local/bin:/usr/bin:/opt/homebrew/bin:/usr/local/bin:/Users/t/.npm-global/bin",
    });
  });

  it("finds an executable on PATH, and asks the interactive shell only when one is missing", async () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\n");
    chmodSync(join(bin, "claude"), 0o755);
    writeFileSync(join(bin, "notes"), "");
    expect(await findExecutable("claude", { PATH: `/nowhere:${bin}` })).toBe(join(bin, "claude"));
    expect(await findExecutable("notes", { PATH: bin })).toBeNull();

    const asked: boolean[] = [];
    const locator = makeLocator({
      names: ["claude"],
      inherited: { HOME: dir },
      readShell: async (_shell, options = {}) => {
        asked.push(options.interactive === true);
        return options.interactive === true ? { PATH: bin } : { PATH: "/nowhere" };
      },
    });
    expect((await locator.locate("claude")).executable).toBe(join(bin, "claude"));
    expect(asked).toEqual([false, true]);
    // Remembered until a refresh.
    await locator.locate("claude");
    expect(asked).toEqual([false, true]);
    locator.refresh();
    await locator.locate("claude");
    expect(asked).toEqual([false, true, false, true]);
  });
});
