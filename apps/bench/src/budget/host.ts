import * as z from "zod";
import { toolText } from "../exec.ts";

// Host facts recorded with every result: same-machine comparisons are only meaningful on the
// same chip, OS build, power source and thermal state (architecture §13).

export const powerStateSchema = z.object({
  source: z.enum(["ac", "battery", "ups", "unknown"]),
  batteryPercent: z.number().nullable(),
  raw: z.string(),
});
export type PowerState = z.infer<typeof powerStateSchema>;

export const thermalStateSchema = z.object({
  /** null when pmset says none has been recorded. */
  warningLevel: z.int().nullable(),
  performanceWarningLevel: z.int().nullable(),
  cpuSpeedLimit: z.int().nullable(),
  raw: z.string(),
});
export type ThermalState = z.infer<typeof thermalStateSchema>;

export const hostSchema = z.object({
  chip: z.string(),
  model: z.string(),
  cores: z.object({
    logical: z.int().nullable(),
    physical: z.int().nullable(),
    performance: z.int().nullable(),
    efficiency: z.int().nullable(),
  }),
  memoryBytes: z.number().nullable(),
  os: z.object({ productVersion: z.string(), buildVersion: z.string() }),
  lowPowerMode: z.boolean().nullable(),
  power: z.object({ start: powerStateSchema, end: powerStateSchema }),
  thermal: z.object({ start: thermalStateSchema, end: thermalStateSchema }),
});
export type Host = z.infer<typeof hostSchema>;

export function parseSwVers(text: string): { productVersion: string; buildVersion: string } {
  const field = (name: string) =>
    new RegExp(`^${name}:\\s*(.+)$`, "m").exec(text)?.[1]?.trim() ?? "unknown";
  return { productVersion: field("ProductVersion"), buildVersion: field("BuildVersion") };
}

/** `pmset -g batt`: "Now drawing from 'AC Power'" and, on a laptop, "37%; discharging". */
export function parsePowerSource(text: string): PowerState {
  const from = /Now drawing from '([^']+)'/.exec(text)?.[1] ?? "";
  const source = from.startsWith("AC")
    ? "ac"
    : from.startsWith("Battery")
      ? "battery"
      : from.startsWith("UPS")
        ? "ups"
        : "unknown";
  const percent = /(\d{1,3})%;/.exec(text)?.[1];
  return {
    source,
    batteryPercent: percent === undefined ? null : Number(percent),
    raw: text.trim(),
  };
}

/** `pmset -g therm`: levels appear only once macOS has recorded a warning. */
export function parseThermal(text: string): ThermalState {
  const integer = (pattern: RegExp) => {
    const value = pattern.exec(text)?.[1];
    return value === undefined ? null : Number(value);
  };
  return {
    warningLevel: integer(/Thermal Warning Level\s*=\s*(\d+)/i),
    performanceWarningLevel: integer(/Performance Warning Level\s*=\s*(\d+)/i),
    cpuSpeedLimit: integer(/CPU_Speed_Limit\s*=\s*(\d+)/),
    raw: text.trim(),
  };
}

/** `pmset -g`: "lowpowermode 0". */
export function parseLowPowerMode(text: string): boolean | null {
  const value = /^\s*lowpowermode\s+(\d)/m.exec(text)?.[1];
  return value === undefined ? null : value === "1";
}

async function sysctl(name: string): Promise<string | null> {
  const text = await toolText("/usr/sbin/sysctl", ["-n", name]);
  return text === null ? null : text.trim();
}

async function sysctlInt(name: string): Promise<number | null> {
  const text = await sysctl(name);
  if (text === null || !/^\d+$/.test(text)) return null;
  return Number(text);
}

export async function readPowerState(): Promise<PowerState> {
  const text = await toolText("/usr/bin/pmset", ["-g", "batt"]);
  return text === null
    ? { source: "unknown", batteryPercent: null, raw: "" }
    : parsePowerSource(text);
}

export async function readThermalState(): Promise<ThermalState> {
  const text = await toolText("/usr/bin/pmset", ["-g", "therm"]);
  return text === null
    ? { warningLevel: null, performanceWarningLevel: null, cpuSpeedLimit: null, raw: "" }
    : parseThermal(text);
}

export type HostSnapshot = Omit<Host, "power" | "thermal"> & {
  power: PowerState;
  thermal: ThermalState;
};

export async function readHost(): Promise<HostSnapshot> {
  const [
    chip,
    model,
    logical,
    physical,
    performance,
    efficiency,
    memoryBytes,
    swVers,
    settings,
    power,
    thermal,
  ] = await Promise.all([
    sysctl("machdep.cpu.brand_string"),
    sysctl("hw.model"),
    sysctlInt("hw.ncpu"),
    sysctlInt("hw.physicalcpu"),
    sysctlInt("hw.perflevel0.physicalcpu"),
    sysctlInt("hw.perflevel1.physicalcpu"),
    sysctlInt("hw.memsize"),
    toolText("/usr/bin/sw_vers", []),
    toolText("/usr/bin/pmset", ["-g"]),
    readPowerState(),
    readThermalState(),
  ]);
  return {
    chip: chip ?? "unknown",
    model: model ?? "unknown",
    cores: { logical, physical, performance, efficiency },
    memoryBytes,
    os:
      swVers === null
        ? { productVersion: "unknown", buildVersion: "unknown" }
        : parseSwVers(swVers),
    lowPowerMode: settings === null ? null : parseLowPowerMode(settings),
    power,
    thermal,
  };
}

/** Results are comparable when they come from the same machine, OS build and power source. */
export function sameConditions(a: Host, b: Host): boolean {
  return (
    a.chip === b.chip &&
    a.model === b.model &&
    a.os.buildVersion === b.os.buildVersion &&
    a.power.start.source === b.power.start.source
  );
}
