import type { ProgressShape } from "./speech-cpp/worker-engine.ts";

// Nemotron's progress, from what speech.cpp reports to what the request's time
// is. speech.cpp 0.9.3 (recognizer.cpp at the pinned revision) gives each of
// its three steps a third of `done`: encoding the audio, reading it into the
// language model, then writing the text, where `done` is
// (2 + positions used / context length) / 3. The audio fills 12.5 positions a
// second, so writing starts at 0.88 for 55 min of audio, though the first two
// steps take about 3 minutes and writing about 15 more (13.5 tokens a second on
// Téo's Mac, 2026-11-08): his 3 h 22 import sat at 24 % for a quarter of an
// hour. Here the first two steps take the first `PREPARE_SHARE`, and writing
// the rest, as the tokens written over those the audio should take, learned
// from the last request that ended.

/** `nemotron-transcribe.llm.context_length` of the pinned weights. */
const CONTEXT_POSITIONS = 65_536;
/** Encoding and reading the audio: about 3 of 20 minutes for 55 min of audio. */
const PREPARE_SHARE = 0.15;
/**
 * Text the model writes per second of audio, until a request teaches better:
 * Téo's talk gave over 13 000 tokens for its first 55 minutes (2026-11-08).
 */
export const DEFAULT_TOKENS_PER_SECOND = 4;
/** Shorter requests say little about how much a recording holds. */
const LEARN_FROM_SECONDS = 60;
/** Writing may go on past the estimate: the share stays below its end until then. */
const WRITING_CAP = 0.95;

export function nemotronProgress(): ProgressShape {
  let tokensPerSecond = DEFAULT_TOKENS_PER_SECOND;
  return {
    start(seconds) {
      /** Positions used when writing began, and at the last report. */
      let writingFrom: number | null = null;
      let position: number | null = null;
      return {
        report(done) {
          if (done >= 1) return 1;
          if (done <= 2 / 3) return PREPARE_SHARE * done * 1.5;
          position = 3 * done - 2;
          writingFrom ??= position;
          const written = (position - writingFrom) * CONTEXT_POSITIONS;
          const expected = Math.max(1, tokensPerSecond * seconds);
          return PREPARE_SHARE + (1 - PREPARE_SHARE) * Math.min(WRITING_CAP, written / expected);
        },
        end() {
          if (writingFrom === null || position === null || seconds < LEARN_FROM_SECONDS) return;
          const written = (position - writingFrom) * CONTEXT_POSITIONS;
          if (written > 0) tokensPerSecond = written / seconds;
        },
      };
    },
  };
}
