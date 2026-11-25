import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import * as z from "zod";
import { decodeToPcm, SAMPLE_RATE } from "../asr/corpus.ts";
import { sortformerTurns, whisperSegments, type SeedSegment, type SpeakerTurn } from "./tools.ts";

// Golden set v0 (ADR 005, architecture §13): Téo's own recordings, exported
// from Sondine, seeded by a non-candidate control, corrected by him, with
// consent per speaker. Private: kept outside the repository and outside
// iCloud-synced folders, never committed.

export const goldenRoot =
  process.env["SONDINE_GOLDEN"] ??
  join(homedir(), "Library", "Application Support", "Sondine", "golden", "v0");

/** v0: three situations, about 10 min each (Téo, 2026-11-06). */
export const SCENARIOS = {
  "appel-fr": "Un appel en français",
  "personne-fr": "Une discussion en français à 2 ou 3, en personne",
  "fr-en": "Une conversation qui passe du français à l'anglais",
} as const;
export type ScenarioId = keyof typeof SCENARIOS;

export const GoldenMeta = z.strictObject({
  scenario: z.string(),
  source: z.string(),
  durationMs: z.int().positive(),
  audioSha256: z.string().regex(/^[0-9a-f]{64}$/),
  seededBy: z.strictObject({ asr: z.string(), speakers: z.string() }),
  createdAt: z.string(),
});
export type GoldenMeta = z.output<typeof GoldenMeta>;

export interface ReferenceTurn {
  readonly startSec: number;
  readonly endSec: number;
  readonly speaker: string;
  readonly text: string;
}

export interface Reference {
  readonly status: "à corriger" | "corrigé";
  /** `S1 = Moi`: the labels and who they are, as Téo writes them. */
  readonly voices: string;
  readonly turns: readonly ReferenceTurn[];
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** « 01:02:03.4 » */
export function formatTime(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  const s = Math.floor(tenths / 10);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}.${tenths % 10}`;
}

function parseTime(text: string): number {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(text.trim());
  if (match === null) throw new Error(`not a time: ${text}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

const TURN = /^\[([^\]→]+)→([^\]]+)\]\s*([^:]+):\s?(.*)$/;

export function formatReference(title: string, reference: Reference): string {
  return [
    `# Sondine golden set v0 — ${title}`,
    "# Corrigez le texte et les voix, une ligne par tour : [début → fin] Voix: texte",
    "# Deux personnes qui parlent en même temps : deux lignes qui se chevauchent.",
    "# Quand tout est juste, remplacez « à corriger » par « corrigé ».",
    `# statut: ${reference.status}`,
    `# voix: ${reference.voices}`,
    "",
    ...reference.turns.map(
      (turn) =>
        `[${formatTime(turn.startSec)} → ${formatTime(turn.endSec)}] ${turn.speaker}: ${turn.text}`,
    ),
    "",
  ].join("\n");
}

export function parseReference(text: string): Reference {
  let status: Reference["status"] = "à corriger";
  let voices = "";
  const turns: ReferenceTurn[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("#")) {
      const statusMatch = /^#\s*statut:\s*(.+)$/.exec(line);
      if (statusMatch?.[1] !== undefined) {
        status = statusMatch[1].trim() === "corrigé" ? "corrigé" : "à corriger";
      }
      const voicesMatch = /^#\s*voix:\s*(.*)$/.exec(line);
      if (voicesMatch?.[1] !== undefined) voices = voicesMatch[1].trim();
      continue;
    }
    const match = TURN.exec(line);
    if (
      match === null ||
      match[1] === undefined ||
      match[2] === undefined ||
      match[3] === undefined
    ) {
      throw new Error(`line ${index + 1}: expected "[début → fin] Voix: texte"`);
    }
    const startSec = parseTime(match[1]);
    const endSec = parseTime(match[2]);
    if (!(endSec > startSec)) throw new Error(`line ${index + 1}: the end is not after the start`);
    turns.push({ startSec, endSec, speaker: match[3].trim(), text: (match[4] ?? "").trim() });
  }
  return { status, voices, turns };
}

