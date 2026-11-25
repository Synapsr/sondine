import type { CaptureHold } from "@sondine/api";
import { m } from "../renderer/paraglide/messages.js";
import { pauseEndLabel } from "./timed-pause";

// Why a private zone holds capture (ADR 029), in one line per hold, in the
// menu bar and in the window's listening menu.

/**
 * « N'écoute pas : la nuit, jusqu'à 07:00 », « Micro coupé : Zoom »: one line
 * per hold of a private zone (ADR 029), those that hold everything first.
 */
export function holdLines(holds: readonly CaptureHold[], locale: "fr" | "en"): string[] {
  const options = { locale };
  const reason = (hold: CaptureHold) => {
    switch (hold.reason) {
      case "calls":
        return m.tray_hold_calls({}, options);
      case "screen":
        return m.tray_hold_screen({}, options);
      default:
        return hold.zoneId === "night" ? m.privacy_night({}, options) : (hold.name ?? "");
    }
  };
  return holds
    .toSorted((a, b) => (a.scope === b.scope ? a.sinceMs - b.sinceMs : a.scope === "all" ? -1 : 1))
    .map((hold) =>
      hold.scope === "microphone"
        ? m.tray_mic_held({ reason: reason(hold) }, options)
        : hold.untilMs === null
          ? m.tray_held({ reason: reason(hold) }, options)
          : m.tray_held_until(
              { reason: reason(hold), time: pauseEndLabel(hold.untilMs, Date.now(), locale) },
              options,
            ),
    );
}
