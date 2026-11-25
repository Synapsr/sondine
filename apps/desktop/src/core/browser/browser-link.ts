import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { browserLinkEnabled, pruneWebPlays, setBrowserLinkEnabled } from "@sondine/db";
import type { BrowserStatus } from "@sondine/api";
import { Context, Effect, Layer } from "effect";
import { CoreConfig, type CoreConfigShape } from "../config";
import { Database } from "../database";
import { log } from "../log";
import { MainChannel } from "../main-channel";
import { makeBrowserHost } from "./browser-host";
import { fileTrace } from "./link-trace";
import { hostStates, installHosts, removeHosts, type HostInstall } from "./native-hosts";

// Settings ▸ Navigateurs (ADR 023): the switch and the browsers that can run
// Sondine's extension; what Sondine keeps of each site is a private zone
// (ADR 029). While
// the switch is on, core listens for the extension and each installed
// browser knows where the relay is; off, both go away and nothing more is
// recorded. Plays no episode met are pruned after two days. What happens on
// the link goes to its trace (`diagnostics/browser-link.jsonl`).

/** Plays nothing shows are kept this long: late regions arrive within minutes. */
const PLAYS_KEPT_MS = 2 * 24 * 3_600_000;
const PRUNE_EVERY_MS = 3_600_000;

export interface BrowserLinkService {
  readonly status: () => BrowserStatus;
  readonly setEnabled: (enabled: boolean) => Promise<BrowserStatus>;
  /** Copies the extension where a browser can load it and shows it in the Finder; false without one. */
  readonly showExtension: () => boolean;
}

export class BrowserLink extends Context.Service<BrowserLink, BrowserLinkService>()(
  "sondine/core/BrowserLink",
) {}

/** The version of the extension this build carries, from its manifest. */
function shippedVersion(config: CoreConfigShape): string | null {
  const extension = config.browserExtension;
  if (extension === null) return null;
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(extension.source, "manifest.json"), "utf8"),
    );
    return typeof manifest === "object" &&
      manifest !== null &&
      "version" in manifest &&
      typeof manifest.version === "string"
      ? manifest.version.slice(0, 32)
      : null;
  } catch {
    return null;
  }
}

function hostInstall(config: CoreConfigShape): HostInstall | null {
  const relay = config.browserRelay;
  if (relay === null) return null;
  return {
    supportDir: join(homedir(), "Library", "Application Support"),
    relayPath: relay.path,
    socket: relay.socketArgument
      ? { path: config.browserSocket, runDir: join(config.dataDir, "run") }
      : null,
    ...(config.nativeHostsDir === null ? {} : { onlyDirs: [config.nativeHostsDir] }),
  };
}

export const browserLinkLayer = Layer.effect(
  BrowserLink,
  Effect.gen(function* () {
    const db = yield* Database;
    const config = yield* CoreConfig;
    const main = yield* MainChannel;
    const install = hostInstall(config);
    const host = makeBrowserHost({
      socketPath: config.browserSocket,
      db,
      trace: fileTrace(config.browserTracePath),
    });
    const shipped = shippedVersion(config);

    /** Copies the extension this build carries over the user's copy, so a browser reloads the new one. */
    const placeExtension = (): string | null => {
      const extension = config.browserExtension;
      if (extension === null || !existsSync(join(extension.source, "manifest.json"))) return null;
      rmSync(extension.target, { recursive: true, force: true });
      cpSync(extension.source, extension.target, { recursive: true });
      return extension.target;
    };

    const apply = (enabled: boolean) => {
      if (install !== null) {
        try {
          if (enabled) {
            const dirs = installHosts(install);
            log.info("browser.hosts-installed", { browsers: dirs.length });
          } else {
            log.info("browser.hosts-removed", { manifests: removeHosts(install) });
          }
        } catch (error) {
          log.warn("browser.hosts-failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (enabled && existsSync(config.browserExtension?.target ?? "")) placeExtension();
      return host.setEnabled(enabled);
    };

    const status = (): BrowserStatus => {
      const heard = new Map(host.browsers().map((browser) => [browser.bundleId, browser]));
      const states = install === null ? [] : hostStates(install);
      const listed = new Set(states.map((state) => state.bundleId));
      const enabled = browserLinkEnabled(db);
      const link = (bundleId: string) => {
        const browser = heard.get(bundleId);
        return {
          links: browser?.links ?? 0,
          lastHeardAtMs: browser?.lastHeardAtMs ?? null,
          extension: browser?.extension ?? null,
        };
      };
      return {
        enabled,
        available: install !== null && config.browserExtension !== null,
        extension: shipped,
        browsers: [
          ...states.map((state) => ({
            bundleId: state.bundleId,
            name: state.name,
            installed: enabled && state.installed,
            ...link(state.bundleId),
          })),
          // A browser Sondine does not list that started the relay anyway (it reads another's folder).
          ...[...heard.values()]
            .filter((browser) => !listed.has(browser.bundleId))
            .map((browser) => ({
              bundleId: browser.bundleId,
              name: browser.name,
              installed: true,
              ...link(browser.bundleId),
            })),
        ],
      };
    };

    yield* Effect.promise(() => apply(browserLinkEnabled(db)));
    yield* Effect.addFinalizer(() => Effect.promise(() => host.stop()));
    const prune = Effect.sync(() => {
      const plays = pruneWebPlays(db, Date.now() - PLAYS_KEPT_MS);
      if (plays > 0) log.info("browser.plays-pruned", { plays });
    });
    yield* prune;
    yield* prune.pipe(Effect.delay(`${PRUNE_EVERY_MS} millis`), Effect.forever, Effect.forkScoped);

    return BrowserLink.of({
      status,
      async setEnabled(enabled) {
        setBrowserLinkEnabled(db, enabled, Date.now());
        log.info("browser.link-set", { enabled });
        await apply(enabled);
        return status();
      },
      showExtension() {
        const target = placeExtension();
        if (target === null) return false;
        main.post({ type: "reveal-folder", path: target });
        return true;
      },
    });
  }),
);
