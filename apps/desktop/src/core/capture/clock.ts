import type { ClockAnchor, ClockPoint } from "@sondine/protocol";

const NS_PER_MS = 1_000_000n;
const NS_PER_US = 1_000n;

/** A helper clock value as a JavaScript number; refuses values past 2^53. */
function safeNumber(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`${field} ${value} does not fit in a double`);
  }
  return Number(value);
}

/** Wall-clock ms of `point`, placed on the wall clock through `anchor` (continuous time). */
export function wallMsAt(point: ClockPoint, anchor: ClockAnchor): number {
  const wallNs = anchor.wallNs + (point.continuousNs - anchor.continuousNs);
  return safeNumber(wallNs / NS_PER_MS, "wall ms");
}

export function anchorWallMs(anchor: ClockAnchor): number {
  return safeNumber(anchor.wallNs / NS_PER_MS, "anchor wall ms");
}

/** The database stores monotonic clocks in microseconds (see packages/db). */
export function continuousUs(point: { continuousNs: bigint }): number {
  return safeNumber(point.continuousNs / NS_PER_US, "continuous us");
}
