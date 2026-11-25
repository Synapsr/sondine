import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { webPageOf } from "@sondine/core";
import {
  endWebPlay,
  listEpisodes,
  notePlaying,
  noteStopped,
  recordSelfEcho,
  setDictationApp,
  syncZoneSpans,
  startWebPlay,
  upsertApp,
} from "@sondine/db";
import { PROTOCOL_VERSION, type ReadyEvent } from "@sondine/protocol";
import { Boot, rows, scalar, tempDb, type TempDb } from "../../../test/capture-fixture";
import { episodeSummaries } from "../api-services";
import { createCaptureImporter } from "../capture/capture-importer";
import { runEpisodePass } from "./episode-pass";

const BOOT = Date.UTC(2026, 10, 5, 8, 0, 0);

let temp: TempDb;
let boot: Boot;
beforeEach(() => {
  temp = tempDb();
  boot = new Boot(temp.db, BOOT);
});
afterEach(() => temp.cleanup());

const pass = (sec: number, fullScan = false) =>
  runEpisodePass(temp.db, { nowMs: boot.wallMs(sec), fullScan });

function episodes() {
  return rows(
    temp.db,
    `SELECT id, state, input_generation, size, size_state, context, started_at_ms, ended_at_ms,
       voiced_ms, analysis_state, grouping_key
     FROM episodes ORDER BY started_at_ms, id`,
  );
}

const members = (episodeId: number | bigint | string | null | undefined | Uint8Array) =>
  rows(
    temp.db,
    "SELECT speech_region_id FROM episode_regions WHERE episode_id = ? ORDER BY speech_region_id",
    Number(episodeId),
  ).map((row) => row["speech_region_id"]);

/** The `ready` of a helper session (the reply to `hello`). */
const helperReady = (sessionId: string): ReadyEvent => ({
  type: "ready",
  replyTo: "hello",
  protocol: PROTOCOL_VERSION,
  sessionId,
  helper: { version: "0.1.0", build: "1" },
  os: { version: "27.0.1", build: "26A434" },
  timebase: { numer: 125, denom: 3 },
  paused: { microphone: false, systemAudio: false },
  capabilities: { appTaps: false, maxAppTaps: 0, vad: { engine: "silero", version: "6.2" } },
});

