import { makeLocator, type Located } from "@sondine/engines";
import { LabCoreSettings } from "../shared/flow-lab";
import type { CoreConfigShape } from "./config";
import { log } from "./log";
import type { CoreLayerOptions } from "./runtime";

// Development only: the flow lab (ADR 049, scripts/dev-lab.mjs). When main
// runs as the lab, it hands core `SONDINE_FLOW_LAB`, what the step on screen
// needs: core then reaches nothing but this Mac (the lab's fake Cloud on
// 127.0.0.1), an update comes from the lab, and the agent is the fake
// `claude` of the engines' tests, or none. Production builds leave it out
// (`import.meta.env.DEV`), and a development build reads it only while
// `updates.blocked` is "development", outside a package.

/** The lab's settings for this core; null outside the lab. */
export function labSettings(config: CoreConfigShape): LabCoreSettings | null {
  const given = process.env["SONDINE_FLOW_LAB"];
  if (config.updates.blocked !== "development" || given === undefined) return null;
  const parsed = LabCoreSettings.safeParse(JSON.parse(given));
  if (!parsed.success) {
    log.warn("flow-lab.settings-invalid", {});
    return null;
  }
  return parsed.data;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** A fetch that reaches only this Mac. */
export const loopbackFetch: typeof globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (LOOPBACK.has(url.hostname)) return globalThis.fetch(input, init);
  log.info("flow-lab.network-refused", { host: url.host });
  return Promise.reject(new TypeError(`the flow lab reaches no network (${url.host})`));
};

/** Where the lab's Cloud answers when it is off: a port nothing listens on. */
const OFFLINE_CLOUD = "http://127.0.0.1:9";

export function labCoreOptions(lab: LabCoreSettings, appVersion: string): CoreLayerOptions {
  return {
    compute: {
      beta:
        lab.cloud === null
          ? null
          : {
              endpoint: lab.offline ? OFFLINE_CLOUD : lab.cloud.endpoint,
              serverKey: lab.cloud.key,
            },
      fetch: loopbackFetch,
    },
    models: { fetch: loopbackFetch },
    updates: {
      fetch: loopbackFetch,
      ask: async () => {
        if (lab.offline) return { ok: false, problem: "network" };
        const version = lab.update ?? appVersion;
        return {
          ok: true,
          feed: {
            format: "sondine-update",
            formatVersion: 1,
            version,
            minimumMacos: "15.0",
            archive: { sizeBytes: 180 * 1024 ** 2, sha256: "0".repeat(64) },
          },
        };
      },
    },
  };
}

/**
 * The `claude` chat and the journal start: the real one outside the lab; in
 * the lab, its fake (or none), never the user's.
 */
export function claudeLocator(config: CoreConfigShape): {
  readonly locate: () => Promise<Located>;
  readonly refresh: () => void;
} {
  const lab = import.meta.env.DEV ? labSettings(config) : null;
  if (lab !== null) {
    const env: Record<string, string> = { FAKE_CLAUDE_MODE: lab.agent.mode };
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !(key in env)) env[key] = value;
    }
    return {
      locate: () => Promise.resolve({ executable: lab.agent.executable, env }),
      refresh: () => undefined,
    };
  }
  const locator = makeLocator({ names: ["claude"], inherited: process.env });
  return { locate: () => locator.locate("claude"), refresh: () => locator.refresh() };
}
