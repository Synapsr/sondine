import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tagKey, tagName } from "./tags";

// The same fixtures as Swift's TagName tests (ADR 039).
const fixtures = readFileSync(
  join(import.meta.dirname, "../../../protocol/fixtures/vectors/tag-names.jsonl"),
  "utf8",
)
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as { typed: string; name: string | null; key?: string });

describe("tag names", () => {
  it.each(fixtures)("$typed", ({ typed, name, key }) => {
    expect(tagName(typed)).toBe(name);
    if (name !== null) expect(tagKey(name)).toBe(key);
  });
});
