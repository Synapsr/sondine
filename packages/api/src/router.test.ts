import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isContractProcedure } from "@orpc/contract";
import { createRouterClient, isDefinedError, ORPCError, safe } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { PHONE_ALL_ROUTES, PHONE_MEMORY_ROUTES } from "@sondine/protocol";
import * as z from "zod";
import { contract } from "./contract";
import { apiErrors, ServiceFailure } from "./errors";
import { EVENT_NAME_PATTERN, MCP_TOOL_NAME_PATTERN, type ProcedureMeta } from "./meta";
import { agentTools } from "./agent-tools";
import { PHONE_MEMORY_READS, PHONE_PROCEDURES } from "./phone-procedures";
import { router } from "./router";
import { exportJsonSchemas } from "./transcript-json";
import type {
  AgentsStatus,
  AnalysisCheck,
  ComputeStatus,
  ListeningStatus,
  ModelsStatus,
  PrivacyStatus,
  OnboardingStatus,
  VoiceReadStatus,
  Status,
} from "./schemas";
import { EpisodeDetail } from "./schemas";
import type { ApiServices } from "./services";

const phoneStatus = {
  enabled: false,
  tailnet: false,
  available: true,
  relay: { phase: "off" as const, port: null, problem: null },
  serviceName: null,
  pairing: null,
  phones: [],
};
const privacyStatus: PrivacyStatus = {
  zones: [],
  durations: {
    audioDays: { calls: 90, conversations: 90, moments: 30, traces: 7, media: 7, dictations: 7 },
    deleteDays: {
      calls: null,
      conversations: null,
      moments: null,
      traces: null,
      media: null,
      dictations: null,
    },
  },
  appsHeard: [],
  sitesHeard: [],
  networkHere: false,
  browserLink: false,
};

const listening: ListeningStatus = {
  desired: "listening",
  effective: "listening",
  microphonePaused: false,
  systemAudioPaused: false,
  changedAtMs: 1_793_610_000_000,
  pausedUntilMs: null,
  holds: [],
  callOffer: null,
  forCall: null,
  call: null,
  callEnded: null,
  pauseReminder: null,
};

const computeStatus: ComputeStatus = {
  destination: "device",
  own: null,
  beta: { available: true, joined: false, invited: false },
};

const analysisCheck: AnalysisCheck = {
  requested: false,
  waitFor: { power: true, idle: true, memory: true },
  remote: false,
  reasons: [],
  onBattery: false,
  idleSeconds: 300,
  idleRequiredSeconds: 120,
  locked: false,
  thermalState: "nominal",
  memoryPressure: "normal",
  swapRoomBytes: null,
  swapRoomNeededBytes: null,
  memoryUse: null,
};

const models: ModelsStatus = {
  artifacts: [
    {
      artifactId: "nemotron-3.5-transcribe-30b-iq4nl",
      version: "55d2890",
      displayName: "Nemotron",
      sizeBytes: 18_997_225_856,
      minimumMemoryBytes: 32 * 1024 ** 3,
      role: "final",
      phase: "found",
      progress: null,
      partialBytes: 0,
      found: { path: "/Users/t/.cache/huggingface/hub/model.gguf", clones: true },
      downloadNeedsBytes: 18_997_225_856 + 14 * 1024 ** 3,
      problem: null,
      license: { name: "OpenMDW-1.1", url: "https://huggingface.co/org/repo/blob/abc/LICENSE" },
    },
  ],
  freeDiskBytes: 100 * 1024 ** 3,
  memoryBytes: 32 * 1024 ** 3,
};

const voiceRead: VoiceReadStatus = {
  recognition: true,
  available: true,
  read: null,
  session: {
    phase: "idle",
    elapsedMs: 0,
    voicedMs: 0,
    targetMs: 25_000,
    minimumMs: 10_000,
    level: 0,
    failure: null,
  },
};

const onboarding: OnboardingStatus = {
  completed: false,
  completedAtMs: null,
  origin: "first-run",
  step: "welcome",
  goal: null,
  cloudNotify: false,
};

const agentsStatus: AgentsStatus = {
  enabled: false,
  listening: false,
  relayPath: null,
  agents: [],
  apps: [],
  calls: [],
};

const status: Status = {
  listening,
  helper: {
    connection: "connected",
    process: "running",
    pid: 4242,
    restarts: 0,
    sessionId: "6f1c2a4e-8b3d-4c5e-9f10-2a3b4c5d6e7f",
    version: "0.1.0",
    connectedAtMs: 1_793_610_000_000,
    lastError: null,
  },
  permissions: {
    microphone: { status: "granted-verified", evidence: "first-signal" },
    systemAudio: { status: "unknown", evidence: "not-checked" },
  },
  tracks: [],
  spool: [],
  lastHealth: null,
  power: { onBattery: false, suspended: false, thermalState: "nominal" },
  importer: { imported: 0, errors: 0, lastError: null },
  analysis: {
    worker: "absent",
    queued: { requested: 0, conversations: 0, moments: 0, media: 0, traces: 0 },
    running: null,
    waitingFor: [],
    waitingEpisodeId: null,
    server: null,
    requests: [],
    retryAtMs: null,
    lastError: null,
    models: [],
  },
  live: { enabled: false, state: "off", revision: 0 },
  updates: {
    automatic: null,
    searches: false,
    blocked: "development",
    current: "0.2.0",
    available: null,
    phase: "idle",
    progress: null,
    waitingFor: [],
    requested: false,
    checkedAtMs: null,
    problem: null,
    updated: null,
  },
  retention: { spoolBytes: 0, archivedBytes: 0, blocked: 0, lastProblem: null },
  deletions: 0,
  kept: 0,
  changes: 0,
  updatedAtMs: 1_793_610_000_000,
};

const chatStatus = { enabled: false, providers: null, choice: null, canRead: true };
const journalState = {
  installed: true,
  enabled: true,
  language: "fr" as const,
  pending: 0,
  failed: 0,
  writing: false,
  requested: false,
  writer: "device" as const,
  claudePaused: false,
};