describe("episode builder pass", () => {
  it("keeps an episode open until the gap and the import watermark pass, then closes and queues it", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 60);
    const a = boot.region(mic, 10, 20);
    const b = boot.region(mic, 30, 40);

    const first = pass(60);
    expect(first.created).toHaveLength(1);
    expect(first.openAfter).toBe(1);
    const [open] = episodes();
    expect(open).toMatchObject({
      state: "open",
      context: "in_person",
      size: "moment",
      size_state: "provisional",
      started_at_ms: boot.wallMs(10),
      ended_at_ms: boot.wallMs(40),
      voiced_ms: 20_000,
      grouping_key: String(a),
    });
    expect(members(open?.["id"])).toEqual([a, b]);

    // 60 s after the last speech grouping closes it, but the mic is imported up to 60 s only.
    expect(pass(100).closed).toEqual([]);
    expect(episodes()[0]?.["state"]).toBe("open");

    boot.chunks(mic, 60, 90);
    const closing = pass(100);
    expect(closing.closed).toEqual([open?.["id"]]);
    expect(closing.enqueued).toEqual([{ episodeId: open?.["id"], outcome: "created" }]);
    expect(episodes()[0]).toMatchObject({
      state: "closed",
      size: "moment",
      size_state: "final",
      analysis_state: "queued",
    });
    expect(scalar(temp.db, "SELECT priority FROM jobs")).toBe(30);
    // Closed episodes leave the window: another pass changes nothing.
    expect(pass(200)).toMatchObject({ created: [], closed: [], bumped: [], regions: 0 });
  });

  it("keeps identity across passes and bumps the generation only when the region set changes", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 120);
    boot.region(mic, 10, 20);
    pass(25);
    const [episode] = episodes();
    const id = episode?.["id"];
    expect(episode?.["input_generation"]).toBe(1);

    expect(pass(26)).toMatchObject({ created: [], bumped: [], deleted: [] });
    expect(episodes()[0]).toMatchObject({ id, input_generation: 1 });

    boot.region(mic, 30, 40);
    expect(pass(41)).toMatchObject({ created: [], bumped: [id] });
    expect(episodes()[0]).toMatchObject({ id, input_generation: 2 });

    // An open region joins; closing it later is not a change of region set or slice.
    boot.region(mic, 50, null);
    expect(pass(52).bumped).toEqual([id]);
    expect(episodes()[0]).toMatchObject({ id, input_generation: 3, ended_at_ms: null });
    boot.close(mic, 50, 55);
    expect(pass(56).bumped).toEqual([]);
    expect(episodes()[0]).toMatchObject({
      id,
      input_generation: 3,
      ended_at_ms: boot.wallMs(55),
    });
    expect(episodes()).toHaveLength(1);
  });

  it("splits at the grouping gap and keeps the earlier episode's id", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 300);
    boot.region(mic, 10, 20);
    pass(21);
    const id = episodes()[0]?.["id"];
    const late = boot.region(mic, 100, 110);
    const report = pass(111);
    expect(report.closed).toEqual([id]);
    expect(report.created).toHaveLength(1);
    const [first, second] = episodes();
    expect(first).toMatchObject({ id, state: "closed" });
    expect(second).toMatchObject({ state: "open" });
    expect(members(second?.["id"])).toEqual([late]);
  });

  it("merges two open episodes when a lagging track bridges them; the larger keeps its id", () => {
    const mic = boot.run({ startSec: 0 });
    const usb = boot.run({ trackKey: "input:USBMic", startSec: 0 });
    boot.chunks(mic, 0, 200);
    // The USB mic is imported only up to 30 s: it holds the first episode open.
    boot.chunks(usb, 0, 30);
    boot.region(mic, 10, 15);
    boot.region(mic, 16, 20);
    boot.region(mic, 80, 90);
    pass(100);
    const [first, second] = episodes();
    expect(first).toMatchObject({ state: "open" });
    expect(second).toMatchObject({ state: "open" });

    // Its import catches up with speech between the two.
    boot.chunks(usb, 30, 200);
    boot.region(usb, 40, 60);
    const report = pass(101);
    expect(report.deleted).toEqual([second?.["id"]]);
    const after = episodes();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: first?.["id"], input_generation: 2 });
    expect(members(first?.["id"])).toHaveLength(4);
  });

  it("joins a late region inside a closed episode, bumps its generation, and queues it again", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 200);
    boot.region(mic, 10, 20);
    boot.region(mic, 30, 40);
    pass(120);
    const [closed] = episodes();
    expect(closed).toMatchObject({ state: "closed", input_generation: 1 });
    const jobId = scalar(temp.db, "SELECT id FROM jobs");

    // Recovered from a manifest: no continuous clock, placed by its chunk.
    const late = boot.region(mic, 24, 27, { clocks: false });
    const routine = pass(130);
    expect(routine.repaired).toEqual([closed?.["id"]]);
    expect(routine.enqueued).toEqual([{ episodeId: closed?.["id"], outcome: "updated" }]);
    expect(episodes()[0]).toMatchObject({
      id: closed?.["id"],
      state: "closed",
      input_generation: 2,
      voiced_ms: 23_000,
    });
    expect(members(closed?.["id"])).toContain(late);
    expect(rows(temp.db, "SELECT id, input_generation, state FROM jobs")).toEqual([
      { id: jobId, input_generation: 2, state: "queued" },
    ]);
    expect(episodes()).toHaveLength(1);
  });

  it("never mixes boots, whose continuous clocks restart at zero", () => {
    const first = boot.run({ startSec: 3_000 });
    boot.chunks(first, 3_000, 3_100);
    boot.region(first, 3_010, 3_020);
    boot.endRun(first, 3_100);
    // Next boot 2 h later: its continuous times are lower than the first boot's.
    const next = new Boot(temp.db, BOOT + 2 * 3_600_000);
    const run = next.run({ startSec: 0 });
    next.chunks(run, 0, 100);
    next.region(run, 3_015 - 3_000, 3_025 - 3_000);
    const report = runEpisodePass(temp.db, { nowMs: next.wallMs(100), fullScan: true });
    expect(report.created).toHaveLength(2);
    const [a, b] = episodes();
    expect(a).toMatchObject({ state: "closed", started_at_ms: boot.wallMs(3_010) });
    expect(b).toMatchObject({ state: "closed", started_at_ms: next.wallMs(15) });
  });

  it("never repairs an episode with a late region of another boot whose wall clock went back", () => {
    const first = boot.run({ startSec: 3_000 });
    boot.chunks(first, 3_000, 3_100);
    boot.region(first, 3_010, 3_020);
    boot.endRun(first, 3_100);
    pass(3_100, true);
    const [closed] = episodes();
    expect(closed).toMatchObject({ state: "closed", input_generation: 1 });

    // The next boot set its wall clock back: its region's wall times fall inside the closed episode.
    const next = new Boot(temp.db, BOOT + 3_000_000);
    const run = next.run({ startSec: 0 });
    next.chunks(run, 0, 100);
    const late = next.region(run, 12, 18);
    const report = runEpisodePass(temp.db, { nowMs: next.wallMs(100), fullScan: true });
    expect(report.repaired).toEqual([]);
    expect(report.created).toHaveLength(1);
    expect(episodes().find((episode) => episode["id"] === closed?.["id"])).toMatchObject({
      input_generation: 1,
    });
    expect(members(closed?.["id"])).not.toContain(late);
    expect(members(report.created[0])).toEqual([late]);
  });

  it("deletes an open episode whose regions a deletion covered", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 60);
    boot.region(mic, 10, 20);
    pass(21);
    const id = episodes()[0]?.["id"];
    temp.db.client
      .prepare(
        `INSERT INTO deleted_ranges (scope, track_run_id, sample_start, sample_end, wall_start_ms,
           wall_end_ms, origin, created_at_ms)
         VALUES ('track_run', ?, ?, ?, ?, ?, 'app', ?)`,
      )
      .run(
        mic.trackRunId,
        boot.sample(mic, 9),
        boot.sample(mic, 21),
        boot.wallMs(9),
        boot.wallMs(21),
        boot.wallMs(22),
      );
    expect(pass(22).deleted).toEqual([id]);
    expect(episodes()).toHaveLength(0);
  });

  it("makes traces final with a job at the lowest priority", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 100);
    boot.region(mic, 10, 11);
    pass(100);
    expect(episodes()[0]).toMatchObject({
      state: "closed",
      size: "trace",
      size_state: "final",
      analysis_state: "queued",
    });
    expect(rows(temp.db, "SELECT priority, state FROM jobs")).toEqual([
      { priority: 50, state: "queued" },
    ]);
  });
});

