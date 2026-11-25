import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Span, SpansOutput } from "@sondine/api";
import { Cause, Context, Effect, Exit, Layer, Option, Tracer } from "effect";
import { CoreConfig } from "./config";
import { log } from "./log";

// Local performance spans (architecture §13): every Effect span core ends is
// kept in a ring for Diagnostics and appended to a JSON-lines file once a
// minute. Spans never hold audio or transcript text, only names, durations
// and small attributes.

const MAX_ATTRIBUTE_LENGTH = 256;
const ROTATE_BYTES = 4 * 1024 * 1024;

export class SpanRing {
  private readonly items: Span[] = [];
  private unpersisted: Span[] = [];

  constructor(private readonly capacity: number) {}

  push(span: Span): void {
    this.items.push(span);
    if (this.items.length > this.capacity) this.items.shift();
    this.unpersisted.push(span);
    if (this.unpersisted.length > this.capacity) this.unpersisted.shift();
  }

  /** Newest first. */
  recent(limit: number, namePrefix?: string): Span[] {
    const out: Span[] = [];
    for (let index = this.items.length - 1; index >= 0 && out.length < limit; index--) {
      const span = this.items[index];
      if (span !== undefined && (namePrefix === undefined || span.name.startsWith(namePrefix))) {
        out.push(span);
      }
    }
    return out;
  }

  takeUnpersisted(): Span[] {
    const taken = this.unpersisted;
    this.unpersisted = [];
    return taken;
  }
}

function attributesOf(attributes: ReadonlyMap<string, unknown>): Span["attributes"] {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of attributes) {
    if (typeof value === "string") out[key] = value.slice(0, MAX_ATTRIBUTE_LENGTH);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "bigint") out[key] = Number(value);
  }
  return out;
}

export function spanRecord(
  span: Tracer.Span,
  startTime: bigint,
  endTime: bigint,
  exit: Exit.Exit<unknown, unknown>,
): Span {
  let status: Span["status"] = "ok";
  if (Exit.isFailure(exit)) status = Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "error";
  return {
    name: span.name,
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: Option.isSome(span.parent) ? span.parent.value.spanId : null,
    startMs: Number(startTime / 1_000n) / 1_000,
    durationMs: Number(endTime - startTime) / 1_000_000,
    status,
    attributes: attributesOf(span.attributes),
  };
}

class RecordingSpan extends Tracer.NativeSpan {
  constructor(
    options: ConstructorParameters<typeof Tracer.NativeSpan>[0],
    private readonly onEnd: (
      span: RecordingSpan,
      endTime: bigint,
      exit: Exit.Exit<unknown, unknown>,
    ) => void,
  ) {
    super(options);
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    const wasOpen = this.status._tag === "Started";
    super.end(endTime, exit);
    if (wasOpen) this.onEnd(this, endTime, exit);
  }
}

export function recordingTracer(ring: SpanRing): Tracer.Tracer {
  return Tracer.make({
    span: (options) =>
      new RecordingSpan(options, (span, endTime, exit) =>
        ring.push(spanRecord(span, span.startTime, endTime, exit)),
      ),
  });
}

export interface SpansService {
  readonly ring: SpanRing;
  recent(input: { limit: number; name?: string | undefined }): SpansOutput;
  /** Appends the spans not yet written to the spans file. */
  readonly flush: Effect.Effect<void>;
}

export class Spans extends Context.Service<Spans, SpansService>()("sondine/core/Spans") {}

function appendSpans(path: string, spans: readonly Span[]) {
  if (spans.length === 0) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    if (statSync(path).size > ROTATE_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // No file yet.
  }
  appendFileSync(path, spans.map((span) => JSON.stringify(span)).join("\n") + "\n", {
    mode: 0o600,
  });
}

export const spansLayer = (options: { capacity?: number; flushEvery?: `${number} seconds` } = {}) =>
  Layer.effect(
    Spans,
    Effect.gen(function* () {
      const config = yield* CoreConfig;
      const ring = new SpanRing(options.capacity ?? 2_000);
      const flush = Effect.sync(() => {
        try {
          appendSpans(config.spansPath, ring.takeUnpersisted());
        } catch (error) {
          log.warn("spans.flush", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
      yield* flush.pipe(
        Effect.delay(options.flushEvery ?? "60 seconds"),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* Effect.addFinalizer(() => flush);
      return Spans.of({
        ring,
        recent: ({ limit, name }) => ({ spans: ring.recent(limit, name) }),
        flush,
      });
    }),
  );

/** Installs the recording tracer for every effect run on the runtime. */
export const tracerLayer = Layer.effect(
  Tracer.Tracer,
  Effect.gen(function* () {
    const spans = yield* Spans;
    return recordingTracer(spans.ring);
  }),
);
