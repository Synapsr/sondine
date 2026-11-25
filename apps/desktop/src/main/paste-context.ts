import type { ContextOngoingResult } from "@sondine/api";
import { m } from "../renderer/paraglide/messages.js";
import type { TrayLocale } from "./tray-state";

// ⌃⌥⌘V from any app (ADR 024): what the clipboard holds goes to the
// conversation going on, and the menu bar says so for a moment. Electron
// leaves a shortcut another app registered first to that app.

export const PASTE_CONTEXT_SHORTCUT = "Control+Alt+Command+V";

/** How long the menu bar shows the outcome. */
export const PASTE_FEEDBACK_MS = 2_500;

/** What the menu bar reads after ⌃⌥⌘V; `null` when core did not answer. */
export function pasteFeedback(result: ContextOngoingResult | null, locale: TrayLocale): string {
  const options = { locale };
  if (result === null) return m.tray_paste_failed({}, options);
  if (result.outcome === "none") return m.tray_paste_none({}, options);
  if (result.itemIds.length > 0) return m.tray_paste_added({}, options);
  if (result.refused.length === 0) return m.tray_paste_empty({}, options);
  return m.tray_paste_failed({}, options);
}
