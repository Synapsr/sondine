import type { Event, Region } from "./schema.ts";

export function unionOverlap(
  start: number,
  end: number,
  intervals: readonly (readonly [number, number])[],
) {
  const clipped = intervals
    .map(([a, b]) => [Math.max(start, a), Math.min(end, b)] as const)
    .filter(([a, b]) => b > a)
    .toSorted((a, b) => a[0] - b[0]);
  let total = 0;
  let through = start;
  for (const [a, b] of clipped) {
    total += Math.max(0, b - Math.max(a, through));
    through = Math.max(through, b);
  }
  return total;
}
export function scoreEvent(event: Event, regions: readonly Region[]) {
  const length = event.endSample - event.startSample;
  if (length <= 0) throw new Error("Invalid labelled clip window");
  const captured = unionOverlap(
    event.startSample,
    event.endSample,
    regions.map((region) => [region.startSample, region.endSample]),
  );
  const speechEnvelope = unionOverlap(
    event.startSample,
    event.endSample,
    regions.map((region) => [region.speechStartSample, region.speechEndSample]),
  );
  return {
    ...event,
    capturedSamples: captured,
    labelledClipSamples: length,
    captureOverlap: captured >= Math.min(length, 800),
    wholeClipRetained: captured / length >= 0.95,
    speechEnvelopeOverlap: speechEnvelope >= Math.min(length, 800),
  };
}
export function validateRegions(regions: readonly Region[], sampleCount: number) {
  for (const region of regions) {
    if (
      !(
        region.startSample <= region.speechStartSample &&
        region.speechStartSample < region.speechEndSample &&
        region.speechEndSample <= region.endSample &&
        region.endSample <= sampleCount
      )
    )
      throw new Error("Helper region bounds are inconsistent");
    if (region.voicedMs > (region.speechEndSample - region.speechStartSample) / 16 + 32)
      throw new Error("Helper voiced time exceeds speech envelope");
  }
}
export function perHour(count: number, durationMs: number) {
  if (durationMs <= 0) throw new Error("Rate denominator must be positive");
  return (count * 3_600_000) / durationMs;
}
