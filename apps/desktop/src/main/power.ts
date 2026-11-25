import { powerMonitor } from "electron";
import type { MainToCore, PowerEventName } from "../shared/core-messages";

// Power and session events are forwarded to core, which records them (sleep
// and wake split episodes) and adjusts its scheduling. Main decides nothing.

export function powerSnapshot(event: PowerEventName): Extract<MainToCore, { type: "power" }> {
  return {
    type: "power",
    event,
    atMs: Date.now(),
    onBattery: powerMonitor.isOnBatteryPower(),
    thermalState: powerMonitor.getCurrentThermalState(),
  };
}

/** Calls `post` for every power event; `onShutdown` when macOS is shutting down. */
export function forwardPowerEvents(
  post: (message: MainToCore) => void,
  onShutdown: () => void,
): void {
  const forward = (event: PowerEventName) => () => {
    post(powerSnapshot(event));
    if (event === "shutdown") onShutdown();
  };
  powerMonitor.on("suspend", forward("suspend"));
  powerMonitor.on("resume", forward("resume"));
  powerMonitor.on("on-ac", forward("on-ac"));
  powerMonitor.on("on-battery", forward("on-battery"));
  powerMonitor.on("lock-screen", forward("lock-screen"));
  powerMonitor.on("unlock-screen", forward("unlock-screen"));
  powerMonitor.on("thermal-state-change", forward("thermal-state-change"));
  powerMonitor.on("shutdown", forward("shutdown"));
}

/** Admission needs 2 min without input, or a locked screen, for automatic analysis. */
const IDLE_THRESHOLD_SECONDS = 120;

/** Main's answer to core's `idle-query`. */
export function idleSnapshot(): Extract<MainToCore, { type: "idle" }> {
  return {
    type: "idle",
    idleSeconds: powerMonitor.getSystemIdleTime(),
    locked: powerMonitor.getSystemIdleState(IDLE_THRESHOLD_SECONDS) === "locked",
    atMs: Date.now(),
  };
}