function fakeServices(overrides: Partial<ApiServices> = {}) {
  const calls: { method: string; input: unknown }[] = [];
  const services: ApiServices = {
    status: {
      get: async () => status,
      async *watch(signal) {
        for (const n of [1, 2, 3]) {
          if (signal?.aborted === true) return;
          yield { ...status, updatedAtMs: status.updatedAtMs + n };
        }
      },
    },
    listening: {
      pause: async (input) => {
        calls.push({ method: "pause", input });
        return { ...listening, desired: "paused", effective: "paused" };
      },
      resume: async (input) => {
        calls.push({ method: "resume", input });
        return listening;
      },
    },
    callOffers: {
      listen: async (input) => {
        calls.push({ method: "callOffers.listen", input });
        return listening;
      },
      skip: async (input) => {
        calls.push({ method: "callOffers.skip", input });
        return listening;
      },
      decline: async (input) => {
        calls.push({ method: "callOffers.decline", input });
        return listening;
      },
      settings: async () => ({ enabled: true, mutedApps: [] }),
      setEnabled: async (input) => ({ enabled: input.enabled, mutedApps: [] }),
      allowApp: async () => ({ enabled: true, mutedApps: [] }),
    },
    permissions: {
      request: async (input) => {
        calls.push({ method: "permissions", input });
        return { outcome: "opened-settings", permissions: status.permissions };
      },
    },
    episodes: {
      day: async (input) => {
        calls.push({ method: "episodes.day", input });
        const empty = { episodes: [], total: 0, nextCursor: null };
        return {
          day: input.day ?? "2026-11-05",
          revision: "0-811c9dc5",
          conversations: empty,
          momentHours: [
            {
              hour: 14,
              startMs: 1_793_610_000_000,
              moments: 2,
              untranscribed: 1,
              previews: [{ episodeId: 3, firstWords: "On décale à 15 h ?" }],
              apps: [],
            },
          ],
          media: empty,
          dictations: empty,
          traces: 4,
          ongoing: [],
        };
      },
      list: async (input) => {
        calls.push({ method: "episodes.list", input });
        return { day: input.day ?? "2026-11-05", episodes: [], nextCursor: null };
      },
      get: async (input) => {
        calls.push({ method: "episodes.get", input });
        throw new ServiceFailure("not-found", `No episode ${input.episodeId}.`);
      },
      playback: async (input) => {
        calls.push({ method: "episodes.playback", input });
        if (input.episodeId === 9) throw new ServiceFailure("not-found", "No episode 9.");
        return {
          src: `sondine-media://episode/${input.episodeId}?g=3`,
          startedAtMs: 1_793_610_000_000,
          durationMs: 72_300,
          speech: [
            { startMs: 1_793_610_001_000, endMs: 1_793_610_004_500, track: "microphone" as const },
          ],
          generation: 3,
        };
      },
      exportAudio: async (input) => {
        calls.push({ method: "episodes.exportAudio", input });
        return { outcome: "cancelled" as const };
      },
      exportText: async (input) => {
        calls.push({ method: "episodes.exportText", input });
        return { outcome: "copied" as const };
      },
      openPage: async (input) => {
        calls.push({ method: "episodes.openPage", input });
        return { opened: true };
      },
      end: async () => ({ ended: true }),
      split: async (input) => ({ episodeId: input.episodeId, newEpisodeId: input.episodeId + 1 }),
      setKind: async () => ({}),
      setJournalSource: async () => ({}),
      keepAudio: async (input) => ({
        zones: [],
        kept: input.keep,
        audioGone: false,
        noText: false,
      }),
      merge: async (input) => ({ episodeId: Math.min(input.episodeId, input.otherId) }),
      delete: async (input) => {
        calls.push({ method: "episodes.delete", input });
        return { deleted: input.episodeId !== 9 };
      },
      setRecognition: async (input) => {
        calls.push({ method: "episodes.setRecognition", input });
        return {};
      },
      deletePassage: async (input) => {
        calls.push({ method: "episodes.deletePassage", input });
        return { episodeDeleted: false };
      },
      forgetPreview: async (input) => {
        calls.push({ method: "episodes.forgetPreview", input });
        return { fromMs: 0, toMs: input.minutes * 60_000, episodes: [], phoneRecordings: [] };
      },
      forget: async (input) => {
        calls.push({ method: "episodes.forget", input });
        return { episodeIds: [] };
      },
      keepRecent: async () => {
        calls.push({ method: "episodes.keepRecent", input: undefined });
        return {
          outcome: "kept" as const,
          atMs: 1_793_610_120_000,
          keptMs: 120_000,
          episodeIds: [4],
        };
      },
    },
    search: {
      query: async (input) => {
        calls.push({ method: "search", input });
        return {
          episodes: [
            {
              episode: {
                id: 2,
                state: "closed",
                context: "in_person",
                size: "moment",
                sizeProvisional: false,
                analysisState: "complete",
                startedAtMs: 1_793_610_000_000,
                endedAtMs: 1_793_610_002_000,
                voicedMs: 1_500,
                firstWords: "Bonjour",
                speakerCount: 1,
                apps: [],
                people: [],
                recognized: [],
                live: false,
                page: null,
                phone: null,
                alsoRecordedBy: null,
                keptAtMs: null,
                note: false,
                tags: [],
              },
              selfOrdinal: null,
              hitCount: 1,
              hits: [
                {
                  segmentId: 1,
                  startMs: 1_793_610_000_000,
                  endMs: 1_793_610_001_000,
                  text: "Bonjour",
                  speakerLabel: "input:mic/1/1",
                  speakerOrdinal: 1,
                  self: false,
                  person: { id: 4, name: "Marie", self: false },
                  recognized: null,
                  highlights: [{ start: 0, end: 7 }],
                  app: { bundleId: "app.sondine", name: "Sondine" },
                },
              ],
              contextHits: [],
            },
          ],
          total: 1,
          untranscribed: 0,
        };
      },
      foregroundApps: async () => {
        calls.push({ method: "search.foregroundApps", input: undefined });
        return { apps: [{ bundleId: "app.sondine", name: "Sondine" }] };
      },
    },
    calls: {
      context: async () => {
        calls.push({ method: "calls.context", input: undefined });
        return { call: null, notch: { openOnHover: true } };
      },
      watch: async function* () {
        yield { call: null, notch: { openOnHover: true } };
      },
      dismiss: async (input) => {
        calls.push({ method: "calls.dismiss", input });
        return { call: null, notch: { openOnHover: true } };
      },
      notch: async () => ({ openOnHover: true }),
      setNotch: async (input) => input,
    },
    people: {
      list: async () => {
        calls.push({ method: "people.list", input: undefined });
        return { people: [] };
      },
      get: async (input) => {
        calls.push({ method: "people.get", input });
        throw new ServiceFailure("not-found", `No person ${input.personId}.`);
      },
      rename: async (input) => {
        calls.push({ method: "people.rename", input });
        return { id: input.personId, name: input.name, self: false };
      },
      merge: async (input) => {
        calls.push({ method: "people.merge", input });
        return { id: input.personId, name: "Marie", self: false };
      },
      delete: async (input) => {
        calls.push({ method: "people.delete", input });
        return { deleted: true };
      },
      unnamed: async () => ({ voices: [] }),
      doubts: async () => ({ voices: [] }),
      recognition: async () => ({ on: true }),
      setRecognition: async (input) => {
        calls.push({ method: "people.setRecognition", input });
        return input;
      },
      dictationLearning: async () => ({ on: false }),
      setDictationLearning: async (input) => {
        calls.push({ method: "people.setDictationLearning", input });
        return input;
      },
    },
    transcript: {
      edit: async (input) => {
        calls.push({ method: "transcript.edit", input });
        return { learned: [], unheard: [] };
      },
      restore: async (input) => {
        calls.push({ method: "transcript.restore", input });
        return {};
      },
    },
    history: {
      undo: async () => {
        calls.push({ method: "history.undo", input: {} });
        return { outcome: "nothing" };
      },
      redo: async () => {
        calls.push({ method: "history.redo", input: {} });
        return { outcome: "nothing" };
      },
    },
    chat: {
      status: async () => chatStatus,
      setEnabled: async (input) => {
        calls.push({ method: "chat.setEnabled", input });
        return { ...chatStatus, enabled: input.enabled };
      },
      async *watch(input) {
        yield { revision: 1, discussions: [], discussion: null, erased: 0 };
        calls.push({ method: "chat.watch", input });
      },
      send: async (input) => {
        calls.push({ method: "chat.send", input });
        return { discussionId: input.discussionId ?? 1 };
      },
      stop: async (input) => {
        calls.push({ method: "chat.stop", input });
        return {};
      },
      remove: async (input) => {
        calls.push({ method: "chat.remove", input });
        return {};
      },
      setLimited: async (input) => {
        calls.push({ method: "chat.setLimited", input });
        return {};
      },
    },
    agents: {
      status: async () => agentsStatus,
      setEnabled: async (input) => {
        calls.push({ method: "agents.setEnabled", input });
        return { ...agentsStatus, enabled: input.enabled };
      },
      create: async (input) => {
        calls.push({ method: "agents.create", input });
        return {
          agent: {
            id: 1,
            name: input.name,
            createdAtMs: 0,
            lastUsedAtMs: null,
            revokedAtMs: null,
            connected: false,
          },
          token: "sdn_test",
          setup: null,
        };
      },
      connectApp: async (input) => {
        calls.push({ method: "agents.connectApp", input });
        if (input.app === "cursor") throw new ServiceFailure("not-found", "Cursor is not here.");
        return { ok: false, path: "~/.grok/config.toml", problem: "unreadable" };
      },
      revoke: async (input) => {
        calls.push({ method: "agents.revoke", input });
        return { status: agentsStatus, removedFrom: [], failed: [] };
      },
      remove: async (input) => {
        calls.push({ method: "agents.remove", input });
        if (input.agentId === 9) throw new ServiceFailure("not-found", "No agent 9.");
        return agentsStatus;
      },
    },
    speakers: {
      name: async (input) => {
        calls.push({ method: "speakers.name", input });
        if (input.runId === 1) throw new ServiceFailure("invalid-input", "Transcript replaced.");
        return { person: { id: 4, name: "Marie", self: false } };
      },
      unname: async (input) => {
        calls.push({ method: "speakers.unname", input });
        return {};
      },
      refuse: async (input) => {
        calls.push({ method: "speakers.refuse", input });
        return {};
      },
      likeness: async () => ({ people: [] }),
      merge: async (input) => {
        calls.push({ method: "speakers.merge", input });
        return { label: input.label };
      },
    },
    analysis: {
      request: async (input) => {
        calls.push({ method: "analysis.request", input });
        return { outcome: "queued", jobId: 7 };
      },
      setWaitFor: async (input) => {
        calls.push({ method: "analysis.setWaitFor", input });
        return {
          ...analysisCheck,
          waitFor: { ...analysisCheck.waitFor, [input.condition]: input.wait },
        };
      },
      check: async () => ({
        requested: false,
        waitFor: { power: true, idle: true, memory: true },
        remote: false,
        reasons: ["not-idle"],
        onBattery: false,
        idleSeconds: 4,
        idleRequiredSeconds: 120,
        locked: false,
        thermalState: "nominal",
        memoryPressure: "normal",
        swapRoomBytes: 80 * 1024 ** 3,
        swapRoomNeededBytes: 29 * 1024 ** 3,
        memoryUse: null,
      }),
    },
    updates: {
      setAutomatic: async (input) => {
        calls.push({ method: "updates.setAutomatic", input });
        return { ...status.updates, automatic: input.automatic };
      },
      check: async () => status.updates,
      install: async () => status.updates,
      closeNote: async () => status.updates,
    },
    compute: {
      get: async () => computeStatus,
      choose: async (input) => {
        calls.push({ method: "compute.choose", input });
        return { ...computeStatus, destination: input.destination };
      },
      connect: async (input) => {
        calls.push({ method: "compute.connect", input });
        return { outcome: "connected", status: computeStatus };
      },
      disconnect: async () => computeStatus,
      joinBeta: async () => ({ outcome: "joined", status: computeStatus }),
      leaveBeta: async () => computeStatus,
      quota: async () => null,
      wave: async () => null,
      openBilling: async (input) => {
        calls.push({ method: "compute.openBilling", input });
        return { outcome: "opened" };
      },
    },
    live: {
      setEnabled: async (input) => {
        calls.push({ method: "live.setEnabled", input });
        return { enabled: input.enabled, state: input.enabled ? "no-model" : "off", revision: 0 };
      },
      partial: async () => null,
    },
    imports: {
      pick: async () => {
        calls.push({ method: "imports.pick", input: null });
        return { outcome: "cancelled" };
      },
      add: async (input) => {
        calls.push({ method: "imports.add", input });
        return { results: input.paths.map(() => ({ outcome: "failed", problem: "unreadable" })) };
      },
      list: async () => ({ imports: [], nextCursor: null }),
    },
    context: {
      add: async (input) => {
        calls.push({ method: "context.add", input });
        return { itemIds: [1], refused: [] };
      },
      paste: async (input) => {
        calls.push({ method: "context.paste", input });
        return { itemIds: [], refused: [] };
      },
      pick: async (input) => {
        calls.push({ method: "context.pick", input });
        return { itemIds: [], refused: [] };
      },
      edit: async (input) => {
        calls.push({ method: "context.edit", input });
        return {};
      },
      unpin: async (input) => {
        calls.push({ method: "context.unpin", input });
        return {};
      },
      remove: async (input) => {
        calls.push({ method: "context.remove", input });
        return {};
      },
      open: async (input) => {
        calls.push({ method: "context.open", input });
        return { opened: true };
      },
      get: async (input) => {
        calls.push({ method: "context.get", input });
        throw new ServiceFailure("not-found", `No item ${input.itemId}.`);
      },
      transcribe: async (input) => {
        calls.push({ method: "context.transcribe", input });
        return { outcome: "imported", episodeId: 9 };
      },
      pasteOngoing: async () => {
        calls.push({ method: "context.pasteOngoing", input: null });
        return { outcome: "none" };
      },
    },
    journal: {
      day: async (input) => {
        calls.push({ method: "journal.day", input });
        return {
          day: input.day ?? "2026-11-09",
          state: journalState,
          conversations: [],
          commitments: [],
        };
      },
      commitments: async (input) => {
        calls.push({ method: "journal.commitments", input });
        return { commitments: [], nextBeforeMs: input.beforeMs ?? 0 };
      },
      mark: async (input) => {
        calls.push({ method: "journal.mark", input });
        return { markId: 1 };
      },
      request: async (input) => {
        calls.push({ method: "journal.request", input });
        return { ...journalState, requested: true };
      },
      settings: async (input) => {
        calls.push({ method: "journal.settings", input });
        return {
          enabled: input.enabled ?? true,
          language: input.language ?? "fr",
          writer: input.writer ?? "device",
        };
      },
      claude: async () => {
        calls.push({ method: "journal.claude", input: null });
        return {
          id: "claude",
          state: "missing",
          executable: null,
          version: null,
          home: null,
          account: null,
          models: [],
          problem: null,
        };
      },
    },
    player: {
      state: async (input) => {
        calls.push({ method: "player.state", input });
        return { route: input.playing ? "speakers" : null };
      },
    },
    browser: {
      status: async () => ({ enabled: false, available: true, extension: "0.2.0", browsers: [] }),
      setEnabled: async (input) => {
        calls.push({ method: "browser.setEnabled", input });
        return { enabled: input.enabled, available: true, extension: "0.2.0", browsers: [] };
      },
      showExtension: async () => ({ shown: true }),
    },
    phone: {
      status: async () => phoneStatus,
      setEnabled: async (input) => {
        calls.push({ method: "phone.setEnabled", input });
        return { ...phoneStatus, enabled: input.enabled };
      },
      setTailnet: async (input) => ({ ...phoneStatus, tailnet: input.enabled }),
      pair: async () => phoneStatus,
      answer: async () => phoneStatus,
      revoke: async () => phoneStatus,
      reset: async () => phoneStatus,
    },
    privacy: {
      status: async () => privacyStatus,
      addZone: async (input) => {
        calls.push({ method: "privacy.addZone", input });
        return privacyStatus;
      },
      updateZone: async () => privacyStatus,
      removeZone: async () => privacyStatus,
      setMediaSite: async () => privacyStatus,
      setDuration: async () => ({ applied: true, deletes: 0, silences: 0, status: privacyStatus }),
      lift: async () => listening,
    },
    dictation: {
      apps: async () => ({ apps: [] }),
      setApp: async (input) => {
        calls.push({ method: "dictation.setApp", input });
        return {
          apps: [
            {
              bundleId: input.bundleId,
              name: "Hex",
              via: "app",
              lastListenedAtMs: 1_793_610_000_000,
              dictation: input.dictation,
              text: null,
            },
          ],
        };
      },
      setText: async (input) => {
        calls.push({ method: "dictation.setText", input });
        return { apps: [] };
      },
    },
    models: {
      status: async () => models,
      async *watch(signal) {
        for (const progress of [0.25, 0.5]) {
          if (signal?.aborted === true) return;
          yield {
            ...models,
            artifacts: models.artifacts.map((artifact) => ({
              ...artifact,
              phase: "downloading" as const,
              progress,
            })),
          };
        }
      },
      import: async (input) => {
        calls.push({ method: "models.import", input });
        if (input.artifactId === "whisper") throw new ServiceFailure("not-found", "No whisper.");
        return models;
      },
      pick: async (input) => {
        calls.push({ method: "models.pick", input });
        return { outcome: "cancelled", models };
      },
      download: async (input) => {
        calls.push({ method: "models.download", input });
        return models;
      },
      cancel: async (input) => {
        calls.push({ method: "models.cancel", input });
        return models;
      },
    },
    voiceRead: {
      get: async () => voiceRead,
      watch: async function* () {
        yield voiceRead;
      },
      start: async (input) => {
        calls.push({ method: "voiceRead.start", input });
        return { ...voiceRead, session: { ...voiceRead.session, phase: "recording" } };
      },
      finish: async () => voiceRead,
      cancel: async () => voiceRead,
      forget: async () => voiceRead,
    },
    display: {
      get: async () => ({ commitmentsFolded: false, media: null, dictations: null }),
      update: async (input) => {
        calls.push({ method: "display.update", input });
        return {
          commitmentsFolded: input.commitmentsFolded ?? false,
          media: input.media ?? null,
          dictations: input.dictations ?? null,
        };
      },
    },
    vocabulary: {
      list: async () => ({ words: [], people: [], modelReads: false }),
      add: async (input) => {
        calls.push({ method: "vocabulary.add", input });
        return { id: 1, word: input.word, note: input.note ?? null };
      },
      update: async (input) => ({ id: input.id, word: input.word, note: input.note ?? null }),
      remove: async () => ({}),
    },
    tags: {
      list: async () => ({ tags: [] }),
      set: async (input) => {
        calls.push({ method: "tags.set", input });
        return { tags: input.on ? [input.name] : [] };
      },
      rename: async (input) => ({ tag: { id: input.tagId, name: input.name }, merged: false }),
      delete: async () => ({ recordings: 0 }),
    },
    onboarding: {
      get: async () => onboarding,
      advance: async (input) => {
        calls.push({ method: "onboarding.advance", input });
        return { ...onboarding, step: input.step };
      },
      complete: async (input) => {
        calls.push({ method: "onboarding.complete", input });
        return {
          onboarding: { ...onboarding, completed: true, completedAtMs: 1_793_610_000_000 },
          listening,
        };
      },
    },
    statistics: {
      get: async () => ({ days: [], contexts: [], people: [], words: 0, agentReads: 0 }),
      month: async (input) => ({ month: input.month, days: [] }),
    },
    usage: {
      get: async () => ({ answer: null, sends: false, today: null, waiting: [] }),
      setSharing: async (input) => {
        calls.push({ method: "usage.setSharing", input });
        return { answer: input.share ? "yes" : "no", sends: false, today: null, waiting: [] };
      },
      processCrashed: async () => ({}),
    },
    diagnostics: {
      report: async () => {
        calls.push({ method: "diagnostic", input: undefined });
        return { text: "" };
      },
      health: async (input) => {
        calls.push({ method: "health", input });
        return { windows: [] };
      },
      spans: async (input) => {
        calls.push({ method: "spans", input });
        return { spans: [] };
      },
    },
    ...overrides,
  };
  return { services, calls };
}

