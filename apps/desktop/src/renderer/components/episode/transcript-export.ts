import {
  DAY_JSON_SCHEMA,
  TRANSCRIPT_JSON_SCHEMA,
  type DayJsonV2,
  type EpisodeDetail,
  type TranscriptFormat,
  type TranscriptJsonV2,
} from "@sondine/api";
import { formatBytes } from "../../lib/bytes";
import { dayOf } from "../../lib/day";
import {
  clock,
  contextLabel,
  episodeLength,
  formatDuration,
  fullDate,
  timeRange,
  voiceName,
} from "../../lib/labels";
import { formatOffset } from "../../lib/time";
import { voiceOfLabel, voicesByLabel } from "../../lib/voices";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
import { groupTurns } from "./transcript-view";

// A transcript as the user takes it out of Sondine, with the names the user
// gave its voices (a voice Sondine only recognized keeps its number: what
// leaves the app holds no guess, ADR 030), in the user's language. Markdown reads well in a plain text
// editor: the date and times as a heading, the length and context, then the
// turns with their offset in the recording. Subtitles (SRT, WebVTT) are timed
// on the exported audio, which starts at the playback timeline's first
// sample: one cue per segment, with its voice. JSON is `sondine.transcript/2`
// (packages/api/src/transcript-json.ts), for scripts and agents.

/** The document, or null when there is no transcript to take. */
export function transcriptDocument(
  detail: EpisodeDetail,
  format: TranscriptFormat,
  timelineStartMs: number | null,
): string | null {
  const segments = detail.segments.filter((segment) => oneLine(segment.text) !== "");
  if (segments.length === 0) return null;
  const transcript = { ...detail, segments };
  switch (format) {
    case "md":
      return markdown(transcript);
    case "srt":
    case "vtt":
      return subtitles(transcript, format, timelineStartMs ?? detail.episode.startedAtMs);
    case "json":
      return `${JSON.stringify(transcriptJson(transcript), null, 2)}\n`;
  }
}

const instant = (ms: number) => new Date(ms).toISOString();

/** The transcript as `sondine.transcript/2`, voices named by the user. */
export function transcriptJson(detail: EpisodeDetail): TranscriptJsonV2 {
  const { episode } = detail;
  const voices = voicesByLabel(detail.speakers, { recognized: false });
  return {
    schema: TRANSCRIPT_JSON_SCHEMA,
    episode: {
      id: episode.id,
      startedAt: instant(episode.startedAtMs),
      endedAt: episode.endedAtMs === null ? null : instant(episode.endedAtMs),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      context: episode.context,
      size: episode.size,
      apps: episode.apps.map((app) => app.name),
    },
    speakers: detail.speakers.map((speaker) => ({
      label: speaker.label,
      name: voiceName(voiceOfLabel(voices, speaker.label)),
      self: speaker.self || speaker.person?.self === true,
      person:
        speaker.person === null || speaker.person.self
          ? null
          : { id: speaker.person.id, name: speaker.person.name },
      voicedMs: speaker.voicedMs,
    })),
    segments: detail.segments.map((segment) => ({
      start: instant(segment.startMs),
      end: instant(Math.max(segment.endMs, segment.startMs)),
      offsetMs: Math.max(0, segment.startMs - episode.startedAtMs),
      speaker: segment.speakerLabel,
      text: oneLine(segment.text),
      lang: segment.lang,
      edited: segment.edited,
    })),
    context: detail.context.map((item) => ({
      kind: item.kind,
      addedAt: instant(item.addedAtMs),
      pinnedAt: item.pinned ? instant(item.atMs) : null,
      text: item.text,
      title: item.title,
      file: item.file === null ? null : { mediaType: item.file.mediaType, bytes: item.file.bytes },
    })),
  };
}

/** A link's address as a Markdown destination: nothing in it can end the link. */
const markdownUrl = (url: string) =>
  url
    .replaceAll(" ", "%20")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("<", "%3C")
    .replaceAll(">", "%3E");

