import { type NormLanguage } from "../text/fr-norm";
import { frNormAlign } from "../text/fr-norm-align";

// Echo between tracks (M3; ADR 016, architecture §3 "Echo and duplicates"):
// on a call through the Mac's speakers, the microphone hears the other side
// too, so their words come back a second time on the mic track. Evidence is
// words: the mic repeats a stretch of one played track (the system or an
// app) word for word, in order on both sides, a moment after it, with a
// steady lag of a few hundred milliseconds at most (sound travels, it does
// not wander). One such stretch of at least three words, or a whole two-word
// mic sentence heard almost at once, leaves the mic transcript; what the
// user said around it stays, as its own sentences, interjections included.
// A reply that repeats the other side comes too late, or too short, and a
// lone word is never taken. When unsure, the user's words stay. Pure: the
// scheduler applies it to a pass's segments and cuts the speaker turns at
// what it took.
//
// `echo/4` (ADR 035): stretches already known to be echo of Sondine's own
// playback (`known`, from its reference) take the mic words said in them,
// whatever the words: Sondine plays on no track, so no word can match.

export const ECHO_VERSION = "echo/4";

/** A word of a segment: its characters in the text, its times from the segment's start. */
export interface EchoWord {
  readonly charStart: number;
  readonly charEnd: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly confidence?: number | null;
}

export interface EchoSegment {
  readonly trackRunId: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly lang?: string | null;
  readonly words?: readonly EchoWord[] | null;
}

export interface EchoTracks {
  /** Track runs that hear the room: microphones, where played sound comes back. */
  readonly heard: ReadonlySet<number>;
  /** Track runs of sound the Mac played: the system, apps. */
  readonly played: ReadonlySet<number>;
  /** Samples per second of the pass (word times map to samples at this rate). Defaults to 16 kHz. */
  readonly sampleRate?: number;
  /**
   * Stretches of the microphone known to be echo of Sondine's own playback
   * (ADR 035): a mic word whose middle falls in one is echo.
   */
  readonly known?: readonly EchoSpan[];
}

/** A stretch of a mic track the echo took, in run samples, half-open. */
export interface EchoSpan {
  readonly trackRunId: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
}

export interface EchoResult<T> {
  readonly segments: T[];
  /** Microphone words taken out as echo. */
  readonly echoWords: number;
  /** Where they were: speaker turns are cut there. */
  readonly spans: readonly EchoSpan[];
}

/** Words in a row that make echo inside a longer sentence. */
const MIN_RUN = 3;
/** A whole mic sentence this short is echo when all of it repeats, almost at once. */
const SHORT_SENTENCE = 2;
/** How late (ms) the mic may hear a played token: travel plus the engines' timing slack. */
const LAG_MIN_MS = -150;
const LAG_MAX_MS = 450;
/** A whole short sentence needs a closer lag. */
const SHORT_LAG_MS = 250;
/** How much the lag may wander along one stretch. */
const LAG_DRIFT_MS = 250;
/** A filler or a mark this close to echo at a sentence's edge goes with it. */
const EDGE_MS = 300;

interface Token {
  readonly key: string;
  /** Wall time of its middle. */
  readonly atMs: number;
  /** The lexical words of its segment it comes from ("1 000" is two). */
  readonly words: readonly number[];
}

/** A lexical word: ASR tokens joined until whitespace ("j'" + "ai" is « j'ai »). */
interface Lexeme {
  readonly charStart: number;
  readonly charEnd: number;
  readonly startMs: number;
  readonly endMs: number;
  /** Indices of its ASR words. */
  readonly parts: readonly number[];
}

const language = (lang: string | null | undefined): NormLanguage =>
  lang?.toLowerCase().startsWith("en") === true ? "en" : "fr";

