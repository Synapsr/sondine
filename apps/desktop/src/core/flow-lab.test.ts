import { afterEach, describe, expect, it } from "vitest";
import type { CoreConfigShape } from "./config";
import { claudeLocator, labCoreOptions, labSettings, loopbackFetch } from "./flow-lab";

const lab = {
  cloud: { endpoint: "http://127.0.0.1:8790", key: "server-key" },
  offline: false,
  update: "0.12.1",
  agent: { executable: "/lab/bin/claude", mode: "signed-out" },
} as const;

const config = (blocked: "development" | null) =>
  ({ updates: { blocked, testFeed: null } }) as unknown as CoreConfigShape;

afterEach(() => {
  delete process.env["SONDINE_FLOW_LAB"];
});

describe("the flow lab in core", () => {
  it("is read only by a development build, and only when main hands it over", () => {
    expect(labSettings(config("development"))).toBeNull();
    process.env["SONDINE_FLOW_LAB"] = JSON.stringify(lab);
    expect(labSettings(config(null))).toBeNull();
    expect(labSettings(config("development"))).toEqual(lab);
  });

  it("reaches nothing but this Mac", async () => {
    await expect(loopbackFetch("https://cloud.sondine.app/v1/hello")).rejects.toThrow("no network");
    await expect(loopbackFetch("https://github.com/Synapsr/sondine")).rejects.toThrow();
    await expect(loopbackFetch("https://huggingface.co/x")).rejects.toThrow();
  });

  it("finds the lab's update, and none offline", async () => {
    const answer = await labCoreOptions(lab, "0.11.0").updates?.ask?.(new AbortController().signal);
    expect(answer).toMatchObject({ ok: true, feed: { version: "0.12.1" } });
    const offline = await labCoreOptions({ ...lab, offline: true }, "0.11.0").updates?.ask?.(
      new AbortController().signal,
    );
    expect(offline).toEqual({ ok: false, problem: "network" });
  });

  it("points the Cloud at the lab's, or at a closed port offline", () => {
    expect(labCoreOptions(lab, "0.11.0").compute?.beta).toEqual({
      endpoint: "http://127.0.0.1:8790",
      serverKey: "server-key",
    });
    expect(labCoreOptions({ ...lab, offline: true }, "0.11.0").compute?.beta?.endpoint).toBe(
      "http://127.0.0.1:9",
    );
  });

  it("starts the fake claude in the lab, in the step's mode", async () => {
    process.env["SONDINE_FLOW_LAB"] = JSON.stringify(lab);
    const located = await claudeLocator(config("development")).locate();
    expect(located.executable).toBe("/lab/bin/claude");
    expect(located.env["FAKE_CLAUDE_MODE"]).toBe("signed-out");
    process.env["SONDINE_FLOW_LAB"] = JSON.stringify({
      ...lab,
      agent: { executable: null, mode: "normal" },
    });
    expect((await claudeLocator(config("development")).locate()).executable).toBeNull();
  });
});
