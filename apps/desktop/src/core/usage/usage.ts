import { randomUUID } from "node:crypto";
import type { UsageCounter, UsageStatus } from "@sondine/api";
import {
  checkpointTruncate,
  deleteUsageState,
  onboardingReached,
  saveUsageState,
  setUsageConsent,
  usageConsent,
  usageState,
  type Database,
} from "@sondine/db";
import {
  COUNTED_EVENTS,
  USAGE_ERRORS,
  USAGE_ONBOARDING,
  USAGE_REPORT_VERSION,
  USAGE_RULES,
  USAGE_SURFACES,
  usageCount,
  UsageReport,
  usageInstalled,
  usageMemory,
  type UsageError,
  type UsageEvent,
  type UsageSurface,
} from "@sondine/protocol";
import * as z from "zod";
import { dayOf, daysBetween, startOfDay } from "./usage-days";

// The anonymous statistics (ADR 042): what is counted, a report a day, and
// when it leaves. Nothing at all is counted, kept or timed unless the user
// answered yes to the question asked now; every answer starts over from
// nothing. Time is the Mac's calendar: a call counts for the day it ends on,
// a past day is closed once, and its report waits for a random moment of the
// day after it.

/** « read » calls of one event and surface closer than this are one. */
export const READ_GAP_MS = 60_000;
/** Counts are written at most this often while the user acts. */
export const SAVE_MS = 60_000;
/** The first look after launch, and the next ones: drawn between these. */
export const FIRST_LOOK_MS = [2 * 60_000, 20 * 60_000] as const;
export const LOOK_MS = [30 * 60_000, 90 * 60_000] as const;
/** A report that did not go waits this long. */
export const RETRY_MS = 6 * 3_600_000;
/** A report is dropped this many days after its day. */
export const KEEP_DAYS = 4;
/** `activeDays` covers this many days. */
const WINDOW_DAYS = 7;

const Counts = z.record(z.string(), z.int().min(1).max(1_000_000));
const DayState = z.strictObject({
  id: z.uuidv4(),
  app: z.string(),
  macos: z.string(),
  onboarding: z.enum(USAGE_ONBOARDING),
  actions: z.partialRecord(z.enum(USAGE_SURFACES), Counts),
  errors: Counts,
});
type DayState = z.output<typeof DayState>;
const Waiting = z.strictObject({
  report: UsageReport,
  dueAtMs: z.number(),
  triedAtMs: z.number().nullable(),
});
const State = z.strictObject({
  days: z.record(z.string(), DayState),
  activeDays: z.array(z.string()).max(32),
  closedThrough: z.string().nullable(),
  waiting: z.array(Waiting).max(16),
});
type State = z.output<typeof State>;

const empty = (): State => ({ days: {}, activeDays: [], closedThrough: null, waiting: [] });

const countable: ReadonlyMap<UsageSurface, ReadonlySet<string>> = new Map(
  USAGE_SURFACES.map((surface) => [surface, new Set<string>(COUNTED_EVENTS[surface])]),
);
const knownErrors: ReadonlySet<string> = new Set(USAGE_ERRORS);

export interface UsageDeps {
  readonly db: Database;
  readonly appVersion: string;
  /** `27.0.1`; core asks main. */
  readonly macosVersion: string;
  readonly memoryBytes: number;
  /** The build's endpoint; null sends nothing, ever. */
  readonly endpoint: string | null;
  readonly send: (endpoint: string, report: UsageReport, signal: AbortSignal) => Promise<boolean>;
  readonly now: () => number;
  /** 0 to 1. */
  readonly random: () => number;
  readonly log: (
    event: string,
    fields: Readonly<Record<string, string | number | boolean>>,
  ) => void;
}

