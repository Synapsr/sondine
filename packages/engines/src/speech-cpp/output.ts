import { EngineError, type AsrResult, type AsrSegment, type AsrToken } from "../contract.ts";
import type { RecognitionEnd } from "./messages.ts";

// Checks a recognition `end` and turns it into contract segments. Anything
// the host could not map back to the audio it sent is `invalid_output`:
// a stop the protocol does not define, a time that is not finite, negative,
// reversed, or more than 1 s past the audio, or segments whose texts do not
// make the request's text.

/** How far past the audio a time may run before the output is refused; later times are clamped. */
export const END_TOLERANCE_SEC = 1;

interface Timed {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface RecognitionContext {
  readonly durationSec: number;
  readonly timestamps: boolean;
  readonly speakers: boolean;
}

export type Recognition = Pick<AsrResult, "text" | "stop" | "segments" | "languages">;

const invalid = (reason: string, message: string) =>
  new EngineError("invalid_output", message, { reason });

function checkTime(what: string, item: Timed, durationSec: number): void {
  const { start, end } = item;
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw invalid("time-not-finite", `${what} has a time that is not finite (${start}, ${end})`);
  }
  if (start < 0 || end < start)
    throw invalid("time-reversed", `${what} runs from ${start} s to ${end} s`);
  if (end > durationSec + END_TOLERANCE_SEC) {
    throw invalid(
      "time-past-audio",
      `${what} ends at ${end} s, past the ${durationSec} s of audio sent`,
    );
  }
}

const clampTo = (durationSec: number, item: Timed) => {
  const end = Math.min(item.end, durationSec);
  return { startSec: Math.min(item.start, end), endSec: end };
};

const normalSpaces = (text: string) => text.replace(/\s+/gu, " ").trim();
const withoutSpaces = (text: string) => text.replace(/\s+/gu, "");

/** The segments' texts, joined with or without spaces, give the whole text. */
export function segmentsMakeText(segments: readonly Timed[], text: string): boolean {
  const expected = normalSpaces(text);
  const texts = segments.map((segment) => segment.text);
  return normalSpaces(texts.join(" ")) === expected || normalSpaces(texts.join("")) === expected;
}

/** Tokens in order, cut where their concatenated text completes each segment's text. */
function tokensByText(segments: readonly Timed[], tokens: readonly Timed[]): Timed[][] | null {
  const groups: Timed[][] = segments.map(() => []);
  let next = 0;
  for (const [index, segment] of segments.entries()) {
    const target = withoutSpaces(segment.text);
    let text = "";
    while (text.length < target.length && next < tokens.length) {
      const token = tokens[next];
      if (token === undefined) break;
      text += withoutSpaces(token.text);
      groups[index]?.push(token);
      next += 1;
      if (!target.startsWith(text)) return null;
    }
    if (text !== target) return null;
  }
  const rest = tokens.slice(next);
  if (rest.some((token) => withoutSpaces(token.text) !== "")) return null;
  groups.at(-1)?.push(...rest);
  return groups;
}

/** Each token goes to the segment it overlaps most, else the nearest one. */
function tokensByTime(segments: readonly Timed[], tokens: readonly Timed[]): Timed[][] {
  const groups: Timed[][] = segments.map(() => []);
  for (const token of tokens) {
    let best = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const [index, segment] of segments.entries()) {
      const overlap = Math.min(token.end, segment.end) - Math.max(token.start, segment.start);
      const middle = (token.start + token.end) / 2;
      const distance = Math.max(segment.start - middle, middle - segment.end, 0);
      const score = overlap > 0 ? overlap : -distance;
      if (score > bestScore) {
        best = index;
        bestScore = score;
      }
    }
    groups[best]?.push(token);
  }
  return groups;
}

/** Puts every token in the segment it belongs to, by text when the texts line up, else by time. */
export function assignTokens(segments: readonly Timed[], tokens: readonly Timed[]): Timed[][] {
  if (segments.length === 0) return [];
  return tokensByText(segments, tokens) ?? tokensByTime(segments, tokens);
}

export function recognitionFrom(end: RecognitionEnd, context: RecognitionContext): Recognition {
  const { durationSec } = context;
  if (end.stop !== "complete" && end.stop !== "model_limit") {
    throw invalid("unknown-stop", `unknown stop "${end.stop}"`);
  }
  const languages = end.languages ?? [];
  if (!context.timestamps && !context.speakers) {
    return { text: end.text, stop: end.stop, segments: [], languages };
  }
  if (end.untimed != null)
    throw invalid("untimed", `the engine could not time its text: ${end.untimed}`);
  const segments = end.segments;
  if (segments == null)
    throw invalid("no-segments", "timestamps or speakers were asked for, but no segments came");
  const tokens = end.tokens ?? [];
  if (context.timestamps && end.tokens == null) {
    throw invalid("no-tokens", "timestamps were asked for, but no tokens came");
  }
  for (const [index, segment] of segments.entries()) {
    checkTime(`segment ${index}`, segment, durationSec);
  }
  for (const [index, token] of tokens.entries()) checkTime(`token ${index}`, token, durationSec);
  if (!segmentsMakeText(segments, end.text)) {
    throw invalid("text-mismatch", "the segments' texts do not make the request's text");
  }
  const groups = assignTokens(segments, tokens);
  const result: AsrSegment[] = segments.map((segment, index) => ({
    ...clampTo(durationSec, segment),
    text: segment.text,
    speaker: context.speakers ? (segment.speaker ?? null) : null,
    tokens: (groups[index] ?? []).map((token): AsrToken => ({
      ...clampTo(durationSec, token),
      text: token.text,
    })),
  }));
  return { text: end.text, stop: end.stop, segments: result, languages };
}
