export {
  EngineError,
  peakBytesFor,
  type AdapterClass,
  type ArtifactRef,
  type AsrCapabilities,
  type AsrEngine,
  type AsrRequest,
  type AsrResult,
  type AsrSegment,
  type AsrToken,
  type EngineErrorCode,
  type EngineManifest,
  type EngineProvenance,
  type EngineResources,
  type EngineStage,
  type EngineState,
  type GenerateOptions,
  type ResidentEngine,
  type TextCapabilities,
  type TextEngine,
  type TextRequest,
  type TextResult,
  type TranscribeOptions,
} from "./contract.ts";
export {
  JOURNAL_ARTIFACT,
  MODEL_CATALOG,
  NEMOTRON_ARTIFACT,
  PARAKEET_ARTIFACT,
  catalogArtifact,
  type CatalogArtifact,
} from "./models/catalog.ts";
export {
  DOWNLOAD_POLICY,
  discardDownload,
  downloadArtifact,
  downloadedBytes,
  downloadFile,
  urlAllowed,
  type DownloadableFile,
  type DownloadOptions,
  type DownloadPolicy,
  type DownloadProgress,
  type DownloadResult,
  type HostRule,
} from "./models/download.ts";
export {
  candidateLocations,
  findArtifactFile,
  huggingFaceCachePath,
  type FoundFile,
} from "./models/locate.ts";
export {
  ARTIFACT_LAYOUT,
  DISK_HEADROOM_BYTES,
  MODELS_HOME_RELATIVE,
  ModelStoreError,
  artifactDirectory,
  availableBytes,
  importArtifact,
  listInstalled,
  modelsDirectory,
  sameVolume,
  sha256File,
  verifyArtifact,
  type ImportMethod,
  type ImportOptions,
  type ImportProgress,
  type ImportResult,
  type InstalledArtifact,
  type InstalledEntry,
  type ModelStoreErrorCode,
  type VerifyOptions,
  type VerifyResult,
} from "./models/store.ts";
export {
  NEMOTRON_CAPABILITIES,
  NEMOTRON_MANIFEST,
  NEMOTRON_RESOURCES,
  createNemotronEngine,
  type NemotronEngineOptions,
} from "./nemotron.ts";
export {
  PARAKEET_CAPABILITIES,
  PARAKEET_MANIFEST,
  PARAKEET_RESOURCES,
  createParakeetEngine,
  type ParakeetEngineOptions,
} from "./parakeet.ts";
export { nemotronProgress } from "./nemotron-progress.ts";
export { repairWordTimes } from "./nemotron-times.ts";
export { SPEECH_CPP_RUNTIME } from "./speech-cpp/runtime.ts";
export {
  assertNoWorkerProcess,
  findWorkerProcesses,
  killStaleWorker,
  stopWorkerProcesses,
  type StaleWorkerOutcome,
  type StopWorkersOptions,
  type StopWorkersReport,
} from "./speech-cpp/stale-worker.ts";
export {
  CHUNK_SECONDS,
  SPEECH_WORKER_DEADLINES,
  createSpeechWorkerEngine,
  type SpeechWorkerDeadlines,
  type SpeechWorkerEngineOptions,
  type SpeechWorkerExit,
} from "./speech-cpp/worker-engine.ts";
export { shareEngine } from "./shared-engine.ts";
export {
  type AssistantAccount,
  type AssistantErrorCode,
  type AssistantEvent,
  type AssistantFailure,
  type AssistantListener,
  type AssistantModel,
  type AssistantProvider,
  type AssistantProviderId,
  type AssistantSession,
  type AssistantSessionOptions,
  type AssistantState,
  type AssistantStatus,
  type McpStdioServer,
} from "./assistants/contract.ts";
export {
  CLAUDE_LOCKED_ARGUMENTS,
  CLAUDE_MIN_VERSION,
  claudeSessionArguments,
  createClaudeProvider,
  type ClaudeProviderOptions,
} from "./assistants/claude.ts";
export {
  CLAUDE_TEXT_CAPABILITIES,
  claudeTextArguments,
  createClaudeTextEngine,
  type ClaudeTextEngineOptions,
} from "./assistants/claude-text.ts";
export { makeLocator, type Environment, type Located } from "./assistants/processes.ts";
export { LLAMA_CPP_RUNTIME } from "./llama-cpp/runtime.ts";
export {
  LLAMA_SERVER_DEADLINES,
  createLlamaServerEngine,
  type LlamaServerDeadlines,
  type LlamaServerEngineOptions,
  type LlamaServerExit,
} from "./llama-cpp/server-engine.ts";
export {
  JOURNAL_CAPABILITIES,
  JOURNAL_MANIFEST,
  JOURNAL_RESOURCES,
  assertNoServerProcess,
  createJournalEngine,
  type JournalEngineOptions,
} from "./journal-model.ts";
export {
  SAME_MOMENT_THRESHOLDS,
  createEnvelopeDetector,
  type SameMomentDetector,
  type SameMomentMeasure,
  type SameMomentSearch,
  type SameMomentThresholds,
  type SameMomentVerdict,
} from "./same-moment/detector.ts";
export {
  SELF_ECHO_THRESHOLDS,
  createSelfEchoDetector,
  type SelfEchoDetector,
  type SelfEchoInput,
  type SelfEchoSpan,
  type SelfEchoThresholds,
  type SelfEchoVerdict,
} from "./self-echo/detector.ts";
export {
  ENVELOPE_FRAME_MS,
  ENVELOPE_SAMPLE_RATE,
  ENVELOPE_SILENT_DB,
  EnvelopeBuilder,
  envelopeOf,
  type Envelope,
} from "./same-moment/envelope.ts";
