import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "./io.ts";
import {
  readPcm16Mono,
  encodePcm16Mono,
  normalizeRms,
  mixAt,
  finalizeMix,
  seededRandom,
  rms,
} from "./signal.ts";
import type { Corpus, Source, Scenario, Event } from "./schema.ts";

const RATE = 16000;
const PAD = 3 * RATE;
export const CONDITIONS = [
  "clean",
  "quiet-12db",
  "quiet-24db",
  "room-proxy",
  "music-equal-rms",
  "speech-proxy-equal-rms",
  "echo-120ms",
] as const;
type Condition = (typeof CONDITIONS)[number];

function altered(samples: Float32Array, condition: Condition) {
  const result = samples.slice();
  const gain =
    condition === "quiet-12db"
      ? 10 ** (-12 / 20)
      : condition === "quiet-24db"
        ? 10 ** (-24 / 20)
        : condition === "room-proxy"
          ? 10 ** (-12 / 20)
          : 1;
  // Deliberately simple distance proxy: one-pole low-pass plus attenuation.
  // It is not a recording of a distant speaker, a whisper, or a measured room.
  let previous = 0;
  for (let i = 0; i < result.length; i++) {
    const value = result[i] ?? 0;
    previous = condition === "room-proxy" ? previous + 0.35 * (value - previous) : value;
    result[i] = previous * gain;
  }
  return result;
}

