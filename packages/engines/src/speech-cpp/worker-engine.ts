import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { endianness, homedir } from "node:os";
import { createJsonLinesDecoder, type JsonLineResult } from "@sondine/protocol";
import {
  EngineError,
  type AsrCapabilities,
  type AsrEngine,
  type AsrRequest,
  type AsrResult,
  type AsrSegment,
  type EngineManifest,
  type EngineResources,
  type EngineState,
  type TranscribeOptions,
} from "../contract.ts";
import {
  ErrorMessage,
  FatalMessage,
  ProgressMessage,
  ReadyMessage,
  RecognitionEnd,
  RequestMessage,
  WorkerLine,
  describeWorkerError,
} from "./messages.ts";
import { recognitionFrom } from "./output.ts";
import { SPEECH_CPP_RUNTIME } from "./runtime.ts";

// A resident `speech worker` (speech.cpp, protocol 3) behind the AsrEngine
// contract (ADR 016 "Engines and the Nemotron worker"). One process at a
// time: a new one starts only after the previous one has exited. One request
// at a time. Messages for any other request id are dropped.

export interface SpeechWorkerDeadlines {
  /** Spawn to `ready` (load and GPU warmup). */
  readonly readyMs: number;
  /** A request may take `requestBaseMs + requestPerAudioSecondMs × audio seconds`. */
  readonly requestBaseMs: number;
  readonly requestPerAudioSecondMs: number;
  /** A cancel's answer, then SIGKILL. */
  readonly cancelMs: number;
  /** Added to `resources.unloadLatencyMs` before an unloading worker is killed. */
  readonly unloadGraceMs: number;
}

export const SPEECH_WORKER_DEADLINES: SpeechWorkerDeadlines = {
  readyMs: 180_000,
  requestBaseMs: 120_000,
  requestPerAudioSecondMs: 4_000,
  cancelMs: 10_000,
  unloadGraceMs: 10_000,
};

/** Audio goes in `chunk` lines of at most 10 s. */
export const CHUNK_SECONDS = 10;
const SAMPLE_RATE = 16_000;
/** An `end` for 55 min of speech carries every token; leave room. */
const MAX_STDOUT_LINE_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;

export interface SpeechWorkerExit {
  readonly pid: number;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The engine's state when the process ended: `ready` means it died while idle. */
  readonly during: EngineState;
  /** The engine asked for it: unload, cancel deadline, or a protocol defect. */
  readonly expected: boolean;
  readonly stderrTail: string;
}

/**
 * How a model's reported progress becomes a share of a request's time, for a
 * model whose steps take shares of `done` unlike their shares of the time.
 */
export interface ProgressShape {
  /** A request of `seconds` of audio starts. */
  start(seconds: number): RequestProgress;
}

export interface RequestProgress {
  report(done: number): number;
  /** The request ended with its text. */
  end(): void;
}

export interface SpeechWorkerEngineOptions {
  readonly manifest: EngineManifest;
  readonly capabilities: AsrCapabilities;
  readonly resources: EngineResources;
  /** The `speech` executable; packaged: `Contents/Helpers/Sondine Speech.app/Contents/MacOS/speech`. */
  readonly executable: string;
  /** Arguments before `worker`; tests run a Node script through `process.execPath`. */
  readonly executableArgs?: readonly string[];
  readonly weights: string;
  /** The verified sha256 of `weights`, for provenance. */
  readonly modelSha256: string;
  /** The release `ready` must report. */
  readonly runtimeVersion?: string;
  readonly device?: string;
  readonly threads?: number;
  readonly deadlines?: Partial<SpeechWorkerDeadlines>;
  /** Added to the worker's minimal environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Every exit of a worker process, expected or not, for core's log and supervision. */
  readonly onExit?: (exit: SpeechWorkerExit) => void;
  /**
   * Runs before every spawn, once the previous worker has exited; throwing
   * fails the load. The Nemotron engine checks that no other process runs
   * the speech binary (ADR 016: at most one worker exists).
   */
  readonly beforeSpawn?: () => Promise<void>;
  /** The model's progress as a share of time; as reported without it. */
  readonly progress?: ProgressShape;
  /** Corrects the model's word times and the segment bounds they give; as written without it. */
  readonly wordTimes?: (segments: readonly AsrSegment[], durationSec: number) => AsrSegment[];
}

