import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "./database";
import { deletePerson, mergePeople, nameSpeaker, resolveSpeakers, unnameSpeaker } from "./people";
import { publishAnalysis } from "./publish";
import {
  at,
  count,
  seedEpisode,
  segment,
  startRun,
  t0,
  tempDatabase,
  turn,
  type TempDatabase,
} from "./test-helpers";
import {
  decideVoice,
  doubtedNames,
  episodeRecognized,
  exclusiveSpeech,
  forgetUnnamedVoices,
  mergeVoice,
  mergeVoices,
  learnsFromDictations,
  measuredChannels,
  PHONE_VOICES_MEASURED,
  recognizedVoices,
  shownSelf,
  recognizeVoice,
  setLearnFromDictations,
  voiceConfidence,
  voiceLikeness,
  refuseSuggestion,
  runsNeedingLinks,
  runsNeedingVoices,
  storeVoicePass,
  unnamedVoices,
  voicesOfRun,
  voicesPrint,
  voiceMatches,
  type VoiceMatch,
} from "./voices";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

type Turn = readonly [start: number, end: number, label: string];

function publish(episodeId: number, trackRunId: number, turns: readonly Turn[]): number {
  const runId = startRun(temp.db, episodeId, "asr");
  const result = publishAnalysis(temp.db, {
    episodeId,
    stage: "asr",
    runId,
    inputGeneration: 1,
    segments: turns.map(([start, end, label]) => segment(trackRunId, start, end, "mot", label)),
    turns: turns.map(([start, end, label]) => turn(trackRunId, start, end, label)),
  });
  expect(result.published).toBe(true);
  return runId;
}

/** A segment with a time for each of its words, spread over its span. */
function timed<T extends { text: string; startMs: number; endMs: number }>(spoken: T) {
  const words = spoken.text.split(" ");
  const step = (spoken.endMs - spoken.startMs) / words.length;
  let charStart = 0;
  return {
    ...spoken,
    words: words.map((word, index) => {
      const timing = {
        charStart,
        charEnd: charStart + word.length,
        startMs: Math.round(index * step),
        endMs: Math.round((index + 1) * step),
      };
      charStart += word.length + 1;
      return timing;
    }),
  };
}

/** A unit vector pointing mostly along `axis`, a little along `lean`. */
function voice(axis: number, lean = (axis + 1) % 256, amount = 0): number[] {
  const vector = Array.from({ length: 256 }, () => 0);
  vector[axis] = Math.sqrt(1 - amount * amount);
  vector[lean] = amount;
  return vector;
}

function call(start: number) {
  const episode = seedEpisode(temp.db, [[start, start + 40]]);
  temp.db.client
    .prepare("UPDATE episodes SET context = 'call' WHERE id = ?")
    .run(episode.episodeId);
  const runId = publish(episode.episodeId, episode.trackRunId, [
    [start, start + 20, "A"],
    [start + 20, start + 40, "B"],
  ]);
  return { ...episode, runId };
}

describe("exclusive speech", () => {
  it("leaves out other voices' time, then trims each stretch, keeping 1 s or more", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 40]]);
    const runId = publish(episodeId, trackRunId, [
      [10, 20, "A"],
      [15, 16, "B"],
      [19.5, 21, "B"],
      [30, 31.2, "A"],
    ]);
    const pieces = exclusiveSpeech(temp.db, runId);
    expect(pieces.get("A")).toEqual([
      { trackRunId, sampleStart: at(10.25), sampleEnd: at(14.75) },
      { trackRunId, sampleStart: at(16.25), sampleEnd: at(19.25) },
    ]);
    // B's turns overlap A's or are too short once trimmed.
    expect(pieces.get("B")).toBeUndefined();
  });

  it("reads at most 30 s of a long turn", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[0, 60]]);
    const runId = publish(episodeId, trackRunId, [[0, 60, "A"]]);
    expect(exclusiveSpeech(temp.db, runId).get("A")).toEqual([
      { trackRunId, sampleStart: at(0.25), sampleEnd: at(30.25) },
    ]);
  });

  it("leaves out a sentence whose words the alignment spread over minutes", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[0, 300]]);
    const runId = startRun(temp.db, episodeId, "asr");
    publishAnalysis(temp.db, {
      episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments: [
        timed(segment(trackRunId, 0, 5, "un deux trois quatre cinq", "A")),
        // Three words over four minutes: other voices speak in that span.
        timed(segment(trackRunId, 10, 250, "oui oui d'accord", "B")),
        timed(segment(trackRunId, 260, 264, "six sept huit neuf", "B")),
      ],
      turns: [],
    });
    const pieces = exclusiveSpeech(temp.db, runId);
    expect(pieces.get("A")).toEqual([{ trackRunId, sampleStart: at(0.25), sampleEnd: at(4.75) }]);
    expect(pieces.get("B")).toEqual([
      { trackRunId, sampleStart: at(260.25), sampleEnd: at(263.75) },
    ]);
  });
});

