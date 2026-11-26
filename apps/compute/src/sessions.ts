import { randomBytes } from "node:crypto";
import { EngineError, type AsrEngine, type AsrResult } from "@sondine/engines";
import {
  CHUNK_BYTES,
  CHUNK_LABEL,
  Command,
  COMMAND_LABEL,
  FailureReason,
  FIRST_COMMAND,
  MAX_MISSING,
  STATE_LABEL,
  type AsrJob,
  type Channel,
  type SessionState,
} from "@sondine/engines/remote";

// The requests a server holds, in memory only: their audio as it arrives, one
// at a time on the engine, taking turns between clients, and the result until
// its client has it. Everything of a session is dropped with it.

export interface SessionLimits {
  /** Audio held at once, over every session. */
  readonly maxBytes: number;
  readonly maxSessions: number;
  readonly maxPerClient: number;
  /** An upload that stopped, a client that asks nothing more. */
  readonly idleMs: number;
  /** A result nobody fetched, whoever keeps asking. */
  readonly keepResultMs: number;
  /** The longest any session lives, whatever its client does. */
  readonly maxAgeMs: number;
  /** The engine lets go of the GPU after this long without work; `Infinity` keeps it. */
  readonly unloadMs: number;
}

export const defaultLimits: SessionLimits = {
  maxBytes: 1.5 * 1024 ** 3,
  maxSessions: 30,
  maxPerClient: 2,
  idleMs: 10 * 60_000,
  keepResultMs: 10 * 60_000,
  maxAgeMs: 6 * 3_600_000,
  unloadMs: 180_000,
};

interface Session {
  readonly id: string;
  readonly clientId: string;
  readonly channel: Channel;
  readonly job: AsrJob;
  readonly bytes: number;
  readonly chunkCount: number;
  chunks: (Buffer | null)[];
  received: number;
  state: SessionState;
  /** Of the last thing its client did, or its result: idle counts from here. */
  touchedAt: number;
  readonly openedAt: number;
  settledAt: number | null;
  counter: bigint;
  /** The last command's counter: an older one is a replay. */
  command: bigint;
  readonly cancel: AbortController;
  readonly waiting: Set<() => void>;
}

export type ServerLog = (event: string, fields?: Readonly<Record<string, string | number>>) => void;

export interface SessionsOptions {
  readonly engine: AsrEngine;
  readonly limits?: Partial<SessionLimits>;
  readonly log?: ServerLog;
  readonly now?: () => number;
  /** Whether a client may still use the server; a removed one's sessions go. */
  readonly known?: (clientId: string) => boolean;
  /** A request ended with its result: its client's seconds. */
  readonly onTranscribed?: (clientId: string, seconds: number) => void;
}

export class Sessions {
  private readonly sessions = new Map<string, Session>();
  private readonly limits: SessionLimits;
  private readonly now: () => number;
  private readonly log: ServerLog;
  /** Each client's last turn on the engine. */
  private readonly served = new Map<string, number>();
  private turns = 0;
  private current: Session | null = null;
  private unloadTimer: NodeJS.Timeout | null = null;
  private readonly sweeper: NodeJS.Timeout;
  private readonly options: SessionsOptions;

