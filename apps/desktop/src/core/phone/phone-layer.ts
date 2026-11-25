import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import type { Server } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { ServiceFailure, type ApiServices, type PhoneStatus } from "@sondine/api";
import {
  listPhoneDevices,
  recentTagNames,
  pairedPhoneCount,
  pairPhoneDevice,
  phoneSyncSettings,
  revokeAllPhoneDevices,
  revokePhoneDevice,
  setPhoneSyncSettings,
} from "@sondine/db";
import { formatPairingUrl, PHONE_LINK_VERSION } from "@sondine/protocol";
import { Context, Effect, Layer } from "effect";
import { DATA_LAYOUT } from "../../shared/data-layout";
import { AgentAccess } from "../agents/agent-access";
import { EpisodeMedia } from "../audio/episode-media";
import { CoreConfig } from "../config";
import { Database } from "../database";
import { Imports, type PhoneExpectation, type PhoneReceipt } from "../imports/imports-layer";
import { log } from "../log";
import { closePrivate, listenPrivate } from "../private-socket";
import { createLanIdentity, readLanIdentity, type LanIdentity } from "./lan-identity";
import { makeRelaySupervisor, type RelaySpawner } from "./lan-relay";
import { makePairingDesk, systemClock, type PairingClock } from "./pairing";
import { makePhoneMemory } from "./phone-memory";
import { readPhoneResult } from "./phone-results";
import { makePhoneServer, type PhoneLimits } from "./phone-server";
import { UsageStatistics } from "../usage/usage-layer";

// Settings ▸ Téléphone and sync with paired iPhones (ADR 008). While the
// user's switch is on and a pairing is open or a phone is paired, core
// listens on `run/phone.sock` and runs `sondine-lan`; otherwise nothing
// listens and nothing is advertised. The key is made at the first pairing.
// A phone's deletion runs the Mac's own, the one « Supprimer » runs, its note
// the one `context.add` runs, and its results and its reads of the Mac's
// memory read the app's procedures: the API hands them over once built
// (`useApi`).

const notReady = () => Promise.reject(new Error("the API is not ready yet"));

/** How long « Appairer un iPhone… » waits for the relay to listen. */
const RELAY_START_MS = 15_000;
const SWEEP_EVERY_MS = 3_600_000;
/** How long the relay stays up for a revoked phone that has not heard it yet. */
const REVOKED_TOLD_MS = 24 * 3_600_000;

export interface PhoneOptions {
  /** How the relay is started; tests give a fake. */
  readonly spawn?: RelaySpawner;
  /** The pairing's timers and the server's clock; tests drive them. */
  readonly clock?: PairingClock;
  /** The Mac's addresses to tell a phone; the interfaces by default. */
  readonly addresses?: (tailnet: boolean) => string[];
  readonly limits?: Partial<PhoneLimits>;
  readonly freeBytes?: () => number;
  /** Wraps the import of a received file; tests order a deletion around it. */
  readonly receive?: (
    path: string,
    expected: PhoneExpectation,
    imported: (path: string, expected: PhoneExpectation) => Promise<PhoneReceipt>,
  ) => Promise<PhoneReceipt>;
  /** Runs while a result or a memory read is read, before the deletion check; tests delete something there. */
  readonly whileReading?: () => Promise<void>;
  /** The largest memory read answered, 8 MiB; tests lower it. */
  readonly memoryAnswerBytes?: number;
  /** Wraps the addition of a phone's note; tests hold two tries of one note at once. */
  readonly addNote?: (
    episodeId: number,
    text: string,
    claim: () => boolean,
    added: (episodeId: number, text: string, claim: () => boolean) => Promise<boolean>,
  ) => Promise<boolean>;
}

export interface PhoneSyncService {
  readonly status: () => PhoneStatus;
  /** A phone's request is being answered, or a pairing is open. */
  readonly busy: () => boolean;
  readonly setEnabled: (enabled: boolean) => Promise<PhoneStatus>;
  readonly setTailnet: (enabled: boolean) => Promise<PhoneStatus>;
  readonly pair: () => Promise<PhoneStatus>;
  readonly answer: (accept: boolean) => Promise<PhoneStatus>;
  readonly revoke: (deviceId: string) => Promise<PhoneStatus>;
  readonly reset: () => Promise<PhoneStatus>;
  /** What the API hands over once it is built. */
  readonly useApi: (api: PhoneApi) => void;
}

