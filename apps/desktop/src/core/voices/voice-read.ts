import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { VoiceReadFailure, VoiceReadSession, VoiceReadStatus } from "@sondine/api";
import {
  forgetVoiceRead,
  learnsFromDictations,
  recognitionEnabled,
  storeVoiceRead,
  voiceRead,
  voiceReadConsent,
  type VoiceReadConsent,
} from "@sondine/db";
import { Context, Effect, Layer, Option, Semaphore, Stream, SubscriptionRef } from "effect";
import { AgentAccess } from "../agents/agent-access";
import { CoreConfig } from "../config";
import { Database } from "../database";
import { Listening } from "../listening";
import { log } from "../log";
import { MainChannel } from "../main-channel";
import { CoreState } from "../status/core-state";
import { VoicePass } from "./voice-pass";
import {
  pieceBase64,
  meterLevel,
  samplesOf,
  toDb,
  voicedPieces,
  VOICED_DB,
} from "./voice-read-audio";
import { embed, type VoiceTool } from "./voice-tool";

// The user's voice read (ADR 034): a short text read aloud on purpose, in
// the first run or later from Settings ▸ Voix and the user's page, which
// becomes one of their references. Main records it (`sondine-audio
// read-voice`, credited to Sondine.app like the helper) into a file of the
// data directory's `voice-read` folder, while the always-on microphone is
// held paused so the read never becomes a memory; core cuts the voiced
// stretches, `sondine-voice` embeds them, the file is deleted, and only the
// embedding is kept. Nothing of it reaches an episode, the spool or a
// transcript.

/** Voice the read asks for: the counter ends it there. */
export const READ_TARGET_MS = 25_000;
/** « Terminer » is offered from this much voice. */
export const READ_MINIMUM_MS = 10_000;
/** The recording stops here whatever the counter says. */
export const READ_MAX_MS = 60_000;
/** Fewer voiced seconds than this, once cut, are too little to embed. */
const EMBED_MINIMUM_MS = 5_000;
/** How long the recorder may take to close its file once asked to stop. */
const STOP_TIMEOUT_MS = 5_000;
/**
 * Core ends a recording this long after it started whatever the recorder
 * says (a microphone gone silent writes nothing, so its own limit never comes).
 */
const READ_DEADLINE_MS = READ_MAX_MS + 10_000;

export interface VoiceReadService {
  readonly get: () => VoiceReadStatus;
  readonly changes: Stream.Stream<VoiceReadStatus>;
  readonly start: (selfName: string) => Effect.Effect<VoiceReadStatus>;
  readonly finish: Effect.Effect<VoiceReadStatus>;
  readonly cancel: Effect.Effect<VoiceReadStatus>;
  readonly forget: Effect.Effect<VoiceReadStatus>;
  /**
   * « Reconnaître les voix » turned off: a read under way keeps nothing and
   * stops (its store would be refused anyway).
   */
  readonly abandon: () => void;
  /** The recorder's report, relayed by main. */
  readonly level: (readId: string, ms: number, rms: number) => void;
  readonly ended: (readId: string, ok: boolean, message: string | null) => void;
}

export class VoiceRead extends Context.Service<VoiceRead, VoiceReadService>()(
  "sondine/core/VoiceRead",
) {}

const idle = (): VoiceReadSession => ({
  phase: "idle",
  elapsedMs: 0,
  voicedMs: 0,
  targetMs: READ_TARGET_MS,
  minimumMs: READ_MINIMUM_MS,
  level: 0,
  failure: null,
});

interface Recording {
  readonly readId: string;
  readonly path: string;
  readonly selfName: string;
  /** What the read was started under: it is kept only if nothing changed (ADR 034). */
  readonly consent: VoiceReadConsent;
  /** Cancelled or forgotten: whatever happens next, nothing is kept. */
  abandoned: boolean;
  deadline: ReturnType<typeof setTimeout> | null;
  /** Resolves once the recorder exited: whether it closed its file. */
  readonly done: Promise<{ readonly ok: boolean; readonly message: string | null }>;
  readonly settle: (result: { readonly ok: boolean; readonly message: string | null }) => void;
  lastMs: number;
  stopping: boolean;
}

/** Whether the microphone permission is known to be missing. */
const microphoneRefused = (status: string | undefined) =>
  status === "denied" || status === "restricted" || status === "not-determined";

