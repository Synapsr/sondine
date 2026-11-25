import { MAX_USAGE_REPORT_BYTES, UsageReport } from "@sondine/protocol";

// stats.sondine.app (ADR 042): receives the daily report of a Mac whose user
// agreed, and passes it to PostHog EU as one event. It reads the method, the
// path, the content type and the body, nothing else of the request: not the
// IP, the country or any other header. It keeps nothing, logs nothing and
// adds nothing about who sent it.

export interface Env {
  /** PostHog's project token (a secret: `wrangler secret put POSTHOG_TOKEN`). */
  readonly POSTHOG_TOKEN?: string;
  /** `no` in development: a report is checked and forwarded nowhere. */
  readonly FORWARD?: string;
  readonly LIMITER?: {
    limit(options: { readonly key: string }): Promise<{ readonly success: boolean }>;
  };
}

export const POSTHOG = "https://eu.i.posthog.com/i/v1/analytics/events";
export const EVENT = "usage_reported";
const PATH = "/v1/report";
/** A Mac drops a report 4 days after its day; a day more for time zones. */
const MAX_AGE_DAYS = 5;

const answer = (status: number) =>
  new Response(null, { status, headers: { "cache-control": "no-store" } });

export async function handle(
  request: Request,
  env: Env,
  options: { readonly send?: typeof fetch; readonly now?: () => number } = {},
): Promise<Response> {
  if (new URL(request.url).pathname !== PATH) return answer(404);
  if (request.method !== "POST") return answer(405);
  if (request.headers.get("content-type") !== "application/json") return answer(415);
  // One key for everyone: a limit per IP would have to read it.
  const allowed = await env.LIMITER?.limit({ key: "reports" });
  if (allowed?.success !== true) return answer(429);
  const body = await readBody(request);
  if (body === null) return answer(413);
  const now = (options.now ?? Date.now)();
  const report = parse(body);
  if (report === null || !recent(report.day, now)) return answer(400);
  if (env.FORWARD === "no") return answer(204);
  if (env.POSTHOG_TOKEN === undefined || env.POSTHOG_TOKEN === "") return answer(503);
  return answer((await forward(report, env.POSTHOG_TOKEN, now, options.send ?? fetch)) ? 204 : 502);
}

/** The body's text, or null past the limit, whatever its announced length. */
async function readBody(request: Request): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_USAGE_REPORT_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parse(body: string): UsageReport | null {
  try {
    const parsed = UsageReport.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A past day somewhere on Earth, not older than a Mac keeps one. */
function recent(day: string, now: number): boolean {
  const age = (now - Date.parse(`${day}T12:00:00.000Z`)) / 86_400_000;
  return age > -1 && age < MAX_AGE_DAYS + 1;
}

/** The report's fields as flat properties, so PostHog can sum and break down each. */
export function properties(report: UsageReport): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {
    report_version: report.v,
    day: report.day,
    app_version: report.app,
    macos: report.macos,
    memory: report.memory,
    installed: report.installed,
    active_days: report.activeDays,
    onboarding: report.onboarding,
    // Not the Worker's place either: no lookup of a place from an address.
    $geoip_disable: true,
  };
  for (const [surface, counts] of Object.entries(report.actions)) {
    for (const [event, times] of Object.entries(counts ?? {})) out[`${surface}.${event}`] = times;
  }
  for (const [code, times] of Object.entries(report.errors)) out[`error.${code}`] = times;
  return out;
}

async function forward(
  report: UsageReport,
  token: string,
  now: number,
  send: typeof fetch,
): Promise<boolean> {
  // PostHog keeps the time it is given (`$sent_at`): it gets the date alone.
  const at = `${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`;
  try {
    // A new request: only these headers, none of the Mac's.
    const response = await send(POSTHOG, {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "sondine-stats",
        "PostHog-Sdk-Info": "sondine-stats/1",
        "PostHog-Request-Id": report.id,
        "PostHog-Attempt": "1",
        "PostHog-Request-Timestamp": at,
      },
      body: JSON.stringify({
        created_at: at,
        batch: [
          {
            event: EVENT,
            // The same for a retry, so PostHog merges them.
            uuid: report.id,
            distinct_id: report.id,
            timestamp: `${report.day}T12:00:00.000Z`,
            options: { process_person_profile: false, disable_skew_correction: true },
            properties: properties(report),
          },
        ],
      }),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return false;
    }
    const result = ((await response.json()) as { results?: Record<string, { result?: string }> })
      .results?.[report.id]?.result;
    return result === "ok" || result === "warning";
  } catch {
    return false;
  }
}
