import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSpeechRegion, closeSpeechRegion, upsertTrackRun } from "./capture-import";
import { openDatabase, type OpenDatabaseOptions, type OpenedDatabase } from "./database";
import { analysisRuns } from "./schema/analysis";
import type { AnalysisStage } from "./schema/enums";
import { episodeRegions, episodes } from "./schema/episodes";

export interface TempDatabase {
  readonly db: OpenedDatabase;
  readonly dir: string;
  readonly path: string;
  reopen(options?: OpenDatabaseOptions): OpenedDatabase;
  cleanup(): void;
}

/** A real file database in a fresh temporary directory. */
export function tempDatabase(options: OpenDatabaseOptions = {}): TempDatabase {
  const dir = mkdtempSync(join(tmpdir(), "sondine-db-"));
  const path = join(dir, "sondine.db");
  const opened: OpenedDatabase[] = [openDatabase(path, options)];
  const first = opened[0];
  if (first === undefined) throw new Error("unreachable");
  return {
    db: first,
    dir,
    path,
    reopen(reopenOptions = options) {
      const db = openDatabase(path, reopenOptions);
      opened.push(db);
      return db;
    },
    cleanup() {
      for (const db of opened) db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const t0 = Date.UTC(2026, 10, 2, 9, 0, 0);
export const rate = 16000;

/** Sample index `seconds` into a run. */
export const at = (seconds: number): number => Math.round(seconds * rate);

let uidCounter = 0;

export function seedTrackRun(db: OpenedDatabase, startedWallMs = t0): number {
  uidCounter += 1;
  return upsertTrackRun(db, {
    uid: `run-${uidCounter}`,
    trackKey: "input:BuiltInMicrophoneDevice",
    sourceKind: "input",
    device: {
      uid: "BuiltInMicrophoneDevice",
      name: "MacBook Pro Microphone",
      transport: "built_in",
      hasInput: true,
      seenAtMs: startedWallMs,
    },
    startedWallMs,
    nowMs: startedWallMs,
  }).trackRunId;
}

export interface SeededEpisode {
  readonly episodeId: number;
  readonly trackRunId: number;
  readonly regionIds: readonly number[];
}

/** An episode over closed regions given as [startSeconds, endSeconds] in one run. */
export function seedEpisode(
  db: OpenedDatabase,
  regions: readonly (readonly [number, number])[] = [[10, 20]],
  trackRunId = seedTrackRun(db),
): SeededEpisode {
  const regionIds = regions.map(([start, end]) => {
    const opened = openSpeechRegion(db, {
      trackRunId,
      sampleStart: at(start),
      wallStartMs: t0 + start * 1000,
      vadVersion: "silero-6.2",
    });
    if (opened.speechRegionId === null) throw new Error("region refused");
    closeSpeechRegion(db, {
      trackRunId,
      sampleStart: at(start),
      sampleEnd: at(end),
      wallEndMs: t0 + end * 1000,
      endReason: "silence",
    });
    return opened.speechRegionId;
  });
  const first = regions[0] ?? [0, 1];
  const last = regions.at(-1) ?? first;
  const episode = db.orm
    .insert(episodes)
    .values({
      state: "closed",
      startedAtMs: t0 + first[0] * 1000,
      endedAtMs: t0 + last[1] * 1000,
      groupingVersion: "g1",
      classifierVersion: "c1",
      createdAtMs: t0,
      updatedAtMs: t0,
    })
    .returning({ id: episodes.id })
    .get();
  regionIds.forEach((speechRegionId, index) => {
    db.orm
      .insert(episodeRegions)
      .values({
        episodeId: episode.id,
        speechRegionId,
        groupingVersion: "g1",
        sliceSampleStart: at(regions[index]?.[0] ?? 0),
      })
      .run();
  });
  return { episodeId: episode.id, trackRunId, regionIds };
}

export function startRun(
  db: OpenedDatabase,
  episodeId: number,
  stage: AnalysisStage,
  inputGeneration = 1,
): number {
  return db.orm
    .insert(analysisRuns)
    .values({
      episodeId,
      stage,
      status: "succeeded",
      engineId: "nemotron-3.5-transcribe-30b",
      engineVersion: "iq4_nl",
      engineRuntime: "speech.cpp",
      adapterClass: "product",
      inputHash: `hash-${episodeId}-${inputGeneration}`,
      inputGeneration,
      startedAtMs: t0,
    })
    .returning({ id: analysisRuns.id })
    .get().id;
}

/** A segment of `text` spanning [start, end] seconds of a run. */
export function segment(
  trackRunId: number,
  start: number,
  end: number,
  text: string,
  speakerLabel = "S1",
) {
  return {
    trackRunId,
    sampleStart: at(start),
    sampleEnd: at(end),
    startMs: t0 + start * 1000,
    endMs: t0 + end * 1000,
    text,
    speakerLabel,
  };
}

export function turn(trackRunId: number, start: number, end: number, speakerLabel: string) {
  return {
    trackRunId,
    sampleStart: at(start),
    sampleEnd: at(end),
    startMs: t0 + start * 1000,
    endMs: t0 + end * 1000,
    speakerLabel,
  };
}

export function count(db: OpenedDatabase, table: string, where = "1 = 1"): number {
  const row = db.client.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get();
  const value = row?.["n"];
  if (typeof value !== "number") throw new Error(`count(${table}) failed`);
  return value;
}
