import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEnvelopeDetector,
  envelopeOf,
  type Envelope,
  type SameMomentVerdict,
} from "@sondine/engines";
import { parsePhoneRecordingHeader } from "@sondine/protocol";
import * as z from "zod";

// The same-moment detector (ADR 032, M5.7) on real double recordings: each
// pair is decoded to 16 kHz mono as the import does (`afconvert`, in a
// private temporary folder removed at once), turned into envelopes and
// compared as core compares them. What is kept is numbers only: no path,
// no audio, no text.

export const pairsSchema = z.strictObject({
  pairs: z
    .array(
      z.strictObject({
        /** A name without anything private: `near-1`, `rooms-3`. */
        id: z.string().regex(/^[\w.-]{1,40}$/),
        /** `same`: one meeting heard by both; `different`: two rooms at the same hour. */
        expect: z.enum(["same", "different"]),
        /** The Mac's audio, as « Exporter l'audio » writes it (WAV), or any file macOS reads. */
        mac: z.string().min(1),
        /** The iPhone app's file (its header gives its start), or any file with `phoneStartMs`. */
        phone: z.string().min(1),
        /** Wall-clock ms of the Mac file's first sample; when absent, see `--shift`. */
        macStartMs: z.int().positive().optional(),
        /** Wall-clock ms of the phone file's first sample; the header's when absent. */
        phoneStartMs: z.int().positive().optional(),
        /** Where the hand clap is in each file, seconds from its start (`same` pairs). */
        clapMacS: z.number().nonnegative().optional(),
        clapPhoneS: z.number().nonnegative().optional(),
      }),
    )
    .min(1),
});
export type Pairs = z.output<typeof pairsSchema>;
export type Pair = Pairs["pairs"][number];

export interface PairResult {
  readonly id: string;
  readonly expect: "same" | "different";
  readonly linked: boolean;
  readonly reason: string | null;
  /** |found − clap| at the clap, ms; null without a link or a clap. */
  readonly errorMs: number | null;
  readonly peak: number;
  readonly prominence: number;
  readonly score: number;
  readonly windows: number;
  readonly agreeing: number;
  readonly driftPpm: number | null;
  readonly clarity: { readonly phone: number; readonly mac: number } | null;
  readonly audioSeconds: { readonly phone: number; readonly mac: number };
  readonly decodeMs: number;
  readonly envelopeMs: number;
  readonly detectMs: number;
  /** As M5.7's exit asks: a link within 100 ms for `same`, no link for `different`. */
  readonly pass: boolean;
}

/** 16 kHz mono 16-bit PCM of `path`, through `afconvert` as the import does. */
export function decode(path: string): Int16Array {
  const folder = mkdtempSync(join(tmpdir(), "sondine-bench-same-moment-"));
  try {
    const wav = join(folder, "decoded.wav");
    execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", path, wav], {
      stdio: "ignore",
    });
    return wavSamples(readFileSync(wav));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** The samples of a 16-bit PCM WAV's `data` chunk. */
export function wavSamples(bytes: Buffer): Int16Array {
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString("ascii", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === "data") {
      const end = Math.min(bytes.length, at + 8 + size);
      const copy = Buffer.from(bytes.subarray(at + 8, end));
      return new Int16Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / 2));
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in the decoded WAV");
}

/** The iPhone app's start in `path`'s comment tag, or null. */
export function phoneHeaderStart(path: string): number | null {
  const output = execFileSync("/usr/bin/afinfo", ["-i", path], { encoding: "utf8" });
  const comment = /^\s*comments\s*: "(.*)"\s*$/m.exec(output)?.[1] ?? null;
  return parsePhoneRecordingHeader(comment)?.startedWallMs ?? null;
}

export interface RunOptions {
  /** The search each side of what the clocks propose, ms (core: 2 min). */
  readonly searchMs: number;
  /**
   * Without the Mac's start, the clocks are taken to agree at the clap and
   * the proposal is moved by this much, so the detector has to find it.
   */
  readonly shiftMs: number;
}

