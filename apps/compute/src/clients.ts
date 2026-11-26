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
// token's hash, its kind/plan/quotas and name, when it came, when it was last
// charged, and the seconds transcribed. Never audio, text, or what a request
// was. docs/network.md and the privacy policy say the same: change them with
// this.

/** Default free trial allowance: 60 minutes total (does not reset monthly). */
export const TRIAL_SECONDS = 60 * 60;
/** Default monthly allowance for Founder and Pro plans: 40 hours. */
export const PLAN_MONTHLY_SECONDS = 40 * 3_600;
/** Default top-up pack: 10 hours. */
export const TOPUP_SECONDS = 10 * 3_600;

const Client = z.strictObject({
  kind: z.enum(["own", "beta"]),
  name: z.string().max(64),
  createdAt: z.int(),
  /** Quota tier; omitted in older state files (defaults to `kind`). */
  plan: QuotaPlan.optional(),
  /** Included seconds (total for `trial`, monthly for `founder`/`pro`/`beta`). */
  limitSeconds: z.number().nonnegative().optional(),
  /** Purchased top-up seconds, consumed only past `limitSeconds`, never reset monthly. */
  extraSeconds: z.number().nonnegative().optional(),
});
export type Client = z.output<typeof Client>;

const Usage = z.strictObject({
  lastUsedAt: z.int(),
  month: z.string(),
  seconds: z.number(),
  /** Cumulative seconds across months (used by `trial`). */
  totalSeconds: z.number().nonnegative().optional(),
});
export type Usage = z.output<typeof Usage>;

const KeyFile = z.strictObject({ publicKey: z.base64url(), privateKey: z.base64url() });

/** A place nobody used for this long goes to the next person. */
export const PLACE_IDLE_MS = 14 * 24 * 3_600_000;

export function planOf(client: Client): QuotaPlan {
  return client.plan ?? client.kind;
}

export function defaultLimitSeconds(plan: QuotaPlan): number | undefined {
  if (plan === "trial") return TRIAL_SECONDS;
  if (plan === "founder" || plan === "pro") return PLAN_MONTHLY_SECONDS;
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

/** One file per client, so the command line and the running server never overwrite each other. */
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
    const limitSeconds =
      options.limitSeconds ?? (plan === undefined ? undefined : defaultLimitSeconds(plan));
    const extraSeconds = options.extraSeconds;
    const record: Client = {
      kind,
      name,
      createdAt: this.now(),
      ...(plan === undefined ? {} : { plan }),
      ...(limitSeconds === undefined ? {} : { limitSeconds }),
      ...(extraSeconds === undefined || extraSeconds <= 0 ? {} : { extraSeconds }),
    };
    writeJson(this.clientPath(id), record);
    return { id, token };
  }

  /** Changes a client's plan while keeping its token and any purchased top-up hours. */
  setPlan(id: string, plan: QuotaPlan, options: { readonly limitSeconds?: number } = {}): boolean {
    const parsed = Client.safeParse(readJson(this.clientPath(id)));
    if (!parsed.success) return false;
    const previous = planOf(parsed.data);
    const limitSeconds = options.limitSeconds ?? defaultLimitSeconds(plan);
    const { limitSeconds: _oldLimit, ...rest } = parsed.data;
    const next: Client = {
      ...rest,
      kind: plan === "own" ? "own" : "beta",
      plan,
      ...(limitSeconds === undefined ? {} : { limitSeconds }),
    };
    writeJson(this.clientPath(id), next);
    // Moving from a free trial to a monthly plan starts the paid month with a full allowance.
    if (previous === "trial" && (plan === "founder" || plan === "pro")) {
      const usage = this.usage(id);
      writeJson(this.usagePath(id), { ...usage, seconds: 0 } satisfies Usage);
    }
    return true;
  }

  /** Adds purchased top-up seconds that persist across months. */
  topUp(id: string, seconds: number): boolean {
    if (!Number.isFinite(seconds) || seconds <= 0) return false;
    const parsed = Client.safeParse(readJson(this.clientPath(id)));
    if (!parsed.success) return false;
    const next: Client = {
      ...parsed.data,
      extraSeconds: (parsed.data.extraSeconds ?? 0) + seconds,
    };
    writeJson(this.clientPath(id), next);
    return true;
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

  /** Seconds transcribed this month (and cumulative total across months). */
  usage(id: string): Usage {
    const stored = Usage.safeParse(readJson(this.usagePath(id)));
    const month = monthOf(this.now());
    if (!stored.success) return { lastUsedAt: 0, month, seconds: 0, totalSeconds: 0 };
    const totalSeconds = stored.data.totalSeconds ?? stored.data.seconds;
    return stored.data.month === month
      ? { ...stored.data, totalSeconds }
      : { ...stored.data, month, seconds: 0, totalSeconds };
  }

  /** Current plan, usage and limits for one client. */
  quota(id: string, betaSecondsPerMonth: number | null = null): QuotaSnapshot | null {
    const parsed = Client.safeParse(readJson(this.clientPath(id)));
    if (!parsed.success) return null;
    const client = parsed.data;
    const plan = planOf(client);
    const usage = this.usage(id);
    const extraSeconds = client.extraSeconds ?? 0;
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
        extraSeconds,
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
      extraSeconds,
    };
  }

  charge(id: string, seconds: number, betaSecondsPerMonth: number | null = null): void {
    const parsed = Client.safeParse(readJson(this.clientPath(id)));
    if (!parsed.success) return;
    const client = parsed.data;
    const usage = this.usage(id);
    const snapshot = this.quota(id, betaSecondsPerMonth);
    let fromExtra = 0;
    if (snapshot !== null && snapshot.limitSeconds !== null && snapshot.extraSeconds > 0) {
      const includedLeft = Math.max(0, snapshot.limitSeconds - snapshot.usedSeconds);
      fromExtra = Math.min(snapshot.extraSeconds, Math.max(0, seconds - includedLeft));
      if (fromExtra > 0) {
        const remaining = Math.max(0, snapshot.extraSeconds - fromExtra);
        const { extraSeconds: _oldExtra, ...rest } = client;
        writeJson(
          this.clientPath(id),
          remaining > 0 ? ({ ...rest, extraSeconds: remaining } satisfies Client) : rest,
        );
      }
    }
    const periodCharge = seconds - fromExtra;
    const priorTotal = usage.totalSeconds ?? usage.seconds;
    const nextSeconds =
      snapshot?.period === "month" ? usage.seconds + periodCharge : usage.seconds + seconds;
    const nextTotal =
      snapshot?.period === "total" ? priorTotal + periodCharge : priorTotal + seconds;
    writeJson(this.usagePath(id), {
      ...usage,
      seconds: nextSeconds,
      totalSeconds: nextTotal,
      lastUsedAt: this.now(),
    } satisfies Usage);
  }

  /** A self-claimed beta place, or null when all `places` are taken by people who use theirs. */
  claim(places: number): string | null {
    const now = this.now();
    // Only open beta places count against `places` or are reclaimed when idle; invited plans stay.
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