describe("voiced time", () => {
  it("sizes on the voice the helper heard, not on the pauses inside its regions", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 120);
    // Six coughs 4 s apart: about 0.5 s regions holding 0.2 s of voice each.
    for (let index = 0; index < 6; index += 1) {
      boot.region(mic, 10 + index * 4, 10.5 + index * 4, { voicedSec: 0.2 });
    }
    pass(120);
    expect(episodes()).toEqual([
      expect.objectContaining({ state: "closed", size: "trace", voiced_ms: 1_200 }),
    ]);
  });

  it("counts the whole span of a region closed before the helper reported its voice", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 120);
    for (let index = 0; index < 6; index += 1) boot.region(mic, 10 + index * 4, 10.5 + index * 4);
    pass(120);
    expect(episodes()).toEqual([
      expect.objectContaining({ state: "closed", size: "moment", voiced_ms: 3_000 }),
    ]);
  });

  it("adds a late region's voice, not its span, when it joins a closed episode", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 200);
    boot.region(mic, 10, 13, { voicedSec: 1 });
    boot.region(mic, 40, 43, { voicedSec: 1 });
    pass(100);
    expect(episodes()[0]).toMatchObject({ state: "closed", voiced_ms: 2_000 });
    // Recovered from a manifest after the episode closed.
    boot.region(mic, 20, 30, { voicedSec: 0.4 });
    pass(200, true);
    expect(episodes()[0]).toMatchObject({ state: "closed", voiced_ms: 2_400 });
  });
});

