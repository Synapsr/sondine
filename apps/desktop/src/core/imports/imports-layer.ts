import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { ImportPickResult } from "@sondine/api";
import {
  durableTransaction,
  importRecording,
  phoneArrival,
  PhoneRecordingRefused,
  transaction,
} from "@sondine/db";
import { Context, Effect, Layer } from "effect";
import { DATA_LAYOUT } from "../../shared/data-layout";
import { AnalysisQueue } from "../analysis/analysis-layer";
import { CoreConfig } from "../config";
import { Database } from "../database";
import { FilePicker } from "../file-picker";
import { log } from "../log";
import { Retention } from "../retention/retention";
import { SameMoment } from "../same-moment/same-moment-layer";
import { IMPORT_SAMPLE_RATE } from "./decode";
import {
  answerForArrival,
  clearStaging,
  discardImport,
  ImportFailure,
  prepareImport,
  lengthReadable,
  publishImport,
  readPhoneFile,
  readPhoneHeader,
  type ImportPaths,
  type PhoneFile,
  type PreparedImport,
} from "./import-audio";

// « Importer un audio… » (ADR 021): an open panel from main, or files the
// user dropped or pasted on « Importés »; each is decoded and kept as an
// imported recording, one at a time, and queued for transcription with its
// voices as a user request. A file the iPhone app recorded becomes a phone
// recording instead (ADR 032): a duplicate, another file under its id or a
// deleted one is answered before any decoding, and checked again in the
// transaction that publishes it; once in, it is compared with what the Mac
// heard at the same time (ADR 032). Logs no names or paths, nor the phone's ids.

/**
 * What the open panel offers: what macOS's Core Audio reads, Voice Memos'
 * `.qta` (QuickTime audio) and QuickTime movies included.
 */
export const AUDIO_EXTENSIONS = [
  "m4a",
  "qta",
  "mp3",
  "wav",
  "aif",
  "aiff",
  "caf",
  "aac",
  "mp4",
  "m4b",
  "mov",
  "flac",
];

/**
 * Whether « Transcrire » is offered for a file (ADR 024): one the open panel
 * would take, or any audio.
 */
export function isTranscribable(name: string, mediaType: string): boolean {
  return (
    mediaType.startsWith("audio/") ||
    AUDIO_EXTENSIONS.includes(extname(name).slice(1).toLowerCase())
  );
}

/** What a paired phone's file must be, and a last check inside the publishing transaction. */
export interface PhoneExpectation {
  readonly recordingId: string;
  /** The caller's device id, never one a request names. */
  readonly deviceId: string;
  /** The file's SHA-256, checked by the inbox against the announcement. */
  readonly sha256: string;
  readonly confirm: () => void;
}

/** What became of a phone's file: what the phone hears (`UploadStatus`). */
export type PhoneReceipt =
  | { readonly outcome: "stored"; readonly episodeId: number | null }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "deleted" }
  | {
      readonly outcome: "refused";
      readonly reason: "header" | "unreadable" | "no-room" | "too-large";
    };

/** A file of a conversation's context to transcribe (ADR 024). */
export interface TranscribeSource {
  /** The name the user gave it (a safe file name), and how to copy its bytes out of Sondine's data. */
  readonly name: string;
  readonly copyTo: (path: string) => Promise<void>;
  /** Links the item to the recording, in the import's transaction; throws to refuse. */
  readonly link: (trackRunId: number) => void;
}

export class Imports extends Context.Service<
  Imports,
  {
    readonly pick: () => Promise<ImportPickResult>;
    /** Files the user dropped or pasted, in order: one result each. */
    readonly add: (paths: readonly string[]) => Promise<ImportPickResult[]>;
    /** « Transcrire » on an audio file of a conversation: imported, then linked to its item. */
    readonly transcribe: (source: TranscribeSource) => Promise<ImportPickResult>;
    /**
     * A file a paired phone sent, its bytes checked against its announced
     * SHA-256 (ADR 008): imported when its header names `expected`, the
     * last transaction durable. `confirm` runs inside it and throws to
     * refuse (the phone was revoked meanwhile). Throws on an internal failure.
     */
    readonly receive: (path: string, expected: PhoneExpectation) => Promise<PhoneReceipt>;
  }
>()("sondine/core/Imports") {}

