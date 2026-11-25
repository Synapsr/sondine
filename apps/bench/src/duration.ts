const units: Readonly<Record<string, number>> = { s: 1, m: 60, min: 60, h: 3600 };

/** "30m", "8h", "1h30m", "90s" or plain seconds ("45") → seconds. */
export function parseDuration(text: string): number {
  const trimmed = text.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const pattern = /(\d+(?:\.\d+)?)(h|min|m|s)/gy;
  let seconds = 0;
  let consumed = 0;
  for (const match of trimmed.matchAll(pattern)) {
    seconds += Number(match[1]) * (units[match[2] ?? ""] ?? Number.NaN);
    consumed = (match.index ?? 0) + match[0].length;
  }
  if (consumed !== trimmed.length || trimmed.length === 0 || !Number.isFinite(seconds)) {
    throw new Error(`invalid duration "${text}" (use 90s, 30m, 8h or 1h30m)`);
  }
  return seconds;
}