describe("dictations (grouping/3)", () => {
  it("gives what is said to Hex its own episode, named after it, apart from the talk around it", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 400);
    const talk = boot.region(mic, 10, 20);
    boot.listen("l1", "anomaly.hex", 30, 45);
    const dictated = boot.region(mic, 31, 44);
    // An app that listens without being a dictation app changes nothing.
    boot.listen("l2", "com.example.recorder", 100, 130);
    const heard = boot.region(mic, 105, 125);
    pass(400);
    expect(episodes().map((episode) => [episode["context"], members(episode["id"])])).toEqual([
      ["in_person", [talk]],
      ["dictation", [dictated]],
      ["in_person", [heard]],
    ]);
    temp.db.client.prepare("UPDATE apps SET name = 'Hex' WHERE bundle_id = 'anomaly.hex'").run();
    const listed = episodeSummaries(
      temp.db,
      listEpisodes(temp.db, { fromMs: 0, toMs: boot.wallMs(10_000), limit: 10 }).episodes,
      boot.wallMs(400),
    );
    expect(listed.find((episode) => episode.context === "dictation")?.apps).toEqual([
      { bundleId: "anomaly.hex", name: "Hex" },
    ]);
  });

  it("repairs a closed dictation only with speech said to the same app, during a call too", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 600);
    boot.listen("hex", "anomaly.hex", 30, 60);
    const hex = [boot.region(mic, 31, 34), boot.region(mic, 44, 47)];
    boot.listen("ink", "com.prakashjoshipax.VoiceInk", 200, 240);
    const ink = [boot.region(mic, 201, 204), boot.region(mic, 214, 217)];
    boot.call("c1", "us.zoom.xos", 400, 500);
    boot.listen("hex-in-call", "anomaly.hex", 402, 450);
    const inCall = [boot.region(mic, 405, 408), boot.region(mic, 430, 433)];
    const talk = [boot.region(mic, 460, 463), boot.region(mic, 480, 483)];
    pass(600);
    const ids = () => episodes().map((episode) => [episode["context"], members(episode["id"])]);
    expect(ids()).toEqual([
      ["dictation", hex],
      ["dictation", ink],
      ["dictation", inCall],
      ["call", talk],
    ]);
    // Recovered after they closed, inside each: each joins its own lane's episode.
    const lateHex = boot.region(mic, 38, 41);
    const lateInk = boot.region(mic, 208, 211);
    const lateInCall = boot.region(mic, 418, 421);
    const lateTalk = boot.region(mic, 470, 473);
    pass(700, true);
    expect(ids()).toEqual([
      ["dictation", [...hex, lateHex]],
      ["dictation", [...ink, lateInk]],
      ["dictation", [...inCall, lateInCall]],
      ["call", [...talk, lateTalk]],
    ]);
  });

  it("follows the user's rule for an app, from the next grouping on", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 400);
    boot.listen("l1", "anomaly.hex", 30, 45);
    boot.region(mic, 31, 44);
    setDictationApp(temp.db, "anomaly.hex", false, boot.wallMs(40));
    pass(60);
    expect(episodes().map((episode) => episode["context"])).toEqual(["in_person"]);
    setDictationApp(temp.db, "anomaly.hex", true, boot.wallMs(61));
    pass(62);
    // Still open: grouped again under the rule as it is now.
    expect(episodes().map((episode) => [episode["context"], episode["state"]])).toEqual([
      ["dictation", "open"],
    ]);
  });
});

