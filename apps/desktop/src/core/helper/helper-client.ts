import {
  PROTOCOL_VERSION,
  type AckEvent,
  type ConfigMessage,
  type ControlMessage,
  type HelloMessage,
  type HelperEvent,
  type ReadyEvent,
} from "@sondine/protocol";
import {
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Layer,
  PubSub,
  Queue,
  Ref,
  Schedule,
  SubscriptionRef,
} from "effect";
import { CoreConfig } from "../config";
import { log } from "../log";
import { openHelperSocket, type HelperSocket } from "./helper-socket";

export class HelperUnavailable extends Data.TaggedError("HelperUnavailable")<{
  readonly reason: string;
}> {}

export class HelperRejected extends Data.TaggedError("HelperRejected")<{
  readonly request: string;
  readonly code: string;
  readonly message: string;
}> {}

export class HelperTimeout extends Data.TaggedError("HelperTimeout")<{
  readonly request: string;
}> {}

export type HelperRequestError = HelperUnavailable | HelperRejected | HelperTimeout;

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
/** Any control message except `hello` (the client sends it itself), without its id. */
export type HelperRequest = WithoutId<Exclude<ControlMessage, HelloMessage>>;

export interface HelperConnectionState {
  readonly state: "connecting" | "connected" | "disconnected" | "incompatible";
  readonly ready: ReadyEvent | null;
  readonly connectedAtMs: number | null;
  readonly error: string | null;
}

export interface HelperReply {
  readonly ack: AckEvent;
  /** Events that answered this request before its `ack` (such as `permissions`), in order. */
  readonly replies: readonly HelperEvent[];
}

export interface HelperClientService {
  readonly connection: SubscriptionRef.SubscriptionRef<HelperConnectionState>;
  /**
   * Every helper event in socket order; `ready` opens each session. Of the
   * `ack`s, only the one that ends a `snapshot` is published: it marks the end
   * of the replay. Bounded: a subscriber must keep taking, or it holds back
   * every other subscriber and, through the socket, the helper.
   */
  readonly events: PubSub.PubSub<HelperEvent>;
  /** Sends one control message and waits for its `ack` (10 s unless `timeoutMs` says otherwise). */
  request(
    message: HelperRequest,
    options?: { readonly timeoutMs?: number },
  ): Effect.Effect<HelperReply, HelperRequestError>;
  /** Events decoded but not yet taken by every subscriber. */
  readonly backlog: () => number;
  /** Events received so far, each published to `events` in order (a subscriber's target for "caught up"). */
  readonly received: () => number;
  /** Remembers Sondine's own PIDs and sends them now and on every reconnect. */
  setExcludedPids(pids: readonly number[]): Effect.Effect<void>;
  /**
   * Remembers which sources the user paused. Each connection pauses them
   * before `config`, so a fresh helper never opens a paused source, even for
   * the moment before core re-applies the intent.
   */
  setPausedSources(sources: PausedSources): Effect.Effect<void>;
  /**
   * The part of the capture policy private zones decide (ADR 029): the apps
   * left out and the holds. Sent with every `config`, and again at once when
   * it changes while connected. Set it before `run` starts so the first
   * `config` has it.
   */
  setZonePolicy(policy: ZonePolicy): Effect.Effect<void>;
  /** The connection loop; runs until interrupted. Started once every subscriber is in place. */
  readonly run: Effect.Effect<never>;
  /** Asks the helper to commit and close its runs, if connected. Never fails. */
  readonly shutdown: Effect.Effect<void>;
}

/** What private zones put in the helper's `config` (ADR 029): the apps left out, and the holds. */
export interface ZonePolicy {
  readonly excludedBundleIds: readonly string[];
  readonly holds: ConfigMessage["holds"];
}

export interface PausedSources {
  readonly microphone: boolean;
  readonly systemAudio: boolean;
}

/** The pause that brings `actual` to at least `wanted`, or null when nothing needs pausing. */
export function startupPauseScope(
  wanted: PausedSources,
  actual: PausedSources,
): "all" | "microphone" | "system-audio" | null {
  const microphone = wanted.microphone && !actual.microphone;
  const systemAudio = wanted.systemAudio && !actual.systemAudio;
  if (microphone && systemAudio) return "all";
  if (microphone) return "microphone";
  if (systemAudio) return "system-audio";
  return null;
}

export class HelperClient extends Context.Service<HelperClient, HelperClientService>()(
  "sondine/core/HelperClient",
) {}