export const voiceReadLayer = Layer.effect(
  VoiceRead,
  Effect.gen(function* () {
    const db = yield* Database;
    const config = yield* CoreConfig;
    const main = yield* MainChannel;
    const listening = yield* Listening;
    const state = yield* CoreState;
    const access = yield* AgentAccess;
    const voices = yield* VoicePass;
    const directory = config.voiceReadDir;
    const tool: VoiceTool | null = config.voiceTool;
    const available = directory !== null && tool !== null;
    const session = yield* SubscriptionRef.make<VoiceReadSession>(idle());
    const lock = yield* Semaphore.make(1);
    const context = yield* Effect.context<never>();
    const run = Effect.runForkWith(context);
    let recording: Recording | null = null;

    // A read a crash left behind is never kept.
    if (directory !== null) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      for (const name of readdirSync(directory)) rmSync(join(directory, name), { force: true });
    }

    const statusOf = (current: VoiceReadSession): VoiceReadStatus => {
      const kept = voiceRead(db);
      return {
        recognition: recognitionEnabled(db),
        available,
        read:
          kept === null
            ? null
            : {
                readAtMs: kept.createdAtMs,
                speechMs: kept.speechMs,
                person: { id: kept.person.id, name: kept.person.name, self: true },
              },
        session: current,
      };
    };
    const status = Effect.map(SubscriptionRef.get(session), statusOf);
    const fail = (failure: VoiceReadFailure) =>
      SubscriptionRef.set(session, {
        ...idle(),
        phase: "failed",
        failure,
      } satisfies VoiceReadSession).pipe(Effect.andThen(status));

    /** Recognitions resting on the user's voice change: agents and windows read again. */
    const voiceChanged = state.update((current, nowMs) => ({
      ...current,
      deletions: current.deletions + 1,
      updatedAtMs: nowMs,
    }));

    /** Stops the recorder and waits for its file; the hold is given back either way. */
    const stopRecording = (current: Recording) =>
      Effect.gen(function* () {
        if (current.deadline !== null) clearTimeout(current.deadline);
        current.deadline = null;
        if (!current.stopping) {
          current.stopping = true;
          main.post({ type: "voice-read-stop", readId: current.readId });
        }
        const result = yield* Effect.promise(() => current.done).pipe(
          Effect.timeoutOrElse({
            duration: `${STOP_TIMEOUT_MS} millis`,
            orElse: () => Effect.succeed({ ok: false, message: "the recorder did not stop" }),
          }),
        );
        yield* listening
          .holdMicrophone(false)
          .pipe(
            Effect.catch((error) =>
              Effect.sync(() => log.warn("voice-read.release", { error: error._tag })),
            ),
          );
        return result;
      });

    const discard = (current: Recording) => rmSync(current.path, { force: true });

    /** The read under way stays `recording` until it is settled, so a cancel can still mark it. */
    const settled = (current: Recording) =>
      Effect.sync(() => {
        if (recording === current) recording = null;
      });

    /** Embeds the recorded read, deletes its file, keeps the embedding. */
    const keep = (current: Recording) =>
      Effect.gen(function* () {
        yield* SubscriptionRef.update(session, (now): VoiceReadSession => ({
          ...now,
          phase: "embedding",
          level: 0,
        }));
        const result = yield* stopRecording(current);
        let bytes: Uint8Array | null = null;
        try {
          if (result.ok && !current.abandoned) bytes = readFileSync(current.path);
        } catch {
          // No file to read (the recorder could not make it): nothing kept.
        } finally {
          discard(current);
        }
        if (current.abandoned) {
          yield* SubscriptionRef.set(session, idle());
          return yield* status;
        }
        if (bytes === null) {
          log.warn("voice-read.recorder", { message: result.message });
          return yield* fail("failed");
        }
        const pieces = voicedPieces(samplesOf(bytes));
        const voicedMs = (pieces.reduce((sum, piece) => sum + piece.length, 0) / 16_000) * 1000;
        if (voicedMs < EMBED_MINIMUM_MS || tool === null) return yield* fail("too-short");
        const answer = yield* Effect.tryPromise({
          try: (signal) => embed(tool, [{ key: "read", pieces: pieces.map(pieceBase64) }], signal),
          catch: (error) => error,
        }).pipe(Effect.option);
        // Cancelled, forgotten or refused while it embedded: nothing is kept.
        if (current.abandoned) {
          yield* SubscriptionRef.set(session, idle());
          return yield* status;
        }
        if (Option.isNone(answer)) return yield* fail("failed");
        const embedded = answer.value.speakers.find((speaker) => speaker.key === "read");
        if (embedded === undefined) return yield* fail("too-short");
        const stored = storeVoiceRead(db, {
          consent: current.consent,
          selfName: current.selfName,
          embedderVersion: answer.value.modelVersion,
          vector: embedded.embedding,
          speechMs: embedded.speechMs,
          nowMs: Date.now(),
        });
        if (!stored.ok) {
          log.info("voice-read.refused", { reason: stored.reason });
          return yield* fail(stored.reason === "recognition-off" ? "recognition-off" : "failed");
        }
        log.info("voice-read.kept", { speechMs: embedded.speechMs, pieces: pieces.length });
        access.contentChanged();
        yield* voiceChanged;
        // The user's dictations may teach their voice now (ADR 030).
        if (learnsFromDictations(db)) voices.wake();
        yield* SubscriptionRef.update(session, (now): VoiceReadSession => ({
          ...now,
          phase: "done",
          level: 0,
        }));
        return yield* status;
      }).pipe(Effect.ensuring(settled(current)));

    const finish = Effect.gen(function* () {
      const current = recording;
      if (current === null || (yield* SubscriptionRef.get(session)).phase !== "recording") {
        return yield* status;
      }
      return yield* keep(current);
    }).pipe(lock.withPermits(1), Effect.withSpan("voice-read.finish"));

    /** Marks the read under way as keeping nothing, at once: an embedding running keeps nothing. */
    const abandonNow = () => {
      if (recording !== null) recording.abandoned = true;
    };

    /** Stops the read under way, if any, and keeps nothing. Callers hold `lock`. */
    const drop = Effect.gen(function* () {
      const current = recording;
      if (current !== null) {
        current.abandoned = true;
        yield* stopRecording(current);
        discard(current);
        yield* settled(current);
      }
      yield* SubscriptionRef.set(session, idle());
    });

    const cancel = Effect.suspend(() => {
      abandonNow();
      return drop.pipe(Effect.andThen(status), lock.withPermits(1));
    }).pipe(Effect.withSpan("voice-read.cancel"));

    const start = (selfName: string) =>
      Effect.gen(function* () {
        const now = yield* SubscriptionRef.get(session);
        if (now.phase === "recording" || now.phase === "embedding") return statusOf(now);
        if (!recognitionEnabled(db)) return yield* fail("recognition-off");
        if (!available || directory === null) return yield* fail("unavailable");
        const permissions = (yield* SubscriptionRef.get(state.status)).permissions;
        if (microphoneRefused(permissions?.microphone.status)) return yield* fail("no-microphone");
        // The always-on microphone first: what the user reads is never a memory.
        const held = yield* listening.holdMicrophone(true).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.sync(() => {
              log.warn("voice-read.hold", { error: error._tag });
              return false;
            }),
          ),
        );
        if (!held) {
          yield* listening.holdMicrophone(false).pipe(Effect.ignore);
          return yield* fail("failed");
        }
        const readId = randomUUID();
        const exit = Promise.withResolvers<{ ok: boolean; message: string | null }>();
        const current: Recording = {
          readId,
          path: join(directory, `${readId}.pcm`),
          selfName,
          consent: voiceReadConsent(db),
          abandoned: false,
          deadline: null,
          done: exit.promise,
          settle: exit.resolve,
          lastMs: 0,
          stopping: false,
        };
        recording = current;
        current.deadline = setTimeout(() => {
          if (recording === current && !current.stopping) run(finish);
        }, READ_DEADLINE_MS);
        current.deadline.unref();
        yield* SubscriptionRef.set(session, {
          ...idle(),
          phase: "recording",
        } satisfies VoiceReadSession);
        main.post({
          type: "voice-read-record",
          readId,
          path: current.path,
          maxMs: READ_MAX_MS,
        });
        log.info("voice-read.started", {});
        return yield* status;
      }).pipe(lock.withPermits(1), Effect.withSpan("voice-read.start"));

    const level = (readId: string, ms: number, rms: number) => {
      const current = recording;
      if (current?.readId !== readId || current.stopping) return;
      const stepMs = Math.max(0, ms - current.lastMs);
      current.lastMs = ms;
      const voiced = toDb(rms) > VOICED_DB;
      let reached = false;
      run(
        SubscriptionRef.update(session, (now) => {
          if (now.phase !== "recording") return now;
          const voicedMs = now.voicedMs + (voiced ? stepMs : 0);
          reached = voicedMs >= READ_TARGET_MS;
          return { ...now, elapsedMs: ms, voicedMs, level: meterLevel(rms) };
        }).pipe(Effect.andThen(Effect.suspend(() => (reached ? finish : Effect.void)))),
      );
    };

    const ended = (readId: string, ok: boolean, message: string | null) => {
      const current = recording;
      if (current?.readId !== readId) return;
      current.settle({ ok, message });
      // Ended by itself (its limit, or a failure): the read ends with it.
      if (!current.stopping) {
        run(ok ? finish : drop.pipe(Effect.andThen(fail("failed")), lock.withPermits(1)));
      }
    };

    // Forgetting also drops a read under way: the user wants no voice print.
    const forget = Effect.suspend(() => {
      abandonNow();
      return Effect.gen(function* () {
        yield* drop;
        if (forgetVoiceRead(db)) {
          log.info("voice-read.forgotten", {});
          access.contentChanged();
          yield* voiceChanged;
        }
        return yield* status;
      }).pipe(lock.withPermits(1));
    }).pipe(Effect.withSpan("voice-read.forget"));

    // Core closing during a read: the recorder stops, nothing is kept.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        const current = recording;
        if (current === null) return;
        if (current.deadline !== null) clearTimeout(current.deadline);
        main.post({ type: "voice-read-stop", readId: current.readId });
        discard(current);
      }),
    );

    return VoiceRead.of({
      get: () => statusOf(Effect.runSync(SubscriptionRef.get(session))),
      changes: SubscriptionRef.changes(session).pipe(Stream.map(statusOf)),
      start,
      finish,
      cancel,
      forget,
      abandon: () => {
        if (recording === null) return;
        abandonNow();
        run(cancel);
      },
      level,
      ended,
    });
  }),
);
