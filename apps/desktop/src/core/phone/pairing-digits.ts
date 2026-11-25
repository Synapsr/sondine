import { createHash } from "node:crypto";

/**
 * The six digits the Mac and the phone both show while pairing (ADR 008):
 * SHA-256 of `token \n deviceId \n pin` (UTF-8), its first four bytes as a
 * big-endian integer, modulo a million, with leading zeros. The vectors in
 * `packages/protocol/fixtures/vectors/pairing-digits.jsonl` hold Swift and
 * this to the same answer.
 */
export function pairingDigits(token: string, deviceId: string, pin: string): string {
  const digest = createHash("sha256").update(`${token}\n${deviceId}\n${pin}`, "utf8").digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}
