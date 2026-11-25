import {
  EngineError,
  type AsrCapabilities,
  type AsrEngine,
  type AsrRequest,
  type AsrResult,
  type EngineManifest,
  type EngineResources,
  type EngineState,
  type TranscribeOptions,
} from "../contract.ts";
import { NEMOTRON_ARTIFACT } from "../models/catalog.ts";
import { NEMOTRON_CAPABILITIES, NEMOTRON_MANIFEST } from "../nemotron.ts";
import { END_TOLERANCE_SEC } from "../speech-cpp/output.ts";
import { exchange, octets, open, parseJson, refuseStatus, type Fetch } from "./client.ts";
import { NoiseError, type Channel } from "./noise.ts";
import {
  CHUNK_BYTES,
  CHUNK_LABEL,
  COMMAND_LABEL,
  FIRST_COMMAND,
  MAX_STATE_BYTES,
  POLL_HOLD_MS,
  SessionState,
  STATE_LABEL,
  type RemoteResult,
  type ServerLink,
} from "./wire.ts";

// Nemotron on a compute server (ADR 040), behind the same contract as on this
// Mac: the same weights and adapter version, or the server is refused. One
// request at a time. The audio leaves in sealed chunks, each only while
// `maySend` allows it; the server forgets the session once the result is here
// or the request is cancelled.

/** Which server: a machine of the user's, or the beta Synapsr runs. */
export type RemoteLocality = "own" | "beta";

export interface RemoteAsrOptions {
  readonly link: ServerLink;
  readonly locality: RemoteLocality;
  readonly fetch?: Fetch;
  /** How long to keep asking a server that stopped answering mid-request. */
  readonly patienceMs?: number;
  /** How long a server may hold a request without any change before this Mac gives up on it. */
  readonly stalledMs?: number;
  readonly retryMs?: number;
}

/**
 * A request at work changes its state every few seconds, a queued one as the
 * ones before it end: no change for this long is a server, or something
 * before it, that will not answer.
 */
const STALLED_MS = 30 * 60_000;
/** Rounds of missing chunks sent again without one more arriving. */
const MAX_RESENDS = 3;

/** The share of progress the upload takes: seconds of minutes, usually. */
const UPLOAD_SHARE = 0.1;
const CAPABILITIES: AsrCapabilities = { ...NEMOTRON_CAPABILITIES, locality: "remote" };

/** No model here: the request's audio, one sealed chunk, and the answer. */
export const REMOTE_RESOURCES: EngineResources = {
  peakBytesBase: 64_000_000,
  peakBytesPerAudioHour: 115_200_000,
  coldLoadMs: 0,
  unloadLatencyMs: 0,
  computeUnits: ["cpu"],
};

export function remoteManifest(locality: RemoteLocality): EngineManifest {
  return {
    ...NEMOTRON_MANIFEST,
    id: `${NEMOTRON_MANIFEST.id}:${locality}`,
    runtime: `sondine-compute, ${NEMOTRON_MANIFEST.runtime}`,
  };
}

interface Session {
  readonly url: string;
  readonly channel: Channel;
  /** The next command's counter. */
  command: bigint;
  /** The last state's counter. */
  state: bigint;
}

