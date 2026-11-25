import { describe, expect, it } from "vitest";
import {
  appOf,
  appShares,
  parseProcesses,
  parseTopCompressed,
  parseVmStat,
  readAppCompressed,
  readVmCounts,
} from "./memory-use";
import { createSystemSignals } from "./system-signals";

const PAGE = 16_384;

// `vm_stat` on Téo's Mac under warn pressure (2026-11-08).
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    15433.
Pages active:                                 360033.
Pages inactive:                               357131.
Pages speculative:                               494.
Pages throttled:                                   0.
Pages wired down:                             416030.
Pages purgeable:                                3209.
Pages stored in compressor:                  1632932.
Pages occupied by compressor:                 894569.
`;

const TOP = `Processes: 1020 total, 3 running, 1017 sleeping, 6200 threads
2026/11/08 09:40:00
PID    CMPRS
8633   1203M
2621   484M+
3454   609M-
609    220M
42     0B
91276  12K
`;

const PS = `    1     0 /sbin/launchd
 1299     1 /Applications/Cursor.app/Contents/MacOS/Cursor
 2621  1299 /Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Renderer).app/Contents/MacOS/Cursor Helper (Renderer)
 3802  1299 /Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)
 8633  3802 /Users/me/.cursor/extensions/native-preview/lib/tsc
 3400     1 /Applications/Ghostty.app/Contents/MacOS/ghostty
 3401  3400 /bin/zsh
 3454  3401 /Users/me/.local/bin/codex
  609     1 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer
  700     1 /usr/local/bin/some-daemon
  536     1 /usr/libexec/logd
`;

describe("what holds the memory macOS counts for its pressure", () => {
  it("reads the pages kept uncompressed and the RAM the compressor occupies", () => {
    expect(parseVmStat(VM_STAT)).toEqual({
      uncompressedBytes: (15_433 + 360_033 + 357_131 + 494) * PAGE,
      compressedBytes: 894_569 * PAGE,
    });
    expect(parseVmStat("Mach Virtual Memory Statistics:")).toBeNull();
  });

  it("reads each process's compressed memory, with top's trend marks", () => {
    expect(parseTopCompressed(TOP)).toEqual(
      new Map([
        [8633, 1203 * 1024 ** 2],
        [2621, 484 * 1024 ** 2],
        [3454, 609 * 1024 ** 2],
        [609, 220 * 1024 ** 2],
        [91276, 12 * 1024],
      ]),
    );
  });

  it("puts a process with the app that quitting would stop", () => {
    const processes = parseProcesses(PS);
    expect(processes.get(2621)?.path).toContain("Cursor Helper (Renderer).app");
    // A helper, and a language server the editor started.
    expect(appOf(2621, processes)).toEqual({ name: "Cursor", appPath: "/Applications/Cursor.app" });
    expect(appOf(8633, processes).name).toBe("Cursor");
    // A command started in a terminal.
    expect(appOf(3454, processes).name).toBe("Ghostty");
    expect(appOf(609, processes)).toEqual({ name: "macOS", appPath: null });
    expect(appOf(536, processes).name).toBe("macOS");
    expect(appOf(700, processes)).toEqual({ name: "some-daemon", appPath: null });
    expect(appOf(12_345, processes).name).toBe("?");
  });

  it("shares the compressor's RAM between apps, the most first", () => {
    const shares = appShares(parseTopCompressed(TOP), parseProcesses(PS), 1_000_000_000);
    expect(shares.map((app) => app.name)).toEqual(["Cursor", "Ghostty", "macOS", "?"]);
    const total = shares.reduce((sum, app) => sum + app.bytes, 0);
    expect(Math.abs(total - 1_000_000_000)).toBeLessThan(10);
  });

  // `top` takes a second or more, longer on a busy Mac.
  it("reads this Mac", { timeout: 20_000 }, async () => {
    const vm = await readVmCounts();
    expect(vm?.uncompressedBytes).toBeGreaterThan(0);
    const reading = await readAppCompressed();
    expect(reading?.processes.size).toBeGreaterThan(10);
  });

  it("runs top once for panels that ask together, then keeps it a while", async () => {
    let tops = 0;
    let now = 0;
    const signals = createSystemSignals({
      power: () => ({ onBattery: false, suspended: false, thermalState: "nominal" }),
      queryIdle: () => undefined,
      now: () => now,
      readVm: async () => ({ uncompressedBytes: 10, compressedBytes: 100 }),
      readApps: async () => {
        tops += 1;
        return { compressed: new Map([[1299, 5]]), processes: parseProcesses(PS) };
      },
    });
    const [first] = await Promise.all([signals.memoryUse(), signals.memoryUse()]);
    expect(first?.apps).toEqual([
      { name: "Cursor", appPath: "/Applications/Cursor.app", bytes: 100 },
    ]);
    now = 10_000;
    await signals.memoryUse();
    expect(tops).toBe(1);
    now = 20_000;
    await signals.memoryUse();
    expect(tops).toBe(2);
  });
});
