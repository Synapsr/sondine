import { homedir, totalmem } from "node:os";
import type { InstalledModel, ModelPickResult, ModelsStatus } from "@sondine/api";
import {
  MODEL_CATALOG,
  type CatalogArtifact,
  type DownloadPolicy,
  type InstalledArtifact,
} from "@sondine/engines";
import { usageError } from "@sondine/protocol";
import { Context, Effect, Layer, SubscriptionRef } from "effect";
import { CoreConfig } from "../config";
import { log } from "../log";
import { FilePicker } from "../file-picker";
import { ModelManager, type ModelTiming } from "./model-manager";
import { UsageStatistics } from "../usage/usage-layer";

/** Model artifacts: status, imports, downloads (ADR 016 "Models"). */
export interface ModelsService {
  /** Every change; progress at most 4 times a second. */
  readonly status: SubscriptionRef.SubscriptionRef<ModelsStatus>;
  /** Looks again for found files and kept downloads. */
  refresh(): Promise<ModelsStatus>;
  /** Throws `ModelRequestError` for an unknown artifact, or no file to import. */
  import(artifactId: string, path?: string): Promise<ModelsStatus>;
  pick(artifactId: string): Promise<ModelPickResult>;
  download(artifactId: string): Promise<ModelsStatus>;
  cancel(artifactId: string, discard: boolean): Promise<ModelsStatus>;
  installed(artifactId: string): InstalledArtifact | null;
  installedModels(): InstalledModel[];
  /** Called each time an artifact becomes ready. */
  onInstalled(listener: () => void): void;
}

export class Models extends Context.Service<Models, ModelsService>()("sondine/core/Models") {}

export interface ModelsOptions {
  /** `MODEL_CATALOG` by default; tests use small synthetic artifacts. */
  readonly catalog?: readonly CatalogArtifact[];
  /** `DOWNLOAD_POLICY` by default; tests allow http on 127.0.0.1. */
  readonly policy?: DownloadPolicy;
  readonly fetch?: typeof globalThis.fetch;
  readonly freeBytes?: (path: string) => number;
  /** Where found files are looked for; the user's home by default. */
  readonly homeDir?: string;
  readonly memoryBytes?: number;
  readonly timing?: Partial<ModelTiming>;
}

export const modelsLayer = (options: ModelsOptions = {}) =>
  Layer.effect(
    Models,
    Effect.gen(function* () {
      const config = yield* CoreConfig;
      const picker = yield* FilePicker;
      const usage = yield* UsageStatistics;
      const listeners: (() => void)[] = [];
      let status: SubscriptionRef.SubscriptionRef<ModelsStatus> | null = null;

      const manager = new ModelManager({
        root: config.modelsDir,
        homeDir: options.homeDir ?? homedir(),
        catalog: options.catalog ?? MODEL_CATALOG,
        ...(options.policy === undefined ? {} : { policy: options.policy }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.freeBytes === undefined ? {} : { freeBytes: options.freeBytes }),
        ...(options.timing === undefined ? {} : { timing: options.timing }),
        memoryBytes: options.memoryBytes ?? totalmem(),
        log,
        onStatus: (next) => {
          // Forked, not runSync: the ref's lock may be held (see CoreState.publish).
          if (status !== null) Effect.runFork(SubscriptionRef.set(status, next));
        },
        onInstalled: () => {
          for (const listener of listeners) listener();
        },
        onFailed: (code) => usage.error(usageError("model", code)),
        // Main owns OS dialogs: core asks, main answers with the path or null.
        pickFile: (request) => picker.pick({ purpose: "model", ...request }),
      });
      status = yield* SubscriptionRef.make(manager.status());
      manager.start();
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await manager.stop();
        }),
      );
      const ref = status;

      return Models.of({
        status: ref,
        refresh: () => manager.refresh(),
        import: (artifactId, path) => manager.import(artifactId, path),
        pick: (artifactId) => manager.pick(artifactId),
        download: (artifactId) => manager.download(artifactId),
        cancel: (artifactId, discard) => manager.cancel(artifactId, discard),
        installed: (artifactId) => manager.installed(artifactId),
        installedModels: () => manager.installedModels(),
        onInstalled: (listener) => {
          listeners.push(listener);
        },
      });
    }),
  );
