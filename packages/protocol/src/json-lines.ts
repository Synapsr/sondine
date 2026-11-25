import * as z from "zod";
import { MAX_LINE_BYTES } from "./constants";

const NEWLINE = 0x0a;
const textEncoder = new TextEncoder();
// `fatal` turns malformed UTF-8 into an error; `ignoreBOM` keeps a BOM so JSON.parse rejects it.
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface ProtocolIssue {
  /** Dotted path to the offending value, empty for the whole message. */
  path: string;
  code: string;
  message: string;
}

export type JsonLineErrorKind =
  | "line-too-long"
  | "invalid-utf8"
  | "invalid-json"
  | "invalid-message"
  | "truncated";

export interface JsonLineError {
  kind: JsonLineErrorKind;
  message: string;
  /** Schema issues for `invalid-message`, empty otherwise. */
  issues: readonly ProtocolIssue[];
}

export interface LinePosition {
  /** 1-based line number in the stream. */
  line: number;
  /** Byte offset of the line's first byte. */
  offset: number;
  /** Byte offset just past the line's newline, where reading can resume. */
  end: number;
}

type LineOutcome<T> = { ok: true; value: T } | { ok: false; error: JsonLineError };

export type JsonLineResult<T> = LineOutcome<T> & LinePosition;

export interface JsonLinesDecoderOptions {
  /** Longest accepted line in bytes, newline excluded. Defaults to 1 MiB. */
  maxLineBytes?: number;
  /** Byte offset of the first chunk in the stream, when resuming a file. */
  startOffset?: number;
  /** Number of lines before the first chunk, when resuming a file. */
  startLine?: number;
}

export interface JsonLinesDecoder<T> {
  /** Feeds bytes and returns one result per line this chunk completes. Never throws. */
  push(chunk: Uint8Array | string): JsonLineResult<T>[];
  /** Ends the stream. A non-blank unterminated last line is reported as `truncated`. */
  end(): JsonLineResult<T>[];
}

export function toProtocolIssues(error: z.ZodError): ProtocolIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message: issue.message,
  }));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(kind: JsonLineErrorKind, message: string): { ok: false; error: JsonLineError } {
  return { ok: false, error: { kind, message, issues: [] } };
}

function isBlank(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0x20 || byte === 0x09 || byte === 0x0d);
}