describe("linking voices", () => {
  it("merges one person's voices, numbers them again, and links each transcript once", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[0, 40]]);
    temp.db.client.prepare("UPDATE episodes SET context = 'call' WHERE id = ?").run(episodeId);
    const runId = publish(episodeId, trackRunId, [
      [0, 10, "t/1/1"],
      [10, 20, "t/1/2"],
      [20, 30, "t/2/1"],
      [30, 40, "t/2/2"],
    ]);
    expect(runsNeedingLinks(temp.db, 10)).toEqual([{ episodeId, runId }]);
    const voices = voicesOfRun(temp.db, runId);
    expect(voices.map((entry) => entry.label)).toEqual(["t/1/1", "t/1/2", "t/2/1", "t/2/2"]);
    expect(voices[0]?.trackKey).toBe("input:BuiltInMicrophoneDevice");
    expect(voices[0]?.personId).toBeNull();
    storeVoicePass(temp.db, {
      episodeId,
      runId,
      embedderVersion: "wespeaker-v2:test",
      voices: [{ label: "t/1/1", vector: voice(0), speechMs: 9_000 }],
      nowMs: t0,
    });

    const links = new Map([
      ["t/1/1", "t/1/1"],
      ["t/1/2", "t/1/2"],
      ["t/2/1", "t/1/2"],
      ["t/2/2", "t/1/1"],
    ]);
    expect(mergeVoices(temp.db, { episodeId, runId, links, nowMs: t0 })).toBe(true);
    const speakers = temp.db.client
      .prepare(
        "SELECT label, ordinal, voiced_ms FROM episode_speakers WHERE run_id = ? ORDER BY ordinal",
      )
      .all(runId);
    expect(speakers).toEqual([
      { label: "t/1/1", ordinal: 1, voiced_ms: 20_000 },
      { label: "t/1/2", ordinal: 2, voiced_ms: 20_000 },
    ]);
    const labels = (table: string) =>
      temp.db.client
        .prepare(
          `SELECT x.speaker_label AS label, sp.label AS speaker FROM ${table} x
           JOIN episode_speakers sp ON sp.id = x.episode_speaker_id
           WHERE x.run_id = ? ORDER BY x.start_ms`,
        )
        .all(runId)
        .map((row) => `${String(row["label"])}=${String(row["speaker"])}`);
    const expected = ["t/1/1=t/1/1", "t/1/2=t/1/2", "t/1/2=t/1/2", "t/1/1=t/1/1"];
    expect(labels("segments")).toEqual(expected);
    expect(labels("speaker_turns")).toEqual(expected);
    // Its voices are embedded again, merged.
    expect(count(temp.db, "speaker_embeddings")).toBe(0);
    expect(
      runsNeedingVoices(temp.db, { embedderVersion: "wespeaker-v2:test", sinceMs: 0, limit: 10 }),
    ).toEqual([{ episodeId, runId }]);
    expect(runsNeedingLinks(temp.db, 10)).toEqual([]);
  });

  it("keeps apart a voice named while the links were computed", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[0, 20]]);
    temp.db.client.prepare("UPDATE episodes SET context = 'call' WHERE id = ?").run(episodeId);
    const runId = publish(episodeId, trackRunId, [
      [0, 10, "A"],
      [10, 20, "B"],
    ]);
    const named = nameSpeaker(temp.db, {
      episodeId,
      runId,
      label: "B",
      person: { kind: "new", name: "Marie" },
      nowMs: t0,
    });
    if (!named.ok) throw new Error(named.reason);
    const links = new Map([["B", "A"]]);
    expect(mergeVoices(temp.db, { episodeId, runId, links, nowMs: t0 })).toBe(true);
    expect(count(temp.db, "episode_speakers", `run_id = ${runId}`)).toBe(2);
    expect(count(temp.db, "voice_links", `run_id = ${runId} AND merged = 0`)).toBe(1);
  });

  it("changes nothing in a transcript that was replaced", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[0, 20]]);
    const runId = publish(episodeId, trackRunId, [
      [0, 10, "A"],
      [10, 20, "B"],
    ]);
    publish(episodeId, trackRunId, [[0, 20, "A"]]);
    const links = new Map([["B", "A"]]);
    expect(mergeVoices(temp.db, { episodeId, runId, links, nowMs: t0 })).toBe(false);
    expect(count(temp.db, "voice_links")).toBe(0);
  });
});

describe("merging two voices by hand (ADR 038)", () => {
  function threeVoices() {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[0, 40]]);
    temp.db.client.prepare("UPDATE episodes SET context = 'call' WHERE id = ?").run(episodeId);
    const runId = publish(episodeId, trackRunId, [
      [0, 10, "A"],
      [10, 20, "B"],
      [20, 30, "C"],
      [30, 40, "B"],
    ]);
    storeVoicePass(temp.db, {
      episodeId,
      runId,
      embedderVersion: "wespeaker-v2:test",
      voices: [
        { label: "A", vector: voice(0), speechMs: 9_000 },
        { label: "B", vector: voice(1), speechMs: 9_000 },
        { label: "C", vector: voice(2), speechMs: 9_000 },
      ],
      nowMs: t0,
    });
    return { episodeId, trackRunId, runId };
  }
  const speakers = (runId: number) =>
    temp.db.client
      .prepare(
        "SELECT label, ordinal, voiced_ms FROM episode_speakers WHERE run_id = ? ORDER BY ordinal",
      )
      .all(runId);

  it("gives the later voice's sentences to the earlier one, numbers again, and embeds it again", () => {
    const { episodeId, runId } = threeVoices();
    // Asked from the later voice: the one that speaks first stays.
    const merged = mergeVoice(temp.db, { episodeId, runId, label: "B", other: "A", nowMs: t0 });
    expect(merged).toEqual({ ok: true, value: { label: "A" } });
    // C moves up a number, as publishing would number it.
    expect(speakers(runId)).toEqual([
      { label: "A", ordinal: 1, voiced_ms: 30_000 },
      { label: "C", ordinal: 2, voiced_ms: 10_000 },
    ]);
    const labels = temp.db.client
      .prepare("SELECT speaker_label AS label FROM segments WHERE run_id = ? ORDER BY start_ms")
      .all(runId)
      .map((row) => row["label"]);
    expect(labels).toEqual(["A", "A", "C", "A"]);
    // Only the joined voices lose their embedding; the run is embedded again.
    const embedded = temp.db.client
      .prepare("SELECT label FROM speaker_embeddings WHERE run_id = ?")
      .all(runId)
      .map((row) => row["label"]);
    expect(embedded).toEqual(["C"]);
    expect(
      runsNeedingVoices(temp.db, { embedderVersion: "wespeaker-v2:test", sinceMs: 0, limit: 10 }),
    ).toEqual([{ episodeId, runId }]);
  });

  it("keeps nothing from a voice pass that read the voices before the merge", () => {
    const { episodeId, runId } = threeVoices();
    const print = voicesPrint(temp.db, runId);
    expect(mergeVoice(temp.db, { episodeId, runId, label: "C", other: "B", nowMs: t0 }).ok).toBe(
      true,
    );
    const stale = storeVoicePass(temp.db, {
      episodeId,
      runId,
      embedderVersion: "wespeaker-v2:test",
      voices: [{ label: "C", vector: voice(2), speechMs: 9_000 }],
      nowMs: t0,
      print,
    });
    expect(stale).toBe(false);
    expect(count(temp.db, "speaker_embeddings", "label = 'C'")).toBe(0);
    expect(count(temp.db, "voice_passes", `run_id = ${runId}`)).toBe(0);
  });

  it("refuses a named voice, a replaced transcript, and a voice that is not there", () => {
    const { episodeId, trackRunId, runId } = threeVoices();
    const named = nameSpeaker(temp.db, {
      episodeId,
      runId,
      label: "A",
      person: { kind: "new", name: "Marie" },
      nowMs: t0,
    });
    expect(named.ok).toBe(true);
    expect(mergeVoice(temp.db, { episodeId, runId, label: "B", other: "A", nowMs: t0 })).toEqual({
      ok: false,
      reason: "named",
    });
    expect(mergeVoice(temp.db, { episodeId, runId, label: "B", other: "Z", nowMs: t0 })).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(mergeVoice(temp.db, { episodeId, runId, label: "B", other: "B", nowMs: t0 })).toEqual({
      ok: false,
      reason: "not-found",
    });
    publish(episodeId, trackRunId, [[0, 40, "A"]]);
    expect(mergeVoice(temp.db, { episodeId, runId, label: "B", other: "C", nowMs: t0 })).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("refuses where voices are not identified", () => {
    const { episodeId, runId } = threeVoices();
    temp.db.client.prepare("UPDATE episodes SET context = 'media' WHERE id = ?").run(episodeId);
    expect(mergeVoice(temp.db, { episodeId, runId, label: "B", other: "C", nowMs: t0 })).toEqual({
      ok: false,
      reason: "not-allowed",
    });
    expect(speakers(runId)).toHaveLength(3);
  });
});

