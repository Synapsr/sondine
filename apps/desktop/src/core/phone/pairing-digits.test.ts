import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { pairingDigits } from "./pairing-digits";

const Vector = z.object({
  token: z.string(),
  deviceId: z.string(),
  pin: z.string(),
  digits: z.string(),
});
const vectors = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../../../packages/protocol/fixtures/vectors/pairing-digits.jsonl",
  ),
  "utf8",
)
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => Vector.parse(JSON.parse(line)));

describe("pairing digits", () => {
  it("match the vectors Swift is held to", () => {
    expect(vectors.length).toBeGreaterThan(0);
    for (const vector of vectors) {
      expect(pairingDigits(vector.token, vector.deviceId, vector.pin), vector.token).toBe(
        vector.digits,
      );
    }
  });
});
