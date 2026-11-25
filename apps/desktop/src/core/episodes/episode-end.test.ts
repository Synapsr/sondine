import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteEpisode,
  endedEpisodeId,
  listEpisodes,
  loadEpisodeDay,
  mergeEpisodes,
  ongoingCall,
  ongoingEpisode,
  publishAnalysis,
  recordEnd,
  redoEnd,
  splitEpisode,
  undoEnd,
  UndoHistory,
  type Database,
  type StoredEnd,
} from "@sondine/db";
import { Boot, RATE, rows, scalar, tempDb, type TempDb } from "../../../test/capture-fixture";
import { runEpisodePass, type PassReport } from "./episode-pass";

// « Terminer » (ADR 044), over the real import functions and grouping passes.

const BOOT = Date.UTC(2026, 10, 25, 8, 0, 0);
const DISCORD = "com.hnc.Discord";

let temp: TempDb;
let boot: Boot;
let db: Database;
beforeEach(() => {
  temp = tempDb();
  db = temp.db;
  boot = new Boot(db, BOOT);
});
afterEach(() => temp.cleanup());

const pass = (sec: number, fullScan = false): PassReport =>
  runEpisodePass(db, { nowMs: boot.wallMs(sec), fullScan });

/** What `EpisodeBuilder.end` does: a pass, the end kept, another pass. */
function end(episodeId: number, sec: number): StoredEnd {
  const point = pass(sec).endPoints.get(episodeId);
  if (point === undefined) throw new Error(`episode ${episodeId} cannot end`);
  const kept = recordEnd(db, { episodeId, ...point, nowMs: boot.wallMs(sec) });
  if (kept === null) throw new Error("no speech");
  pass(sec);
  return kept;
}

interface Shown {
  readonly id: number;
  readonly state: string;
  readonly context: string;
  /** `[region, from, to]` in seconds of the run; null to the region's end. */
  readonly slices: readonly (readonly [number, number, number | null])[];
}

const seconds = (value: unknown) => (value === null ? null : Number(value) / RATE);

function shown(): Shown[] {
  return rows(db, "SELECT id, state, context FROM episodes ORDER BY started_at_ms, id").map(
    (episode) => ({
      id: Number(episode["id"]),
      state: String(episode["state"]),
      context: String(episode["context"]),
      slices: rows(
        db,
        `SELECT speech_region_id, slice_sample_start, slice_sample_end FROM episode_regions
         WHERE episode_id = ? ORDER BY slice_sample_start, speech_region_id`,
        Number(episode["id"]),
      ).map(
        (row) =>
          [
            Number(row["speech_region_id"]),
            Number(row["slice_sample_start"]) / RATE,
            seconds(row["slice_sample_end"]),
          ] as const,
      ),
    }),
  );
}

const first = () => {
  const [episode] = shown();
  if (episode === undefined) throw new Error("no episode");
  return episode;
};

const outline = () => shown().map(({ state, context, slices }) => [state, context, slices.length]);

