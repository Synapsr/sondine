import { resolve } from "node:path";
import {
  openDatabase,
  saveUsageState,
  setUsageConsent,
  usageConsent,
  usageState,
} from "@sondine/db";
import { USAGE_REPORT_VERSION, UsageReport } from "@sondine/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Usage, type UsageDeps } from "./usage";
import { dayOf, daysBetween, startOfDay } from "./usage-days";
import { sendReport } from "./usage-send";

// The rules of the anonymous statistics (ADR 042), on an in-memory database
// and a clock the tests set. `sent` is everything that would have left.

const migrationsFolder = resolve(import.meta.dirname, "../../../../../packages/db/drizzle");
const ENDPOINT = "https://stats.example/v1/report";
const HOUR = 3_600_000;

const opened: Usage[] = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  for (const usage of opened.splice(0)) await usage.close();
  vi.useRealTimers();
});

/** 10:00 on a day, in the Mac's time zone. */
const at = (day: string, hour = 10) => startOfDay(day) + hour * HOUR;

function setup(
  options: {
    readonly answer?: "yes" | "no";
    readonly version?: number;
    readonly endpoint?: string | null;
    readonly installed?: string;
    readonly send?: UsageDeps["send"];
  } = {},
) {
  const db = openDatabase(":memory:", { migrationsFolder });
  let now = at("2026-11-24");
  const sent: UsageReport[] = [];
  const asked = vi.fn<UsageDeps["send"]>(async (_endpoint, report) => {
    sent.push(UsageReport.parse(JSON.parse(JSON.stringify(report))));
    return true;
  });
  if (options.installed !== undefined) {
    db.statement(
      "INSERT INTO settings (key, value, updated_at_ms) VALUES ('onboarding', ?, 0)",
    ).run(
      JSON.stringify({
        origin: "first-run",
        step: "start",
        startedAtMs: at(options.installed),
        completedAtMs: at(options.installed),
      }),
    );
  }
  if (options.answer !== undefined) {
    setUsageConsent(db, {
      answer: options.answer,
      version: options.version ?? USAGE_REPORT_VERSION,
      atMs: now,
    });
  }
  const open = (): Usage => {
    const usage = new Usage({
      db,
      appVersion: "0.7.0",
      macosVersion: "27.0.1",
      memoryBytes: 32 * 1024 ** 3,
      endpoint: options.endpoint === undefined ? ENDPOINT : options.endpoint,
      send: options.send ?? asked,
      now: () => now,
      random: () => 0.5,
      log: () => undefined,
    });
    opened.push(usage);
    usage.start();
    return usage;
  };
  const usage = open();
  const did = (event: string, surface: "desktop" | "mcp" | "mobile" = "desktop", on = usage) => {
    const begun = on.begin();
    if (begun !== null) on.succeeded(begun, surface, event);
  };
  return {
    db,
    usage,
    open,
    did,
    sent,
    asked,
    goTo: (ms: number) => {
      now = ms;
      vi.setSystemTime(ms);
    },
    now: () => now,
  };
}

const days = (n: number) => ({ 0: "24", 1: "25", 2: "26", 3: "27", 4: "28", 5: "29", 6: "30" })[n];

