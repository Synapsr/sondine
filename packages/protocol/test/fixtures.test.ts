import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
  BROWSER_MESSAGE_TYPES,
  BrowserAnswer,
  BrowserHello,
  BrowserMessage,
  CONTROL_MESSAGE_TYPES,
  ControlMessage,
  HELPER_EVENT_TYPES,
  HelperEvent,
  MANIFEST_RECORD_TYPES,
  NOTCH_COMMAND_TYPES,
  NOTCH_EVENT_TYPES,
  ManifestEnvelope,
  ManifestRecord,
  NetworkHash,
  NetworkKey,
  NotchCommand,
  NotchEvent,
  PHONE_SYNC_SCHEMAS,
  PairingInvite,
  PhoneRecordingHeader,
  type PhoneSyncSchemaName,
  crc32,
  formatPairingUrl,
  parsePairingUrl,
  decodeEnvelopeValues,
  decodeJsonLines,
  encodeJsonLine,
  envelopeValues,
  parsePhoneRecordingHeader,
} from "../src";

const fixturesDir = join(import.meta.dirname, "..", "fixtures");

const contracts = [
  { file: "browser-messages.jsonl", schema: BrowserMessage, types: BROWSER_MESSAGE_TYPES },
  { file: "control-messages.jsonl", schema: ControlMessage, types: CONTROL_MESSAGE_TYPES },
  { file: "helper-events.jsonl", schema: HelperEvent, types: HELPER_EVENT_TYPES },
  { file: "manifest-records.jsonl", schema: ManifestRecord, types: MANIFEST_RECORD_TYPES },
  { file: "notch-commands.jsonl", schema: NotchCommand, types: NOTCH_COMMAND_TYPES },
  { file: "notch-events.jsonl", schema: NotchEvent, types: NOTCH_EVENT_TYPES },
] as const;

function read(...path: string[]): string {
  return readFileSync(join(fixturesDir, ...path), "utf8");
}

function nonBlankLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

function jsonlFiles(...path: string[]): string[] {
  return readdirSync(join(fixturesDir, ...path))
    .filter((name) => name.endsWith(".jsonl"))
    .toSorted();
}

describe("fixture layout", () => {
  it("has exactly one valid and one invalid file per contract", () => {
    const expected = contracts.map((contract) => contract.file).toSorted();
    expect(jsonlFiles()).toEqual(expected);
    expect(jsonlFiles("invalid")).toEqual(expected);
  });
});

describe.each(contracts)("$file", ({ file, schema, types }) => {
  const text = read(file);
  const results = decodeJsonLines(schema, text);

  it("parses every valid line", () => {
    const failures = results.flatMap((result) =>
      result.ok ? [] : [{ line: result.line, error: result.error }],
    );
    expect(failures).toEqual([]);
    expect(results).toHaveLength(nonBlankLines(text).length);
  });

  it("covers every type", () => {
    const seen = new Set(results.flatMap((result) => (result.ok ? [result.value.type] : [])));
    expect([...types].filter((type) => !seen.has(type))).toEqual([]);
  });

  it("round-trips every line through decode and encode", () => {
    const lines = nonBlankLines(text);
    results.forEach((result, index) => {
      if (!result.ok) throw new Error(`line ${result.line} did not parse`);
      const encoded = encodeJsonLine(schema, result.value);
      if (!encoded.ok) throw new Error(`line ${result.line}: ${encoded.error.message}`);
      expect(JSON.parse(encoded.line)).toEqual(JSON.parse(lines[index] ?? ""));
    });
  });

  it("rejects every invalid line", () => {
    const invalidText = read("invalid", file);
    const invalid = decodeJsonLines(schema, invalidText);
    expect(invalid).toHaveLength(nonBlankLines(invalidText).length);
    const accepted = invalid.filter((result) => result.ok).map((result) => result.line);
    expect(accepted).toEqual([]);
  });
});

describe("browser handshake", () => {
  const Handshake = z.union([BrowserHello, BrowserAnswer]);

  it("parses every valid line and rejects every invalid one", () => {
    const valid = decodeJsonLines(Handshake, read("handshake", "valid.jsonl"));
    expect(valid.filter((result) => !result.ok).map((result) => result.line)).toEqual([]);
    expect(valid).toHaveLength(nonBlankLines(read("handshake", "valid.jsonl")).length);
    const invalid = decodeJsonLines(Handshake, read("handshake", "invalid.jsonl"));
    expect(invalid.filter((result) => result.ok).map((result) => result.line)).toEqual([]);
    expect(invalid).toHaveLength(nonBlankLines(read("handshake", "invalid.jsonl")).length);
  });
});