function concat(parts: readonly Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/** Parses one complete line (newline excluded) against `schema`. */
export function decodeJsonLine<S extends z.ZodType>(
  schema: S,
  line: Uint8Array | string,
): LineOutcome<z.output<S>> {
  let text: string;
  if (typeof line === "string") {
    text = line;
  } else {
    try {
      text = utf8Decoder.decode(line);
    } catch (error) {
      return failure("invalid-utf8", describeError(error));
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return failure("invalid-json", describeError(error));
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: "invalid-message",
        message: "line does not match the schema",
        issues: toProtocolIssues(parsed.error),
      },
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Incremental JSON-lines decoder validated by `schema`. It accepts any split
 * of the byte stream (including inside a UTF-8 sequence), keeps at most
 * `maxLineBytes` of an unfinished line, and skips the rest of an oversized
 * line up to its newline. Blank lines are ignored.
 */
export function createJsonLinesDecoder<S extends z.ZodType>(
  schema: S,
  options: JsonLinesDecoderOptions = {},
): JsonLinesDecoder<z.output<S>> {
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  let pending: Uint8Array[] = [];
  /** Bytes of the current line so far, including skipped ones. */
  let lineBytes = 0;
  let lineOffset = options.startOffset ?? 0;
  let lineNumber = options.startLine ?? 0;

  function takePending(last: Uint8Array): Uint8Array {
    if (pending.length === 0) return last;
    return concat([...pending, last], lineBytes);
  }

  /** Completes the current line; `terminated` is false at the end of the stream. */
  function complete(
    last: Uint8Array,
    terminated: boolean,
  ): JsonLineResult<z.output<S>> | undefined {
    lineBytes += last.byteLength;
    const position: LinePosition = {
      line: lineNumber + 1,
      offset: lineOffset,
      end: lineOffset + lineBytes + (terminated ? 1 : 0),
    };
    let outcome: LineOutcome<z.output<S>> | undefined;
    if (lineBytes > maxLineBytes) {
      outcome = failure(
        "line-too-long",
        `line has ${lineBytes} bytes; the limit is ${maxLineBytes}`,
      );
    } else {
      const bytes = takePending(last);
      if (!isBlank(bytes)) {
        outcome = terminated
          ? decodeJsonLine(schema, bytes)
          : failure("truncated", "the stream ended inside a line");
      }
    }
    pending = [];
    lineBytes = 0;
    lineNumber = position.line;
    lineOffset = position.end;
    return outcome === undefined ? undefined : { ...outcome, ...position };
  }

  function keep(piece: Uint8Array) {
    lineBytes += piece.byteLength;
    if (lineBytes > maxLineBytes) {
      pending = [];
      return;
    }
    // Copy: callers may reuse their read buffers.
    pending.push(piece.slice());
  }

  return {
    push(chunk) {
      const bytes = typeof chunk === "string" ? textEncoder.encode(chunk) : chunk;
      const results: JsonLineResult<z.output<S>>[] = [];
      let start = 0;
      while (start < bytes.byteLength) {
        const newline = bytes.indexOf(NEWLINE, start);
        if (newline === -1) {
          keep(bytes.subarray(start));
          break;
        }
        const result = complete(bytes.subarray(start, newline), true);
        if (result !== undefined) results.push(result);
        start = newline + 1;
      }
      return results;
    },
    end() {
      if (lineBytes === 0) return [];
      const result = complete(new Uint8Array(0), false);
      return result === undefined ? [] : [result];
    },
  };
}

/** Decodes a whole JSON-lines document, such as a manifest file or a fixture. */
export function decodeJsonLines<S extends z.ZodType>(
  schema: S,
  input: Uint8Array | string,
  options: JsonLinesDecoderOptions = {},
): JsonLineResult<z.output<S>>[] {
  const decoder = createJsonLinesDecoder(schema, options);
  return [...decoder.push(input), ...decoder.end()];
}

export type JsonLineEncodeErrorKind = "invalid-message" | "unserializable" | "line-too-long";

export interface JsonLineEncodeError {
  kind: JsonLineEncodeErrorKind;
  message: string;
  issues: readonly ProtocolIssue[];
}

export type JsonLineEncodeResult =
  | { ok: true; line: string }
  | { ok: false; error: JsonLineEncodeError };

/**
 * Validates `value` against `schema`, converts it to its wire form (bigint
 * clocks become decimal strings), and returns one JSON line ending in `\n`.
 * Never throws.
 */
export function encodeJsonLine<S extends z.ZodType>(
  schema: S,
  value: z.output<S>,
  options: Pick<JsonLinesDecoderOptions, "maxLineBytes"> = {},
): JsonLineEncodeResult {
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  const encoded = z.safeEncode(schema, value);
  if (!encoded.success) {
    return {
      ok: false,
      error: {
        kind: "invalid-message",
        message: "value does not match the schema",
        issues: toProtocolIssues(encoded.error),
      },
    };
  }
  let text: string;
  try {
    text = JSON.stringify(encoded.data);
  } catch (error) {
    return {
      ok: false,
      error: { kind: "unserializable", message: describeError(error), issues: [] },
    };
  }
  const byteLength = textEncoder.encode(text).byteLength;
  if (byteLength > maxLineBytes) {
    return {
      ok: false,
      error: {
        kind: "line-too-long",
        message: `line has ${byteLength} bytes; the limit is ${maxLineBytes}`,
        issues: [],
      },
    };
  }
  return { ok: true, line: `${text}\n` };
}