describe("without a yes", () => {
  it.each([
    ["no answer", {}],
    ["a no", { answer: "no" }],
    ["a yes to an older question", { answer: "yes", version: USAGE_REPORT_VERSION - 1 }],
  ] as const)("%s: counts nothing, keeps nothing, sends nothing, sets no timer", async (_, o) => {
    const { db, usage, did, asked, goTo } = setup(o);
    expect(usage.begin()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    did("conversation_opened");
    usage.succeeded(0, "desktop", "conversation_opened");
    usage.error("core_crashed");
    for (let day = 0; day < 6; day += 1) {
      goTo(at(`2026-11-${days(day)}`, 23));
      await usage.look();
    }
    await vi.advanceTimersByTimeAsync(5 * 24 * HOUR);
    expect(asked).not.toHaveBeenCalled();
    expect(usageState(db)).toBeNull();
    expect(usage.status().today).toBeNull();
    expect(usage.status().answer).toBe("answer" in o && o.answer === "no" ? "no" : null);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deletes what an older question, or a crash, left behind", () => {
    const { db, open } = setup({ answer: "no" });
    saveUsageState(
      db,
      { days: {}, activeDays: ["2026-11-20"], closedThrough: null, waiting: [] },
      0,
    );
    open();
    expect(usageState(db)).toBeNull();
  });
});

describe("with a yes", () => {
  it("counts by surface, rounds, and shows today's report exactly as it would leave", () => {
    const { usage, did } = setup({ answer: "yes" });
    for (let n = 0; n < 4; n += 1) did("conversation_opened");
    did("transcripts_searched", "mcp");
    did("day_viewed", "mobile");
    // Polled by the window, unknown, or of a surface that cannot: nothing.
    did("day_viewed");
    did("status_watched");
    did("episode_deleted", "mcp");
    did("une phrase dite");
    usage.error("transcription_deadline");
    const { today, waiting } = usage.status();
    expect(waiting).toEqual([]);
    expect(today).toEqual({
      v: 1,
      id: today?.id,
      day: "2026-11-24",
      app: "0.7.0",
      macos: "27.0",
      memory: "32plus",
      installed: "0",
      activeDays: null,
      onboarding: "welcome",
      actions: {
        desktop: { conversation_opened: 3 },
        mcp: { transcripts_searched: 1 },
        mobile: { day_viewed: 1 },
      },
      errors: { transcription_deadline: 1 },
    });
  });

  it("makes reads less than a minute apart one, and keeps distinct actions", () => {
    const { usage, did, goTo, now } = setup({ answer: "yes" });
    for (let n = 0; n < 5; n += 1) {
      did("transcripts_searched");
      did("tag_set");
      goTo(now() + 20_000);
    }
    goTo(now() + 61_000);
    did("transcripts_searched");
    expect(usage.status().today?.actions.desktop).toEqual({ tag_set: 5, transcripts_searched: 2 });
  });

  it("counts a day's first read however close to the last of the day before", () => {
    const { usage, did, goTo } = setup({ answer: "yes", installed: "2026-10-01" });
    goTo(startOfDay("2026-11-25") - 10_000);
    did("window_opened");
    goTo(startOfDay("2026-11-25") + 10_000);
    did("window_opened");
    expect(usage.status().today).toMatchObject({
      day: "2026-11-25",
      actions: { desktop: { window_opened: 1 } },
    });
  });

  it("sends one report a past day, at a random moment of the next one, once", async () => {
    const { usage, did, sent, goTo } = setup({ answer: "yes" });
    did("conversation_opened");
    await usage.look();
    expect(sent).toEqual([]);
    // Closed at the first look of the 25th; due at its middle (random is 0.5).
    goTo(at("2026-11-25", 1));
    await usage.look();
    const [waiting] = usage.status().waiting;
    expect(waiting?.day).toBe("2026-11-24");
    goTo(at("2026-11-25", 11));
    await usage.look();
    expect(sent).toEqual([]);
    goTo(at("2026-11-25", 13));
    await usage.look();
    expect(sent).toEqual([waiting]);
    goTo(at("2026-11-25", 23));
    await usage.look();
    expect(sent).toHaveLength(1);
    expect(usage.status().waiting).toEqual([]);
  });

  it("gives each day its own id, and keeps it across a retry and a relaunch", async () => {
    let reachable = false;
    const ids: string[] = [];
    const { usage, open, did, goTo } = setup({
      answer: "yes",
      send: async (_endpoint, report) => {
        ids.push(report.id);
        return reachable;
      },
    });
    did("conversation_opened");
    goTo(at("2026-11-25", 13));
    await usage.look();
    await usage.look();
    expect(ids).toHaveLength(1);
    await usage.close();
    const again = open();
    goTo(at("2026-11-25", 18));
    await again.look();
    expect(ids).toHaveLength(1);
    reachable = true;
    goTo(at("2026-11-25", 20));
    await again.look();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    goTo(at("2026-11-26", 20));
    await again.look();
    expect(ids).toHaveLength(3);
    expect(ids[2]).not.toBe(ids[1]);
  });

  it("drops a report four days after its day, unsent", async () => {
    const { usage, did, goTo, asked } = setup({ answer: "yes", endpoint: null });
    did("conversation_opened");
    goTo(at("2026-11-25"));
    await usage.look();
    expect(usage.status().waiting).toHaveLength(1);
    goTo(at("2026-11-29"));
    await usage.look();
    expect(usage.status().waiting.map((report) => report.day)).not.toContain("2026-11-24");
    expect(asked).not.toHaveBeenCalled();
  });

  it("never sends without the build's endpoint", async () => {
    const { usage, did, goTo, asked } = setup({ answer: "yes", endpoint: null });
    for (let day = 0; day < 6; day += 1) {
      goTo(at(`2026-11-${days(day)}`));
      did("conversation_opened");
      await usage.look();
    }
    await vi.advanceTimersByTimeAsync(3 * 24 * HOUR);
    expect(asked).not.toHaveBeenCalled();
    expect(usage.status().sends).toBe(false);
  });

  it("asks the stored consent again right before sending", async () => {
    const { db, usage, did, goTo, asked } = setup({ answer: "yes" });
    did("conversation_opened");
    goTo(at("2026-11-25", 13));
    db.statement("DELETE FROM settings WHERE key = 'usage.consent'").run();
    await usage.look();
    expect(asked).not.toHaveBeenCalled();
  });

  it("is active with an act of the user, on this Mac or a phone, never of an agent", async () => {
    const { usage, did, goTo } = setup({ answer: "yes", installed: "2026-10-01" });
    const acts: [string, "desktop" | "mcp" | "mobile"][] = [
      ["window_opened", "desktop"],
      ["transcripts_searched", "mcp"],
      ["day_viewed", "mobile"],
      ["conversation_opened", "desktop"],
      ["status_viewed", "mcp"],
      ["tag_set", "desktop"],
    ];
    for (const [index, [event, surface]] of acts.entries()) {
      goTo(at(`2026-11-${days(index)}`));
      did(event, surface);
      expect(usage.status().today?.activeDays).toBeNull();
    }
    // A week after the yes: the 25th to the 1st, active on the 26th, 27th and 29th.
    goTo(at("2026-12-01"));
    usage.error("helper_crashed");
    expect(usage.status().today).toMatchObject({ activeDays: 3, installed: "28-89" });
  });

  it("adds nothing to a day already closed when the clock goes back", async () => {
    const { usage, did, goTo, sent } = setup({ answer: "yes" });
    did("conversation_opened");
    goTo(at("2026-11-25", 13));
    await usage.look();
    goTo(at("2026-11-24", 20));
    did("conversation_opened");
    expect(usage.status().today).toBeNull();
    goTo(at("2026-11-26", 13));
    await usage.look();
    expect(sent.map((report) => report.day)).toEqual(["2026-11-24", "2026-11-25"]);
  });

  it("keeps counts across a relaunch", async () => {
    const { usage, open, did } = setup({ answer: "yes" });
    did("conversation_opened");
    did("conversation_opened");
    await usage.close();
    expect(open().status().today?.actions.desktop).toEqual({ conversation_opened: 2 });
  });
});

describe("the answer", () => {
  it("a yes starts counting; a no deletes counts and waiting reports at once, timers too", async () => {
    const { db, usage, did, goTo, asked } = setup();
    expect(usage.setSharing(true)).toMatchObject({ answer: "yes", waiting: [] });
    did("conversation_opened");
    goTo(at("2026-11-25", 1));
    await usage.look();
    expect(usage.status().waiting).toHaveLength(1);
    expect(usageState(db)).not.toBeNull();
    expect(usage.setSharing(false)).toEqual({
      answer: "no",
      sends: true,
      today: null,
      waiting: [],
    });
    expect(usageState(db)).toBeNull();
    expect(usageConsent(db)?.answer).toBe("no");
    expect(vi.getTimerCount()).toBe(0);
    goTo(at("2026-11-25", 20));
    await usage.look();
    await vi.advanceTimersByTimeAsync(48 * HOUR);
    expect(asked).not.toHaveBeenCalled();
    expect(usageState(db)).toBeNull();
  });

  it("a call that began before an answer is not counted after it", () => {
    const { db, usage } = setup({ answer: "yes" });
    const begun = usage.begin() ?? -1;
    usage.setSharing(false);
    usage.succeeded(begun, "desktop", "conversation_opened");
    usage.failed(begun, "api_internal");
    expect(usageState(db)).toBeNull();
    usage.setSharing(true);
    usage.succeeded(begun, "desktop", "conversation_opened");
    usage.failed(begun, "api_internal");
    expect(usage.status().today).toMatchObject({ actions: {}, errors: {} });
  });

  it("a no aborts a report on its way, and nothing of it is kept or tried again", async () => {
    let aborted = false;
    const { db, usage, did, goTo } = setup({
      answer: "yes",
      send: (_endpoint, _report, signal) =>
        new Promise((done) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            done(false);
          });
        }),
    });
    did("conversation_opened");
    goTo(at("2026-11-25", 13));
    const looking = usage.look();
    await Promise.resolve();
    usage.setSharing(false);
    await looking;
    expect(aborted).toBe(true);
    expect(usageState(db)).toBeNull();
    expect(usage.status().waiting).toEqual([]);
  });

  it("a yes, a no and a yes start over from nothing", async () => {
    const { usage, did, goTo } = setup({ answer: "yes", installed: "2026-10-01" });
    did("conversation_opened");
    goTo(at("2026-11-25", 1));
    await usage.look();
    usage.setSharing(false);
    const again = usage.setSharing(true);
    expect(again.waiting).toEqual([]);
    expect(again.today).toMatchObject({ actions: {}, activeDays: null });
  });
});

