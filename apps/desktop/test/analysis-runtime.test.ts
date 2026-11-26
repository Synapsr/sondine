import { MessageChannel } from "node:worker_threads";
import { createORPCClient, ORPCError, safe } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { AppClient } from "@sondine/api";
import { checkSearchIndex, openDatabase } from "@sondine/db";
import { Effect, SubscriptionRef } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Api } from "../src/core/api-services";
import { Exports } from "../src/core/exports";
import { EpisodeMedia, mediaReplyMessage } from "../src/core/audio/episode-media";
import type { CoreConfigShape } from "../src/core/config";
import { Database } from "../src/core/database";
import { RpcHost } from "../src/core/rpc-host";
import { makeCoreRuntime, type CoreLayerOptions, type CoreRuntime } from "../src/core/runtime";
import { CoreState } from "../src/core/status/core-state";
import { createMediaRelay, handleMediaRequest, type MediaRelay } from "../src/main/media-protocol";
import { APP_ORIGIN } from "../src/main/url-guard";
import { CoreToMain, MainToCore } from "../src/shared/core-messages";
import {
  engineLayer,
  fakeEngine,
  fakeSignals,
  regionAudioLayer,
  straySpeechWorker,
  type FakeEngine,
} from "./fake-engine";
import { startFakeHelper, type FakeHelper } from "./fake-helper/fake-helper";
import {
  captureOptions,
  migrationsDir,
  recordingMain,
  tempDataDir,
  waitUntil,
  type TempDataDir,
} from "./support";

// The transcription pipeline through the real core runtime: the fake helper
// streams capture events over its socket, core groups them into episodes,
// queues the analysis, runs a fake engine on synthesized audio, publishes,
// and serves the result through the API.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const fastTiming = {
  admissionIntervalMs: 30,
  idleUnloadMs: 150,
  rssIntervalMs: 30,
  noModelPollMs: 30,
};

interface Started {
  readonly runtime: CoreRuntime;
  /** What core posted to main. */
  readonly posted: readonly CoreToMain[];
  dispose(): Promise<void>;
}

function startCore(
  data: TempDataDir,
  fake: FakeHelper,
  analysis: NonNullable<CoreLayerOptions["analysis"]>,
  config: Partial<CoreConfigShape> = {},
): Started {
  const main = recordingMain();
  const runtime = makeCoreRuntime(data.config(config), main, {
    ...captureOptions(data),
    helper: { helloTimeoutMs: 1_000, requestTimeoutMs: 2_000, incompatibleRetryMs: 200 },
    spans: { flushEvery: "1 seconds" },
    analysis: {
      timing: fastTiming,
      audio: regionAudioLayer,
      dictationHome: null,
      ...analysis,
    },
    episodes: { now: () => fake.wallNowMs(), intervalMs: 30, debounceMs: 10 },
  });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await runtime.dispose();
  };
  cleanups.push(dispose);
  return { runtime, posted: main.posted, dispose };
}

async function helper(data: TempDataDir) {
  const fake = await startFakeHelper({
    socketPath: data.socketPath,
    autoplay: null,
    virtualClock: true,
  });
  cleanups.push(() => fake.close());
  return fake;
}

function setup() {
  const data = tempDataDir();
  cleanups.push(() => data.cleanup());
  return data;
}

const status = (runtime: CoreRuntime) =>
  runtime.runPromise(Effect.flatMap(CoreState, (state) => SubscriptionRef.get(state.status)));

const rows = (runtime: CoreRuntime, sql: string) =>
  runtime.runPromise(Effect.map(Database, (db) => db.statement(sql).all()));

const scalar = async (runtime: CoreRuntime, sql: string) => {
  const [row] = await rows(runtime, sql);
  return row === undefined ? undefined : Object.values(row)[0];
};

/** Connected, and the snapshot's replay of the open mic run imported: events now land in it. */
const connected = async (runtime: CoreRuntime) => {
  await waitUntil(async () => (await status(runtime)).helper.connection === "connected", {
    label: "helper connection",
  });
  await waitUntil(async () => (await scalar(runtime, "SELECT count(*) FROM track_runs")) === 1, {
    label: "mic run imported",
  });
};

