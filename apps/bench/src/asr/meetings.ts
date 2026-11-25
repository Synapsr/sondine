import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { frNormTokens, wordErrorRate } from "@sondine/core";
import * as z from "zod";
import { SORTFORMER_MODEL } from "../golden/tools.ts";
import { cachePath, fetchPinned, PROBE_WEIGHTS, SILERO_VAD, speechExecutable } from "./assets.ts";
import { createBenchEngine } from "./engines.ts";
import type { EngineId } from "./ids.ts";

// Conversational French with speakers (architecture §13 quick tier): SUMM-RE
// test meetings, their close-talk tracks summed into one mix (the condition
// Sondine hears through one microphone), scored with MeetEval's tcpWER and
// cpWER and a speaker-agnostic WER. Nemotron runs as the product sends audio
// (speakers and timestamps); the challengers run speech.cpp's own pipeline,
// Silero regions with Sortformer speakers (a composite probe).

const run = promisify(execFile);
const RATE = 16_000;
const MEETEVAL = "meeteval==0.4.3";
/** MeetEval reads SegLST JSON with simplejson, an optional dependency. */
const SIMPLEJSON = "simplejson==4.2.0";
/** MeetEval's usual collar for tcpWER (seconds of hypothesis timing slack). */
const COLLAR_S = 5;

const Reference = z.object({
  meeting: z.string(),
  durationMs: z.number(),
  mix: z.object({ pcm: z.string(), sha256: z.string() }),
  segments: z.array(
    z.object({ speaker: z.string(), start: z.number(), end: z.number(), text: z.string() }),
  ),
});
type Reference = z.output<typeof Reference>;

export interface Meeting {
  readonly directory: string;
  readonly reference: Reference;
}

export const meetingsDirectory = () => cachePath("corpora/summre-test");

/** The meeting's mix, checked against its reference (prepared here or on another Mac). */
function mixBytes(meeting: Meeting): Buffer {
  const bytes = readFileSync(join(meeting.directory, meeting.reference.mix.pcm));
  if (createHash("sha256").update(bytes).digest("hex") !== meeting.reference.mix.sha256) {
    throw new Error(`${meeting.reference.meeting}: mix.pcm does not match its reference`);
  }
  return bytes;
}

export function loadMeetings(): Meeting[] {
  const root = meetingsDirectory();
  if (!existsSync(root)) {
    throw new Error(
      `no meetings in ${root}: run apps/bench/src/asr/summre/prepare.py (see the README)`,
    );
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "reference.json")))
    .map((entry) => ({
      directory: join(root, entry.name),
      reference: Reference.parse(
        JSON.parse(readFileSync(join(root, entry.name, "reference.json"), "utf8")),
      ),
    }))
    .toSorted((a, b) => a.reference.meeting.localeCompare(b.reference.meeting));
}

export interface HypothesisSegment {
  readonly speaker: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Nemotron's words with their times, in text order. */
  readonly tokens?: readonly {
    readonly start: number;
    readonly end: number;
    readonly text: string;
  }[];
}

/**
 * Scoring words: fr-norm, then apostrophes as separators on both sides, since
 * SUMM-RE writes « l heure » where an engine writes « l'heure » (fr-norm keeps
 * « l' »). Annotation marks (`_`, `*`, `@`) are already handled by fr-norm.
 */