export interface HelperClientOptions {
  readonly helloTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  /** Delay before reconnecting to a helper that speaks another protocol. */
  readonly incompatibleRetryMs?: number;
  readonly capture?: Omit<ConfigMessage, "id" | "type">;
  /**
   * Events held for subscribers before the socket stops reading (default
   * 256). Reading resumes once the backlog drains to a quarter of it.
   */
  readonly eventBuffer?: number;
}

/**
 * No private zone holds capture (ADR 029). An empty network key tells the
 * helper to read no network, so `situation.networks` stays empty.
 */
export const EMPTY_HOLDS: ConfigMessage["holds"] = {
  calls: false,
  screen: false,
  schedule: [],
  networks: [],
  networkKey: "",
  lifted: [],
};

/** The capture policy: the microphone, and a tap per app playing (ADR 026). */
export const defaultCaptureConfig: Omit<ConfigMessage, "id" | "type"> = {
  microphone: {
    enabled: true,
    followCalls: true,
    allowedTransports: ["built-in", "usb", "thunderbolt", "pci"],
  },
  systemAudio: {
    enabled: true,
    appTaps: { enabled: true, max: 8, releaseAfterIdleMs: 30_000, releaseAfterSilenceMs: 120_000 },
  },
  excludedBundleIds: [],
  holds: EMPTY_HOLDS,
  vad: { threshold: 0.5, minSpeechMs: 250, minSilenceMs: 800 },
  healthIntervalMs: 60_000,
};

interface PendingRequest {
  readonly answer: Deferred.Deferred<HelperEvent>;
  readonly replies: HelperEvent[];
}

interface Session {
  readonly socket: HelperSocket;
  readonly pending: Map<string, PendingRequest>;
  /** Ids of `snapshot` requests whose `ack` has not arrived (kept past a timeout). */
  readonly snapshots: Set<string>;
  readonly closed: Deferred.Deferred<string>;
  nextId: number;
}

const isTerminal = (event: HelperEvent) =>
  event.type === "ready" || event.type === "ack" || event.type === "error";

// Exponential from 250 ms, capped at 5 s, forever; reset after each connection.
const reconnectSchedule = Schedule.min([
  Schedule.exponential("250 millis"),
  Schedule.spaced("5 seconds"),
]);