export function createRemoteAsrEngine(options: RemoteAsrOptions): AsrEngine {
  const { link, locality } = options;
  const fetchImpl: Fetch = options.fetch ?? fetch;
  const patienceMs = options.patienceMs ?? 120_000;
  const stalledMs = options.stalledMs ?? STALLED_MS;
  const retryMs = options.retryMs ?? 2_000;
  const manifest = remoteManifest(locality);
  let busy = false;

  async function transcribe(
    request: AsrRequest,
    { signal, onProgress, maySend }: TranscribeOptions = {},
  ): Promise<AsrResult> {
    if (busy) throw new EngineError("rejected", "one request at a time");
    const durationSec = request.samples.length / request.sampleRate;
    if (request.samples.length === 0 || durationSec > CAPABILITIES.maxRequestSeconds) {
      throw new EngineError("rejected", "the request's length is out of bounds");
    }
    busy = true;
    let session: Session | null = null;
    const mayGoOn = () => {
      if (signal?.aborted === true) throw new EngineError("cancelled", "cancelled");
      if (maySend?.() === false) throw new EngineError("cancelled", "no longer allowed to leave");
    };
    try {
      mayGoOn();
      const opened = await open(
        link,
        {
          kind: "asr",
          token: link.token,
          job: {
            modelSha256: NEMOTRON_ARTIFACT.sha256,
            engineVersion: NEMOTRON_MANIFEST.version,
            samples: request.samples.length,
            speakers: request.speakers,
            timestamps: request.timestamps,
            ...(request.language === undefined ? {} : { language: request.language }),
          },
        },
        { fetch: fetchImpl, signal },
      );
      if (opened.reply.kind !== "session") {
        throw new EngineError("server_mismatch", "not a session");
      }
      session = {
        url: `${link.endpoint}/v1/s/${opened.reply.id}`,
        channel: opened.channel,
        command: FIRST_COMMAND,
        state: -1n,
      };
      const audio = Buffer.from(
        request.samples.buffer,
        request.samples.byteOffset,
        request.samples.byteLength,
      );
      const send = (index: number) => sendChunk(session, audio, index, mayGoOn, signal);
      const chunks = Math.ceil(audio.length / CHUNK_BYTES);
      for (let index = 0; index < chunks; index += 1) {
        await send(index);
        onProgress?.(((index + 1) / chunks) * UPLOAD_SHARE);
      }
      const result = await wait(session, send, signal, (done) =>
        onProgress?.(UPLOAD_SHARE + done * (1 - UPLOAD_SHARE)),
      );
      return toResult(request, result, durationSec);
    } finally {
      busy = false;
      if (session !== null) void forget(session);
    }
  }

  async function sendChunk(
    session: Session | null,
    audio: Buffer,
    index: number,
    mayGoOn: () => void,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (session === null) return;
    mayGoOn();
    // A chunk sent again is the same bytes under the same counter.
    const sealed = session.channel.toServer.seal(
      BigInt(index),
      audio.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES),
      CHUNK_LABEL,
    );
    await patiently(signal, async () => {
      mayGoOn();
      const { status } = await exchange(
        fetchImpl,
        `${session.url}/${index}`,
        { method: "PUT", body: new Uint8Array(sealed), headers: octets },
        { maxBytes: 1024, timeoutMs: 120_000, signal },
      );
      refuseSession(status);
    });
  }

  async function wait(
    session: Session,
    send: (index: number) => Promise<void>,
    signal: AbortSignal | undefined,
    onDone: (done: number) => void,
  ): Promise<RemoteResult> {
    let resends = 0;
    let seen = "";
    let changedAt = Date.now();
    for (;;) {
      const state = await patiently(signal, () => readState(session, signal));
      const key = JSON.stringify(state);
      if (key !== seen) {
        seen = key;
        changedAt = Date.now();
        resends = 0;
      } else if (Date.now() - changedAt > stalledMs) {
        throw new EngineError("network_unavailable", "the server no longer changes");
      }
      switch (state.state) {
        case "done":
          return state.result;
        case "failed":
          throw state.code === "failed"
            ? new EngineError("crashed", "the server's engine failed")
            : new EngineError(
                state.code,
                "the server's engine refused",
                state.reason === null ? {} : { reason: state.reason },
              );
        case "running":
          onDone(state.progress);
          break;
        case "uploading":
          // Something between answered for the server: what it lacks goes again.
          resends += 1;
          if (resends > MAX_RESENDS) {
            throw new EngineError("network_unavailable", "the audio does not arrive");
          }
          for (const index of state.missing) await send(index);
          break;
        case "queued":
          break;
      }
    }
  }

  /** One sealed command; its counter is never used again, answered or not. */
  function command(session: Session, name: "state" | "drop"): Uint8Array<ArrayBuffer> {
    const counter = session.command++;
    const head = Buffer.alloc(8);
    head.writeBigUInt64BE(counter);
    return new Uint8Array(
      Buffer.concat([
        head,
        session.channel.toServer.seal(
          counter,
          Buffer.from(JSON.stringify({ command: name })),
          COMMAND_LABEL,
        ),
      ]),
    );
  }

  async function readState(
    session: Session,
    signal: AbortSignal | undefined,
  ): Promise<SessionState> {
    const { status, body } = await exchange(
      fetchImpl,
      session.url,
      { method: "POST", body: command(session, "state"), headers: octets },
      { maxBytes: MAX_STATE_BYTES, timeoutMs: POLL_HOLD_MS + 30_000, signal },
    );
    refuseSession(status);
    const read = openState(session.channel, body, session.state);
    session.state = read.counter;
    return read.state;
  }

  /** Tries again while the server does not answer, up to `patienceMs` in a row. */
  async function patiently<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    const until = Date.now() + patienceMs;
    for (;;) {
      try {
        return await work();
      } catch (error) {
        const dropped = error instanceof EngineError && error.code === "network_unavailable";
        if (!dropped || Date.now() >= until) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      if (signal?.aborted === true) throw new EngineError("cancelled", "cancelled");
    }
  }

  async function forget(session: Session): Promise<void> {
    const body = command(session, "drop");
    session.channel.toServer.wipe();
    session.channel.toClient.wipe();
    await exchange(
      fetchImpl,
      session.url,
      { method: "POST", body, headers: octets },
      { maxBytes: 1024, timeoutMs: 10_000 },
    ).catch(() => undefined);
  }

  function toResult(request: AsrRequest, result: RemoteResult, durationSec: number): AsrResult {
    checkTimes(result, durationSec);
    return {
      requestId: request.id,
      text: result.text,
      stop: result.stop,
      segments: result.segments,
      languages: result.languages,
      provenance: {
        engineId: manifest.id,
        engineVersion: manifest.version,
        runtime: `sondine-compute, ${result.runtime}`,
        adapterClass: manifest.adapterClass,
        modelSha256: NEMOTRON_ARTIFACT.sha256,
        config: {
          locality,
          speakers: request.speakers,
          timestamps: request.timestamps,
          language: request.language ?? "auto",
        },
      },
      metrics: { audioMs: Math.round(durationSec * 1000), computeMs: result.computeMs },
    };
  }

  return {
    manifest,
    capabilities: CAPABILITIES,
    resources: REMOTE_RESOURCES,
    // Nothing is loaded here, so there is never a worker to keep or let go.
    state: (): EngineState => (busy ? "busy" : "absent"),
    pid: () => undefined,
    load: () => Promise.resolve({ loadMs: 0 }),
    unload: () => Promise.resolve(),
    transcribe,
  };
}

