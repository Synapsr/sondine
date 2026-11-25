import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODELS_HOME_RELATIVE, installVadModel, modelsDirectory } from "./models-directory";

let dir: string;
let bundled: string;
let models: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sondine-models-"));
  bundled = join(dir, "bundle", "silero_vad.onnx");
  mkdirSync(join(dir, "bundle"));
  writeFileSync(bundled, "model v6.2");
  models = join(dir, "models");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const target = () => join(models, "silero-vad", "silero_vad.onnx");

describe("models directory", () => {
  it("is the home-relative folder the helper's read-only exception names", () => {
    expect(modelsDirectory("/Users/t")).toBe("/Users/t/Library/Application Support/Sondine/models");
    expect(MODELS_HOME_RELATIVE).toBe("Library/Application Support/Sondine/models");
  });

  it("copies the bundled model on first launch", () => {
    expect(installVadModel(bundled, models)).toEqual({ ok: true, path: target(), copied: true });
    expect(readFileSync(target(), "utf8")).toBe("model v6.2");
  });

  it("keeps a copy whose content matches", () => {
    installVadModel(bundled, models);
    const before = statSync(target()).mtimeMs;
    expect(installVadModel(bundled, models)).toEqual({ ok: true, path: target(), copied: false });
    expect(statSync(target()).mtimeMs).toBe(before);
  });

  it("replaces an older or damaged copy", () => {
    installVadModel(bundled, models);
    writeFileSync(target(), "model v5");
    expect(installVadModel(bundled, models)).toMatchObject({ ok: true, copied: true });
    expect(readFileSync(target(), "utf8")).toBe("model v6.2");
  });

  it("reports a missing bundled model instead of throwing", () => {
    rmSync(bundled);
    expect(installVadModel(bundled, models)).toMatchObject({ ok: false });
  });
});
