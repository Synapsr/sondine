/** Version of the helper socket protocol. Bump it on any breaking change (see README). */
export const PROTOCOL_VERSION = 7;

/** Name and version written in every spool manifest header. */
export const SPOOL_FORMAT = "sondine-spool";
export const SPOOL_FORMAT_VERSION = 1;

/** Every track is resampled once in the helper to this rate. */
export const SAMPLE_RATE = 16_000;
export const CHANNELS = 1;
export const SAMPLE_FORMAT = "s16le";
export const BYTES_PER_SAMPLE = 2;

/** Envelopes hold one log-energy value per 10 ms frame. */
export const ENVELOPE_FRAME_SAMPLES = 160;
export const ENVELOPE_ENCODING = "f32le-base64";
/** Up to one minute of envelope per manifest record. */
export const MAX_ENVELOPE_FRAMES = 6_000;

/** Levels are clamped to this floor so digital silence stays finite. */
export const DBFS_FLOOR = -120;

/** Longest accepted JSON line in bytes, newline excluded. */
export const MAX_LINE_BYTES = 1024 * 1024;

/** Largest value of a 64-bit clock field (SQLite INTEGER is signed). */
export const MAX_CLOCK_VALUE = 2n ** 63n - 1n;