describe("days", () => {
  it("are the Mac's calendar days, whatever their length", () => {
    expect(dayOf(startOfDay("2026-11-24"))).toBe("2026-11-24");
    expect(dayOf(startOfDay("2026-11-24", 1) - 1)).toBe("2026-11-24");
    expect(dayOf(startOfDay("2026-12-31", 1))).toBe("2027-01-01");
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetween("2026-11-25", "2026-11-24")).toBe(-1);
  });
});

describe("the request", () => {
  const report = UsageReport.parse({
    v: 1,
    id: "5f0c2d5e-8f0b-4b7e-9a3a-2f1d7f7f5b10",
    day: "2026-11-24",
    app: "0.7.0",
    macos: "27.0",
    memory: "32plus",
    installed: "0",
    activeDays: null,
    onboarding: "done",
    actions: {},
    errors: {},
  });
  const signal = new AbortController().signal;

  it("is one POST of the report, with no redirect, cookie or name", async () => {
    const calls: [unknown, RequestInit | undefined][] = [];
    const answer = await sendReport(ENDPOINT, report, {
      signal,
      fetch: async (url, init) => {
        calls.push([url, init]);
        return new Response(null, { status: 204 });
      },
    });
    expect(answer).toBe(true);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] ?? [];
    expect(url).toBe(ENDPOINT);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers: { "Content-Type": "application/json", "User-Agent": "Sondine" },
    });
    expect(Object.keys(init?.headers ?? {})).toHaveLength(2);
    expect(JSON.parse(String(init?.body))).toEqual(report);
  });

  it("takes only 204 for an answer, and never throws", async () => {
    for (const status of [200, 302, 400, 429, 502]) {
      const answered = async () => new Response(null, { status });
      expect(await sendReport(ENDPOINT, report, { signal, fetch: answered })).toBe(false);
    }
    const offline = async () => Promise.reject(new TypeError("offline"));
    expect(await sendReport(ENDPOINT, report, { signal, fetch: offline })).toBe(false);
  });
});
