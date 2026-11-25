import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import type { PowerStatus } from "@sondine/api";
import type { MemoryPressure, SystemSample } from "./admission";
import {
  appShares,
  readAppCompressed,
  readVmCounts,
  type MemoryUse,
  type VmCounts,
} from "./memory-use";

type AppReading = NonNullable<Awaited<ReturnType<typeof readAppCompressed>>>;

// What admission reads about the Mac. Core is an Electron utility process:
// power, thermal state, idle time and the lock state come from main (power
// events, and an `idle` answer to each `idle-query`); memory pressure and swap
// come from `sysctl`, and the room left for swap from the VM volume, read only
// when the cheap conditions already pass. What holds that memory, app by app
// (memory-use.ts), is read only for the window.

const SYSCTL = "/usr/sbin/sysctl";
/** Where macOS keeps swap files; an APFS volume sharing the container's free space. */
const SWAP_VOLUME = "/System/Volumes/VM";

/** Main's answer to `idle-query`. */
export interface IdleState {
  readonly idleSeconds: number;
  readonly locked: boolean;
  readonly atMs: number;
}

export interface MemoryState {
  readonly memoryPressure: MemoryPressure | null;
  readonly swapUsedBytes: number | null;
  readonly swapRoomBytes: number | null;
}

export interface SystemSignalsPort {
  /** Power, thermal state, idle and lock; memory fields are null. */
  cheap(): Promise<SystemSample>;
  /** Memory pressure, swap in use, and the room left for swap. */
  memory(): Promise<MemoryState>;
  /** What holds the memory pressure counts, app by app; for the window only. */
  memoryUse(): Promise<MemoryUse | null>;
}

/** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export function parseMemoryPressure(output: string): MemoryPressure | null {
  switch (output.trim()) {
    case "1":
      return "normal";
    case "2":
      return "warn";
    case "4":
      return "critical";
    default:
      return null;
  }
}

const UNITS: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** `vm.swapusage`: `total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)`. */
export function parseSwapUsage(output: string): number | null {
  const match = /used\s*=\s*([\d.]+)([KMGT])/.exec(output);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const unit = UNITS[match[2]];
  const value = Number.parseFloat(match[1]);
  if (unit === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * unit);
}

function run(file: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: 2_000, encoding: "utf8" }, (error, stdout) =>
      resolve(error === null ? stdout : null),
    );
  });
}

async function swapRoom(): Promise<number | null> {
  try {
    const stats = await statfs(SWAP_VOLUME);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

export async function readMemoryState(): Promise<MemoryState> {
  const [pressure, swap, room] = await Promise.all([
    run(SYSCTL, ["-n", "kern.memorystatus_vm_pressure_level"]),
    run(SYSCTL, ["-n", "vm.swapusage"]),
    swapRoom(),
  ]);
  return {
    memoryPressure: pressure === null ? null : parseMemoryPressure(pressure),
    swapUsedBytes: swap === null ? null : parseSwapUsage(swap),
    swapRoomBytes: room,
  };
}

/** How long the first reading waits for main's power snapshot. */
const POWER_WAIT_MS = 2_000;

/** How long to wait for main's idle answer before using the last one. */
const IDLE_REPLY_MS = 1_000;
/** An idle answer older than this is not used. */
const IDLE_FRESH_MS = 30_000;

/** The app list is read again after this long: `top` costs about a second of CPU. */
const APPS_FRESH_MS = 15_000;

export interface SystemSignalsOptions {
  readonly power: () => PowerStatus;
  /**
   * Settles once main sent its first power snapshot. Until then power and heat
   * read null, which admission takes as « on battery » and « hot »: the first
   * look at launch said « waits for the Mac to cool down » on a cool Mac.
   */
  readonly powerKnown?: Promise<void>;
  /** Posts `idle-query` to main. */
  readonly queryIdle: () => void;
  readonly readMemory?: () => Promise<MemoryState>;
  readonly readVm?: () => Promise<VmCounts | null>;
  readonly readApps?: typeof readAppCompressed;
  readonly now?: () => number;
  /** How long to wait for main's answer; defaults to 1 s. */
  readonly idleReplyMs?: number;
}

export interface SystemSignals extends SystemSignalsPort {
  /** Main's `idle` message. */
  receiveIdle(state: IdleState): void;
}

export function createSystemSignals(options: SystemSignalsOptions): SystemSignals {
  const now = options.now ?? Date.now;
  const readMemory = options.readMemory ?? readMemoryState;
  const readVm = options.readVm ?? readVmCounts;
  const readApps = options.readApps ?? readAppCompressed;
  let idle: IdleState | null = null;
  let apps: { readonly atMs: number; readonly reading: AppReading | null } | null = null;
  let appsPending: Promise<AppReading | null> | null = null;

  /** One `top` at a time, kept for `APPS_FRESH_MS`. */
  async function appReading(): Promise<AppReading | null> {
    if (apps !== null && now() - apps.atMs < APPS_FRESH_MS) return apps.reading;
    appsPending ??= readApps().finally(() => {
      appsPending = null;
    });
    const reading = await appsPending;
    apps = { atMs: now(), reading };
    return reading;
  }

  async function memoryUse(): Promise<MemoryUse | null> {
    const [vm, reading] = await Promise.all([readVm(), appReading()]);
    if (vm === null) return null;
    return {
      ...vm,
      apps:
        reading === null
          ? []
          : appShares(reading.compressed, reading.processes, vm.compressedBytes),
    };
  }
  let waiters: (() => void)[] = [];

  async function freshIdle(): Promise<IdleState | null> {
    const askedAt = now();
    options.queryIdle();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, options.idleReplyMs ?? IDLE_REPLY_MS);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      waiters.push(done);
    });
    if (idle === null || askedAt - idle.atMs > IDLE_FRESH_MS) return null;
    return idle;
  }

  async function cheap(): Promise<SystemSample> {
    if (options.powerKnown !== undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        options.powerKnown,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, POWER_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    const power = options.power();
    const state = await freshIdle();
    return {
      onBattery: power.onBattery,
      thermalState: power.thermalState,
      idleSeconds: state?.idleSeconds ?? null,
      locked: state?.locked ?? false,
      memoryPressure: null,
      swapUsedBytes: null,
      swapRoomBytes: null,
    };
  }

  return {
    cheap,
    memory: readMemory,
    memoryUse,
    receiveIdle(state) {
      idle = state;
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) resolve();
    },
  };
}