export const importsLayer = Layer.effect(
  Imports,
  Effect.gen(function* () {
    const config = yield* CoreConfig;
    const db = yield* Database;
    const picker = yield* FilePicker;
    const retention = yield* Retention;
    const queue = yield* AnalysisQueue;
    const sameMoment = yield* SameMoment;
    const paths: ImportPaths = {
      dataDir: config.dataDir,
      spoolDir: config.spoolDir,
      archiveDir: DATA_LAYOUT.archiveDir,
      stagingDir: join(config.dataDir, DATA_LAYOUT.importStagingDir),
    };
    // What an interrupted import decoded: private audio, gone at each start.
    clearStaging(paths);

    /** A phone recording this Mac already knows, as its result; null to import it. */
    const known = (phone: PhoneFile): ImportPickResult | null =>
      answerForArrival(
        phoneArrival(db, { recordingId: phone.header.recordingId, sha256: phone.sha256 }),
      );

    /**
     * Decodes `path` and publishes it under retention's lock. `phone`: its
     * header and hash, read before; with one, the publishing transaction
     * reaches the disk before this returns (a paired phone erases its copy
     * on that row). `link`: run in the publishing transaction, throws to
     * refuse it.
     */
    const decodeAndPublish = async (
      path: string,
      options: {
        readonly phone: PhoneFile | null;
        readonly link?: ((trackRunId: number) => void) | undefined;
      },
    ): Promise<{
      readonly episodeId: number;
      readonly seconds: number;
      readonly prepared: PreparedImport;
    }> => {
      const { phone, link } = options;
      // Startup recovery removes archive `.tmp` files: it runs before this one is written.
      await Effect.runPromise(retention.exclusive(() => undefined, 0));
      const prepared = await prepareImport(path, paths, Date.now(), phone?.header ?? null);
      const write = () => {
        const imported = importRecording(db, {
          uid: prepared.uid,
          fileName: prepared.fileName,
          sampleRate: IMPORT_SAMPLE_RATE,
          sampleCount: prepared.sampleCount,
          startedWallMs: prepared.startedWallMs,
          archiveRelPath: prepared.archiveRelPath,
          spoolRelPath: prepared.spoolRelPath,
          chunks: prepared.chunks,
          nowMs: Date.now(),
          ...(phone === null
            ? {}
            : {
                phone: {
                  recordingId: phone.header.recordingId,
                  deviceId: phone.header.deviceId,
                  sha256: phone.sha256,
                  timeUncertain: prepared.timeUncertain,
                },
              }),
        });
        link?.(imported.trackRunId);
        return imported;
      };
      try {
        const { episodeId } = await Effect.runPromise(
          retention.exclusive(
            () =>
              publishImport(prepared, () =>
                // A phone recording's row is a receipt the phone may erase its audio on (ADR 008),
                // whichever way the file came: AirDrop first, then the same id announced.
                phone !== null ? durableTransaction(db, write) : transaction(db, write),
              ),
            prepared.sampleCount * 2,
          ),
        );
        queue.wake();
        // A phone recording may be a meeting the Mac heard too (ADR 032).
        if (phone !== null) sameMoment.wake();
        return {
          episodeId,
          seconds: Math.round(prepared.sampleCount / IMPORT_SAMPLE_RATE),
          prepared,
        };
      } catch (error) {
        discardImport(prepared);
        throw error;
      }
    };

    const importFile = async (
      path: string,
      link?: (trackRunId: number) => void,
    ): Promise<ImportPickResult> => {
      const startedAt = Date.now();
      // « Transcrire » on a conversation's file stays a transcription (ADR 024).
      const phone = link === undefined ? await readPhoneFile(path) : null;
      const answered = phone === null ? null : known(phone);
      if (answered !== null) {
        log.info("imports.phone.known", {
          outcome: answered.outcome === "failed" ? answered.problem : answered.outcome,
        });
        return answered;
      }
      try {
        const { episodeId, seconds, prepared } = await decodeAndPublish(path, { phone, link });
        log.info(phone === null ? "imports.imported" : "imports.phone.imported", {
          episodeId,
          seconds,
          ms: Date.now() - startedAt,
          ...(phone === null ? {} : { timeUncertain: prepared.timeUncertain }),
        });
        return { outcome: phone === null ? "imported" : "phone", episodeId };
      } catch (error) {
        // Another import published it meanwhile: answered as if it came after.
        if (error instanceof PhoneRecordingRefused && phone !== null) {
          const answer = known(phone);
          if (answer !== null) return answer;
        }
        throw error;
      }
    };

    /** What a paired phone hears of a file it sent, once its header and hash are known. */
    const receipt = (phone: PhoneFile): PhoneReceipt | null => {
      const arrival = phoneArrival(db, {
        recordingId: phone.header.recordingId,
        sha256: phone.sha256,
      });
      switch (arrival.kind) {
        case "new":
          return null;
        case "duplicate":
          return { outcome: "stored", episodeId: arrival.episodeId };
        case "conflict":
        case "deleted":
          return { outcome: arrival.kind };
      }
    };

    const receiveFile = async (path: string, expected: PhoneExpectation): Promise<PhoneReceipt> => {
      const startedAt = Date.now();
      const header = await readPhoneHeader(path);
      // The id in the address, the announcement and the header are one; the device is the caller.
      if (
        header === null ||
        header.recordingId !== expected.recordingId ||
        header.deviceId !== expected.deviceId
      ) {
        return { outcome: "refused", reason: "header" };
      }
      const phone: PhoneFile = { header, sha256: expected.sha256 };
      const already = receipt(phone);
      if (already !== null) return already;
      // Without its length the import would skip its room check: fine for a
      // file the user chose, not for one a phone sends (ADR 008).
      if (!(await lengthReadable(path))) return { outcome: "refused", reason: "unreadable" };
      try {
        const { episodeId, seconds } = await decodeAndPublish(path, {
          phone,
          link: () => expected.confirm(),
        });
        log.info("imports.phone.received", { episodeId, seconds, ms: Date.now() - startedAt });
        return { outcome: "stored", episodeId };
      } catch (error) {
        if (error instanceof PhoneRecordingRefused) return receipt(phone) ?? { outcome: "deleted" };
        if (error instanceof ImportFailure) {
          log.info("imports.phone.refused", { problem: error.problem });
          return {
            outcome: "refused",
            reason:
              error.problem === "disk-full"
                ? "no-room"
                : error.problem === "too-long"
                  ? "too-large"
                  : "unreadable",
          };
        }
        throw error;
      }
    };

    /** One file, its failure as a result. */
    const importOne = async (
      path: string,
      link?: (trackRunId: number) => void,
    ): Promise<ImportPickResult> => {
      try {
        // A folder or a missing file is no audio to read.
        if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
          throw new ImportFailure("unreadable", "not a file");
        }
        return await importFile(path, link);
      } catch (error) {
        if (error instanceof ImportFailure) {
          log.info("imports.refused", { problem: error.problem });
          return { outcome: "failed", problem: error.problem };
        }
        log.warn("imports.failed", { error: error instanceof Error ? error.name : "unknown" });
        return { outcome: "failed", problem: "internal" };
      }
    };

    // One import at a time: each decodes a whole file and writes as much.
    let turn: Promise<unknown> = Promise.resolve();
    const inTurn = <A>(work: () => Promise<A>): Promise<A> => {
      const mine = turn.then(work);
      turn = mine.catch(() => undefined);
      return mine;
    };

    return Imports.of({
      pick: () =>
        inTurn(async () => {
          const path = await picker.pick({
            purpose: "audio",
            label: "Audio",
            extensions: AUDIO_EXTENSIONS,
          });
          return path === null ? { outcome: "cancelled" } : importOne(path);
        }),
      add: (paths) =>
        inTurn(async () => {
          const results: ImportPickResult[] = [];
          for (const path of paths) results.push(await importOne(path));
          return results;
        }),
      receive: (path, expected) => inTurn(() => receiveFile(path, expected)),
      transcribe: (source) =>
        inTurn(async () => {
          // Decoding reads the format from the name too: a clone named as the
          // user's file, in the import staging folder (emptied at each start).
          const folder = join(paths.stagingDir, `context-${randomUUID()}`);
          mkdirSync(folder, { recursive: true, mode: 0o700 });
          try {
            const named = join(folder, source.name);
            try {
              await source.copyTo(named);
            } catch {
              // Removed meanwhile, or its bytes unreadable.
              log.info("imports.refused", { problem: "unreadable" });
              return { outcome: "failed", problem: "unreadable" };
            }
            return await importOne(named, source.link);
          } finally {
            rmSync(folder, { recursive: true, force: true });
          }
        }),
    });
  }),
);