describe("ending an ongoing episode", () => {
  it("closes a call that goes on once its audio is in, and opens another for what is next", () => {
    const mic = boot.run({ startSec: 0 });
    boot.call("c1", DISCORD, 0, null);
    boot.chunks(mic, 0, 40);
    const a = boot.region(mic, 10, 20);
    pass(40);
    const { id } = first();
    end(id, 41);
    // Imported to 40 s only: what was said before 41 s may still come.
    expect(outline()).toEqual([["open", "call", 1]]);
    boot.chunks(mic, 40, 42);
    expect(pass(42).closed).toEqual([]);
    boot.chunks(mic, 42, 44);
    expect(pass(44).closed).toEqual([id]);
    expect(scalar(db, "SELECT count(*) FROM jobs WHERE episode_id = ?", id)).toBe(1);

    // The call goes on: 5 s later, another episode.
    const b = boot.region(mic, 46, 50);
    boot.chunks(mic, 44, 60);
    pass(60);
    expect(shown().map(({ state, context, slices }) => [state, context, slices])).toEqual([
      ["closed", "call", [[a, 10, null]]],
      ["open", "call", [[b, 46, null]]],
    ]);
  });

  it("makes no episode when nothing is said afterwards, and leaves listening alone", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 40);
    boot.region(mic, 10, 20);
    pass(22);
    const settings = rows(db, "SELECT * FROM settings");
    end(first().id, 25);
    expect(pass(40).closed).toHaveLength(1);
    boot.chunks(mic, 40, 400);
    pass(400);
    expect(outline()).toEqual([["closed", "in_person", 1]]);
    expect(rows(db, "SELECT * FROM settings")).toEqual(settings);
    expect(rows(db, "SELECT id FROM track_runs WHERE state = 'open'")).toHaveLength(1);
  });

  it("cuts the sentence being said, for good, while it goes on and after", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 32);
    const a = boot.region(mic, 10, 20);
    const open = boot.region(mic, 28, null);
    pass(30);
    const { id } = first();
    end(id, 30);
    // What goes on is an episode once it is surely speech.
    expect(pass(31).openAfter).toBe(1);
    boot.chunks(mic, 32, 34);
    expect(pass(33)).toMatchObject({ closed: [id], openAfter: 1 });
    const cut = [
      [
        "closed",
        [
          [a, 10, null],
          [open, 28, 30],
        ],
      ],
      ["open", [[open, 30, null]]],
    ];
    const seen = () => shown().map(({ state, slices }) => [state, slices]);
    expect(seen()).toEqual(cut);
    // Later passes, a restart's included, change nothing.
    for (const [sec, full] of [
      [34, false],
      [35, true],
    ] as const) {
      const report = pass(sec, full);
      expect(report).toMatchObject({ created: [], bumped: [], deleted: [], repaired: [] });
      expect(seen()).toEqual(cut);
    }
    boot.close(mic, 28, 50, { voicedSec: 11 });
    const b = boot.region(mic, 60, 65);
    boot.chunks(mic, 34, 120);
    pass(120, true);
    expect(shown().map(({ state, slices }) => [state, slices])).toEqual([
      [
        "closed",
        [
          [a, 10, null],
          [open, 28, 30],
        ],
      ],
      [
        "closed",
        [
          [open, 30, null],
          [b, 60, null],
        ],
      ],
    ]);
    // The rest's share of the voice: 20 of the sentence's 22 s, of 11 s voiced.
    expect(scalar(db, "SELECT voiced_ms FROM episodes ORDER BY id DESC LIMIT 1")).toBe(15_000);
  });

  it("takes no silence for speech when ended right after the last word", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 30);
    // The helper keeps a region open 2.3 s after its last word.
    const said = boot.region(mic, 20, null);
    pass(29);
    const { id } = first();
    end(id, 30);
    for (const sec of [31, 32]) {
      pass(sec);
      expect(outline()).toEqual([["open", "in_person", 1]]);
    }
    boot.close(mic, 20, 29);
    boot.chunks(mic, 30, 34);
    pass(34);
    expect(shown()).toMatchObject([{ id, state: "closed", slices: [[said, 20, null]] }]);
  });

  it("drops what is left of a region found to end before its cut", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 34);
    const said = boot.region(mic, 20, null);
    pass(29);
    const { id } = first();
    end(id, 30);
    pass(34);
    expect(shown()).toHaveLength(2);
    boot.close(mic, 20, 29);
    pass(35);
    expect(shown()).toMatchObject([{ id, state: "closed", slices: [[said, 20, 30]] }]);
  });

  it("ends an episode whose only region is the one being said", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 34);
    const open = boot.region(mic, 10, null);
    pass(20);
    const { id } = first();
    end(id, 30);
    pass(34);
    expect(shown().map(({ id: shownId, state, slices }) => [shownId, state, slices])).toEqual([
      [id, "closed", [[open, 10, 30]]],
      [expect.any(Number), "open", [[open, 30, null]]],
    ]);
  });

  it("leaves media, a dictation and another call as they are", () => {
    const mic = boot.run({ startSec: 0 });
    const system = boot.run({ trackKey: "system:other", sourceKind: "system", startSec: 0 });
    const usb = boot.run({ trackKey: "input:USB", startSec: 0 });
    const zoom = boot.run({
      trackKey: "app:us.zoom.xos",
      sourceKind: "app",
      bundleId: "us.zoom.xos",
      startSec: 0,
    });
    const discord = boot.run({
      trackKey: `app:${DISCORD}`,
      sourceKind: "app",
      bundleId: DISCORD,
      startSec: 0,
    });
    for (const run of [mic, system, usb, zoom, discord]) boot.chunks(run, 0, 60);
    boot.call("c1", DISCORD, 0, null);
    boot.call("c2", "us.zoom.xos", 1, null);
    boot.listen("l1", "anomaly.hex", 20, null);
    const me = boot.region(mic, 5, 12);
    const them = boot.region(discord, 10, null);
    const video = boot.region(system, 10, null, { attributedTo: "com.apple.Safari" });
    const other = boot.region(zoom, 10, null);
    const said = boot.region(usb, 22, null);
    pass(30);
    const before = new Map(shown().map((episode) => [episode.context, episode]));
    const call = shown().find((episode) => episode.slices.some(([id]) => id === them));
    if (call === undefined) throw new Error("no call");
    end(call.id, 30);
    pass(34);
    const now = shown();
    expect(now.find((episode) => episode.id === call.id)).toMatchObject({
      state: "closed",
      slices: [
        [me, 5, null],
        [them, 10, 30],
      ],
    });
    expect(now.find((e) => e.context === "media")).toEqual(before.get("media"));
    expect(now.find((e) => e.context === "dictation")).toEqual(before.get("dictation"));
    expect(now.filter((e) => e.slices.some(([id]) => id === other))).toHaveLength(1);
    expect(now.filter((e) => e.slices.some(([id]) => id === video || id === said))).toHaveLength(2);
    expect(now.find((e) => e.slices.some(([id, from]) => id === them && from === 30))?.state).toBe(
      "open",
    );
  });

  it("keeps two episodes when the call comes back within 45 s", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 80);
    boot.call("c1", DISCORD, 0, 33);
    boot.region(mic, 10, 20);
    pass(30);
    end(first().id, 30);
    pass(34);
    boot.call("c2", DISCORD, 40, null);
    boot.region(mic, 45, 50);
    pass(60);
    expect(outline()).toEqual([
      ["closed", "call", 1],
      ["open", "call", 1],
    ]);
  });

  it("puts a region imported before the close, or long after, on its side", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 20);
    const a = boot.region(mic, 10, 20);
    pass(22);
    const { id } = first();
    end(id, 30);
    // The last seconds of audio, with a sentence known only now.
    boot.chunks(mic, 20, 34);
    const b = boot.region(mic, 26, 29);
    pass(34);
    expect(shown().map(({ state, slices }) => [state, slices])).toEqual([
      [
        "closed",
        [
          [a, 10, null],
          [b, 26, null],
        ],
      ],
    ]);
    // Recovered by a reconciliation, after the close and after what came next.
    const next = boot.region(mic, 36, 38);
    boot.chunks(mic, 34, 40);
    pass(39);
    const late = boot.region(mic, 29.2, 29.6);
    const across = boot.region(mic, 29.7, 31);
    pass(40, true);
    expect(shown().map(({ state, slices }) => [state, slices])).toEqual([
      [
        "closed",
        [
          [a, 10, null],
          [b, 26, null],
          [late, 29.2, null],
          [across, 29.7, 30],
        ],
      ],
      [
        "open",
        [
          [across, 30, null],
          [next, 36, null],
        ],
      ],
    ]);
  });

  it("gives the rest of a late region to the next episode, closed too", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 200);
    const a = boot.region(mic, 10, 20);
    pass(22);
    end(first().id, 30);
    const b = boot.region(mic, 32, 40);
    pass(200);
    expect(outline()).toEqual([
      ["closed", "in_person", 1],
      ["closed", "in_person", 1],
    ]);
    const other = boot.run({ trackKey: "input:USB", startSec: 0 });
    const across = boot.region(other, 25, 35);
    pass(210, true);
    expect(shown().map(({ slices }) => slices)).toEqual([
      [
        [a, 10, null],
        [across, 25, 30],
      ],
      [
        [across, 30, null],
        [b, 32, null],
      ],
    ]);
  });

  it("finishes after a crash between the click and the close", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 24);
    const a = boot.region(mic, 10, 20);
    const open = boot.region(mic, 22, null);
    pass(24);
    const { id } = first();
    end(id, 24);
    db = temp.reopen();
    boot = new Boot(db, BOOT);
    boot.chunks(mic, 24, 40);
    boot.close(mic, 22, 36);
    boot.endRun(mic, 40);
    pass(300, true);
    expect(shown().map(({ id: shownId, state, slices }) => [shownId, state, slices])).toEqual([
      [
        id,
        "closed",
        [
          [a, 10, null],
          [open, 22, 24],
        ],
      ],
      [expect.any(Number), "closed", [[open, 24, null]]],
    ]);
  });

  it("shows as over at once, and goes on in no list of what is ongoing", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 30);
    boot.call("c1", DISCORD, 0, null);
    boot.region(mic, 10, 20);
    pass(22);
    const { id } = first();
    const listed = () => listEpisodes(db, { fromMs: 0, toMs: boot.wallMs(900), limit: 9 }).episodes;
    const day = () =>
      loadEpisodeDay(db, {
        fromMs: boot.wallMs(0),
        toMs: boot.wallMs(900),
        hours: [],
        pageSize: 5,
        nowMs: boot.wallMs(30),
      }).ongoing.map((episode) => episode.id);
    expect([listed()[0]?.ending, day(), ongoingCall(db, boot.wallMs(30))?.episodeId]).toEqual([
      false,
      [id],
      id,
    ]);
    end(id, 29);
    expect(first().state).toBe("open");
    expect([listed()[0]?.ending, day(), ongoingCall(db, boot.wallMs(30))?.episodeId]).toEqual([
      true,
      [],
      null,
    ]);
    // The next one, as soon as it is said, is the one going on.
    boot.region(mic, 30, null);
    pass(31);
    const next = shown()[1]?.id;
    expect([day(), ongoingEpisode(db, boot.wallMs(31))]).toEqual([[next], next]);
    boot.chunks(mic, 30, 34);
    pass(34);
    expect(listed().map((episode) => [episode.state, episode.ending])).toEqual([
      ["open", false],
      ["closed", false],
    ]);
  });

  it("keeps the rest of the sentence when the ended episode is deleted", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 40);
    const open = boot.region(mic, 20, null);
    pass(28);
    const { id } = first();
    end(id, 30);
    pass(34);
    boot.close(mic, 20, 38);
    deleteEpisode(db, id, { origin: "app", nowMs: boot.wallMs(39) });
    pass(40);
    expect(shown().map(({ state, slices }) => [state, slices])).toEqual([
      ["open", [[open, 30, null]]],
    ]);
  });

  it("splits an ended episode while its last sentence goes on", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 40);
    boot.region(mic, 5, 10);
    const open = boot.region(mic, 20, null);
    pass(28);
    const { id } = first();
    end(id, 30);
    pass(34);
    const split = splitEpisode(db, {
      episodeId: id,
      atMs: boot.wallMs(15),
      nowMs: boot.wallMs(35),
    });
    expect(split.ok).toBe(true);
    expect(shown().map(({ slices }) => slices.at(-1))).toContainEqual([open, 20, 30]);
  });
});

