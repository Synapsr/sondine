import type { Database } from "./database";
import { str } from "./rows";

// Where the final transcription runs (ADR 040): this Mac, always, unless the
// user chose a compute server. A server's token is kept here, beside the
// transcripts it produced: whoever reads this database already has those.

export const COMPUTE_DESTINATIONS = ["device", "own", "beta"] as const;
export type ComputeDestination = (typeof COMPUTE_DESTINATIONS)[number];

export interface ComputeServer {
  readonly endpoint: string;
  /** Its public key, base64url. */
  readonly serverKey: string;
  readonly token: string;
  readonly name: string;
  /** True when joined via a Wave 1 invite link/code (never sends `leave` on disconnect). */
  readonly invited?: boolean;
}

export interface ComputeSettings {
  readonly destination: ComputeDestination;
  readonly own: ComputeServer | null;
  readonly beta: ComputeServer | null;
}

const KEY = "compute";
const ON_DEVICE: ComputeSettings = { destination: "device", own: null, beta: null };

function server(value: unknown): ComputeServer | null {
  if (typeof value !== "object" || value === null) return null;
  const { endpoint, serverKey, token, name, invited } = value as Record<string, unknown>;
  if (
    typeof endpoint !== "string" ||
    typeof serverKey !== "string" ||
    typeof token !== "string" ||
    typeof name !== "string"
  ) {
    return null;
  }
  return invited === true
    ? { endpoint, serverKey, token, name, invited: true }
    : { endpoint, serverKey, token, name };
}

export function computeSettings(db: Database): ComputeSettings {
  const row = db.statement("SELECT value FROM settings WHERE key = ?").get(KEY);
  if (row === undefined) return ON_DEVICE;
  const value: unknown = JSON.parse(str(row, "value"));
  if (typeof value !== "object" || value === null) return ON_DEVICE;
  const stored = value as Record<string, unknown>;
  const own = server(stored["own"]);
  const beta = server(stored["beta"]);
  // Anything unreadable means this Mac: nothing leaves without a clear choice.
  const destination =
    (stored["destination"] === "own" && own !== null) ||
    (stored["destination"] === "beta" && beta !== null)
      ? (stored["destination"] as ComputeDestination)
      : "device";
  return { destination, own, beta };
}

export function setComputeSettings(db: Database, settings: ComputeSettings, nowMs: number): void {
  db.statement(
    `INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
  ).run(KEY, JSON.stringify(settings), nowMs);
}