describe("Sondine's own playback", () => {
  it("leaves out the mic speech heard while Sondine played on the speakers, not on headphones", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 600);
    // The player renews every 3 s while it plays.
    const play = (route: "speakers" | "headphones", fromSec: number, toSec: number) => {
      for (let sec = fromSec; sec < toSec; sec += 3) {
        notePlaying(temp.db, { route, nowMs: boot.wallMs(sec) });
      }
      noteStopped(temp.db, boot.wallMs(toSec));
    };
    const before = boot.region(mic, 10, 15);
    play("speakers", 100, 130);
    boot.region(mic, 101, 128);
    play("headphones", 300, 330);
    const talked = boot.region(mic, 305, 320);
    pass(600);
    expect(episodes().map((episode) => members(episode["id"]))).toEqual([[before], [talked]]);
    // A later full pass does not bring it back as a late region.
    pass(700, true);
    expect(episodes().map((episode) => members(episode["id"]))).toEqual([[before], [talked]]);
  });

  it("keeps what someone said over a playback once the reference says so (ADR 035)", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 900);
    for (let sec = 100; sec < 400; sec += 3) {
      notePlaying(temp.db, { route: "speakers", nowMs: boot.wallMs(sec) });
    }
    noteStopped(temp.db, boot.wallMs(400));
    const echo = boot.region(mic, 110, 120);
    const spoke = boot.region(mic, 130, 140);
    const unsure = boot.region(mic, 150, 160);
    const waiting = boot.region(mic, 170, 180);
    const judge = (regionId: number, kind: "echo" | "near-end" | "no-reference") =>
      recordSelfEcho(temp.db, {
        regionId,
        method: "envelope-echo/1",
        kind,
        voicedMs: 8_000,
        coveredMs: 8_000,
        echoMs: kind === "echo" ? 8_000 : 2_000,
        nearEndMs: kind === "near-end" ? 6_000 : 0,
        lagMs: 120,
        correlation: 0.8,
        spans: [],
        judgedAtMs: boot.wallMs(200),
      });
    // Before any verdict, ADR 020's rule: everything heard on the speakers stays out.
    pass(181);
    expect(episodes()).toEqual([]);
    judge(echo, "echo");
    judge(spoke, "near-end");
    judge(unsure, "no-reference");
    pass(182);
    expect(episodes().map((episode) => members(episode["id"]))).toEqual([[spoke]]);
    // Not yet judged, it stays out; judged later, it joins the conversation.
    judge(waiting, "near-end");
    pass(183);
    expect(episodes().map((episode) => members(episode["id"]))).toEqual([[spoke, waiting]]);
  });

  it("brings a region someone spoke in back to a closed episode as a late region", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 1_200);
    const said = boot.region(mic, 50, 55);
    const after = boot.region(mic, 75, 80);
    for (let sec = 58; sec < 72; sec += 3) {
      notePlaying(temp.db, { route: "speakers", nowMs: boot.wallMs(sec) });
    }
    noteStopped(temp.db, boot.wallMs(72));
    const over = boot.region(mic, 60, 70);
    pass(1_000);
    const [closed] = episodes();
    expect(closed).toMatchObject({ state: "closed" });
    expect(members(closed?.["id"])).toEqual([said, after]);
    recordSelfEcho(temp.db, {
      regionId: over,
      method: "envelope-echo/1",
      kind: "near-end",
      voicedMs: 6_000,
      coveredMs: 6_000,
      echoMs: 1_000,
      nearEndMs: 5_000,
      lagMs: 100,
      correlation: 0.7,
      spans: [],
      judgedAtMs: boot.wallMs(1_000),
    });
    const repaired = pass(1_001, true);
    expect(repaired.repaired).toEqual([closed?.["id"]]);
    expect(members(closed?.["id"])).toEqual([said, after, over].toSorted((a, b) => a - b));
  });
});

