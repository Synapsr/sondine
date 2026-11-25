import type {
  EngineManifest,
  EngineResources,
  EngineState,
  GenerateOptions,
  TextCapabilities,
  TextEngine,
  TextRequest,
  TextResult,
} from "../contract.ts";
import { EngineError } from "../contract.ts";
import { CLAUDE_LOCKED_ARGUMENTS, KNOWN_BLOCKS, QUIET_ENV } from "./claude.ts";
import {
  endProcess,
  field,
  readJsonLines,
  startProcess,
  stderrTail,
  type Environment,
} from "./processes.ts";

// The journal on the user's Claude subscription (ADR 028 `provider`, ADR
// 027): one `claude -p` per request, with the flags ADR 027 measured (no
// tools, no MCP server, none of the user's settings, no session kept), the
// request's instructions as the system prompt, its schema as the structured
// output, and what the model works on as the one message. The only tool the
// CLI may offer is the one that carries the schema; any other stops the
// request. Product code calls it only with the user's consent: the text
// leaves the Mac.

/** The tool `--json-schema` adds: the answer comes back through it. */
const SCHEMA_TOOL = "StructuredOutput";

/** A request longer than this is stopped (a day's longest window answers in about a minute). */
const REQUEST_DEADLINE_MS = 5 * 60_000;

export const CLAUDE_TEXT_CAPABILITIES: TextCapabilities = {
  languages: ["fr", "en"],
  contextTokens: 200_000,
  maxOutputTokens: 32_000,
  schemaConstrained: true,
  locality: "provider",
};

/** A CLI process per request, nothing resident: the scheduler reserves no memory for it. */
export const CLAUDE_TEXT_RESOURCES: EngineResources = {
  peakBytesBase: 0,
  peakBytesPerAudioHour: 0,
  coldLoadMs: 0,
  unloadLatencyMs: 2_000,
  computeUnits: [],
};

export interface ClaudeTextEngineOptions {
  /** The `claude` executable and the environment to start it with (ADR 027's locator). */
  readonly locate: () => Promise<{ readonly executable: string | null; readonly env: Environment }>;
  /** A model alias (`haiku`) or a full id. */
  readonly model: string;
  /** `low`, `medium`, `high`, or null for the CLI's default. */
  readonly effort: string | null;
  /** An empty private folder to run in: never Sondine's container (ADR 027). */
  readonly workDirectory: string;
  readonly requestDeadlineMs?: number;
}

export function claudeTextArguments(
  options: Pick<ClaudeTextEngineOptions, "model" | "effort">,
  request: Pick<TextRequest, "system" | "schema">,
): string[] {
  const args = [
    ...CLAUDE_LOCKED_ARGUMENTS,
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
    "--model",
    options.model,
    "--system-prompt",
    request.system,
    "--json-schema",
    JSON.stringify(request.schema),
  ];
  if (options.effort !== null) args.push("--effort", options.effort);
  return args;
}

const number = (value: unknown, key: string) => field.number(value, key) ?? 0;

/** Read at each call: a signal may abort while a request waits. */
const isAborted = (signal: AbortSignal | undefined) => signal?.aborted === true;

