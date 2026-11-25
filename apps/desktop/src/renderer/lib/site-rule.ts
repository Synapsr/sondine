import type { PrivacyZone } from "@sondine/api";

/**
 * Whether Sondine still keeps what a site plays, by the zones as Settings
 * shows them (ADR 029): left out when a zone of that site, or the built-in
 * films, series and music zone with the site switched off, is on and keeps
 * nothing. Returns the site's own zone too, the one « Ne plus garder » turns
 * on (or adds when there is none).
 */
export function siteRule(
  zones: readonly PrivacyZone[],
  site: string,
): { readonly kept: boolean; readonly zone: PrivacyZone | null } {
  const zone =
    zones.find((each) => each.situation.kind === "site" && each.situation.site === site) ?? null;
  const leftOutBySite = zone !== null && zone.on && zone.outcome === "nothing";
  const leftOutAsMedia = zones.some(
    (each) =>
      each.situation.kind === "media_sites" &&
      each.on &&
      each.outcome === "nothing" &&
      each.situation.sites.some((entry) => entry.site === site && !entry.kept),
  );
  return { kept: !leftOutBySite && !leftOutAsMedia, zone };
}