function lexemesOf(segment: EchoSegment): Lexeme[] {
  const words = segment.words ?? [];
  if (words.length > 0) {
    const out: {
      charStart: number;
      charEnd: number;
      startMs: number;
      endMs: number;
      parts: number[];
    }[] = [];
    words.forEach((word, index) => {
      const previous = out.at(-1);
      const joined =
        previous !== undefined &&
        !/\s/u.test(segment.text.slice(previous.charEnd, word.charStart)) &&
        !/^\s/u.test(segment.text.slice(word.charStart, word.charEnd));
      if (joined) {
        previous.charEnd = word.charEnd;
        previous.endMs = word.endMs;
        previous.parts.push(index);
      } else {
        out.push({
          charStart: word.charStart,
          charEnd: word.charEnd,
          startMs: word.startMs,
          endMs: word.endMs,
          parts: [index],
        });
      }
    });
    return out;
  }
  // No timings: words spread over the segment.
  const matches = [...segment.text.matchAll(/\S+/gu)];
  const step = (segment.endMs - segment.startMs) / Math.max(1, matches.length);
  return matches.map((match, index) => ({
    charStart: match.index,
    charEnd: match.index + match[0].length,
    startMs: Math.round(step * index),
    endMs: Math.round(step * (index + 1)),
    parts: [],
  }));
}

/**
 * A segment's normalized tokens, normalized in context ("1 000 euros",
 * "quatre vingts"), each with the lexical words it came from.
 */
function tokensOf(segment: EchoSegment, lexemes: readonly Lexeme[]): Token[] {
  const units = frNormAlign(segment.text, {
    language: language(segment.lang),
    diacritics: "strip",
    fillers: "drop",
    numbers: "words",
  });
  return units.flatMap((unit) => {
    if (unit.tokens.length === 0) return [];
    const words = lexemes.flatMap((lexeme, index) =>
      lexeme.charStart < unit.end && lexeme.charEnd > unit.start ? [index] : [],
    );
    const first = lexemes[words[0] ?? -1];
    const last = lexemes[words.at(-1) ?? -1];
    if (first === undefined || last === undefined) return [];
    const span = (last.endMs - first.startMs) / unit.tokens.length;
    return unit.tokens.map((key, index) => ({
      key,
      atMs: segment.startMs + first.startMs + span * (index + 0.5),
      words,
    }));
  });
}

interface Run {
  readonly start: number;
  readonly lag: number;
  readonly length: number;
}

/** A stretch of the mic tokens that repeats one played stream, with its lag. */
interface Match {
  readonly from: number;
  /** Inclusive. */
  readonly to: number;
  readonly lag: number;
}

/**
 * Stretches of mic tokens that repeat one played stream: contiguous on both
 * sides, each pair a moment later on the mic, the lag steady along it.
 */
function echoRuns(mic: readonly Token[], streams: readonly (readonly Token[])[]): Match[] {
  const found: Match[] = [];
  for (const stream of streams) {
    const byKey = new Map<string, number[]>();
    stream.forEach((token, index) => {
      byKey.set(token.key, [...(byKey.get(token.key) ?? []), index]);
    });
    // Runs ending at the previous mic token, by the played index they reached.
    let previous = new Map<number, Run>();
    const close = (run: Run, end: number) => {
      if (run.length >= 2) found.push({ from: run.start, to: end, lag: run.lag });
    };
    for (let i = 0; i < mic.length; i++) {
      const token = mic[i];
      const current = new Map<number, Run>();
      for (const j of token === undefined ? [] : (byKey.get(token.key) ?? [])) {
        const lag = (token?.atMs ?? 0) - (stream[j]?.atMs ?? 0);
        if (lag < LAG_MIN_MS || lag > LAG_MAX_MS) continue;
        const before = previous.get(j - 1);
        current.set(
          j,
          before !== undefined && Math.abs(lag - before.lag) <= LAG_DRIFT_MS
            ? { start: before.start, lag: before.lag, length: before.length + 1 }
            : { start: i, lag, length: 1 },
        );
      }
      // Runs that did not go on end at the previous token.
      for (const [j, run] of previous) {
        if (current.get(j + 1)?.start !== run.start) close(run, i - 1);
      }
      previous = current;
    }
    for (const run of previous.values()) close(run, mic.length - 1);
  }
  return found;
}

