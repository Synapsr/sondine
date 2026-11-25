import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Api } from "../src/core/api-services";
import { Database } from "../src/core/database";
import { EpisodeBuilder } from "../src/core/episodes/episode-builder";
import { makeCoreRuntime } from "../src/core/runtime";
import { Boot, rows } from "./capture-fixture";
import { captureOptions, recordingMain, tempDataDir, waitUntil } from "./support";

// « Terminer » through the real core (ADR 044): the window's call, the passes
// that follow it until the episode closes, what the API says meanwhile, and ⌘Z.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

describe("ending an ongoing episode in core", () => {
  it("ends it at once for the window, closes it when its audio is in, and takes it back", async () => {
    const data = tempDataDir();
    cleanups.push(() => data.cleanup());
    const runtime = makeCoreRuntime(data.config(), recordingMain(), captureOptions(data));
    cleanups.push(() => runtime.dispose());
    const services = await runtime.runPromise(Api);
    const db = await runtime.runPromise(Database);
    const pass = () => runtime.runPromise(Effect.flatMap(EpisodeBuilder, (b) => b.pass));

    // An hour into a boot: a sentence that ended 10 s ago, on a track still recording.
    const boot = new Boot(db, Date.now() - 3_600_000);
    const mic = boot.run({ startSec: 3_500 });
    boot.chunks(mic, 3_500, 3_600);
    boot.region(mic, 3_560, 3_590);
    await pass();
    const today = async () => (await services.episodes.day({})).ongoing;
    const [ongoing] = await today();
    if (ongoing === undefined) throw new Error("nothing ongoing");
    const episodeId = ongoing.id;
    const settings = rows(db, "SELECT key, value FROM settings ORDER BY key");
    const state = () => rows(db, "SELECT state FROM episodes").map((row) => row["state"]);

    expect(await services.episodes.end({ episodeId })).toEqual({ ended: true });
    expect(await services.episodes.end({ episodeId })).toEqual({ ended: false });
    // Over for the window, still waiting for its last seconds in the database.
    expect(state()).toEqual(["open"]);
    expect((await services.episodes.get({ episodeId })).episode.state).toBe("closed");
    expect(await today()).toEqual([]);

    boot.chunks(mic, 3_600, 3_610);
    await waitUntil(() => state()[0] === "closed", { timeoutMs: 10_000 });
    expect(rows(db, "SELECT key, value FROM settings ORDER BY key")).toEqual(settings);

    expect(await services.history.undo()).toMatchObject({
      outcome: "undone",
      action: "end",
      removed: [],
      kept: [episodeId],
    });
    expect((await today()).map((episode) => episode.id)).toEqual([episodeId]);
    expect(await services.history.redo()).toMatchObject({ outcome: "redone", action: "end" });
    expect(await today()).toEqual([]);

    await expect(services.episodes.end({ episodeId: 999 })).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("asks for the transcript of one just ended once it is closed", async () => {
    const data = tempDataDir();
    cleanups.push(() => data.cleanup());
    const runtime = makeCoreRuntime(data.config(), recordingMain(), captureOptions(data));
    cleanups.push(() => runtime.dispose());
    const services = await runtime.runPromise(Api);
    const db = await runtime.runPromise(Database);
    const boot = new Boot(db, Date.now() - 3_600_000);
    const mic = boot.run({ startSec: 3_500 });
    boot.chunks(mic, 3_500, 3_610);
    boot.region(mic, 3_560, 3_590);
    await runtime.runPromise(Effect.flatMap(EpisodeBuilder, (b) => b.pass));
    const [ongoing] = (await services.episodes.day({})).ongoing;
    const episodeId = ongoing?.id ?? 0;
    await services.episodes.end({ episodeId });
    expect((await services.analysis.request({ episodeId })).outcome).not.toBe("episode-open");
  });
});
