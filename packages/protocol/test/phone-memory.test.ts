import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
  PHONE_ALL_ROUTES,
  PHONE_MEMORY_ROUTES,
  PHONE_MEMORY_SCHEMAS,
  PHONE_ROUTES,
  type PhoneMemorySchemaName,
} from "../src";

// The phone's live reads of the Mac's memory (M5.4): golden fixtures shared
// with Swift (`native/Tests/SondinePhoneTests`).

const lines = (file: string) =>
  readFileSync(join(import.meta.dirname, "..", "fixtures", "phone", file), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const { schema, value } = z
        .strictObject({ schema: z.enum(Object.keys(PHONE_MEMORY_SCHEMAS)), value: z.unknown() })
        .parse(JSON.parse(line));
      return {
        name: schema,
        schema: PHONE_MEMORY_SCHEMAS[schema as PhoneMemorySchemaName],
        value,
      };
    });

describe("phone memory reads", () => {
  it("accepts every valid fixture and covers every message", () => {
    const valid = lines("memory-valid.jsonl");
    for (const { name, schema, value } of valid) {
      expect(schema.safeParse(value).success, `${name}: ${JSON.stringify(value)}`).toBe(true);
    }
    expect(new Set(valid.map((line) => line.name))).toEqual(
      new Set(Object.keys(PHONE_MEMORY_SCHEMAS)),
    );
  });

  it("refuses every invalid fixture", () => {
    for (const { name, schema, value } of lines("memory-invalid.jsonl")) {
      expect(schema.safeParse(value).success, `${name}: ${JSON.stringify(value)}`).toBe(false);
    }
  });

  it("names each route once, apart from the sync's", () => {
    const paths = Object.values(PHONE_ALL_ROUTES).map((route) => route.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const route of Object.values(PHONE_MEMORY_ROUTES)) {
      expect(route.path).toMatch(/^\/v1\/memory\/[a-z]+$/);
    }
    expect(Object.keys(PHONE_ALL_ROUTES)).toHaveLength(
      Object.keys(PHONE_ROUTES).length + Object.keys(PHONE_MEMORY_ROUTES).length,
    );
  });
});
