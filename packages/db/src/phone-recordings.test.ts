import { DAY_MS } from "@sondine/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importRecording, type ImportedChunk, type PhoneOrigin } from "./audio-import";
import { deleteEpisode } from "./delete-episode";
import { episodeNeighbours, mergeEpisodes, splitEpisode } from "./episode-boundaries";
import { setEpisodeKind } from "./episode-kind";
import { episodesInRange, forgetRange, phoneRecordingsInRange } from "./forget-range";
import {
  loadJournalItems,
  publishJournalRun,
  setJournalMark,
  startJournalRun,
  type JournalItemInput,
} from "./journal";
import { loadJournalSource } from "./journal-input";
import { JOURNAL_TRIGGERS } from "./journal-triggers";
import { phoneArrival, PhoneRecordingRefused } from "./phone-recordings";
import { audioExpiryDue, episodePrivacy, recordingsToDelete } from "./privacy-policy";
import { addZone, durationsSince, setDuration, updateZone } from "./privacy-zones";
import { publishAnalysis } from "./publish";
import {
  count,
  rate,
  seedEpisode,
  segment,
  startRun,
  t0,
  tempDatabase,
  turn,
  type TempDatabase,
} from "./test-helpers";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const s = (seconds: number) => t0 + seconds * 1000;
const zone = "Europe/Paris";
const key = "engine@1|model@1|journal-prompt/1";
const day = { fromMs: t0 - 3_600_000, toMs: t0 + 3_600_000 };
let uid = 0;

/** 2 s blocks over `seconds` of audio, as the import writes them. */
function blocks(seconds: number): ImportedChunk[] {
  const out: ImportedChunk[] = [];
  for (let start = 0; start < seconds * rate; start += 2 * rate) {
    const sampleCount = Math.min(2 * rate, seconds * rate - start);
    out.push({ sampleStart: start, sampleCount, byteOffset: start * 2, crc32: 0 });
  }
  return out;
}

const origin = (recordingId: string, sha256 = "a".repeat(64)): PhoneOrigin => ({
  recordingId,
  deviceId: "c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b",
  sha256,
  timeUncertain: false,
});

/** A file imported as the phone recorded it, `seconds` long from t0; null `phone`: an ordinary import. */
function imported(
  seconds: number,
  phone: PhoneOrigin | null,
  nowMs = s(3_600),
): { episodeId: number; trackRunId: number } {
  uid += 1;
  return importRecording(temp.db, {
    uid: `import-${uid}`,
    fileName: `file-${uid}.m4a`,
    sampleRate: rate,
    sampleCount: seconds * rate,
    startedWallMs: t0,
    archiveRelPath: `archive/imports/import-${uid}/0001.pcm`,
    spoolRelPath: `spool/imports/import-${uid}/0001.pcm`,
    chunks: blocks(seconds),
    nowMs,
    ...(phone === null ? {} : { phone }),
  });
}

/** Publishes a transcript of three sentences, 10–35 s, with a promise in the middle. */
function transcribe(episodeId: number, trackRunId: number, word: string): number[] {
  const runId = startRun(temp.db, episodeId, "asr");
  expect(
    publishAnalysis(temp.db, {
      episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments: [
        segment(trackRunId, 10, 15, `on parle du budget ${word}`, "A"),
        segment(trackRunId, 20, 25, `je t'envoie le devis ${word} demain`, "B"),
        segment(trackRunId, 30, 35, "parfait merci", "A"),
      ],
      turns: [
        turn(trackRunId, 10, 15, "A"),
        turn(trackRunId, 20, 25, "B"),
        turn(trackRunId, 30, 35, "A"),
      ],
    }).published,
  ).toBe(true);
  return temp.db.client
    .prepare("SELECT id FROM segments WHERE episode_id = ? ORDER BY start_ms")
    .all(episodeId)
    .map((row) => Number(row["id"]));
}

