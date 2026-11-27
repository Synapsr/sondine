import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  generateKeyPair,
  QuotaPlan,
  type KeyPair,
  type QuotaSnapshot,
  type Subscription,
} from "@sondine/engines/remote";
import { z } from "zod";

// What the server keeps on disk, all of it: its key; for each client a
// token's hash, its kind/plan/quotas and opaque label in `clients/` (written
// by the CLI, and by the server when someone takes a place); when it was last
// charged and the seconds transcribed in `usage/`; for a place that paid, its
// Stripe customer and subscription in `billing/`; the Stripe events already
// handled; and the wave's number of places. `usage/`, `billing/` and the events
// are written by the running server alone. Never audio, text, or what a
// request was. docs/network.md and the privacy policy say the same: change
// them with this.

/** Default free trial allowance: 60 minutes total (does not reset monthly). */
export const TRIAL_SECONDS = 60 * 60;
/** Default monthly allowance for invited Cloud plans: 40 hours (UTC calendar month). */
export const PLAN_MONTHLY_SECONDS = 40 * 3_600;
/** Default top-up pack: 10 hours (persists across months, no expiration). */
export const TOPUP_SECONDS = 10 * 3_600;

const Client = z.strictObject({
  kind: z.enum(["own", "beta"]),
  name: z.string().max(64),
  createdAt: z.int(),
  /** Quota tier; omitted in older 0.9.0 state files (defaults to `kind`). */
  plan: QuotaPlan.optional(),
  /** Included seconds (total for `trial`, monthly for `cloud`/`beta`). */
  limitSeconds: z.number().nonnegative().optional(),
  /** Purchased top-up seconds added by CLI; spent balance is tracked in `usage/`. */
  extraSeconds: z.number().nonnegative().optional(),
});
export type Client = z.output<typeof Client>;

const Usage = z.strictObject({
  lastUsedAt: z.int(),
  month: z.string(),
  seconds: z.number(),
  /** Cumulative seconds across months (stored only for `trial` clients). */
  totalSeconds: z.number().nonnegative().optional(),
  /** Cumulative top-up seconds already spent (stored only once top-ups are spent). */
  extraSpent: z.number().nonnegative().optional(),
});
export type Usage = z.output<typeof Usage>;

const KeyFile = z.strictObject({ publicKey: z.base64url(), privateKey: z.base64url() });

