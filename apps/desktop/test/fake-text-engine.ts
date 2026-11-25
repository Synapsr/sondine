import { EngineError, type EngineState, type TextEngine, type TextRequest } from "@sondine/engines";

// A text model for the journal's tests (ADR 028): it answers every request
// with one journal line and one commitment, both citing line 1, or waits
// for its abort signal when told to hang. Heavy by default, as the real one;
// as the user's Claude (`provider`), nothing to load and no memory here, it
// answers a check of the commitments with `check`, or fails with `fail`.

export interface FakeTextEngine extends TextEngine {
  readonly requests: TextRequest[];
  loads: number;
  unloads: number;
}

/** What the fake Claude answers about every commitment it is asked to check. */
export interface FakeCheck {
  readonly says: string;
  readonly when: string;
  readonly owed?: boolean;
}

export function fakeTextEngine(
  options: {
    readonly hang?: boolean;
    readonly peakBytes?: number;
    readonly answer?: string;
    readonly provider?: boolean;
    readonly check?: FakeCheck;
    readonly fail?: () => Error;
  } = {},
): FakeTextEngine {
  const provider = options.provider === true;
  let state: EngineState = provider ? "ready" : "absent";
  const engine: FakeTextEngine = {
    manifest: {
      id: "fake-journal",
      version: "1",
      runtime: "fake 1",
      adapterClass: "probe",
      stages: ["textgen"],
      artifacts: [{ artifactId: "fake-model", version: "1" }],
    },
    capabilities: {
      languages: ["fr", "en"],
      contextTokens: 16_384,
      maxOutputTokens: 4_096,
      schemaConstrained: true,
      locality: provider ? "provider" : "device",
    },
    resources: {
      peakBytesBase: options.peakBytes ?? (provider ? 0 : 6 * 1024 ** 3),
      peakBytesPerAudioHour: 0,
      coldLoadMs: 0,
      unloadLatencyMs: 0,
      computeUnits: ["gpu"],
    },
    requests: [],
    loads: 0,
    unloads: 0,
    state: () => state,
    pid: () => undefined,
    async load(signal) {
      if (signal?.aborted === true) throw new EngineError("cancelled", "load cancelled");
      engine.loads += 1;
      state = "ready";
      return { loadMs: 1 };
    },
    async generate(request, generateOptions = {}) {
      if (state === "absent") await engine.load(generateOptions.signal);
      engine.requests.push(request);
      if (options.fail !== undefined) throw options.fail();
      state = "busy";
      try {
        if (options.hang === true) {
          await new Promise<never>((_, reject) => {
            const signal = generateOptions.signal;
            const fail = () => reject(new EngineError("cancelled", "cancelled"));
            if (signal?.aborted === true) fail();
            signal?.addEventListener("abort", fail, { once: true });
          });
        }
        const checking = request.id.endsWith("-check");
        const checks = checking
          ? (request.user.match(/^Commitment \d+:/gmu) ?? []).map((_, index) => ({
              n: index + 1,
              speaker: "P1",
              says: options.check?.says ?? "will-do",
              when: options.check?.when ?? "later",
              owed: options.check?.owed ?? true,
              heard: "conversation",
            }))
          : null;
        return {
          requestId: request.id,
          text:
            checks !== null
              ? JSON.stringify({ checks })
              : (options.answer ??
                JSON.stringify({
                  journal: [{ text: "On a parlé du budget.", cite: [1] }],
                  commitments: [
                    {
                      cite: [1],
                      who: "P1",
                      kind: "promise",
                      to: null,
                      what: "envoyer le devis",
                      due: null,
                      dueText: null,
                    },
                  ],
                })),
          stop: "complete",
          provenance: {
            engineId: "fake-journal",
            engineVersion: "1",
            runtime: "fake 1",
            adapterClass: "probe",
            modelSha256: "fake",
            config: {},
          },
          metrics: { promptTokens: 10, outputTokens: 5, promptMs: 1, generateMs: 1, computeMs: 2 },
        };
      } finally {
        if (state === "busy") state = "ready";
      }
    },
    async unload() {
      engine.unloads += 1;
      if (!provider) state = "absent";
    },
  };
  return engine;
}
