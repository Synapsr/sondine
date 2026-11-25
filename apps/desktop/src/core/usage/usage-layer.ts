import { totalmem } from "node:os";
import { Context, Effect, Layer } from "effect";
import { CoreConfig } from "../config";
import { Database } from "../database";
import { log } from "../log";
import { Usage, type UsageDeps } from "./usage";
import { sendReport } from "./usage-send";

// The anonymous statistics in core (ADR 042, usage.ts). Built early: the
// queues, the models and the API's hosts all count on it.

export class UsageStatistics extends Context.Service<UsageStatistics, Usage>()(
  "sondine/core/UsageStatistics",
) {}

/** Tests answer the request, and set the clock. */
export type UsageOptions = Partial<Pick<UsageDeps, "send" | "now" | "random" | "memoryBytes">>;

export const usageLayer = (options: UsageOptions = {}) =>
  Layer.effect(
    UsageStatistics,
    Effect.gen(function* () {
      const db = yield* Database;
      const config = yield* CoreConfig;
      const usage = new Usage({
        db,
        appVersion: config.appVersion,
        macosVersion: config.macosVersion,
        endpoint: config.statsEndpoint,
        memoryBytes: options.memoryBytes ?? totalmem(),
        send:
          options.send ?? ((endpoint, report, signal) => sendReport(endpoint, report, { signal })),
        now: options.now ?? Date.now,
        random: options.random ?? Math.random,
        log: (event, fields) => log.info(event, fields),
      });
      usage.start();
      yield* Effect.addFinalizer(() => Effect.promise(() => usage.close()));
      return UsageStatistics.of(usage);
    }),
  );
