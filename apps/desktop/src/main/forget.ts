import { app, dialog } from "electron";
import type { AppClient } from "@sondine/api";
import { m } from "../renderer/paraglide/messages.js";
import { log } from "./log";
import type { ForgetMinutes } from "./tray";
import type { TrayLocale } from "./tray-state";

// « Effacer les N dernières minutes » from the menu bar: what it deletes,
// asked in a native alert (the window may be closed), then core erases it.

export async function confirmAndForget(
  client: AppClient,
  minutes: ForgetMinutes,
  locale: TrayLocale,
): Promise<void> {
  const options = { locale };
  const preview = await client.episodes.forgetPreview({ minutes });
  const range =
    minutes === 60
      ? m.forget_last_hour({}, options)
      : m.forget_last_minutes({ minutes: String(minutes) }, options);
  const clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  const lines = preview.episodes.map((episode) => {
    const end =
      episode.endedAtMs === null ? m.forget_ongoing({}, options) : clock.format(episode.endedAtMs);
    const before =
      episode.startedAtMs < preview.fromMs ? ` (${m.forget_started_before({}, options)})` : "";
    return `${clock.format(episode.startedAtMs)} – ${end}${before}`;
  });
  const detail = [
    m.forget_description({}, options),
    ...(lines.length === 0
      ? []
      : ["", m.forget_recordings({ count: lines.length }, options), ...lines]),
  ].join("\n");
  app.focus({ steal: true });
  const { response } = await dialog.showMessageBox({
    type: "warning",
    message: m.forget_title({ range }, options),
    detail,
    buttons: [m.forget_confirm({}, options), m.cancel({}, options)],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return;
  const result = await client.episodes.forget({ minutes, untilMs: preview.toMs });
  log.info("tray.forgot", { minutes, episodes: result.episodeIds.length });
}