describe("phone recording header", () => {
  it("parses every valid header and rejects every invalid one", () => {
    const valid = decodeJsonLines(PhoneRecordingHeader, read("phone", "header-valid.jsonl"));
    expect(valid.filter((result) => !result.ok).map((result) => result.line)).toEqual([]);
    expect(valid).toHaveLength(nonBlankLines(read("phone", "header-valid.jsonl")).length);
    const invalid = decodeJsonLines(PhoneRecordingHeader, read("phone", "header-invalid.jsonl"));
    expect(invalid.filter((result) => result.ok).map((result) => result.line)).toEqual([]);
    expect(invalid).toHaveLength(nonBlankLines(read("phone", "header-invalid.jsonl")).length);
  });

  it("is read from a comment tag's text, or not at all", () => {
    const [line = ""] = nonBlankLines(read("phone", "header-valid.jsonl"));
    expect(parsePhoneRecordingHeader(line)).toMatchObject({ part: 1, previous: null });
    expect(parsePhoneRecordingHeader(null)).toBeNull();
    expect(parsePhoneRecordingHeader("Enregistré avec Dictaphone")).toBeNull();
    expect(
      parsePhoneRecordingHeader(`${line.slice(0, -1)},"pad":"${"x".repeat(5000)}"}`),
    ).toBeNull();
    for (const bad of nonBlankLines(read("phone", "header-invalid.jsonl"))) {
      expect(parsePhoneRecordingHeader(bad), bad).toBeNull();
    }
  });
});

describe("binary vectors", () => {
  const CrcVector = z.strictObject({ name: z.string(), bytes: z.base64(), crc32: z.int() });
  const EnvelopeVector = z.strictObject({ data: z.base64(), values: z.array(z.number()) });

  it("matches the CRC-32 vectors", () => {
    for (const result of decodeJsonLines(CrcVector, read("vectors", "crc32.jsonl"))) {
      if (!result.ok) throw new Error(`crc32 vector line ${result.line} is malformed`);
      const bytes = Uint8Array.from(Buffer.from(result.value.bytes, "base64"));
      expect(crc32(bytes), result.value.name).toBe(result.value.crc32);
    }
  });

  it("matches the network hash vectors (HMAC-SHA256, first 16 bytes)", () => {
    const NetworkVector = z.strictObject({
      key: z.base64(),
      signature: z.string(),
      hash: NetworkHash,
    });
    const vectors = decodeJsonLines(NetworkVector, read("vectors", "network-hash.jsonl"));
    expect(vectors.length).toBeGreaterThan(0);
    for (const result of vectors) {
      if (!result.ok) throw new Error(`network vector line ${result.line} is malformed`);
      const { key, signature, hash } = result.value;
      expect(NetworkKey.safeParse(key).success).toBe(true);
      const mac = createHmac("sha256", Buffer.from(key, "base64")).update(signature, "utf8");
      expect(mac.digest("hex").slice(0, 32)).toBe(hash);
    }
  });

  it("matches the envelope vectors", () => {
    for (const result of decodeJsonLines(EnvelopeVector, read("vectors", "envelope.jsonl"))) {
      if (!result.ok) throw new Error(`envelope vector line ${result.line} is malformed`);
      expect([...(decodeEnvelopeValues(result.value.data) ?? [])]).toEqual(result.value.values);
    }
  });

  it("decodes the manifest envelope fixture", () => {
    const envelope = decodeJsonLines(ManifestRecord, read("manifest-records.jsonl")).find(
      (result) => result.ok && result.value.type === "envelope",
    );
    if (envelope === undefined || !envelope.ok) throw new Error("no envelope fixture");
    const record = ManifestEnvelope.parse(z.encode(ManifestRecord, envelope.value));
    expect([...envelopeValues(record)]).toEqual([-120, -60.5, -30.25, -12]);
  });
});

describe("phone sync messages", () => {
  const lines = (file: string) =>
    nonBlankLines(read("phone", file)).map((line) => {
      const { schema, value } = z
        .strictObject({ schema: z.enum(Object.keys(PHONE_SYNC_SCHEMAS)), value: z.unknown() })
        .parse(JSON.parse(line));
      return { name: schema, schema: PHONE_SYNC_SCHEMAS[schema as PhoneSyncSchemaName], value };
    });

  it("accepts every valid fixture and covers every message", () => {
    const valid = lines("sync-valid.jsonl");
    for (const { name, schema, value } of valid) {
      expect(schema.safeParse(value).success, `${name}: ${JSON.stringify(value)}`).toBe(true);
    }
    expect(new Set(valid.map((line) => line.name))).toEqual(
      new Set(Object.keys(PHONE_SYNC_SCHEMAS)),
    );
  });

  it("refuses every invalid fixture", () => {
    for (const { name, schema, value } of lines("sync-invalid.jsonl")) {
      expect(schema.safeParse(value).success, `${name}: ${JSON.stringify(value)}`).toBe(false);
    }
  });

  it("writes and reads the pairing QR", () => {
    const [first] = lines("sync-valid.jsonl");
    const invite = PairingInvite.parse(first?.value);
    expect(parsePairingUrl(formatPairingUrl(invite))).toEqual(invite);
    expect(parsePairingUrl("https://example.com")).toBeNull();
    expect(parsePairingUrl(formatPairingUrl(invite).replace("v=1", "v=2"))).toBeNull();
  });

  it("matches the pairing digits vectors", () => {
    for (const line of nonBlankLines(read("vectors", "pairing-digits.jsonl"))) {
      const row = z
        .strictObject({
          token: z.string(),
          deviceId: z.string(),
          pin: z.string(),
          digits: z.string(),
        })
        .parse(JSON.parse(line));
      const digest = createHash("sha256")
        .update(`${row.token}\n${row.deviceId}\n${row.pin}`, "utf8")
        .digest();
      expect(String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0")).toBe(row.digits);
    }
  });
});