/**
 * The lexical words that are echo: those one stretch covers whole, when it
 * covers three in a row, or every word of a two-word sentence heard almost at
 * once; then fillers and marks between echo words, or right at its edge.
 */
function echoWordsOf(
  lexemes: readonly Lexeme[],
  tokens: readonly Token[],
  matches: readonly Match[],
): Set<number> {
  const keyed = [...new Set(tokens.flatMap((token) => token.words))].toSorted((a, b) => a - b);
  const echo = new Set<number>();
  for (const match of matches) {
    const inside = new Set(tokens.slice(match.from, match.to + 1));
    // Words whose every token lies in this one stretch.
    const covered = keyed.filter((word) =>
      tokens.every((token) => !token.words.includes(word) || inside.has(token)),
    );
    const whole =
      covered.length === keyed.length &&
      keyed.length >= SHORT_SENTENCE &&
      Math.abs(match.lag) <= SHORT_LAG_MS;
    if (covered.length >= MIN_RUN || whole) for (const word of covered) echo.add(word);
  }
  // Unspoken words (fillers, marks): echo between echo words, or touching it at an edge.
  const timeOf = (index: number) => lexemes[index];
  for (let index = 0; index < lexemes.length; index++) {
    if (keyed.includes(index)) continue;
    const before = keyed.findLast((word) => word < index);
    const after = keyed.find((word) => word > index);
    const near = (word: number | undefined, side: "before" | "after") => {
      if (word === undefined || !echo.has(word)) return false;
      const self = timeOf(index);
      const other = timeOf(word);
      if (self === undefined || other === undefined) return false;
      return side === "before"
        ? self.startMs - other.endMs <= EDGE_MS
        : other.startMs - self.endMs <= EDGE_MS;
    };
    const between =
      before !== undefined && after !== undefined && echo.has(before) && echo.has(after);
    const edge =
      (before === undefined && near(after, "after")) ||
      (after === undefined && near(before, "before"));
    if (between || edge) echo.add(index);
  }
  return echo;
}

/** The pieces of a timed segment left between its echo words. */
function piecesOf<T extends EchoSegment>(
  segment: T,
  lexemes: readonly Lexeme[],
  echo: ReadonlySet<number>,
  rate: number,
): T[] {
  const words = segment.words ?? [];
  const out: T[] = [];
  const toSample = (ms: number) => segment.sampleStart + Math.round((ms * rate) / 1000);
  const flush = (from: number, to: number) => {
    const parts = lexemes.slice(from, to).flatMap((lexeme) => lexeme.parts);
    const head = parts[0];
    const tail = parts.at(-1);
    const startWord = head === undefined ? undefined : words[head];
    const endWord = tail === undefined ? undefined : words[tail];
    if (
      head === undefined ||
      tail === undefined ||
      startWord === undefined ||
      endWord === undefined
    ) {
      return;
    }
    const atStart = from === 0;
    const atEnd = to === lexemes.length;
    const startMs = atStart ? 0 : startWord.startMs;
    const endMs = Math.max(startMs, atEnd ? segment.endMs - segment.startMs : endWord.endMs);
    const charStart = atStart ? 0 : startWord.charStart;
    const charEnd = atEnd ? segment.text.length : endWord.charEnd;
    const raw = segment.text.slice(charStart, charEnd);
    const text = raw.trim();
    if (text === "") return;
    const lead = raw.search(/\S/u);
    // Samples from the words' own times, at the pass's rate; wall times from them too.
    const sampleStart = atStart
      ? segment.sampleStart
      : Math.min(segment.sampleEnd, toSample(startWord.startMs));
    const sampleEnd = atEnd
      ? segment.sampleEnd
      : Math.max(sampleStart + 1, Math.min(segment.sampleEnd, toSample(endWord.endMs)));
    out.push({
      ...segment,
      sampleStart,
      sampleEnd,
      startMs: segment.startMs + startMs,
      endMs: segment.startMs + endMs,
      text,
      words: words.slice(head, tail + 1).map((word) => ({
        ...word,
        charStart: word.charStart - charStart - lead,
        charEnd: word.charEnd - charStart - lead,
        startMs: Math.max(0, word.startMs - startMs),
        endMs: Math.max(0, word.endMs - startMs),
      })),
    });
  };
  let from = -1;
  for (let index = 0; index < lexemes.length; index++) {
    if (echo.has(index)) {
      if (from >= 0) flush(from, index);
      from = -1;
    } else if (from < 0) {
      from = index;
    }
  }
  if (from >= 0) flush(from, lexemes.length);
  return out;
}