describe("calls (grouping/3)", () => {
  const ZOOM = "us.zoom.xos";
  const contexts = () => episodes().map((episode) => episode["context"]);
  const system = () => boot.run({ trackKey: "system:other", sourceKind: "system", startSec: 0 });

  it("groups a call's mic and far side into one conversation named after the call app", () => {
    const mic = boot.run({ startSec: 0 });
    const far = system();
    boot.chunks(mic, 0, 400);
    boot.chunks(far, 0, 400);
    boot.call("c1", ZOOM, 100, null);
    const before = boot.region(mic, 20, 25);
    const said = boot.region(mic, 110, 115);
    const heard = boot.region(far, 116, 125);
    const answered = boot.region(mic, 200, 201);

    // Active call: one open call episode while someone speaks within 5 min.
    pass(260);
    expect(contexts()).toEqual(["in_person", "call"]);
    const [inPerson, theCall] = episodes();
    expect(inPerson).toMatchObject({ state: "closed", size: "moment" });
    expect(members(inPerson?.["id"])).toEqual([before]);
    expect(theCall).toMatchObject({ state: "open", size: "conversation" });
    expect(members(theCall?.["id"])).toEqual([said, heard, answered]);

    // It closes once the call ended and the rejoin window passed.
    boot.call("c1", ZOOM, 100, 300);
    expect(pass(340).closed).toEqual([]);
    const closing = pass(346);
    expect(closing.closed).toEqual([theCall?.["id"]]);
    expect(episodes()[1]).toMatchObject({
      state: "closed",
      size: "conversation",
      size_state: "final",
    });
    expect(
      scalar(temp.db, "SELECT priority FROM jobs WHERE episode_id = ?", Number(theCall?.["id"])),
    ).toBe(20);

    temp.db.client.prepare("UPDATE apps SET name = 'zoom.us' WHERE bundle_id = ?").run(ZOOM);
    const listed = episodeSummaries(
      temp.db,
      listEpisodes(temp.db, { fromMs: 0, toMs: boot.wallMs(10_000), limit: 10 }).episodes,
      boot.wallMs(400),
    );
    expect(listed.map((episode) => [episode.context, episode.apps.map((app) => app.name)])).toEqual(
      [
        ["call", ["zoom.us"]],
        ["in_person", []],
      ],
    );
  });

  it("keeps one call across a restart within 45 s, and two calls past it", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 600);
    boot.call("c1", ZOOM, 0, 60);
    boot.call("c2", ZOOM, 90, 150); // 30 s later: the same call
    boot.call("c3", ZOOM, 300, 360); // 150 s later: another call
    boot.region(mic, 10, 20);
    boot.region(mic, 100, 110);
    boot.region(mic, 310, 320);
    pass(600);
    expect(
      episodes().map((episode) => [episode["context"], members(episode["id"]).length]),
    ).toEqual([
      ["call", 2],
      ["call", 1],
    ]);
  });

  it("closes a call's episode after 5 min without speech, the call still on", () => {
    const mic = boot.run({ startSec: 0 });
    const far = system();
    boot.chunks(mic, 0, 1000);
    boot.chunks(far, 0, 1000);
    boot.call("c1", ZOOM, 0, null);
    const first = [boot.region(mic, 10, 15), boot.region(far, 16, 25)];
    const next = boot.region(far, 400, 410);
    pass(420);
    expect(
      episodes().map((episode) => [episode["context"], episode["state"], members(episode["id"])]),
    ).toEqual([
      ["call", "closed", first],
      ["call", "open", [next]],
    ]);
  });

  it("keeps a video another app plays on system:other out of the call", () => {
    const mic = boot.run({ startSec: 0 });
    const far = system();
    boot.chunks(mic, 0, 600);
    boot.chunks(far, 0, 600);
    boot.call("c1", ZOOM, 0, 100);
    const said = boot.region(mic, 10, 20);
    const video = boot.region(far, 30, 60, { attributedTo: "com.apple.Safari" });
    const heard = boot.region(far, 62, 70);
    pass(600);
    expect(contexts()).toEqual(["call", "media"]);
    const [theCall, media] = episodes();
    expect(members(theCall?.["id"])).toEqual([said, heard]);
    expect(members(media?.["id"])).toEqual([video]);
    const listed = episodeSummaries(
      temp.db,
      listEpisodes(temp.db, { fromMs: 0, toMs: boot.wallMs(10_000), limit: 10 }).episodes,
      boot.wallMs(600),
    );
    expect(listed.map((episode) => episode.apps.map((app) => app.bundleId))).toEqual([
      ["com.apple.Safari"],
      ["us.zoom.xos"],
    ]);
  });

  it("leaves a region whose middle falls after the call's end to the lanes outside it", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 600);
    boot.call("c1", ZOOM, 0, 60);
    const inside = boot.region(mic, 50, 66); // middle at 58 s
    const after = boot.region(mic, 56, 70); // middle at 63 s
    pass(600);
    expect(contexts()).toEqual(["call", "in_person"]);
    const [theCall, inPerson] = episodes();
    expect(members(theCall?.["id"])).toEqual([inside]);
    expect(members(inPerson?.["id"])).toEqual([after]);
  });

  it("joins a late region recovered inside a closed call to it", () => {
    const mic = boot.run({ startSec: 0 });
    const far = system();
    boot.chunks(mic, 0, 600);
    boot.chunks(far, 0, 600);
    boot.call("c1", ZOOM, 0, 200);
    boot.region(mic, 10, 20);
    boot.region(far, 150, 160);
    pass(600);
    const [theCall] = episodes();
    expect(theCall).toMatchObject({ context: "call", state: "closed", input_generation: 1 });

    const late = boot.region(far, 80, 90, { clocks: false });
    expect(pass(610).repaired).toEqual([theCall?.["id"]]);
    expect(members(theCall?.["id"])).toContain(late);
    expect(episodes()).toHaveLength(1);
  });

  it("keeps later speech out of a call whose helper died before its next clock", () => {
    // Store: a helper reports a call at 0 s, then dies before vouching for it again.
    const importer = createCaptureImporter(temp.db, {
      spoolDir: "spool",
      now: () => boot.wallMs(1000),
      bootWallMs: () => BOOT,
    });
    importer.handle(helperReady("6f1c2a4e-8b3d-4c5e-9f10-2a3b4c5d6e7f"));
    importer.handle({
      type: "call",
      callId: "60d5bca7-8e9f-42d0-a176-cdae4f506172",
      state: "active",
      at: { hostTicks: 0n, continuousNs: 0n },
      bundleId: ZOOM,
      via: "call-app",
      inputDeviceUid: null,
    });
    // Recover: the next helper's snapshot does not replay it, so it closes at its start.
    importer.handle(helperReady("7a2d3b5f-9c4e-4d6f-8a21-3b4c5d6e7f80"));
    expect(importer.handle({ type: "ack", replyTo: "snapshot" })).toMatchObject({
      spansChanged: 1,
    });
    expect(rows(temp.db, "SELECT started_wall_ms, ended_wall_ms, end_reason FROM calls")).toEqual([
      { started_wall_ms: boot.wallMs(0), ended_wall_ms: boot.wallMs(0), end_reason: "lost" },
    ]);

    // Group: the call is over, and speech 10 s later is in person.
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 1000);
    const speech = boot.region(mic, 10, 12);
    pass(1000);
    expect(episodes()).toMatchObject([{ context: "in_person", state: "closed" }]);
    expect(members(episodes()[0]?.["id"])).toEqual([speech]);
  });

  it("never mixes a call of one boot with the regions of another", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 400);
    boot.region(mic, 50, 60);
    // A call of the next boot (started 200 s later by the wall clock): its
    // continuous clock covers 0 to 300 s again, and its wall times meet the window.
    const next = new Boot(temp.db, BOOT + 200_000);
    next.call("other-boot", ZOOM, 0, 300);
    runEpisodePass(temp.db, { nowMs: boot.wallMs(400), fullScan: true });
    expect(contexts()).toEqual(["in_person"]);
  });
});

