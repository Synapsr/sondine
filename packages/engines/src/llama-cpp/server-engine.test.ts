import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineError, type TextEngine, type TextRequest } from "../contract.ts";
import { createLlamaServerEngine } from "./server-engine.ts";

const fake = fileURLToPath(new URL("../../test/fake-llama-server.ts", import.meta.url));

let dir: string;
let engines: TextEngine[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sdn-llama-"));
  writeFileSync(join(dir, "model.gguf"), "weights");
  engines = [];
});
afterEach(async () => {
  await Promise.all(engines.map((engine) => engine.unload()));
  rmSync(dir, { recursive: true, force: true });
});

function serverEngine(scenario: string, deadlines: Record<string, number> = {}): TextEngine {
  const created = createLlamaServerEngine({
    manifest: {
      id: "fake",
      version: "1",
      runtime: "llama.cpp test",
      adapterClass: "product",
      stages: ["textgen"],
      artifacts: [],
    },
    capabilities: {
      languages: ["fr"],
      contextTokens: 4_096,
      maxOutputTokens: 1_024,
      schemaConstrained: true,
      locality: "device",
    },
    resources: {
      peakBytesBase: 0,
      peakBytesPerAudioHour: 0,
      coldLoadMs: 0,
      unloadLatencyMs: 200,
      computeUnits: ["cpu"],
    },
    executable: process.execPath,
    executableArgs: [fake, "--scenario", scenario, "--log", join(dir, "log.jsonl")],
    weights: join(dir, "model.gguf"),
    modelSha256: "abc",
    socketPath: join(dir, "s.sock"),
    deadlines: { healthPollMs: 20, unloadGraceMs: 500, ...deadlines },
  });
  engines.push(created);
  return created;
}

const request: TextRequest = {
  id: "r1",
  system: "instructions",
  user: "transcript",
  schema: { type: "object" },
  maxOutputTokens: 256,
};

const logged = () =>
  existsSync(join(dir, "log.jsonl"))
    ? readFileSync(join(dir, "log.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { event: string; body?: Record<string, unknown>; argv?: string[] },
        )
    : [];

describe("llama-server engine", () => {
  it("loads once healthy, streams an answer held to the schema, and unloads", async () => {
    const text = serverEngine("normal");
    expect(text.state()).toBe("absent");
    const result = await text.generate(request);
    expect(JSON.parse(result.text)).toEqual({
      journal: [{ text: "On a parlé du budget.", cite: [1] }],
      commitments: [],
    });
    expect(result).toMatchObject({
      requestId: "r1",
      stop: "complete",
      metrics: { promptTokens: 42, promptMs: 21, generateMs: 30 },
      provenance: { engineId: "fake", modelSha256: "abc", config: { temperature: 0 } },
    });
    expect(text.state()).toBe("ready");
    const sent = logged().find((entry) => entry.event === "request")?.body;
    expect(sent).toMatchObject({
      temperature: 0,
      max_tokens: 256,
      stream: true,
      response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } },
      messages: [
        { role: "system", content: "instructions" },
        { role: "user", content: "transcript" },
      ],
    });
    const argv = logged().find((entry) => entry.event === "start")?.argv ?? [];
    expect(argv).toEqual(expect.arrayContaining(["--host", join(dir, "s.sock"), "--no-webui"]));
    expect(argv.some((arg) => arg === "-hf" || arg === "--connect")).toBe(false);
    await text.unload();
    expect(text.state()).toBe("absent");
    expect(text.pid()).toBeUndefined();
    expect(existsSync(join(dir, "s.sock"))).toBe(false);
  });

  it("reports an answer cut by its output limit", async () => {
    const result = await serverEngine("length").generate(request);
    expect(result.stop).toBe("length");
  });

  it("refuses with a fixed reason, keeping the server", async () => {
    const text = serverEngine("refuse");
    const error = await text.generate(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({ code: "rejected", reason: "context-exceeded" });
    expect(text.state()).toBe("ready");
  });

  it("cancels a request when its signal aborts, closing the connection", async () => {
    const text = serverEngine("slow");
    // Loaded first: an abort during the load cancels before any request.
    await text.load();
    const controller = new AbortController();
    const pending = text.generate(request, { signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(logged().some((entry) => entry.event === "client-gone")).toBe(true);
  });

  it("fails a request when the server dies under it", async () => {
    const text = serverEngine("crash-in-request");
    await expect(text.generate(request)).rejects.toMatchObject({ code: "crashed" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(text.state()).toBe("absent");
  });

  it("fails a load that never becomes healthy, and one whose server exits", async () => {
    await expect(serverEngine("never-ready", { readyMs: 300 }).load()).rejects.toMatchObject({
      code: "deadline",
    });
    await expect(serverEngine("exit-at-start").load()).rejects.toMatchObject({
      code: "load_failed",
    });
  });

  it("kills a server that ignores SIGTERM once the unload grace is over", async () => {
    const text = serverEngine("ignore-sigterm");
    await text.load();
    const started = Date.now();
    await text.unload();
    expect(text.state()).toBe("absent");
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
  });
});
