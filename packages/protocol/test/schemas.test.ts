import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  CONTROL_MESSAGE_TYPES,
  ClockValue,
  ControlMessage,
  HELPER_EVENT_TYPES,
  HelperEvent,
  MAX_CLOCK_VALUE,
  ManifestRecord,
  PROTOCOL_VERSION,
  TERMINAL_REPLY,
  TrackKey,
  base64ToBytes,
  bytesToBase64,
  crc32,
  decodeJsonLine,
  encodeEnvelopeValues,
  parseTrackKey,
  ticksToNs,
  trackKeyOf,
} from "../src";

function issuePaths(result: ReturnType<typeof decodeJsonLine>): string[] {
  return result.ok ? [] : result.error.issues.map((issue) => issue.path);
}

describe("ClockValue", () => {
  it("decodes decimal strings to bigint up to 2^63 - 1", () => {
    expect(ClockValue.parse("0")).toBe(0n);
    expect(ClockValue.parse(MAX_CLOCK_VALUE.toString())).toBe(MAX_CLOCK_VALUE);
    expect(ClockValue.safeParse((MAX_CLOCK_VALUE + 1n).toString()).success).toBe(false);
  });

  it.each(["", "01", "-1", "1.0", "1e3", " 1", "99999999999999999999"])("rejects %j", (text) => {
    expect(ClockValue.safeParse(text).success).toBe(false);
  });

  it("rejects JSON numbers", () => {
    expect(ClockValue.safeParse(1).success).toBe(false);
  });
});

describe("track keys", () => {
  it.each([
    ["input:BuiltInMicrophoneDevice", { kind: "input", deviceUid: "BuiltInMicrophoneDevice" }],
    [
      "input:AppleUSBAudioEngine:Vendor:Mic:1:1",
      { kind: "input", deviceUid: "AppleUSBAudioEngine:Vendor:Mic:1:1" },
    ],
    ["app:us.zoom.xos", { kind: "app", bundleId: "us.zoom.xos" }],
    ["system:other", { kind: "system" }],
  ] as const)("parses %s", (key, parsed) => {
    expect(TrackKey.parse(key)).toBe(key);
    expect(parseTrackKey(key)).toEqual(parsed);
  });

  it.each(["input:", "app:", "app:has space", "system:all", "phone:abc", "input:tab\there"])(
    "rejects %j",
    (key) => {
      expect(TrackKey.safeParse(key).success).toBe(false);
    },
  );

  it("derives the key from a source", () => {
    expect(
      trackKeyOf({ kind: "app", bundleId: "com.apple.Safari", name: null, objectIds: [1] }),
    ).toBe("app:com.apple.Safari");
    expect(trackKeyOf({ kind: "system", excludedObjectIds: [] })).toBe("system:other");
  });
});

describe("clocks", () => {
  it("converts Apple silicon ticks (24 MHz) to nanoseconds", () => {
    expect(ticksToNs(24_000_000n, { numer: 125, denom: 3 })).toBe(1_000_000_000n);
    expect(ticksToNs(123_456_789_012n, { numer: 125, denom: 3 })).toBe(5_144_032_875_500n);
  });
});

describe("request and reply rules", () => {
  it("names a terminal reply for every control message", () => {
    expect(Object.keys(TERMINAL_REPLY).toSorted()).toEqual([...CONTROL_MESSAGE_TYPES].toSorted());
    for (const reply of Object.values(TERMINAL_REPLY)) {
      expect(HELPER_EVENT_TYPES).toContain(reply);
    }
  });

  it("answers request.permissions with permissions, then ack", () => {
    const request = { type: "request.permissions", id: "p1", scope: "system-audio" };
    const decoded = decodeJsonLine(ControlMessage, JSON.stringify(request));
    expect(decoded.ok && decoded.value).toEqual(request);
    expect(TERMINAL_REPLY["request.permissions"]).toBe("ack");
    const state = { status: "granted", evidence: "tcc-preflight" };
    const permissions = {
      type: "permissions",
      replyTo: "p1",
      microphone: state,
      systemAudio: state,
    };
    expect(decodeJsonLine(HelperEvent, JSON.stringify(permissions)).ok).toBe(true);
    const unscoped = { type: "request.permissions", id: "p1" };
    expect(issuePaths(decodeJsonLine(ControlMessage, JSON.stringify(unscoped)))).toEqual(["scope"]);
  });

  it("speaks protocol 7 in hello and ready", () => {
    expect(PROTOCOL_VERSION).toBe(7);
    const hello = { type: "hello", id: "c1", protocol: 1, client: { name: "core", version: "1" } };
    expect(issuePaths(decodeJsonLine(ControlMessage, JSON.stringify(hello)))).toEqual(["protocol"]);
  });

  it("rejects null for optional fields", () => {
    const warning = JSON.stringify({ type: "warning", code: "a.b", message: "m", trackKey: null });
    expect(decodeJsonLine(HelperEvent, warning).ok).toBe(false);
  });
});