const StripeId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]{1,250}$`));

/**
 * A place's link to Stripe (ADR 047). `ref` is what Stripe knows the place by:
 * random, neither the token nor its hash.
 */
const Billing = z.strictObject({
  ref: z.string().regex(/^[0-9a-f]{32}$/),
  customer: StripeId("cus").optional(),
  subscription: z
    .strictObject({
      id: StripeId("sub"),
      status: z.enum(["active", "past_due", "ended"]),
      /** The period its 40 hours count in; they come back with the next one. */
      periodStart: z.int().nullable(),
      periodEnd: z.int().nullable(),
      cancelAtPeriodEnd: z.boolean(),
    })
    .optional(),
  /** Seconds bought as top-ups; spent ones are counted in `usage/`. */
  topupSeconds: z.number().nonnegative().optional(),
  /** Checkout sessions already credited, newest last: a session is never paid twice. */
  credited: z.array(StripeId("cs")).max(64).optional(),
});
export type Billing = z.output<typeof Billing>;

const Wave = z.strictObject({ places: z.int().nonnegative() });

/** Stripe events already handled, by id, and when: Stripe sends one again for three days. */
const Events = z.record(z.string().max(255), z.int());
export const EVENTS_KEPT_MS = 30 * 24 * 3_600_000;

/** A place nobody used for this long goes to the next person. */
export const PLACE_IDLE_MS = 14 * 24 * 3_600_000;

/** A client's plan: its subscription's, once it has one, else the one it was given. */
export function planOf(client: Client, billing: Billing | null = null): QuotaPlan {
  const subscription = billing?.subscription;
  if (subscription !== undefined) return subscription.status === "ended" ? "ended" : "cloud";
  return client.plan ?? client.kind;
}

/** Plans of the wave (ADR 047): their places count in its gauge. */
export function isWavePlan(plan: QuotaPlan): boolean {
  return plan === "trial" || plan === "cloud" || plan === "ended";
}

export function isInvitedPlan(plan: QuotaPlan): boolean {
  return plan === "trial" || plan === "cloud" || plan === "ended";
}

export function defaultLimitSeconds(plan: QuotaPlan): number | undefined {
  if (plan === "trial") return TRIAL_SECONDS;
  if (plan === "cloud") return PLAN_MONTHLY_SECONDS;
  return undefined;
}

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const monthOf = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 7);

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * One file per client in `clients/` (written by the CLI / `claim` only) and
 * one file per client in `usage/` (written by `charge`), so the CLI and the
 * running server never overwrite each other's files.
 */
export class ClientStore {
  private readonly directory: string;
  private readonly now: () => number;

  constructor(stateDir: string, now: () => number = Date.now) {
    this.directory = stateDir;
    this.now = now;
    for (const name of ["clients", "usage", "billing"]) {
      mkdirSync(join(stateDir, name), { recursive: true, mode: 0o700 });
    }
  }

  /** The server's key, made once: clients know the server by it. */
  key(): KeyPair {
    const path = join(this.directory, "key.json");
    if (existsSync(path)) {
      const stored = KeyFile.parse(readJson(path));
      return {
        publicKey: Buffer.from(stored.publicKey, "base64url"),
        privateKey: Buffer.from(stored.privateKey, "base64url"),
      };
    }
    const key = generateKeyPair();
    writeJson(path, {
      publicKey: key.publicKey.toString("base64url"),
      privateKey: key.privateKey.toString("base64url"),
    });
    return key;
  }

  /** A new client; its token is told once and only its hash kept. */
  add(
    kind: Client["kind"],
    name: string,
    options: {
      readonly plan?: QuotaPlan;
      readonly limitSeconds?: number;
      readonly extraSeconds?: number;
    } = {},
  ): { readonly id: string; readonly token: string } {
    const token = randomBytes(32).toString("base64url");
    const id = hashOf(token);
    const plan = options.plan;
    const effectivePlan = plan ?? kind;
    const limitSeconds =
      effectivePlan === "own"
        ? undefined
        : (options.limitSeconds ?? (plan === undefined ? undefined : defaultLimitSeconds(plan)));
    const extraSeconds =
      effectivePlan === "own" || effectivePlan === "trial" ? undefined : options.extraSeconds;
    const record: Client = {
      kind,
      name,
      createdAt: this.now(),
      ...(plan === undefined || plan === kind ? {} : { plan }),
      ...(limitSeconds === undefined ? {} : { limitSeconds }),
      ...(extraSeconds === undefined || extraSeconds <= 0 ? {} : { extraSeconds }),
    };
    writeJson(this.clientPath(id), record);
    return { id, token };
  }

  /**
   * Changes a client's plan while keeping its token and any purchased top-up
   * hours. Refuses downgrades from a paid/unlimited plan to `trial`.
   */
  setPlan(
    id: string,
    plan: QuotaPlan,
    options: { readonly limitSeconds?: number } = {},
  ): { readonly ok: true } | { readonly ok: false; readonly reason: "not-found" | "downgrade" } {
    const parsed = Client.safeParse(readJson(this.clientPath(id)));
    if (!parsed.success) return { ok: false, reason: "not-found" };
    const previous = planOf(parsed.data, this.billing(id));
    if (plan === "trial" && previous !== "trial") {
      return { ok: false, reason: "downgrade" };
    }
    const limitSeconds =
      plan === "own" ? undefined : (options.limitSeconds ?? defaultLimitSeconds(plan));
    const { limitSeconds: _oldLimit, plan: _oldPlan, ...rest } = parsed.data;
    const kind: Client["kind"] = plan === "own" ? "own" : "beta";
    const next: Client = {
      ...rest,
      kind,
      ...(plan === kind ? {} : { plan }),
      ...(limitSeconds === undefined ? {} : { limitSeconds }),
    };
    writeJson(this.clientPath(id), next);
    // Moving from a free trial to a monthly Cloud plan starts the first paid month fresh.
    if (previous === "trial" && plan === "cloud") {
      const usage = this.usage(id);
      const { totalSeconds: _dropTotal, ...kept } = usage;
      writeJson(this.usagePath(id), { ...kept, seconds: 0 } satisfies Usage);
    }
    return { ok: true };
  }

  /** Adds purchased top-up seconds that persist across months. Refused on `own` and `trial`. */
  topUp(
    id: string,
    seconds: number,
  ):
    | { readonly ok: true; readonly remainingSeconds: number }
    | {
        readonly ok: false;
        readonly reason: "not-found" | "invalid" | "unsupported-plan";
      } {
    if (!Number.isFinite(seconds) || seconds <= 0) return { ok: false, reason: "invalid" };
    const parsed = Client.safeParse(readJson(this.clientPath(id)));
    if (!parsed.success) return { ok: false, reason: "not-found" };
    const plan = planOf(parsed.data, this.billing(id));
    if (plan === "own" || plan === "trial") return { ok: false, reason: "unsupported-plan" };
    const nextExtra = (parsed.data.extraSeconds ?? 0) + seconds;
    const next: Client = { ...parsed.data, extraSeconds: nextExtra };
    writeJson(this.clientPath(id), next);
    const spent = this.usage(id).extraSpent ?? 0;
    return { ok: true, remainingSeconds: Math.max(0, nextExtra - spent) };
  }

  /** The client a token belongs to; null when it is unknown or was removed. */
  find(token: string): { readonly id: string; readonly client: Client } | null {
    const id = hashOf(token);
    const client = Client.safeParse(readJson(this.clientPath(id)));
    return client.success ? { id, client: client.data } : null;
  }

  has(id: string): boolean {
    return existsSync(this.clientPath(id));
  }

  list(): { readonly id: string; readonly client: Client; readonly usage: Usage }[] {
    return readdirSync(join(this.directory, "clients"))
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        const id = name.slice(0, -".json".length);
        const client = Client.safeParse(readJson(this.clientPath(id)));
        return client.success ? [{ id, client: client.data, usage: this.usage(id) }] : [];
      });
  }

  remove(id: string): void {
    rmSync(this.clientPath(id), { force: true });
    rmSync(this.usagePath(id), { force: true });
    rmSync(this.billingPath(id), { force: true });
  }

  /**
   * A new token for the same place: its plan, hours and subscription follow,
   * and the old link stops working at once.
   */
  rekey(id: string): { readonly id: string; readonly token: string } | null {
    if (!this.has(id)) return null;
    const token = randomBytes(32).toString("base64url");
    const next = hashOf(token);
    for (const path of [this.usagePath, this.billingPath, this.clientPath]) {
      const from = path.call(this, id);
      if (existsSync(from)) renameSync(from, path.call(this, next));
    }
    return { id: next, token };
  }

  /**
   * The period seconds are counted in: a subscription's own, so its hours
   * come back at each renewal; else the UTC calendar month.
   */
  private periodOf(id: string): string {
    const start = this.billing(id)?.subscription?.periodStart;
    return start === undefined || start === null ? monthOf(this.now()) : `period-${start}`;
  }

  /** Seconds transcribed this period (plus cumulative / top-up fields when present). */
  usage(id: string): Usage {
    const stored = Usage.safeParse(readJson(this.usagePath(id)));
    const month = this.periodOf(id);
    if (!stored.success) return { lastUsedAt: 0, month, seconds: 0 };
    if (stored.data.month === month) return stored.data;
    const { totalSeconds, extraSpent, lastUsedAt } = stored.data;
    return {
      lastUsedAt,
      month,
      seconds: 0,
      ...(totalSeconds === undefined ? {} : { totalSeconds }),
      ...(extraSpent === undefined ? {} : { extraSpent }),
    };
  }

  /** Current plan, usage and limits for one client. */
  quota(id: string, betaSecondsPerMonth: number | null = null): QuotaSnapshot | null {
    const parsed = Client.safeParse(readJson(this.clientPath(id)));
    if (!parsed.success) return null;
    const client = parsed.data;
    const billing = this.billing(id);
    const plan = planOf(client, billing);
    const usage = this.usage(id);
    const bought = (client.extraSeconds ?? 0) + (billing?.topupSeconds ?? 0);
    const remainingExtra = Math.max(0, bought - (usage.extraSpent ?? 0));
    const subscription: Subscription | null =
      billing?.subscription === undefined
        ? null
        : {
            status: billing.subscription.status,
            periodEnd: billing.subscription.periodEnd,
            cancelAtPeriodEnd: billing.subscription.cancelAtPeriodEnd,
          };
    if (plan === "own") {
      return {
        plan,
        period: "unlimited",
        usedSeconds: usage.seconds,
        limitSeconds: null,
        extraSeconds: 0,
      };
    }
    if (plan === "trial") {
      return {
        plan,
        period: "total",
        usedSeconds: usage.totalSeconds ?? usage.seconds,
        limitSeconds: client.limitSeconds ?? TRIAL_SECONDS,
        extraSeconds: 0,
      };
    }
    // A limit given to the client was for the plan it was given, not for its subscription's.
    const given = client.plan === plan ? client.limitSeconds : undefined;
    const limitSeconds =
      plan === "beta"
        ? (client.limitSeconds ?? betaSecondsPerMonth)
        : plan === "ended"
          ? 0
          : (given ?? PLAN_MONTHLY_SECONDS);
    return {
      plan,
      period: "month",
      usedSeconds: usage.seconds,
      limitSeconds,
      extraSeconds: remainingExtra,
      ...(subscription === null ? {} : { subscription }),
    };
  }

  /**
   * Charges transcribed seconds to `usage/<id>.json` only (never touches
   * `clients/<id>.json`). Keeps `own` and `beta` usage files minimal when no
   * top-up is spent.
   */
  charge(id: string, seconds: number, betaSecondsPerMonth: number | null = null): void {
    const parsed = Client.safeParse(readJson(this.clientPath(id)));
    if (!parsed.success) return;
    const usage = this.usage(id);
    const snapshot = this.quota(id, betaSecondsPerMonth);
    if (snapshot === null) return;

    let fromExtra = 0;
    if (
      snapshot.period === "month" &&
      snapshot.limitSeconds !== null &&
      snapshot.extraSeconds > 0
    ) {
      const includedLeft = Math.max(0, snapshot.limitSeconds - snapshot.usedSeconds);
      fromExtra = Math.min(snapshot.extraSeconds, Math.max(0, seconds - includedLeft));
    }
    const nextExtraSpent = (usage.extraSpent ?? 0) + fromExtra;

    if (snapshot.period === "total") {
      const nextTotal = (usage.totalSeconds ?? usage.seconds) + seconds;
      writeJson(this.usagePath(id), {
        lastUsedAt: this.now(),
        month: usage.month,
        seconds: usage.seconds + seconds,
        totalSeconds: nextTotal,
        ...(nextExtraSpent > 0 ? { extraSpent: nextExtraSpent } : {}),
      } satisfies Usage);
      return;
    }

    const nextSeconds = usage.seconds + (seconds - fromExtra);
    writeJson(this.usagePath(id), {
      lastUsedAt: this.now(),
      month: usage.month,
      seconds: nextSeconds,
      ...(usage.totalSeconds === undefined ? {} : { totalSeconds: usage.totalSeconds }),
      ...(nextExtraSpent > 0 ? { extraSpent: nextExtraSpent } : {}),
    } satisfies Usage);
  }

  /** A self-claimed open-beta place, or null when all `places` are taken by active users. */
  claim(places: number): string | null {
    const now = this.now();
    // Only open-beta places count against `places` or are reclaimed when idle; invited plans stay.
    const beta = this.list().filter(({ client }) => planOf(client) === "beta");
    const idle = beta
      .map((entry) => ({
        id: entry.id,
        lastSeen: Math.max(entry.usage.lastUsedAt, entry.client.createdAt),
      }))
      .filter(({ lastSeen }) => now - lastSeen > PLACE_IDLE_MS)
      .toSorted((a, b) => a.lastSeen - b.lastSeen);
    if (beta.length >= places) {
      const freed = idle.slice(0, beta.length - places + 1);
      if (beta.length - freed.length >= places) return null;
      for (const { id } of freed) this.remove(id);
    }
    return this.add("beta", "beta").token;
  }

  /** A place of the wave with its trial, or null when the wave is closed or full. */
  trial(): string | null {
    const { places, taken } = this.wave();
    if (places === 0 || taken >= places) return null;
    return this.add("beta", "trial", { plan: "trial" }).token;
  }

  /**
   * The wave's places, and how many are taken: by a subscription that goes on
   * (or one the operator gave), or by a trial or an ended subscription used in
   * the last 14 days. One unused that long frees its place without losing it.
   */
  wave(): { readonly places: number; readonly taken: number } {
    const stored = Wave.safeParse(readJson(this.wavePath()));
    const places = stored.success ? stored.data.places : 0;
    const now = this.now();
    let taken = 0;
    for (const { id, client, usage } of this.list()) {
      const billing = this.billing(id);
      const plan = planOf(client, billing);
      if (client.kind === "own" || !isWavePlan(plan)) continue;
      const lastSeen = Math.max(
        client.createdAt,
        usage.lastUsedAt,
        billing?.subscription?.periodEnd ?? 0,
      );
      if (plan === "cloud" || now - lastSeen <= PLACE_IDLE_MS) taken += 1;
    }
    return { places, taken };
  }

  /** Sets the wave's places; 0 closes it. Places already taken stay. */
  setWavePlaces(places: number): void {
    writeJson(this.wavePath(), Wave.parse({ places }));
  }

  /** A place's link to Stripe, or null when it never paid. */
  billing(id: string): Billing | null {
    const stored = Billing.safeParse(readJson(this.billingPath(id)));
    return stored.success ? stored.data : null;
  }

  /** The place's link to Stripe, made with its reference on first use. */
  billingOf(id: string): Billing {
    return this.billing(id) ?? { ref: randomBytes(16).toString("hex") };
  }

  setBilling(id: string, billing: Billing): void {
    if (!this.has(id)) return;
    writeJson(this.billingPath(id), Billing.parse(billing));
  }

  /** The place Stripe knows by `ref` (or by its customer or subscription), if any. */
  findBilling(match: {
    readonly ref?: string | null;
    readonly customer?: string | null;
    readonly subscription?: string | null;
  }): string | null {
    for (const name of readdirSync(join(this.directory, "billing"))) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      const billing = this.billing(id);
      if (billing === null) continue;
      if (
        (match.ref != null && billing.ref === match.ref) ||
        (match.subscription != null && billing.subscription?.id === match.subscription) ||
        (match.customer != null && billing.customer === match.customer)
      ) {
        return id;
      }
    }
    return null;
  }

  /** Whether a Stripe event was handled already. */
  handled(eventId: string): boolean {
    return this.events()[eventId] !== undefined;
  }

  markHandled(eventId: string): void {
    const now = this.now();
    const kept = Object.fromEntries(
      Object.entries(this.events()).filter(([, at]) => now - at <= EVENTS_KEPT_MS),
    );
    writeJson(join(this.directory, "stripe-events.json"), { ...kept, [eventId]: now });
  }

  private events(): Record<string, number> {
    const stored = Events.safeParse(readJson(join(this.directory, "stripe-events.json")));
    return stored.success ? stored.data : {};
  }

  private wavePath(): string {
    return join(this.directory, "wave.json");
  }

  private billingPath(id: string): string {
    return join(this.directory, "billing", `${id}.json`);
  }

  private clientPath(id: string): string {
    return join(this.directory, "clients", `${id}.json`);
  }

  private usagePath(id: string): string {
    return join(this.directory, "usage", `${id}.json`);
  }
}
