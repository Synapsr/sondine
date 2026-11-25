import { urlAllowed, type DownloadPolicy } from "@sondine/engines";
import {
  isNewer,
  LATEST_UPDATE_FEED,
  releasePage,
  UPDATE_HOSTS,
  UpdateFeed,
} from "../../shared/updates";

// The update check (ADR 002, ADR 045): one small public file of the newest
// release on GitHub, which github.com redirects to its own storage. No API,
// so no quota shared by everyone behind one address. A generic user agent,
// and nothing about the user or the Mac.

export type ReleaseAnswer =
  | { readonly ok: true; readonly feed: UpdateFeed }
  | { readonly ok: false; readonly problem: "network" | "refused" | "bad_response" };

/** Only GitHub's hosts, for the file and for the archive (ADR 045). */
export const UPDATE_POLICY: DownloadPolicy = {
  protocols: ["https:"],
  hosts: { "github.com": UPDATE_HOSTS.map((host) => ({ host })) },
  maxRedirects: 5,
};

/** A test build's own server (shared/updates.ts). */
const TEST_POLICY: DownloadPolicy = {
  protocols: ["http:"],
  hosts: { "127.0.0.1": [{ host: "127.0.0.1" }] },
  maxRedirects: 1,
};

export const updatePolicy = (testFeed: string | null) =>
  testFeed === null ? UPDATE_POLICY : TEST_POLICY;

export const UPDATE_USER_AGENT = "Sondine";

const TIMEOUT_MS = 15_000;
const MAX_FEED_BYTES = 16 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** GitHub refuses to answer for now, as it does an address that asked too much. */
const refusals = new Set([401, 403, 429, 451]);

export async function latestRelease(
  fetchImpl: typeof fetch = fetch,
  options: {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly testFeed?: string | null;
  } = {},
): Promise<ReleaseAnswer> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
  const testFeed = options.testFeed ?? null;
  const policy = updatePolicy(testFeed);
  const first = new URL(testFeed ?? LATEST_UPDATE_FEED);
  let url = first;
  let text: string | null;
  try {
    for (let hop = 0; ; hop += 1) {
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": UPDATE_USER_AGENT },
        redirect: "manual",
        signal,
      });
      if (REDIRECTS.has(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        const next = location === null ? null : URL.parse(location, url);
        if (hop >= policy.maxRedirects || next === null || !urlAllowed(next, first, policy)) {
          return { ok: false, problem: "bad_response" };
        }
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, problem: refusals.has(response.status) ? "refused" : "bad_response" };
      }
      text = await limitedText(response, MAX_FEED_BYTES);
      break;
    }
  } catch {
    return { ok: false, problem: "network" };
  }
  const feed = text === null ? null : parseFeed(text);
  return feed === null ? { ok: false, problem: "bad_response" } : { ok: true, feed };
}

/** The body, or null past `limit` bytes. */
async function limitedText(response: Response, limit: number): Promise<string | null> {
  if (response.body === null) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseFeed(text: string): UpdateFeed | null {
  try {
    const parsed = UpdateFeed.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The release worth showing, from the newest version named: later than this app's, or none. */
export function availableRelease(
  latest: string | null,
  current: string,
): { readonly version: string; readonly url: string } | null {
  return latest !== null && isNewer(latest, current)
    ? { version: latest, url: releasePage(latest) }
    : null;
}
