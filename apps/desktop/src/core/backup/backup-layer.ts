import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import type {
  BackupChooseResult,
  BackupExportInput,
  BackupExportResult,
  BackupInspectResult,
  BackupOperation,
  BackupRendererPrefs,
  BackupRestoreResult,
  BackupStatus,
  BackupSummaryView,
} from "@sondine/api";
import { BACKUP_RENDERER_KEYS } from "@sondine/api";
import {
  dismissRestoredNote,
  migrationRefusal,
  readMigrations,
  restoredNote,
  type Migration,
} from "@sondine/db";
import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";
import { DATA_LAYOUT } from "../../shared/data-layout";
import { stampMs } from "../../shared/restore-marker";
import { CoreConfig } from "../config";
import { Database } from "../database";
import { FilePicker } from "../file-picker";
import { log } from "../log";
import { MainChannel } from "../main-channel";
import { Models } from "../models/models-layer";
import { Retention } from "../retention/retention";
import { CoreState } from "../status/core-state";
import { WrongPassphrase } from "./backup-crypto";
import { BackupNoSpace, BackupStale, cleanInterruptedExport, writeExport } from "./backup-export";
import {
  BACKUP_EXTENSION,
  BackupFormatError,
  openBackup,
  readProtection,
  type BackupSummary,
} from "./backup-format";
import { restoreRoom, RestoreRefused, stageRestore } from "./backup-restore";

// A whole backup and its restore, in core (ADR 048). One operation at a time.
// The export asks main for a save panel and writes the file itself, holding
// retention, and stops as `stale` when something is deleted meanwhile. A
// restore is chosen with an open panel, inspected (summary, version, space),
// then staged; main relaunches Sondine and swaps the data in before the helper
// and core start. Nothing here touches the network.

export interface BackupService {
  status(): BackupStatus;
  readonly changes: Stream.Stream<BackupStatus>;
  export(
    input: BackupExportInput & { readonly prefs: BackupRendererPrefs },
  ): Promise<BackupExportResult>;
  choose(): Promise<BackupChooseResult>;
  inspect(passphrase: string | null): Promise<BackupInspectResult>;
  restore(passphrase: string | null): Promise<BackupRestoreResult>;
  cancel(): void;
  deletePrevious(): BackupStatus;
  closeNote(): BackupStatus;
  /**
   * Something the backup holds was deleted (a person, a discussion, a tag, a
   * word, an added item, the voice read): an export under way stops, as for
   * `Status.deletions`.
   */
  noteRemoval(): void;
  /** Main's answer to `backup-save`. */
  receiveSavePath(requestId: string, path: string | null): void;
}

export class Backup extends Context.Service<Backup, BackupService>()("sondine/core/Backup") {}

/** A save panel left open this long counts as closed. */
const SAVE_TIMEOUT_MS = 30 * 60_000;
/** Progress reaches the window at most this often. */
const PROGRESS_EVERY_MS = 250;
const ESTIMATE_TTL_MS = 10_000;

const idle: BackupOperation = { kind: "idle" };

const fail = (outcome: BackupExportResult["outcome"]): BackupExportResult => ({
  outcome,
  bytes: null,
  neededBytes: null,
  freeBytes: null,
});

function summaryView(summary: BackupSummary): BackupSummaryView {
  return {
    createdAtMs: summary.createdAtMs,
    macName: summary.macName,
    appVersion: summary.appVersion,
    includeAudio: summary.includeAudio,
    ...summary.counts,
    bytes: summary.bytes,
  };
}

/** « Sondine 2026-11-27.sondine », in local time. */
export function backupFileName(atMs: number): string {
  const date = new Date(atMs);
  const two = (value: number) => String(value).padStart(2, "0");
  return `Sondine ${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}.${BACKUP_EXTENSION}`;
}

/** A number a pragma or an aggregate returned; 0 when there is none. */
function int(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : 0;
}

function directoryBytes(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += directoryBytes(child);
    else if (entry.isFile()) total += statSync(child).size;
  }
  return total;
}

function classify(error: unknown): Exclude<BackupInspectResult["outcome"], "ok"> | "failed" {
  if (error instanceof WrongPassphrase) return "wrong-passphrase";
  if (error instanceof BackupFormatError) {
    return error.reason === "not-a-backup"
      ? "not-a-backup"
      : error.reason === "unsupported"
        ? "unsupported"
        : "damaged";
  }
  if (error instanceof RestoreRefused) return error.reason;
  return "failed";
}