/** The Mac's own procedures a phone's requests run (ADR 008). */
export interface PhoneApi {
  /** The deletion of an episode, as « Supprimer » runs it. */
  readonly deleteEpisode: (episodeId: number) => Promise<void>;
  /**
   * A note added as `context.add` adds one; `claim` runs first in its durable
   * transaction, and nothing is written when it returns false.
   */
  readonly addNote: (episodeId: number, text: string, claim: () => boolean) => Promise<boolean>;
  /** A tag from the phone, as `tags.set` puts it (ADR 039); `claim` first, in its transaction. */
  readonly setTag: (
    episodeId: number,
    tag: { readonly name: string; readonly on: boolean },
    claim: () => boolean,
  ) => Promise<boolean>;
  /** « C'est moi » from the phone: voice `ordinal` named as the user; `claim` first. */
  readonly confirmSelf: (
    episodeId: number,
    voice: { readonly ordinal: number; readonly sentenceId: number },
    claim: () => boolean,
  ) => Promise<boolean>;
  /** The app's procedures, for reads (`episodes.get`, `journal.day`, `search.query`…). */
  readonly services: () => ApiServices;
}

export class PhoneSync extends Context.Service<PhoneSync, PhoneSyncService>()(
  "sondine/core/PhoneSync",
) {}

const SERVICE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** « Sondine » and four random characters: never the user's or the Mac's name. */
const serviceName = (): string =>
  `Sondine ${Array.from({ length: 4 }, () => SERVICE_ALPHABET[randomInt(SERVICE_ALPHABET.length)]).join("")}`;

const isTailnet = (address: string) => {
  const [a, b] = address.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b < 128;
};

/**
 * The Mac's IPv4 addresses a phone can try when Bonjour is blocked: those of
 * the home network first, then, with Tailscale allowed, the tunnels' in
 * Tailscale's range, which the phone tries only once none of the others answered.
 */
export function macAddresses(
  tailnet: boolean,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const home: string[] = [];
  const tunnels: string[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    const tunnel = /^(utun|ipsec|ppp|gif|stf|awdl|llw|bridge|anpi|ap)/.test(name);
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      if (!tunnel && !isTailnet(entry.address)) home.push(entry.address);
      if (tunnel && tailnet && isTailnet(entry.address)) tunnels.push(entry.address);
    }
  }
  return [...home, ...tunnels];
}