describe("voice suggestions", () => {
  it("suggests the person whose named voice is closest, until the user says no", () => {
    const first = call(10);
    const second = call(100);
    const version = "wespeaker-v2:test";
    expect(runsNeedingVoices(temp.db, { embedderVersion: version, sinceMs: 0, limit: 10 })).toEqual(
      [
        { episodeId: second.episodeId, runId: second.runId },
        { episodeId: first.episodeId, runId: first.runId },
      ],
    );
    for (const [episode, vectors] of [
      [first, { A: voice(0), B: voice(9) }],
      [second, { A: voice(0, 1, 0.3), B: voice(50) }],
    ] as const) {
      expect(
        storeVoicePass(temp.db, {
          episodeId: episode.episodeId,
          runId: episode.runId,
          embedderVersion: version,
          voices: Object.entries(vectors).map(([label, vector]) => ({
            label,
            vector,
            speechMs: 9_000,
          })),
          nowMs: t0,
        }),
      ).toBe(true);
    }
    expect(runsNeedingVoices(temp.db, { embedderVersion: version, sinceMs: 0, limit: 10 })).toEqual(
      [],
    );
    expect(voiceMatches(temp.db, second.runId).size).toBe(0);

    const named = nameSpeaker(temp.db, {
      episodeId: first.episodeId,
      runId: first.runId,
      label: "A",
      person: { kind: "new", name: "Marie" },
      nowMs: t0,
    });
    if (!named.ok) throw new Error(named.reason);
    const suggestions = voiceMatches(temp.db, second.runId);
    expect([...suggestions.keys()]).toEqual(["A"]);
    expect(suggestions.get("A")?.person.name).toBe("Marie");
    expect(suggestions.get("A")?.similarity).toBeCloseTo(Math.sqrt(1 - 0.09), 5);

    expect(
      refuseSuggestion(temp.db, {
        episodeId: second.episodeId,
        runId: second.runId,
        label: "A",
        personId: named.value.id,
        nowMs: t0,
      }),
    ).toBe("ok");
    expect(voiceMatches(temp.db, second.runId).size).toBe(0);
    // The queue still lists the voice, without the refused suggestion.
    expect(
      unnamedVoices(temp.db, { sinceMs: 0, minVoicedMs: 1_000, limit: 10 }).map((entry) => [
        entry.episodeId,
        entry.label,
        entry.match?.person.name ?? null,
      ]),
    ).toEqual([
      [second.episodeId, "A", null],
      [second.episodeId, "B", null],
      [first.episodeId, "B", null],
    ]);
  });

  it("finds older episodes behind many that may not be identified", () => {
    const old = call(10);
    for (let index = 0; index < 5; index++) {
      const blocked = call(100 + index * 60);
      temp.db.client
        .prepare(
          `INSERT INTO identity_rules (scope, episode_id, recognize, created_at_ms, updated_at_ms) VALUES ('episode', ?, 0, 0, 0)`,
        )
        .run(blocked.episodeId);
    }
    expect(runsNeedingVoices(temp.db, { embedderVersion: "v", sinceMs: 0, limit: 2 })).toEqual([
      { episodeId: old.episodeId, runId: old.runId },
    ]);
  });

  it("embeds an old named voice again, and leaves old unnamed ones", () => {
    const named = call(10);
    call(100);
    const marie = nameSpeaker(temp.db, {
      episodeId: named.episodeId,
      runId: named.runId,
      label: "A",
      person: { kind: "new", name: "Marie" },
      nowMs: t0,
    });
    if (!marie.ok) throw new Error(marie.reason);
    // Both episodes are older than the window: only the named one comes back.
    expect(
      runsNeedingVoices(temp.db, { embedderVersion: "v", sinceMs: t0 + 10_000_000, limit: 10 }),
    ).toEqual([{ episodeId: named.episodeId, runId: named.runId }]);
  });

  it("deletes a person's voice with them, and compares one embedder version at a time", () => {
    const first = call(10);
    const second = call(100);
    storeVoicePass(temp.db, {
      episodeId: first.episodeId,
      runId: first.runId,
      embedderVersion: "old",
      voices: [{ label: "A", vector: voice(0), speechMs: 9_000 }],
      nowMs: t0,
    });
    storeVoicePass(temp.db, {
      episodeId: second.episodeId,
      runId: second.runId,
      embedderVersion: "new",
      voices: [{ label: "A", vector: voice(0), speechMs: 9_000 }],
      nowMs: t0,
    });
    const named = nameSpeaker(temp.db, {
      episodeId: first.episodeId,
      runId: first.runId,
      label: "A",
      person: { kind: "new", name: "Marie" },
      nowMs: t0,
    });
    if (!named.ok) throw new Error(named.reason);
    // Same direction, different versions: never compared.
    expect(voiceMatches(temp.db, second.runId).size).toBe(0);
    deletePerson(temp.db, named.value.id);
    const left = temp.db.client.prepare("SELECT run_id FROM speaker_embeddings").all();
    expect(left.map((row) => row["run_id"])).toEqual([second.runId]);
  });

  it("forgets unnamed voices after 90 days, never a named one", () => {
    const first = call(10);
    storeVoicePass(temp.db, {
      episodeId: first.episodeId,
      runId: first.runId,
      embedderVersion: "v",
      voices: [
        { label: "A", vector: voice(0), speechMs: 9_000 },
        { label: "B", vector: voice(1), speechMs: 9_000 },
      ],
      nowMs: t0,
    });
    nameSpeaker(temp.db, {
      episodeId: first.episodeId,
      runId: first.runId,
      label: "A",
      person: { kind: "new", name: "Marie" },
      nowMs: t0,
    });
    expect(forgetUnnamedVoices(temp.db, t0)).toBe(0);
    expect(forgetUnnamedVoices(temp.db, t0 + 90 * 86_400_000)).toBe(1);
    const left = temp.db.client.prepare("SELECT label FROM speaker_embeddings").all();
    expect(left.map((row) => row["label"])).toEqual(["A"]);
  });

  it("stays quiet when two people sound alike until they are merged, and never stores a replaced run", () => {
    const first = call(10);
    const second = call(100);
    const version = "wespeaker-v2:test";
    storeVoicePass(temp.db, {
      episodeId: first.episodeId,
      runId: first.runId,
      embedderVersion: version,
      voices: [
        { label: "A", vector: voice(0, 1, 0.2), speechMs: 9_000 },
        { label: "B", vector: voice(0, 1, -0.2), speechMs: 9_000 },
      ],
      nowMs: t0,
    });
    for (const [label, name] of [
      ["A", "Marie"],
      ["B", "Jeanne"],
    ] as const) {
      nameSpeaker(temp.db, {
        episodeId: first.episodeId,
        runId: first.runId,
        label,
        person: { kind: "new", name },
        nowMs: t0,
      });
    }
    storeVoicePass(temp.db, {
      episodeId: second.episodeId,
      runId: second.runId,
      embedderVersion: version,
      voices: [{ label: "A", vector: voice(0), speechMs: 9_000 }],
      nowMs: t0,
    });
    // Both are 0.98 away: no clear winner.
    expect(voiceMatches(temp.db, second.runId).size).toBe(0);
    // Once the user says they are one person, their voice is both voices.
    const [jeanne, marie] = temp.db.client
      .prepare("SELECT id FROM people ORDER BY name")
      .all()
      .map((row) => Number(row["id"]));
    if (marie === undefined || jeanne === undefined) throw new Error("people missing");
    expect(mergePeople(temp.db, { personId: marie, otherId: jeanne, nowMs: t0 }).ok).toBe(true);
    expect(voiceMatches(temp.db, second.runId).get("A")?.person.name).toBe("Marie");

    const replaced = publish(second.episodeId, second.trackRunId, [[100, 140, "Z"]]);
    expect(
      storeVoicePass(temp.db, {
        episodeId: second.episodeId,
        runId: second.runId,
        embedderVersion: version,
        voices: [],
        nowMs: t0,
      }),
    ).toBe(false);
    expect(replaced).not.toBe(second.runId);
  });
});

