// The ASR bench's names, apart from the modules that load engines, so the CLI
// can print its usage without them.

export const CORPUS_IDS = ["fleurs-fr", "fleurs-en"] as const;
export type CorpusId = (typeof CORPUS_IDS)[number];

export const ENGINE_IDS = [
  "nemotron",
  "parakeet-tdt-0.6b-v3",
  "qwen3-asr-1.7b",
  "qwen3-asr-0.6b",
] as const;
export type EngineId = (typeof ENGINE_IDS)[number];
