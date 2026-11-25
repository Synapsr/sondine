import type { EpisodePrivacy } from "@sondine/api";
import { m } from "../../paraglide/messages.js";
import { outcomeDetail, zoneTitle } from "../settings/privacy-section";

// One line under an episode's title when a private zone changed something,
// when its audio is gone, or when the user keeps it (ADR 029). Nothing
// otherwise.

export function PrivacyLine({ privacy }: { privacy: EpisodePrivacy }) {
  const lines = privacy.kept
    ? [m.episode_audio_kept()]
    : privacy.zones.length > 0
      ? privacy.zones.map((zone) =>
          m.episode_zone_line({ name: zoneTitle(zone), what: outcomeDetail(zone) }),
        )
      : privacy.audioGone
        ? [m.episode_audio_gone()]
        : [];
  if (lines.length === 0) return null;
  return <p className="text-body-s text-cte-text-muted">{lines.join(" · ")}</p>;
}