describe("recognizing a voice heard in a call (ADR 025)", () => {
  it("finds the person, and no one for a voice closest to the user's", () => {
    const first = call(10);
    const version = "wespeaker-v2:test";
    storeVoicePass(temp.db, {
      episodeId: first.episodeId,
      runId: first.runId,
      embedderVersion: version,
      voices: [
        { label: "A", vector: voice(0), speechMs: 9_000 },
        { label: "B", vector: voice(9), speechMs: 9_000 },
      ],
      nowMs: t0,
    });
    const name = (label: string, person: Parameters<typeof nameSpeaker>[1]["person"]) =>
      nameSpeaker(temp.db, {
        episodeId: first.episodeId,
        runId: first.runId,
        label,
        person,
        nowMs: t0,
      });
    name("A", { kind: "self", name: "Moi" });
    name("B", { kind: "new", name: "Marie" });
    const live = call(100);
    const heard = (vector: number[], embedderVersion = version) =>
      recognizeVoice(temp.db, {
        episodeId: live.episodeId,
        embedderVersion,
        vector,
        speechMs: 3_000,
        channel: "computer",
      });

    // Heard by the Mac, against references from another channel: suggested only.
    expect(heard(voice(9, 10, 0.3))).toMatchObject({
      person: { name: "Marie" },
      zone: "likely",
    });
    // The user's own voice coming back on the far side is no one's.
    expect(heard(voice(0, 1, 0.2))).toBeNull();
    expect(heard(voice(50))).toBeNull();
    expect(heard(voice(9), "another-embedder")).toBeNull();
    // Not where voices may not be identified.
    temp.db.client
      .prepare("UPDATE episodes SET context = 'media' WHERE id = ?")
      .run(live.episodeId);
    expect(heard(voice(9))).toBeNull();
  });
});

function nameAs(
  target: { episodeId: number; runId: number },
  label: string,
  person: Parameters<typeof nameSpeaker>[1]["person"],
) {
  const named = nameSpeaker(temp.db, { ...target, label, person, nowMs: t0 });
  if (!named.ok) throw new Error(named.reason);
  return named.value;
}

