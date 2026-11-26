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
} from "@sondine/engines/remote";
import { z } from "zod";

// What the server keeps on disk, all of it: its key, and for each client a
// token's hash, its kind/plan/quotas and opaque label in `clients/` (written
// only by the CLI and open-beta `claim`), and when it was last charged plus
// seconds transcribed in `usage/` (written by the running server). Never
// audio, text, or what a request was. docs/network.md and the privacy policy
// say the same: change them with this.

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

/** A place nobody used for this long goes to the next person. */
export const PLACE_IDLE_MS = 14 * 24 * 3_600_000;

export function planOf(client: Client): QuotaPlan {
  return client.plan ?? client.kind;
}

export function isInvitedPlan(plan: QuotaPlan): boolean {
  return plan === "trial" || plan === "cloud";
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
    for (const name of ["clients", "usage"]) {
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
    const previous = planOf(parsed.data);
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
    const plan = planOf(parsed.data);
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
  }

  /** Seconds transcribed this UTC calendar month (plus cumulative / top-up fields when present). */
  usage(id: string): Usage {
    const stored = Usage.safeParse(readJson(this.usagePath(id)));
    const month = monthOf(this.now());
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
    const plan = planOf(client);
    const usage = this.usage(id);
    const remainingExtra = Math.max(0, (client.extraSeconds ?? 0) - (usage.extraSpent ?? 0));
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
    const limitSeconds =
      plan === "beta"
        ? (client.limitSeconds ?? betaSecondsPerMonth)
        : (client.limitSeconds ?? PLAN_MONTHLY_SECONDS);
    return {
      plan,
      period: "month",
      usedSeconds: usage.seconds,
      limitSeconds,
      extraSeconds: remainingExtra,
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

  private clientPath(id: string): string {
    return join(this.directory, "clients", `${id}.json`);
  }

  private usagePath(id: string): string {
    return join(this.directory, "usage", `${id}.json`);
  }
}