export const phoneSyncLayer = (options: PhoneOptions = {}) =>
  Layer.effect(
    PhoneSync,
    Effect.gen(function* () {
      const config = yield* CoreConfig;
      const db = yield* Database;
      const imports = yield* Imports;
      const access = yield* AgentAccess;
      const usage = yield* UsageStatistics;
      const media = yield* EpisodeMedia;
      const clock = options.clock ?? systemClock;
      const addresses = options.addresses ?? macAddresses;
      const lanDir = join(config.dataDir, DATA_LAYOUT.lanDir);
      let identity: LanIdentity | null = readLanIdentity(lanDir);
      let api: PhoneApi | null = null;

      /** This Mac's id and Bonjour name, made once. */
      const ensureNames = () => {
        const settings = phoneSyncSettings(db);
        const changes = {
          ...(settings.macId === null ? { macId: randomUUID() } : {}),
          ...(settings.serviceName === null ? { serviceName: serviceName() } : {}),
        };
        if (Object.keys(changes).length > 0) setPhoneSyncSettings(db, changes, clock.now());
        const now = phoneSyncSettings(db);
        return { macId: now.macId ?? "", serviceName: now.serviceName ?? "" };
      };

      const relay =
        config.phoneRelay === null
          ? null
          : makeRelaySupervisor({
              binary: config.phoneRelay.path,
              ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
              onListening: (port) => setPhoneSyncSettings(db, { port }, clock.now()),
            });
      const port = () => relay?.state().port ?? phoneSyncSettings(db).port;

      const pairing = makePairingDesk({
        clock,
        complete(request) {
          const credential = `sdp_${randomBytes(32).toString("base64url")}`;
          pairPhoneDevice(db, {
            deviceId: request.deviceId,
            name: request.deviceName,
            credentialHash: createHash("sha256").update(credential, "utf8").digest(),
            nowMs: clock.now(),
          });
          return { credential, macId: ensureNames().macId };
        },
        changed: () => void reconcile(),
      });

      const server = makePhoneServer({
        db,
        inboxDir: join(config.dataDir, DATA_LAYOUT.phoneInboxDir),
        clock,
        pairing,
        receive: (path, expected) =>
          options.receive === undefined
            ? imports.receive(path, expected)
            : options.receive(path, expected, imports.receive),
        deleteEpisode: (episodeId) => (api === null ? notReady() : api.deleteEpisode(episodeId)),
        addNote: (episodeId, text, claim) => {
          const add = (id: number, words: string, claimed: () => boolean) =>
            api === null ? notReady() : api.addNote(id, words, claimed);
          return options.addNote === undefined
            ? add(episodeId, text, claim)
            : options.addNote(episodeId, text, claim, add);
        },
        setTag: (episodeId, tag, claim) =>
          api === null ? notReady() : api.setTag(episodeId, tag, claim),
        confirmSelf: (episodeId, voice, claim) =>
          api === null ? notReady() : api.confirmSelf(episodeId, voice, claim),
        tags: () => recentTagNames(db, 50),
        result: (input) =>
          readPhoneResult(
            {
              db,
              services: () => api?.services() ?? null,
              playback: (episodeId) => media.playback(episodeId),
              contentGeneration: () => access.contentGeneration(),
              ...(options.whileReading === undefined ? {} : { whileReading: options.whileReading }),
            },
            input,
          ),
        memory: makePhoneMemory({
          db,
          services: () => api?.services() ?? null,
          usage,
          contentGeneration: () => access.contentGeneration(),
          ...(options.whileReading === undefined ? {} : { whileReading: options.whileReading }),
          ...(options.memoryAnswerBytes === undefined
            ? {}
            : { maxAnswerBytes: options.memoryAnswerBytes }),
        }),
        media: { read: (request) => media.read(request), cancel: (id) => media.cancel(id) },
        hello: () => ({
          macId: ensureNames().macId,
          addrs: addresses(phoneSyncSettings(db).tailnet),
          port: port() ?? 1,
        }),
        tailnet: () => phoneSyncSettings(db).tailnet,
        changed: () => void reconcile(),
        revokedHeard: (deviceId) => {
          if (telling.delete(deviceId)) void reconcile();
        },
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        ...(options.freeBytes === undefined ? {} : { freeBytes: options.freeBytes }),
      });

      // Phones revoked here that have not heard it yet, with when to stop
      // waiting: the relay stays up for them (a phone that never hears
      // `revoked` keeps showing a Mac it can no longer reach). In memory: a
      // restart of core stops waiting.
      const telling = new Map<string, number>();
      let tellingTimer: NodeJS.Timeout | null = null;
      const stillTelling = () => {
        const now = clock.now();
        for (const [deviceId, untilMs] of telling) if (untilMs <= now) telling.delete(deviceId);
        if (tellingTimer !== null) clearTimeout(tellingTimer);
        tellingTimer = null;
        if (telling.size === 0) return false;
        const next = Math.min(...telling.values()) - now;
        tellingTimer = setTimeout(() => void reconcile(), next);
        tellingTimer.unref();
        return true;
      };

      // The socket and the relay follow one rule, applied in turn.
      let listener: Server | null = null;
      let turn: Promise<void> = Promise.resolve();
      const wanted = () =>
        relay !== null &&
        identity !== null &&
        phoneSyncSettings(db).enabled &&
        (pairing.view() !== null || pairedPhoneCount(db) > 0 || stillTelling());
      const apply = async () => {
        const want = wanted();
        if (want && listener === null) {
          listener = await listenPrivate(config.phoneSocket, "phone", (socket) =>
            server.accept(socket),
          );
        }
        if (!want && listener !== null) {
          const closing = listener;
          listener = null;
          server.closeAll();
          await closePrivate(closing, config.phoneSocket);
        }
        const settings = phoneSyncSettings(db);
        relay?.want(
          want && listener !== null && identity !== null
            ? {
                bundlePath: identity.bundlePath,
                passwordPath: identity.passwordPath,
                socketPath: config.phoneSocket,
                name: ensureNames().serviceName,
                port: settings.port,
                tailnet: settings.tailnet,
                allowLoopback: config.phoneRelay?.allowLoopback ?? false,
              }
            : null,
        );
        log.info("phone.sync", { listening: listener !== null, phones: pairedPhoneCount(db) });
      };
      const reconcile = (): Promise<void> => {
        turn = turn.then(apply).catch((error: unknown) =>
          log.warn("phone.sync-failed", {
            message: error instanceof Error ? error.message.slice(0, 200) : String(error),
          }),
        );
        return turn;
      };

      const status = (): PhoneStatus => {
        const settings = phoneSyncSettings(db);
        const view = pairing.view();
        const relayState = relay?.state() ?? { phase: "off", port: null, problem: null };
        const currentPort = port();
        return {
          enabled: settings.enabled,
          tailnet: settings.tailnet,
          available: relay !== null,
          relay: relayState,
          serviceName: settings.serviceName,
          pairing:
            view === null || identity === null
              ? null
              : {
                  phase: view.phase,
                  url:
                    currentPort === null
                      ? null
                      : formatPairingUrl({
                          v: PHONE_LINK_VERSION,
                          pin: identity.pin,
                          token: view.token,
                          name: settings.serviceName ?? ensureNames().serviceName,
                          port: currentPort,
                          addrs: addresses(false).slice(0, 8),
                        }),
                  expiresAtMs: view.expiresAtMs,
                  deviceName: view.phase === "asked" ? view.deviceName : null,
                  digits: view.phase === "asked" ? view.digits : null,
                },
          phones: listPhoneDevices(db).map((device) => ({ ...device })),
        };
      };

      const sweep = () => {
        try {
          server.sweep();
        } catch (error) {
          log.warn("phone.sweep-failed", {
            error: error instanceof Error ? error.name : "unknown",
          });
        }
      };
      sweep();
      const sweeper = setInterval(sweep, SWEEP_EVERY_MS);
      sweeper.unref();
      yield* Effect.promise(reconcile);
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          clearInterval(sweeper);
          pairing.cancel();
          await relay?.stop();
          server.closeAll();
          await turn;
          if (listener !== null) await closePrivate(listener, config.phoneSocket);
          listener = null;
        }),
      );

      return PhoneSync.of({
        status,
        busy: () => pairing.view() !== null || server.answering(),
        async setEnabled(enabled) {
          setPhoneSyncSettings(db, { enabled }, clock.now());
          log.info("phone.enabled-set", { enabled });
          if (!enabled) pairing.cancel();
          await reconcile();
          return status();
        },
        async setTailnet(enabled) {
          setPhoneSyncSettings(db, { tailnet: enabled }, clock.now());
          log.info("phone.tailnet-set", { enabled });
          // The relay starts again without it; what came through it closes now.
          if (!enabled) server.closeTailnet();
          await reconcile();
          return status();
        },
        async pair() {
          if (relay === null) {
            throw new ServiceFailure("invalid-input", "This build has no relay for phones.");
          }
          setPhoneSyncSettings(db, { enabled: true }, clock.now());
          ensureNames();
          if (identity === null) {
            identity = await createLanIdentity(lanDir);
            log.info("phone.identity-created", {});
          }
          pairing.open(identity.pin);
          await reconcile();
          try {
            await relay.listening(RELAY_START_MS);
          } catch {
            pairing.cancel();
            await reconcile();
            throw new ServiceFailure(
              "invalid-input",
              "The relay for phones did not start; nothing listens.",
            );
          }
          log.info("phone.pairing-opened", {});
          return status();
        },
        async answer(accept) {
          pairing.answer(accept);
          await reconcile();
          return status();
        },
        async revoke(deviceId) {
          if (!revokePhoneDevice(db, deviceId, clock.now())) {
            throw new ServiceFailure("not-found", "This phone is not paired.");
          }
          server.disconnect(deviceId);
          telling.set(deviceId, clock.now() + REVOKED_TOLD_MS);
          log.info("phone.revoked", {});
          await reconcile();
          return status();
        },
        async reset() {
          pairing.cancel();
          for (const deviceId of revokeAllPhoneDevices(db, clock.now()))
            server.disconnect(deviceId);
          // No key, nothing listens: those phones learn it at the next pairing.
          telling.clear();
          // The next pairing makes a new key: a copy of this one opens nothing.
          rmSync(lanDir, { recursive: true, force: true });
          identity = null;
          log.info("phone.pairing-reset", {});
          await reconcile();
          return status();
        },
        useApi(handed) {
          api = handed;
        },
      });
    }),
  );
