import type { KeepRecentResult } from "@sondine/api";
import { m } from "../renderer/paraglide/messages.js";

// « Garder les 2 dernières minutes » (plan.md, Later 1): one gesture from the
// menu bar, ⌃⌥⌘K from any app, or the sidebar, and the words it answers with,
// the same in the menu bar's title and in the window.

/** ⌃⌥⌘K, beside ⌃⌥⌘V (ADR 024); Electron leaves it to an app that registered it first. */
export const KEEP_RECENT_SHORTCUT = "Control+Alt+Command+K";

/** Kept this much or more reads « les 2 dernières minutes », not a length. */
const WHOLE_MS = 115_000;

/** What the gesture kept, in words; `null` when core did not answer. */
export function keepFeedback(result: KeepRecentResult | null, locale?: "en" | "fr"): string {
  const options = locale === undefined ? undefined : { locale };
  if (result === null) return m.keep_recent_failed({}, options);
  if (result.outcome === "nothing") return m.keep_recent_nothing({}, options);
  if (result.keptMs >= WHOLE_MS) return m.keep_recent_kept({}, options);
  const seconds = Math.max(1, Math.round(result.keptMs / 1_000));
  const duration =
    seconds < 60
      ? m.duration_seconds({ seconds: String(seconds) }, options)
      : m.duration_minutes({ minutes: String(Math.round(seconds / 60)) }, options);
  return m.keep_recent_partial({ duration }, options);
}