/** « ## Contexte » and one line per item: notes, links, files by name (ADR 024). */
function markdownContext(detail: EpisodeDetail, heading: string): string[] {
  if (detail.context.length === 0) return [];
  const lines = ["", `${heading} ${m.context_title()}`, ""];
  for (const item of detail.context) {
    const pin = item.pinned ? `${clock(item.atMs)} · ` : "";
    const name = item.title ?? "";
    const line =
      item.kind === "note"
        ? markdownText(item.text)
        : item.kind === "link"
          ? `[${markdownText(name === "" ? item.text : name)}](${markdownUrl(item.text)})`
          : `${markdownText(name)} (${item.file?.mediaType ?? ""}, ${formatBytes(item.file?.bytes ?? 0, getLocale())})`;
    lines.push(`- ${pin}${line}`);
  }
  return lines;
}

export const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();

// Markdown's own characters are escaped, so speech never turns into markup.
export function markdownText(text: string): string {
  return oneLine(text)
    .replace(/[\\`*_[\]<>|]/gu, "\\$&")
    .replace(/^(#|>|[-+]\s|\d+[.)]\s)/u, "\\$1");
}

function markdown(detail: EpisodeDetail): string {
  const { episode } = detail;
  const title = `# ${fullDate(dayOf(episode.startedAtMs))} · ${timeRange(episode.startedAtMs, episode.endedAtMs)}`;
  return `${[title, ...markdownBody(detail)].join("\n")}\n`;
}

/** The length and context line, the added context, then the turns: what follows an episode's heading. */
function markdownBody(detail: EpisodeDetail, heading = "##"): string[] {
  const { episode, segments } = detail;
  const voices = voicesByLabel(detail.speakers, { recognized: false });
  const meta = [formatDuration(episodeLength(episode, Date.now())), contextLabel(episode)].filter(
    (part) => part !== null,
  );
  const lines = ["", meta.join(" · "), ...markdownContext(detail, heading)];
  for (const turn of groupTurns(segments, voices)) {
    const text = turn.segments.map((index) => markdownText(segments[index]?.text ?? ""));
    lines.push(
      "",
      `**${markdownText(voiceName(turn.voice))}** · ${formatOffset(turn.startMs - episode.startedAtMs)}`,
      text.join(" "),
    );
  }
  return lines;
}

/**
 * A day's transcripts in one document (Markdown or `sondine.day/2`), in time
 * order; null when none of them has words.
 */
export function dayDocument(
  day: string,
  details: readonly EpisodeDetail[],
  format: "md" | "json",
): string | null {
  const transcripts = details
    .map((detail) => ({
      ...detail,
      segments: detail.segments.filter((segment) => oneLine(segment.text) !== ""),
    }))
    .filter((detail) => detail.segments.length > 0)
    .toSorted((a, b) => a.episode.startedAtMs - b.episode.startedAtMs);
  if (transcripts.length === 0) return null;
  if (format === "json") {
    const document: DayJsonV2 = {
      schema: DAY_JSON_SCHEMA,
      day,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      episodes: transcripts.map(transcriptJson),
    };
    return `${JSON.stringify(document, null, 2)}\n`;
  }
  const lines = [`# ${fullDate(day)}`];
  for (const detail of transcripts) {
    const { episode } = detail;
    lines.push(
      "",
      `## ${timeRange(episode.startedAtMs, episode.endedAtMs)}`,
      ...markdownBody(detail, "###"),
    );
  }
  return `${lines.join("\n")}\n`;
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** `00:01:02,345` (SRT) or `00:01:02.345` (WebVTT); never before the audio's start. */
function cueTime(ms: number, format: "srt" | "vtt"): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const separator = format === "srt" ? "," : ".";
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(total % 1000, 3)}`;
}

// An arrow in the text would read as a cue's timing line.
const cueText = (text: string) => oneLine(text).replaceAll("-->", "→");
const vttEscape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function subtitles(detail: EpisodeDetail, format: "srt" | "vtt", originMs: number): string {
  const voices = voicesByLabel(detail.speakers, { recognized: false });
  const cues = detail.segments.map((segment, index) => {
    const startMs = segment.startMs - originMs;
    const timing = `${cueTime(startMs, format)} --> ${cueTime(Math.max(segment.endMs - originMs, startMs + 1), format)}`;
    const voice = voiceName(voiceOfLabel(voices, segment.speakerLabel));
    const text = cueText(segment.text);
    return format === "srt"
      ? `${index + 1}\n${timing}\n${m.transcript_cue({ voice, text })}`
      : `${timing}\n<v ${vttEscape(voice)}>${vttEscape(text)}`;
  });
  return format === "srt" ? `${cues.join("\n\n")}\n` : `WEBVTT\n\n${cues.join("\n\n")}\n`;
}
