import { spawn } from "node:child_process";
import type { SpeechPiece } from "@sondine/db";
import * as z from "zod";
import type { ReadTrackAudio } from "../audio/track-audio";

// `sondine-voice embed` (architecture §8): WeSpeaker on Core ML in the
// sandboxed `Sondine Voice.app`, audio in on stdin, no file, no network.

const TOOL_TIMEOUT_MS = 120_000;
/** Voices per request (the tool takes 64). */
export const VOICES_PER_REQUEST = 32;
/** A missing stretch (gap, expired audio) splits a piece; what is left must last 1 s. */
const MIN_PIECE_SAMPLES = 16_000;

export interface VoiceTool {
  readonly binary: string;
  readonly model: string;
}

const Answer = z.object({
  modelVersion: z.string().min(1).max(200),
  speakers: z.array(
    z.object({
      key: z.string(),
      embedding: z.array(z.number()).length(256),
      speechMs: z.number().int().min(0),
    }),
  ),
  errors: z.array(z.object({ key: z.string(), message: z.string() })),
});
export type VoiceAnswer = z.output<typeof Answer>;

/** Runs `sondine-voice embed` on one request. */
export function embed(
  tool: VoiceTool,
  speakers: readonly { key: string; pieces: string[] }[],
  signal: AbortSignal,
): Promise<VoiceAnswer> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool.binary, ["embed", "--model", tool.model], {
      stdio: ["pipe", "pipe", "pipe"],
      signal,
      timeout: TOOL_TIMEOUT_MS,
    });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      err = (err + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", reject);
    // The tool may exit before it read everything (EPIPE): its exit says why.
    child.stdin.on("error", () => undefined);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`sondine-voice exited with ${code}: ${err.trim()}`));
        return;
      }
      try {
        resolve(Answer.parse(JSON.parse(Buffer.concat(out).toString("utf8"))));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify({ speakers }));
  });
}

/** A voice's pieces as base64 PCM16, without what the spool no longer holds. */
export function readPieces(read: ReadTrackAudio, pieces: readonly SpeechPiece[]): string[] {
  const out: string[] = [];
  for (const piece of pieces) {
    const audio = read(piece);
    let from = 0;
    const cuts = [
      ...audio.missing.map(
        (span) =>
          [span.sampleStart - piece.sampleStart, span.sampleEnd - piece.sampleStart] as const,
      ),
      [audio.samples.length, audio.samples.length] as const,
    ];
    for (const [start, end] of cuts) {
      if (start - from >= MIN_PIECE_SAMPLES) {
        const slice = audio.samples.subarray(from, start);
        out.push(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString("base64"));
      }
      from = Math.max(from, end);
    }
  }
  return out;
}

/** Embeds voices in requests of `VOICES_PER_REQUEST`; voices with too little speech are left out. */
export async function embedAll(
  tool: VoiceTool,
  speakers: readonly { key: string; pieces: string[] }[],
  signal: AbortSignal,
): Promise<{
  readonly modelVersion: string | null;
  readonly speakers: VoiceAnswer["speakers"];
  readonly tooShort: number;
}> {
  const embedded: VoiceAnswer["speakers"] = [];
  let modelVersion: string | null = null;
  let tooShort = 0;
  for (let start = 0; start < speakers.length; start += VOICES_PER_REQUEST) {
    const answer = await embed(tool, speakers.slice(start, start + VOICES_PER_REQUEST), signal);
    if (modelVersion !== null && answer.modelVersion !== modelVersion) {
      throw new Error("sondine-voice changed version during a run");
    }
    modelVersion = answer.modelVersion;
    embedded.push(...answer.speakers);
    tooShort += answer.errors.length;
  }
  return { modelVersion, speakers: embedded, tooShort };
}