export class Usage implements UsageCounter {
  /** Non-null only under a yes to the question asked now. */
  private state: State | null = null;
  private consentDay = "";
  /** Moves with every answer: what began before one is not counted after it. */
  private generation = 0;
  private readonly lastRead = new Map<string, number>();
  private saveTimer: NodeJS.Timeout | null = null;
  private lookTimer: NodeJS.Timeout | null = null;
  private sending: AbortController | null = null;
  private pending: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly deps: UsageDeps) {
    const consent = usageConsent(deps.db);
    if (consent?.answer === "yes" && consent.version === USAGE_REPORT_VERSION) {
      const stored = State.safeParse(usageState(deps.db) ?? empty());
      this.state = stored.success ? stored.data : empty();
      this.consentDay = dayOf(consent.atMs);
    } else {
      // A crash, or an older question: whatever is left goes.
      if (deleteUsageState(deps.db)) this.scrub();
    }
  }

  // The user's answer

  status(): UsageStatus {
    const consent = usageConsent(this.deps.db);
    const answer = consent?.version === USAGE_REPORT_VERSION ? consent.answer : null;
    if (this.state !== null) this.today();
    return {
      answer,
      sends: this.deps.endpoint !== null,
      today: this.state === null ? null : this.draft(dayOf(this.deps.now())),
      waiting: this.state?.waiting.map((entry) => entry.report) ?? [],
    };
  }

  setSharing(share: boolean): UsageStatus {
    this.generation += 1;
    this.sending?.abort();
    this.stopTimers();
    this.lastRead.clear();
    const atMs = this.deps.now();
    // In memory first: nothing is counted even if the write throws.
    this.state = null;
    setUsageConsent(this.deps.db, {
      answer: share ? "yes" : "no",
      version: USAGE_REPORT_VERSION,
      atMs,
    });
    if (share && !this.closed) {
      this.state = empty();
      this.consentDay = dayOf(atMs);
      this.today();
      this.save();
      this.schedule(FIRST_LOOK_MS);
    }
    if (!share) this.scrub();
    this.deps.log("usage.answered", { share });
    return this.status();
  }

  // Counting (the API's middleware, and the failures core sees)

  begin(): number | null {
    return this.state === null ? null : this.generation;
  }

  succeeded(begun: number, surface: UsageSurface, event: string): void {
    if (begun !== this.generation || countable.get(surface)?.has(event) !== true) return;
    const day = this.today();
    if (day === null) return;
    if (USAGE_RULES[event as UsageEvent] === "read") {
      // A day's first read counts, however close to the last of the day before.
      const key = `${dayOf(this.deps.now())} ${surface}.${event}`;
      const now = this.deps.now();
      const last = this.lastRead.get(key);
      this.lastRead.set(key, now);
      if (last !== undefined && now >= last && now - last < READ_GAP_MS) return;
    }
    const counts = (day.actions[surface] ??= {});
    counts[event] = (counts[event] ?? 0) + 1;
    if (surface !== "mcp") this.markActive();
    this.saveSoon();
  }

  failed(begun: number, code: UsageError): void {
    if (begun === this.generation) this.error(code);
  }

  /** A failure core saw outside a call: it counts when it happens, under the consent of then. */
  error(code: UsageError): void {
    if (!knownErrors.has(code)) return;
    const day = this.today();
    if (day === null) return;
    day.errors[code] = (day.errors[code] ?? 0) + 1;
    this.saveSoon();
  }

  // Reports

  /** Starts the looks of a Mac that already said yes. */
  start(): void {
    if (this.state !== null) this.schedule(FIRST_LOOK_MS);
  }

  /** Closes past days, drops what is too old, sends what is due. */
  look(): Promise<void> {
    this.pending ??= this.lookNow().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.sending?.abort();
    const wasDirty = this.saveTimer !== null;
    this.stopTimers();
    await this.pending?.catch(() => undefined);
    if (wasDirty) this.save();
  }

  private async lookNow(): Promise<void> {
    if (this.state === null || this.closed) return;
    const generation = this.generation;
    const now = this.deps.now();
    const today = dayOf(now);
    this.today();
    this.closeDays(today);
    const { state } = this;
    state.waiting = state.waiting.filter(
      (entry) => Math.abs(daysBetween(entry.report.day, today)) <= KEEP_DAYS,
    );
    this.save();
    for (const entry of state.waiting) {
      const { endpoint } = this.deps;
      if (endpoint === null || entry.dueAtMs > now) continue;
      if (entry.triedAtMs !== null && Math.abs(now - entry.triedAtMs) < RETRY_MS) continue;
      entry.triedAtMs = now;
      this.save();
      // The consent as it is stored, right before anything leaves.
      const consent = usageConsent(this.deps.db);
      if (consent?.answer !== "yes" || consent.version !== USAGE_REPORT_VERSION) return;
      const sending = new AbortController();
      this.sending = sending;
      const sent = await this.deps.send(endpoint, entry.report, sending.signal);
      this.sending = null;
      // Answered no, or no then yes, meanwhile: this state is gone.
      if (generation !== this.generation || this.closed) return;
      this.deps.log("usage.report", { sent });
      if (sent) {
        state.waiting = state.waiting.filter((other) => other !== entry);
        this.save();
      }
    }
  }

  /** The record of the day it is, made on its first use; null without a yes, or on a closed day. */
  private today(): DayState | null {
    const { state } = this;
    if (state === null || this.closed) return null;
    const today = dayOf(this.deps.now());
    // The clock went back to a day already reported.
    if (state.closedThrough !== null && today <= state.closedThrough) return null;
    const reached = onboardingReached(this.deps.db)?.step;
    const day = (state.days[today] ??= {
      id: randomUUID(),
      app: "",
      macos: "",
      onboarding: "welcome",
      actions: {},
      errors: {},
    });
    day.app = /^\d+\.\d+\.\d+/u.exec(this.deps.appVersion)?.[0] ?? "";
    day.macos = /^\d+\.\d+/u.exec(this.deps.macosVersion)?.[0] ?? "";
    day.onboarding = USAGE_ONBOARDING.find((step) => step === reached) ?? "welcome";
    return day;
  }

  private markActive(): void {
    const { state } = this;
    const today = dayOf(this.deps.now());
    if (state === null || state.activeDays.includes(today)) return;
    state.activeDays = [...state.activeDays, today]
      .filter((day) => Math.abs(daysBetween(day, today)) < 2 * WINDOW_DAYS)
      .slice(-2 * WINDOW_DAYS);
  }

  private closeDays(today: string): void {
    const { state } = this;
    if (state === null) return;
    for (const day of Object.keys(state.days).toSorted()) {
      if (day >= today) continue;
      const report = this.draft(day);
      delete state.days[day];
      if (state.closedThrough === null || day > state.closedThrough) state.closedThrough = day;
      if (report === null || daysBetween(day, today) > KEEP_DAYS) continue;
      const from = startOfDay(day, 1);
      const dueAtMs = Math.floor(from + this.deps.random() * (startOfDay(day, 2) - from));
      state.waiting.push({ report, dueAtMs, triedAtMs: null });
    }
  }

  /** The report of a day as it stands; null when it does not fit the schema. */
  private draft(day: string): UsageReport | null {
    const { state } = this;
    const counted = state?.days[day];
    if (state === null || counted === undefined) return null;
    const startedAtMs = onboardingReached(this.deps.db)?.startedAtMs;
    const installDay = startedAtMs === undefined ? this.consentDay : dayOf(startedAtMs);
    const countedFrom = installDay > this.consentDay ? installDay : this.consentDay;
    const covered = daysBetween(countedFrom, day) >= WINDOW_DAYS;
    const active = state.activeDays.filter((other) => {
      const ago = daysBetween(other, day);
      return ago >= 0 && ago < WINDOW_DAYS;
    });
    const rounded = (counts: Readonly<Record<string, number>>) =>
      Object.fromEntries(
        Object.entries(counts)
          .toSorted(([a], [b]) => (a < b ? -1 : 1))
          .map(([name, times]) => [name, usageCount(times)]),
      );
    const parsed = UsageReport.safeParse({
      v: USAGE_REPORT_VERSION,
      id: counted.id,
      day,
      app: counted.app,
      macos: counted.macos,
      memory: usageMemory(this.deps.memoryBytes),
      installed: usageInstalled(daysBetween(installDay, day)),
      activeDays: covered ? active.length : null,
      onboarding: counted.onboarding,
      actions: Object.fromEntries(
        Object.entries(counted.actions).map(([surface, counts]) => [surface, rounded(counts)]),
      ),
      errors: rounded(counted.errors),
    });
    return parsed.success ? parsed.data : null;
  }

  /** What was deleted leaves the write-ahead log too, not only the database. */
  private scrub(): void {
    if (this.deps.db.path === ":memory:") return;
    try {
      checkpointTruncate(this.deps.db);
    } catch {
      // Busy: the next checkpoint takes it.
      this.deps.log("usage.scrub", { done: false });
    }
  }

  // Timers and writes, only under a yes

  private schedule([from, to]: readonly [number, number]): void {
    if (this.lookTimer !== null) clearTimeout(this.lookTimer);
    this.lookTimer = setTimeout(
      () => {
        this.lookTimer = null;
        void this.look()
          .catch(() => undefined)
          .then(() => {
            if (this.state !== null && !this.closed) this.schedule(LOOK_MS);
          });
      },
      Math.floor(from + this.deps.random() * (to - from)),
    );
    this.lookTimer.unref();
  }

  private saveSoon(): void {
    if (this.saveTimer !== null || this.closed) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_MS);
    this.saveTimer.unref();
  }

  private save(): void {
    if (this.state === null) return;
    saveUsageState(this.deps.db, this.state, this.deps.now());
  }

  private stopTimers(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    if (this.lookTimer !== null) clearTimeout(this.lookTimer);
    this.saveTimer = null;
    this.lookTimer = null;
  }
}