describe("cross-field rules", () => {
  const at = { hostTicks: "1", continuousNs: "1" };

  it("ties a track's key to its source", () => {
    const open = {
      type: "track.open",
      trackKey: "app:us.zoom.xos",
      runId: "1b0e6c52-3f4a-4d8b-9c21-7e5f9a0b1c2d",
      epoch: 0,
      start: at,
      anchor: { ...at, wallNs: "1" },
      format: { rate: 16000, channels: 1, sampleFormat: "s16le" },
      nominalRate: 48000,
      measuredRate: null,
      stream: "starting",
      source: { kind: "app", bundleId: "com.apple.Safari", name: null, objectIds: [3] },
    };
    expect(issuePaths(decodeJsonLine(HelperEvent, JSON.stringify(open)))).toEqual(["source"]);
  });

  it("checks commit offsets against the block size", () => {
    const commit = {
      type: "commit",
      seq: 0,
      epoch: 0,
      committedOffset: 3,
      sampleIndex: 0,
      sampleCount: 1,
      crc32: 0,
      at,
    };
    expect(issuePaths(decodeJsonLine(ManifestRecord, JSON.stringify(commit)))).toEqual([
      "committedOffset",
    ]);
    commit.committedOffset = 4;
    expect(decodeJsonLine(ManifestRecord, JSON.stringify(commit)).ok).toBe(true);
  });

  it("checks that envelope data holds count finite levels", () => {
    const envelope = {
      type: "envelope",
      sampleIndex: 160,
      frameSamples: 160,
      count: 3,
      encoding: "f32le-base64",
      data: encodeEnvelopeValues([-120, -50, 0]),
    };
    expect(decodeJsonLine(ManifestRecord, JSON.stringify(envelope)).ok).toBe(true);
    for (const values of [
      [-120, -50],
      [-120, -50, 0.5],
      [-121, -50, 0],
      [-120, Number.NaN, 0],
    ]) {
      const bad = { ...envelope, data: encodeEnvelopeValues(values) };
      expect(issuePaths(decodeJsonLine(ManifestRecord, JSON.stringify(bad)))).toEqual(["data"]);
    }
  });

  it("checks histogram ordering", () => {
    const health = {
      type: "health",
      at,
      windowMs: 60000,
      process: { footprintBytes: 1, cpuNs: 1, wakeups: 1 },
      tracks: [],
      stages: [{ stage: "vad", trackKey: null, count: 2, sum: 10, p50: 6, p95: 5, max: 6 }],
    };
    expect(issuePaths(decodeJsonLine(HelperEvent, JSON.stringify(health)))).toEqual(["stages.0"]);
  });
});

describe("private zones", () => {
  const at = { hostTicks: "1", continuousNs: "1" };
  const key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
  const holds = {
    calls: false,
    screen: false,
    schedule: [{ days: [5, 6], startMinute: 1380, endMinute: 420 }],
    networks: ["156d3845f9cf77804e66d475ef0ed074"],
    networkKey: key,
    lifted: [],
  };
  const config = (changes: Partial<typeof holds> = {}) =>
    JSON.stringify({
      type: "config",
      id: "c",
      microphone: { enabled: true, followCalls: true, allowedTransports: [] },
      systemAudio: {
        enabled: true,
        appTaps: { enabled: true, max: 8, releaseAfterIdleMs: 0, releaseAfterSilenceMs: 0 },
      },
      excludedBundleIds: [],
      holds: { ...holds, ...changes },
      vad: { threshold: 0.5, minSpeechMs: 250, minSilenceMs: 800 },
      healthIntervalMs: 60000,
    });

  it("takes a window across midnight and refuses one that ends where it starts", () => {
    expect(decodeJsonLine(ControlMessage, config()).ok).toBe(true);
    const empty = [{ days: [1], startMinute: 600, endMinute: 600 }];
    expect(issuePaths(decodeJsonLine(ControlMessage, config({ schedule: empty })))).toEqual([
      "holds.schedule.0.endMinute",
    ]);
    const toMidnight = [{ days: [1], startMinute: 1380, endMinute: 1440 }];
    expect(decodeJsonLine(ControlMessage, config({ schedule: toMidnight })).ok).toBe(true);
  });

  it("reads no network without a key, and takes only a 32-byte key", () => {
    expect(decodeJsonLine(ControlMessage, config({ networkKey: "", networks: [] })).ok).toBe(true);
    expect(issuePaths(decodeJsonLine(ControlMessage, config({ networkKey: "" })))).toEqual([
      "holds.networks",
    ]);
    const short = Buffer.alloc(31, 1).toString("base64");
    expect(issuePaths(decodeJsonLine(ControlMessage, config({ networkKey: short })))).toEqual([
      "holds.networkKey",
    ]);
    const long = Buffer.alloc(33, 1).toString("base64");
    expect(decodeJsonLine(ControlMessage, config({ networkKey: long })).ok).toBe(false);
    expect(
      decodeJsonLine(ControlMessage, config({ networkKey: Buffer.alloc(32, 7).toString("base64") }))
        .ok,
    ).toBe(true);
  });

  it("ties a hold's scope and detail to its reason", () => {
    const hold = (fields: Record<string, unknown>) =>
      JSON.stringify({
        type: "holds",
        holds: [
          {
            occurrenceId: "1b5d3f7a-2c4e-4a6b-9d8f-0e1c2b3d4f5a",
            since: at,
            sinceWallMs: 0,
            lifted: false,
            ...fields,
          },
        ],
      });
    expect(decodeJsonLine(HelperEvent, hold({ reason: "screen", scope: "all" })).ok).toBe(true);
    expect(
      decodeJsonLine(HelperEvent, hold({ reason: "app", scope: "microphone", bundleId: "a.b" })).ok,
    ).toBe(true);
    expect(
      issuePaths(decodeJsonLine(HelperEvent, hold({ reason: "screen", scope: "microphone" }))),
    ).toEqual(["holds.0.scope"]);
    expect(
      issuePaths(decodeJsonLine(HelperEvent, hold({ reason: "schedule", scope: "all" }))),
    ).toEqual(["holds.0.window"]);
    expect(
      issuePaths(
        decodeJsonLine(
          HelperEvent,
          hold({ reason: "calls", scope: "all", network: "0".repeat(32) }),
        ),
      ),
    ).toEqual(["holds.0.network"]);
  });

  it("keeps the situation's networks sorted and unique", () => {
    const situation = (networks: string[]) =>
      JSON.stringify({ type: "situation", screenAway: false, networks });
    const [low, high] = ["0".repeat(32), "f".repeat(32)];
    expect(decodeJsonLine(HelperEvent, situation([low, high])).ok).toBe(true);
    expect(issuePaths(decodeJsonLine(HelperEvent, situation([high, low])))).toEqual(["networks.1"]);
    expect(issuePaths(decodeJsonLine(HelperEvent, situation([low, low])))).toEqual(["networks.1"]);
  });
});