describe("confidence and zones (ADR 030)", () => {
  const version = "wespeaker-v2:test";
  const mic = "input:BuiltInMicrophoneDevice/1/1";
  const other = "input:BuiltInMicrophoneDevice/1/2";
  const DAY = 86_400;

  /** An in-person conversation on the microphone, `start` seconds after t0, with two voices embedded. */
  function room(start: number, vectors: { readonly first: number[]; readonly second?: number[] }) {
    const episode = seedEpisode(temp.db, [[start, start + 40]]);
    temp.db.client
      .prepare("UPDATE episodes SET context = 'in_person' WHERE id = ?")
      .run(episode.episodeId);
    const runId = publish(episode.episodeId, episode.trackRunId, [
      [start, start + 20, mic],
      [start + 20, start + 40, other],
    ]);
    storeVoicePass(temp.db, {
      episodeId: episode.episodeId,
      runId,
      embedderVersion: version,
      voices: [
        { label: mic, vector: vectors.first, speechMs: 20_000 },
        ...(vectors.second === undefined
          ? []
          : [{ label: other, vector: vectors.second, speechMs: 20_000 }]),
      ],
      nowMs: t0,
    });
    return { ...episode, runId };
  }

  /** Conversations at `starts`, their first voice named as one person each time. */
  /**
   * Conversations at `starts`, their first voice named as one person each
   * time: one direction with a little noise, leaning on `lean` + 1, + 2…
   */
  function namedAt(starts: readonly number[], person: "self" | "new" | string, lean = 0) {
    const [first, ...rest] = starts.map((start, index) =>
      room(start, { first: voice(0, lean + index + 1, 0.3) }),
    );
    if (first === undefined) throw new Error("no conversation");
    const named = nameAs(
      first,
      mic,
      person === "self"
        ? { kind: "self", name: "Moi" }
        : { kind: "new", name: person === "new" ? "Marie" : person },
    );
    for (const later of rest) nameAs(later, mic, { kind: "existing", personId: named.id });
    return named;
  }

  it("calibrates: 80 % at a cosine of 0.486, 99 % at 0.607", () => {
    expect(voiceConfidence(0.486)).toBeCloseTo(0.8, 2);
    expect(voiceConfidence(0.607)).toBeCloseTo(0.99, 3);
    expect(voiceConfidence(0.3)).toBeLessThan(0.03);
  });

  it("recognizes a voice once three references on two days agree, and suggests before", () => {
    // Téo's references, one direction with a little noise each time, on one day.
    const moi = namedAt([10, 100], "self");
    // A conversation to read: Téo, at 0.7 from each reference, and a stranger.
    const heard = room(3 * DAY, { first: voice(0, 4, 0.7), second: voice(80) });
    // Two references on one day: likely, with its confidence.
    const early = voiceMatches(temp.db, heard.runId).get(mic);
    expect(early).toMatchObject({ person: { name: "Moi" }, zone: "likely", references: 2 });
    expect(early?.confidence).toBeGreaterThan(0.99);
    expect(voiceMatches(temp.db, heard.runId).has(other)).toBe(false);

    // A third reference, on another day: recognized.
    const third = room(DAY, { first: voice(0, 3, 0.3) });
    nameAs(third, mic, { kind: "existing", personId: moi.id });
    expect(voiceMatches(temp.db, heard.runId).get(mic)).toMatchObject({
      zone: "recognized",
      references: 3,
    });
    expect(recognizedVoices(temp.db).map((entry) => [entry.episodeId, entry.label])).toEqual([
      [heard.episodeId, mic],
    ]);
    expect(episodeRecognized(temp.db, [heard.episodeId]).get(heard.episodeId)).toEqual([moi]);
    // Never a reference: another voice (only suggested) is still compared with three, not four.
    const probe = room(4 * DAY, { first: voice(0, 5, 0.85) });
    expect(voiceMatches(temp.db, probe.runId).get(mic)).toMatchObject({
      zone: "suggested",
      references: 3,
    });

    // Taking a reference back moves the recognition at once: it is derived.
    unnameSpeaker(temp.db, { ...third, label: mic, nowMs: t0 });
    expect(voiceMatches(temp.db, heard.runId).get(mic)?.zone).toBe("likely");
    // So does the voice whose name was taken back, against the two left.
    expect(recognizedVoices(temp.db).map((entry) => entry.match.zone)).toEqual([
      "likely",
      "likely",
    ]);
    nameAs(third, mic, { kind: "existing", personId: moi.id });

    // « Non » removes it, as a name given to the voice does.
    expect(refuseSuggestion(temp.db, { ...heard, label: mic, personId: moi.id, nowMs: t0 })).toBe(
      "ok",
    );
    expect(voiceMatches(temp.db, heard.runId).has(mic)).toBe(false);
    expect(recognizedVoices(temp.db)).toEqual([]);
  });

  it("finds only likely, from 99 %, a voice heard another way than its references", () => {
    namedAt([10, 100, DAY], "new");
    const live = call(3 * DAY);
    const heard = (vector: number[]) =>
      recognizeVoice(temp.db, {
        episodeId: live.episodeId,
        embedderVersion: version,
        vector,
        speechMs: 10_000,
        channel: "computer",
      });
    // 0.7 to Marie's centroid: 99.9 %, likely on the far side.
    expect(heard(voice(0, 4, 0.7))).toMatchObject({ zone: "likely" });
    // 0.55 (91 %) would be suggested on the microphone, not across channels.
    const middle = Math.sqrt(1 - 0.55 * 0.55);
    expect(heard(voice(0, 5, middle))).toBeNull();
  });

  it("never recognizes a voice of under 3 s, counted in the embedding that scored", () => {
    namedAt([10, 100, DAY], "self");
    const heard = room(3 * DAY, { first: voice(0, 4, 0.5) });
    temp.db.client
      .prepare("UPDATE speaker_embeddings SET speech_ms = 2000 WHERE run_id = ?")
      .run(heard.runId);
    // A longer embedding of another version, which no reference shares, does not count.
    storeVoicePass(temp.db, {
      episodeId: heard.episodeId,
      runId: heard.runId,
      embedderVersion: "another-embedder",
      voices: [{ label: mic, vector: voice(0, 4, 0.5), speechMs: 20_000 }],
      nowMs: t0,
    });
    expect(voiceMatches(temp.db, heard.runId).get(mic)?.zone).toBe("likely");
    expect(recognizedVoices(temp.db).map((entry) => entry.match.zone)).toEqual(["likely"]);
  });

  it("recognizes nobody where voices may not be identified", () => {
    namedAt([10, 100, DAY], "self");
    const heard = room(3 * DAY, { first: voice(0, 4, 0.5) });
    expect(recognizedVoices(temp.db).map((entry) => entry.episodeId)).toEqual([heard.episodeId]);
    temp.db.client
      .prepare(
        `INSERT INTO identity_rules (scope, episode_id, recognize, created_at_ms, updated_at_ms)
         VALUES ('episode', ?, 0, 0, 0)`,
      )
      .run(heard.episodeId);
    expect(voiceMatches(temp.db, heard.runId).size).toBe(0);
    expect(recognizedVoices(temp.db)).toEqual([]);
    expect(episodeRecognized(temp.db, [heard.episodeId]).size).toBe(0);
  });

  it("lets « Non » to one of two people who sound alike recognize the other", () => {
    const moi = namedAt([10, 100, DAY], "self");
    const jeanne = namedAt([200, 300, DAY + 100], "Jeanne", 10);
    const heard = room(3 * DAY, { first: voice(0, 30, 0.7) });
    // As close to both: no one.
    expect(voiceMatches(temp.db, heard.runId).has(mic)).toBe(false);
    expect(recognizedVoices(temp.db)).toEqual([]);
    refuseSuggestion(temp.db, { ...heard, label: mic, personId: jeanne.id, nowMs: t0 });
    expect(voiceMatches(temp.db, heard.runId).get(mic)).toMatchObject({
      person: { id: moi.id },
      zone: "recognized",
    });
    expect(recognizedVoices(temp.db).map((entry) => entry.match.person.id)).toEqual([moi.id]);
  });

  it("says how much a voice sounds like each person, likeliest first", () => {
    const moi = namedAt([10, 100, DAY], "self");
    const jeanne = namedAt([200], "Jeanne", 40);
    const heard = room(3 * DAY, { first: voice(0, 30, 0.9) });
    const likeness = voiceLikeness(temp.db, { runId: heard.runId, label: mic });
    expect(likeness.map((entry) => entry.person.id)).toEqual([moi.id, jeanne.id]);
    expect(likeness[0]?.confidence).toBeCloseTo(voiceConfidence(likeness[0]?.similarity ?? 0), 9);
    expect(likeness[0]?.references).toBe(3);
    temp.db.client
      .prepare("UPDATE episodes SET context = 'media' WHERE id = ?")
      .run(heard.episodeId);
    expect(voiceLikeness(temp.db, { runId: heard.runId, label: mic })).toEqual([]);
  });

  it("leaves recognized voices out of « Qui est-ce ? »", () => {
    namedAt([10, 100, DAY], "self");
    const heard = room(3 * DAY, { first: voice(0, 4, 0.7), second: voice(80) });
    expect(
      unnamedVoices(temp.db, { sinceMs: 0, minVoicedMs: 1_000, limit: 10 })
        .filter((entry) => entry.episodeId === heard.episodeId)
        .map((entry) => entry.label),
    ).toEqual([other]);
  });

  it("asks about a name given to a voice that sounds like someone else, until the user answers", () => {
    const jules = namedAt([10, 100, DAY], "Jules");
    const first = room(200, { first: voice(100, 101, 0.3) });
    const marie = nameAs(first, mic, { kind: "new", name: "Marie" });
    nameAs(room(DAY + 100, { first: voice(100, 102, 0.3) }), mic, {
      kind: "existing",
      personId: marie.id,
    });
    expect(doubtedNames(temp.db, { limit: 10 })).toEqual([]);
    // Jules's voice, named Marie by mistake.
    const wrong = room(3 * DAY, { first: voice(0, 5, 0.3) });
    nameAs(wrong, mic, { kind: "existing", personId: marie.id });
    const [doubt, ...others] = doubtedNames(temp.db, { limit: 10 });
    expect(others).toEqual([]);
    expect(doubt).toMatchObject({
      episodeId: wrong.episodeId,
      label: mic,
      person: { id: marie.id },
      match: { person: { id: jules.id } },
      startMs: temp.db.client
        .prepare("SELECT min(start_ms) AS ms FROM segments WHERE run_id = ? AND speaker_label = ?")
        .get(wrong.runId, mic)?.["ms"],
    });
    expect(doubt?.confidence ?? 1).toBeLessThan(doubt?.match.confidence ?? 0);
    // « C'est Jules » settles it, and « C'est bien Marie » too, for good.
    nameAs(wrong, mic, { kind: "existing", personId: jules.id });
    expect(doubtedNames(temp.db, { limit: 10 })).toEqual([]);
    nameAs(wrong, mic, { kind: "existing", personId: marie.id });
    expect(doubtedNames(temp.db, { limit: 10 })).toHaveLength(1);
    refuseSuggestion(temp.db, { ...wrong, label: mic, personId: jules.id, nowMs: t0 });
    expect(doubtedNames(temp.db, { limit: 10 })).toEqual([]);
    expect(resolveSpeakers(temp.db, wrong.runId).get(mic)?.id).toBe(marie.id);
  });

  it("never asks about a name over a closer person, even one refused before it was given", () => {
    const marie = namedAt([10, 100, DAY], "Marie");
    const jules = namedAt([200, 300, DAY + 100], "Jules", 10);
    // As close to both: neither 0.10 ahead.
    const heard = room(3 * DAY, { first: voice(0, 30, 0.6) });
    refuseSuggestion(temp.db, { ...heard, label: mic, personId: marie.id, nowMs: t0 });
    nameAs(heard, mic, { kind: "existing", personId: marie.id });
    expect(voiceLikeness(temp.db, { runId: heard.runId, label: mic })).toHaveLength(2);
    expect(jules.id).not.toBe(marie.id);
    expect(doubtedNames(temp.db, { limit: 10 })).toEqual([]);
  });

  it("names a likely voice everywhere, and keeps it in « Qui est-ce ? » (Marie*)", () => {
    // One reference: sure enough to read as them, not to leave the list.
    const marie = namedAt([10], "Marie");
    const heard = room(3 * DAY, { first: voice(0, 4, 0.5) });
    const listed = unnamedVoices(temp.db, { sinceMs: 0, minVoicedMs: 1_000, limit: 10 }).find(
      (entry) => entry.episodeId === heard.episodeId && entry.label === mic,
    );
    expect(listed?.match).toMatchObject({ person: { id: marie.id }, zone: "likely" });
    expect(recognizedVoices(temp.db).map((entry) => entry.episodeId)).toEqual([heard.episodeId]);
    // Never a reference: the next voice is still compared with one.
    const next = room(4 * DAY, { first: voice(0, 5, 0.5) });
    expect(voiceMatches(temp.db, next.runId).get(mic)?.references).toBe(1);
    refuseSuggestion(temp.db, { ...heard, label: mic, personId: marie.id, nowMs: t0 });
    expect(episodeRecognized(temp.db, [heard.episodeId]).size).toBe(0);
  });
});

