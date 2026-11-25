import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
  HelperEvent,
  MAX_LINE_BYTES,
  type JsonLineResult,
  type JsonLinesDecoder,
  createJsonLinesDecoder,
  decodeJsonLines,
  encodeJsonLine,
} from "../src";

const Item = z.strictObject({ type: z.literal("item"), name: z.string() });
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

/** An `item` line of exactly `length` bytes (length >= 25). */
function itemLine(length: number): string {
  return `{"type":"item","name":"${"x".repeat(length - 25)}"}`;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function feed<T>(decoder: JsonLinesDecoder<T>, chunks: readonly Uint8Array[]): JsonLineResult<T>[] {
  return [...chunks.flatMap((chunk) => decoder.push(chunk)), ...decoder.end()];
}

describe("createJsonLinesDecoder", () => {
  it("decodes several messages in one chunk with positions", () => {
    const text = '{"type":"item","name":"a"}\n{"type":"item","name":"bé"}\n';
    const results = decodeJsonLines(Item, text);
    expect(results).toEqual([
      { ok: true, value: { type: "item", name: "a" }, line: 1, offset: 0, end: 27 },
      { ok: true, value: { type: "item", name: "bé" }, line: 2, offset: 27, end: 56 },
    ]);
  });

  it("gives the same results for every split of the stream", () => {
    const fixture = readFileSync(
      join(import.meta.dirname, "..", "fixtures", "helper-events.jsonl"),
    );
    const whole = decodeJsonLines(HelperEvent, fixture);
    expect(whole.every((result) => result.ok)).toBe(true);

    const oneByte = feed(
      createJsonLinesDecoder(HelperEvent),
      Array.from(fixture, (byte) => Uint8Array.of(byte)),
    );
    expect(oneByte).toEqual(whole);

    const random = mulberry32(7);
    for (let round = 0; round < 20; round += 1) {
      const chunks: Uint8Array[] = [];
      for (let start = 0; start < fixture.byteLength;) {
        const size = 1 + Math.floor(random() * 700);
        chunks.push(fixture.subarray(start, start + size));
        start += size;
      }
      expect(feed(createJsonLinesDecoder(HelperEvent), chunks)).toEqual(whole);
    }
  });

  it("joins a UTF-8 sequence split across chunks", () => {
    const line = bytes('{"type":"item","name":"micro 🎙️ é"}\n');
    const split = line.indexOf(0xf0) + 2;
    const results = feed(createJsonLinesDecoder(Item), [
      line.subarray(0, split),
      line.subarray(split),
    ]);
    expect(results).toMatchObject([{ ok: true, value: { name: "micro 🎙️ é" } }]);
  });

  it("copies partial lines so callers may reuse their buffers", () => {
    const decoder = createJsonLinesDecoder(Item);
    const source = bytes('{"type":"item","name":"abc"}\n');
    const readBuffer = source.slice(0, 20);
    expect(decoder.push(readBuffer)).toEqual([]);
    readBuffer.fill(0x20);
    expect(decoder.push(source.subarray(20))).toMatchObject([{ ok: true, value: { name: "abc" } }]);
  });

  it("accepts CRLF and skips blank lines while counting them", () => {
    const results = decodeJsonLines(Item, '\n  \r\n{"type":"item","name":"a"}\r\n\n');
    expect(results).toEqual([
      { ok: true, value: { type: "item", name: "a" }, line: 3, offset: 5, end: 33 },
    ]);
  });

  it("reports each kind of bad line and keeps going", () => {
    const stream = [
      bytes('{"type":"item","name":"ok"}\n'),
      bytes("{not json}\n"),
      Uint8Array.of(0x7b, 0xff, 0xfe, 0x7d, 0x0a),
      bytes('{"type":"item","name":3}\n'),
      bytes('﻿{"type":"item","name":"bom"}\n'),
      bytes('{"type":"item","name":"after"}\n'),
      bytes('{"type":"item"'),
    ];
    const results = feed(createJsonLinesDecoder(Item), stream);
    expect(results.map((result) => (result.ok ? "ok" : result.error.kind))).toEqual([
      "ok",
      "invalid-json",
      "invalid-utf8",
      "invalid-message",
      "invalid-json",
      "ok",
      "truncated",
    ]);
    expect(results[3]).toMatchObject({
      ok: false,
      error: { issues: [{ path: "name", code: "invalid_type" }] },
    });
  });

  it("enforces the line limit, then resynchronises on the next line", () => {
    const max = 64;
    expect(itemLine(max)).toHaveLength(max);

    const decoder = createJsonLinesDecoder(Item, { maxLineBytes: max });
    const atLimit = decoder.push(`${itemLine(max)}\n`);
    expect(atLimit).toMatchObject([{ ok: true }]);

    const long = bytes(`${itemLine(max + 1)}`);
    const results = [
      ...decoder.push(long.subarray(0, 10)),
      ...decoder.push(long.subarray(10)),
      ...decoder.push(`\n${itemLine(30)}\n`),
    ];
    expect(results).toMatchObject([
      { ok: false, error: { kind: "line-too-long" }, line: 2, offset: max + 1, end: 2 * max + 3 },
      { ok: true, line: 3, offset: 2 * max + 3 },
    ]);
  });

  it("defaults the line limit to 1 MiB", () => {
    const name = "x".repeat(MAX_LINE_BYTES);
    const results = decodeJsonLines(Item, `{"type":"item","name":"${name}"}\n`);
    expect(results).toMatchObject([{ ok: false, error: { kind: "line-too-long" } }]);
  });

  it("reports an oversized unterminated line as too long", () => {
    const decoder = createJsonLinesDecoder(Item, { maxLineBytes: 8 });
    expect(decoder.push("0123456789")).toEqual([]);
    expect(decoder.end()).toMatchObject([
      { ok: false, error: { kind: "line-too-long" }, line: 1, offset: 0, end: 10 },
    ]);
  });

  it("resumes positions from a stored offset", () => {
    const decoder = createJsonLinesDecoder(Item, { startOffset: 1000, startLine: 41 });
    expect(decoder.push('{"type":"item","name":"a"}\n')).toMatchObject([
      { ok: true, line: 42, offset: 1000, end: 1027 },
    ]);
  });

  it("never throws on random bytes", () => {
    const random = mulberry32(42);
    for (let round = 0; round < 200; round += 1) {
      const decoder = createJsonLinesDecoder(HelperEvent, { maxLineBytes: 256 });
      const results: JsonLineResult<HelperEvent>[] = [];
      for (let chunk = 0; chunk < 8; chunk += 1) {
        const data = Uint8Array.from({ length: Math.floor(random() * 120) }, () =>
          random() < 0.1 ? 0x0a : Math.floor(random() * 256),
        );
        results.push(...decoder.push(data));
      }
      results.push(...decoder.end());
      for (const result of results) expect(typeof result.ok).toBe("boolean");
    }
  });
});

describe("encodeJsonLine", () => {
  it("writes bigint clocks as decimal strings on one line", () => {
    const clock: HelperEvent = {
      type: "clock",
      reason: "wake",
      anchor: {
        hostTicks: 123_456_789_012n,
        continuousNs: 9_007_199_254_740_993n,
        wallNs: 1_793_610_000_000_000_001n,
      },
    };
    const result = encodeJsonLine(HelperEvent, clock);
    expect(result).toEqual({
      ok: true,
      line: '{"type":"clock","reason":"wake","anchor":{"hostTicks":"123456789012","continuousNs":"9007199254740993","wallNs":"1793610000000000001"}}\n',
    });
    if (!result.ok) return;
    expect(decodeJsonLines(HelperEvent, result.line)).toMatchObject([{ ok: true, value: clock }]);
  });

  it("returns an error for an invalid value instead of throwing", () => {
    const Positive = z.strictObject({ n: z.int().min(0) });
    expect(encodeJsonLine(Positive, { n: -1 })).toMatchObject({
      ok: false,
      error: { kind: "invalid-message", issues: [{ path: "n", code: "too_small" }] },
    });
  });

  it("escapes newlines inside strings", () => {
    const result = encodeJsonLine(Item, { type: "item", name: "a\nb" });
    expect(result).toEqual({ ok: true, line: '{"type":"item","name":"a\\nb"}\n' });
  });

  it("enforces the line limit", () => {
    const result = encodeJsonLine(
      Item,
      { type: "item", name: "x".repeat(100) },
      { maxLineBytes: 64 },
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "line-too-long" } });
  });

  it("reports values JSON cannot represent", () => {
    const Any = z.unknown();
    expect(encodeJsonLine(Any, { big: 1n })).toMatchObject({
      ok: false,
      error: { kind: "unserializable" },
    });
  });
});