interface Worker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pid: number;
  readonly closed: Promise<void>;
  readonly stderrTail: () => string;
  ready: boolean;
  /** SIGKILL sent: its remaining lines are not read. */
  killed: boolean;
  done: boolean;
  stdinOpen: boolean;
  expectedExit: boolean;
  killTimer: NodeJS.Timeout | null;
}

interface PendingLoad {
  readonly worker: Worker;
  readonly startedAt: number;
  readonly resolve: (value: { readonly loadMs: number }) => void;
  readonly reject: (error: EngineError) => void;
  readonly cleanup: () => void;
}

interface ActiveRequest {
  readonly worker: Worker;
  readonly request: AsrRequest;
  readonly durationSec: number;
  readonly startedAt: number;
  readonly onProgress: ((done: number) => void) | undefined;
  readonly progress: RequestProgress | null;
  readonly resolve: (result: AsrResult) => void;
  readonly reject: (error: EngineError) => void;
  /** Set once we asked the worker to stop; the request then fails with it. */
  stopping: EngineError | null;
  readonly timers: NodeJS.Timeout[];
  cleanupAbort: () => void;
}

function stderrRing(limit: number) {
  let tail = Buffer.alloc(0);
  return {
    push(chunk: Buffer) {
      const joined = Buffer.concat([tail, chunk]);
      tail = joined.byteLength > limit ? Buffer.from(joined.subarray(-limit)) : joined;
    },
    text: () => tail.toString("utf8"),
  };
}

const rejected = (message: string) => new EngineError("rejected", message);

const exitText = (code: number | null, signal: NodeJS.Signals | null) =>
  signal === null ? `exit ${code ?? "?"}` : `signal ${signal}`;

