import type { AnalysisCheck, AnalysisStatus, AnalysisWaitReason } from "@sondine/api";

// What the next transcription waits for, one row per condition (ADR 016
// admission), from `analysis.check`: met or not, and what the Mac reports
// when it matters. A request skips power and idle, so those rows go. Words
// are the panel's (analysis-checks.tsx).

export type CheckKey = "model" | "server" | "power" | "idle" | "heat" | "memory";

/** Why the compute server takes nothing now. */
export type ServerReason = "server-offline" | "server-busy" | "server-refused" | "server-quota";
const SERVER_REASONS: readonly ServerReason[] = [
  "server-offline",
  "server-busy",
  "server-refused",
  "server-quota",
];

export type CheckDetail =
  | { readonly kind: "no-model" }
  | { readonly kind: ServerReason }
  | { readonly kind: "on-battery" }
  | { readonly kind: "locked" }
  | { readonly kind: "used"; readonly seconds: number }
  | { readonly kind: "idle"; readonly seconds: number }
  | { readonly kind: "hot" }
  | {
      readonly kind: "pressure";
      readonly pressure: "warn" | "critical";
      readonly use: AnalysisCheck["memoryUse"];
    }
  | { readonly kind: "room"; readonly roomBytes: number; readonly neededBytes: number }
  | { readonly kind: "swap" }
  /** The user turned this condition off: automatic jobs no longer wait for it. */
  | { readonly kind: "waived" }
  | { readonly kind: "unknown" };

/** The conditions the user may turn off; the model and heat always count. */
export type AdjustableKey = keyof AnalysisCheck["waitFor"];

export interface CheckRow {
  readonly key: CheckKey;
  readonly ok: boolean;
  readonly detail: CheckDetail | null;
  /** Its switch: on while automatic jobs wait for it; null for the model and heat. */
  readonly waitedFor: boolean | null;
}

/** What the panel says under the rows. */
export type CheckSummary =
  | "running"
  /** A memory refusal or a failed job holds the queue for a while. */
  | "retry-later"
  | "nothing-queued"
  /** Only traces wait: they run only while the engine is loaded for other work. */
  | "traces"
  | "ready"
  /** Only power or idle stand in the way: a conversation's « Transcrire maintenant » skips both. */
  | "request-now"
  | null;

const blocks = (check: AnalysisCheck, ...reasons: readonly AnalysisWaitReason[]) =>
  reasons.some((reason) => check.reasons.includes(reason));

export function checkRows(check: AnalysisCheck): readonly CheckRow[] {
  const model = !blocks(check, "no-model");
  const power = !blocks(check, "on-battery");
  const idle = !blocks(check, "not-idle");
  const heat = !blocks(check, "thermal");
  const memory = !blocks(check, "memory", "swap");
  const waived = (key: AdjustableKey) => !check.waitFor[key];
  const rows: CheckRow[] = [
    { key: "model", ok: model, detail: model ? null : { kind: "no-model" }, waitedFor: null },
    {
      key: "power",
      ok: power,
      detail: waived("power")
        ? { kind: "waived" }
        : power
          ? null
          : check.onBattery === null
            ? { kind: "unknown" }
            : { kind: "on-battery" },
      waitedFor: check.waitFor.power,
    },
    {
      key: "idle",
      ok: idle,
      detail: waived("idle") ? { kind: "waived" } : idleDetail(check, idle),
      waitedFor: check.waitFor.idle,
    },
    {
      key: "heat",
      ok: heat,
      detail: heat
        ? null
        : check.thermalState === null || check.thermalState === "unknown"
          ? { kind: "unknown" }
          : { kind: "hot" },
      waitedFor: null,
    },
    {
      key: "memory",
      ok: memory,
      // Turned off, memory still stops a job at critical pressure or without swap room.
      detail: memory ? (waived("memory") ? { kind: "waived" } : null) : memoryDetail(check),
      waitedFor: check.waitFor.memory,
    },
  ];
  if (check.remote) {
    const reason = SERVER_REASONS.find((candidate) => check.reasons.includes(candidate));
    return [
      {
        key: "server",
        ok: reason === undefined,
        detail: reason === undefined ? null : { kind: reason },
        waitedFor: null,
      },
      // Only a Mac in trouble holds a server's job back.
      ...rows
        .filter((row) => !row.ok && (row.key === "heat" || row.key === "memory"))
        .map((row) => ({ ...row, waitedFor: null })),
    ];
  }
  return check.requested ? rows.filter((row) => row.key !== "power" && row.key !== "idle") : rows;
}

