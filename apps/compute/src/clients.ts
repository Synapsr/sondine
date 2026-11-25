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
import { generateKeyPair, type KeyPair } from "@sondine/engines/remote";
import { z } from "zod";

// What the server keeps on disk, all of it: its key, and for each client a
// token's hash, its kind and name, when it came, when it was last charged, and
// the seconds transcribed in that month. Kept until the client is removed.
// Never audio, text, or what a request was. docs/network.md and the privacy
// policy say the same: change them with this.

const Client = z.strictObject({
  kind: z.enum(["own", "beta"]),
  name: z.string().max(64),
  createdAt: z.int(),
});
export type Client = z.output<typeof Client>;

const Usage = z.strictObject({ lastUsedAt: z.int(), month: z.string(), seconds: z.number() });
export type Usage = z.output<typeof Usage>;

const KeyFile = z.strictObject({ publicKey: z.base64url(), privateKey: z.base64url() });

/** A place nobody used for this long goes to the next person. */
export const PLACE_IDLE_MS = 14 * 24 * 3_600_000;

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
  add(kind: Client["kind"], name: string): { readonly id: string; readonly token: string } {
    const token = randomBytes(32).toString("base64url");
    const id = hashOf(token);
    writeJson(this.clientPath(id), { kind, name, createdAt: this.now() } satisfies Client);
    return { id, token };
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

  /** Seconds transcribed this month. */
  usage(id: string): Usage {
    const stored = Usage.safeParse(readJson(this.usagePath(id)));
    const month = monthOf(this.now());
    if (!stored.success) return { lastUsedAt: 0, month, seconds: 0 };
    return stored.data.month === month ? stored.data : { ...stored.data, month, seconds: 0 };
  }

  charge(id: string, seconds: number): void {
    if (!this.has(id)) return;
    const usage = this.usage(id);
    writeJson(this.usagePath(id), {
      ...usage,
      seconds: usage.seconds + seconds,
      lastUsedAt: this.now(),
    } satisfies Usage);
  }

  /** A beta place, or null when all `places` are taken by people who use theirs. */
  claim(places: number): string | null {
    const now = this.now();
    const beta = this.list().filter(({ client }) => client.kind === "beta");
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