export function createSpeechWorkerEngine(options: SpeechWorkerEngineOptions): AsrEngine {
  // Int16Array views go to base64 as they are: the wire is little-endian.
  if (endianness() !== "LE") throw new Error("the speech worker client needs a little-endian host");
  const deadlines = { ...SPEECH_WORKER_DEADLINES, ...options.deadlines };
  const runtimeVersion = options.runtimeVersion ?? SPEECH_CPP_RUNTIME.version;
  const device = options.device ?? "gpu";
  const threads = options.threads ?? 4;
  const { capabilities, resources, manifest } = options;

  let state: EngineState = "absent";
  let worker: Worker | null = null;
  /** Resolves once the last process started has exited. */
  let previousExit: Promise<void> = Promise.resolve();
  let loadPromise: Promise<{ readonly loadMs: number }> | null = null;
  let pendingLoad: PendingLoad | null = null;
  let active: ActiveRequest | null = null;
  /** A transcribe call between its checks and its request (it may be loading). */
  let reserved = false;
  let unloadPromise: Promise<void> | null = null;
  /** Bumped by unload: a load still waiting to spawn gives up. */
  let epoch = 0;

  const withTail = (message: string, target: Worker | null) => {
    const tail = target?.stderrTail().trimEnd() ?? "";
    return tail === "" ? message : `${message}\n--- speech worker stderr (last 8 KiB) ---\n${tail}`;
  };

  function kill(target: Worker): void {
    target.expectedExit = true;
    if (target.done) return;
    target.killed = true;
    target.child.kill("SIGKILL");
    // Until 'close', the process still holds its memory.
    if (worker === target) state = "unloading";
  }

  /** What a worker was doing, for its exit report. */
  const phaseOf = (target: Worker): EngineState =>
    !target.ready
      ? "loading"
      : active?.worker === target
        ? "busy"
        : target.stdinOpen
          ? "ready"
          : "unloading";

  function killAfter(target: Worker, ms: number): void {
    if (target.killTimer !== null) clearTimeout(target.killTimer);
    target.killTimer = setTimeout(() => kill(target), ms);
  }

  function closeStdin(target: Worker): void {
    if (!target.stdinOpen) return;
    target.stdinOpen = false;
    target.child.stdin.end();
  }

  /** Writes one line; false when the worker can no longer take it. Waits out backpressure. */
  function writeLine(target: Worker, message: object): Promise<boolean> {
    if (target.done || !target.stdinOpen) return Promise.resolve(false);
    const stdin = target.child.stdin;
    if (stdin.write(`${JSON.stringify(message)}\n`)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const settle = (value: boolean) => {
        stdin.off("drain", onDrain);
        stdin.off("close", onStdinClose);
        resolve(value);
      };
      const onDrain = () => settle(true);
      const onStdinClose = () => settle(false);
      stdin.once("drain", onDrain);
      stdin.once("close", onStdinClose);
    });
  }

  function failLoad(error: EngineError): void {
    const pending = pendingLoad;
    if (pending === null) return;
    pendingLoad = null;
    pending.cleanup();
    pending.reject(error);
  }

  function finishRequest(request: ActiveRequest, outcome: AsrResult | EngineError): void {
    if (active !== request) return;
    active = null;
    for (const timer of request.timers) clearTimeout(timer);
    request.cleanupAbort();
    if (state === "busy") state = "ready";
    if (outcome instanceof EngineError) request.reject(outcome);
    else request.resolve(outcome);
  }

  /** Asks the worker to stop the request; SIGKILL if it has not answered within the cancel deadline. */
  function stopRequest(request: ActiveRequest, reason: EngineError): void {
    if (active !== request || request.stopping !== null) return;
    request.stopping = reason;
    void writeLine(request.worker, { type: "cancel", id: request.request.id });
    request.timers.push(setTimeout(() => kill(request.worker), deadlines.cancelMs));
  }

  /** A line the protocol does not allow: the worker's state is unknown, so it goes. */
  function protocolFailure(target: Worker, message: string): void {
    const error = new EngineError("protocol", withTail(message, target));
    kill(target);
    if (pendingLoad?.worker === target) failLoad(error);
    if (active?.worker === target) finishRequest(active, error);
  }

  function onReady(target: Worker, line: WorkerLine): void {
    const ready = ReadyMessage.safeParse(line);
    if (!ready.success || target.ready || pendingLoad?.worker !== target) {
      protocolFailure(target, "unexpected or malformed ready");
      return;
    }
    if (ready.data.protocol !== SPEECH_CPP_RUNTIME.workerProtocol) {
      protocolFailure(
        target,
        `the worker speaks protocol ${ready.data.protocol}; this client speaks ${SPEECH_CPP_RUNTIME.workerProtocol}`,
      );
      return;
    }
    if (ready.data.version !== runtimeVersion) {
      const error = new EngineError(
        "load_failed",
        `the worker is speech.cpp ${ready.data.version}; expected ${runtimeVersion}`,
      );
      kill(target);
      failLoad(error);
      return;
    }
    const pending = pendingLoad;
    if (pending === null) return;
    target.ready = true;
    state = "ready";
    pendingLoad = null;
    pending.cleanup();
    pending.resolve({ loadMs: Math.round(performance.now() - pending.startedAt) });
  }

  function onFatal(target: Worker, line: WorkerLine): void {
    const fatal = FatalMessage.safeParse(line);
    if (!fatal.success || pendingLoad?.worker !== target) {
      protocolFailure(target, "unexpected or malformed fatal");
      return;
    }
    // The worker exits on its own after `fatal`; make sure it does.
    killAfter(target, deadlines.cancelMs);
    target.expectedExit = true;
    failLoad(
      new EngineError(
        "load_failed",
        withTail(`the worker could not start: ${describeWorkerError(fatal.data.error)}`, target),
      ),
    );
  }

  /** The active request when `line` belongs to it; undefined drops the line. */
  function requestFor(target: Worker, line: WorkerLine): ActiveRequest | undefined {
    const parsed = RequestMessage.safeParse(line);
    if (!parsed.success || active?.worker !== target) return undefined;
    return parsed.data.id === active.request.id ? active : undefined;
  }

  function onRequestLine(target: Worker, line: WorkerLine): void {
    if (line.type === "error") {
      const error = ErrorMessage.safeParse(line);
      if (!error.success) {
        protocolFailure(target, "malformed error");
        return;
      }
      if (error.data.id == null) {
        protocolFailure(
          target,
          `the worker refused a line we sent: ${describeWorkerError(error.data.error)}`,
        );
        return;
      }
    }
    const request = requestFor(target, line);
    if (request === undefined) return;
    switch (line.type) {
      case "progress": {
        const progress = ProgressMessage.safeParse(line);
        if (!progress.success || !Number.isFinite(progress.data.done)) {
          protocolFailure(target, "malformed progress");
          return;
        }
        const done = Math.min(1, Math.max(0, progress.data.done));
        request.onProgress?.(request.progress === null ? done : request.progress.report(done));
        return;
      }
      case "cancelled":
        finishRequest(
          request,
          request.stopping ?? new EngineError("cancelled", "the worker cancelled the request"),
        );
        return;
      case "error": {
        const error = ErrorMessage.parse(line);
        finishRequest(
          request,
          request.stopping ??
            new EngineError(
              "rejected",
              withTail(
                `the worker refused the request: ${describeWorkerError(error.error)}`,
                target,
              ),
            ),
        );
        return;
      }
      case "end": {
        if (request.stopping !== null) {
          finishRequest(request, request.stopping);
          return;
        }
        const end = RecognitionEnd.safeParse(line);
        if (!end.success) {
          finishRequest(
            request,
            new EngineError("invalid_output", `malformed end: ${end.error.message}`, {
              reason: "malformed-end",
            }),
          );
          return;
        }
        try {
          const result = resultFrom(request, end.data);
          request.progress?.end();
          finishRequest(request, result);
        } catch (error) {
          finishRequest(
            request,
            error instanceof EngineError
              ? error
              : new EngineError("invalid_output", String(error), {
                  cause: error,
                  reason: "unmappable",
                }),
          );
        }
        return;
      }
    }
  }

  function onLine(target: Worker, result: JsonLineResult<WorkerLine>): void {
    if (worker !== target || target.done || target.killed) return;
    if (!result.ok) {
      protocolFailure(
        target,
        `stdout line ${result.line} is not a protocol message (${result.error.kind}: ${result.error.message})`,
      );
      return;
    }
    const line = result.value;
    switch (line.type) {
      case "ready":
        onReady(target, line);
        return;
      case "fatal":
        onFatal(target, line);
        return;
      case "progress":
      case "end":
      case "error":
      case "cancelled":
        onRequestLine(target, line);
        return;
      default:
        // A message added after protocol 3 does not concern this client.
        return;
    }
  }

  function onClose(target: Worker, code: number | null, signal: NodeJS.Signals | null): void {
    if (target.done) return;
    const during = phaseOf(target);
    target.done = true;
    target.stdinOpen = false;
    if (target.killTimer !== null) clearTimeout(target.killTimer);
    const how = exitText(code, signal);
    if (worker === target) {
      worker = null;
      state = "absent";
    }
    if (pendingLoad?.worker === target) {
      failLoad(
        new EngineError("load_failed", withTail(`the worker exited (${how}) before ready`, target)),
      );
    }
    if (active?.worker === target) {
      finishRequest(
        active,
        active.stopping ??
          new EngineError(
            "crashed",
            withTail(`the worker exited (${how}) during request ${active.request.id}`, target),
          ),
      );
    }
    options.onExit?.({
      pid: target.pid,
      code,
      signal,
      during,
      expected: target.expectedExit,
      stderrTail: target.stderrTail(),
    });
  }

  function spawnWorker(): Worker | EngineError {
    const args = [
      ...(options.executableArgs ?? []),
      "worker",
      options.weights,
      "--device",
      device,
      "--threads",
      String(threads),
    ];
    const child = spawn(options.executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      // A minimal environment: speech.cpp's update check stays off, even
      // where the sandbox would not stop it (development builds).
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: process.env.HOME ?? homedir(),
        ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
        SPEECH_NO_UPDATE_CHECK: "1",
        ...options.env,
      },
    });
    if (child.pid === undefined) {
      // The spawn failed; 'error' follows. Keep it from going unhandled.
      child.once("error", () => undefined);
      return new EngineError("load_failed", `cannot start ${options.executable}`);
    }
    const stderr = stderrRing(STDERR_TAIL_BYTES);
    const closed = Promise.withResolvers<void>();
    const target: Worker = {
      child,
      pid: child.pid,
      closed: closed.promise,
      stderrTail: stderr.text,
      ready: false,
      killed: false,
      done: false,
      stdinOpen: true,
      expectedExit: false,
      killTimer: null,
    };
    const decoder = createJsonLinesDecoder(WorkerLine, { maxLineBytes: MAX_STDOUT_LINE_BYTES });
    child.stdout.on("data", (chunk: Buffer) => {
      for (const result of decoder.push(chunk)) onLine(target, result);
    });
    child.stdout.on("end", () => {
      // A line cut short by the exit is the exit's to report.
      for (const result of decoder.end()) if (result.ok) onLine(target, result);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    // EPIPE once the worker is gone; 'close' reports the exit.
    child.stdin.on("error", () => {
      target.stdinOpen = false;
    });
    // After a successful spawn, 'error' only reports a failed kill; 'close' still comes.
    child.on("error", () => undefined);
    child.on("close", (code, signal) => {
      onClose(target, code, signal);
      closed.resolve();
    });
    return target;
  }

  async function startLoad(signal: AbortSignal | undefined): Promise<{ readonly loadMs: number }> {
    const startEpoch = epoch;
    const giveUp = () => {
      if (signal?.aborted === true) throw new EngineError("cancelled", "the load was cancelled");
      if (epoch !== startEpoch)
        throw new EngineError("cancelled", "the engine unloaded while loading");
    };
    await previousExit;
    giveUp();
    try {
      await access(options.executable, constants.X_OK);
    } catch {
      throw new EngineError("load_failed", `no speech executable at ${options.executable}`);
    }
    // speech.cpp takes a missing file for a model name to fetch: never let it try.
    try {
      await access(options.weights, constants.R_OK);
    } catch {
      throw new EngineError("load_failed", `no readable weights at ${options.weights}`);
    }
    giveUp();
    if (options.beforeSpawn !== undefined) {
      try {
        await options.beforeSpawn();
      } catch (error) {
        throw error instanceof EngineError
          ? error
          : new EngineError("load_failed", "the check before spawning failed", { cause: error });
      }
      giveUp();
    }
    const spawned = spawnWorker();
    if (spawned instanceof EngineError) throw spawned;
    worker = spawned;
    previousExit = spawned.closed;
    state = "loading";
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        failLoad(new EngineError("cancelled", "the load was cancelled"));
        kill(spawned);
      };
      const timer = setTimeout(() => {
        failLoad(
          new EngineError("deadline", withTail(`no ready within ${deadlines.readyMs} ms`, spawned)),
        );
        kill(spawned);
      }, deadlines.readyMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      pendingLoad = {
        worker: spawned,
        startedAt: performance.now(),
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
      };
    });
  }

  function load(signal?: AbortSignal): Promise<{ readonly loadMs: number }> {
    if (state === "ready" || state === "busy") return Promise.resolve({ loadMs: 0 });
    if (loadPromise !== null) return loadPromise;
    const started = startLoad(signal);
    loadPromise = started;
    const clear = () => {
      if (loadPromise === started) loadPromise = null;
    };
    started.then(clear, clear);
    return started;
  }

  function checkRequest(request: AsrRequest): void {
    if (request.id === "") throw rejected("a request needs an id");
    if (request.sampleRate !== SAMPLE_RATE) throw rejected(`audio must be ${SAMPLE_RATE} Hz`);
    if (request.samples.length === 0) throw rejected("the request has no audio");
    const seconds = request.samples.length / SAMPLE_RATE;
    if (seconds > capabilities.maxRequestSeconds) {
      throw rejected(
        `${seconds} s of audio; one request takes at most ${capabilities.maxRequestSeconds} s`,
      );
    }
    if (request.language !== undefined && !capabilities.languages.includes(request.language)) {
      throw rejected(`language "${request.language}" is not one the engine takes`);
    }
    if (request.speakers && !capabilities.nativeSpeakers)
      throw rejected("the engine gives no speakers");
    if (request.timestamps && !capabilities.wordTimestamps) {
      throw rejected("the engine gives no timestamps");
    }
  }

  function resultFrom(request: ActiveRequest, end: RecognitionEnd): AsrResult {
    const { request: asked } = request;
    const recognition = recognitionFrom(end, {
      durationSec: request.durationSec,
      timestamps: asked.timestamps,
      speakers: asked.speakers,
    });
    const segments =
      options.wordTimes === undefined || !asked.timestamps
        ? recognition.segments
        : options.wordTimes(recognition.segments, request.durationSec);
    return {
      requestId: asked.id,
      ...recognition,
      segments,
      provenance: {
        engineId: manifest.id,
        engineVersion: manifest.version,
        runtime: manifest.runtime,
        adapterClass: manifest.adapterClass,
        modelSha256: options.modelSha256,
        config: {
          device,
          threads,
          timestamps: asked.timestamps,
          speakers: asked.speakers,
          language: asked.language ?? "auto",
        },
      },
      metrics: {
        audioMs: Math.round((asked.samples.length * 1000) / SAMPLE_RATE),
        computeMs: Math.round(performance.now() - request.startedAt),
      },
    };
  }

  async function sendAudio(request: ActiveRequest): Promise<void> {
    const { samples, id } = request.request;
    const step = CHUNK_SECONDS * SAMPLE_RATE;
    for (let seq = 0, offset = 0; offset < samples.length; seq += 1, offset += step) {
      if (active !== request || request.stopping !== null) return;
      const slice = samples.subarray(offset, offset + step);
      const pcm = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString("base64");
      if (!(await writeLine(request.worker, { type: "chunk", id, seq, pcm }))) return;
    }
    if (active !== request || request.stopping !== null) return;
    const { timestamps, speakers, language } = request.request;
    await writeLine(request.worker, {
      type: "transcribe",
      id,
      sample_rate: SAMPLE_RATE,
      timestamps,
      speakers,
      ...(language === undefined ? {} : { language }),
    });
  }

  function runRequest(
    target: Worker,
    request: AsrRequest,
    opts: TranscribeOptions,
  ): Promise<AsrResult> {
    return new Promise((resolve, reject) => {
      const durationSec = request.samples.length / SAMPLE_RATE;
      const current: ActiveRequest = {
        worker: target,
        request,
        durationSec,
        startedAt: performance.now(),
        onProgress: opts.onProgress,
        progress: options.progress?.start(durationSec) ?? null,
        resolve,
        reject,
        stopping: null,
        timers: [],
        cleanupAbort: () => undefined,
      };
      active = current;
      state = "busy";
      const deadlineMs = deadlines.requestBaseMs + deadlines.requestPerAudioSecondMs * durationSec;
      current.timers.push(
        setTimeout(
          () =>
            stopRequest(
              current,
              new EngineError(
                "deadline",
                `request ${request.id} took more than ${Math.round(deadlineMs)} ms`,
              ),
            ),
          deadlineMs,
        ),
      );
      const signal = opts.signal;
      if (signal !== undefined) {
        const onAbort = () =>
          stopRequest(current, new EngineError("cancelled", `request ${request.id} was cancelled`));
        signal.addEventListener("abort", onAbort, { once: true });
        current.cleanupAbort = () => signal.removeEventListener("abort", onAbort);
      }
      sendAudio(current).catch((error: unknown) => {
        kill(target);
        finishRequest(
          current,
          new EngineError("crashed", `sending audio to the worker failed: ${String(error)}`, {
            cause: error,
          }),
        );
      });
    });
  }

  async function transcribe(request: AsrRequest, opts: TranscribeOptions = {}): Promise<AsrResult> {
    checkRequest(request);
    if (active !== null || reserved) {
      throw new EngineError("rejected", "the engine runs one request at a time");
    }
    reserved = true;
    const checkAborted = () => {
      if (opts.signal?.aborted === true) {
        throw new EngineError("cancelled", `request ${request.id} was cancelled`);
      }
    };
    try {
      checkAborted();
      await load(opts.signal);
      checkAborted();
      const target = worker;
      if (target === null || !target.ready || state !== "ready") {
        throw new EngineError("cancelled", "the worker unloaded before the request started");
      }
      reserved = false;
      return await runRequest(target, request, opts);
    } finally {
      reserved = false;
    }
  }

  function unload(): Promise<void> {
    if (unloadPromise !== null) return unloadPromise;
    epoch += 1;
    // A load() right after this call must start afresh, not get the cancelled one.
    loadPromise = null;
    const target = worker;
    if (target === null) {
      // A load between its checks and its spawn fails on its own; wait for any exit.
      return previousExit;
    }
    target.expectedExit = true;
    if (!target.ready) {
      // Loading cannot stop halfway: nothing to save.
      failLoad(new EngineError("cancelled", "the engine unloaded while loading"));
      kill(target);
    } else {
      let killMs = resources.unloadLatencyMs + deadlines.unloadGraceMs;
      if (active?.worker === target) {
        stopRequest(active, new EngineError("cancelled", "the engine unloaded"));
        killMs += deadlines.cancelMs;
      }
      state = "unloading";
      // On stdin EOF the worker answers what it has, then exits 0.
      closeStdin(target);
      killAfter(target, killMs);
    }
    const done = target.closed.then(() => {
      if (unloadPromise === done) unloadPromise = null;
    });
    unloadPromise = done;
    return done;
  }

  return {
    manifest,
    capabilities,
    resources,
    state: () => state,
    pid: () => (worker === null || worker.done ? undefined : worker.pid),
    load,
    transcribe,
    unload,
  };
}
