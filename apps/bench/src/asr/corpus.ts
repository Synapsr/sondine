import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import { cachePath, fetchPinned, type PinnedFile } from "./assets.ts";
import type { CorpusId } from "./ids.ts";

// Corpora of the ASR bench (architecture §13, quick tier): pinned upstream
// files, a deterministic selection, audio converted once to PCM16 mono at
// 16 kHz, and a manifest whose hash goes into every result.

export const SAMPLE_RATE = 16_000;

export const CorpusItem = z.strictObject({
  id: z.string().min(1),
  /** Relative to the corpus directory: raw PCM16 little-endian, mono, 16 kHz. */
  audio: z.string().min(1),
  audioSha256: z.string().regex(/^[0-9a-f]{64}$/),
  durationMs: z.int().positive(),
  language: z.enum(["fr", "en"]),
  /** As the corpus writes it; scoring normalizes it with fr-norm. */
  reference: z.string(),
});
export type CorpusItem = z.output<typeof CorpusItem>;

export interface Corpus {
  readonly id: string;
  readonly directory: string;
  readonly items: readonly CorpusItem[];
  /** sha256 of the manifest file. */
  readonly manifestSha256: string;
  readonly license: string;
}

interface FleursSpec {
  readonly language: "fr" | "en";
  readonly locale: string;
  readonly tsv: PinnedFile;
  readonly audio: PinnedFile;
}

const FLEURS_REVISION = "70bb2e84b976b7e960aa89f1c648e09c59f894dd";
const fleursUrl = (path: string) =>
  `https://huggingface.co/datasets/google/fleurs/resolve/${FLEURS_REVISION}/${path}`;

const FLEURS: Record<"fr" | "en", FleursSpec> = {
  fr: {
    language: "fr",
    locale: "fr_fr",
    tsv: {
      url: fleursUrl("data/fr_fr/test.tsv"),
      sizeBytes: 456_972,
      sha256: "5d06d338b242e00786fcf12c4c92008b9f399d5a5c872c91dca90572e7869c0d",
      path: "downloads/fleurs/fr_fr/test.tsv",
    },
    audio: {
      url: fleursUrl("data/fr_fr/audio/test.tar.gz"),
      sizeBytes: 349_036_055,
      sha256: "d23690e102f373554d1b544cd2ff1e76e4fedeb04953c0b72751a1b7c518cfdd",
      path: "downloads/fleurs/fr_fr/test.tar.gz",
    },
  },
  en: {
    language: "en",
    locale: "en_us",
    tsv: {
      url: fleursUrl("data/en_us/test.tsv"),
      sizeBytes: 367_864,
      sha256: "74c046239374deeb60fa63f258f907388093a32bcaa3140965f70ef05c79f7ca",
      path: "downloads/fleurs/en_us/test.tsv",
    },
    audio: {
      url: fleursUrl("data/en_us/audio/test.tar.gz"),
      sizeBytes: 289_851_356,
      sha256: "d9c2e37b41aacd41bc283554a0a82b5476b36887049774ecb2819dcaaa55a356",
      path: "downloads/fleurs/en_us/test.tar.gz",
    },
  },
};

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Decodes any audio file to PCM16 mono 16 kHz with ffmpeg. */
export function decodeToPcm(path: string): Buffer {
  return execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      path,
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-",
    ],
    { maxBuffer: 1024 * 1024 * 1024 },
  );
}

/**
 * The first `size` sentence ids in ascending order, one recording each (the
 * smallest file name): FLEURS has several readers per sentence, and one
 * sentence read twice would weigh twice.
 */
export function selectFleurs(
  tsv: string,
  size: number,
): { file: string; reference: string; sentence: number }[] {
  const bySentence = new Map<number, { file: string; reference: string }>();
  for (const line of tsv.split("\n")) {
    const columns = line.split("\t");
    const sentence = Number(columns[0]);
    const file = columns[1];
    const reference = columns[2];
    if (!Number.isInteger(sentence) || file === undefined || reference === undefined) continue;
    const kept = bySentence.get(sentence);
    if (kept === undefined || file < kept.file) bySentence.set(sentence, { file, reference });
  }
  return [...bySentence.entries()]
    .toSorted(([a], [b]) => a - b)
    .slice(0, size)
    .map(([sentence, value]) => ({ sentence, ...value }));
}

/** Fetches and prepares a corpus (idempotent), then loads its manifest. */
export async function prepareCorpus(
  id: CorpusId,
  size: number,
  log: (line: string) => void,
): Promise<Corpus> {
  const spec = FLEURS[id === "fleurs-fr" ? "fr" : "en"];
  const directory = cachePath(`corpora/${id}-test-${size}`);
  const manifestPath = join(directory, "manifest.jsonl");
  if (!existsSync(manifestPath)) {
    const tsv = readFileSync(await fetchPinned(spec.tsv, log), "utf8");
    const archive = await fetchPinned(spec.audio, log);
    const chosen = selectFleurs(tsv, size);
    const staging = join(directory, "staging");
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(join(directory, "audio"), { recursive: true });
    mkdirSync(staging, { recursive: true });
    log(`extracting ${chosen.length} recordings of ${id}`);
    execFileSync("tar", [
      "-xzf",
      archive,
      "-C",
      staging,
      ...chosen.map((item) => `test/${item.file}`),
    ]);
    const items = chosen.map((item): CorpusItem => {
      const pcm = decodeToPcm(join(staging, "test", item.file));
      const audio = `audio/${item.sentence}.pcm`;
      writeFileSync(join(directory, audio), pcm);
      return {
        id: `${id}/${item.sentence}`,
        audio,
        audioSha256: sha256(pcm),
        durationMs: Math.round((pcm.byteLength / 2 / SAMPLE_RATE) * 1000),
        language: spec.language,
        reference: item.reference,
      };
    });
    rmSync(staging, { recursive: true, force: true });
    writeFileSync(manifestPath, items.map((item) => JSON.stringify(item)).join("\n") + "\n");
  }
  const text = readFileSync(manifestPath, "utf8");
  const items = text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => CorpusItem.parse(JSON.parse(line)));
  return { id, directory, items, manifestSha256: sha256(text), license: "CC-BY-4.0 (FLEURS)" };
}

/** An item's samples, checked against the manifest. */
export function loadSamples(corpus: Corpus, item: CorpusItem): Int16Array {
  const bytes = readFileSync(join(corpus.directory, item.audio));
  if (sha256(bytes) !== item.audioSha256)
    throw new Error(`${item.id}: audio does not match the manifest`);
  // A copy: a small file's Buffer may sit at an odd offset of a shared pool.
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