export async function generateScenarios(
  corpus: Corpus,
  paths: ReadonlyMap<string, string>,
  cache: string,
  seed: number,
): Promise<Scenario[]> {
  const dir = join(cache, "inputs");
  await mkdir(dir, { recursive: true });
  const signals = new Map<string, Float32Array>();
  const decoded = [];
  for (const source of corpus.sources) {
    const path = paths.get(source.id);
    if (!path) throw new Error(`Missing decoded source ${source.id}`);
    const bytes = await readFile(path);
    const raw = readPcm16Mono(bytes);
    const normalized = normalizeRms(raw, -24);
    signals.set(source.id, normalized.samples);
    decoded.push({
      id: source.id,
      sha256: sha256(bytes),
      sampleCount: raw.length,
      rawRms: rms(raw),
      normalizationGain: normalized.appliedGain,
      limitedByPeak: normalized.limitedByPeak,
    });
  }
  await writeFile(join(cache, "decoded-manifest.json"), JSON.stringify(decoded, null, 2));
  const get = (source: Source) => {
    const signal = signals.get(source.id);
    if (!signal) throw new Error(`No signal ${source.id}`);
    return signal;
  };
  const instrumental = corpus.sources.find((source) => source.role === "instrumental");
  const spoken = corpus.sources.find((source) => source.role === "spoken-proxy");
  if (!instrumental || !spoken)
    throw new Error("Instrumental and spoken background controls are required");
  const scenarios: Scenario[] = [];
  async function save(
    id: string,
    suite: Scenario["suite"],
    condition: string,
    signal: Float32Array,
    events: readonly Event[],
    sourceIds: readonly string[],
    sourceKind: "input" | "system",
    backgroundPair: string | null = null,
    forcedGain?: number,
  ) {
    const finalized =
      forcedGain === undefined
        ? finalizeMix(signal)
        : { samples: signal.map((x) => x * forcedGain), appliedGain: forcedGain };
    const bytes = encodePcm16Mono(finalized.samples);
    await writeFile(join(dir, `${id}.wav`), bytes);
    const result: Scenario = {
      id,
      suite,
      condition,
      sampleCount: signal.length,
      events,
      sourceIds,
      sourceKind,
      inputSha256: sha256(bytes),
      finalGain: finalized.appliedGain,
      backgroundPair,
    };
    scenarios.push(result);
    return result;
  }
  async function speechScene(
    id: string,
    suite: "isolated" | "timeline",
    condition: Condition,
    sources: readonly Source[],
    gapMs: number,
  ) {
    const random = seededRandom((seed ^ Number.parseInt(sha256(id).slice(0, 8), 16)) >>> 0);
    const events: Event[] = [];
    let cursor = PAD;
    for (const source of sources) {
      const signal = get(source);
      events.push({
        sourceId: source.id,
        startSample: cursor,
        endSample: cursor + signal.length,
        language: source.language,
        speaker: source.speaker,
      });
      cursor += signal.length + Math.round((gapMs * RATE) / 1000);
    }
    const length = cursor - Math.round((gapMs * RATE) / 1000) + PAD;
    const target = new Float32Array(length);
    const background = new Float32Array(length);
    const backgroundSource =
      condition === "music-equal-rms"
        ? instrumental
        : condition === "speech-proxy-equal-rms"
          ? spoken
          : null;
    if (backgroundSource) {
      const values = get(backgroundSource);
      const offset = Math.floor(random() * values.length);
      for (let i = 0; i < length; i++) background[i] = values[(offset + i) % values.length] ?? 0;
      target.set(background);
    }
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      const event = events[i];
      if (!source || !event) throw new Error("Event/source mismatch");
      const signal = altered(get(source), condition);
      mixAt(target, signal, event.startSample, 1);
      if (condition === "echo-120ms") mixAt(target, signal, event.startSample + 1920, 0.5);
    }
    const pairId = backgroundSource ? `${id}-background` : null;
    const scene = await save(
      id,
      suite,
      condition,
      target,
      events,
      [...sources.map((source) => source.id), ...(backgroundSource ? [backgroundSource.id] : [])],
      "input",
      pairId,
    );
    if (pairId && backgroundSource)
      await save(
        pairId,
        "paired-background",
        condition,
        background,
        events,
        [backgroundSource.id],
        "input",
        null,
        scene.finalGain,
      );
  }
  const words = corpus.sources.filter((source) => source.role === "word");
  for (const word of words)
    for (const condition of CONDITIONS)
      await speechScene(`isolated-${word.id}-${condition}`, "isolated", condition, [word], 0);
  for (const language of ["fr", "en"]) {
    const selected = words.filter((word) => word.language === language);
    if (!selected.length) continue;
    for (const gap of [600, 55_000])
      for (const condition of ["clean", "quiet-24db", "music-equal-rms"] as const) {
        await speechScene(
          `timeline-${language}-gap${gap}-${condition}`,
          "timeline",
          condition,
          selected,
          gap,
        );
      }
  }
  for (const source of corpus.sources.filter((item) => item.role === "noise")) {
    for (const gapMs of [4000, 55_000]) {
      const value = get(source);
      const gap = (gapMs * RATE) / 1000;
      const target = new Float32Array(PAD * 2 + 6 * value.length + 5 * gap);
      for (let i = 0; i < 6; i++) mixAt(target, value, PAD + i * (value.length + gap), 1);
      await save(
        `noise-${source.id}-gap${gapMs}`,
        "negative",
        `${source.category}-gap${gapMs}`,
        target,
        [],
        [source.id],
        "input",
      );
    }
  }
  for (const source of corpus.sources.filter((item) =>
    ["instrumental", "vocal-media", "spoken-proxy"].includes(item.role),
  )) {
    for (const route of ["input", "system"] as const)
      await save(
        `media-${route}-${source.id}`,
        source.role === "instrumental" ? "negative" : "media",
        source.role,
        get(source),
        [],
        [source.id],
        route,
      );
  }
  await save(
    "digital-silence",
    "negative",
    "synthetic-silence",
    new Float32Array(60 * RATE),
    [],
    [],
    "input",
  );
  const clicks = new Float32Array(60 * RATE);
  const random = seededRandom(seed);
  for (let i = 0; i < 60; i++) {
    const at = Math.floor(random() * (clicks.length - 160));
    for (let j = 0; j < 160; j++) clicks[at + j] = ((j % 2) * 2 - 1) * 0.5 * Math.exp(-j / 24);
  }
  await save("synthetic-clicks", "negative", "synthetic-clicks", clicks, [], [], "input");
  return scenarios;
}
