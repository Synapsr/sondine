import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAnalysisInput,
  publishAnalysis,
  setDictationText,
  upsertApp,
  type AnalysisInput,
} from "@sondine/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Boot, rows, scalar, tempDb, type Run, type TempDb } from "../../../test/capture-fixture";
import type { DictatedText } from "../analysis/scheduler";
import { runEpisodePass } from "../episodes/episode-pass";
import { dictationTexts } from "./dictation-text";

// Hex's file against what was captured, end to end.

const START = Date.UTC(2026, 10, 5, 8, 0, 0);
let temp: TempDb;
let home: string;
let boot: Boot;
let mic: Run;

beforeEach(() => {
  temp = tempDb();
  home = mkdtempSync(join(tmpdir(), "sondine-text-home-"));
  boot = new Boot(temp.db, START);
  mic = boot.run({ startSec: 0 });
  boot.chunks(mic, 0, 600);
  boot.region(mic, 10, 18);
  boot.region(mic, 300, 306);
  runEpisodePass(temp.db, { nowMs: boot.wallMs(600), fullScan: true });
  upsertApp(temp.db, { bundleId: "anomaly.hex", name: "Hex", seenAtMs: START });
  temp.db
    .statement(
      "UPDATE episodes SET context = 'dictation', primary_app_id = (SELECT id FROM apps WHERE bundle_id = 'anomaly.hex')",
    )
    .run();
});
afterEach(() => {
  temp.cleanup();
  rmSync(home, { recursive: true, force: true });
});

const hex = (...said: [from: number, to: number, text: string][]) => {
  const folder = join(home, "Library", "Application Support", "hex");
  mkdirSync(folder, { recursive: true });
  const entries = said.map(([from, to, text], id) => ({
    id,
    kind: "dictation",
    timestamp_ms: boot.wallMs(to) + 900,
    total_ms: 900,
    audio_ms: Math.round((to - from) * 1000),
    final_text: text,
  }));
  writeFileSync(join(folder, "history.json"), JSON.stringify({ version: 1, entries }));
};
const episodes = () =>
  rows(temp.db, "SELECT id FROM episodes ORDER BY started_at_ms").map((row) => Number(row["id"]));
const textOf = (episodeId: number | undefined) => {
  const input = loadAnalysisInput(temp.db, episodeId ?? -1);
  return input === null
    ? null
    : (dictationTexts(temp.db, home)
        .of(input)
        ?.segments.map((segment) => segment.text) ?? null);
};

describe("a dictation's text, from its app", () => {
  it("is what Hex typed, for what it covers, unless the user said no", () => {
    hex([9.8, 18.2, "Ajoute du lait."]);
    const [first, second] = episodes();
    expect(textOf(first)).toEqual(["Ajoute du lait."]);
    expect(textOf(second)).toBeNull();
    setDictationText(temp.db, "anomaly.hex", false, START);
    expect(textOf(first)).toBeNull();
  });

  it("is never another app's, nor of an episode that is no dictation", () => {
    hex([9.8, 18.2, "Ajoute du lait."]);
    const [first] = episodes();
    temp.db.statement("UPDATE episodes SET context = 'in_person'").run();
    expect(textOf(first)).toBeNull();
    upsertApp(temp.db, { bundleId: "com.example.other", name: "Other", seenAtMs: START });
    temp.db
      .statement(
        "UPDATE episodes SET context = 'dictation', primary_app_id = (SELECT id FROM apps WHERE bundle_id = 'com.example.other')",
      )
      .run();
    expect(textOf(first)).toBeNull();
  });

  it("takes the past dictations it covers, once", async () => {
    hex([9.8, 18.2, "Ajoute du lait."]);
    const [first, second] = episodes();
    temp.db.statement("DELETE FROM jobs").run();
    for (const episodeId of [first, second]) {
      const { lastInsertRowid } = temp.db
        .statement(
          `INSERT INTO analysis_runs (episode_id, stage, status, pass_uid, engine_id, engine_version,
             engine_runtime, adapter_class, engine_config, input_hash, input_generation, started_at_ms)
           VALUES (?, 'asr', 'running', ?, 'parakeet', '1', 'x', 'product', '{}', 'h', 1, 1)`,
        )
        .run(episodeId ?? -1, `p${episodeId}`);
      publishAnalysis(temp.db, {
        episodeId: episodeId ?? -1,
        stage: "asr",
        runId: Number(lastInsertRowid),
        inputGeneration: Number(
          scalar(temp.db, "SELECT input_generation FROM episodes WHERE id = ?", episodeId ?? -1),
        ),
        segments: [],
        turns: [],
      });
    }
    const texts = dictationTexts(temp.db, home);
    const taken: (number | string)[] = [];
    const publish = (input: AnalysisInput, text: DictatedText) => {
      taken.push(input.episodeId, ...text.segments.map((segment) => segment.text));
      return true;
    };
    expect(await texts.takePast(START, publish)).toBe(1);
    expect(taken).toEqual([first, "Ajoute du lait."]);
    expect(await texts.takePast(START, publish)).toBe(0);
  });

  it("looks for them again when the app is not there yet, or the user said no", async () => {
    const texts = dictationTexts(temp.db, home);
    expect(await texts.takePast(START, () => true)).toBe(0);
    setDictationText(temp.db, "anomaly.hex", false, START);
    hex([9.8, 18.2, "Ajoute du lait."]);
    expect(await texts.takePast(START, () => true)).toBe(0);
    expect(rows(temp.db, "SELECT value FROM settings WHERE key = 'dictation.text.past'")).toEqual(
      [],
    );
  });
});
