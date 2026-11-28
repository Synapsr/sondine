import type { MessageEvent as ElectronMessageEvent, ParentPort } from "electron";
import { Effect } from "effect";
import { CoreToMain, MainToCore } from "../shared/core-messages";
import { SystemSignals } from "./analysis/analysis-layer";
import { Backup } from "./backup/backup-layer";
import { Exports } from "./exports";
import { EpisodeMedia, mediaReplyMessage } from "./audio/episode-media";
import { CoreState } from "./status/core-state";
import { applyHelperProcess } from "./status/status-model";
import { coreConfigFrom, parseCoreArguments } from "./config";
import { Importer } from "./capture/importer";
import { HelperClient } from "./helper/helper-client";
import { log } from "./log";
import { ContextStore } from "./context/context-layer";
import { FilePicker } from "./file-picker";
import { RpcHost } from "./rpc-host";
import { makeCoreRuntime } from "./runtime";
import { labCoreOptions, labSettings } from "./flow-lab";
import { Updates } from "./updates/updates-layer";
import { UsageStatistics } from "./usage/usage-layer";
import { VoiceRead } from "./voices/voice-read";

// Entry of the `core` utility process (ADR 003). Main forks it with
// utilityProcess.fork and talks to it over process.parentPort.

const parentPort: ParentPort = process.parentPort;
const config = coreConfigFrom(parseCoreArguments(process.argv));

const post = (message: CoreToMain) => parentPort.postMessage(CoreToMain.parse(message));
// The flow lab's core (development only, flow-lab.ts) reaches nothing but this Mac.
const lab = import.meta.env.DEV ? labSettings(config) : null;
const runtime = makeCoreRuntime(
  config,
  { post },
  lab === null ? undefined : labCoreOptions(lab, config.appVersion),
);

/** When the helper last went away, as main said it; undefined until main first said. */
let helperExit: number | null | undefined;

