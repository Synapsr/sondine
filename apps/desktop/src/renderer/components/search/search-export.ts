import {
  SEARCH_JSON_SCHEMA,
  type SearchEpisode,
  type SearchInput,
  type SearchJsonV2,
} from "@sondine/api";
import { dayOf } from "../../lib/day";
import { clock, fullDate, timeRange, voiceName } from "../../lib/labels";
import { voiceOf } from "../../lib/voices";
import { m } from "../../paraglide/messages.js";
import { markdownText, oneLine } from "../episode/transcript-export";

// Search results as the user takes them out of Sondine: each matching
// episode with its best matches (at most 5, as the screen shows them), their
// time and voice, in Markdown or as `sondine.search/2`.

const instant = (ms: number) => new Date(ms).toISOString();

const speakerOf = (result: SearchEpisode, hit: SearchEpisode["hits"][number]) =>
  hit.speakerOrdinal === null && !hit.self && hit.person === null
    ? null
    : voiceName(voiceOf(hit.speakerOrdinal, hit.self, result.selfOrdinal, hit.person));

/** The results' document, or null when there are none. */
export function searchDocument(
  input: Pick<SearchInput, "text" | "tag" | "from" | "to">,
  results: readonly SearchEpisode[],
  total: number,
  format: "md" | "json",
): string | null {
  if (results.length === 0) return null;
  // A tag alone is searched as « # idées » (ADR 039).
  const query = [input.text, input.tag === undefined ? undefined : `# ${input.tag}`]
    .filter((part) => part !== undefined)
    .join(" ");
  if (format === "json") {
    const document: SearchJsonV2 = {
      schema: SEARCH_JSON_SCHEMA,
      query,
      from: input.from ?? null,
      to: input.to ?? null,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      total,
      episodes: results.map((result) => ({
        id: result.episode.id,
        startedAt: instant(result.episode.startedAtMs),
        endedAt: result.episode.endedAtMs === null ? null : instant(result.episode.endedAtMs),
        context: result.episode.context,
        size: result.episode.size,
        hitCount: result.hitCount,
        hits: result.hits.map((hit) => ({
          start: instant(hit.startMs),
          end: instant(Math.max(hit.endMs, hit.startMs)),
          speaker: speakerOf(result, hit),
          text: oneLine(hit.text),
        })),
        contextHits: result.contextHits.map((hit) => ({ kind: hit.kind, text: oneLine(hit.text) })),
      })),
    };
    return `${JSON.stringify(document, null, 2)}\n`;
  }
  const lines = [
    `# ${markdownText(m.search_export_title({ query }))}`,
    "",
    m.search_total({ count: total }),
  ];
  for (const result of results) {
    const { episode } = result;
    lines.push(
      "",
      `## ${fullDate(dayOf(episode.startedAtMs))} · ${timeRange(episode.startedAtMs, episode.endedAtMs)}`,
    );
    for (const hit of result.hits) {
      const speaker = speakerOf(result, hit);
      lines.push(
        "",
        `${speaker === null ? "" : `**${markdownText(speaker)}** · `}${clock(hit.startMs)}`,
        markdownText(hit.text),
      );
    }
    for (const hit of result.contextHits) {
      lines.push("", `**${markdownText(m.search_context_hit())}**`, markdownText(hit.text));
    }
  }
  return `${lines.join("\n")}\n`;
}