/**
 * One speech region on the mic (0.25 s to 5.875 s), then 50 s of silence:
 * past the in-person gap, with the mic imported past it too.
 */
async function speakThenWait(fake: FakeHelper) {
  for (let i = 0; i < 3; i++) fake.tick();
  for (let i = 0; i < 25; i++) fake.tick({ speech: false });
}

const pad2 = (value: number) => String(value).padStart(2, "0");

const localDay = (ms: number) => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
};

describe("transcription pipeline in the core runtime", () => {
  it("groups, transcribes, publishes, and finds the word at the time it was said", async () => {
    const data = setup();
    const fake = await helper(data);
    const engine = fakeEngine();
    const signals = fakeSignals();
    const { runtime } = startCore(data, fake, {
      engine: engineLayer(() => engine),
      signals: signals.layer,
    });
    await connected(runtime);
    await speakThenWait(fake);

    await waitUntil(async () => (await scalar(runtime, "SELECT count(*) FROM segments")) === 1, {
      label: "published segment",
      timeoutMs: 10_000,
    });
    const services = await runtime.runPromise(Api);
    const found = await services.search.query({ text: "sondine", limit: 20, offset: 0 });
    expect(found).toMatchObject({ total: 1, untranscribed: 0 });
    // In person: no voice is the user's, so the voices keep their own numbers.
    expect(found.episodes[0]?.selfOrdinal).toBeNull();
    const hits = found.episodes[0]?.hits ?? [];
    expect(hits).toHaveLength(1);
    const [region] = await rows(runtime, "SELECT wall_start_ms, wall_end_ms FROM speech_regions");
    expect(hits[0]?.startMs).toBe(region?.["wall_start_ms"]);
    expect(hits[0]?.text).toBe("Bonjour Sondine");
    expect(hits[0]?.highlights).toEqual([{ start: 8, end: 15 }]);
    // Accents and case do not matter.
    expect(
      (await services.search.query({ text: "BONJOUR", limit: 5, offset: 0 })).episodes,
    ).toHaveLength(1);

    const episodeId = found.episodes[0]?.episode.id ?? 0;
    const highlighted = await services.episodes.get({ episodeId, q: "bonjour" });
    expect(highlighted.segments.map((segment) => segment.highlights)).toEqual([
      [{ start: 0, end: 7 }],
    ]);
    const detail = await services.episodes.get({ episodeId });
    expect(detail.segments.map((segment) => segment.highlights)).toEqual([[]]);
    expect(detail.episode).toMatchObject({
      state: "closed",
      context: "in_person",
      size: "moment",
      sizeProvisional: false,
      analysisState: "complete",
      firstWords: "Bonjour Sondine",
      speakerCount: 1,
    });
    expect(detail.episode.apps).toEqual([]);
    // In person: no speaker is marked as the user (only a call's mic is).
    expect(detail.speakers).toEqual([
      {
        label: "input:BuiltInMicrophoneDevice/1/1",
        ordinal: 1,
        voicedMs: expect.any(Number),
        trackKind: "input",
        self: false,
        person: null,
        recognized: null,
        suggestion: null,
      },
    ]);
    expect(detail.segments.map((segment) => segment.self)).toEqual([false]);
    expect(detail.tracks).toEqual([
      expect.objectContaining({ trackKey: "input:BuiltInMicrophoneDevice", kind: "input" }),
    ]);
    expect(detail.analysis).toMatchObject({ engineId: "fake-asr", coverage: 1 });

    const listed = await services.episodes.list({
      day: localDay(detail.episode.startedAtMs),
      limit: 10,
    });
    expect(listed.episodes.map((episode) => episode.id)).toContain(episodeId);
    const day = await services.episodes.day({ day: localDay(detail.episode.startedAtMs) });
    const hour = new Date(detail.episode.startedAtMs).getHours();
    expect(day.momentHours).toEqual([
      expect.objectContaining({
        hour,
        moments: 1,
        untranscribed: 0,
        previews: [{ episodeId, firstWords: "Bonjour Sondine" }],
      }),
    ]);
    expect(day).toMatchObject({ conversations: { total: 0 }, media: { total: 0 }, traces: 0 });

    // One request with roll: the region from its start (clamped at 0) to its end + 0.8 s.
    expect(engine.requests).toHaveLength(1);
    expect(engine.requests[0]?.samples.length).toBe(94_000 + 12_800);
    const [run] = await rows(runtime, "SELECT metrics, coverage FROM analysis_runs");
    const metrics = JSON.parse(String(run?.["metrics"])) as Record<string, unknown>;
    expect(metrics).toMatchObject({ audioMs: 6_675, coverage: 1, loadMs: 5, requests: 1 });

    // The queue is empty: the worker unloads after its idle delay.
    await waitUntil(async () => (await status(runtime)).analysis.worker === "absent", {
      label: "idle unload",
    });
    expect((await status(runtime)).analysis).toMatchObject({
      queued: { requested: 0, conversations: 0, moments: 0, media: 0, traces: 0 },
      running: null,
      waitingFor: [],
      waitingEpisodeId: null,
      server: null,
      requests: [],
      retryAtMs: null,
      lastError: null,
    });
    await runtime.runPromise(Effect.map(Database, (db) => checkSearchIndex(db)));
  });

  it("deletes an episode for good: its text, its index rows, and its audio", async () => {
    const data = setup();
    const fake = await helper(data);
    const engine = fakeEngine();
    const { runtime } = startCore(data, fake, {
      engine: engineLayer(() => engine),
      signals: fakeSignals().layer,
    });
    await connected(runtime);
    await speakThenWait(fake);
    await waitUntil(async () => (await scalar(runtime, "SELECT count(*) FROM segments")) === 1, {
      label: "published segment",
      timeoutMs: 10_000,
    });
    const services = await runtime.runPromise(Api);
    const found = await services.search.query({ text: "sondine", limit: 20, offset: 0 });
    const episodeId = found.episodes[0]?.episode.id ?? 0;

    await expect(services.episodes.delete({ episodeId })).resolves.toEqual({ deleted: true });
    await expect(services.episodes.get({ episodeId })).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(services.episodes.playback({ episodeId })).rejects.toMatchObject({
      code: "not-found",
    });
    expect((await services.search.query({ text: "sondine", limit: 20, offset: 0 })).total).toBe(0);
    expect(await scalar(runtime, "SELECT count(*) FROM segments")).toBe(0);
    expect(await scalar(runtime, "SELECT count(*) FROM speech_regions")).toBe(0);
    expect(await scalar(runtime, "SELECT count(*) FROM deleted_ranges")).toBeGreaterThan(0);
    expect(
      Number(await scalar(runtime, "SELECT count(*) FROM chunks WHERE audio_state = 'deleted'")),
    ).toBeGreaterThan(0);
    // Asking again is harmless.
    await expect(services.episodes.delete({ episodeId })).resolves.toEqual({ deleted: false });
  });

  it("exports an episode's audio through main, never over oRPC", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime, posted } = startCore(data, fake, {
      engine: engineLayer(() => fakeEngine()),
      signals: fakeSignals().layer,
    });
    await connected(runtime);
    await speakThenWait(fake);
    // While the speech is still open, there is nothing to export yet.
    await waitUntil(
      async () =>
        (await scalar(runtime, "SELECT count(*) FROM episodes WHERE ended_at_ms IS NOT NULL")) ===
        1,
      { label: "episode" },
    );
    const services = await runtime.runPromise(Api);
    const episodeId = Number(await scalar(runtime, "SELECT id FROM episodes"));

    const exported = services.episodes.exportAudio({ episodeId });
    const request = await waitUntil(
      () =>
        posted.find(
          (message): message is Extract<CoreToMain, { type: "export-audio" }> =>
            message.type === "export-audio",
        ),
      { label: "export request" },
    );
    expect(request).toMatchObject({ episodeId, generation: 1 });
    expect(request.fileName).toMatch(/^Sondine \d{4}-\d{2}-\d{2} \d{2}-\d{2}\.wav$/);
    (await runtime.runPromise(Exports)).receive(request.requestId, "saved");
    await expect(exported).resolves.toEqual({ outcome: "saved" });
    await expect(services.episodes.exportAudio({ episodeId: 999 })).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("hands a transcript to main for the clipboard or a file, never for a deleted episode", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime, posted } = startCore(data, fake, {
      engine: engineLayer(() => fakeEngine()),
      signals: fakeSignals().layer,
    });
    await connected(runtime);
    await speakThenWait(fake);
    await waitUntil(async () => (await scalar(runtime, "SELECT count(*) FROM episodes")) === 1, {
      label: "episode",
    });
    const services = await runtime.runPromise(Api);
    const exports = await runtime.runPromise(Exports);
    const episodeId = Number(await scalar(runtime, "SELECT id FROM episodes"));
    const go = (requestId: string) =>
      waitUntil(() =>
        posted.find(
          (message): message is Extract<CoreToMain, { type: "export-go" }> =>
            message.type === "export-go" && message.requestId === requestId,
        ),
      ).then((message) => message.go);
    const textRequest = (destination: "file" | "clipboard") =>
      waitUntil(() =>
        posted.find(
          (message): message is Extract<CoreToMain, { type: "export-text" }> =>
            message.type === "export-text" && message.destination === destination,
        ),
      );

    const copied = services.episodes.exportText({
      episodeIds: [episodeId],
      format: "md",
      destination: "clipboard",
      text: "# Transcript\n",
      deletionsSeen: 0,
    });
    const copy = await textRequest("clipboard");
    expect(copy.text).toBe("# Transcript\n");
    exports.confirm(copy.requestId);
    await expect(go(copy.requestId)).resolves.toBe(true);
    exports.receive(copy.requestId, "copied");
    await expect(copied).resolves.toEqual({ outcome: "copied" });
    // A window that read the episode before a deletion is refused at once.
    await expect(
      services.episodes.exportText({
        episodeIds: [episodeId],
        format: "md",
        destination: "clipboard",
        text: "x",
        deletionsSeen: 3,
      }),
    ).resolves.toEqual({ outcome: "stale" });

    const saved = services.episodes.exportText({
      episodeIds: [episodeId],
      format: "srt",
      destination: "file",
      text: "1\n00:00:00,000 --> 00:00:01,000\nMe: hi\n",
      deletionsSeen: 0,
    });
    const file = await textRequest("file");
    expect(file.fileName).toMatch(/^Sondine \d{4}-\d{2}-\d{2} \d{2}-\d{2}\.srt$/);
    // Deleted while the save panel was open: main is told not to write.
    await services.episodes.delete({ episodeId });
    exports.confirm(file.requestId);
    await expect(go(file.requestId)).resolves.toBe(false);
    exports.receive(file.requestId, "stale");
    await expect(saved).resolves.toEqual({ outcome: "stale" });

    await expect(
      services.episodes.exportText({
        episodeIds: [episodeId],
        format: "md",
        destination: "clipboard",
        text: "x",
        deletionsSeen: 1,
      }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("corrects a segment's text: the transcript and search read it, a stale version is refused", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = startCore(data, fake, {
      engine: engineLayer(() => fakeEngine()),
      signals: fakeSignals().layer,
    });
    await connected(runtime);
    await speakThenWait(fake);
    await waitUntil(async () => (await scalar(runtime, "SELECT count(*) FROM segments")) === 1, {
      label: "published segment",
      timeoutMs: 10_000,
    });
    const services = await runtime.runPromise(Api);
    const episodeId = Number(await scalar(runtime, "SELECT id FROM episodes"));
    const before = await services.episodes.get({ episodeId });
    const runId = before.analysis?.runId ?? 0;
    const segmentId = before.segments[0]?.id ?? 0;

    await expect(
      services.transcript.edit({ episodeId, runId: runId + 1, segmentId, text: "x" }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      services.transcript.edit({ episodeId, runId, segmentId: segmentId + 99, text: "x" }),
    ).rejects.toMatchObject({ code: "not-found" });

    await services.transcript.edit({ episodeId, runId, segmentId, text: "Corrigé par Téo" });
    const after = await services.episodes.get({ episodeId });
    expect(after.segments[0]).toMatchObject({ text: "Corrigé par Téo", edited: true });
    const hits = await services.search.query({ text: "corrigé", limit: 20, offset: 0 });
    expect(hits.total).toBe(1);

    await services.transcript.restore({ episodeId, runId, segmentId });
    expect((await services.episodes.get({ episodeId })).segments[0]).toMatchObject({
      text: before.segments[0]?.text,
      edited: false,
    });
  });

  it("names a voice: the name reads in the transcript, search and people, until deleted", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = startCore(data, fake, {
      engine: engineLayer(() => fakeEngine()),
      signals: fakeSignals().layer,
    });
    await connected(runtime);
    await speakThenWait(fake);
    await waitUntil(async () => (await scalar(runtime, "SELECT count(*) FROM segments")) === 1, {
      label: "published segment",
      timeoutMs: 10_000,
    });
    const services = await runtime.runPromise(Api);
    const episodeId = Number(await scalar(runtime, "SELECT id FROM episodes"));
    const before = await services.episodes.get({ episodeId });
    const [voice] = before.speakers;
    const runId = before.analysis?.runId ?? 0;
    expect(voice?.person).toBeNull();

    const target = { episodeId, runId, label: voice?.label ?? "" };
    const { person } = await services.speakers.name({
      ...target,
      person: { kind: "new", name: "Marie" },
    });
    expect(person).toMatchObject({ name: "Marie", self: false });
    const after = await services.episodes.get({ episodeId });
    expect(after.speakers[0]?.person).toEqual(person);
    const hits = await services.search.query({ text: "sondine", limit: 20, offset: 0 });
    expect(hits.episodes[0]?.hits[0]?.person).toEqual(person);
    expect((await services.people.list()).people).toEqual([
      { person, episodeCount: 1, lastHeardMs: after.episode.startedAtMs, recognizedCount: 0 },
    ]);
    expect(
      (await services.people.get({ personId: person.id, limit: 200 })).episodes.map((e) => e.id),
    ).toEqual([episodeId]);
    await expect(
      services.speakers.name({
        ...target,
        runId: runId + 1,
        person: { kind: "self", name: "Moi" },
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });

    await expect(
      services.people.rename({ personId: person.id, name: "Marie C." }),
    ).resolves.toEqual({
      ...person,
      name: "Marie C.",
    });
    await expect(services.people.delete({ personId: person.id })).resolves.toEqual({
      deleted: true,
    });
    expect((await services.episodes.get({ episodeId })).speakers[0]?.person).toBeNull();
    await expect(services.people.get({ personId: person.id, limit: 200 })).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("forgets the last minutes: lists what goes, then erases it with a tombstone", async () => {
    const data = setup();
    const fake = await helper(data);
    const engine = fakeEngine();
    const { runtime } = startCore(data, fake, {
      engine: engineLayer(() => engine),
      signals: fakeSignals().layer,
    });
    await connected(runtime);
    await speakThenWait(fake);
    await waitUntil(async () => (await scalar(runtime, "SELECT count(*) FROM segments")) === 1, {
      label: "published segment",
      timeoutMs: 10_000,
    });
    const services = await runtime.runPromise(Api);
    const preview = await services.episodes.forgetPreview({ minutes: 5 });
    expect(preview.toMs - preview.fromMs).toBe(5 * 60_000);
    expect(preview.episodes).toHaveLength(1);

    const episodeId = preview.episodes[0]?.id ?? 0;
    await expect(services.episodes.forget({ minutes: 5, untilMs: preview.toMs })).resolves.toEqual({
      episodeIds: [episodeId],
    });
    expect((await services.search.query({ text: "sondine", limit: 20, offset: 0 })).total).toBe(0);
    expect(await scalar(runtime, "SELECT count(*) FROM episodes")).toBe(0);
    expect(await scalar(runtime, "SELECT count(*) FROM deleted_ranges WHERE scope = 'all'")).toBe(
      1,
    );
    expect((await services.episodes.forgetPreview({ minutes: 5 })).episodes).toEqual([]);
    // A range confirmed over an hour ago is refused.
    await expect(
      services.episodes.forget({ minutes: 5, untilMs: preview.toMs - 2 * 60 * 60_000 }),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("keeps the last 2 minutes: the recording heard then shows « Gardé à » and keeps its audio", async () => {
    const data = setup();
    const fake = await helper(data);
    const engine = fakeEngine();
    const { runtime } = startCore(data, fake, {
      engine: engineLayer(() => engine),
      signals: fakeSignals().layer,
    });
    await connected(runtime);
    await speakThenWait(fake);
    await waitUntil(async () => (await scalar(runtime, "SELECT count(*) FROM segments")) === 1, {
      label: "published segment",
      timeoutMs: 10_000,
    });
    const services = await runtime.runPromise(Api);
    const episodeId = Number(await scalar(runtime, "SELECT id FROM episodes"));
    const kept = await services.episodes.keepRecent();
    expect(kept).toMatchObject({ outcome: "kept", episodeIds: [episodeId] });
    if (kept.outcome !== "kept") throw new Error("nothing kept");
    expect(kept.keptMs).toBeGreaterThan(0);
    expect(kept.keptMs).toBeLessThanOrEqual(2 * 60_000);
    const detail = await services.episodes.get({ episodeId });
    expect(detail.episode.keptAtMs).toBe(kept.atMs);
    expect(detail.privacy.kept).toBe(true);
    expect(
      await scalar(runtime, "SELECT count(*) FROM kept_audio WHERE origin = 'moment'"),
    ).toBeGreaterThan(0);
    // Windows read their recordings again, the menu bar's gesture included.
    expect((await status(runtime)).kept).toBe(1);
  });

  it("plays an episode back through the media scheme, by byte ranges, never over oRPC", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = startCore(data, fake, {
      engine: engineLayer(() => null),
      signals: fakeSignals().layer,
    });
    await connected(runtime);
    await speakThenWait(fake);
    await waitUntil(
      async () => (await scalar(runtime, "SELECT state FROM episodes")) === "closed",
      {
        label: "closed episode",
      },
    );
    const episodeId = Number(await scalar(runtime, "SELECT id FROM episodes"));

    // The renderer's transport, with every message core posts recorded.
    const channel = new MessageChannel();
    const posted: unknown[] = [];
    const post = channel.port1.postMessage.bind(channel.port1);
    channel.port1.postMessage = (message, transfer) => {
      posted.push(message);
      post(message, transfer);
    };
    (await runtime.runPromise(RpcHost)).attach(channel.port1, "test");
    channel.port2.start();
    cleanups.push(() => {
      channel.port1.close();
      channel.port2.close();
    });
    const client: AppClient = createORPCClient(new RPCLink({ port: channel.port2 }));

    const playback = await client.episodes.playback({ episodeId });
    // The region (0.25 s to 5.875 s) with roll: from the run's start to 6.675 s.
    expect(playback).toMatchObject({
      src: `sondine-media://episode/${episodeId}?g=1`,
      durationMs: 6_675,
      generation: 1,
    });
    // No audio crossed the port: no bytes, no long text.
    expect(posted.some((message) => message instanceof Uint8Array)).toBe(false);
    expect(posted.every((message) => typeof message !== "string" || message.length < 1_000)).toBe(
      true,
    );

    // Main's handler relaying to core's media service, each message through
    // the channel's schemas and a structured clone, as on process.parentPort.
    const media = await runtime.runPromise(EpisodeMedia);
    const relay: MediaRelay = createMediaRelay({
      send: (message) => {
        const sent = MainToCore.parse(structuredClone(message));
        if (sent.type === "media-cancel") media.cancel(sent.requestId);
        if (sent.type !== "media-read") return true;
        void media.read(sent).then((reply) => {
          const answer = mediaReplyMessage(sent.requestId, reply);
          if (answer === null) return;
          const received = CoreToMain.parse(structuredClone(answer));
          if (received.type === "media-bytes" || received.type === "media-failed") {
            relay.receive(received);
          }
        });
        return true;
      },
    });
    const get = (url: string, range?: string) => {
      const request = new Request(url, { headers: range === undefined ? {} : { Range: range } });
      return handleMediaRequest(Object.assign(request, { initiatorOrigin: APP_ORIGIN }), {
        relay,
        isAllowedInitiator: (origin) => origin === APP_ORIGIN,
      });
    };

    const whole = await get(playback.src, "bytes=0-");
    expect(whole.status).toBe(206);
    expect(whole.headers.get("content-range")).toBe(
      `bytes 0-${44 + 106_800 * 2 - 1}/${44 + 106_800 * 2}`,
    );
    const bytes = new Uint8Array(await whole.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
    expect(bytes.byteLength).toBe(44 + 106_800 * 2);
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset + 44);
    expect([samples[3_999], samples[4_000], samples[93_999], samples[94_000]]).toEqual([
      0, 1_000, 1_000, 0,
    ]);
    // A seek lands on the same bytes.
    const seek = await get(playback.src, `bytes=${44 + 2 * 93_998}-`);
    expect(new Int16Array(await seek.arrayBuffer()).subarray(0, 3)).toEqual(
      Int16Array.from([1_000, 1_000, 0]),
    );
    expect((await get(`sondine-media://episode/${episodeId}?g=2`, "bytes=0-")).status).toBe(409);
    expect((await get("sondine-media://episode/999?g=1", "bytes=0-")).status).toBe(404);

    const [missing] = await safe(client.episodes.playback({ episodeId: 999 }));
    expect(missing instanceof ORPCError && missing.code).toBe("NOT_FOUND");
  });

  it("recovers a job whose core died during inference: one published run, no duplicates", async () => {
    const data = setup();
    const fake = await helper(data);
    const stray = await straySpeechWorker(data.dir);
    cleanups.push(() => void stray.child.kill("SIGKILL"));
    const hung = fakeEngine({ hang: true, pid: () => stray.child.pid });
    const first = startCore(
      data,
      fake,
      { engine: engineLayer(() => hung), signals: fakeSignals().layer },
      { speechBinary: stray.binary },
    );
    await connected(first.runtime);
    await speakThenWait(fake);
    await waitUntil(() => hung.requests.length === 1, { label: "inference started" });
    await waitUntil(
      async () =>
        (await scalar(first.runtime, "SELECT worker_pid FROM job_attempts")) === stray.child.pid,
      { label: "worker pid recorded" },
    );
    await first.dispose();

    // What the dead core left: the attempt still running, nothing published.
    const left = openDatabase(data.config().databasePath, { migrationsFolder: migrationsDir });
    expect(left.statement("SELECT state FROM jobs").all()).toEqual([{ state: "running" }]);
    expect(left.statement("SELECT outcome FROM job_attempts").all()).toEqual([
      { outcome: "running" },
    ]);
    expect(left.statement("SELECT count(*) AS n FROM segments").get()).toEqual({ n: 0 });
    left.close();

    // A worker spawned during a cold load, killed with its core before its pid was recorded.
    const unrecorded = await straySpeechWorker(data.dir);
    cleanups.push(() => void unrecorded.child.kill("SIGKILL"));
    const engine = fakeEngine();
    const second = startCore(
      data,
      fake,
      { engine: engineLayer(() => engine), signals: fakeSignals().layer },
      { speechBinary: stray.binary },
    );
    await waitUntil(
      async () =>
        (await scalar(
          second.runtime,
          "SELECT count(*) FROM analysis_runs WHERE status = 'published'",
        )) === 1,
      { label: "published after restart", timeoutMs: 10_000 },
    );
    for (const child of [stray.child, unrecorded.child]) {
      await waitUntil(() => child.exitCode !== null || child.signalCode !== null, {
        label: "stray worker stopped",
      });
      expect(child.signalCode).toBe("SIGTERM");
    }
    expect(await rows(second.runtime, "SELECT status FROM analysis_runs ORDER BY id")).toEqual([
      { status: "cancelled" },
      { status: "published" },
    ]);
    expect(
      await rows(second.runtime, "SELECT attempt, outcome FROM job_attempts ORDER BY attempt"),
    ).toEqual([
      { attempt: 1, outcome: "abandoned" },
      { attempt: 2, outcome: "succeeded" },
    ]);
    expect(await scalar(second.runtime, "SELECT count(*) FROM segments")).toBe(1);
    expect(await scalar(second.runtime, "SELECT state FROM jobs")).toBe("succeeded");
    await second.runtime.runPromise(Effect.map(Database, (db) => checkSearchIndex(db)));
  });

  it("says why the queue waits, and lets a user request skip power and idle", async () => {
    const data = setup();
    const fake = await helper(data);
    const engine = fakeEngine();
    let installed: FakeEngine | null = null;
    const signals = fakeSignals({ onBattery: true, idleSeconds: 5 });
    const { runtime } = startCore(data, fake, {
      engine: engineLayer(() => installed),
      signals: signals.layer,
    });
    await connected(runtime);
    await speakThenWait(fake);

    await waitUntil(async () => (await status(runtime)).analysis.waitingFor.join() === "no-model", {
      label: "no-model",
    });
    expect((await status(runtime)).analysis.queued.moments).toBe(1);

    installed = engine;
    await waitUntil(
      async () => (await status(runtime)).analysis.waitingFor.join() === "on-battery,not-idle",
      { label: "on battery and in use" },
    );
    expect(engine.requests).toHaveLength(0);

    const services = await runtime.runPromise(Api);
    const episodeId = Number(await scalar(runtime, "SELECT id FROM episodes"));
    await expect(services.analysis.request({ episodeId })).resolves.toMatchObject({
      outcome: "already-queued",
    });
    await waitUntil(
      async () => (await scalar(runtime, "SELECT analysis_state FROM episodes")) === "complete",
      { label: "requested analysis published" },
    );
    expect(engine.requests).toHaveLength(1);
    await expect(services.analysis.request({ episodeId: 999 })).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("cancels a job when the Mac becomes busy, without counting a failure, then finishes it", async () => {
    const data = setup();
    const fake = await helper(data);
    const hung = fakeEngine({ hang: true, progress: false });
    const engine = fakeEngine();
    let installed: FakeEngine = hung;
    const signals = fakeSignals();
    const { runtime } = startCore(data, fake, {
      engine: engineLayer(() => installed),
      signals: signals.layer,
    });
    await connected(runtime);
    await speakThenWait(fake);
    await waitUntil(() => hung.requests.length === 1, { label: "inference started" });

    signals.set({ idleSeconds: 0 });
    await waitUntil(
      async () => (await scalar(runtime, "SELECT outcome FROM job_attempts")) === "cancelled",
      { label: "cancelled" },
    );
    expect(hung.unloads).toBeGreaterThan(0);
    expect(await scalar(runtime, "SELECT state FROM jobs")).toBe("queued");
    expect((await status(runtime)).analysis.waitingFor).toEqual(["not-idle"]);

    installed = engine;
    signals.set({ idleSeconds: 600 });
    await waitUntil(async () => (await scalar(runtime, "SELECT state FROM jobs")) === "succeeded", {
      label: "finished",
    });
    expect(
      await rows(runtime, "SELECT outcome, error_code FROM job_attempts ORDER BY attempt"),
    ).toEqual([
      { outcome: "cancelled", error_code: "admission" },
      { outcome: "succeeded", error_code: null },
    ]);
  });
});