  constructor(options: SessionsOptions) {
    this.options = options;
    this.limits = { ...defaultLimits, ...options.limits };
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.sweeper = setInterval(() => this.sweep(), 5_000);
    this.sweeper.unref();
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Whether one more request of `bytes` fits. */
  hasRoom(clientId: string, bytes: number): boolean {
    let held = bytes;
    let own = 0;
    for (const session of this.sessions.values()) {
      held += session.bytes;
      if (session.clientId === clientId) own += 1;
    }
    return (
      this.sessions.size < this.limits.maxSessions &&
      own < this.limits.maxPerClient &&
      held <= this.limits.maxBytes
    );
  }

  /** Seconds a client has asked for and not been charged for yet. */
  pendingSeconds(clientId: string): number {
    let seconds = 0;
    for (const session of this.sessions.values()) {
      const charged = session.state.state === "done" || session.state.state === "failed";
      if (session.clientId === clientId && !charged) seconds += session.job.samples / 16_000;
    }
    return seconds;
  }

  newId(): string {
    return randomBytes(16).toString("hex");
  }

  add(id: string, clientId: string, channel: Channel, job: AsrJob): void {
    const bytes = job.samples * 2;
    const chunkCount = Math.ceil(bytes / CHUNK_BYTES);
    this.sessions.set(id, {
      id,
      clientId,
      channel,
      job,
      bytes,
      chunkCount,
      chunks: Array.from({ length: chunkCount }, () => null),
      received: 0,
      state: { state: "uploading", missing: [] },
      touchedAt: this.now(),
      openedAt: this.now(),
      settledAt: null,
      counter: 0n,
      command: FIRST_COMMAND - 1n,
      cancel: new AbortController(),
      waiting: new Set(),
    });
  }

  /** Whether a session exists and its client is still allowed. */
  has(id: string): boolean {
    const session = this.sessions.get(id);
    if (session === undefined) return false;
    if (this.options.known?.(session.clientId) !== false) return true;
    this.drop(id);
    return false;
  }

  /** One chunk; false when it is not one of this session's. The same chunk again is fine. */
  receive(id: string, index: number, sealed: Buffer): boolean {
    const session = this.sessions.get(id);
    if (session === undefined || index >= session.chunkCount) return false;
    // The last chunk's answer was lost: the client sends it again.
    if (session.state.state !== "uploading") return true;
    const last = session.chunkCount - 1;
    const plain = session.channel.toServer.open(BigInt(index), sealed, CHUNK_LABEL);
    const expected = index === last ? session.bytes - last * CHUNK_BYTES : CHUNK_BYTES;
    if (plain.length !== expected) return false;
    session.touchedAt = this.now();
    if (session.chunks[index] === null) {
      session.chunks[index] = plain;
      session.received += 1;
    }
    if (session.received < session.chunkCount) {
      this.setState(session, { state: "uploading", missing: missingOf(session) });
      return true;
    }
    this.setState(session, { state: "queued", ahead: 0 });
    this.countAhead();
    void this.next();
    return true;
  }

  /** What its client asks, read only from its sealed command; null when it is not one. */
  command(id: string, body: Buffer): Command["command"] | null {
    const session = this.sessions.get(id);
    if (session === undefined || body.length < 8) return null;
    const counter = body.readBigUInt64BE(0);
    // A command sent again, or a chunk's counter: not the client's next word.
    if (counter <= session.command) return null;
    const plain = session.channel.toServer.open(counter, body.subarray(8), COMMAND_LABEL);
    session.command = counter;
    const parsed = Command.safeParse(JSON.parse(plain.toString("utf8")));
    return parsed.success ? parsed.data.command : null;
  }

  /** The sealed state, once it changes or after `holdMs`; null when the session is gone. */
  async state(id: string, holdMs: number, gone: AbortSignal): Promise<Buffer | null> {
    const session = this.sessions.get(id);
    if (session === undefined) return null;
    session.touchedAt = this.now();
    if (session.state.state === "uploading") {
      session.state = { state: "uploading", missing: missingOf(session) };
    }
    const settled = () => session.state.state === "done" || session.state.state === "failed";
    // Asked while chunks are missing: the client sends those, nothing to wait for.
    if (!settled() && session.state.state !== "uploading" && holdMs > 0) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          session.waiting.delete(finish);
          gone.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, holdMs);
        session.waiting.add(finish);
        gone.addEventListener("abort", finish, { once: true });
      });
    }
    if (!this.sessions.has(id)) return null;
    session.touchedAt = this.now();
    const counter = session.counter++;
    const head = Buffer.alloc(8);
    head.writeBigUInt64BE(counter);
    return Buffer.concat([
      head,
      session.channel.toClient.seal(
        counter,
        Buffer.from(JSON.stringify(session.state)),
        STATE_LABEL,
      ),
    ]);
  }

  /** Forgets a session: cancelled, or its result arrived. */
  drop(id: string): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    this.sessions.delete(id);
    session.cancel.abort();
    for (const chunk of session.chunks) chunk?.fill(0);
    session.chunks = [];
    session.state = { state: "uploading", missing: [] };
    session.channel.toServer.wipe();
    session.channel.toClient.wipe();
    for (const wake of session.waiting) wake();
    this.countAhead();
  }

  dropClient(clientId: string): void {
    for (const session of this.sessions.values()) {
      if (session.clientId === clientId) this.drop(session.id);
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.sweeper);
    if (this.unloadTimer !== null) clearTimeout(this.unloadTimer);
    for (const id of this.sessions.keys()) this.drop(id);
    await this.options.engine.unload();
  }

  private queued(): Session[] {
    return [...this.sessions.values()].filter(({ state }) => state.state === "queued");
  }

  /** The client served longest ago goes first; its own requests in their order. */
  private inTurn(): Session[] {
    const queued = this.queued();
    return queued.toSorted(
      (a, b) => (this.served.get(a.clientId) ?? 0) - (this.served.get(b.clientId) ?? 0),
    );
  }

  private countAhead(): void {
    const running = this.current === null ? 0 : 1;
    this.inTurn().forEach((session, index) => {
      const ahead = index + running;
      if (session.state.state === "queued" && session.state.ahead !== ahead) {
        this.setState(session, { state: "queued", ahead });
      }
    });
  }

  private async next(): Promise<void> {
    if (this.current !== null) return;
    const session = this.inTurn().find(({ id }) => this.has(id));
    if (session === undefined) return;
    this.current = session;
    this.served.set(session.clientId, ++this.turns);
    if (this.unloadTimer !== null) clearTimeout(this.unloadTimer);
    this.unloadTimer = null;
    this.setState(session, { state: "running", progress: 0 });
    this.countAhead();
    try {
      await this.transcribe(session);
    } finally {
      this.current = null;
      this.countAhead();
      const { engine } = this.options;
      // Node fires a timer of Infinity at once: a model kept loaded has none.
      if (Number.isFinite(this.limits.unloadMs)) {
        this.unloadTimer = setTimeout(() => {
          if (this.current === null) void engine.unload().catch(() => undefined);
        }, this.limits.unloadMs);
        this.unloadTimer.unref();
      }
      void this.next();
    }
  }

  private async transcribe(session: Session): Promise<void> {
    const { job } = session;
    const samples = new Int16Array(job.samples);
    const bytes = new Uint8Array(samples.buffer);
    session.chunks.forEach((chunk, index) => {
      if (chunk === null) return;
      bytes.set(chunk, index * CHUNK_BYTES);
      chunk.fill(0);
    });
    session.chunks = [];
    try {
      const result = await this.options.engine.transcribe(
        {
          id: session.id,
          samples,
          sampleRate: 16_000,
          speakers: job.speakers,
          timestamps: job.timestamps,
          ...(job.language === undefined ? {} : { language: job.language }),
        },
        {
          signal: session.cancel.signal,
          onProgress: (done) => {
            const progress = Math.min(1, Math.max(0, done));
            if (session.state.state !== "running") return;
            // A poll waits for a change worth showing.
            if (progress - session.state.progress >= 0.01) {
              this.setState(session, { state: "running", progress });
            }
          },
        },
      );
      if (!this.sessions.has(session.id)) return;
      // Audio the model heard to its end is charged; a cut one goes again in halves.
      if (result.stop === "complete") {
        this.options.onTranscribed?.(session.clientId, job.samples / 16_000);
      }
      this.setState(session, { state: "done", result: remoteResult(result) });
      this.log("transcribed");
    } catch (error) {
      if (!this.sessions.has(session.id)) return;
      const code = error instanceof EngineError ? error.code : "internal";
      const own = code === "invalid_output" || code === "rejected";
      const reason = reasonOf(error);
      this.setState(session, { state: "failed", code: own ? code : "failed", reason });
      // A fixed code (`untimed`…), never the engine's message, which may quote its text.
      this.log("failed", reason === null ? { code } : { code, reason });
    } finally {
      samples.fill(0);
      session.touchedAt = this.now();
      session.settledAt = this.now();
    }
  }

  private setState(session: Session, state: SessionState): void {
    session.state = state;
    for (const wake of session.waiting) wake();
  }

  private sweep(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      const { idleMs, keepResultMs, maxAgeMs } = this.limits;
      // Queued or running too: a client that stopped asking does not want it any more.
      const over =
        now - session.touchedAt > idleMs ||
        now - session.openedAt > maxAgeMs ||
        (session.settledAt !== null && now - session.settledAt > keepResultMs) ||
        this.options.known?.(session.clientId) === false;
      if (over) {
        this.drop(session.id);
        this.log("expired");
      }
    }
  }
}

function missingOf(session: Session): number[] {
  const missing: number[] = [];
  session.chunks.forEach((chunk, index) => {
    if (chunk === null && missing.length < MAX_MISSING) missing.push(index);
  });
  return missing;
}

function reasonOf(error: unknown) {
  const reason = FailureReason.safeParse(error instanceof EngineError ? error.reason : undefined);
  return reason.success ? reason.data : null;
}

function remoteResult(result: AsrResult) {
  return {
    text: result.text,
    stop: result.stop,
    segments: result.segments.map((segment) => ({
      startSec: segment.startSec,
      endSec: segment.endSec,
      text: segment.text,
      speaker: segment.speaker,
      tokens: segment.tokens.map(({ startSec, endSec, text }) => ({ startSec, endSec, text })),
    })),
    languages: [...result.languages],
    runtime: result.provenance.runtime,
    computeMs: result.metrics.computeMs,
  };
}
