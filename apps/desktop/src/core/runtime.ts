import { Context, Effect, Layer, ManagedRuntime } from "effect";
import {
  analysisQueueLayer,
  AnalysisQueue,
  nemotronEngineLayer,
  parakeetEngineLayer,
  systemSignalsLayer,
  trackAudioLayer,
  type AnalysisOptions,
  type EngineProvider,
  type ParakeetEngineProvider,
  type SystemSignals,
  type TrackAudioSource,
} from "./analysis/analysis-layer";
import { agentAccessLayer } from "./agents/agent-access";
import { agentHostLayer } from "./agents/agent-host";
import { apiLayer } from "./api-services";
import { chatKeysLayer } from "./chat/chat-keys";
import { chatLayer } from "./chat/chat-layer";
import { browserLinkLayer } from "./browser/browser-link";
import { contextLayer } from "./context/context-layer";
import { exportsLayer } from "./exports";
import { callContextLayer } from "./voices/call-context-layer";
import { voicePassLayer, type VoicePass } from "./voices/voice-pass";
import { voiceReadLayer } from "./voices/voice-read";
import { episodeMediaLayer } from "./audio/episode-media";
import { importerLayer, Importer } from "./capture/importer";
import { type Compute, computeLayer, type ComputeOptions } from "./compute/compute-layer";
import { type CoreConfig, coreConfigLayer, type CoreConfigShape } from "./config";
import { type Database, databaseLayer } from "./database";
import { filePickerLayer } from "./file-picker";
import { importsLayer } from "./imports/imports-layer";
import {
  journalEngineLayer,
  journalLayer,
  type JournalEngineProvider,
} from "./journal/journal-layer";
import {
  EpisodeBuilder,
  episodeBuilderLayer,
  type EpisodeBuilderOptions,
} from "./episodes/episode-builder";
import { HelperClient, helperClientLayer, type HelperClientOptions } from "./helper/helper-client";
import { Listening, listeningLayer, type ListeningOptions } from "./listening";
import { callOffersLayer, type CallOffersOptions } from "./call-offers/call-offers";
import {
  PauseReminder,
  pauseReminderLayer,
  type PauseReminderOptions,
} from "./call-offers/pause-reminder";
import { liveTextLayer, type LiveOptions } from "./live/live-layer";
import { type MainChannel, mainChannelLayer, type MainChannelService } from "./main-channel";
import { type Models, modelsLayer, type ModelsOptions } from "./models/models-layer";
import { Onboarding, onboardingLayer, type OnboardingOptions } from "./onboarding";
import { phoneSyncLayer, type PhoneOptions } from "./phone/phone-layer";
import { privacyLayer } from "./privacy/privacy";
import { retentionLayer } from "./retention/retention";
import { sameMomentLayer } from "./same-moment/same-moment-layer";
import { selfEchoLayer } from "./echo/self-echo-layer";
import { rpcHostLayer } from "./rpc-host";
import { usageLayer, type UsageOptions, type UsageStatistics } from "./usage/usage-layer";
import { goingOnActionsLayer } from "./going-on";
import { updatesLayer, type UpdatesOptions } from "./updates/updates-layer";
import { spansLayer, tracerLayer } from "./spans";
import {
  type CoreState,
  coreStateLayer,
  StatusProjection,
  statusProjectionLayer,
} from "./status/core-state";

/** What the engine, audio and signal layers may use. */
export type AnalysisInputDeps =
  | CoreConfig
  | Database
  | CoreState
  | MainChannel
  | Models
  | Compute
  | UsageStatistics;

export interface CoreLayerOptions {
  readonly helper?: HelperClientOptions;
  readonly spans?: Parameters<typeof spansLayer>[0];
  /**
   * The ASR engines (the verified Nemotron model by default, and Parakeet for
   * near-live text and dictations), the track audio reader (the spool and
   * archive), and the Mac's signals; tests replace them.
   */
  readonly analysis?: AnalysisOptions & {
    readonly engine?: Layer.Layer<EngineProvider, never, AnalysisInputDeps>;
    readonly parakeet?: Layer.Layer<ParakeetEngineProvider, never, AnalysisInputDeps>;
    readonly audio?: Layer.Layer<TrackAudioSource, never, AnalysisInputDeps>;
    readonly signals?: Layer.Layer<SystemSignals, never, AnalysisInputDeps>;
    /** The journal's text model (ADR 028); tests replace it. */
    readonly journal?: Layer.Layer<JournalEngineProvider, never, AnalysisInputDeps>;
  };
  readonly episodes?: EpisodeBuilderOptions;
  /** The clock and check interval of timed pauses. */
  readonly listening?: ListeningOptions;
  readonly callOffers?: CallOffersOptions;
  /** A forgotten pause's clock and delay. */
  readonly pauseReminder?: PauseReminderOptions;
  /** Tests of capture skip the first run, which keeps a fresh install paused. */
  readonly onboarding?: OnboardingOptions;
  /** The voice pass (sondine-voice when the build has it); tests replace it. */
  readonly voices?: Layer.Layer<VoicePass, never, CoreConfig | Database | TrackAudioSource>;
  /** The catalog, network and disk the model jobs use; tests replace them. */
  readonly models?: ModelsOptions;
  /** The beta's server and the network compute servers are reached through; tests answer them. */
  readonly compute?: ComputeOptions;
  /** The updates' request, download, tools and clock; tests answer them. */
  readonly updates?: UpdatesOptions;
  /** The anonymous statistics' request and clock (ADR 042); tests answer it themselves. */
  readonly usage?: UsageOptions;
  /** Near-live text's timing; tests replace it. */
  readonly live?: LiveOptions;
  /** Phone sync's relay, clock and limits (ADR 008); tests replace them. */
  readonly phone?: PhoneOptions;
}