/** A session the server forgot (it restarted, or waited too long): the request starts over later. */
function refuseSession(status: number): void {
  if (status === 404) throw new EngineError("server_busy", "the server forgot the session");
  refuseStatus(status);
}

function openState(
  channel: Channel,
  body: Buffer,
  last: bigint,
): { readonly state: SessionState; readonly counter: bigint } {
  try {
    const counter = body.readBigUInt64BE(0);
    const opened = channel.toClient.open(counter, body.subarray(8), STATE_LABEL);
    // An old state played again would hide the newer one.
    if (counter <= last) throw new EngineError("server_mismatch", "a state came back");
    return { state: SessionState.parse(parseJson(opened)), counter };
  } catch (error) {
    if (error instanceof EngineError) throw error;
    const why = error instanceof NoiseError ? "not the server's" : "one this version can't read";
    throw new EngineError("server_mismatch", `the state is ${why}`);
  }
}

/** The server's times must map back to the audio this Mac sent. */
function checkTimes(result: RemoteResult, durationSec: number): void {
  const limit = durationSec + END_TOLERANCE_SEC;
  const outside = (item: { startSec: number; endSec: number }) =>
    item.endSec < item.startSec || item.endSec > limit;
  if (result.segments.some((segment) => outside(segment) || segment.tokens.some(outside))) {
    throw new EngineError("invalid_output", "a time falls outside the audio", {
      reason: "time-past-audio",
    });
  }
}