/** Writes the journal of an episode: an event and a commitment, then marks the commitment done. */
function journal(episodeId: number, segmentIds: readonly number[], word: string): void {
  const source = loadJournalSource(temp.db, episodeId, zone, s(100));
  if (source === null) throw new Error("no source");
  const runId = startJournalRun(temp.db, {
    episodeId,
    asrRunId: source.asrRunId,
    inputHash: source.inputHash,
    configKey: key,
    engineId: "engine",
    modelSha256: "sha",
    speakerRefs: { P1: "A", P2: "B" },
    nowMs: s(100),
  });
  const items: JournalItemInput[] = [
    {
      kind: "event",
      text: `On a parlé du budget ${word}`,
      whoRef: null,
      toRef: null,
      due: null,
      dueText: null,
      segmentIds: [segmentIds[0] ?? 0],
    },
    {
      kind: "commitment",
      text: `envoyer le devis ${word}`,
      whoRef: "P2",
      toRef: "P1",
      due: null,
      dueText: null,
      segmentIds: [segmentIds[1] ?? 0],
    },
  ];
  publishJournalRun(temp.db, { runId, items, metrics: {}, timeZone: zone, nowMs: s(110) });
  const commitment = loadJournalItems(temp.db, day).find(
    (item) => item.kind === "commitment" && item.text.includes(word),
  );
  expect(
    setJournalMark(
      temp.db,
      { itemId: commitment?.itemId ?? null, markId: null },
      { status: "done" },
      s(150),
    ),
  ).toMatchObject({ ok: true });
}

/** A Mac conversation and a phone recording of the same minutes (10–40 s and 0–60 s). */
function sameMinutes() {
  const mac = seedEpisode(temp.db, [[10, 40]]);
  temp.db
    .statement("UPDATE episodes SET size = 'conversation', context = 'in_person' WHERE id = ?")
    .run(mac.episodeId);
  const phone = imported(60, origin("7f9c2b1e-4d3a-4c8e-9b6f-1a2b3c4d5e6f"));
  return { mac, phone };
}