/** The lexical words of `segment` whose middle falls in a known echo stretch of its run. */
function knownEchoOf(
  segment: EchoSegment,
  lexemes: readonly Lexeme[],
  known: readonly EchoSpan[],
  rate: number,
): number[] {
  const mine = known.filter(
    (span) =>
      span.trackRunId === segment.trackRunId &&
      span.sampleStart < segment.sampleEnd &&
      span.sampleEnd > segment.sampleStart,
  );
  if (mine.length === 0) return [];
  return lexemes.flatMap((lexeme, index) => {
    const middle =
      segment.sampleStart + Math.round((((lexeme.startMs + lexeme.endMs) / 2) * rate) / 1000);
    return mine.some((span) => span.sampleStart <= middle && middle < span.sampleEnd)
      ? [index]
      : [];
  });
}

/** The pass's segments without the microphone's echo of played sound, in their order. */
export function removeEcho<T extends EchoSegment>(
  segments: readonly T[],
  tracks: EchoTracks,
): EchoResult<T> {
  const rate = tracks.sampleRate ?? 16_000;
  const streams = [...tracks.played].map((trackRunId) =>
    segments
      .filter((segment) => segment.trackRunId === trackRunId)
      .flatMap((segment) => tokensOf(segment, lexemesOf(segment)))
      .toSorted((a, b) => a.atMs - b.atMs),
  );
  const known = tracks.known ?? [];
  if (streams.every((stream) => stream.length === 0) && known.length === 0) {
    return { segments: [...segments], echoWords: 0, spans: [] };
  }
  let echoWords = 0;
  const spans: EchoSpan[] = [];
  const out: T[] = [];
  for (const segment of segments) {
    if (!tracks.heard.has(segment.trackRunId)) {
      out.push(segment);
      continue;
    }
    const lexemes = lexemesOf(segment);
    const tokens = tokensOf(segment, lexemes);
    const near = streams.map((stream) =>
      stream.filter(
        (token) =>
          token.atMs >= segment.startMs - LAG_MAX_MS && token.atMs <= segment.endMs - LAG_MIN_MS,
      ),
    );
    const echo = echoWordsOf(lexemes, tokens, echoRuns(tokens, near));
    for (const index of knownEchoOf(segment, lexemes, known, rate)) echo.add(index);
    if (echo.size === 0) {
      out.push(segment);
      continue;
    }
    const whole = lexemes.every((_, index) => echo.has(index));
    // Without word timings a sentence cannot be cut: it goes only when all of it is echo.
    if ((segment.words ?? []).length === 0 && !whole) {
      out.push(segment);
      continue;
    }
    const spoken = new Set(tokens.flatMap((token) => token.words));
    echoWords += [...echo].filter((word) => spoken.has(word)).length;
    if (whole) {
      spans.push({
        trackRunId: segment.trackRunId,
        sampleStart: segment.sampleStart,
        sampleEnd: segment.sampleEnd,
      });
      continue;
    }
    const pieces = piecesOf(segment, lexemes, echo, rate);
    // What the pieces no longer hold is the echo, for the turns.
    let cursor = segment.sampleStart;
    for (const piece of [...pieces, null]) {
      const end = piece === null ? segment.sampleEnd : piece.sampleStart;
      if (end > cursor) {
        spans.push({ trackRunId: segment.trackRunId, sampleStart: cursor, sampleEnd: end });
      }
      if (piece !== null) cursor = Math.max(cursor, piece.sampleEnd);
    }
    out.push(...pieces);
  }
  return { segments: out, echoWords, spans };
}
