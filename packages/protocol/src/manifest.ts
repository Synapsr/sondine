import * as z from "zod";
import {
  CHANNELS,
  ENVELOPE_ENCODING,
  ENVELOPE_FRAME_SAMPLES,
  MAX_ENVELOPE_FRAMES,
  SAMPLE_FORMAT,
  SAMPLE_RATE,
  SPOOL_FORMAT,
  SPOOL_FORMAT_VERSION,
} from "./constants";
import { decodeEnvelopeValues, findInvalidEnvelopeValue } from "./envelope";
import {
  ClockAnchor,
  Count,
  Epoch,
  GapReason,
  SampleIndex,
  Timebase,
  TrackKey,
  Uuid,
  VersionText,
} from "./primitives";
import { described, named } from "./registry";
import { checkCommit, checkRegionSpan, commitShape, regionSpanShape } from "./shapes";

export const ManifestHeader = named(
  "ManifestHeader",
  "First line of every manifest. One manifest per PCM file; files rotate every 10 min within a run.",
  z.strictObject({
    type: z.literal("header"),
    format: z.literal(SPOOL_FORMAT),
    version: z.literal(SPOOL_FORMAT_VERSION),
    sessionId: described("Helper launch that wrote the file.", Uuid),
    trackKey: TrackKey,
    runId: Uuid,
    epoch: described("Epoch at the file's first sample.", Epoch),
    file: described(
      "Name of the PCM file, a sibling of the manifest.",
      z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,123}\.pcm$/),
    ),
    sequence: described("Number of this file within the run, starting at 0.", Count),
    startSample: described("Run sample index of the file's first sample.", SampleIndex),
    rate: z.literal(SAMPLE_RATE),
    channels: z.literal(CHANNELS),
    sampleFormat: z.literal(SAMPLE_FORMAT),
    timebase: Timebase,
    anchor: described("Clocks read together when the file was created.", ClockAnchor),
    helperVersion: VersionText,
  }),
);
export type ManifestHeader = z.output<typeof ManifestHeader>;

export const ManifestCommit = named(
  "ManifestCommit",
  "Written after the block's PCM bytes are fsynced, then the manifest is fsynced. Recovery truncates the PCM file to the last commit's committedOffset.",
  z.strictObject({ type: z.literal("commit"), ...commitShape }).superRefine(checkCommit),
);
export type ManifestCommit = z.output<typeof ManifestCommit>;

export const ManifestGap = named(
  "ManifestGap",
  "Samples [fromSample, toSample) of the run with no stored bytes; written before the next commit. Recovery writes `recovery-truncated` for bytes it cut.",
  z
    .strictObject({
      type: z.literal("gap"),
      reason: GapReason,
      fromSample: SampleIndex,
      toSample: SampleIndex,
    })
    .refine((gap) => gap.toSample > gap.fromSample, {
      path: ["toSample"],
      message: "toSample must be > fromSample",
    }),
);
export type ManifestGap = z.output<typeof ManifestGap>;

export const ManifestEnvelope = named(
  "ManifestEnvelope",
  "Log-energy envelope, one value per 10 ms frame, for every track regardless of VAD. `data` is base64 of `count` little-endian Float32 values in dBFS within [-120, 0]. Base64 binary is allowed only here, in manifests.",
  z
    .strictObject({
      type: z.literal("envelope"),
      sampleIndex: described("Run sample index of the first frame's first sample.", SampleIndex),
      frameSamples: z.literal(ENVELOPE_FRAME_SAMPLES),
      count: z.int().min(1).max(MAX_ENVELOPE_FRAMES),
      encoding: z.literal(ENVELOPE_ENCODING),
      data: z.base64(),
    })
    .superRefine((envelope, ctx) => {
      const values = decodeEnvelopeValues(envelope.data);
      if (values?.length !== envelope.count) {
        ctx.addIssue({
          code: "custom",
          path: ["data"],
          message: `data must decode to ${envelope.count * 4} bytes`,
        });
        return;
      }
      const invalid = findInvalidEnvelopeValue(values);
      if (invalid !== -1) {
        ctx.addIssue({
          code: "custom",
          path: ["data"],
          message: `value ${invalid} is not a finite dBFS level within [-120, 0]`,
        });
      }
    }),
);
export type ManifestEnvelope = z.output<typeof ManifestEnvelope>;

export const ManifestRegion = named(
  "ManifestRegion",
  "A closed speech region, written to the manifest of the file current at close. Its samples may span earlier files of the run.",
  z.strictObject({ type: z.literal("region"), ...regionSpanShape }).superRefine(checkRegionSpan),
);
export type ManifestRegion = z.output<typeof ManifestRegion>;

/** Every line of a spool manifest, discriminated on `type`. */
export const ManifestRecord = z.discriminatedUnion("type", [
  ManifestHeader,
  ManifestCommit,
  ManifestGap,
  ManifestEnvelope,
  ManifestRegion,
]);
export type ManifestRecord = z.output<typeof ManifestRecord>;
export type ManifestRecordWire = z.input<typeof ManifestRecord>;
export type ManifestRecordType = ManifestRecord["type"];

export const MANIFEST_RECORD_TYPES: readonly ManifestRecordType[] = ManifestRecord.options.map(
  (option) => option.shape.type.value,
);

/** Decodes an envelope record's values. The record must have passed `ManifestEnvelope`. */
export function envelopeValues(envelope: ManifestEnvelope): Float32Array {
  return decodeEnvelopeValues(envelope.data) ?? new Float32Array(0);
}
