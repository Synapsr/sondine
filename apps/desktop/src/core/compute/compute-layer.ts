import type {
  ComputeConnectOutcome,
  ComputeDestination,
  ComputeJoinOutcome,
  ComputeQuota,
  ComputeStatus,
} from "@sondine/api";
import { computeSettings, setComputeSettings, type ComputeSettings } from "@sondine/db";
import { EngineError, type AsrEngine } from "@sondine/engines";
import {
  claimPlace,
  createRemoteAsrEngine,
  hello,
  leavePlace,
  parseServerLink,
  readQuota,
  RefusedError,
  Token,
  type Fetch,
  type RemoteLocality,
  type ServerAddress,
  type ServerLink,
} from "@sondine/engines/remote";
import { Context, Effect, Layer } from "effect";
import { CLOUD_BETA } from "../../shared/cloud";
import { Database } from "../database";
import { log } from "../log";

// Where the final transcription runs (ADR 040): this Mac unless the user
// chose a machine of theirs or the beta. Nothing here reaches the network
// before one of those calls: reading the choice, or whether a beta exists in
// this build, is local.

export interface ComputeService {
  status(): ComputeStatus;
  /** The chosen server's engine; null while transcription runs on this Mac. */
  engine(): AsrEngine | null;
  /** False: that destination is not set up. */
  choose(destination: ComputeDestination): boolean;
  /** Checks the link's server, then keeps it and sends transcription there. */
  connect(link: string): Promise<ComputeConnectOutcome>;
  /** Forgets the user's machine. */
  disconnect(): void;
  /** Takes one of the beta's places (or connects an invite link/token), then sends transcription there. */
  joinBeta(invite?: string): Promise<ComputeJoinOutcome>;
  /** Gives the place back, and forgets it whatever the server says. */
  leaveBeta(): Promise<void>;
  /** Reads the active remote destination's quota; null on this Mac or when unavailable. */
  quota(): Promise<ComputeQuota | null>;
  /** Called after each change of where transcription runs. */
  onChanged(listener: () => void): void;
}

export class Compute extends Context.Service<Compute, ComputeService>()("sondine/core/Compute") {}

export interface ComputeOptions {
  /** The beta's server; `CLOUD_BETA` by default. */
  readonly beta?: ServerAddress | null;
  readonly fetch?: Fetch;
  readonly now?: () => number;
}

const failed = (error: unknown) => (error instanceof EngineError ? error.code : "internal");

export const computeLayer = (options: ComputeOptions = {}) =>
  Layer.effect(
    Compute,
    Effect.gen(function* () {
      const db = yield* Database;
      const beta = options.beta === undefined ? CLOUD_BETA : options.beta;
      const now = options.now ?? Date.now;
      const network = options.fetch === undefined ? {} : { fetch: options.fetch };
      const listeners: (() => void)[] = [];
      let engine: { readonly key: string; readonly engine: AsrEngine } | null = null;

      // Counts every choice: one made while a server was answering wins over its answer.
      let choice = 0;

      const save = (change: Partial<ComputeSettings>) => {
        choice += 1;
        const before = computeSettings(db);
        const next = { ...before, ...change };
        setComputeSettings(db, next, now());
        log.info("compute.changed", { destination: next.destination });
        for (const listener of listeners) listener();
      };

      return Compute.of({
        status: () => {
          const { destination, own, beta: place } = computeSettings(db);
          return {
            destination,
            own: own === null ? null : { name: own.name, host: new URL(own.endpoint).host },
            beta: { available: beta !== null, joined: place !== null },
          };
        },
        engine: () => {
          const settings = computeSettings(db);
          const { destination } = settings;
          const link = destination === "device" ? null : settings[destination];
          if (link === null || destination === "device") return null;
          const locality: RemoteLocality = destination;
          const key = JSON.stringify([locality, link]);
          if (engine?.key !== key) {
            engine = { key, engine: createRemoteAsrEngine({ link, locality, ...network }) };
          }
          return engine.engine;
        },
        choose: (destination) => {
          const settings = computeSettings(db);
          if (destination !== "device" && settings[destination] === null) return false;
          save({ destination });
          return true;
        },
        connect: async (text) => {
          const link = parseServerLink(text);
          if (link === null) return "bad-link";
          const asked = ++choice;
          try {
            const { name } = await hello(link, network);
            if (choice !== asked) return "cancelled";
            save({ destination: "own", own: { ...link, name } });
            return "connected";
          } catch (error) {
            const code = failed(error);
            log.warn("compute.connect-failed", { code });
            if (code === "network_unavailable") return "offline";
            return code === "unauthorized" ? "refused" : "mismatch";
          }
        },
        disconnect: () => {
          const { destination } = computeSettings(db);
          save({ own: null, destination: destination === "own" ? "device" : destination });
        },
        joinBeta: async (invite) => {
          if (beta === null) return "closed";
          const trimmed = invite?.trim() ?? "";
          if (trimmed !== "") {
            let link: ServerLink | null = null;
            const parsedLink = parseServerLink(trimmed);
            if (parsedLink !== null) {
              if (
                parsedLink.endpoint !== beta.endpoint ||
                parsedLink.serverKey !== beta.serverKey
              ) {
                return "mismatch";
              }
              link = parsedLink;
            } else {
              const rawToken = Token.safeParse(trimmed);
              if (rawToken.success) link = { ...beta, token: rawToken.data };
            }
            if (link === null) return "bad-link";
            const asked = ++choice;
            try {
              const { name } = await hello(link, network);
              if (choice !== asked) return "cancelled";
              save({ destination: "beta", beta: { ...link, name } });
              return "joined";
            } catch (error) {
              const code = failed(error);
              log.warn("compute.join-failed", { code });
              if (code === "network_unavailable") return "offline";
              return code === "unauthorized" ? "refused" : "mismatch";
            }
          }
          const { beta: place } = computeSettings(db);
          if (place !== null) {
            save({ destination: "beta" });
            return "joined";
          }
          const asked = ++choice;
          try {
            const token = await claimPlace(beta, network);
            if (choice !== asked) {
              // Nobody wants this place any more: it goes to someone else.
              await leavePlace({ ...beta, token }, network).catch(() => undefined);
              return "cancelled";
            }
            save({ destination: "beta", beta: { ...beta, token, name: "Sondine" } });
            return "joined";
          } catch (error) {
            const refusal = error instanceof RefusedError ? error.refusal : null;
            log.warn("compute.join-failed", { code: failed(error) });
            if (refusal === "full" || refusal === "closed" || refusal === "busy") return refusal;
            return failed(error) === "network_unavailable" ? "offline" : "mismatch";
          }
        },
        leaveBeta: async () => {
          const { destination, beta: place } = computeSettings(db);
          save({ beta: null, destination: destination === "beta" ? "device" : destination });
          if (place !== null) await leavePlace(place, network).catch(() => undefined);
        },
        quota: async () => {
          const settings = computeSettings(db);
          if (settings.destination === "device") return null;
          const link = settings[settings.destination];
          if (link === null) return null;
          return readQuota(link, network).catch(() => null);
        },
        onChanged: (listener) => {
          listeners.push(listener);
        },
      });
    }),
  );
