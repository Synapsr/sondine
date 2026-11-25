import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ImportConflictError, openDatabase, type OpenedDatabase } from "@sondine/db";
import { decodeJsonLines, HelperEvent } from "@sondine/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrationsDir } from "../../../test/support";
import { createCaptureImporter, spoolSeq, type CaptureImporter } from "./capture-importer";

const fixtures = decodeJsonLines(
  HelperEvent,
  readFileSync(
    resolve(import.meta.dirname, "../../../../../packages/protocol/fixtures/helper-events.jsonl"),
  ),
).map((result) => {
  if (!result.ok) throw new Error(`fixture line ${result.line}: ${result.error.message}`);
  return result.value;
});

type EventOf<T extends HelperEvent["type"]> = Extract<HelperEvent, { type: T }>;

const isType = <T extends HelperEvent["type"]>(event: HelperEvent, type: T): event is EventOf<T> =>
  event.type === type;

function fixture<T extends HelperEvent["type"]>(
  type: T,
  predicate: (event: EventOf<T>) => boolean = () => true,
): EventOf<T> {
  for (const event of fixtures) if (isType(event, type) && predicate(event)) return event;
  throw new Error(`no ${type} fixture`);
}

const count = (db: OpenedDatabase, table: string): number => {
  const value = db.statement(`SELECT count(*) AS n FROM ${table}`).get()?.["n"];
  return typeof value === "number" ? value : -1;
};