export const backupLayer = Layer.effect(
  Backup,
  Effect.gen(function* () {
    const config = yield* CoreConfig;
    const db = yield* Database;
    const main = yield* MainChannel;
    const picker = yield* FilePicker;
    const retention = yield* Retention;
    const state = yield* CoreState;
    const models = yield* Models;
    const operation = yield* SubscriptionRef.make<BackupOperation>(idle);
    const dataDir = config.dataDir;

    // What an export left when core died (its `.partial`, the database's copy) goes at each start.
    if (dataDir !== "" && config.databasePath !== ":memory:") cleanInterruptedExport(dataDir);

    let migrations: readonly Migration[] | null = null;
    const knownMigrations = () => (migrations ??= readMigrations(config.migrationsDir));

    const pending = new Map<string, (path: string | null) => void>();
    let controller: AbortController | null = null;
    let chosen: string | null = null;
    let estimate: { atMs: number; value: BackupStatus["estimate"] } | null = null;
    let previous: { value: BackupStatus["previous"] } | null = null;

    const setOperation = (next: BackupOperation) =>
      Effect.runSync(SubscriptionRef.set(operation, next));

    const currentEstimate = (): BackupStatus["estimate"] => {
      const now = Date.now();
      if (estimate !== null && now - estimate.atMs < ESTIMATE_TTL_MS) return estimate.value;
      const page = db.statement("PRAGMA page_count").get() ?? {};
      const size = db.statement("PRAGMA page_size").get() ?? {};
      const value = {
        databaseBytes: int(page, "page_count") * int(size, "page_size"),
        audioBytes: int(
          db
            .statement(
              "SELECT coalesce(sum(byte_length), 0) AS n FROM chunks WHERE audio_state = 'archived'",
            )
            .get() ?? {},
          "n",
        ),
        contextBytes: int(
          db
            .statement(
              "SELECT coalesce(sum(file_bytes), 0) AS n FROM (SELECT DISTINCT file_sha256, file_bytes FROM context_items WHERE file_sha256 IS NOT NULL)",
            )
            .get() ?? {},
          "n",
        ),
      };
      estimate = { atMs: now, value };
      return value;
    };

    const currentPrevious = (): BackupStatus["previous"] => {
      if (previous !== null) return previous.value;
      const root = join(dataDir, DATA_LAYOUT.beforeRestoreDir);
      let value: BackupStatus["previous"] = null;
      if (existsSync(root)) {
        const stamps = readdirSync(root).toSorted();
        const newest = stamps.at(-1);
        const at = newest === undefined ? null : stampMs(newest);
        if (at !== null) value = { restoredAtMs: at, bytes: directoryBytes(root) };
      }
      previous = { value };
      return value;
    };

    const currentNote = (): BackupStatus["restored"] => {
      const note = restoredNote(db);
      if (note === null) return null;
      const artifacts = Effect.runSync(SubscriptionRef.get(models.status)).artifacts;
      const prefs: BackupRendererPrefs = {};
      for (const key of BACKUP_RENDERER_KEYS) {
        const value = note.prefs[key];
        if (value !== undefined) prefs[key] = value;
      }
      return {
        restoredAtMs: note.restoredAtMs,
        createdAtMs: note.createdAtMs,
        missingModels: artifacts
          .filter(
            (artifact) => note.models.includes(artifact.artifactId) && artifact.phase !== "ready",
          )
          .map((artifact) => ({
            artifactId: artifact.artifactId,
            displayName: artifact.displayName,
          })),
        prefs,
      };
    };

    const statusWith = (current: BackupOperation): BackupStatus => ({
      operation: current,
      estimate: currentEstimate(),
      previous: currentPrevious(),
      restored: currentNote(),
    });
    const status = () => statusWith(Effect.runSync(SubscriptionRef.get(operation)));

    const busy = () => Effect.runSync(SubscriptionRef.get(operation)).kind !== "idle";

    const throttled = (report: (done: number, total: number) => void) => {
      let last = 0;
      return (done: number, total: number) => {
        const now = Date.now();
        if (now - last < PROGRESS_EVERY_MS && done < total) return;
        last = now;
        report(done, total);
      };
    };

    const askSavePath = () =>
      new Promise<string | null>((resolve) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => answer(null), SAVE_TIMEOUT_MS);
        const answer = (path: string | null) => {
          clearTimeout(timer);
          pending.delete(requestId);
          resolve(path);
        };
        pending.set(requestId, answer);
        main.post({ type: "backup-save", requestId, fileName: backupFileName(Date.now()) });
      });

    let removals = 0;
    const deletions = () => Effect.runSync(SubscriptionRef.get(state.status)).deletions + removals;

    const installedModels = () =>
      Effect.runSync(SubscriptionRef.get(models.status))
        .artifacts.filter((artifact) => artifact.phase === "ready")
        .map((artifact) => artifact.artifactId);

    const runExport = async (
      input: BackupExportInput & { readonly prefs: BackupRendererPrefs },
    ): Promise<BackupExportResult> => {
      if (busy()) return fail("busy");
      const path = await askSavePath();
      if (path === null) return fail("cancelled");
      if (busy()) return fail("busy");
      const abort = new AbortController();
      controller = abort;
      setOperation({ kind: "exporting", doneBytes: 0, totalBytes: 0 });
      const startedAt = Date.now();
      try {
        const result = await Effect.runPromise(
          retention.hold(async (): Promise<BackupExportResult> => {
            const seen = deletions();
            try {
              const written = await writeExport({
                db,
                dataDir,
                path,
                passphrase: input.passphrase ?? null,
                includeAudio: input.includeAudio,
                prefs: Object.fromEntries(
                  Object.entries(input.prefs).filter(
                    (entry): entry is [string, string] => typeof entry[1] === "string",
                  ),
                ),
                appVersion: config.appVersion,
                macName: hostname().replace(/\.local$/, ""),
                models: installedModels(),
                nowMs: Date.now(),
                signal: abort.signal,
                stillCurrent: () => deletions() === seen,
                onProgress: throttled((done, total) =>
                  setOperation({ kind: "exporting", doneBytes: done, totalBytes: total }),
                ),
              });
              return { outcome: "saved", bytes: written.bytes, neededBytes: null, freeBytes: null };
            } catch (error) {
              if (error instanceof BackupStale) return fail("stale");
              if (error instanceof BackupNoSpace) {
                return {
                  outcome: "no-space",
                  bytes: null,
                  neededBytes: error.neededBytes,
                  freeBytes: error.freeBytes,
                };
              }
              if (abort.signal.aborted) return fail("cancelled");
              log.warn("backup.export-failed", {
                error: error instanceof Error ? error.name : "unknown",
              });
              return fail("failed");
            }
          }),
        );
        log.info("backup.exported", {
          outcome: result.outcome,
          bytes: result.bytes,
          includeAudio: input.includeAudio,
          protected: input.passphrase !== null,
          ms: Date.now() - startedAt,
        });
        return result;
      } finally {
        controller = null;
        setOperation(idle);
      }
    };

    const choose = async (): Promise<BackupChooseResult> => {
      if (busy()) return { outcome: "busy", fileName: null, protected: false };
      const path = await picker.pick({
        purpose: "backup",
        label: "Sondine",
        extensions: [BACKUP_EXTENSION],
      });
      if (path === null) return { outcome: "cancelled", fileName: null, protected: false };
      try {
        const protection = await readProtection(path);
        chosen = path;
        return {
          outcome: "chosen",
          fileName: basename(path),
          protected: protection.kind !== "none",
        };
      } catch (error) {
        chosen = null;
        const outcome = classify(error);
        return {
          outcome: outcome === "unsupported" ? "unsupported" : "not-a-backup",
          fileName: basename(path),
          protected: false,
        };
      }
    };

    const inspect = async (passphrase: string | null): Promise<BackupInspectResult> => {
      const none = { summary: null, neededBytes: null, freeBytes: null };
      if (chosen === null) return { outcome: "none-chosen", ...none };
      if (busy()) return { outcome: "busy", ...none };
      try {
        const backup = await openBackup(chosen, passphrase);
        await backup.close();
        const summary = summaryView(backup.summary);
        if (migrationRefusal(backup.summary.migrations, knownMigrations()) !== null) {
          return { outcome: "newer", summary, neededBytes: null, freeBytes: null };
        }
        const room = restoreRoom(backup.summary, dataDir);
        return {
          outcome: room.freeBytes < room.neededBytes ? "no-space" : "ok",
          summary,
          ...room,
        };
      } catch (error) {
        const outcome = classify(error);
        return { outcome: outcome === "failed" ? "damaged" : outcome, ...none };
      }
    };

    const restore = async (passphrase: string | null): Promise<BackupRestoreResult> => {
      if (chosen === null) return { outcome: "none-chosen" };
      if (busy()) return { outcome: "busy" };
      const path = chosen;
      const abort = new AbortController();
      controller = abort;
      setOperation({ kind: "restoring", doneBytes: 0, totalBytes: 0 });
      const startedAt = Date.now();
      try {
        await stageRestore({
          path,
          passphrase,
          dataDir,
          migrations: knownMigrations(),
          nowMs: Date.now(),
          signal: abort.signal,
          onProgress: throttled((done, total) =>
            setOperation({ kind: "restoring", doneBytes: done, totalBytes: total }),
          ),
        });
        log.info("backup.staged", { ms: Date.now() - startedAt });
        chosen = null;
        main.post({ type: "backup-restart" });
        return { outcome: "restarting" };
      } catch (error) {
        if (abort.signal.aborted) return { outcome: "cancelled" };
        const outcome = classify(error);
        log.warn("backup.restore-refused", {
          outcome,
          error: error instanceof Error ? error.name : "unknown",
        });
        return { outcome };
      } finally {
        controller = null;
        // A staged restore stays « restoring » until main relaunches.
        if (!existsSync(join(dataDir, DATA_LAYOUT.restoreMarker))) setOperation(idle);
      }
    };

    return Backup.of({
      status,
      changes: SubscriptionRef.changes(operation).pipe(Stream.map(statusWith)),
      export: runExport,
      choose,
      inspect,
      restore,
      cancel: () => controller?.abort(),
      deletePrevious: () => {
        rmSync(join(dataDir, DATA_LAYOUT.beforeRestoreDir), { recursive: true, force: true });
        previous = null;
        log.info("backup.previous-deleted");
        return status();
      },
      closeNote: () => {
        dismissRestoredNote(db);
        return status();
      },
      noteRemoval: () => {
        removals += 1;
      },
      receiveSavePath: (requestId, path) => pending.get(requestId)?.(path),
    });
  }),
);