const MetaShape = z.strictObject({
  event: z.string(),
  mcp: z
    .strictObject({
      name: z.string(),
      description: z.string(),
      readOnlyHint: z.boolean(),
      destructiveHint: z.boolean(),
      idempotentHint: z.boolean(),
    })
    .nullable(),
}) satisfies z.ZodType<ProcedureMeta>;

function failingPause(failure: ServiceFailure): ApiServices {
  return fakeServices({
    listening: {
      pause: async () => {
        throw failure;
      },
      resume: async () => listening,
    },
  }).services;
}

function procedures(node: unknown, path: string[] = []): { path: string; meta: ProcedureMeta }[] {
  if (isContractProcedure(node)) {
    return [{ path: path.join("."), meta: MetaShape.parse(node["~orpc"].meta) }];
  }
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, child]) => procedures(child, [...path, key]));
}

describe("contract metadata", () => {
  const all = procedures(contract);

  it("covers the M0 to M3 procedures", () => {
    expect(all.map((p) => p.path).toSorted()).toEqual([
      "agents.connectApp",
      "agents.create",
      "agents.remove",
      "agents.revoke",
      "agents.setEnabled",
      "agents.status",
      "analysis.check",
      "analysis.request",
      "analysis.setWaitFor",
      "browser.setEnabled",
      "browser.showExtension",
      "browser.status",
      "callOffers.allowApp",
      "callOffers.decline",
      "callOffers.listen",
      "callOffers.setEnabled",
      "callOffers.settings",
      "callOffers.skip",
      "calls.context",
      "calls.dismiss",
      "calls.notch",
      "calls.setNotch",
      "calls.watch",
      "chat.remove",
      "chat.send",
      "chat.setEnabled",
      "chat.setLimited",
      "chat.status",
      "chat.stop",
      "chat.watch",
      "compute.choose",
      "compute.connect",
      "compute.disconnect",
      "compute.get",
      "compute.joinBeta",
      "compute.leaveBeta",
      "compute.openBilling",
      "compute.quota",
      "compute.wave",
      "context.add",
      "context.edit",
      "context.get",
      "context.open",
      "context.paste",
      "context.pasteOngoing",
      "context.pick",
      "context.remove",
      "context.transcribe",
      "context.unpin",
      "diagnostics.health",
      "diagnostics.report",
      "diagnostics.spans",
      "dictation.apps",
      "dictation.setApp",
      "dictation.setText",
      "display.get",
      "display.update",
      "episodes.day",
      "episodes.delete",
      "episodes.deletePassage",
      "episodes.end",
      "episodes.exportAudio",
      "episodes.exportText",
      "episodes.forget",
      "episodes.forgetPreview",
      "episodes.get",
      "episodes.keepAudio",
      "episodes.keepRecent",
      "episodes.list",
      "episodes.merge",
      "episodes.openPage",
      "episodes.playback",
      "episodes.setJournalSource",
      "episodes.setKind",
      "episodes.setRecognition",
      "episodes.split",
      "history.redo",
      "history.undo",
      "imports.add",
      "imports.list",
      "imports.pick",
      "journal.claude",
      "journal.commitments",
      "journal.day",
      "journal.mark",
      "journal.request",
      "journal.settings",
      "listening.pause",
      "listening.resume",
      "live.partial",
      "live.setEnabled",
      "models.cancel",
      "models.download",
      "models.import",
      "models.pick",
      "models.status",
      "models.watch",
      "onboarding.advance",
      "onboarding.complete",
      "onboarding.get",
      "people.delete",
      "people.dictationLearning",
      "people.doubts",
      "people.get",
      "people.list",
      "people.merge",
      "people.recognition",
      "people.rename",
      "people.setDictationLearning",
      "people.setRecognition",
      "people.unnamed",
      "permissions.request",
      "phone.answer",
      "phone.pair",
      "phone.reset",
      "phone.revoke",
      "phone.setEnabled",
      "phone.setTailnet",
      "phone.status",
      "player.state",
      "privacy.addZone",
      "privacy.lift",
      "privacy.removeZone",
      "privacy.setDuration",
      "privacy.setMediaSite",
      "privacy.status",
      "privacy.updateZone",
      "search.foregroundApps",
      "search.query",
      "speakers.likeness",
      "speakers.merge",
      "speakers.name",
      "speakers.refuse",
      "speakers.unname",
      "statistics.get",
      "statistics.month",
      "status.get",
      "status.watch",
      "tags.delete",
      "tags.list",
      "tags.rename",
      "tags.set",
      "transcript.edit",
      "transcript.restore",
      "updates.check",
      "updates.closeNote",
      "updates.install",
      "updates.setAutomatic",
      "usage.conversationOpened",
      "usage.get",
      "usage.processCrashed",
      "usage.setSharing",
      "usage.windowOpened",
      "vocabulary.add",
      "vocabulary.list",
      "vocabulary.remove",
      "vocabulary.update",
      "voiceRead.cancel",
      "voiceRead.finish",
      "voiceRead.forget",
      "voiceRead.get",
      "voiceRead.start",
      "voiceRead.watch",
    ]);
  });

  it("keeps models, the first run, agent access, discussions and naming people away from agents", () => {
    for (const { path, meta } of all) {
      if (
        [
          "agents.",
          "calls.",
          "chat.",
          "history.",
          "models.",
          "onboarding.",
          "phone.",
          "speakers.",
          "transcript.",
          "voiceRead.",
        ].some((group) => path.startsWith(group))
      ) {
        expect(meta.mcp, path).toBeNull();
      }
    }
    // Agents read the people the user named, and change nothing about them.
    for (const { path, meta } of all.filter((p) => p.path.startsWith("people."))) {
      if (path === "people.list" || path === "people.get") {
        expect(meta.mcp?.readOnlyHint, path).toBe(true);
      } else {
        expect(meta.mcp, path).toBeNull();
      }
    }
  });

  it("gives every procedure an object_verb event name", () => {
    for (const { path, meta } of all) {
      expect(meta.event, path).toMatch(EVENT_NAME_PATTERN);
    }
    const events = all.map((p) => p.meta.event);
    expect(new Set(events).size).toBe(events.length);
  });

  it("declares MCP exposure with unique snake_case names and coherent hints", () => {
    const tools = all.flatMap((p) =>
      p.meta.mcp === null ? [] : [{ ...p.meta.mcp, path: p.path }],
    );
    expect(tools.length).toBe(16);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const tool of tools) {
      expect(tool.name, tool.path).toMatch(MCP_TOOL_NAME_PATTERN);
      expect(tool.description.length, tool.path).toBeGreaterThan(40);
      if (tool.readOnlyHint) expect(tool.destructiveHint, tool.path).toBe(false);
    }
    expect(all.find((p) => p.path === "status.watch")?.meta.mcp).toBeNull();
    // Agents read transcripts, never audio.
    expect(all.find((p) => p.path === "episodes.playback")?.meta).toEqual({
      event: "episode_played",
      mcp: null,
    });
    // Agents never erase what was heard, nor take it out of the Mac.
    for (const path of [
      "episodes.delete",
      "episodes.deletePassage",
      "episodes.end",
      "episodes.exportAudio",
      "episodes.exportText",
      "episodes.forget",
      "episodes.forgetPreview",
      "episodes.keepRecent",
      "episodes.merge",
      "episodes.setKind",
      "episodes.setRecognition",
      "episodes.split",
    ]) {
      expect(all.find((p) => p.path === path)?.meta.mcp, path).toBeNull();
    }
  });
});