describe("pages a browser played (ADR 023)", () => {
  const YAB = "dev.serafim.fast";
  const system = () => boot.run({ trackKey: "system:other", sourceKind: "system", startSec: 0 });
  const play = (url: string, fromSec: number, toSec: number) => {
    const page = webPageOf(url);
    if (page === null) throw new Error(url);
    const appId = upsertApp(temp.db, {
      bundleId: YAB,
      name: "Yab",
      seenAtMs: boot.wallMs(0),
    }).appId;
    const id = startWebPlay(temp.db, {
      appId,
      page,
      url,
      title: "Titre",
      atMs: boot.wallMs(fromSec),
      nowMs: boot.wallMs(fromSec),
    });
    endWebPlay(temp.db, id, boot.wallMs(toSec), boot.wallMs(toSec));
  };
  const pages = () =>
    rows(temp.db, "SELECT page_key, state FROM episodes ORDER BY started_at_ms").map(
      (row) => row["page_key"],
    );

  it("gives two videos in a row two episodes, each with its page", () => {
    const far = system();
    boot.chunks(far, 0, 400);
    play("https://www.youtube.com/watch?v=a", 0, 60);
    play("https://www.youtube.com/watch?v=b", 60, 120);
    boot.region(far, 10, 50, { attributedTo: YAB });
    boot.region(far, 70, 110, { attributedTo: YAB });
    // Another app's sound plays no page.
    boot.region(far, 200, 210, { attributedTo: "com.apple.Music" });
    pass(400);
    expect(pages()).toEqual(["youtube.com/watch?v=a", "youtube.com/watch?v=b", null]);
    expect(episodes().map((episode) => episode["context"])).toEqual(["media", "media", "media"]);
  });

  it("gives speech macOS named no app for the one page that played then", () => {
    const far = system();
    boot.chunks(far, 0, 600);
    play("https://www.youtube.com/watch?v=a", 0, 60);
    // No attribution: several apps held their output open.
    boot.region(far, 10, 50);
    // Two pages at once: nothing tells which one spoke.
    play("https://www.youtube.com/watch?v=b", 200, 260);
    play("https://example.org/radio", 200, 260);
    boot.region(far, 210, 250);
    pass(600);
    expect(pages()).toEqual(["youtube.com/watch?v=a", null]);
  });

  it("never gives system:other the page of a browser on its own track (ADR 026)", () => {
    const far = system();
    boot.chunks(far, 0, 400);
    // Yab plays Netflix on its own track; something without an app speaks on system:other.
    const yab = boot.run({ trackKey: `app:${YAB}`, sourceKind: "app", bundleId: YAB, startSec: 0 });
    boot.chunks(yab, 0, 120);
    play("https://www.netflix.com/watch/81", 0, 120);
    // Netflix is left out by default: its zone is on from the start (ADR 029).
    syncZoneSpans(temp.db, boot.wallMs(0));
    boot.region(far, 10, 50);
    const report = pass(400);
    expect(report.dropped.episodeIds).toEqual([]);
    expect(pages()).toEqual([null]);
  });

  it("deletes an episode of a site left out when it closes, before it is transcribed", () => {
    const far = system();
    boot.chunks(far, 0, 400);
    play("https://www.netflix.com/watch/81", 0, 100);
    play("https://www.youtube.com/watch?v=a", 150, 250);
    boot.region(far, 10, 50, { attributedTo: YAB });
    boot.region(far, 160, 200, { attributedTo: YAB });
    // Netflix is left out by default: its zone is on from the start (ADR 029).
    syncZoneSpans(temp.db, boot.wallMs(0));
    const report = pass(400);
    expect(report.dropped.episodeIds).toHaveLength(1);
    expect(report.dropped.chunks.length).toBeGreaterThan(0);
    expect(pages()).toEqual(["youtube.com/watch?v=a"]);
    // Only the kept episode waits for its transcript.
    expect(scalar(temp.db, "SELECT count(*) AS n FROM jobs WHERE state = 'queued'")).toBe(1);
  });
});