export function runPair(pair: Pair, options: RunOptions): PairResult {
  const decodeStart = performance.now();
  const macPcm = decode(pair.mac);
  const phonePcm = decode(pair.phone);
  const decodeMs = performance.now() - decodeStart;
  const phoneStartMs = pair.phoneStartMs ?? phoneHeaderStart(pair.phone);
  if (phoneStartMs === null)
    throw new Error(`${pair.id}: the phone file has no header and no phoneStartMs`);
  const clap =
    pair.clapMacS === undefined || pair.clapPhoneS === undefined
      ? null
      : { mac: pair.clapMacS * 1000, phone: pair.clapPhoneS * 1000 };
  let macStartMs = pair.macStartMs;
  let expectedOffsetMs = 0;
  if (macStartMs === undefined) {
    if (clap === null) throw new Error(`${pair.id}: give macStartMs, or the clap in both files`);
    // The clocks taken to agree at the clap, then the proposal moved away from it.
    macStartMs = phoneStartMs + clap.phone - clap.mac;
    expectedOffsetMs = options.shiftMs;
  }
  const envelopeStart = performance.now();
  const phone = envelopeOf(phoneStartMs, phonePcm);
  const mac = envelopeOf(macStartMs, macPcm);
  const envelopeMs = performance.now() - envelopeStart;
  const detectStart = performance.now();
  const verdict = createEnvelopeDetector().detect(phone, mac, {
    expectedOffsetMs,
    toleranceMs: options.searchMs,
  });
  const detectMs = performance.now() - detectStart;
  const errorMs =
    verdict.linked && clap !== null
      ? Math.abs(
          offsetAt(verdict, phoneStartMs + clap.phone) -
            (macStartMs + clap.mac - (phoneStartMs + clap.phone)),
        )
      : null;
  return {
    id: pair.id,
    expect: pair.expect,
    linked: verdict.linked,
    reason: verdict.linked ? null : verdict.reason,
    errorMs: errorMs === null ? null : Math.round(errorMs),
    peak: round(verdict.peak),
    prominence: round(verdict.prominence),
    score: round(verdict.score),
    windows: verdict.windows,
    agreeing: verdict.agreeing,
    driftPpm: verdict.linked ? verdict.driftPpm : null,
    clarity: verdict.linked ? verdict.clarity : null,
    audioSeconds: { phone: seconds(phone), mac: seconds(mac) },
    decodeMs: Math.round(decodeMs),
    envelopeMs: Math.round(envelopeMs),
    detectMs: Math.round(detectMs),
    pass:
      pair.expect === "different"
        ? !verdict.linked
        : verdict.linked && (errorMs === null || errorMs < 100),
  };
}

/** The offset the verdict gives at a phone wall time, drift included. */
export function offsetAt(
  verdict: Extract<SameMomentVerdict, { linked: true }>,
  phoneMs: number,
): number {
  return verdict.offsetMs + (verdict.driftPpm * (phoneMs - verdict.anchorMs)) / 1e6;
}

const seconds = (envelope: Envelope) => Math.round(envelope.db.length / 100);
const round = (value: number) => Math.round(value * 1000) / 1000;

/** A table of the results, numbers only. */
export function resultTable(results: readonly PairResult[]): string {
  const rows = results.map(
    (r) =>
      `| ${r.id} | ${r.expect} | ${r.linked ? "linked" : `no (${r.reason ?? ""})`} | ${r.errorMs ?? "—"} | ${r.peak} | ${r.prominence} | ${r.score} | ${r.agreeing}/${r.windows} | ${r.driftPpm ?? "—"} | ${r.audioSeconds.phone} / ${r.audioSeconds.mac} | ${r.envelopeMs + r.detectMs} | ${r.pass ? "pass" : "FAIL"} |`,
  );
  return [
    "| pair | expect | found | error at clap (ms) | peak | prominence | score | windows | drift (ppm) | audio s (phone / Mac) | envelope + detect (ms) | |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}
