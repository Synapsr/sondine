import { MAX_USAGE_REPORT_BYTES, USAGE_EXAMPLE } from "@sondine/protocol";
import { describe, expect, it, vi } from "vitest";
import { EVENT, handle, POSTHOG, properties, type Env } from "../src/report";
import * as entry from "../src/worker";

const NOW = Date.parse("2026-11-25T15:04:05.678Z");
const TOKEN = "phc_test";
const open: Env = { POSTHOG_TOKEN: TOKEN, LIMITER: { limit: async () => ({ success: true }) } };

/** What a Mac sends, with what Cloudflare and a browser may add to it. */
function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://stats.sondine.app/v1/report", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Sondine",
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "203.0.113.7",
      "x-real-ip": "203.0.113.7",
      "cf-ipcountry": "FR",
      "accept-language": "fr-FR",
      cookie: "a=b",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function posthog(result: unknown = { results: { [USAGE_EXAMPLE.id]: { result: "ok" } } }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const send = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(result);
  }) as typeof fetch;
  return { calls, options: { send, now: () => NOW } };
}

describe("stats.sondine.app", () => {
  it("passes a report on as one event, without a person, a place, or anything of the request", async () => {
    const { calls, options } = posthog();
    const response = await handle(post(USAGE_EXAMPLE), open, options);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(POSTHOG);
    expect(new URL(POSTHOG).hostname).toBe("eu.i.posthog.com");
    expect(call?.init.redirect).toBe("manual");
    expect(Object.keys(call?.init.headers ?? {}).toSorted()).toEqual([
      "Authorization",
      "Content-Type",
      "PostHog-Attempt",
      "PostHog-Request-Id",
      "PostHog-Request-Timestamp",
      "PostHog-Sdk-Info",
      "User-Agent",
    ]);
    const sent = `${JSON.stringify(call?.init.headers)}${String(call?.init.body)}`;
    // Not the time of sending either: PostHog would keep it.
    expect(sent).not.toContain("15:04");
    for (const trace of ["203.0.113.7", "FR", "fr-FR", "a=b", "cf-", "cookie"]) {
      expect(sent, trace).not.toContain(trace);
    }
    expect(JSON.parse(String(call?.init.body))).toEqual({
      created_at: "2026-11-25T00:00:00.000Z",
      batch: [
        {
          event: EVENT,
          uuid: USAGE_EXAMPLE.id,
          distinct_id: USAGE_EXAMPLE.id,
          timestamp: "2026-11-24T12:00:00.000Z",
          options: { process_person_profile: false, disable_skew_correction: true },
          properties: {
            report_version: 1,
            day: "2026-11-24",
            app_version: "0.7.0",
            macos: "27.0",
            memory: "32plus",
            installed: "7-13",
            active_days: 5,
            onboarding: "done",
            $geoip_disable: true,
            "desktop.conversation_opened": 5,
            "desktop.speaker_named": 1,
            "desktop.transcripts_searched": 2,
            "desktop.window_opened": 3,
            "mcp.transcripts_searched": 3,
            "error.transcription_deadline": 1,
          },
        },
      ],
    });
  });

  it("gives a retry the same event, so PostHog merges them", async () => {
    const first = posthog();
    const second = posthog();
    await handle(post(USAGE_EXAMPLE), open, first.options);
    await handle(post(USAGE_EXAMPLE), open, {
      ...second.options,
      now: () => NOW + 6 * 3_600_000,
    });
    const event = (calls: typeof first.calls) =>
      (JSON.parse(String(calls[0]?.init.body)) as { batch: unknown[] }).batch;
    expect(event(first.calls)).toEqual(event(second.calls));
  });

  it("refuses anything that is not exactly a recent report, and sends nothing on", async () => {
    const { calls, options } = posthog();
    const refused: [Request, number][] = [
      [post({ ...USAGE_EXAMPLE, email: "camille@exemple.fr" }), 400],
      [post({ ...USAGE_EXAMPLE, actions: { desktop: { Réunion: 1 } } }), 400],
      [post({ ...USAGE_EXAMPLE, v: 2 }), 400],
      [post({ ...USAGE_EXAMPLE, day: "2026-11-01" }), 400],
      [post({ ...USAGE_EXAMPLE, day: "2026-11-27" }), 400],
      [post("not json"), 400],
      [post(""), 400],
      [post([USAGE_EXAMPLE]), 400],
      [post("x".repeat(MAX_USAGE_REPORT_BYTES + 1)), 413],
      [post(USAGE_EXAMPLE, { "content-type": "text/plain" }), 415],
      [new Request("https://stats.sondine.app/v1/report"), 405],
      [new Request("https://stats.sondine.app/v1/report", { method: "OPTIONS" }), 405],
      [new Request("https://stats.sondine.app/"), 404],
      [new Request("https://stats.sondine.app/v1/report/x", { method: "POST" }), 404],
    ];
    for (const [request, status] of refused) {
      expect((await handle(request, open, options)).status, request.url).toBe(status);
    }
    expect(calls).toEqual([]);
  });

  it("stops a body past the limit without reading the rest", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(8 * 1024));
      },
    });
    const request = new Request("https://stats.sondine.app/v1/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: endless,
      duplex: "half",
    } as RequestInit);
    expect((await handle(request, open, posthog().options)).status).toBe(413);
    expect(pulled).toBeLessThan(6);
  });

  it("limits everyone together, never by address, and refuses without a limiter", async () => {
    const keys: string[] = [];
    const { calls, options } = posthog();
    const busy: Env = {
      POSTHOG_TOKEN: TOKEN,
      LIMITER: {
        limit: async ({ key }) => {
          keys.push(key);
          return { success: false };
        },
      },
    };
    expect((await handle(post(USAGE_EXAMPLE), busy, options)).status).toBe(429);
    expect(keys).toEqual(["reports"]);
    expect((await handle(post(USAGE_EXAMPLE), { POSTHOG_TOKEN: TOKEN }, options)).status).toBe(429);
    expect(calls).toEqual([]);
  });

  it("says 204 only once PostHog took the event", async () => {
    const results: [unknown, number][] = [
      [{ results: { [USAGE_EXAMPLE.id]: { result: "ok" } } }, 204],
      [{ results: { [USAGE_EXAMPLE.id]: { result: "warning" } } }, 204],
      [{ results: { [USAGE_EXAMPLE.id]: { result: "drop" } } }, 502],
      [{ results: { [USAGE_EXAMPLE.id]: { result: "retry" } } }, 502],
      [{ results: {} }, 502],
      ["oops", 502],
    ];
    for (const [result, status] of results) {
      const { options } = posthog(result);
      expect((await handle(post(USAGE_EXAMPLE), open, options)).status).toBe(status);
    }
    for (const down of [
      async () => new Response(null, { status: 302, headers: { location: "https://x.test" } }),
      async () => new Response("no", { status: 500 }),
      async () => Promise.reject(new TypeError("down")),
    ]) {
      const options = { send: down as typeof fetch, now: () => NOW };
      expect((await handle(post(USAGE_EXAMPLE), open, options)).status).toBe(502);
    }
  });

  it("forwards nothing in development, nor without a token", async () => {
    const { calls, options } = posthog();
    const dev: Env = { ...open, FORWARD: "no" };
    expect((await handle(post(USAGE_EXAMPLE), dev, options)).status).toBe(204);
    const bare: Env = { LIMITER: { limit: async () => ({ success: true }) } };
    expect((await handle(post(USAGE_EXAMPLE), bare, options)).status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("logs nothing", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    await handle(post(USAGE_EXAMPLE), open, posthog().options);
    await handle(post("no"), open, posthog().options);
    await handle(post(USAGE_EXAMPLE), open, posthog("oops").options);
    await entry.default.fetch(new Request("https://stats.sondine.app/"), open);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it("exports only its handler: workerd refuses to start on anything else", () => {
    expect(Object.keys(entry)).toEqual(["default"]);
  });

  it("flattens nothing but the report's own fields", () => {
    const keys = Object.keys(properties(USAGE_EXAMPLE));
    expect(keys.filter((key) => key.startsWith("$"))).toEqual(["$geoip_disable"]);
  });
});
