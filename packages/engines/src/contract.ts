/**
 * Engine contracts (ADR 005, ADR 016). Product code depends on these types,
 * never on a specific model. Times inside a request are seconds from the
 * start of the audio sent; the host maps them back to track samples.
 */

export type EngineStage = "vad" | "asr" | "align" | "diarize" | "embed-speaker" | "textgen";

export type AdapterClass = "product" | "probe";

/** An artifact the model manager owns, named as in the catalog. */
export interface ArtifactRef {
  readonly artifactId: string;
  readonly version: string;
}

export interface EngineManifest {
  /** Stable id, e.g. "nemotron-3.5-transcribe-iq4nl". */
  readonly id: string;
  readonly version: string;
  /** The runtime and its version, e.g. "speech.cpp 0.9.3". */
  readonly runtime: string;
  readonly adapterClass: AdapterClass;
  /** Every stage one pass covers. */
  readonly stages: readonly EngineStage[];
  readonly artifacts: readonly ArtifactRef[];
}

export interface AsrCapabilities {
  readonly streaming: "native" | "pseudo" | "none";
  /** Speakers come with the text (no separate diarize run needed). */
  readonly nativeSpeakers: boolean;
  readonly wordTimestamps: boolean;
  /** BCP 47 primary tags, e.g. ["fr", "en"]. */
  readonly languages: readonly string[];
  /** The longest audio one request may carry. */
  readonly maxRequestSeconds: number;
  /**
   * Where the audio goes. `device`: it never leaves the Mac. `remote`: a
   * compute server the user turned on (ADR 040); it holds no model here.
   */
  readonly locality: "device" | "remote";
}

/** Measured costs; admission reads them (ADR 016). */
export interface EngineResources {
  /** Peak resident memory of the worker with the model loaded and idle. */
  readonly peakBytesBase: number;
  /** Extra peak per hour of audio in one request. */
  readonly peakBytesPerAudioHour: number;
  readonly coldLoadMs: number;
  /** Time from closing stdin (or cancel) to exit, memory released. */
  readonly unloadLatencyMs: number;
  readonly computeUnits: readonly ("cpu" | "gpu" | "ane")[];
}

export function peakBytesFor(resources: EngineResources, audioSeconds: number): number {
  return resources.peakBytesBase + (resources.peakBytesPerAudioHour * audioSeconds) / 3600;
}

export interface AsrRequest {
  /** Unique per attempt; responses for another id are dropped. */
  readonly id: string;
  /** Mono PCM16 at `sampleRate`. */
  readonly samples: Int16Array;
  readonly sampleRate: 16000;
  /** Omitted: the engine detects the language. */
  readonly language?: string;
  readonly speakers: boolean;
  readonly timestamps: boolean;
}

export interface AsrToken {
  readonly startSec: number;
  readonly endSec: number;
  /** As the engine wrote it, leading space included. */
  readonly text: string;
}

export interface AsrSegment {
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
  /** 0-based, local to this request; null when the engine gave none. */
  readonly speaker: number | null;
  /** This segment's tokens, in order; empty without timestamps. */
  readonly tokens: readonly AsrToken[];
}

export interface EngineProvenance {
  readonly engineId: string;
  readonly engineVersion: string;
  readonly runtime: string;
  readonly adapterClass: AdapterClass;
  readonly modelSha256: string;
  /** Options that change the output, as sent. */
  readonly config: Readonly<Record<string, string | number | boolean>>;
}

export interface AsrResult {
  readonly requestId: string;
  readonly text: string;
  readonly stop: "complete" | "model_limit";
  readonly segments: readonly AsrSegment[];
  /** Languages the engine reported, if any. */
  readonly languages: readonly string[];
  readonly provenance: EngineProvenance;
  readonly metrics: {
    readonly audioMs: number;
    readonly computeMs: number;
  };
}

export type EngineState = "absent" | "loading" | "ready" | "busy" | "unloading";

