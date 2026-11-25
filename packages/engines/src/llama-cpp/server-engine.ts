import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, rm } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import * as z from "zod";
import {
  EngineError,
  type EngineManifest,
  type EngineResources,
  type EngineState,
  type GenerateOptions,
  type TextCapabilities,
  type TextEngine,
  type TextRequest,
  type TextResult,
} from "../contract.ts";

// A resident `llama-server` (llama.cpp) behind the TextEngine contract (ADR
// 028). It listens on a Unix socket, never a TCP port; core speaks HTTP to
// it there. One process at a time, one request at a time, one slot. The
// output is constrained to the request's JSON schema (the server turns it
// into a grammar). Never passes a download or tunnel option (`-hf`,
// `--connect`); the packaged helper's sandbox refuses the network anyway.

export interface LlamaServerDeadlines {
  /** Spawn to a healthy server (load and GPU warmup). */
  readonly readyMs: number;
  /** One request, prompt and output. */
  readonly requestMs: number;
  /** After SIGTERM, before SIGKILL. */
  readonly unloadGraceMs: number;
  /** How often `/health` is asked while loading. */
  readonly healthPollMs: number;
}

export const LLAMA_SERVER_DEADLINES: LlamaServerDeadlines = {
  readyMs: 180_000,
  requestMs: 600_000,
  unloadGraceMs: 10_000,
  healthPollMs: 250,
};

const STDERR_TAIL_BYTES = 8 * 1024;
/** An answer larger than this is not one the schema allows. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface LlamaServerExit {
  readonly pid: number;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly during: EngineState;
  /** The engine asked for it (unload, a deadline). */
  readonly expected: boolean;
  readonly stderrTail: string;
}

export interface LlamaServerEngineOptions {
  readonly manifest: EngineManifest;
  readonly capabilities: TextCapabilities;
  readonly resources: EngineResources;
  /** `llama-server`; packaged: `Contents/Helpers/Sondine Text.app/Contents/MacOS/llama-server`. */
  readonly executable: string;
  /** Arguments before the server's own; tests run a Node script through `process.execPath`. */
  readonly executableArgs?: readonly string[];
  readonly weights: string;
  /** The verified sha256 of `weights`, for provenance. */
  readonly modelSha256: string;
  /** Where the server listens; must end in `.sock`, at most 103 bytes. */
  readonly socketPath: string;
  readonly threads?: number;
  readonly deadlines?: Partial<LlamaServerDeadlines>;
  /** Added to the server's minimal environment. */
  readonly env?: Readonly<Record<string, string>>;
  readonly onExit?: (exit: LlamaServerExit) => void;
  /** Runs before every spawn, once the previous server has exited; throwing fails the load. */
  readonly beforeSpawn?: () => Promise<void>;
}

/** The server's answer to `/v1/chat/completions` when streaming, one `data:` line at a time. */
const StreamChunk = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        delta: z.looseObject({ content: z.string().nullish() }).nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .nullish(),
  timings: z
    .looseObject({
      prompt_n: z.number().nullish(),
      prompt_ms: z.number().nullish(),
      predicted_n: z.number().nullish(),
      predicted_ms: z.number().nullish(),
    })
    .nullish(),
});

const ErrorBody = z.looseObject({
  error: z.looseObject({ type: z.string().nullish(), message: z.string().nullish() }),
});

