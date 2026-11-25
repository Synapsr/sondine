import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { UpdatesStatus } from "@sondine/api";
import { captureGoingOn } from "@sondine/db";
import { availableBytes, downloadFile, ModelStoreError } from "@sondine/engines";
import { usageError } from "@sondine/protocol";
import { Context, Effect, Layer, SubscriptionRef } from "effect";
import { DATA_LAYOUT } from "../../shared/data-layout";
import { updateArchiveName, updateArchiveUrl, type UpdateFeed } from "../../shared/updates";
import { SystemSignals } from "../analysis/analysis-layer";
import { Chat } from "../chat/chat-layer";
import { CoreConfig } from "../config";
import { Database } from "../database";
import { GoingOnActions } from "../going-on";
import { Journal } from "../journal/journal-layer";
import { log } from "../log";
import { MainChannel } from "../main-channel";
import { Models } from "../models/models-layer";
import { PhoneSync } from "../phone/phone-layer";
import { CoreState } from "../status/core-state";
import { UsageStatistics } from "../usage/usage-layer";
import { VoiceRead } from "../voices/voice-read";
import { latestRelease, UPDATE_USER_AGENT, updatePolicy, type ReleaseAnswer } from "./update-check";
import { UpdateFailure, UpdateManager, type NetworkKind } from "./update-manager";
import {
  macosAtLeast,
  removeTree,
  runTool,
  unpackUpdate,
  UPDATE_APP_NAME,
  UpdateRefusal,
  verifyUpdateApp,
  type Expected,
  type RunTool,
} from "./update-package";
import { updateWaits } from "./update-quiet";

// Updates in core (ADR 045): core asks, downloads, checks and decides when
// (update-manager.ts); main only says what the network is, replaces the app
// and starts it again. Everything sits in the data directory's `updates`
// folder, which macOS keeps from other apps, one folder per archive.

/** After a launch, before the first look: nothing reaches the network while Sondine starts. */
const FIRST_LOOK_MS = 60_000;
/** Left free on the disk once the archive and the app unpacked from it are there. */
const HEADROOM_BYTES = 2 * 1024 ** 3;
/** The app unpacked, as a multiple of its archive (2.3 in 0.7.0), with a margin. */
const UNPACKED_RATIO = 4;
/** What a crash may make it fetch again. */
const SYNC_EVERY_BYTES = 8 * 1024 ** 2;
/** How long main has to say what the network is. */
const NETWORK_REPLY_MS = 2_000;

export class Updates extends Context.Service<
  Updates,
  {
    readonly setAutomatic: (automatic: boolean) => UpdatesStatus;
    readonly check: () => Promise<UpdatesStatus>;
    readonly install: () => UpdatesStatus;
    readonly closeNote: () => UpdatesStatus;
    /** Main's answer to `network-query`. */
    readonly receiveNetwork: (network: NetworkKind) => void;
    /** Main could not replace the app. */
    readonly installFailed: () => void;
  }
>()("sondine/core/Updates") {}

export interface UpdatesOptions {
  /** The request, the download's fetch, the tools and the clock; tests answer them. */
  readonly ask?: (signal: AbortSignal) => Promise<ReleaseAnswer>;
  readonly fetch?: typeof globalThis.fetch;
  readonly run?: RunTool;
  readonly now?: () => number;
  readonly firstLookMs?: number;
}

const downloadProblem = (error: unknown): unknown => {
  if (error instanceof UpdateRefusal) {
    return new UpdateFailure(error.problem, error.problem !== "disk_full", error.message);
  }
  if (!(error instanceof ModelStoreError)) return error;
  switch (error.code) {
    case "disk_full":
      return new UpdateFailure("disk_full", false, error.message);
    case "network":
      return new UpdateFailure("network", false, error.message);
    case "http_status":
      return new UpdateFailure("refused", false, error.message);
    case "hash_mismatch":
    case "size_mismatch":
    case "too_large":
      return new UpdateFailure("corrupt", true, error.message);
    default:
      return new UpdateFailure("bad_response", false, error.message);
  }
};