function idleDetail(check: AnalysisCheck, ok: boolean): CheckDetail {
  if (check.locked) return { kind: "locked" };
  if (check.idleSeconds === null) return { kind: "unknown" };
  return ok
    ? { kind: "idle", seconds: check.idleSeconds }
    : { kind: "used", seconds: check.idleSeconds };
}

function memoryDetail(check: AnalysisCheck): CheckDetail {
  if (blocks(check, "swap")) return { kind: "swap" };
  const { swapRoomBytes: room, swapRoomNeededBytes: needed } = check;
  if (needed !== null && room !== null && room < needed) {
    return { kind: "room", roomBytes: room, neededBytes: needed };
  }
  if (needed !== null && room === null) return { kind: "unknown" };
  if (check.memoryPressure === "warn" || check.memoryPressure === "critical") {
    return { kind: "pressure", pressure: check.memoryPressure, use: check.memoryUse };
  }
  return { kind: "unknown" };
}

/** Apps drawn one by one on the memory bar; the rest share one segment. */
export const BAR_APPS = 4;

export interface MemoryBar {
  /** Shares of the counted memory, the most first; `name` null for the other apps. */
  readonly segments: readonly {
    readonly name: string | null;
    /** The app's bundle, for its icon; null for the other apps, macOS and tools. */
    readonly appPath: string | null;
    readonly bytes: number;
    readonly share: number;
  }[];
  /** Where the line goes: under it, the job is no longer refused. */
  readonly limitShare: number;
  /** Compressed memory to free to get under the line; 0 once under it. */
  readonly toFreeBytes: number;
}

/**
 * The compressed memory as a bar over everything macOS counts for its
 * pressure level (macOS Settings' storage bar, Téo's idea), with the line.
 */
export function memoryBar(use: NonNullable<AnalysisCheck["memoryUse"]>): MemoryBar {
  const counted = Math.max(use.countedBytes, 1);
  const named = use.apps.slice(0, BAR_APPS);
  const namedBytes = named.reduce((sum, app) => sum + app.bytes, 0);
  const other = Math.max(0, use.compressedBytes - namedBytes);
  return {
    segments: [
      ...named.map((app) => ({
        name: app.name,
        appPath: app.appPath,
        bytes: app.bytes,
        share: app.bytes / counted,
      })),
      ...(other === 0 ? [] : [{ name: null, appPath: null, bytes: other, share: other / counted }]),
    ],
    limitShare: Math.min(1, use.limitBytes / counted),
    toFreeBytes: Math.max(0, use.compressedBytes - use.limitBytes),
  };
}

export function checkSummary(
  analysis: AnalysisStatus,
  check: AnalysisCheck,
  rows: readonly CheckRow[],
): CheckSummary {
  if (analysis.running !== null) return "running";
  if (blocks(check, "retry-later")) return "retry-later";
  const { requested, conversations, moments, media, traces } = analysis.queued;
  if (requested + conversations + moments + media === 0) {
    return traces === 0 ? "nothing-queued" : "traces";
  }
  const blocked = rows.filter((row) => !row.ok);
  if (blocked.length === 0) return "ready";
  return !check.requested && blocked.every((row) => row.key === "power" || row.key === "idle")
    ? "request-now"
    : null;
}
