import { linkVoices } from "@sondine/core";
import {
  exclusiveSpeech,
  forgetUnnamedVoices,
  mergeVoices,
  runsNeedingLinks,
  runsNeedingVoices,
  storeVoicePass,
  voicesOfRun,
  voicesPrint,
  type Database as CoreDatabase,
  type VoiceRun,
} from "@sondine/db";
import { Context, Effect, Layer } from "effect";
import { AnalysisQueue, TrackAudioSource } from "../analysis/analysis-layer";
import type { ReadTrackAudio } from "../audio/track-audio";
import { CoreConfig } from "../config";
import { Database } from "../database";
import { log } from "../log";
import { embed, embedAll, readPieces, type VoiceTool } from "./voice-tool";

// The voice pass (architecture §8): after a transcript is published, its
// voices that are one person are linked, in every context, then each voice of
// a transcript whose voices may be identified gets an embedding from its
// exclusive speech, read back from the spool or the archive, by the sandboxed
// `sondine-voice`. It looks every minute for transcripts not linked or not
// embedded yet, newest first, embeds over the last 90 days, and forgets
// unnamed voices older than that (ADR 012). Embeddings made to link are never
// kept. Without the tool (a build without it) voices are named by hand and
// never suggested, and stay as the engine numbered them.

const SCAN_MS = 60_000;
const FIRST_SCAN_MS = 30_000;
const KEEP_UNNAMED_MS = 90 * 86_400_000;
/** Transcripts linked, then embedded, per scan. */
const RUNS_PER_SCAN = 20;

export class VoicePass extends Context.Service<
  VoicePass,
  {
    /** Looks for transcripts to link and embed now, as after a publish. */
    readonly wake: () => void;
  }
>()("sondine/core/VoicePass") {}

/** Merges a transcript's voices that are one person; their embeddings are not kept. */
async function linkRun(
  db: CoreDatabase,
  tool: VoiceTool,
  read: ReadTrackAudio,
  run: VoiceRun,
  signal: AbortSignal,
): Promise<void> {
  const voices = voicesOfRun(db, run.runId);
  const { speakers } = await embedAll(
    tool,
    voices
      .map((voice) => ({ key: voice.label, pieces: readPieces(read, voice.pieces) }))
      .filter((speaker) => speaker.pieces.length > 0),
    signal,
  );
  const vectors = new Map(speakers.map((speaker) => [speaker.key, speaker.embedding]));
  const links = linkVoices(
    voices.flatMap((voice) => {
      const vector = vectors.get(voice.label);
      return vector === undefined
        ? []
        : [
            {
              label: voice.label,
              track: voice.trackKey,
              vector,
              person: voice.personId === null ? null : String(voice.personId),
            },
          ];
    }),
  );
  const merged = [...links].filter(([from, to]) => from !== to).length;
  const done = mergeVoices(db, { ...run, links, nowMs: Date.now() });
  log.info("voices.linked", {
    episodeId: run.episodeId,
    voices: voices.length,
    embedded: vectors.size,
    merged,
    done,
  });
}

async function embedRun(
  db: CoreDatabase,
  tool: VoiceTool,
  read: ReadTrackAudio,
  run: VoiceRun,
  embedderVersion: string,
  signal: AbortSignal,
): Promise<void> {
  // A merge while the tool runs changes the voices: what it answers is not kept.
  const print = voicesPrint(db, run.runId);
  const answer = await embedAll(
    tool,
    [...exclusiveSpeech(db, run.runId)]
      .map(([key, pieces]) => ({ key, pieces: readPieces(read, pieces) }))
      .filter((speaker) => speaker.pieces.length > 0),
    signal,
  );
  if (answer.modelVersion !== null && answer.modelVersion !== embedderVersion) {
    throw new Error("sondine-voice changed version during a scan");
  }
  const stored = storeVoicePass(db, {
    ...run,
    embedderVersion,
    voices: answer.speakers.map((speaker) => ({
      label: speaker.key,
      vector: speaker.embedding,
      speechMs: speaker.speechMs,
    })),
    nowMs: Date.now(),
    print,
  });
  log.info("voices.embedded", {
    episodeId: run.episodeId,
    voices: answer.speakers.length,
    tooShort: answer.tooShort,
    stored,
  });
}

export const voicePassLayer = Layer.effect(
  VoicePass,
  Effect.gen(function* () {
    const config = yield* CoreConfig;
    const db = yield* Database;
    const audio = yield* TrackAudioSource;
    const queue = yield* AnalysisQueue;
    const tool = config.voiceTool;
    if (tool === null) {
      log.info("voices.unavailable", {});
      return VoicePass.of({ wake: () => undefined });
    }
    const controller = new AbortController();
    // A transcript the tool failed on is left until core restarts, so it
    // never holds up the others.
    const failed = new Set<number>();
    const failedLinks = new Set<number>();
    let embedderVersion: string | null = null;
    let scanning = false;
    let again = false;
    const scan = async (): Promise<void> => {
      if (scanning) {
        again = true;
        return;
      }
      scanning = true;
      try {
        do {
          again = false;
          const read = audio.reader();
          if (read === null) return;
          embedderVersion ??= (await embed(tool, [], controller.signal)).modelVersion;
          // Linked first: a transcript is embedded with its voices merged.
          const toLink = runsNeedingLinks(db, RUNS_PER_SCAN + failedLinks.size)
            .filter((run) => !failedLinks.has(run.runId))
            .slice(0, RUNS_PER_SCAN);
          for (const run of toLink) {
            if (controller.signal.aborted) return;
            try {
              await linkRun(db, tool, read, run, controller.signal);
            } catch (error) {
              if (controller.signal.aborted) return;
              failedLinks.add(run.runId);
              log.warn("voices.link-failed", {
                episodeId: run.episodeId,
                message: error instanceof Error ? error.message : "error",
              });
            }
          }
          const nowMs = Date.now();
          const forgotten = forgetUnnamedVoices(db, nowMs - KEEP_UNNAMED_MS);
          if (forgotten > 0) log.info("voices.forgotten", { voices: forgotten });
          const runs = runsNeedingVoices(db, {
            embedderVersion,
            sinceMs: nowMs - KEEP_UNNAMED_MS,
            limit: RUNS_PER_SCAN + failed.size,
          })
            .filter((run) => !failed.has(run.runId))
            .slice(0, RUNS_PER_SCAN);
          for (const run of runs) {
            if (controller.signal.aborted) return;
            try {
              await embedRun(db, tool, read, run, embedderVersion, controller.signal);
            } catch (error) {
              if (controller.signal.aborted) return;
              failed.add(run.runId);
              log.warn("voices.run-failed", {
                episodeId: run.episodeId,
                message: error instanceof Error ? error.message : "error",
              });
            }
          }
          if (toLink.length === RUNS_PER_SCAN || runs.length === RUNS_PER_SCAN) again = true;
        } while (again && !controller.signal.aborted);
      } catch (error) {
        if (!controller.signal.aborted) {
          log.warn("voices.failed", { message: error instanceof Error ? error.message : "error" });
        }
      } finally {
        scanning = false;
      }
    };
    // A new transcript's voices are linked before anyone looks at them for long.
    queue.onPublished(() => void scan());
    const first = setTimeout(() => void scan(), FIRST_SCAN_MS);
    const timer = setInterval(() => void scan(), SCAN_MS);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        clearTimeout(first);
        clearInterval(timer);
        controller.abort();
      }),
    );
    return VoicePass.of({ wake: () => void scan() });
  }),
);