export function scoringWords(text: string): string[] {
  return frNormTokens(text.replaceAll("_", " "), { language: "fr" }).flatMap((token) =>
    token.split(/['’]/u).filter((part) => part !== ""),
  );
}

function wavFile(directory: string, pcm: Buffer): string {
  const path = join(directory, "mix.wav");
  if (existsSync(path)) return path;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  writeFileSync(path, Buffer.concat([header, pcm]));
  return path;
}

/** The process's physical footprint, as in run.ts. */
async function footprintBytes(pid: number): Promise<number | null> {
  try {
    const { stdout } = await run("footprint", ["-p", String(pid)], { timeout: 10_000 });
    const match = stdout.match(/Footprint:\s+([\d.]+)\s+(KB|MB|GB)/);
    if (match?.[1] === undefined) return null;
    return Math.round(
      Number(match[1]) * { KB: 1e3, MB: 1e6, GB: 1e9 }[match[2] as "KB" | "MB" | "GB"],
    );
  } catch {
    return null;
  }
}

/** speech.cpp's region pipeline: each region's text goes to the speaker who speaks most in it. */
async function compositeSegments(
  engineId: Exclude<EngineId, "nemotron">,
  wav: string,
  log: (line: string) => void,
): Promise<{ segments: HypothesisSegment[]; peak: number | null }> {
  const weights = await fetchPinned(PROBE_WEIGHTS[engineId], log);
  const vad = await fetchPinned(SILERO_VAD, log);
  const diarizer = await fetchPinned(SORTFORMER_MODEL, log);
  const child = spawn(await speechExecutable(), [
    "asr",
    weights,
    "--vad",
    vad,
    "--diarize",
    diarizer,
    "--format",
    "json",
    wav,
  ]);
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  // Read, so a chatty run never blocks on a full pipe; the tail explains a failure.
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  let peak: number | null = null;
  let done = false;
  const sampler = (async () => {
    while (!done) {
      if (child.pid !== undefined) {
        const bytes = await footprintBytes(child.pid);
        if (bytes !== null) peak = Math.max(peak ?? 0, bytes);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  })();
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  done = true;
  await sampler;
  // 3: a region reached the most the model writes; the text written so far stands.
  if (code === 3) log(`  a region hit the model's output limit; its text is kept as written`);
  else if (code !== 0) throw new Error(`speech asr exited with ${code}: ${stderr.trim()}`);
  const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
    regions?: {
      start: number;
      end: number;
      text: string;
      speakers?: { speaker: number; start: number; end: number }[];
    }[];
  };
  const segments = (parsed.regions ?? []).map((region) => {
    const time = new Map<number, number>();
    for (const part of region.speakers ?? []) {
      time.set(part.speaker, (time.get(part.speaker) ?? 0) + (part.end - part.start));
    }
    const [speaker] = [...time.entries()].toSorted((a, b) => b[1] - a[1])[0] ?? [null];
    return {
      speaker: speaker === null || speaker === undefined ? "?" : `S${speaker}`,
      start: region.start,
      end: region.end,
      text: region.text,
    };
  });
  return { segments, peak };
}

interface MeetEvalScore {
  readonly errorRate: number;
  readonly errors: number;
  readonly length: number;
}

/** Runs MeetEval (pinned, through uv) on SegLST files; per meeting and averaged. */
async function meeteval(
  metric: "tcpwer" | "cpwer",
  reference: string,
  hypothesis: string,
  directory: string,
): Promise<{ average: MeetEvalScore; perMeeting: Record<string, MeetEvalScore> }> {
  const average = join(directory, `${metric}-average.json`);
  const perReco = join(directory, `${metric}-per-reco.json`);
  const args = [
    "run",
    "--quiet",
    "--no-project",
    "--with",
    MEETEVAL,
    "--with",
    SIMPLEJSON,
    "meeteval-wer",
    metric,
    "-r",
    reference,
    "-h",
    hypothesis,
  ];
  if (metric === "tcpwer") args.push("--collar", String(COLLAR_S));
  args.push("--average-out", average, "--per-reco-out", perReco);
  await run("uv", args, { timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  const score = (value: { error_rate: number; errors: number; length: number }): MeetEvalScore => ({
    errorRate: value.error_rate,
    errors: value.errors,
    length: value.length,
  });
  const perMeeting = JSON.parse(readFileSync(perReco, "utf8")) as Record<
    string,
    { error_rate: number; errors: number; length: number }
  >;
  return {
    average: score(JSON.parse(readFileSync(average, "utf8"))),
    perMeeting: Object.fromEntries(
      Object.entries(perMeeting).map(([key, value]) => [key, score(value)]),
    ),
  };
}

const segLst = (session: string, segments: readonly HypothesisSegment[]) =>
  segments
    .map((segment) => ({
      session_id: session,
      speaker: segment.speaker,
      start_time: segment.start,
      end_time: Math.max(segment.end, segment.start + 0.01),
      words: scoringWords(segment.text).join(" "),
    }))
    .filter((segment) => segment.words !== "");

export interface MeetingResult {
  readonly meeting: string;
  readonly audioMs: number;
  readonly wallMs: number;
  readonly referenceSpeakers: number;
  readonly hypothesisSpeakers: number;
  /** Speaker-agnostic: every word in time order. */
  readonly wer: number | null;
  readonly cpwer: number | null;
  readonly tcpwer: number | null;
  readonly hypothesis: readonly HypothesisSegment[];
}

export interface MeetingsRunResult {
  readonly schema: "sondine-bench/asr-meetings/1";
  readonly engine: EngineId;
  readonly startedAt: string;
  readonly scoring: { readonly words: string; readonly meeteval: string; readonly collarS: number };
  readonly peakFootprintBytes: number | null;
  readonly totals: {
    readonly wer: number | null;
    readonly cpwer: number;
    readonly tcpwer: number;
    readonly rtfx: number;
  };
  readonly meetings: readonly MeetingResult[];
}

export async function runMeetings(options: {
  readonly engineId: EngineId;
  readonly resultsDirectory: string;
  readonly log: (line: string) => void;
}): Promise<{ readonly path: string; readonly result: MeetingsRunResult }> {
  const { engineId, log } = options;
  const meetings = loadMeetings();
  const startedAt = new Date().toISOString();
  const work = mkdtempSync(join(tmpdir(), "sondine-meetings-"));
  const hypotheses: { meeting: Meeting; segments: HypothesisSegment[]; wallMs: number }[] = [];
  let peak: number | null = null;
  try {
    if (engineId === "nemotron") {
      const { engine } = await createBenchEngine("nemotron", log);
      try {
        await engine.load();
        for (const meeting of meetings) {
          const bytes = mixBytes(meeting);
          const samples = new Int16Array(
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          );
          log(`${meeting.reference.meeting}: nemotron`);
          const began = performance.now();
          const result = await engine.transcribe({
            id: `meeting-${meeting.reference.meeting}`,
            samples,
            sampleRate: 16_000,
            speakers: true,
            timestamps: true,
          });
          const pid = engine.pid();
          if (pid !== undefined) peak = Math.max(peak ?? 0, (await footprintBytes(pid)) ?? 0);
          hypotheses.push({
            meeting,
            wallMs: performance.now() - began,
            segments: result.segments.map((segment) => ({
              speaker: segment.speaker === null ? "?" : `S${segment.speaker}`,
              start: segment.startSec,
              end: segment.endSec,
              text: segment.text,
              tokens: segment.tokens.map((token) => ({
                start: token.startSec,
                end: token.endSec,
                text: token.text,
              })),
            })),
          });
        }
      } finally {
        await engine.unload();
      }
    } else {
      for (const meeting of meetings) {
        const wav = wavFile(meeting.directory, mixBytes(meeting));
        log(`${meeting.reference.meeting}: ${engineId} + Sortformer`);
        const began = performance.now();
        const composite = await compositeSegments(engineId, wav, log);
        if (composite.peak !== null) peak = Math.max(peak ?? 0, composite.peak);
        hypotheses.push({
          meeting,
          wallMs: performance.now() - began,
          segments: composite.segments,
        });
      }
    }

    const refPath = join(work, "ref.json");
    const hypPath = join(work, "hyp.json");
    writeFileSync(
      refPath,
      JSON.stringify(
        hypotheses.flatMap(({ meeting }) =>
          segLst(meeting.reference.meeting, meeting.reference.segments),
        ),
      ),
    );
    writeFileSync(
      hypPath,
      JSON.stringify(
        hypotheses.flatMap(({ meeting, segments }) => segLst(meeting.reference.meeting, segments)),
      ),
    );
    log("scoring with MeetEval");
    const tcp = await meeteval("tcpwer", refPath, hypPath, work);
    const cp = await meeteval("cpwer", refPath, hypPath, work);
    const words = (segments: readonly { start: number; text: string }[]) =>
      segments
        .toSorted((a, b) => a.start - b.start)
        .flatMap((segment) => scoringWords(segment.text));
    let werErrors = 0;
    let werLength = 0;
    const results: MeetingResult[] = hypotheses.map(({ meeting, segments, wallMs }) => {
      const id = meeting.reference.meeting;
      const wer = wordErrorRate(words(meeting.reference.segments), words(segments), {
        alignment: false,
      });
      werErrors += wer.errors;
      werLength += wer.refLength;
      return {
        meeting: id,
        audioMs: meeting.reference.durationMs,
        wallMs: Math.round(wallMs),
        referenceSpeakers: new Set(meeting.reference.segments.map((segment) => segment.speaker))
          .size,
        hypothesisSpeakers: new Set(
          segments.map((segment) => segment.speaker).filter((s) => s !== "?"),
        ).size,
        wer: wer.rate,
        cpwer: cp.perMeeting[id]?.errorRate ?? null,
        tcpwer: tcp.perMeeting[id]?.errorRate ?? null,
        hypothesis: segments,
      };
    });
    const audioMs = results.reduce((sum, item) => sum + item.audioMs, 0);
    const wallMs = results.reduce((sum, item) => sum + item.wallMs, 0);
    const result: MeetingsRunResult = {
      schema: "sondine-bench/asr-meetings/1",
      engine: engineId,
      startedAt,
      scoring: {
        words: "fr-norm/1 + apostrophes as separators",
        meeteval: MEETEVAL,
        collarS: COLLAR_S,
      },
      peakFootprintBytes: peak,
      totals: {
        wer: werLength > 0 ? werErrors / werLength : null,
        cpwer: cp.average.errorRate,
        tcpwer: tcp.average.errorRate,
        rtfx: wallMs > 0 ? audioMs / wallMs : 0,
      },
      meetings: results,
    };
    mkdirSync(options.resultsDirectory, { recursive: true });
    const stamp = startedAt.replaceAll(":", "-").replace(/\.\d+Z$/, "Z");
    const path = join(options.resultsDirectory, `asr-meetings-${engineId}-${stamp}.json`);
    writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
    return { path, result };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const percent = (rate: number | null) => (rate === null ? "–" : `${(rate * 100).toFixed(1)} %`);

export function formatMeetingsTable(results: readonly MeetingsRunResult[]): string {
  const lines = [
    "| Engine | Meetings | WER (who-agnostic) | cpWER | tcpWER | Speakers found / true | RTFx | Peak |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    const found = result.meetings
      .map((m) => `${m.hypothesisSpeakers}/${m.referenceSpeakers}`)
      .join(" ");
    lines.push(
      `| ${result.engine} | ${result.meetings.length} | ${percent(result.totals.wer)} | ${percent(result.totals.cpwer)} | ${percent(result.totals.tcpwer)} | ${found} | ${result.totals.rtfx.toFixed(1)}× | ${result.peakFootprintBytes === null ? "–" : `${(result.peakFootprintBytes / 1e9).toFixed(1)} GB`} |`,
    );
  }
  return lines.join("\n");
}