describe("a phone recording arriving", () => {
  it("is an in-person conversation on a run keyed by its id, remembered by that id", () => {
    const { episodeId, trackRunId } = imported(60, origin("7f9c2b1e-4d3a-4c8e-9b6f-1a2b3c4d5e6f"));
    expect(
      temp.db.client
        .prepare("SELECT context, label, state FROM episodes WHERE id = ?")
        .get(episodeId),
    ).toEqual({ context: "in_person", label: null, state: "closed" });
    expect(
      temp.db.client
        .prepare("SELECT track_key, source_kind FROM track_runs WHERE id = ?")
        .get(trackRunId),
    ).toEqual({ track_key: "phone:7f9c2b1e-4d3a-4c8e-9b6f-1a2b3c4d5e6f", source_kind: "phone" });
    expect(temp.db.client.prepare("SELECT * FROM phone_recordings").all()).toEqual([
      {
        recording_id: "7f9c2b1e-4d3a-4c8e-9b6f-1a2b3c4d5e6f",
        device_id: "c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b",
        state: "stored",
        track_run_id: trackRunId,
        sha256: "a".repeat(64),
        time_uncertain: 0,
        name: null,
        name_typed_at_ms: null,
        received_at_ms: s(3_600),
        deleted_at_ms: null,
      },
    ]);
    // Transcribed as a request, as imports are.
    expect(count(temp.db, "jobs", "state = 'queued' AND priority = 10")).toBe(1);
  });

  it("is one recording when the same file comes twice; other bytes or a deleted id are refused", () => {
    const id = "7f9c2b1e-4d3a-4c8e-9b6f-1a2b3c4d5e6f";
    const first = imported(10, origin(id));
    expect(phoneArrival(temp.db, origin(id))).toEqual({
      kind: "duplicate",
      episodeId: first.episodeId,
    });
    expect(phoneArrival(temp.db, origin(id, "b".repeat(64)))).toEqual({ kind: "conflict" });
    // Refused again inside the transaction that would publish it: nothing is written.
    expect(() => imported(10, origin(id))).toThrow(PhoneRecordingRefused);
    expect(() => imported(10, origin(id, "b".repeat(64)))).toThrow(PhoneRecordingRefused);
    expect(count(temp.db, "episodes")).toBe(1);
    expect(count(temp.db, "track_runs")).toBe(1);

    expect(
      deleteEpisode(temp.db, first.episodeId, { origin: "app", nowMs: s(4_000) }).deleted,
    ).toBe(true);
    // A tombstone: the id, the device and two times, nothing of the audio, no name.
    expect(temp.db.client.prepare("SELECT * FROM phone_recordings").all()).toEqual([
      {
        recording_id: id,
        device_id: "c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b",
        state: "deleted",
        track_run_id: null,
        sha256: null,
        time_uncertain: 0,
        name: null,
        name_typed_at_ms: null,
        received_at_ms: s(3_600),
        deleted_at_ms: s(4_000),
      },
    ]);
    expect(phoneArrival(temp.db, origin(id))).toEqual({ kind: "deleted" });
    let refusal: unknown;
    try {
      imported(10, origin(id));
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(PhoneRecordingRefused);
    expect(refusal instanceof PhoneRecordingRefused ? refusal.arrival : null).toEqual({
      kind: "deleted",
    });
    expect(count(temp.db, "episodes")).toBe(0);
  });

  it("keeps a file without the header an import, as before", () => {
    const { episodeId } = imported(10, null);
    expect(
      temp.db.client.prepare("SELECT context FROM episodes WHERE id = ?").get(episodeId),
    ).toEqual({ context: "imported" });
    expect(count(temp.db, "phone_recordings")).toBe(0);
  });
});

describe("a Mac recording and a phone recording of the same minutes", () => {
  it("forget lists and deletes the Mac's only, and names the phone's as staying", () => {
    const { mac, phone } = sameMinutes();
    expect(episodesInRange(temp.db, s(0), s(120)).map((episode) => episode.id)).toEqual([
      mac.episodeId,
    ]);
    expect(phoneRecordingsInRange(temp.db, s(0), s(120)).map((episode) => episode.id)).toEqual([
      phone.episodeId,
    ]);
    const result = forgetRange(temp.db, { fromWallMs: s(0), toWallMs: s(120), origin: "app" });
    expect(result.episodeIds).toEqual([mac.episodeId]);
    expect(count(temp.db, "episodes")).toBe(1);
    expect(
      count(temp.db, "chunks", `track_run_id = ${phone.trackRunId} AND audio_state = 'archived'`),
    ).toBe(30);
    expect(count(temp.db, "phone_recordings", "state = 'stored'")).toBe(1);
  });

  it("forget keeps the phone recording's journal lines and its marks' words", () => {
    const { mac, phone } = sameMinutes();
    journal(mac.episodeId, transcribe(mac.episodeId, mac.trackRunId, "mac"), "mac");
    journal(phone.episodeId, transcribe(phone.episodeId, phone.trackRunId, "phone"), "phone");
    const generated = (word: string) =>
      temp.db.client
        .prepare("SELECT generated_text FROM journal_marks WHERE generated_text LIKE ?")
        .all(`%${word}%`).length;
    expect(generated("mac")).toBe(1);
    expect(generated("phone")).toBe(1);

    forgetRange(temp.db, { fromWallMs: s(0), toWallMs: s(120), origin: "app" });
    const lines = loadJournalItems(temp.db, day).map((item) => item.text);
    expect(lines).toEqual(["On a parlé du budget phone", "envoyer le devis phone"]);
    expect(generated("mac")).toBe(0);
    expect(generated("phone")).toBe(1);
    expect(count(temp.db, "segments", `episode_id = ${phone.episodeId}`)).toBe(3);
  });

  it("a deletion inside the phone recording still reaches its own marks", () => {
    const { phone } = sameMinutes();
    journal(phone.episodeId, transcribe(phone.episodeId, phone.trackRunId, "phone"), "phone");
    deleteEpisode(temp.db, phone.episodeId, { origin: "app", nowMs: s(200) });
    expect(
      temp.db.client
        .prepare("SELECT count(*) AS n FROM journal_marks WHERE generated_text <> ''")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("the phone recording cannot be split or merged, and is no one's neighbour", () => {
    const { mac, phone } = sameMinutes();
    const later = seedEpisode(temp.db, [[100, 110]], mac.trackRunId);
    expect(
      splitEpisode(temp.db, { episodeId: phone.episodeId, atMs: s(30), nowMs: s(200) }),
    ).toEqual({ ok: false, reason: "kept-whole" });
    expect(
      mergeEpisodes(temp.db, { episodeId: mac.episodeId, otherId: phone.episodeId, nowMs: s(200) }),
    ).toMatchObject({ ok: false });
    expect(episodeNeighbours(temp.db, phone.episodeId)).toEqual({ previous: null, next: null });
    expect(episodeNeighbours(temp.db, mac.episodeId)).toEqual({
      previous: null,
      next: later.episodeId,
    });
    // « Type ▸ » stays: its durations follow the type.
    expect(
      setEpisodeKind(temp.db, { episodeId: phone.episodeId, kind: "moment", nowMs: s(200) }),
    ).toBe(true);
  });

  it("a zone over those minutes takes nothing from the phone recording", () => {
    const { mac, phone } = sameMinutes();
    const everyHour = addZone(
      temp.db,
      {
        kind: "hours",
        name: "Toujours",
        windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1440 }],
      },
      t0 - 60_000,
    );
    updateZone(temp.db, everyHour.id, { outcome: "nothing" }, t0 - 60_000);
    const privacy = episodePrivacy(temp.db, [mac.episodeId, phone.episodeId], s(200));
    expect(privacy.get(mac.episodeId)?.zones.map((zone) => zone.zoneId)).toEqual([everyHour.id]);
    expect(privacy.get(mac.episodeId)?.keeping.text).toBe(false);
    expect(privacy.get(phone.episodeId)?.zones).toEqual([]);
    expect(privacy.get(phone.episodeId)?.keeping).toEqual({
      text: true,
      audio: true,
      deleteAfterMs: null,
    });
  });
});

describe("a phone recording's durations", () => {
  it("count from its arrival on the Mac when it came later than it ended", () => {
    durationsSince(temp.db, t0 - DAY_MS);
    setDuration(temp.db, "conversations", { deleteDays: 7, audioDays: 30 }, t0);
    // Recorded at t0, synced ten days later.
    const late = imported(60, origin("7f9c2b1e-4d3a-4c8e-9b6f-1a2b3c4d5e6f"), t0 + 10 * DAY_MS);
    temp.db.statement("UPDATE episodes SET size = 'conversation' WHERE id = ?").run(late.episodeId);
    const mac = seedEpisode(temp.db, [[10, 40]]);
    temp.db
      .statement("UPDATE episodes SET size = 'conversation', context = 'in_person' WHERE id = ?")
      .run(mac.episodeId);
    expect(recordingsToDelete(temp.db, t0 + 8 * DAY_MS).ids).toEqual([mac.episodeId]);
    expect(recordingsToDelete(temp.db, t0 + 16 * DAY_MS).ids).toEqual([mac.episodeId]);
    expect(recordingsToDelete(temp.db, t0 + 18 * DAY_MS).ids.toSorted()).toEqual(
      [mac.episodeId, late.episodeId].toSorted(),
    );
    const cap = Number.MAX_SAFE_INTEGER;
    // Recorded before durations began, arrived after: its arrival counts, not the update.
    const older = imported(60, origin("8a0d3c2f-5e4b-4d9f-8c70-2b3c4d5e6f70"), t0 + 10 * DAY_MS);
    temp.db
      .statement("UPDATE episodes SET size = 'conversation' WHERE id = ?")
      .run(older.episodeId);
    temp.db
      .statement("UPDATE episodes SET started_at_ms = ?, ended_at_ms = ? WHERE id = ?")
      .run(t0 - 5 * DAY_MS, t0 - 5 * DAY_MS + 60_000, older.episodeId);
    expect(
      audioExpiryDue(temp.db, { nowMs: t0 + 39 * DAY_MS, capBytes: cap }).episodeIds,
    ).not.toContain(older.episodeId);
    expect(
      audioExpiryDue(temp.db, { nowMs: t0 + 39 * DAY_MS, capBytes: cap }).episodeIds,
    ).not.toContain(late.episodeId);
    expect(
      audioExpiryDue(temp.db, { nowMs: t0 + 70 * DAY_MS, capBytes: cap }).episodeIds,
    ).toContain(late.episodeId);
  });
});

describe("the journal's triggers", () => {
  it("are replaced when an older build left another body under the same name", () => {
    temp.db.client.exec("DROP TRIGGER journal_mark_tombstone");
    temp.db.client.exec(
      "CREATE TRIGGER journal_mark_tombstone AFTER INSERT ON deleted_ranges BEGIN SELECT 1; END",
    );
    const again = temp.reopen();
    const body = again.client
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'journal_mark_tombstone'",
      )
      .get()?.["sql"];
    const current = JOURNAL_TRIGGERS.find((trigger) => trigger.includes("journal_mark_tombstone"));
    expect(body).toBe(current?.replace("IF NOT EXISTS ", ""));
  });
});