export type EngineErrorCode =
  /** The worker could not start or load (missing binary or weights, fatal). */
  | "load_failed"
  /** A message the protocol does not allow, or an unexpected protocol version. */
  | "protocol"
  /** A deadline passed: load, request, or cancel. */
  | "deadline"
  | "cancelled"
  /** The worker exited while it held work. */
  | "crashed"
  /** The engine refused the request or its output failed validation. */
  | "invalid_output"
  | "rejected"
  /** Another process already runs the speech binary: a second worker never starts. */
  | "worker_running"
  /** A remote engine's server does not answer, or the connection dropped. */
  | "network_unavailable"
  /** The server takes no more work now. */
  | "server_busy"
  /** The server does not know this Mac (any more). */
  | "unauthorized"
  /** The server's hours for this Mac are used up. */
  | "quota_exhausted"
  /** Another key, protocol, model or engine than this Mac expects. */
  | "server_mismatch";

export interface EngineErrorOptions extends ErrorOptions {
  /** A short kebab-case cause, e.g. `text-mismatch`; never quotes the engine's output. */
  readonly reason?: string;
}

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  /** Safe to log and store, unlike the message, which may quote what the engine wrote. */
  readonly reason: string | undefined;
  constructor(code: EngineErrorCode, message: string, options?: EngineErrorOptions) {
    super(message, options);
    this.name = "EngineError";
    this.code = code;
    this.reason = options?.reason;
  }
}

export interface TranscribeOptions {
  readonly signal?: AbortSignal;
  /** 0 to 1, as the engine reports it. */
  readonly onProgress?: (done: number) => void;
  /** A remote engine asks before each part of the audio leaves; false stops the request. */
  readonly maySend?: () => boolean;
}

/**
 * What every engine the scheduler holds shares: one worker, loaded on
 * demand, one request at a time. `unload` ends the worker and resolves once
 * its process has exited.
 */
export interface ResidentEngine {
  readonly manifest: EngineManifest;
  readonly resources: EngineResources;
  state(): EngineState;
  /** The worker's pid while one exists, so core can record and reap it. */
  pid(): number | undefined;
  load(signal?: AbortSignal): Promise<{ readonly loadMs: number }>;
  unload(): Promise<void>;
}

/** A resident ASR engine; `transcribe` loads it first when it is absent. */
export interface AsrEngine extends ResidentEngine {
  readonly capabilities: AsrCapabilities;
  transcribe(request: AsrRequest, options?: TranscribeOptions): Promise<AsrResult>;
}

// Text generation (`textgen`, ADR 028): the daily journal and commitments.

export interface TextCapabilities {
  /** BCP 47 primary tags it writes well, e.g. ["fr", "en"]. */
  readonly languages: readonly string[];
  /** Prompt and output together, in the model's tokens. */
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
  /** The output always follows the request's JSON schema (a grammar constrains it). */
  readonly schemaConstrained: boolean;
  /**
   * Where the text goes. `device`: it never leaves the Mac. `provider`: a
   * service the user signed into (ADR 027), which product code calls only
   * with the user's consent; such an engine holds no memory here.
   */
  readonly locality: "device" | "provider";
}

export interface TextRequest {
  /** Unique per attempt; a late answer for another id is dropped. */
  readonly id: string;
  /** Instructions only: never holds what was said. */
  readonly system: string;
  /** What the model works on. Transcript text is untrusted: no tools, output only. */
  readonly user: string;
  /** The JSON schema the output must follow. */
  readonly schema: Readonly<Record<string, unknown>>;
  readonly maxOutputTokens: number;
}

export interface TextResult {
  readonly requestId: string;
  readonly text: string;
  /** `length`: the output limit cut it, so it may not parse. */
  readonly stop: "complete" | "length";
  readonly provenance: EngineProvenance;
  readonly metrics: {
    readonly promptTokens: number;
    readonly outputTokens: number;
    readonly promptMs: number;
    readonly generateMs: number;
    readonly computeMs: number;
  };
}

export interface GenerateOptions {
  readonly signal?: AbortSignal;
  /** Output tokens written so far. */
  readonly onProgress?: (outputTokens: number) => void;
}

/** A resident text model; `generate` loads it first when it is absent. */
export interface TextEngine extends ResidentEngine {
  readonly capabilities: TextCapabilities;
  generate(request: TextRequest, options?: GenerateOptions): Promise<TextResult>;
}