describe("⌘Z on « Terminer »", () => {
  const undo = (kept: StoredEnd, sec: number) => {
    const undone = undoEnd(db, kept, boot.wallMs(sec));
    pass(sec);
    return undone;
  };
  const integrity = () => rows(db, "PRAGMA foreign_key_check");

  it("takes back an end not yet closed", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 30);
    boot.region(mic, 10, null);
    pass(22);
    const { id } = first();
    const kept = end(id, 29);
    expect(undo(kept, 30)).toEqual({ ok: true, episodeId: id, mergedId: null });
    expect(shown()).toMatchObject([
      { id, state: "open", slices: [[expect.any(Number), 10, null]] },
    ]);
    expect(scalar(db, "SELECT count(*) FROM user_assertions")).toBe(0);
  });

  it("reopens the episode and joins what was said since, its sentence whole again", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 60);
    const a = boot.region(mic, 5, 10);
    const open = boot.region(mic, 20, null);
    pass(28);
    const { id } = first();
    const kept = end(id, 30);
    pass(34);
    const b = boot.region(mic, 50, 55);
    boot.close(mic, 20, 40);
    pass(56);
    expect(shown()).toHaveLength(2);
    expect(undo(kept, 57)).toMatchObject({ ok: true, mergedId: null });
    const whole = [
      [a, 5, null],
      [open, 20, null],
      [b, 50, null],
    ];
    expect(shown().map(({ state, slices }) => [state, slices])).toEqual([["open", whole]]);
    expect(rows(db, "SELECT state FROM jobs WHERE state = 'queued'")).toEqual([]);
    const only = first().id;

    // ⇧⌘Z: cut again at the same sample, the first part keeping the id.
    expect(redoEnd(db, kept, boot.wallMs(58))).toEqual({
      ok: true,
      episodeId: only,
      newEpisodeId: null,
    });
    pass(58);
    expect(shown().map(({ id: shownId, state, slices }) => [shownId, state, slices])).toEqual([
      [
        only,
        "closed",
        [
          [a, 5, null],
          [open, 20, 30],
        ],
      ],
      [
        expect.any(Number),
        "open",
        [
          [open, 30, null],
          [b, 50, null],
        ],
      ],
    ]);
    expect(integrity()).toEqual([]);
  });

  it("merges the two once both are closed, and redoing separates them again", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 200);
    const a = boot.region(mic, 10, 20);
    pass(22);
    const { id } = first();
    const kept = end(id, 25);
    const b = boot.region(mic, 30, 40);
    pass(200);
    const other = shown()[1]?.id;
    expect(undo(kept, 201)).toEqual({ ok: true, episodeId: id, mergedId: other });
    expect(shown()).toMatchObject([
      {
        id,
        state: "closed",
        slices: [
          [a, 10, null],
          [b, 30, null],
        ],
      },
    ]);
    expect(redoEnd(db, kept, boot.wallMs(202))).toMatchObject({ ok: true, episodeId: id });
    pass(202);
    expect(shown().map(({ slices }) => slices)).toEqual([[[a, 10, null]], [[b, 30, null]]]);
    expect(endedEpisodeId(db, kept)).toBe(id);
  });

  it("leaves apart what the gap would have separated anyway", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 400);
    boot.region(mic, 10, 20);
    pass(22);
    const kept = end(first().id, 25);
    boot.region(mic, 100, 110);
    pass(400);
    expect(undo(kept, 401)).toMatchObject({ ok: true, mergedId: null });
    expect(outline()).toEqual([
      ["closed", "in_person", 1],
      ["closed", "in_person", 1],
    ]);
    expect(scalar(db, "SELECT count(*) FROM user_assertions")).toBe(0);
  });

  it("merges across another conversation heard in between", () => {
    const mic = boot.run({ startSec: 0 });
    const usb = boot.run({ trackKey: "input:USB", startSec: 0 });
    const discord = boot.run({
      trackKey: `app:${DISCORD}`,
      sourceKind: "app",
      bundleId: DISCORD,
      startSec: 0,
    });
    const zoom = boot.run({
      trackKey: "app:us.zoom.xos",
      sourceKind: "app",
      bundleId: "us.zoom.xos",
      startSec: 0,
    });
    for (const run of [mic, usb, discord, zoom]) boot.chunks(run, 0, 900);
    boot.call("c1", DISCORD, 0, null);
    boot.call("c2", "us.zoom.xos", 1, null);
    boot.region(discord, 10, 20);
    pass(22);
    const { id } = first();
    const kept = end(id, 25);
    boot.region(zoom, 26, 30);
    boot.region(discord, 40, 50);
    pass(800);
    expect(outline()).toHaveLength(3);
    expect(undo(kept, 801)).toMatchObject({ ok: true, episodeId: id });
    expect(outline()).toHaveLength(2);
    expect(first().slices).toHaveLength(2);
  });

  it("keeps a transcribed episode's id and text when it reopens", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 80);
    const a = boot.region(mic, 10, 20);
    pass(22);
    const { id } = first();
    const kept = end(id, 25);
    pass(30);
    transcribe(id, mic.trackRunId);
    // The continuation holds more regions: without care it would take the id.
    const later = [boot.region(mic, 30, 35), boot.region(mic, 40, 45), boot.region(mic, 50, 55)];
    pass(56);
    expect(undo(kept, 57)).toMatchObject({ ok: true });
    expect(shown()).toMatchObject([
      {
        id,
        state: "open",
        slices: [[a, 10, null], ...later.map((region) => [region, expect.any(Number), null])],
      },
    ]);
    expect(scalar(db, "SELECT text FROM segments WHERE episode_id = ?", id)).toBe("bonjour");
    boot.chunks(mic, 80, 140);
    pass(140);
    expect(first().state).toBe("closed");
    expect(scalar(db, "SELECT count(*) FROM jobs WHERE state = 'queued'")).toBe(1);
  });

  it("refuses once the episode was merged by hand, or deleted", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 200);
    boot.region(mic, 10, 20);
    pass(22);
    const { id } = first();
    const kept = end(id, 25);
    boot.region(mic, 30, 40);
    pass(200);
    const other = shown()[1]?.id ?? 0;
    expect(mergeEpisodes(db, { episodeId: id, otherId: other, nowMs: boot.wallMs(201) }).ok).toBe(
      true,
    );
    expect(undoEnd(db, kept, boot.wallMs(202))).toEqual({ ok: false, reason: "changed" });
    deleteEpisode(db, id, { origin: "app", nowMs: boot.wallMs(203) });
    expect(undoEnd(db, kept, boot.wallMs(204))).toEqual({ ok: false, reason: "changed" });
  });

  it("is one step of the window's history, before and after the others", () => {
    const history = new UndoHistory(db);
    history.record({
      action: "end",
      undo: () => ({ ok: true, removed: [], kept: [7] }),
      redo: () => ({ ok: false, reason: "changed" }),
    });
    expect(history.heldFiles()).toEqual(new Set());
    expect(history.undo(1)).toMatchObject({ outcome: "undone", action: "end", kept: [7] });
    expect(history.redo(2)).toEqual({ outcome: "refused", action: "end", reason: "changed" });
    expect(history.redo(3)).toEqual({ outcome: "nothing" });
  });
});

/** A published transcript of one sentence. */
function transcribe(episodeId: number, trackRunId: number): void {
  const generation = Number(
    scalar(db, "SELECT input_generation FROM episodes WHERE id = ?", episodeId),
  );
  db.statement(
    `INSERT INTO analysis_runs (id, episode_id, stage, status, engine_id, engine_version, engine_runtime,
       adapter_class, engine_config, input_hash, input_generation, started_at_ms, finished_at_ms)
     VALUES (900, ?, 'asr', 'succeeded', 'test', '1', 'test', 'product', '{}', 'h', ?, 1, 1)`,
  ).run(episodeId, generation);
  publishAnalysis(db, {
    episodeId,
    stage: "asr",
    runId: 900,
    inputGeneration: generation,
    segments: [
      {
        trackRunId,
        sampleStart: 10 * RATE,
        sampleEnd: 12 * RATE,
        startMs: boot.wallMs(10),
        endMs: boot.wallMs(12),
        text: "bonjour",
        speakerLabel: null,
        lang: null,
        confidence: null,
        words: null,
      },
    ],
    turns: [],
    analysisState: "complete",
    nowMs: boot.wallMs(30),
  });
}