export const makeHelperClient = (options: HelperClientOptions = {}) =>
  Effect.gen(function* () {
    const config = yield* CoreConfig;
    const helloTimeoutMs = options.helloTimeoutMs ?? 5_000;
    const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    const incompatibleRetryMs = options.incompatibleRetryMs ?? 30_000;
    const capture = options.capture ?? defaultCaptureConfig;
    const eventBuffer = options.eventBuffer ?? 256;
    const lowWater = Math.max(1, Math.floor(eventBuffer / 4));

    const connection = yield* SubscriptionRef.make<HelperConnectionState>({
      state: "connecting",
      ready: null,
      connectedAtMs: null,
      error: null,
    });
    // Backpressure without loss: decoded events wait in `inbox`, one fiber
    // publishes them to the bounded PubSub (suspending while a subscriber lags),
    // and the socket stops reading while the inbox holds `eventBuffer` events.
    // The inbox then holds at most that plus one socket read.
    const events = yield* PubSub.bounded<HelperEvent>(eventBuffer);
    yield* Effect.addFinalizer(() => PubSub.shutdown(events));
    const inbox = yield* Queue.unbounded<HelperEvent>();
    // Sockets of this and earlier sessions that stopped reading.
    const paused = new Set<HelperSocket>();
    yield* Queue.take(inbox).pipe(
      Effect.flatMap((event) => PubSub.publish(events, event)),
      Effect.andThen(
        Effect.sync(() => {
          if (paused.size > 0 && Queue.sizeUnsafe(inbox) <= lowWater) {
            for (const socket of paused) socket.resume();
            paused.clear();
          }
        }),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
    let received = 0;
    const current = yield* Ref.make<Session | null>(null);
    const excludedPids = yield* Ref.make<readonly number[] | null>(null);
    const pausedSources = yield* Ref.make<PausedSources>({ microphone: false, systemAudio: false });
    const zonePolicy = yield* Ref.make<ZonePolicy>({
      excludedBundleIds: [],
      holds: capture.holds,
    });
    const configMessage = (policy: ZonePolicy) => ({
      type: "config" as const,
      ...capture,
      excludedBundleIds: [...policy.excludedBundleIds],
      holds: policy.holds,
    });

    const route = (session: Session, event: HelperEvent) => {
      const replyTo = event.replyTo;
      const waiting = replyTo === undefined ? undefined : session.pending.get(replyTo);
      if (replyTo !== undefined && waiting !== undefined) {
        if (isTerminal(event)) {
          session.pending.delete(replyTo);
          Deferred.doneUnsafe(waiting.answer, Exit.succeed(event));
        } else {
          waiting.replies.push(event);
        }
      }
      if (event.type === "ack" && !(replyTo !== undefined && session.snapshots.delete(replyTo))) {
        return;
      }
      Queue.offerUnsafe(inbox, event);
      received += 1;
      if (!paused.has(session.socket) && Queue.sizeUnsafe(inbox) >= eventBuffer) {
        paused.add(session.socket);
        session.socket.pause();
      }
    };

    const connect = Effect.callback<Session, HelperUnavailable>((resume) => {
      const closed = Deferred.makeUnsafe<string>();
      let session: Session | undefined;
      const attempt = openHelperSocket(config.helperSocket, {
        onEvent: (event) => {
          if (session !== undefined) route(session, event);
        },
        onDecodeError: (error, line) =>
          log.warn("helper.decode", { line, kind: error.kind, message: error.message }),
        onClose: (error) => Deferred.doneUnsafe(closed, Exit.succeed(error?.message ?? "closed")),
      });
      attempt.connected.then(
        (socket) => {
          session = { socket, pending: new Map(), snapshots: new Set(), closed, nextId: 1 };
          resume(Effect.succeed(session));
        },
        (error: unknown) =>
          resume(
            Effect.fail(
              new HelperUnavailable({
                reason: error instanceof Error ? error.message : String(error),
              }),
            ),
          ),
      );
      return Effect.sync(attempt.cancel);
    });

    const send = (session: Session, message: WithoutId<ControlMessage>, timeoutMs: number) =>
      Effect.gen(function* () {
        const id = `c${session.nextId++}`;
        const reply = Deferred.makeUnsafe<HelperEvent>();
        const replies: HelperEvent[] = [];
        session.pending.set(id, { answer: reply, replies });
        if (message.type === "snapshot") session.snapshots.add(id);
        // The spread keeps the message's own type; the union is rebuilt with its id.
        const full = { ...message, id } as ControlMessage;
        yield* Effect.try({
          try: () => session.socket.send(full),
          catch: (error) =>
            new HelperRejected({
              request: message.type,
              code: "request.invalid",
              message: error instanceof Error ? error.message : String(error),
            }),
        });
        const answered = yield* Deferred.await(reply).pipe(
          Effect.raceFirst(
            Deferred.await(session.closed).pipe(
              Effect.flatMap((reason) => Effect.fail(new HelperUnavailable({ reason }))),
            ),
          ),
          Effect.timeoutOrElse({
            duration: `${timeoutMs} millis`,
            orElse: () => Effect.fail(new HelperTimeout({ request: message.type })),
          }),
          Effect.ensuring(Effect.sync(() => session.pending.delete(id))),
        );
        if (answered.type === "error") {
          return yield* new HelperRejected({
            request: message.type,
            code: answered.code,
            message: answered.message,
          });
        }
        return { answer: answered, replies };
      });

    const request = (message: HelperRequest, requestOptions?: { readonly timeoutMs?: number }) =>
      Effect.gen(function* () {
        const session = yield* Ref.get(current);
        if (session === null) {
          return yield* new HelperUnavailable({ reason: "not connected" });
        }
        const { answer, replies } = yield* send(
          session,
          message,
          requestOptions?.timeoutMs ?? requestTimeoutMs,
        );
        if (answer.type !== "ack") {
          return yield* new HelperRejected({
            request: message.type,
            code: "protocol.unexpected-reply",
            message: `expected ack, got ${answer.type}`,
          });
        }
        return { ack: answer, replies } satisfies HelperReply;
      }).pipe(Effect.withSpan("helper.request", { attributes: { type: message.type } }));

    const logged = (message: HelperRequest) =>
      request(message).pipe(
        Effect.catch((error) =>
          Effect.sync(() => log.warn("helper.setup", { request: message.type, error: error._tag })),
        ),
      );

    const session = Effect.gen(function* () {
      yield* SubscriptionRef.update(connection, (state): HelperConnectionState => ({
        ...state,
        state: "connecting",
      }));
      const opened = yield* Effect.acquireRelease(
        connect.pipe(
          Effect.tapError((error) =>
            SubscriptionRef.update(connection, (state): HelperConnectionState => ({
              ...state,
              state: "disconnected",
              ready: null,
              connectedAtMs: null,
              error: error.reason,
            })),
          ),
          Effect.retry(reconnectSchedule),
          // The schedule never ends, so the retry never gives up.
          Effect.orDie,
          // An acquire is uninterruptible: without this, closing core while
          // no helper answers waits for a connection that never comes.
          Effect.interruptible,
        ),
        (connected) => Effect.sync(() => connected.socket.close()),
      );

      const hello = yield* send(
        opened,
        {
          type: "hello",
          protocol: PROTOCOL_VERSION,
          client: { name: "sondine-core", version: config.appVersion },
        },
        helloTimeoutMs,
      ).pipe(Effect.result);
      if (hello._tag === "Failure" || hello.success.answer.type !== "ready") {
        const reason =
          hello._tag === "Failure"
            ? hello.failure._tag === "HelperRejected"
              ? `${hello.failure.code}: ${hello.failure.message}`
              : hello.failure._tag
            : `expected ready, got ${hello.success.answer.type}`;
        const incompatible = hello._tag === "Failure" && hello.failure._tag === "HelperRejected";
        const next: HelperConnectionState["state"] = incompatible ? "incompatible" : "disconnected";
        log.warn("helper.hello", { reason });
        yield* SubscriptionRef.set(connection, {
          state: next,
          ready: null,
          connectedAtMs: null,
          error: reason,
        });
        if (incompatible) yield* Effect.sleep(`${incompatibleRetryMs} millis`);
        return;
      }
      const ready = hello.success.answer;

      yield* Ref.set(current, opened);
      // Before `config`, which lets the helper open its sources.
      const pauseFirst = startupPauseScope(yield* Ref.get(pausedSources), ready.paused);
      if (pauseFirst !== null) yield* logged({ type: "pause", scope: pauseFirst });
      yield* SubscriptionRef.set(connection, {
        state: "connected",
        ready,
        connectedAtMs: Date.now(),
        error: null,
      });
      log.info("helper.connected", { sessionId: ready.sessionId, helper: ready.helper.version });

      yield* logged(configMessage(yield* Ref.get(zonePolicy)));
      const pids = yield* Ref.get(excludedPids);
      if (pids !== null) yield* logged({ type: "exclude.pids", pids: [...pids] });
      yield* logged({ type: "snapshot" });

      const reason = yield* Deferred.await(opened.closed);
      log.info("helper.disconnected", { reason });
      yield* Ref.set(current, null);
      // Waiting requests fail on their own: each one races the session's close.
      opened.pending.clear();
      yield* SubscriptionRef.set(connection, {
        state: "disconnected",
        ready: null,
        connectedAtMs: null,
        error: reason,
      });
    }).pipe(
      Effect.scoped,
      Effect.ensuring(Ref.set(current, null)),
      Effect.withSpan("helper.session"),
    );

    const run = session.pipe(Effect.andThen(Effect.sleep("250 millis")), Effect.forever);

    const setExcludedPids = (pids: readonly number[]) =>
      Effect.gen(function* () {
        const previous = yield* Ref.getAndSet(excludedPids, pids);
        const same =
          previous !== null &&
          previous.length === pids.length &&
          previous.every((pid, index) => pid === pids[index]);
        if (same) return;
        if ((yield* Ref.get(current)) !== null)
          yield* logged({ type: "exclude.pids", pids: [...pids] });
      });

    const setPausedSources = (sources: PausedSources) => Ref.set(pausedSources, { ...sources });

    const setZonePolicy = (policy: ZonePolicy) =>
      Effect.gen(function* () {
        const next = {
          excludedBundleIds: [...new Set(policy.excludedBundleIds)].toSorted(),
          holds: policy.holds,
        };
        const previous = yield* Ref.getAndSet(zonePolicy, next);
        if (JSON.stringify(previous) === JSON.stringify(next)) return;
        if ((yield* Ref.get(current)) !== null) yield* logged(configMessage(next));
      });

    const shutdown = request({ type: "shutdown" }).pipe(
      Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.void }),
      Effect.ignore,
    );

    return HelperClient.of({
      connection,
      events,
      request,
      backlog: () => Queue.sizeUnsafe(inbox) + PubSub.sizeUnsafe(events),
      received: () => received,
      setExcludedPids,
      setPausedSources,
      setZonePolicy,
      run,
      shutdown,
    });
  });

export const helperClientLayer = (options?: HelperClientOptions) =>
  Layer.effect(HelperClient, makeHelperClient(options));
