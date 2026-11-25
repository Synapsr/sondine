// Where the anonymous statistics go (ADR 042). The release build compiles the
// endpoint in (`SONDINE_STATS_ENDPOINT`, electron.vite.config.ts); any other
// build has none, and main hands it to core only in a packaged app.

declare const COMPILED_STATS_ENDPOINT: string | undefined;

export const STATS_ENDPOINT = /^https:\/\/[a-z0-9.-]{1,120}\/v1\/report$/u;

export function statsEndpoint(isPackaged: boolean): string | null {
  // Not defined where nothing compiled it in: tests, scripts.
  if (!isPackaged || typeof COMPILED_STATS_ENDPOINT !== "string") return null;
  return STATS_ENDPOINT.test(COMPILED_STATS_ENDPOINT) ? COMPILED_STATS_ENDPOINT : null;
}