let shuttingDown = false;
async function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("core.shutdown", { reason });
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const helper = yield* HelperClient;
        const importer = yield* Importer;
        yield* helper.shutdown;
        // The helper sent its last commits and closes before the ack: import
        // them before the database closes.
        if (!(yield* importer.drain(2_000))) log.warn("core.shutdown-drain", { timedOut: true });
      }).pipe(Effect.timeout("6 seconds"), Effect.ignore),
    );
    await runtime.dispose();
  } catch (error) {
    log.error("core.shutdown-failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  post({ type: "shutdown-complete" });
  process.exit(0);
}

function handle(event: ElectronMessageEvent) {
  const parsed = MainToCore.safeParse(event.data);
  if (!parsed.success) {
    log.warn("main.invalid-message", { issues: parsed.error.issues.length });
    return;
  }
  const message = parsed.data;
  switch (message.type) {
    case "renderer-port":
    case "main-port": {
      const [port] = event.ports;
      if (port === undefined) {
        log.warn("main.port-missing", { type: message.type });
        return;
      }
      const label = message.type === "main-port" ? "main" : `window-${message.windowId}`;
      void runtime.runPromise(
        Effect.gen(function* () {
          const host = yield* RpcHost;
          host.attach(port, label);
        }),
      );
      return;
    }
    case "exclude-pids":
      void runtime.runPromise(
        Effect.gen(function* () {
          const helper = yield* HelperClient;
          yield* helper.setExcludedPids(message.pids);
        }),
      );
      return;
    case "helper-process":
      void runtime.runPromise(
        Effect.gen(function* () {
          const state = yield* CoreState;
          yield* state.update((status, nowMs) => applyHelperProcess(status, message.info, nowMs));
          const exit = message.info.lastExit?.atMs ?? null;
          // An exit the supervisor answers by a restart, seen by this core (ADR 042).
          const gone = helperExit !== undefined && exit !== helperExit;
          helperExit = exit;
          if (gone && exit !== null && message.info.state !== "stopped") {
            (yield* UsageStatistics).error("helper_crashed");
          }
        }),
      );
      return;
    case "power":
      log.info("power", {
        event: message.event,
        onBattery: message.onBattery,
        thermalState: message.thermalState,
      });
      void runtime.runPromise(
        Effect.gen(function* () {
          const state = yield* CoreState;
          yield* state.update((status, nowMs) => ({
            ...status,
            power: {
              onBattery: message.onBattery,
              suspended:
                message.event === "suspend"
                  ? true
                  : message.event === "resume"
                    ? false
                    : status.power.suspended,
              thermalState: message.thermalState,
            },
            updatedAtMs: nowMs,
          }));
        }).pipe(Effect.withSpan("power.event", { attributes: { event: message.event } })),
      );
      return;
    case "idle":
      void runtime.runPromise(
        Effect.gen(function* () {
          const signals = yield* SystemSignals;
          signals.receiveIdle(message);
        }),
      );
      return;
    case "media-read":
      void runtime
        .runPromise(
          Effect.gen(function* () {
            const media = yield* EpisodeMedia;
            return yield* Effect.promise(() => media.read(message));
          }),
        )
        .then((reply) => {
          const answer = mediaReplyMessage(message.requestId, reply);
          if (answer !== null) post(answer);
        })
        .catch(() =>
          post({
            type: "media-failed",
            requestId: message.requestId,
            reason: "unavailable",
            total: null,
          }),
        );
      return;
    case "media-cancel":
      void runtime.runPromise(
        Effect.gen(function* () {
          const media = yield* EpisodeMedia;
          media.cancel(message.requestId);
        }),
      );
      return;
    case "exported":
      void runtime.runPromise(
        Effect.gen(function* () {
          const exports = yield* Exports;
          exports.receive(message.requestId, message.outcome);
        }),
      );
      return;
    case "export-ready":
      void runtime.runPromise(
        Effect.gen(function* () {
          const exports = yield* Exports;
          exports.confirm(message.requestId);
        }),
      );
      return;
    case "backup-save-picked":
      void runtime.runPromise(
        Effect.gen(function* () {
          (yield* Backup).receiveSavePath(message.requestId, message.path);
        }),
      );
      return;
    case "file-picked":
      void runtime.runPromise(
        Effect.gen(function* () {
          const picker = yield* FilePicker;
          picker.receive(message.requestId, message.path);
        }),
      );
      return;
    case "files-picked":
      void runtime.runPromise(
        Effect.gen(function* () {
          const picker = yield* FilePicker;
          picker.receiveFiles(message.requestId, message.paths);
        }),
      );
      return;
    case "clipboard-read":
      void runtime.runPromise(
        Effect.gen(function* () {
          const picker = yield* FilePicker;
          picker.receiveClipboard(message.requestId, message.content);
        }),
      );
      return;
    case "context-read":
      void runtime
        .runPromise(
          Effect.gen(function* () {
            const store = yield* ContextStore;
            return yield* Effect.promise(() => store.read(message));
          }),
        )
        .then(post)
        .catch(() =>
          post({
            type: "media-failed",
            requestId: message.requestId,
            reason: "unavailable",
            total: null,
          }),
        );
      return;
    case "voice-read-level":
      void runtime.runPromise(
        Effect.gen(function* () {
          const read = yield* VoiceRead;
          read.level(message.readId, message.ms, message.rms);
        }),
      );
      return;
    case "voice-read-ended":
      void runtime.runPromise(
        Effect.gen(function* () {
          const read = yield* VoiceRead;
          read.ended(message.readId, message.ok, message.message);
        }),
      );
      return;
    case "network":
      void runtime.runPromise(
        Effect.gen(function* () {
          (yield* Updates).receiveNetwork(message.network);
        }),
      );
      return;
    case "update-failed":
      log.warn("updates.install-failed", { reason: message.reason });
      void runtime.runPromise(
        Effect.gen(function* () {
          (yield* Updates).installFailed();
        }),
      );
      return;
    case "shutdown":
      void shutdown("main");
      return;
  }
}

parentPort.on("message", handle);
process.once("SIGTERM", () => void shutdown("SIGTERM"));

runtime
  .runPromise(Effect.void)
  .then(() => {
    log.info("core.ready", { pid: process.pid, database: config.databasePath });
    post({ type: "ready", databasePath: config.databasePath });
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log.error("core.fatal", { message });
    post({ type: "fatal", message });
    process.exit(1);
  });