export function createClaudeTextEngine(options: ClaudeTextEngineOptions): TextEngine {
  const manifest: EngineManifest = {
    id: `claude-${options.model}-journal`,
    version: "1",
    runtime: "claude-code",
    adapterClass: "product",
    stages: ["textgen"],
    artifacts: [],
  };
  let running: ReturnType<typeof startProcess> | null = null;
  /** Bumped by `unload`: a request still finding the CLI then never starts it. */
  let generation = 0;

  const generate = async (
    request: TextRequest,
    generateOptions: GenerateOptions = {},
  ): Promise<TextResult> => {
    const { signal } = generateOptions;
    if (signal?.aborted === true) {
      throw new EngineError("cancelled", `request ${request.id} was cancelled`);
    }
    const started = generation;
    const { executable, env } = await options.locate();
    // Finding the CLI can take seconds (the login shell): a cancel or an
    // unload meanwhile means nothing is sent.
    if (isAborted(signal) || started !== generation) {
      throw new EngineError("cancelled", `request ${request.id} was cancelled`);
    }
    if (executable === null) {
      throw new EngineError("load_failed", "claude is not installed", { reason: "missing" });
    }
    const startedAt = performance.now();
    const child = startProcess(executable, claudeTextArguments(options, request), {
      env: { ...env, ...QUIET_ENV },
      cwd: options.workDirectory,
    });
    running = child;
    const stderr = stderrTail(child.stderr);
    try {
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const fail = (error: EngineError) => {
          clearTimeout(timer);
          reject(error);
        };
        const timer = setTimeout(
          () =>
            fail(
              new EngineError("deadline", `request ${request.id} took too long`, {
                reason: "deadline",
              }),
            ),
          options.requestDeadlineMs ?? REQUEST_DEADLINE_MS,
        );
        signal?.addEventListener(
          "abort",
          () => fail(new EngineError("cancelled", `request ${request.id} was cancelled`)),
          { once: true },
        );
        // ADR 027's tripwire, failing closed: an init that does not list its
        // tools and servers, any tool but the schema's, any MCP server, any
        // kind of content not known, or an answer before the init.
        let initialized = false;
        const trip = () =>
          fail(new EngineError("rejected", "claude went beyond the request", { reason: "tool" }));
        const offTool = (name: string | null) => name !== SCHEMA_TOOL;
        readJsonLines(
          child.stdout,
          (message) => {
            const type = field.string(message, "type");
            if (type === "system" && field.string(message, "subtype") === "init") {
              if (!Array.isArray(message["tools"]) || !Array.isArray(message["mcp_servers"])) {
                return trip();
              }
              const tools = field.array(message, "tools");
              if (tools.some((tool) => typeof tool !== "string" || offTool(tool))) return trip();
              if (field.array(message, "mcp_servers").length > 0) return trip();
              initialized = true;
            } else if (type === "assistant") {
              for (const block of field.array(field.object(message, "message"), "content")) {
                const kind = field.string(block, "type") ?? "";
                if (!KNOWN_BLOCKS.has(kind)) return trip();
                if (kind === "tool_use" && offTool(field.string(block, "name"))) return trip();
              }
            } else if (type === "stream_event") {
              const block = field.object(field.object(message, "event"), "content_block");
              const kind = field.string(block, "type");
              if (kind === "server_tool_use") return trip();
              if (kind === "tool_use" && offTool(field.string(block, "name"))) return trip();
            } else if (type === "result") {
              if (!initialized) return trip();
              clearTimeout(timer);
              resolve(message);
            }
          },
          (reason) =>
            fail(new EngineError("protocol", "claude sent a line that is not JSON", { reason })),
        );
        child.on("error", () =>
          fail(new EngineError("load_failed", "claude did not start", { reason: "spawn" })),
        );
        child.on("exit", () =>
          fail(new EngineError("crashed", "claude ended without an answer", { reason: "exit" })),
        );
        child.stdin.write(
          `${JSON.stringify({ type: "user", message: { role: "user", content: request.user } })}\n`,
        );
        child.stdin.end();
      });
      if (
        field.boolean(result, "is_error") === true ||
        field.string(result, "subtype") !== "success"
      ) {
        // A fixed reason, never the CLI's words: they may quote what was sent.
        const status = field.number(result, "api_error_status");
        throw new EngineError("rejected", "claude refused the request", {
          reason: status === null ? (field.string(result, "subtype") ?? "error") : `http-${status}`,
        });
      }
      const output = field.object(result, "structured_output");
      if (output === null) {
        throw new EngineError("invalid_output", "claude gave no structured output", {
          reason: stderr() === "" ? "no-output" : "no-output-stderr",
        });
      }
      const usage = field.object(result, "usage");
      const durationMs = number(result, "duration_ms");
      return {
        requestId: request.id,
        text: JSON.stringify(output),
        stop: field.string(result, "stop_reason") === "max_tokens" ? "length" : "complete",
        provenance: {
          engineId: manifest.id,
          engineVersion: manifest.version,
          runtime: manifest.runtime,
          adapterClass: manifest.adapterClass,
          // A provider's model has no file here to hash: the model it answered with says which.
          modelSha256: "",
          config: {
            model: Object.keys(field.object(result, "modelUsage") ?? {})[0] ?? options.model,
            ...(options.effort === null ? {} : { effort: options.effort }),
          },
        },
        metrics: {
          promptTokens:
            number(usage, "input_tokens") +
            number(usage, "cache_creation_input_tokens") +
            number(usage, "cache_read_input_tokens"),
          outputTokens: number(usage, "output_tokens"),
          promptMs: 0,
          generateMs: number(result, "duration_api_ms"),
          computeMs: durationMs === 0 ? Math.round(performance.now() - startedAt) : durationMs,
        },
      };
    } finally {
      running = null;
      await endProcess(child);
    }
  };

  return {
    manifest,
    resources: CLAUDE_TEXT_RESOURCES,
    capabilities: CLAUDE_TEXT_CAPABILITIES,
    state: (): EngineState => (running === null ? "ready" : "busy"),
    pid: () => running?.pid,
    load: async () => ({ loadMs: 0 }),
    unload: async () => {
      generation += 1;
      const child = running;
      if (child !== null) await endProcess(child);
    },
    generate,
  };
}
