/**
 * Reading a track run's audio back from the spool or the archive (ADR 016).
 * The retention work implements `readTrackAudio`; the transcription pipeline
 * builds requests on it.
 */

export type MissingReason =
  /** The helper recorded a gap (overflow, disk full, outage…). */
  | "gap"
  /** No chunk and no gap covers these samples. */
  | "unrecorded"
  | "expired"
  | "deleted"
  /** The bytes on disk failed their CRC, or the file is gone. */
  | "corrupt";

export interface MissingSpan {
  readonly sampleStart: number;
  readonly sampleEnd: number;
  readonly reason: MissingReason;
}

export interface TrackAudioRange {
  readonly trackRunId: number;
  /** Inclusive start, exclusive end, in the run's 16 kHz samples. */
  readonly sampleStart: number;
  readonly sampleEnd: number;
}

export interface TrackAudio {
  /** Exactly `sampleEnd - sampleStart` samples; missing ones are zero. */
  readonly samples: Int16Array;
  /** Zero-filled spans, in order, within the range. */
  readonly missing: readonly MissingSpan[];
}

export type ReadTrackAudio = (range: TrackAudioRange) => TrackAudio;
