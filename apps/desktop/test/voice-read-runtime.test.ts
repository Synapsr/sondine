import { chmodSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, SubscriptionRef } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Api } from "../src/core/api-services";
import { Database } from "../src/core/database";
import { makeCoreRuntime, type CoreRuntime } from "../src/core/runtime";
import { CoreState } from "../src/core/status/core-state";
import { VoiceRead } from "../src/core/voices/voice-read";
import type { CoreToMain } from "../src/shared/core-messages";
import { DATA_LAYOUT } from "../src/shared/data-layout";
import { startFakeHelper, type FakeHelper } from "./fake-helper/fake-helper";
import { recordingMain, tempDataDir, waitUntil, type TempDataDir } from "./support";

// The user's voice read (ADR 034) through the real core runtime and the fake
// helper: the always-on microphone pauses while the user reads and resumes
// after, the stored intent never moves, the recording's file is deleted once
// embedded, and only the embedding is kept, for the user.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A `sondine-voice` that answers one embedding for the read. */
function fakeVoiceTool(dir: string, delaySeconds = 0): string {
  const path = join(dir, "fake-sondine-voice");
  const embedding = Array.from({ length: 256 }, (_, index) => (index === 0 ? 1 : 0));
  const answer = JSON.stringify({
    modelVersion: "wespeaker-v2:test",
    speakers: [{ key: "read", embedding, speechMs: 12_000 }],
    errors: [],
  });
  writeFileSync(path, `#!/bin/sh\ncat > /dev/null\nsleep ${delaySeconds}\necho '${answer}'\n`);
  chmodSync(path, 0o755);
  return path;
}

/** 16 kHz PCM16: `seconds` of a loud tone in 2 s sentences with short pauses. */
function readAloud(path: string, seconds: number) {
  const samples = new Int16Array(seconds * 16_000);
  for (let index = 0; index < samples.length; index++) {
    const inPause = index % 32_000 > 28_000;
    samples[index] = inPause
      ? 0
      : Math.round(8_000 * Math.sin((2 * Math.PI * 220 * index) / 16_000));
  }
  writeFileSync(path, Buffer.from(samples.buffer));
}

async function launch(data: TempDataDir, { embedSeconds = 0 } = {}) {
  const fake = await startFakeHelper({ socketPath: data.socketPath, autoplay: null });
  cleanups.push(() => fake.close());
  const main = recordingMain();
  const runtime = makeCoreRuntime(
    data.config({
      voiceReadDir: join(data.dir, DATA_LAYOUT.voiceReadDir),
      voiceTool: { binary: fakeVoiceTool(data.dir, embedSeconds), model: "unused" },
    }),
    main,
    {
      helper: { helloTimeoutMs: 1_000, requestTimeoutMs: 2_000, incompatibleRetryMs: 200 },
      spans: { flushEvery: "1 seconds" },
      models: { homeDir: data.dir },
      onboarding: { skipFirstRun: true },
    },
  );
  cleanups.push(() => runtime.dispose());
  const api = await runtime.runPromise(Api);
  const read = await runtime.runPromise(VoiceRead);
  await waitUntil(async () => (await listening(runtime)).effective === "listening", {
    label: "listening",
  });
  return { fake, main, runtime, api, read };
}

const listening = async (runtime: CoreRuntime) =>
  (
    await runtime.runPromise(
      Effect.flatMap(CoreState, (state) => SubscriptionRef.get(state.status)),
    )
  ).listening;

const scalar = async (runtime: CoreRuntime, sql: string) => {
  const [row] = await runtime.runPromise(Effect.map(Database, (db) => db.statement(sql).all()));
  return row === undefined ? undefined : Object.values(row)[0];
};

const lastOf = <T extends CoreToMain["type"]>(posted: readonly CoreToMain[], type: T) =>
  posted.findLast((message): message is Extract<CoreToMain, { type: T }> => message.type === type);

const micPauses = (fake: FakeHelper) =>
  fake.received
    .filter((message) => message.type === "pause" || message.type === "resume")
    .map((message) => `${message.type} ${"scope" in message ? String(message.scope) : ""}`);