describe("capture importer", () => {
  let db: OpenedDatabase;
  let importer: CaptureImporter;

  beforeEach(() => {
    db = openDatabase(":memory:", { migrationsFolder: migrationsDir });
    importer = createCaptureImporter(db, { spoolDir: "spool", now: () => 1_793_610_100_000 });
  });
  afterEach(() => db.close());

  it("imports every protocol fixture and is idempotent on replay", () => {
    const first = fixtures.map((event) => importer.handle(event));
    const counts = () =>
      [
        "track_runs",
        "epochs",
        "spool_files",
        "chunks",
        "speech_regions",
        "gaps",
        "devices",
        "apps",
        "calls",
        "listens",
      ].map((table) => [table, count(db, table)] as const);
    const afterFirst = counts();

    // A reconnecting core sees `ready` and the snapshot again, then live events.
    const second = fixtures.map((event) => importer.handle(event));
    expect(counts()).toEqual(afterFirst);

    const changed = second.flatMap((result) => result.statuses).filter((s) => s === "inserted");
    expect(changed).toEqual([]);
    expect(first.some((result) => result.statuses.includes("inserted"))).toBe(true);

    const tally = Object.fromEntries(afterFirst);
    expect(tally["devices"]).toBe(5);
    // Fixtures open three runs; the system run closes (its tap released) before its commit replays.
    expect(tally["track_runs"]).toBe(3);
    expect(tally["speech_regions"]).toBe(1);
    expect(tally["chunks"]).toBeGreaterThanOrEqual(1);
    expect(tally["calls"]).toBe(1);
    expect(tally["listens"]).toBe(1);
  });

  describe("calls", () => {
    const active = fixture("call", (e) => e.state === "active");
    const ended = fixture("call", (e) => e.state === "ended");
    const clock = fixture("clock");
    const wallNs = clock.anchor.wallNs;
    const calls = () =>
      db
        .statement(
          `SELECT uid, bundle_id, via, input_device_uid, started_wall_ms, ended_wall_ms, end_reason,
             last_seen_wall_ms
           FROM calls ORDER BY id`,
        )
        .all();
    /** A clock `sec` seconds after the fixture's anchor. */
    const clockAt = (sec: number) => ({
      ...clock,
      anchor: {
        hostTicks: clock.anchor.hostTicks + BigInt(sec * 24_000_000),
        continuousNs: clock.anchor.continuousNs + BigInt(sec * 1e9),
        wallNs: wallNs + BigInt(sec * 1e9),
      },
    });
    const wallMs = (sec: number) => Number(wallNs / 1_000_000n) + sec * 1000;
    /** A helper instant `sec` seconds after the fixture's anchor. */
    const pointAt = (sec: number) => {
      const { hostTicks, continuousNs } = clockAt(sec).anchor;
      return { hostTicks, continuousNs };
    };

    it("records a call once, placed on the wall clock by the newest anchor", () => {
      importer.handle(fixture("ready"));
      importer.handle(clock);
      expect(importer.handle(active)).toMatchObject({ statuses: ["inserted"], spansChanged: 1 });
      // A snapshot replays it: nothing changes.
      expect(importer.handle({ ...active, replyTo: "s1" })).toMatchObject({
        statuses: ["duplicate"],
        spansChanged: 0,
      });
      expect(calls()).toEqual([
        {
          uid: active.callId,
          bundle_id: "us.zoom.xos",
          via: "call_app",
          input_device_uid: "BuiltInMicrophoneDevice",
          // The call started 1 s before the anchor.
          started_wall_ms: wallMs(-1),
          ended_wall_ms: null,
          end_reason: null,
          last_seen_wall_ms: wallMs(-1),
        },
      ]);
      // The clock vouches for the active call; its end is the helper's.
      importer.handle(clockAt(20));
      expect(calls()[0]).toMatchObject({ last_seen_wall_ms: wallMs(20) });
      expect(importer.handle(ended)).toMatchObject({ statuses: ["updated"], spansChanged: 1 });
      expect(importer.handle(ended)).toMatchObject({ statuses: ["duplicate"], spansChanged: 0 });
      expect(calls()[0]).toMatchObject({ ended_wall_ms: wallMs(1740), end_reason: "ended" });
    });

    it("closes, at a snapshot's end, the calls it did not replay, at their last-seen clock", () => {
      const ready = fixture("ready");
      importer.handle(ready);
      importer.handle(clock);
      importer.handle(active);
      const other = { ...active, callId: "70e6cdb8-9fa0-43e1-b287-debf50617283" };
      importer.handle(other);
      importer.handle(clockAt(30));
      // Core reconnects to the same helper: its snapshot replays only what is still active.
      importer.handle(ready);
      expect(importer.handle({ ...other, replyTo: "s2" }).statuses).toEqual(["duplicate"]);
      expect(importer.handle({ type: "ack", replyTo: "s2" })).toMatchObject({ spansChanged: 1 });
      expect(calls().map((row) => [row["uid"], row["end_reason"], row["ended_wall_ms"]])).toEqual([
        [active.callId, "lost", wallMs(30)],
        [other.callId, null, null],
      ]);
      // Its buffered `ended` arrives after the snapshot: the exact end wins over the estimate.
      importer.handle(ended);
      expect(calls()[0]).toMatchObject({ end_reason: "ended", ended_wall_ms: wallMs(1740) });

      // A new helper (the previous one died during the call) replays nothing of it.
      importer.handle({ ...ready, sessionId: "7a2d3b5f-9c4e-4d6f-8a21-3b4c5d6e7f80" });
      importer.handle(clockAt(60));
      expect(importer.handle({ type: "ack", replyTo: "s3" })).toMatchObject({ spansChanged: 1 });
      expect(calls()[1]).toMatchObject({ end_reason: "lost", ended_wall_ms: wallMs(30) });
    });

    it("closes a call whose `ended` was lost at its last clock, not at the snapshot's", () => {
      const ready = fixture("ready");
      importer.handle(ready);
      importer.handle(clock);
      importer.handle(active);
      const kept = { ...active, callId: "70e6cdb8-9fa0-43e1-b287-debf50617283" };
      importer.handle(kept);
      importer.handle(clockAt(30));
      // Core reconnects to the same helper an hour later. The first call ended
      // meanwhile, and its `ended` was dropped from the helper's backlog.
      importer.handle(ready);
      importer.handle({ type: "warning", code: "events.dropped", message: "12 events" });
      // Clocks before the snapshot's replays vouch for neither call.
      importer.handle(clockAt(3600));
      importer.handle({ ...clockAt(3605), reason: "request", replyTo: "s2" });
      expect(calls().map((row) => row["last_seen_wall_ms"])).toEqual([wallMs(30), wallMs(30)]);
      importer.handle({ ...kept, replyTo: "s2" });
      expect(importer.handle({ type: "ack", replyTo: "s2" })).toMatchObject({ spansChanged: 1 });
      expect(
        calls().map((row) => [
          row["uid"],
          row["end_reason"],
          row["ended_wall_ms"],
          row["last_seen_wall_ms"],
        ]),
      ).toEqual([
        [active.callId, "lost", wallMs(30), wallMs(30)],
        // The replay confirms the other as of the snapshot's clock, and later clocks vouch for it.
        [kept.callId, null, null, wallMs(3605)],
      ]);
      importer.handle(clockAt(3615));
      expect(calls()[1]).toMatchObject({ last_seen_wall_ms: wallMs(3615) });
    });

    it("lets only a new helper's own calls ride on its clocks", () => {
      importer.handle(fixture("ready"));
      importer.handle(clock);
      importer.handle(active);
      importer.handle(clockAt(30));
      // The helper died during the call; the next one reports a call of its own.
      importer.handle({ ...fixture("ready"), sessionId: "7a2d3b5f-9c4e-4d6f-8a21-3b4c5d6e7f80" });
      const fresh = {
        ...active,
        callId: "70e6cdb8-9fa0-43e1-b287-debf50617283",
        at: pointAt(50),
      };
      importer.handle(clockAt(45));
      importer.handle(fresh);
      importer.handle(clockAt(60));
      importer.handle({ ...clockAt(65), reason: "request", replyTo: "s3" });
      importer.handle({ ...fresh, replyTo: "s3" });
      expect(importer.handle({ type: "ack", replyTo: "s3" })).toMatchObject({ spansChanged: 1 });
      expect(calls().map((row) => [row["uid"], row["end_reason"], row["ended_wall_ms"]])).toEqual([
        [active.callId, "lost", wallMs(30)],
        [fresh.callId, null, null],
      ]);
      expect(calls()[1]).toMatchObject({ last_seen_wall_ms: wallMs(65) });
    });

    it("stops vouching for a call whose `ended` failed to import", () => {
      importer.handle(fixture("ready"));
      importer.handle(clock);
      importer.handle(active);
      importer.handle(clockAt(30));
      // A write that fails (a full disk) loses the `ended`.
      db.client.exec(
        `CREATE TEMP TRIGGER fail_end BEFORE UPDATE OF end_reason ON calls
         WHEN NEW.end_reason = 'ended' BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
      );
      expect(() => importer.handle(ended)).toThrow("disk full");
      db.client.exec("DROP TRIGGER fail_end");
      importer.handle(clockAt(3600));
      expect(calls()[0]).toMatchObject({ end_reason: null, last_seen_wall_ms: wallMs(30) });
      // The next snapshot leaves it out: it closes at the last clock that vouched for it.
      importer.handle(fixture("ready"));
      importer.handle({ type: "ack", replyTo: "s2" });
      expect(calls()[0]).toMatchObject({ end_reason: "lost", ended_wall_ms: wallMs(30) });
    });

    it("records listen spans beside calls, with the same snapshot rules", () => {
      const listen = fixture("listen", (e) => e.state === "active");
      const listens = () =>
        db
          .statement(
            `SELECT uid, bundle_id, via, ended_wall_ms, end_reason, last_seen_wall_ms
             FROM listens ORDER BY id`,
          )
          .all();
      importer.handle(fixture("ready"));
      importer.handle(clock);
      importer.handle(active);
      expect(importer.handle(listen)).toMatchObject({ statuses: ["inserted"], spansChanged: 1 });
      importer.handle(clockAt(30));
      expect(listens()).toEqual([
        {
          uid: listen.listenId,
          bundle_id: "anomaly.hex",
          via: "app",
          ended_wall_ms: null,
          end_reason: null,
          last_seen_wall_ms: wallMs(30),
        },
      ]);
      // After a reconnect, a snapshot that replays the call but not the listener closes only
      // the listener, at the last clock that vouched for it.
      importer.handle(fixture("ready"));
      importer.handle({ ...clockAt(40), reason: "request", replyTo: "s2" });
      importer.handle({ ...active, replyTo: "s2" });
      expect(importer.handle({ type: "ack", replyTo: "s2" })).toMatchObject({ spansChanged: 1 });
      expect(listens()[0]).toMatchObject({ end_reason: "lost", ended_wall_ms: wallMs(30) });
      expect(calls()[0]).toMatchObject({ end_reason: null, last_seen_wall_ms: wallMs(40) });
      // Replayed later, it is on again.
      importer.handle({ ...clockAt(50), reason: "request", replyTo: "s3" });
      importer.handle({ ...active, replyTo: "s3" });
      expect(importer.handle({ ...listen, replyTo: "s3" }).statuses).toEqual(["updated"]);
      importer.handle({ type: "ack", replyTo: "s3" });
      expect(listens()[0]).toMatchObject({ end_reason: null, last_seen_wall_ms: wallMs(50) });
    });

    it("drops an `ended` for a call it never saw start", () => {
      importer.handle(fixture("ready"));
      expect(importer.handle(ended)).toMatchObject({ statuses: ["unknown"], spansChanged: 0 });
      expect(calls()).toEqual([]);
    });

    it("attributes a system:other region to the app the latest activity named", () => {
      importer.handle(fixture("ready"));
      const system = fixture("track.open", (e) => e.trackKey === "system:other");
      importer.handle(system);
      const activity = fixture("activity");
      const attribute = (bundleId: string | null) =>
        importer.handle({
          ...activity,
          attribution: [
            {
              trackKey: "system:other",
              runId: system.runId,
              confidence: bundleId === null ? "ambiguous" : "single-active",
              bundleId,
              candidateObjectIds: bundleId === null ? [107, 112] : [112],
            },
          ],
        });
      const open = fixture("region.open");
      const regionAt = (startSample: number) =>
        importer.handle({ ...open, trackKey: "system:other", runId: system.runId, startSample });
      attribute("com.apple.Safari");
      regionAt(64_000);
      attribute(null);
      regionAt(96_000);
      expect(
        db
          .statement(
            `SELECT r.sample_start, a.bundle_id FROM speech_regions r
             LEFT JOIN apps a ON a.id = r.attributed_app_id ORDER BY r.sample_start`,
          )
          .all(),
      ).toEqual([
        { sample_start: 64_000, bundle_id: "com.apple.Safari" },
        { sample_start: 96_000, bundle_id: null },
      ]);
    });
  });

  it("skips events for runs it never saw opened", () => {
    importer.handle(fixture("ready"));
    expect(importer.handle(fixture("commit"))).toMatchObject({
      skipped: "unknown run",
      statuses: [],
    });
    expect(count(db, "chunks")).toBe(0);
  });

  it("records a region whose open it missed, and the gaps a commit carries", () => {
    importer.handle(fixture("ready"));
    importer.handle(fixture("track.open", (e) => e.trackKey === "input:BuiltInMicrophoneDevice"));
    const close = importer.handle(fixture("region.close"));
    expect(close.statuses).toEqual(["inserted", "updated"]);
    expect(db.statement("SELECT state, end_reason FROM speech_regions").get()).toEqual({
      state: "closed",
      end_reason: "silence",
    });
    // The apps in front while it lasted (ADR 022); a replay adds none.
    const foreground = () =>
      db
        .statement(
          `SELECT a.bundle_id, a.name, f.sample_start, f.sample_end FROM foreground_spans f
           JOIN apps a ON a.id = f.app_id ORDER BY f.sample_start`,
        )
        .all();
    expect(foreground()).toEqual([
      { bundle_id: "com.apple.dt.Xcode", name: "Xcode", sample_start: 64_000, sample_end: 100_000 },
      { bundle_id: "app.sondine", name: "Sondine", sample_start: 100_000, sample_end: 136_000 },
    ]);
    importer.handle(fixture("region.close"));
    expect(foreground()).toHaveLength(2);

    importer.handle(fixture("track.open", (e) => e.trackKey === "system:other"));
    const withGap = importer.handle(fixture("commit", (e) => e.gaps.length > 0));
    expect(withGap.statuses).toContain("inserted");
    expect(db.statement("SELECT reason, sample_start, sample_end FROM gaps").get()).toEqual({
      reason: "ring_overflow",
      sample_start: 192_000,
      sample_end: 192_800,
    });
  });

  it("keeps a revoked permission as the reason a run ended", () => {
    importer.handle(fixture("ready"));
    const open = fixture("track.open", (e) => e.trackKey === "input:BuiltInMicrophoneDevice");
    importer.handle(open);
    importer.handle({
      ...fixture("track.close"),
      trackKey: open.trackKey,
      runId: open.runId,
      endSample: 0,
      reason: "permission",
    });
    expect(db.statement("SELECT state, end_reason FROM track_runs").get()).toEqual({
      state: "closed",
      end_reason: "permission_revoked",
    });
  });

  it("closes the previous spool file when a run rotates", () => {
    importer.handle(fixture("ready"));
    importer.handle(fixture("track.open", (e) => e.trackKey === "input:BuiltInMicrophoneDevice"));
    const commit = fixture("commit", (e) => e.trackKey === "input:BuiltInMicrophoneDevice");
    importer.handle(commit);
    const next = commit.file.replace("0000.pcm", "0001.pcm");
    importer.handle({
      ...commit,
      file: next,
      seq: 0,
      committedOffset: commit.sampleCount * 2,
      sampleIndex: commit.sampleIndex + commit.sampleCount,
    });
    const files = db.statement("SELECT seq, state, rel_path FROM spool_files ORDER BY seq").all();
    expect(files).toEqual([
      { seq: 0, state: "closed", rel_path: `spool/${commit.file}` },
      { seq: 1, state: "open", rel_path: `spool/${next}` },
    ]);
  });

  it("never lets a replayed commit from an older file close the newer one", () => {
    importer.handle(fixture("ready"));
    importer.handle(fixture("track.open", (e) => e.trackKey === "input:BuiltInMicrophoneDevice"));
    const commit = fixture("commit", (e) => e.trackKey === "input:BuiltInMicrophoneDevice");
    const next = {
      ...commit,
      file: commit.file.replace("0000.pcm", "0001.pcm"),
      committedOffset: commit.sampleCount * 2,
      sampleIndex: commit.sampleIndex + commit.sampleCount,
    };
    importer.handle(commit);
    importer.handle(next);
    // A snapshot after reconnecting replays the older file's commit.
    expect(importer.handle(commit).statuses).toEqual(["duplicate", "duplicate"]);
    const later = {
      ...next,
      committedOffset: next.committedOffset + next.sampleCount * 2,
      sampleIndex: next.sampleIndex + next.sampleCount,
    };
    expect(importer.handle(later).statuses).toEqual(["inserted"]);
    const files = db.statement("SELECT seq, state FROM spool_files ORDER BY seq").all();
    expect(files).toEqual([
      { seq: 0, state: "closed" },
      { seq: 1, state: "open" },
    ]);
  });

  it("forgets a spool file whose first commit rolled back", () => {
    importer.handle(fixture("ready"));
    importer.handle(fixture("track.open", (e) => e.trackKey === "input:BuiltInMicrophoneDevice"));
    const commit = fixture("commit", (e) => e.trackKey === "input:BuiltInMicrophoneDevice");
    // An empty block makes the chunk insert throw after the file row was written.
    expect(() => importer.handle({ ...commit, sampleCount: 0 })).toThrow(RangeError);
    expect(count(db, "spool_files")).toBe(0);
    expect(importer.handle(commit).statuses).toEqual(["inserted", "inserted"]);
    expect(count(db, "chunks")).toBe(1);
  });

  it("carries host ticks above 2^53 to the database exactly, on replay too", () => {
    const ticks = 9_007_199_254_740_993n;
    importer.handle(fixture("ready"));
    const open = fixture("track.open", (e) => e.trackKey === "input:BuiltInMicrophoneDevice");
    const bigOpen = { ...open, anchor: { ...open.anchor, hostTicks: ticks } };
    const commit = fixture("commit", (e) => e.trackKey === "input:BuiltInMicrophoneDevice");
    const bigCommit = { ...commit, at: { ...commit.at, hostTicks: ticks } };
    for (let pass = 0; pass < 2; pass++) {
      importer.handle(bigOpen);
      importer.handle(bigCommit);
    }
    const text = (sql: string) => db.statement(sql).get()?.["v"];
    expect(text("SELECT cast(anchor_host_ticks AS text) AS v FROM epochs")).toBe(String(ticks));
    expect(text("SELECT cast(host_ticks AS text) AS v FROM chunks")).toBe(String(ticks));
    expect(count(db, "chunks")).toBe(1);
  });

  it("reconciles the spool at the end of a snapshot, and at the next commit after a failure", () => {
    const spool = mkdtempSync(join(tmpdir(), "sondine-importer-"));
    try {
      const withSpool = createCaptureImporter(db, {
        spoolDir: "spool",
        spoolRoot: spool,
        now: () => 1_793_610_100_000,
      });
      withSpool.handle(fixture("ready"));
      withSpool.handle(
        fixture("track.open", (e) => e.trackKey === "input:BuiltInMicrophoneDevice"),
      );
      expect(withSpool.handle({ type: "ack", replyTo: "c3" }).reconciled).toMatchObject({
        runsClosed: 0,
        problems: [],
      });
      const commit = fixture("commit", (e) => e.trackKey === "input:BuiltInMicrophoneDevice");
      expect(withSpool.handle(commit).reconciled).toBeUndefined();
      // The same block with another checksum cannot be imported.
      expect(() => withSpool.handle({ ...commit, crc32: commit.crc32 + 1 })).toThrow(
        ImportConflictError,
      );
      const next = {
        ...commit,
        committedOffset: commit.committedOffset + commit.sampleCount * 2,
        sampleIndex: commit.sampleIndex + commit.sampleCount,
      };
      expect(withSpool.handle(next).reconciled).toBeDefined();
      expect(
        withSpool.handle({
          ...next,
          committedOffset: next.committedOffset + next.sampleCount * 2,
          sampleIndex: next.sampleIndex + next.sampleCount,
        }).reconciled,
      ).toBeUndefined();
    } finally {
      rmSync(spool, { recursive: true, force: true });
    }
  });

  it("waits for the snapshot before reconciling after dropped events", () => {
    const spool = mkdtempSync(join(tmpdir(), "sondine-importer-"));
    try {
      const withSpool = createCaptureImporter(db, { spoolDir: "spool", spoolRoot: spool });
      const ready = fixture("ready");
      const open = fixture("track.open", (e) => e.trackKey === "input:BuiltInMicrophoneDevice");
      withSpool.handle(ready);
      withSpool.handle(open);
      // Core reconnects to the same helper; its backlog overflowed meanwhile and the
      // warning comes before the snapshot names the live runs.
      withSpool.handle(ready);
      expect(
        withSpool.handle({ type: "warning", code: "events.dropped", message: "12 events" })
          .reconciled,
      ).toBeUndefined();
      withSpool.handle({ ...open, replyTo: "c3" });
      expect(withSpool.handle({ type: "ack", replyTo: "c3" }).reconciled).toMatchObject({
        runsClosed: 0,
      });
      expect(db.statement("SELECT state FROM track_runs").all()).toEqual([{ state: "open" }]);
    } finally {
      rmSync(spool, { recursive: true, force: true });
    }
  });

  it("vouches for runs once the snapshot is reconciled, minus the runs with problems", () => {
    const spool = mkdtempSync(join(tmpdir(), "sondine-importer-"));
    try {
      const withSpool = createCaptureImporter(db, { spoolDir: "spool", spoolRoot: spool });
      const open = fixture("track.open", (e) => e.trackKey === "input:BuiltInMicrophoneDevice");
      expect(withSpool.reconciliation().reconciled).toBe(false);
      withSpool.handle(fixture("ready"));
      withSpool.handle(open);
      expect(withSpool.reconciliation()).toMatchObject({ reconciled: false });
      // A run only its unreadable manifest knows.
      const broken = "6f1c2a4e-8b3d-4c5e-9f10-2a3b4c5d6e7f";
      mkdirSync(join(spool, "input-Gone", broken), { recursive: true });
      writeFileSync(join(spool, "input-Gone", broken, "0000.jsonl"), "not json\n");
      withSpool.handle({ type: "ack", replyTo: "c3" });
      const state = withSpool.reconciliation();
      expect(state.reconciled).toBe(true);
      expect([...state.liveRuns]).toEqual([open.runId]);
      expect([...state.problemRuns]).toEqual([broken]);
      // A new helper session must be reconciled again.
      withSpool.handle({ ...fixture("ready"), sessionId: "99999999-2222-4333-8444-555555555555" });
      expect(withSpool.reconciliation()).toMatchObject({ reconciled: false });
      expect(withSpool.reconciliation().problemRuns.size).toBe(0);
    } finally {
      rmSync(spool, { recursive: true, force: true });
    }
  });

  it("vouches for nothing when the spool cannot be listed", () => {
    const dir = mkdtempSync(join(tmpdir(), "sondine-importer-"));
    try {
      const notADirectory = join(dir, "spool");
      writeFileSync(notADirectory, "");
      const withSpool = createCaptureImporter(db, { spoolDir: "spool", spoolRoot: notADirectory });
      withSpool.handle(fixture("ready"));
      withSpool.handle({ type: "ack", replyTo: "c3" });
      expect(withSpool.reconciliation().reconciled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses rotation indexes from spool file names", () => {
    expect(spoolSeq("input-X/abc/0003.pcm")).toBe(3);
    expect(() => spoolSeq("input-X/abc/data.raw")).toThrow(RangeError);
  });
});