/** Starts the helper connection once every event subscriber is in place. */
class Launcher extends Context.Service<Launcher, { readonly started: true }>()(
  "sondine/core/Launcher",
) {}

const launcherLayer = Layer.effect(
  Launcher,
  Effect.gen(function* () {
    yield* Importer;
    yield* StatusProjection;
    yield* Listening;
    // A fresh install's pause is stored before the helper connects.
    yield* Onboarding;
    yield* AnalysisQueue;
    yield* EpisodeBuilder;
    yield* PauseReminder;
    const helper = yield* HelperClient;
    yield* Effect.forkScoped(helper.run);
    return Launcher.of({ started: true });
  }),
);

/**
 * Core's layers, in dependency order: config and the main channel, spans and
 * the recording tracer (so every later layer's fibers are traced), the
 * database, helper client and state, then the domain services (listening,
 * the importer, the status, the models), the first run, spool retention, the
 * analysis queue (which recovers interrupted jobs before any worker starts),
 * near-live text, the episode builder, Sondine's own sound judged against its
 * reference (ADR 035), the same meeting on both devices (ADR 032),
 * playback, phone sync, the API, and its hosts: oRPC
 * for the app and, while the user allows it, the agents' MCP socket. Closing the
 * runtime runs every finalizer: the helper socket, the span file and the
 * database close in reverse order.
 */
export function coreLayer(
  config: CoreConfigShape,
  main: MainChannelService,
  options: CoreLayerOptions = {},
) {
  const base = Layer.mergeAll(coreConfigLayer(config), mainChannelLayer(main));
  const observability = tracerLayer.pipe(
    Layer.provideMerge(spansLayer(options.spans)),
    Layer.provideMerge(base),
  );
  const infrastructure = Layer.mergeAll(
    usageLayer(options.usage).pipe(Layer.provideMerge(databaseLayer)),
    helperClientLayer(options.helper),
    coreStateLayer,
    filePickerLayer(),
  ).pipe(Layer.provideMerge(observability));
  const domain = Layer.mergeAll(
    listeningLayer(options.listening),
    importerLayer,
    statusProjectionLayer,
    modelsLayer(options.models),
    computeLayer(options.compute),
    agentAccessLayer,
    chatKeysLayer,
  ).pipe(Layer.provideMerge(infrastructure));
  const onboarding = onboardingLayer(options.onboarding).pipe(Layer.provideMerge(domain));
  // Retention follows the importer's reconciliations.
  const retention = retentionLayer.pipe(Layer.provideMerge(onboarding));
  const analysisInputs = Layer.mergeAll(
    options.analysis?.engine ?? nemotronEngineLayer,
    options.analysis?.parakeet ?? parakeetEngineLayer,
    options.analysis?.audio ?? trackAudioLayer,
    options.analysis?.signals ?? systemSignalsLayer,
    options.analysis?.journal ?? journalEngineLayer,
  ).pipe(Layer.provideMerge(retention));
  const journal = journalLayer.pipe(Layer.provideMerge(analysisInputs));
  const analysis = analysisQueueLayer(options.analysis).pipe(Layer.provideMerge(journal));
  // After the queue's recovery stopped any orphan speech worker.
  const live = liveTextLayer(options.live).pipe(Layer.provideMerge(analysis));
  const episodes = episodeBuilderLayer(options.episodes).pipe(Layer.provideMerge(live));
  // Sondine's own sound on the speakers, judged against its reference (ADR 035).
  const selfEcho = selfEchoLayer.pipe(Layer.provideMerge(episodes));
  // Before the imports, which wake it once a phone recording is in.
  const sameMoment = sameMomentLayer.pipe(Layer.provideMerge(selfEcho));
  const media = Layer.mergeAll(
    episodeMediaLayer,
    exportsLayer,
    importsLayer,
    contextLayer,
    browserLinkLayer,
    callContextLayer,
    callOffersLayer(options.callOffers),
    pauseReminderLayer(options.pauseReminder),
    privacyLayer,
    options.voices ?? voicePassLayer,
  ).pipe(Layer.provideMerge(sameMoment));
  const assistants = Layer.mergeAll(
    chatLayer,
    phoneSyncLayer(options.phone),
    voiceReadLayer,
    goingOnActionsLayer,
  ).pipe(Layer.provideMerge(media));
  // After everything an update would cut (ADR 045).
  const updates = updatesLayer(options.updates).pipe(Layer.provideMerge(assistants));
  const api = apiLayer.pipe(Layer.provideMerge(updates));
  return Layer.mergeAll(rpcHostLayer, agentHostLayer, launcherLayer).pipe(Layer.provideMerge(api));
}

export function makeCoreRuntime(
  config: CoreConfigShape,
  main: MainChannelService,
  options?: CoreLayerOptions,
) {
  return ManagedRuntime.make(coreLayer(config, main, options));
}

export type CoreRuntime = ReturnType<typeof makeCoreRuntime>;