/** Each Whisper segment gets the Sortformer speaker it overlaps most (S1, S2… in order of first word). */
export function seedTurns(
  segments: readonly SeedSegment[],
  speakers: readonly SpeakerTurn[],
): ReferenceTurn[] {
  const labels = new Map<string, string>();
  return segments
    .filter((segment) => segment.text !== "" && segment.endSec > segment.startSec)
    .map((segment) => {
      let best: { speaker: string; overlap: number } | null = null;
      for (const turn of speakers) {
        const overlap =
          Math.min(segment.endSec, turn.endSec) - Math.max(segment.startSec, turn.startSec);
        if (overlap > 0 && (best === null || overlap > best.overlap))
          best = { speaker: turn.speaker, overlap };
      }
      const raw = best?.speaker ?? "?";
      let label = labels.get(raw);
      if (label === undefined) {
        label = raw === "?" ? "?" : `S${labels.size + 1}`;
        if (raw !== "?") labels.set(raw, label);
      }
      return {
        startSec: segment.startSec,
        endSec: segment.endSec,
        speaker: label,
        text: segment.text,
      };
    });
}

/** Copies an exported recording in, seeds its reference, and returns its folder. */
export async function addGolden(
  audioFile: string,
  scenario: ScenarioId,
  log: (line: string) => void,
): Promise<string> {
  const directory = join(goldenRoot, scenario);
  if (existsSync(join(directory, "reference.txt"))) {
    throw new Error(`${scenario} already has a reference in ${directory}`);
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const pcm = decodeToPcm(audioFile);
  writeFileSync(join(directory, "audio.pcm"), pcm, { mode: 0o600 });
  const wav = join(directory, "audio.wav");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    audioFile,
    "-ac",
    "1",
    "-ar",
    String(SAMPLE_RATE),
    wav,
  ]);
  log("seeding the text with Whisper large-v3");
  const segments = await whisperSegments(wav, log);
  log("seeding the voices with Sortformer");
  const turns = seedTurns(segments, await sortformerTurns(wav, log));
  const meta: GoldenMeta = {
    scenario,
    source: basename(audioFile),
    durationMs: Math.round((pcm.byteLength / 2 / SAMPLE_RATE) * 1000),
    audioSha256: createHash("sha256").update(pcm).digest("hex"),
    seededBy: {
      asr: "whisper.cpp v1.9.5 ggml-large-v3 (sha256 64d182b4)",
      speakers: "speech.cpp 0.9.3 nemotron-3-diarization Q8_0 (sha256 336df635)",
    },
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(directory, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, {
    mode: 0o600,
  });
  writeFileSync(
    join(directory, "reference.txt"),
    formatReference(SCENARIOS[scenario], { status: "à corriger", voices: "S1 = ?, S2 = ?", turns }),
    { mode: 0o600 },
  );
  return directory;
}

export interface GoldenStatus {
  readonly scenario: string;
  readonly durationMs: number;
  readonly status: Reference["status"] | "illisible";
  readonly turns: number;
  readonly problem: string | null;
}

export function goldenStatus(): GoldenStatus[] {
  if (!existsSync(goldenRoot)) return [];
  return readdirSync(goldenRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(goldenRoot, entry.name, "meta.json")))
    .map((entry) => {
      const directory = join(goldenRoot, entry.name);
      const meta = GoldenMeta.parse(JSON.parse(readFileSync(join(directory, "meta.json"), "utf8")));
      try {
        const reference = parseReference(readFileSync(join(directory, "reference.txt"), "utf8"));
        return {
          scenario: meta.scenario,
          durationMs: meta.durationMs,
          status: reference.status,
          turns: reference.turns.length,
          problem: null,
        };
      } catch (error) {
        return {
          scenario: meta.scenario,
          durationMs: meta.durationMs,
          status: "illisible",
          turns: 0,
          problem: error instanceof Error ? error.message : String(error),
        };
      }
    });
}