describe("phone voices (ADR 032, M5.8)", () => {
  const version = "wespeaker-v2:test";
  const DAY = 86_400;
  const mic = "input:BuiltInMicrophoneDevice/1/1";
  let recordings = 0;

  /** An in-person conversation, one voice embedded, heard by the microphone or by the phone. */
  function heardOn(where: "microphone" | "phone", start: number, vector: number[]) {
    recordings += 1;
    const label = where === "phone" ? `phone:recording-${recordings}/1/1` : mic;
    const episode = seedEpisode(temp.db, [[start, start + 20]]);
    temp.db.client
      .prepare("UPDATE episodes SET context = 'in_person' WHERE id = ?")
      .run(episode.episodeId);
    const runId = publish(episode.episodeId, episode.trackRunId, [[start, start + 20, label]]);
    storeVoicePass(temp.db, {
      episodeId: episode.episodeId,
      runId,
      embedderVersion: version,
      voices: [{ label, vector, speechMs: 20_000 }],
      nowMs: t0,
    });
    return { ...episode, runId, label };
  }

  /** Marie's references: three voices on two days, one direction with a little noise. */
  function marieOn(where: "microphone" | "phone", lean = 0) {
    const [first, ...rest] = [10, 100, DAY].map((start, index) =>
      heardOn(where, start + lean * 1000, voice(0, lean + index + 1, 0.3)),
    );
    if (first === undefined) throw new Error("no conversation");
    const marie = nameAs(first, first.label, { kind: "new", name: "Marie" });
    for (const later of rest) nameAs(later, later.label, { kind: "existing", personId: marie.id });
    return marie;
  }

  it("ships with phone voices at suggestions only", () => {
    expect(PHONE_VOICES_MEASURED).toBe(false);
    expect([...measuredChannels(PHONE_VOICES_MEASURED)]).toEqual(["microphone"]);
  });

  it("reads a phone voice as the person, from 99 %, without recognizing it for sure", () => {
    marieOn("phone");
    // 0.7 to the centroid of three phone voices on two days: 99.9 %, recognized on a microphone.
    const sure = heardOn("phone", 3 * DAY, voice(0, 4, 0.7));
    expect(voiceMatches(temp.db, sure.runId).get(sure.label)).toMatchObject({
      person: { name: "Marie" },
      zone: "likely",
      references: 3,
    });
    // « Marie* » everywhere her voice is listed, marked as any recognition.
    expect(recognizedVoices(temp.db).map((entry) => entry.episodeId)).toEqual([sure.episodeId]);
    expect(episodeRecognized(temp.db, [sure.episodeId]).get(sure.episodeId)).toMatchObject([
      { name: "Marie" },
    ]);
    // 0.55 (91 %) would be suggested on a measured channel; not on the phone.
    const middle = heardOn("phone", 4 * DAY, voice(0, 5, Math.sqrt(1 - 0.55 * 0.55)));
    expect(voiceMatches(temp.db, middle.runId).has(middle.label)).toBe(false);
  });

  it("compares a phone voice with phone references when the person has some", () => {
    const marie = marieOn("microphone");
    // Two phone voices of Marie leaning elsewhere: the phone voice is compared with those.
    for (const [index, start] of [5 * DAY, 6 * DAY].entries()) {
      const named = heardOn("phone", start, voice(0, 20 + index, 0.3));
      nameAs(named, named.label, { kind: "existing", personId: marie.id });
    }
    const heard = heardOn("phone", 7 * DAY, voice(0, 22, 0.5));
    expect(voiceMatches(temp.db, heard.runId).get(heard.label)).toMatchObject({
      zone: "likely",
      references: 2,
    });
  });

  it("finds only likely, from 99 %, a phone voice against microphone references", () => {
    marieOn("microphone");
    // A phone voice against microphone references.
    const phone = heardOn("phone", 3 * DAY, voice(0, 4, 0.7));
    expect(voiceMatches(temp.db, phone.runId).get(phone.label)).toMatchObject({
      zone: "likely",
      references: 3,
    });
    const middle = heardOn("phone", 4 * DAY, voice(0, 5, Math.sqrt(1 - 0.55 * 0.55)));
    expect(voiceMatches(temp.db, middle.runId).has(middle.label)).toBe(false);
    expect(recognizedVoices(temp.db).map((entry) => entry.match.zone)).toEqual(["likely"]);
  });

  it("finds only likely a microphone voice against phone references", () => {
    marieOn("phone");
    const heard = heardOn("microphone", 3 * DAY, voice(0, 4, 0.7));
    expect(voiceMatches(temp.db, heard.runId).get(mic)).toMatchObject({ zone: "likely" });
    expect(recognizedVoices(temp.db).map((entry) => entry.match.zone)).toEqual(["likely"]);
  });

  it("recognizes a phone voice against phone references only once the phone is measured", () => {
    const marie = { id: 1, name: "Marie", isSelf: false };
    const jeanne = { id: 2, name: "Jeanne", isSelf: false };
    const score = (same: boolean, similarity = 0.7) => [
      {
        person: marie,
        similarity,
        references: 3,
        dictations: 0,
        reads: 0,
        days: 2,
        same,
        speechMs: 20_000,
      },
      {
        person: jeanne,
        similarity: 0.2,
        references: 3,
        dictations: 0,
        reads: 0,
        days: 2,
        same,
        speechMs: 20_000,
      },
    ];
    const measured = measuredChannels(true);
    expect(decideVoice(score(true), "phone")?.zone).toBe("likely");
    expect(decideVoice(score(true), "phone", { measured })).toMatchObject({
      person: marie,
      zone: "recognized",
    });
    // Measured, a phone voice is suggested from 80 % as on the microphone…
    expect(decideVoice(score(true, 0.55), "phone")).toBeNull();
    expect(decideVoice(score(true, 0.55), "phone", { measured })?.zone).toBe("suggested");
    // …but compared with references heard another way it stays « Marie ? », from 99 %.
    expect(decideVoice(score(false), "phone", { measured })?.zone).toBe("likely");
    expect(decideVoice(score(false, 0.55), "phone", { measured })).toBeNull();
    // Measuring the phone changes nothing elsewhere.
    expect(decideVoice(score(true), "computer", { measured })?.zone).toBe("likely");
    expect(decideVoice(score(true), "microphone")?.zone).toBe("recognized");
    // Refused, Marie is skipped: Jeanne is too far for anything.
    expect(decideVoice(score(true), "phone", { measured, skip: (p) => p.id === 1 })).toBeNull();
  });
});