/** Deterministic pseudo-random bytes. */
function randomBytes(length: number, seed: number): Uint8Array {
  let state = seed;
  return Uint8Array.from({ length }, () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state >>> 16;
  });
}

describe("binary helpers", () => {
  it("matches zlib's crc32, also when continued across buffers", () => {
    const check = new TextEncoder().encode("123456789");
    expect(crc32(check)).toBe(0xcbf43926);
    expect(crc32(check.subarray(4), crc32(check.subarray(0, 4)))).toBe(0xcbf43926);
    for (const length of [0, 1, 7, 64, 1000, 64_000]) {
      const bytes = randomBytes(length, length + 1);
      expect(crc32(bytes)).toBe(zlibCrc32(bytes));
    }
  });

  it("matches Node's base64 for every padding length", () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = randomBytes(length, length + 99);
      const text = Buffer.from(bytes).toString("base64");
      expect(bytesToBase64(bytes)).toBe(text);
      expect(base64ToBytes(text)).toEqual(bytes);
    }
  });

  it.each(["A", "AB=", "A===", "AB=C", "@@@@", "AAAA=AAA"])("rejects base64 %j", (text) => {
    expect(base64ToBytes(text)).toBeUndefined();
  });
});

describe("robustness", () => {
  const replacements: readonly unknown[] = [
    null,
    -1,
    0,
    1.5,
    2 ** 64,
    "",
    "x",
    "9223372036854775808",
    [],
    [null],
    {},
    true,
  ];

  function mutateRandomly(value: unknown, random: () => number): unknown {
    if (Array.isArray(value)) {
      if (value.length === 0 || random() < 0.2)
        return replacements[Math.floor(random() * replacements.length)];
      const copy = [...value];
      const index = Math.floor(random() * copy.length);
      copy[index] = mutateRandomly(copy[index], random);
      return copy;
    }
    if (typeof value === "object" && value !== null) {
      const entries = Object.entries(value);
      if (entries.length === 0 || random() < 0.2)
        return replacements[Math.floor(random() * replacements.length)];
      const index = Math.floor(random() * entries.length);
      const copy = Object.fromEntries(entries);
      const key = entries[index]?.[0] ?? "";
      if (random() < 0.15) delete copy[key];
      else copy[key] = mutateRandomly(copy[key], random);
      return copy;
    }
    return replacements[Math.floor(random() * replacements.length)];
  }

  it.each([
    ["control-messages.jsonl", ControlMessage],
    ["helper-events.jsonl", HelperEvent],
    ["manifest-records.jsonl", ManifestRecord],
  ] as const)("never throws on mutated %s", (file, schema) => {
    let state = 1234;
    const random = () => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state / 4_294_967_296;
    };
    const text = readFileSync(join(import.meta.dirname, "..", "fixtures", file), "utf8");
    const records: unknown[] = text
      .split("\n")
      .filter((line) => line !== "")
      .map((line): unknown => JSON.parse(line));
    for (let round = 0; round < 2000; round += 1) {
      const record = records[round % records.length];
      const mutated = JSON.stringify(mutateRandomly(mutateRandomly(record, random), random));
      expect(() => decodeJsonLine(schema, mutated)).not.toThrow();
    }
  });
});