describe("the voice read", () => {
  it("records with the always-on microphone paused, keeps the embedding and deletes the file", async () => {
    const data = tempDataDir();
    cleanups.push(() => data.cleanup());
    const { fake, main, runtime, api, read } = await launch(data);

    const started = await api.voiceRead.start({ selfName: "Moi" });
    expect(started.session.phase).toBe("recording");
    expect(micPauses(fake)).toContain("pause microphone");
    // The pause is the read's: the user's intent still listens.
    expect((await listening(runtime)).desired).toBe("listening");
    const record = lastOf(main.posted, "voice-read-record");
    if (record === undefined) throw new Error("no recording asked");
    expect(record.path.startsWith(join(data.dir, DATA_LAYOUT.voiceReadDir))).toBe(true);

    readAloud(record.path, 14);
    read.level(record.readId, 5_000, 0.2);
    await waitUntil(async () => (await api.voiceRead.get()).session.voicedMs === 5_000, {
      label: "counter",
    });

    const finishing = api.voiceRead.finish();
    await waitUntil(() => lastOf(main.posted, "voice-read-stop")?.readId === record.readId, {
      label: "stop asked",
    });
    read.ended(record.readId, true, null);
    const done = await finishing;
    expect(done.session.phase).toBe("done");
    expect(done.read).toMatchObject({ speechMs: 12_000, person: { name: "Moi", self: true } });
    expect(existsSync(record.path)).toBe(false);
    expect(readdirSync(join(data.dir, DATA_LAYOUT.voiceReadDir))).toEqual([]);
    expect(micPauses(fake).at(-1)).toBe("resume microphone");
    expect(await scalar(runtime, "SELECT count(*) FROM voice_reads")).toBe(1);
    // Nothing of it is a memory.
    expect(await scalar(runtime, "SELECT count(*) FROM episodes")).toBe(0);

    const forgotten = await api.voiceRead.forget();
    expect(forgotten.read).toBeNull();
    expect(await scalar(runtime, "SELECT count(*) FROM voice_reads")).toBe(0);
  });

  it("keeps nothing when cancelled, and gives the microphone back", async () => {
    const data = tempDataDir();
    cleanups.push(() => data.cleanup());
    const { fake, main, runtime, api, read } = await launch(data);
    await api.voiceRead.start({ selfName: "Moi" });
    const record = lastOf(main.posted, "voice-read-record");
    if (record === undefined) throw new Error("no recording asked");
    readAloud(record.path, 14);
    const cancelling = api.voiceRead.cancel();
    await waitUntil(() => lastOf(main.posted, "voice-read-stop") !== undefined, {
      label: "stop asked",
    });
    read.ended(record.readId, true, null);
    expect((await cancelling).session.phase).toBe("idle");
    expect(existsSync(record.path)).toBe(false);
    expect(micPauses(fake).at(-1)).toBe("resume microphone");
    expect(await scalar(runtime, "SELECT count(*) FROM voice_reads")).toBe(0);
    expect(await scalar(runtime, "SELECT count(*) FROM people")).toBe(0);
  });

  it("fails, and can start again, when the recorder left no file", async () => {
    const data = tempDataDir();
    cleanups.push(() => data.cleanup());
    const { fake, main, api, read } = await launch(data);
    await api.voiceRead.start({ selfName: "Moi" });
    const record = lastOf(main.posted, "voice-read-record");
    if (record === undefined) throw new Error("no recording asked");
    const finishing = api.voiceRead.finish();
    await waitUntil(() => lastOf(main.posted, "voice-read-stop") !== undefined, {
      label: "stop asked",
    });
    read.ended(record.readId, true, null);
    expect((await finishing).session).toMatchObject({ phase: "failed", failure: "failed" });
    expect(micPauses(fake).at(-1)).toBe("resume microphone");
    expect((await api.voiceRead.start({ selfName: "Moi" })).session.phase).toBe("recording");
    const again = lastOf(main.posted, "voice-read-record");
    if (again === undefined) throw new Error("no second recording asked");
    const cancelling = api.voiceRead.cancel();
    await waitUntil(() => lastOf(main.posted, "voice-read-stop")?.readId === again.readId, {
      label: "second stop",
    });
    read.ended(again.readId, true, null);
    await cancelling;
  });

  it("keeps nothing when cancelled while it embeds", async () => {
    const data = tempDataDir();
    cleanups.push(() => data.cleanup());
    const { main, runtime, api, read } = await launch(data, { embedSeconds: 1 });
    await api.voiceRead.start({ selfName: "Moi" });
    const record = lastOf(main.posted, "voice-read-record");
    if (record === undefined) throw new Error("no recording asked");
    readAloud(record.path, 14);
    const finishing = api.voiceRead.finish();
    await waitUntil(() => lastOf(main.posted, "voice-read-stop") !== undefined, {
      label: "stop asked",
    });
    read.ended(record.readId, true, null);
    await waitUntil(async () => (await api.voiceRead.get()).session.phase === "embedding", {
      label: "embedding",
    });
    const cancelled = api.voiceRead.cancel();
    expect((await finishing).session.phase).toBe("idle");
    expect((await cancelled).session.phase).toBe("idle");
    expect(await scalar(runtime, "SELECT count(*) FROM voice_reads")).toBe(0);
    expect(existsSync(record.path)).toBe(false);
  });

  it("stops and keeps nothing when recognition is turned off during the read", async () => {
    const data = tempDataDir();
    cleanups.push(() => data.cleanup());
    const { fake, main, runtime, api, read } = await launch(data);
    await api.voiceRead.start({ selfName: "Moi" });
    const record = lastOf(main.posted, "voice-read-record");
    if (record === undefined) throw new Error("no recording asked");
    readAloud(record.path, 14);
    await api.people.setRecognition({ on: false });
    await waitUntil(() => lastOf(main.posted, "voice-read-stop") !== undefined, {
      label: "stop asked",
    });
    read.ended(record.readId, true, null);
    await waitUntil(async () => (await api.voiceRead.get()).session.phase === "idle", {
      label: "idle",
    });
    await api.people.setRecognition({ on: true });
    expect(await scalar(runtime, "SELECT count(*) FROM voice_reads")).toBe(0);
    expect(existsSync(record.path)).toBe(false);
    await waitUntil(() => micPauses(fake).at(-1) === "resume microphone", { label: "resumed" });
  });

  it("offers nothing while voices are not recognized", async () => {
    const data = tempDataDir();
    cleanups.push(() => data.cleanup());
    const { fake, main, api } = await launch(data);
    await api.people.setRecognition({ on: false });
    const refused = await api.voiceRead.start({ selfName: "Moi" });
    expect(refused).toMatchObject({
      recognition: false,
      session: { phase: "failed", failure: "recognition-off" },
    });
    expect(lastOf(main.posted, "voice-read-record")).toBeUndefined();
    expect(micPauses(fake)).not.toContain("pause microphone");
  });
});