interface Server {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly closed: Promise<void>;
  readonly stderrTail: () => string;
  ready: boolean;
  done: boolean;
  expectedExit: boolean;
  killTimer: NodeJS.Timeout | null;
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

const exitText = (code: number | null, signal: NodeJS.Signals | null) =>
  signal === null ? `exit ${code ?? "?"}` : `signal ${signal}`;

const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createLlamaServerEngine(options: LlamaServerEngineOptions): TextEngine {
  const deadlines = { ...LLAMA_SERVER_DEADLINES, ...options.deadlines };
  const threads = options.threads ?? 4;
  const { capabilities, resources, manifest, socketPath } = options;
  if (!socketPath.endsWith(".sock") || Buffer.byteLength(socketPath) > 103) {
    throw new Error("the server's socket path must end in .sock and fit in 103 bytes");
  }

  let state: EngineState = "absent";
  let server: Server | null = null;
  let previousExit: Promise<void> = Promise.resolve();
  let loadPromise: Promise<{ readonly loadMs: number }> | null = null;
  let unloadPromise: Promise<void> | null = null;
  /** A generate call between its checks and its end. */
  let busy = false;
  /** Bumped by unload: a load in progress gives up. */
  let epoch = 0;
  /** Aborts the request in flight when the server goes. */
  let inFlight: AbortController | null = null;

  const withTail = (message: string, target: Server | null) => {
    const tail = target?.stderrTail().trimEnd() ?? "";
    return tail === "" ? message : `${message}\n--- llama-server stderr (last 8 KiB) ---\n${tail}`;
  };

  function kill(target: Server): void {
    target.expectedExit = true;
    if (target.done) return;
    target.child.kill("SIGKILL");
    if (server === target) state = "unloading";
  }

  function spawnServer(): Server | EngineError {
    const args = [
      ...(options.executableArgs ?? []),
      "--model",
      options.weights,
      "--host",
      socketPath,
      "--no-webui",
      "--ctx-size",
      String(capabilities.contextTokens),
      "--parallel",
      "1",
      "--n-gpu-layers",
      "999",
      "--flash-attn",
      "on",
      // No prompt cache kept in memory between requests: each unit is new text.
      "--cache-ram",
      "0",
      "--reasoning",
      "off",
      "--threads",
      String(threads),
    ];
    const child = spawn(options.executable, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: process.env.HOME ?? homedir(),
        ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
        ...options.env,
      },
    });
    if (child.pid === undefined) {
      child.once("error", () => undefined);
      return new EngineError("load_failed", `cannot start ${options.executable}`);
    }
    const stderr = stderrRing(STDERR_TAIL_BYTES);
    const closed = Promise.withResolvers<void>();
    const target: Server = {
      child,
      pid: child.pid,
      closed: closed.promise,
      stderrTail: stderr.text,
      ready: false,
      done: false,
      expectedExit: false,
      killTimer: null,
    };
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", () => undefined);
    child.on("close", (code, signal) => {
      const during: EngineState = !target.ready ? "loading" : busy ? "busy" : state;
      target.done = true;
      if (target.killTimer !== null) clearTimeout(target.killTimer);
      if (server === target) {
        server = null;
        state = "absent";
      }
      inFlight?.abort(
        new EngineError(
          target.expectedExit ? "cancelled" : "crashed",
          withTail(`llama-server exited (${exitText(code, signal)})`, target),
        ),
      );
      void removeSocket().finally(() => closed.resolve());
      options.onExit?.({
        pid: target.pid,
        code,
        signal,
        during,
        expected: target.expectedExit,
        stderrTail: target.stderrTail(),
      });
    });
    return target;
  }

  /** A socket file a crashed server left would refuse the next bind. */
  async function removeSocket(): Promise<void> {
    try {
      if ((await lstat(socketPath)).isSocket()) await rm(socketPath, { force: true });
    } catch {
      // Not there.
    }
  }

  /** GET `/health`: the status code, or null while nothing listens. */
  function health(signal: AbortSignal): Promise<number | null> {
    return new Promise((resolve) => {
      const req = httpRequest(
        { socketPath, path: "/health", method: "GET", agent: false, signal, timeout: 5_000 },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? null);
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(null));
      req.end();
    });
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
      throw new EngineError("load_failed", `no llama-server at ${options.executable}`);
    }
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
    await removeSocket();
    const spawned = spawnServer();
    if (spawned instanceof EngineError) throw spawned;
    server = spawned;
    previousExit = spawned.closed;
    state = "loading";
    const startedAt = performance.now();
    const polling = new AbortController();
    const stop = () => polling.abort();
    signal?.addEventListener("abort", stop, { once: true });
    try {
      while (performance.now() - startedAt < deadlines.readyMs) {
        if (spawned.done) {
          throw new EngineError(
            "load_failed",
            withTail("llama-server exited before it was ready", spawned),
          );
        }
        if (signal?.aborted === true || epoch !== startEpoch) {
          kill(spawned);
          giveUp();
        }
        const code = await health(polling.signal);
        if (code === 200 && !spawned.done && server === spawned) {
          spawned.ready = true;
          state = "ready";
          return { loadMs: Math.round(performance.now() - startedAt) };
        }
        await sleep(deadlines.healthPollMs);
      }
      kill(spawned);
      throw new EngineError(
        "deadline",
        withTail(`not ready within ${deadlines.readyMs} ms`, spawned),
      );
    } catch (error) {
      if (!spawned.ready) kill(spawned);
      throw error instanceof EngineError
        ? error
        : new EngineError("load_failed", String(error), { cause: error });
    } finally {
      signal?.removeEventListener("abort", stop);
    }
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

  function checkRequest(request: TextRequest): void {
    if (request.id === "") throw new EngineError("rejected", "a request needs an id");
    if (request.maxOutputTokens <= 0 || request.maxOutputTokens > capabilities.maxOutputTokens) {
      throw new EngineError(
        "rejected",
        `the output limit must be within 1 and ${capabilities.maxOutputTokens} tokens`,
      );
    }
  }

  async function runRequest(request: TextRequest, opts: GenerateOptions): Promise<TextResult> {
    const controller = new AbortController();
    inFlight = controller;
    const onAbort = () =>
      controller.abort(new EngineError("cancelled", `request ${request.id} was cancelled`));
    if (opts.signal?.aborted === true) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new EngineError(
            "deadline",
            `request ${request.id} took more than ${deadlines.requestMs} ms`,
          ),
        ),
      deadlines.requestMs,
    );
    const startedAt = performance.now();
    state = "busy";
    const body = JSON.stringify({
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      stream: true,
      max_tokens: request.maxOutputTokens,
      temperature: 0,
      seed: 0,
      response_format: {
        type: "json_schema",
        json_schema: { name: "output", strict: true, schema: request.schema },
      },
      chat_template_kwargs: { enable_thinking: false },
    });
    try {
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = httpRequest(
          {
            socketPath,
            path: "/v1/chat/completions",
            method: "POST",
            agent: false,
            signal: controller.signal,
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            },
          },
          resolve,
        );
        req.on("error", reject);
        req.end(body);
      });
      if (res.statusCode !== 200) {
        const raw = await readBody(res);
        const parsed = ErrorBody.safeParse(safeJson(raw));
        const type = parsed.success ? (parsed.data.error.type ?? "") : "";
        throw new EngineError(
          "rejected",
          `llama-server refused the request (${res.statusCode ?? "?"} ${type})`,
          { reason: type.includes("context") ? "context-exceeded" : `http-${res.statusCode ?? 0}` },
        );
      }
      const streamed = await readStream(res, (count) => opts.onProgress?.(count));
      if (streamed.stop !== "stop" && streamed.stop !== "length") {
        throw new EngineError("invalid_output", "the answer ended without a stop", {
          reason: "no-stop",
        });
      }
      const computeMs = Math.round(performance.now() - startedAt);
      const timings = streamed.timings;
      return {
        requestId: request.id,
        text: streamed.text,
        stop: streamed.stop === "length" ? "length" : "complete",
        provenance: {
          engineId: manifest.id,
          engineVersion: manifest.version,
          runtime: manifest.runtime,
          adapterClass: manifest.adapterClass,
          modelSha256: options.modelSha256,
          config: {
            contextTokens: capabilities.contextTokens,
            temperature: 0,
            seed: 0,
            reasoning: false,
            threads,
          },
        },
        metrics: {
          promptTokens: Math.round(timings?.prompt_n ?? 0),
          outputTokens: Math.round(timings?.predicted_n ?? 0),
          promptMs: Math.round(timings?.prompt_ms ?? 0),
          generateMs: Math.round(timings?.predicted_ms ?? 0),
          computeMs,
        },
      };
    } catch (error) {
      const reason = controller.signal.reason;
      if (controller.signal.aborted && reason instanceof EngineError) throw reason;
      if (error instanceof EngineError) throw error;
      throw new EngineError("crashed", withTail(`the request failed: ${String(error)}`, server), {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (inFlight === controller) inFlight = null;
      if (state === "busy") state = "ready";
    }
  }

  async function generate(request: TextRequest, opts: GenerateOptions = {}): Promise<TextResult> {
    checkRequest(request);
    if (busy) throw new EngineError("rejected", "the engine runs one request at a time");
    busy = true;
    try {
      if (opts.signal?.aborted === true) {
        throw new EngineError("cancelled", `request ${request.id} was cancelled`);
      }
      await load(opts.signal);
      // The signal may have fired while the load was awaited.
      if (isAborted(opts.signal)) {
        throw new EngineError("cancelled", `request ${request.id} was cancelled`);
      }
      if (server === null || !server.ready || state !== "ready") {
        throw new EngineError("cancelled", "the server unloaded before the request started");
      }
      return await runRequest(request, opts);
    } finally {
      busy = false;
    }
  }

  function unload(): Promise<void> {
    if (unloadPromise !== null) return unloadPromise;
    epoch += 1;
    loadPromise = null;
    const target = server;
    if (target === null) return previousExit;
    target.expectedExit = true;
    state = "unloading";
    inFlight?.abort(new EngineError("cancelled", "the engine unloaded"));
    target.child.kill("SIGTERM");
    target.killTimer = setTimeout(
      () => kill(target),
      resources.unloadLatencyMs + deadlines.unloadGraceMs,
    );
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
    pid: () => (server === null || server.done ? undefined : server.pid),
    load,
    generate,
    unload,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Reads an SSE stream of chunks; resolves with the text, the stop, and the timings. */
function readStream(
  res: IncomingMessage,
  onToken: (count: number) => void,
): Promise<{
  text: string;
  stop: string | null;
  timings: z.output<typeof StreamChunk>["timings"];
}> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let text = "";
    let stop: string | null = null;
    let tokens = 0;
    let timings: z.output<typeof StreamChunk>["timings"] = null;
    let size = 0;
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.destroy(
          new EngineError("invalid_output", "the answer is too long", { reason: "too-long" }),
        );
        return;
      }
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let parsed: z.output<typeof StreamChunk>;
        try {
          parsed = StreamChunk.parse(JSON.parse(data));
        } catch {
          res.destroy(
            new EngineError("protocol", "llama-server sent a chunk that is not JSON", {
              reason: "malformed-chunk",
            }),
          );
          return;
        }
        const choice = parsed.choices?.[0];
        const content = choice?.delta?.content;
        if (typeof content === "string" && content !== "") {
          text += content;
          tokens += 1;
          onToken(tokens);
        }
        if (choice?.finish_reason != null) stop = choice.finish_reason;
        if (parsed.timings != null) timings = parsed.timings;
      }
    });
    res.on("end", () => resolve({ text, stop, timings }));
    res.on("error", reject);
    res.on("aborted", () => reject(new EngineError("crashed", "the answer was cut")));
  });
}

function readBody(res: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      if (body.length < 64 * 1024) body += chunk;
    });
    res.on("end", () => resolve(body));
    res.on("error", () => resolve(body));
  });
}