/** How many dictation embeddings are kept. */
const dictationRows = () =>
  temp.db.client
    .prepare(
      `SELECT count(*) AS n FROM speaker_embeddings v JOIN episodes e ON e.id = v.episode_id
       WHERE e.context = 'dictation'`,
    )
    .get()?.["n"];

describe("the user's dictations as their references (ADR 030)", () => {
  const version = "wespeaker-v2:test";
  const mic = "input:BuiltInMicrophoneDevice/1/1";
  const DAY = 86_400;

  /** An episode of `context` on the microphone, one voice, embedded when the rules let it be. */
  function heardAt(start: number, context: "in_person" | "dictation", vector: number[]) {
    const episode = seedEpisode(temp.db, [[start, start + 20]]);
    temp.db.client
      .prepare("UPDATE episodes SET context = ? WHERE id = ?")
      .run(context, episode.episodeId);
    const runId = publish(episode.episodeId, episode.trackRunId, [[start, start + 20, mic]]);
    const stored = storeVoicePass(temp.db, {
      episodeId: episode.episodeId,
      runId,
      embedderVersion: version,
      voices: [{ label: mic, vector, speechMs: 20_000 }],
      nowMs: t0,
    });
    return { ...episode, runId, stored };
  }

  it("is off by default, and teaches only once the user named their voice", () => {
    expect(learnsFromDictations(temp.db)).toBe(false);
    const before = heardAt(10, "dictation", voice(0, 1, 0.3));
    expect(before.stored).toBe(false);
    setLearnFromDictations(temp.db, { on: true, nowMs: t0 });
    // Nobody is the user yet.
    expect(runsNeedingVoices(temp.db, { embedderVersion: version, sinceMs: 0, limit: 10 })).toEqual(
      [],
    );
    const named = heardAt(100, "in_person", voice(0, 2, 0.3));
    nameAs(named, mic, { kind: "self", name: "Moi" });
    expect(
      runsNeedingVoices(temp.db, { embedderVersion: version, sinceMs: 0, limit: 10 }).map(
        (run) => run.episodeId,
      ),
    ).toEqual([before.episodeId]);
    // A dictation still names no one and is never recognized.
    expect(heardAt(200, "dictation", voice(0, 3, 0.3)).stored).toBe(true);
    expect(recognizedVoices(temp.db)).toEqual([]);
  });

  it("makes the user surer of their voice, without dictations someone else said", () => {
    setLearnFromDictations(temp.db, { on: true, nowMs: t0 });
    const moi = nameAs(heardAt(10, "in_person", voice(0, 1, 0.3)), mic, {
      kind: "self",
      name: "Moi",
    });
    const heard = heardAt(3 * DAY, "in_person", voice(0, 9, 0.7));
    // One named voice: suggested.
    expect(voiceMatches(temp.db, heard.runId).get(mic)).toMatchObject({
      person: { id: moi.id },
      zone: "likely",
      references: 1,
      dictations: 0,
    });
    heardAt(DAY, "dictation", voice(0, 2, 0.3));
    heardAt(2 * DAY, "dictation", voice(0, 3, 0.3));
    // Someone else dictating on the Mac: not like the user, left out.
    heardAt(2 * DAY + 100, "dictation", voice(80));
    expect(voiceMatches(temp.db, heard.runId).get(mic)).toMatchObject({
      zone: "recognized",
      references: 3,
      dictations: 2,
    });

    // Off: the dictations' embeddings go, and the recognition with them.
    setLearnFromDictations(temp.db, { on: false, nowMs: t0 });
    expect(dictationRows()).toBe(0);
    expect(voiceMatches(temp.db, heard.runId).get(mic)?.zone).toBe("likely");
  });

  it("stops once no voice is named as the user, and forgets even passes that kept nothing", () => {
    setLearnFromDictations(temp.db, { on: true, nowMs: t0 });
    const named = heardAt(10, "in_person", voice(0, 1, 0.3));
    nameAs(named, mic, { kind: "self", name: "Moi" });
    // A dictation the tool found too short: its pass is recorded, with no embedding.
    const silent = heardAt(DAY, "dictation", voice(0, 2, 0.3));
    temp.db.client.prepare("DELETE FROM speaker_embeddings WHERE run_id = ?").run(silent.runId);
    const passes = () =>
      temp.db.client
        .prepare("SELECT count(*) AS n FROM voice_passes WHERE run_id = ?")
        .get(silent.runId)?.["n"];
    expect(passes()).toBe(1);
    setLearnFromDictations(temp.db, { on: false, nowMs: t0 });
    expect(passes()).toBe(0);

    setLearnFromDictations(temp.db, { on: true, nowMs: t0 });
    unnameSpeaker(temp.db, { ...named, label: mic, nowMs: t0 });
    expect(runsNeedingVoices(temp.db, { embedderVersion: version, sinceMs: 0, limit: 10 })).toEqual(
      [],
    );
    expect(heardAt(2 * DAY, "dictation", voice(0, 3, 0.3)).stored).toBe(false);
  });

  it("deletes the dictations' embeddings with the user", () => {
    setLearnFromDictations(temp.db, { on: true, nowMs: t0 });
    const moi = nameAs(heardAt(10, "in_person", voice(0, 1, 0.3)), mic, {
      kind: "self",
      name: "Moi",
    });
    heardAt(DAY, "dictation", voice(0, 2, 0.3));
    expect(dictationRows()).toBe(1);
    deletePerson(temp.db, moi.id);
    expect(dictationRows()).toBe(0);
  });
});

