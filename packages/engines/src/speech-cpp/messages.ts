import * as z from "zod";

// What `speech worker` writes on stdout, protocol 3 (docs/worker.md of
// speech.cpp). Objects are loose: a release may add members or messages
// without raising the protocol. A member set to null counts as left out.

/** Every stdout line is one JSON object with a string `type`. */
export const WorkerLine = z.looseObject({ type: z.string() });
export type WorkerLine = z.output<typeof WorkerLine>;

const WorkerErrorBody = z.looseObject({
  code: z.string(),
  option: z.string().nullish(),
  message: z.string(),
});
export type WorkerErrorBody = z.output<typeof WorkerErrorBody>;

export const ReadyMessage = z.looseObject({
  type: z.literal("ready"),
  protocol: z.number(),
  version: z.string(),
});

export const FatalMessage = z.looseObject({ type: z.literal("fatal"), error: WorkerErrorBody });

/** A message that belongs to a request. */
export const RequestMessage = z.looseObject({ id: z.string() });

export const ProgressMessage = z.looseObject({
  type: z.literal("progress"),
  id: z.string(),
  done: z.number(),
});

/** An `error` without `id` refuses a line that named no request: a defect of ours. */
export const ErrorMessage = z.looseObject({
  type: z.literal("error"),
  id: z.string().nullish(),
  error: WorkerErrorBody,
});

const TimedText = { start: z.number(), end: z.number(), text: z.string() };

/** The terminal `end` of a recognition request. */
export const RecognitionEnd = z.looseObject({
  type: z.literal("end"),
  id: z.string(),
  text: z.string(),
  stop: z.string(),
  segments: z.array(z.looseObject({ ...TimedText, speaker: z.int().min(0).nullish() })).nullish(),
  tokens: z.array(z.looseObject(TimedText)).nullish(),
  languages: z.array(z.string()).nullish(),
  /** Why the model could not time its text; then neither segments nor tokens come. */
  untimed: z.string().nullish(),
});
export type RecognitionEnd = z.output<typeof RecognitionEnd>;

export const describeWorkerError = (error: WorkerErrorBody): string =>
  `${error.code}${error.option == null ? "" : ` (${error.option})`}: ${error.message}`;