export const updatesLayer = (options: UpdatesOptions = {}) =>
  Layer.effect(
    Updates,
    Effect.gen(function* () {
      const db = yield* Database;
      const state = yield* CoreState;
      const config = yield* CoreConfig;
      const usage = yield* UsageStatistics;
      const main = yield* MainChannel;
      const signals = yield* SystemSignals;
      const models = yield* Models;
      const journal = yield* Journal;
      const chat = yield* Chat;
      const voiceRead = yield* VoiceRead;
      const phone = yield* PhoneSync;
      const actions = yield* GoingOnActions;
      const now = options.now ?? Date.now;
      const run = options.run ?? runTool;
      const { testFeed } = config.updates;
      const root = join(config.dataDir, DATA_LAYOUT.updatesDir);
      const keyOf = (feed: UpdateFeed) => `${feed.version}-${feed.archive.sha256.slice(0, 16)}`;
      const dirOf = (feed: UpdateFeed) => join(root, keyOf(feed));
      const appOf = (feed: UpdateFeed) => join(dirOf(feed), "ready", UPDATE_APP_NAME);
      const expected = (feed: UpdateFeed): Expected => ({
        version: feed.version,
        current: config.appVersion,
        macosVersion: config.macosVersion,
        notarized: testFeed === null,
      });

      let networkWaiters: ((network: NetworkKind) => void)[] = [];
      const network = () =>
        new Promise<NetworkKind>((resolve) => {
          const timer = setTimeout(() => resolve("unknown"), NETWORK_REPLY_MS);
          networkWaiters.push((answer) => {
            clearTimeout(timer);
            resolve(answer);
          });
          main.post({ type: "network-query" });
        });

      const modelBusy = () =>
        Effect.runSync(SubscriptionRef.get(models.status)).artifacts.some(
          ({ phase }) => phase === "importing" || phase === "downloading" || phase === "verifying",
        );
      const waitingFor = async () => {
        const sample = await signals.cheap();
        const read = voiceRead.get().session.phase;
        return updateWaits({
          status: Effect.runSync(SubscriptionRef.get(state.status)),
          capture: captureGoingOn(db, now()),
          phone: phone.busy(),
          task:
            actions.any() ||
            journal.work.current() !== null ||
            chat.answering() ||
            read === "recording" ||
            read === "embedding" ||
            modelBusy(),
          idle: { idleSeconds: sample.idleSeconds, locked: sample.locked },
        });
      };

      /**
       * Unpacks and checks, the room capture needs kept: whatever the archive
       * unpacks to, it stops before the disk is full.
       */
      const unpackWithRoom = async (
        archive: string,
        dir: string,
        feed: UpdateFeed,
        signal: AbortSignal,
      ) => {
        if (availableBytes(dir) < HEADROOM_BYTES + feed.archive.sizeBytes * UNPACKED_RATIO) {
          throw new UpdateFailure("disk_full", false, "no room to unpack");
        }
        const full = new AbortController();
        const watch = setInterval(() => {
          if (availableBytes(dir) < HEADROOM_BYTES) full.abort();
        }, 250);
        try {
          await unpackUpdate(
            archive,
            dir,
            expected(feed),
            run,
            AbortSignal.any([signal, full.signal]),
          );
        } catch (error) {
          if (full.signal.aborted)
            throw new UpdateFailure("disk_full", true, "unpacks to too much");
          throw error;
        } finally {
          clearInterval(watch);
        }
      };

      const manager = new UpdateManager({
        db,
        current: config.appVersion,
        blocked: config.updates.blocked,
        ask: options.ask ?? ((signal) => latestRelease(fetch, { signal, testFeed })),
        network,
        prepare: async (feed, onProgress, signal) => {
          if (!macosAtLeast(config.macosVersion, feed.minimumMacos)) {
            throw new UpdateFailure("macos", true, feed.minimumMacos);
          }
          try {
            const dir = dirOf(feed);
            await mkdir(root, { recursive: true, mode: 0o700 });
            const { sizeBytes, sha256 } = feed.archive;
            const archive = await downloadFile({
              dir,
              file: {
                artifactId: updateArchiveName(feed.version),
                version: feed.version,
                url: updateArchiveUrl(feed.version, testFeed),
                sizeBytes,
                sha256,
              },
              policy: updatePolicy(testFeed),
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
              userAgent: UPDATE_USER_AGENT,
              headroomBytes: HEADROOM_BYTES + sizeBytes * UNPACKED_RATIO,
              syncEveryBytes: SYNC_EVERY_BYTES,
              signal,
              onProgress: (progress) => {
                if (progress.phase === "download") {
                  onProgress("downloading", progress.bytes / progress.totalBytes);
                } else onProgress("verifying", null);
              },
            });
            await unpackWithRoom(archive.path, dir, feed, signal);
            // The app is ready: its archive has no more use.
            await rm(archive.path, { force: true });
          } catch (error) {
            throw downloadProblem(error);
          }
        },
        prepared: (feed) =>
          stat(appOf(feed)).then(
            (found) => found.isDirectory(),
            () => false,
          ),
        recheck: (feed) =>
          verifyUpdateApp(appOf(feed), expected(feed), run).catch((error: unknown) => {
            throw downloadProblem(error);
          }),
        prune: async (keep) => {
          const names = await readdir(root).catch((): string[] => []);
          for (const name of names) {
            if (keep !== null && name === keyOf(keep)) continue;
            await removeTree(join(root, name)).catch(() =>
              log.warn("updates.prune-failed", { name }),
            );
          }
        },
        waitingFor,
        install: (feed) =>
          main.post({ type: "install-update", version: feed.version, app: appOf(feed) }),
        onStatus: (updates) =>
          state.publish((status, nowMs) => ({ ...status, updates, updatedAtMs: nowMs })),
        onFailed: (problem) => usage.error(usageError("update", problem)),
        now,
        log: (event, fields) => log.info(event, fields),
      });
      manager.start(options.firstLookMs ?? FIRST_LOOK_MS);
      yield* Effect.addFinalizer(() => Effect.promise(() => manager.close()));
      return Updates.of({
        setAutomatic: (automatic) => manager.setAutomatic(automatic),
        check: () => manager.check(),
        install: () => manager.install(),
        closeNote: () => manager.closeNote(),
        receiveNetwork: (answer) => {
          const waiters = networkWaiters;
          networkWaiters = [];
          for (const answered of waiters) answered(answer);
        },
        installFailed: () => manager.installFailed(),
      });
    }),
  );
