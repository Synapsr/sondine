import {
  EngineError,
  type AsrEngine,
  type AsrRequest,
  type AsrResult,
  type EngineState,
  type TranscribeOptions,
} from "./contract.ts";

// One resident engine for several users (Parakeet: near-live text and the
// dictations' final pass, ADR 020): one worker, one request at a time. Each
// user gets a handle that waits its turn for every load, request and unload,
// in the order they were asked, and whose unload only lets go of the engine:
// the worker exits once no handle holds it. A handle sees "ready" while
// another one's request runs, and its request waits.

export function shareEngine(engine: AsrEngine, users: number): AsrEngine[] {
  let turn: Promise<unknown> = Promise.resolve();
  let running: number | null = null;
  const holding = new Set<number>();

  /** Runs `work` once every earlier call is done; a signal that aborts first gives up its turn. */
  function inTurn<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = turn;
    const mine = (async () => {
      await previous.catch(() => undefined);
      if (signal?.aborted === true) throw new EngineError("cancelled", "cancelled before its turn");
      return work();
    })();
    turn = mine.catch(() => undefined);
    return mine;
  }

  return Array.from({ length: users }, (_, user): AsrEngine => ({
    manifest: engine.manifest,
    capabilities: engine.capabilities,
    resources: engine.resources,
    state(): EngineState {
      const state = engine.state();
      return state === "busy" && running !== user ? "ready" : state;
    },
    pid: () => engine.pid(),
    load(signal?: AbortSignal) {
      return inTurn(async () => {
        const loaded = await engine.load(signal);
        holding.add(user);
        return loaded;
      }, signal);
    },
    transcribe(request: AsrRequest, options?: TranscribeOptions): Promise<AsrResult> {
      return inTurn(async () => {
        holding.add(user);
        running = user;
        try {
          return await engine.transcribe(request, options);
        } finally {
          running = null;
        }
      }, options?.signal);
    },
    unload() {
      return inTurn(async () => {
        holding.delete(user);
        if (holding.size === 0 && engine.state() !== "absent") await engine.unload();
      });
    },
  }));
}