describe("router", () => {
  it("keeps the last 2 minutes through one procedure, never offered to agents", async () => {
    const { services, calls } = fakeServices();
    const client = createRouterClient(router, { context: { services } });
    await expect(client.episodes.keepRecent()).resolves.toEqual({
      outcome: "kept",
      atMs: 1_793_610_120_000,
      keptMs: 120_000,
      episodeIds: [4],
    });
    expect(calls).toContainEqual({ method: "episodes.keepRecent", input: undefined });
    const procedure = procedures(contract).find((p) => p.path === "episodes.keepRecent");
    expect(procedure?.meta).toEqual({ event: "recent_kept", mcp: null });
  });

  it("returns validated status", async () => {
    const { services } = fakeServices();
    const client = createRouterClient(router, { context: { services } });
    await expect(client.status.get()).resolves.toEqual(status);
  });

  it("applies input defaults before calling services", async () => {
    const { services, calls } = fakeServices();
    const client = createRouterClient(router, { context: { services } });
    await client.listening.pause();
    await client.listening.resume({ scope: "microphone" });
    await client.diagnostics.health();
    await client.diagnostics.spans({ name: "helper." });
    expect(calls).toEqual([
      { method: "pause", input: { scope: "all" } },
      { method: "resume", input: { scope: "microphone" } },
      { method: "health", input: { limit: 60 } },
      { method: "spans", input: { limit: 200, name: "helper." } },
    ]);
  });

  it("rejects invalid input", async () => {
    const { services } = fakeServices();
    const client = createRouterClient(router, { context: { services } });
    // @ts-expect-error -- the wrong kind is the point of the test
    const [error] = await safe(client.permissions.request({ kind: "camera" }));
    expect(error).toBeInstanceOf(ORPCError);
    expect(error instanceof ORPCError && error.code).toBe("BAD_REQUEST");
  });

  it("rejects service output that breaks the schema", async () => {
    const { services } = fakeServices({
      status: {
        get: async () => ({ ...status, updatedAtMs: -1 }),
        watch: fakeServices().services.status.watch,
      },
    });
    const client = createRouterClient(router, { context: { services } });
    const [error] = await safe(client.status.get());
    expect(error instanceof ORPCError && error.code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("maps service failures to typed errors", async () => {
    const cases = [
      [new ServiceFailure("helper-unavailable", "not connected"), "HELPER_UNAVAILABLE"],
      [new ServiceFailure("timeout", "no answer"), "TIMEOUT"],
      [new ServiceFailure("helper-rejected", "refused", "request.rejected"), "HELPER_REJECTED"],
    ] as const;
    for (const [failure, code] of cases) {
      const client = createRouterClient(router, { context: { services: failingPause(failure) } });
      const [error] = await safe(client.listening.pause());
      expect(isDefinedError(error), code).toBe(true);
      expect(error instanceof ORPCError && error.code).toBe(code);
      if (code === "HELPER_REJECTED") {
        expect(error instanceof ORPCError && error.data).toEqual({ code: "request.rejected" });
      }
    }
  });

  it("serves episodes, search and analysis requests", async () => {
    const { services, calls } = fakeServices();
    const client = createRouterClient(router, { context: { services } });
    await expect(client.episodes.day()).resolves.toMatchObject({ traces: 4, momentHours: [{}] });
    await expect(client.episodes.list()).resolves.toEqual({
      day: "2026-11-05",
      episodes: [],
      nextCursor: null,
    });
    await client.episodes.list({
      day: "2026-11-04",
      hour: 14,
      lane: "moments",
      cursor: "1793610000000:12",
    });
    await expect(client.search.query({ text: "  bonjour " })).resolves.toMatchObject({
      episodes: [
        {
          hitCount: 1,
          hits: [
            {
              text: "Bonjour",
              highlights: [{ start: 0, end: 7 }],
              app: { bundleId: "app.sondine", name: "Sondine" },
            },
          ],
        },
      ],
      total: 1,
    });
    await client.search.query({
      text: "devis",
      from: "2026-11-01",
      to: "2026-11-05",
      sizes: ["conversation"],
      contexts: ["call", "in_person"],
      foregroundApp: "com.apple.dt.Xcode",
    });
    await expect(client.search.foregroundApps()).resolves.toEqual({
      apps: [{ bundleId: "app.sondine", name: "Sondine" }],
    });
    await expect(client.analysis.request({ episodeId: 2 })).resolves.toEqual({
      outcome: "queued",
      jobId: 7,
    });
    expect(calls).toEqual([
      { method: "episodes.day", input: {} },
      { method: "episodes.list", input: { limit: 200 } },
      {
        method: "episodes.list",
        input: {
          day: "2026-11-04",
          hour: 14,
          lane: "moments",
          cursor: "1793610000000:12",
          limit: 200,
        },
      },
      { method: "search", input: { text: "bonjour", limit: 20, offset: 0 } },
      {
        method: "search",
        input: {
          text: "devis",
          from: "2026-11-01",
          to: "2026-11-05",
          sizes: ["conversation"],
          contexts: ["call", "in_person"],
          foregroundApp: "com.apple.dt.Xcode",
          limit: 20,
          offset: 0,
        },
      },
      { method: "search.foregroundApps", input: undefined },
      { method: "analysis.request", input: { episodeId: 2 } },
    ]);
    const [missing] = await safe(client.episodes.get({ episodeId: 9 }));
    expect(isDefinedError(missing)).toBe(true);
    expect(missing instanceof ORPCError && missing.code).toBe("NOT_FOUND");
    const [empty] = await safe(client.search.query({ text: "   " }));
    expect(empty instanceof ORPCError && empty.code).toBe("BAD_REQUEST");
    const [backwards] = await safe(
      client.search.query({ text: "devis", from: "2026-11-05", to: "2026-11-01" }),
    );
    expect(backwards instanceof ORPCError && backwards.code).toBe("BAD_REQUEST");
    const [badCursor] = await safe(client.episodes.list({ cursor: "page-2" }));
    expect(badCursor instanceof ORPCError && badCursor.code).toBe("BAD_REQUEST");
  });

  it("serves an episode's playback as a media URL, and no audio", async () => {
    const { services, calls } = fakeServices();
    const client = createRouterClient(router, { context: { services } });
    await expect(client.episodes.playback({ episodeId: 2 })).resolves.toEqual({
      src: "sondine-media://episode/2?g=3",
      startedAtMs: 1_793_610_000_000,
      durationMs: 72_300,
      generation: 3,
      speech: [{ startMs: 1_793_610_001_000, endMs: 1_793_610_004_500, track: "microphone" }],
    });
    const [missing] = await safe(client.episodes.playback({ episodeId: 9 }));
    expect(isDefinedError(missing)).toBe(true);
    expect(missing instanceof ORPCError && missing.code).toBe("NOT_FOUND");
    expect(calls).toEqual([
      { method: "episodes.playback", input: { episodeId: 2 } },
      { method: "episodes.playback", input: { episodeId: 9 } },
    ]);
    // The old whole-file procedure's error is gone (the procedure list above has no audio).
    expect(Object.keys(apiErrors)).not.toContain("TOO_LONG");
  });

  it("rejects a playback whose URL is not a sondine-media: episode URL", async () => {
    for (const src of [
      "blob:sondine://app/1234",
      "file:///tmp/episode.wav",
      "sondine-media://episode/2",
      "data:audio/wav;base64,UklGRg==",
    ]) {
      const { services } = fakeServices();
      const client = createRouterClient(router, {
        context: {
          services: {
            ...services,
            episodes: {
              ...services.episodes,
              playback: async () => ({
                src,
                startedAtMs: 0,
                durationMs: 0,
                generation: 1,
                speech: [],
              }),
            },
          },
        },
      });
      const [error] = await safe(client.episodes.playback({ episodeId: 2 }));
      expect(error instanceof ORPCError && error.code, src).toBe("INTERNAL_SERVER_ERROR");
    }
  });

  it("passes a timed pause through and maps a past deadline to INVALID_INPUT", async () => {
    const { services, calls } = fakeServices();
    const client = createRouterClient(router, { context: { services } });
    await client.listening.pause({ untilMs: 1_793_610_900_000 });
    expect(calls).toEqual([
      { method: "pause", input: { scope: "all", untilMs: 1_793_610_900_000 } },
    ]);
    const [badShape] = await safe(client.listening.pause({ untilMs: -1 }));
    expect(badShape instanceof ORPCError && badShape.code).toBe("BAD_REQUEST");
    const past = createRouterClient(router, {
      context: {
        services: failingPause(new ServiceFailure("invalid-input", "The pause ends in the past.")),
      },
    });
    const [error] = await safe(past.listening.pause({ untilMs: 1 }));
    expect(isDefinedError(error)).toBe(true);
    expect(error instanceof ORPCError && error.code).toBe("INVALID_INPUT");
  });

  it("names a voice, and refuses a transcript that was replaced", async () => {
    const { services, calls } = fakeServices();
    const client = createRouterClient(router, { context: { services } });
    const target = { episodeId: 2, runId: 3, label: "input:mic/1/1" };
    await expect(
      client.speakers.name({ ...target, person: { kind: "new", name: "  Marie " } }),
    ).resolves.toEqual({ person: { id: 4, name: "Marie", self: false } });
    expect(calls.at(-1)).toEqual({
      method: "speakers.name",
      input: { ...target, person: { kind: "new", name: "Marie" } },
    });
    const [stale] = await safe(
      client.speakers.name({ ...target, runId: 1, person: { kind: "self", name: "Moi" } }),
    );
    expect(stale instanceof ORPCError && stale.code).toBe("INVALID_INPUT");
    const [empty] = await safe(client.people.rename({ personId: 4, name: "   " }));
    expect(empty instanceof ORPCError && empty.code).toBe("BAD_REQUEST");
    const [missing] = await safe(client.people.get({ personId: 9 }));
    expect(missing instanceof ORPCError && missing.code).toBe("NOT_FOUND");
  });

  it("serves models and the first run", async () => {
    const { services, calls } = fakeServices();
    const client = createRouterClient(router, { context: { services } });
    await expect(client.models.status()).resolves.toEqual(models);
    await client.models.import({ artifactId: "nemotron-3.5-transcribe-30b-iq4nl" });
    await expect(
      client.models.pick({ artifactId: "nemotron-3.5-transcribe-30b-iq4nl" }),
    ).resolves.toMatchObject({ outcome: "cancelled" });
    await client.models.download({ artifactId: "nemotron-3.5-transcribe-30b-iq4nl" });
    await client.models.cancel({ artifactId: "nemotron-3.5-transcribe-30b-iq4nl" });
    await expect(client.onboarding.get()).resolves.toEqual(onboarding);
    await client.onboarding.advance({ step: "permissions" });
    await expect(client.onboarding.complete()).resolves.toMatchObject({
      onboarding: { completed: true },
    });
    expect(calls).toEqual([
      { method: "models.import", input: { artifactId: "nemotron-3.5-transcribe-30b-iq4nl" } },
      { method: "models.pick", input: { artifactId: "nemotron-3.5-transcribe-30b-iq4nl" } },
      { method: "models.download", input: { artifactId: "nemotron-3.5-transcribe-30b-iq4nl" } },
      {
        method: "models.cancel",
        input: { artifactId: "nemotron-3.5-transcribe-30b-iq4nl", discard: false },
      },
      { method: "onboarding.advance", input: { step: "permissions" } },
      { method: "onboarding.complete", input: { startListening: true } },
    ]);
    const [unknown] = await safe(client.models.import({ artifactId: "whisper" }));
    expect(unknown instanceof ORPCError && unknown.code).toBe("NOT_FOUND");
    // @ts-expect-error -- a step the first run does not have
    const [badStep] = await safe(client.onboarding.advance({ step: "done" }));
    expect(badStep instanceof ORPCError && badStep.code).toBe("BAD_REQUEST");
    const seen: (number | null)[] = [];
    for await (const next of await client.models.watch()) {
      seen.push(next.artifacts[0]?.progress ?? null);
    }
    expect(seen).toEqual([0.25, 0.5]);
  });

  it("streams status changes", async () => {
    const { services } = fakeServices();
    const client = createRouterClient(router, { context: { services } });
    const seen: number[] = [];
    for await (const next of await client.status.watch()) seen.push(next.updatedAtMs);
    expect(seen).toEqual([1, 2, 3].map((n) => status.updatedAtMs + n));
  });
});

describe("agents and excerpts", () => {
  it("reads an excerpt only with both ends, at most 30 minutes apart", async () => {
    const { services, calls } = fakeServices();
    const client = createRouterClient(router, { context: { services } });
    for (const input of [
      { episodeId: 1, fromMs: 1_000 },
      { episodeId: 1, fromMs: 2_000, toMs: 1_000 },
      { episodeId: 1, fromMs: 0, toMs: 30 * 60_000 + 1 },
    ]) {
      const [error] = await safe(client.episodes.get(input));
      expect(error, JSON.stringify(input)).toBeInstanceOf(ORPCError);
    }
    expect(calls.filter((call) => call.method === "episodes.get")).toEqual([]);
  });

  it("maps an unknown agent to NOT_FOUND", async () => {
    const { services } = fakeServices();
    const client = createRouterClient(router, { context: { services } });
    const [error] = await safe(client.agents.remove({ agentId: 9 }));
    expect(isDefinedError(error) && error.code).toBe("NOT_FOUND");
    await expect(client.agents.create({ name: "  Claude Code " })).resolves.toMatchObject({
      agent: { name: "Claude Code" },
    });
  });

  it("connects only the apps Sondine knows, and says when it left an app's file alone", async () => {
    const { calls, services } = fakeServices();
    const client = createRouterClient(router, { context: { services } });
    // @ts-expect-error -- an app Sondine does not write into
    const [unknown] = await safe(client.agents.connectApp({ app: "chatgpt" }));
    expect(unknown).toBeInstanceOf(ORPCError);
    const [missing] = await safe(client.agents.connectApp({ app: "cursor" }));
    expect(isDefinedError(missing) && missing.code).toBe("NOT_FOUND");
    await expect(client.agents.connectApp({ app: "grok" })).resolves.toEqual({
      ok: false,
      path: "~/.grok/config.toml",
      problem: "unreadable",
    });
    expect(calls.filter((call) => call.method === "agents.connectApp")).toHaveLength(2);
  });
});

describe("phone procedures", () => {
  it("name every route of the phone contract, and nothing else reaches a phone", () => {
    expect([...PHONE_PROCEDURES].toSorted()).toEqual(Object.keys(PHONE_ALL_ROUTES).toSorted());
    // The app's procedures are not a phone's: Settings ▸ Téléphone is the user's.
    const phone = procedures(contract).filter((p) => p.path.startsWith("phone."));
    expect(phone.length).toBeGreaterThan(0);
    expect(phone.every((p) => p.meta.mcp === null)).toBe(true);
  });

  it("read the Mac's memory through agents' read-only tools only", () => {
    const tools = new Map(agentTools().map((tool) => [tool.name, tool]));
    expect(Object.keys(PHONE_MEMORY_READS).toSorted()).toEqual(
      Object.keys(PHONE_MEMORY_ROUTES).toSorted(),
    );
    for (const name of Object.values(PHONE_MEMORY_READS)) {
      expect(tools.get(name)?.meta).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });
});

describe("agent tools", () => {
  it("offers agents an explicit list of read-only reads, with their procedures' inputs", () => {
    const tools = agentTools();
    expect(tools.map((tool) => [tool.name, tool.path.join(".")])).toEqual([
      ["get_status", "status.get"],
      ["get_day_overview", "episodes.day"],
      ["list_episodes", "episodes.list"],
      ["get_episode", "episodes.get"],
      ["get_context_item", "context.get"],
      ["search_transcripts", "search.query"],
      ["list_people", "people.list"],
      ["get_person", "people.get"],
      ["get_journal", "journal.day"],
      ["list_commitments", "journal.commitments"],
    ]);
    const getEpisode = tools.find((tool) => tool.name === "get_episode");
    expect(getEpisode?.input.safeParse({ episodeId: 1, fromMs: 5 }).success).toBe(false);
    expect(getEpisode?.input.safeParse({ episodeId: 1, fromMs: 5, toMs: 10 }).success).toBe(true);
    // Every read with MCP metadata but not offered stays a diagnostic or a write.
    for (const name of [
      "get_capture_health",
      "list_spans",
      "pause_listening",
      "request_analysis",
    ]) {
      expect(
        tools.some((tool) => tool.name === name),
        name,
      ).toBe(false);
    }
  });
});

describe("transcript JSON", () => {
  it("publishes its schemas in docs/schemas, generated from the code", () => {
    for (const [name, schema] of Object.entries(exportJsonSchemas())) {
      const published = JSON.parse(
        readFileSync(resolve(import.meta.dirname, "../../../docs/schemas", name), "utf8"),
      );
      expect(published, name).toEqual(schema);
    }
  });
});

describe("EpisodeDetail", () => {
  it("lists every recording of the same meeting: a 3 h phone recording may overlap many", () => {
    const moments = Array.from({ length: 40 }, (_, index) => ({
      episodeId: index + 1,
      by: "mac" as const,
      offsetMs: -2_300,
      driftPpm: 12,
      anchorMs: 1_794_560_000_000,
      sharedFromMs: 1_794_560_000_000,
      sharedToMs: 1_794_560_060_000,
      feedsJournal: true,
    }));
    expect(EpisodeDetail.shape.sameMoments.safeParse(moments).success).toBe(true);
  });
});
