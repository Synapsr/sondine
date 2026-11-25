import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkBundles, checkScript } from "../scripts/check-bundles.ts";
import { builtFiles, readBuilt, SCRIPTS } from "./bundled.ts";
import { BUILDS } from "./global-setup.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
/** Paths of the machine that built it, which no script may name. */
const localPaths = [homedir(), packageDir, realpathSync(packageDir)];

describe("bundle", () => {
  it("makes each entry one classic script that reaches no network, in every build", () => {
    for (const { name } of BUILDS) {
      const scripts = builtFiles(name).filter((file) => file.endsWith(".js"));
      expect(scripts).toEqual(Object.values(SCRIPTS).toSorted());
      for (const file of scripts) {
        const code = readBuilt(name, file);
        expect(() => checkScript(file, code)).not.toThrow();
        // Only types come from the protocol: zod stays out of the extension.
        expect(code).not.toMatch(/zod|@sondine\/protocol/);
        // Readable output: anyone can check what the extension does.
        expect(code.split("\n").length).toBeGreaterThan(100);
        for (const path of localPaths) expect(code).not.toContain(path);
      }
    }
  });

  it("refuses a module, a network call, or code loading", () => {
    expect(() => checkScript("module", "export const a = 1;")).toThrow(SyntaxError);
    expect(() => checkScript("module", 'import "./a.js";')).toThrow(SyntaxError);
    expect(() => checkScript("fetch", 'fetch("https://example.com/");')).toThrow(/fetch/);
    expect(() => checkScript("socket", 'new WebSocket("ws://a");')).toThrow(/WebSocket/);
    expect(() => checkScript("import", 'import("https://a/b.js");')).toThrow(/import/);
  });

  it("fails a build whose folder holds such a script, wherever it is", () => {
    const dir = mkdtempSync(join(tmpdir(), "sondine-extension-check-"));
    try {
      writeFileSync(join(dir, "background.js"), "void 0;");
      checkBundles(dir);
      mkdirSync(join(dir, "chunks"));
      writeFileSync(join(dir, "chunks", "a.js"), 'fetch("https://example.com/");');
      expect(() => checkBundles(dir)).toThrow(/chunks\/a\.js calls fetch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