describe("the voice shown as the user (ADR 030)", () => {
  const base = { label: "input:mic/1/1", ordinal: 1 };
  // Only a recognized voice is looked up; here at ordinal 2.
  const db = { statement: () => ({ get: () => ({ ordinal: 2 }) }) } as unknown as Database;
  const match = (zone: VoiceMatch["zone"], isSelf: boolean): VoiceMatch => ({
    person: { id: isSelf ? 1 : 2, name: isSelf ? "Alex" : "Marie", isSelf },
    similarity: 0.7,
    confidence: 0.995,
    references: 1,
    dictations: 0,
    reads: 0,
    zone,
  });
  const shown = (self: typeof base | undefined, entries: [string, VoiceMatch][]) =>
    shownSelf(db, 1, self, new Map(), new Map(entries));
  const far = "app:us.zoom.xos/1/1";

  it("moves to a voice recognized for sure, never to one only likely them", () => {
    expect(shown(base, [[far, match("recognized", true)]])).toEqual({ label: far, ordinal: 2 });
    expect(shown(base, [[far, match("likely", true)]])).toEqual(base);
    expect(shown(undefined, [[far, match("likely", true)]])).toBeNull();
  });

  it("leaves a voice that reads as someone else, not one only suggested", () => {
    expect(shown(base, [[base.label, match("likely", false)]])).toBeNull();
    expect(shown(base, [[base.label, match("suggested", false)]])).toEqual(base);
    expect(shown(base, [[base.label, match("likely", true)]])).toEqual(base);
  });
});
