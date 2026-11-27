import type { UsageError, UsageSurface } from "@sondine/protocol";
import type * as z from "zod";
import type {
  AgentAppConnectResult,
  AgentAppInput,
  AgentCreateInput,
  AgentCreateResult,
  AgentInput,
  AgentRevokeResult,
  AgentsEnabledInput,
  AgentsStatus,
  AnalysisCheck,
  AnalysisRequestResult,
  AnalysisWaitForInput,
  BackupChooseResult,
  BackupExportInput,
  BackupExportResult,
  BackupInspectResult,
  BackupPassphraseInput,
  BackupRestoreResult,
  BackupStatus,
  BrowserEnabledInput,
  BrowserShowExtensionResult,
  BrowserStatus,
  PhoneAnswerInput,
  PhoneEnabledInput,
  PhoneRevokeInput,
  PhoneStatus,
  CallContext,
  CallDismissInput,
  CallOfferAppInput,
  CallOfferDeclineInput,
  CallOfferEnabledInput,
  CallOfferInput,
  CallOfferSettings,
  ChatDiscussionInput,
  ChatEnabledInput,
  ChatSendInput,
  ChatSendResult,
  ChatProvider,
  ChatStatus,
  ChatStatusInput,
  ChatView,
  ChatWatchInput,
  ComputeChooseInput,
  ComputeConnectInput,
  ComputeConnectResult,
  ComputeJoinInput,
  ComputeJoinResult,
  ComputeQuota,
  ComputeBillingInput,
  ComputeBillingResult,
  ComputeWave,
  ComputeStatus,
  ContextAddInput,
  ContextAddResult,
  ContextEditInput,
  ContextItemDetail,
  ContextItemInput,
  ContextOngoingResult,
  ContextOpenResult,
  ContextTargetInput,
  DictationAppInput,
  DictationApps,
  DictationTextInput,
  EpisodeDeleteResult,
  EpisodeDetail,
  EpisodeExportResult,
  EpisodeExportTextInput,
  EpisodeExportTextResult,
  EpisodeGetInput,
  EpisodeInput,
  EpisodeKeepAudioInput,
  EpisodeJournalSourceInput,
  EpisodeJournalSourceResult,
  EpisodeKindInput,
  EpisodeKindResult,
  EpisodeEndResult,
  EpisodeMergeInput,
  EpisodeMergeResult,
  EpisodeOpenPageInput,
  EpisodeOpenPageResult,
  EpisodePassageInput,
  EpisodePassageResult,
  EpisodePlayback,
  EpisodePrivacy,
  EpisodeRecognitionInput,
  EpisodeSplitInput,
  EpisodeSplitResult,
  EpisodesDayInput,
  EpisodesDayOutput,
  EpisodesListInput,
  EpisodesListOutput,
  ForegroundApps,
  JournalCommitmentsInput,
  JournalCommitmentsOutput,
  JournalDay,
  JournalDayInput,
  JournalMarkInput,
  JournalMarkResult,
  JournalRequestInput,
  JournalSettings,
  JournalSettingsInput,
  JournalState,
  ForgetInput,
  ForgetPreview,
  ForgetResult,
  ForgetRunInput,
  KeepRecentResult,
  HealthInput,
  HealthOutput,
  ImportPickResult,
  ImportsAddInput,
  ImportsAddResult,
  ImportsListInput,
  ImportsListOutput,
  ListeningInput,
  ListeningStatus,
  LiveEnabledInput,
  LivePartial,
  LiveStatus,
  ModelCancelInput,
  ModelImportInput,
  ModelInput,
  ModelPickResult,
  ModelsStatus,
  NotchSettings,
  OnboardingAdvanceInput,
  OnboardingCompleteInput,
  OnboardingCompleteResult,
  OnboardingStatus,
  DisplaySettings,
  DisplayUpdateInput,
  VoiceReadStartInput,
  VoiceReadStatus,
  PauseInput,
  PeopleListOutput,
  PeopleDoubtsOutput,
  PeopleUnnamedOutput,
  PermissionKind,
  PermissionRequestResult,
  PersonDeleteResult,
  PersonDetail,
  PersonGetInput,
  PersonInput,
  PersonMergeInput,
  PersonRef,
  PersonRenameInput,
  PlayerStateInput,
  PlayerStateResult,
  PrivacyAddZoneInput,
  PrivacyDurationInput,
  PrivacyDurationResult,
  PrivacyLiftInput,
  PrivacyMediaSiteInput,
  PrivacyStatus,
  PrivacyUpdateZoneInput,
  PrivacyZoneIdInput,
  DictationLearning,
  Recognition,
  SearchInput,
  SearchOutput,
  SpansInput,
  SpansOutput,
  SpeakerNameInput,
  SpeakerNameResult,
  SpeakerRefuseInput,
  SpeakerLikenessOutput,
  SpeakerMergeInput,
  SpeakerMergeResult,
  SpeakerUnnameInput,
  SpeakerUnnameResult,
  Status,
  TranscriptEditInput,
  TranscriptEditResult,
  TranscriptRestoreInput,
  UndoStep,
  UpdatesAutomaticInput,
  UpdatesStatus,
  Statistics,
  StatisticsMonth,
  StatisticsMonthInput,
  ChatLimitInput,
  TagDeleteInput,
  TagDeleteResult,
  TagList,
  TagRenameInput,
  TagRenameResult,
  TagSetInput,
  VocabularyAddInput,
  VocabularyEntry,
  VocabularyList,
  VocabularyRemoveInput,
  VocabularyUpdateInput,
  TranscriptCorrectResult,
  TagSetResult,
  DiagnosticReport,
  UsageCrashInput,
  UsageSharingInput,
  UsageStatus,
} from "./schemas";

/**
 * What the procedures call. Core implements it on its Effect runtime; tests
 * implement it with fakes. Implementations throw `ServiceFailure` for
 * expected failures.
 */
export interface ApiServices {
  readonly status: {
    get(): Promise<Status>;
    /** Yields the current status at once, then on every change until `signal` aborts. */
    watch(signal: AbortSignal | undefined): AsyncIterable<Status>;
  };
  readonly listening: {
    /** Throws `ServiceFailure("invalid-input")` for an `untilMs` already past. */
    pause(input: z.output<typeof PauseInput>): Promise<ListeningStatus>;
    resume(input: z.output<typeof ListeningInput>): Promise<ListeningStatus>;
  };
  readonly callOffers: {
    /** Throws `ServiceFailure("not-found")` when this call is no longer offered. */
    listen(input: z.output<typeof CallOfferInput>): Promise<ListeningStatus>;
    skip(input: z.output<typeof CallOfferInput>): Promise<ListeningStatus>;
    decline(input: z.output<typeof CallOfferDeclineInput>): Promise<ListeningStatus>;
    settings(): Promise<CallOfferSettings>;
    setEnabled(input: z.output<typeof CallOfferEnabledInput>): Promise<CallOfferSettings>;
    allowApp(input: z.output<typeof CallOfferAppInput>): Promise<CallOfferSettings>;
  };
  readonly permissions: {
    request(input: { kind: PermissionKind }): Promise<PermissionRequestResult>;
  };
  readonly episodes: {
    day(input: z.output<typeof EpisodesDayInput>): Promise<EpisodesDayOutput>;
    list(input: z.output<typeof EpisodesListInput>): Promise<EpisodesListOutput>;
    /** Throws `ServiceFailure("not-found")` for an unknown or deleted episode. */
    get(input: z.output<typeof EpisodeGetInput>): Promise<EpisodeDetail>;
    /**
     * Plans playback without reading audio. Throws `ServiceFailure("not-found")`
     * for an unknown or deleted episode.
     */
    playback(input: z.output<typeof EpisodeInput>): Promise<EpisodePlayback>;
    /**
     * Asks main for a save panel and writes the episode's WAV there, as
     * playback reads it. Throws `ServiceFailure("not-found")` for an unknown
     * or deleted episode.
     */
    exportAudio(input: z.output<typeof EpisodeInput>): Promise<EpisodeExportResult>;
    /**
     * Puts a transcript the window wrote on the clipboard, or in a file
     * through a save panel; NOT_FOUND for an unknown or deleted episode.
     */
    exportText(input: z.output<typeof EpisodeExportTextInput>): Promise<EpisodeExportTextResult>;
    /** Throws `not-found` for an unknown episode or a segment not in it. */
    openPage(input: z.output<typeof EpisodeOpenPageInput>): Promise<EpisodeOpenPageResult>;
    /**
     * Throws `not-found` for an unknown or open episode and `invalid-input`
     * for a cut outside it or leaving a side without speech.
     */
    end(input: z.output<typeof EpisodeInput>): Promise<EpisodeEndResult>;
    split(input: z.output<typeof EpisodeSplitInput>): Promise<EpisodeSplitResult>;
    /** Throws `not-found` for an unknown or open episode. */
    setKind(input: z.output<typeof EpisodeKindInput>): Promise<EpisodeKindResult>;
    setJournalSource(
      input: z.output<typeof EpisodeJournalSourceInput>,
    ): Promise<EpisodeJournalSourceResult>;
    keepAudio(input: z.output<typeof EpisodeKeepAudioInput>): Promise<EpisodePrivacy>;
    /** Throws `not-found` as `split` does, and `invalid-input` for episodes that are not neighbours. */
    merge(input: z.output<typeof EpisodeMergeInput>): Promise<EpisodeMergeResult>;
    /**
     * Erases the episode for good: its audio (tombstoned, chunks zeroed), its
     * text and index rows, its analysis and jobs (ADR 006, `deleteEpisode`).
     */
    delete(input: z.output<typeof EpisodeInput>): Promise<EpisodeDeleteResult>;
    /**
     * Deletes a passage of a closed episode for good. Throws
     * `ServiceFailure("not-found")` without such an episode and
     * `"invalid-input"` for a passage outside it.
     */
    deletePassage(input: z.output<typeof EpisodePassageInput>): Promise<EpisodePassageResult>;
    /** Throws `ServiceFailure("not-found")` without such an episode, or for media. */
    setRecognition(input: z.output<typeof EpisodeRecognitionInput>): Promise<EpisodeKindResult>;
    /** The recordings `forget` would delete now, and its range. */
    forgetPreview(input: z.output<typeof ForgetInput>): Promise<ForgetPreview>;
    /**
     * Erases everything heard in the `minutes` before `untilMs` (a preview's
     * range, `forgetRange`): the recordings it touches whole, every audio
     * block in it, and a tombstone over it so nothing comes back. Throws
     * `ServiceFailure("invalid-input")` for an `untilMs` ahead of now or over
     * an hour old.
     */
    forget(input: z.output<typeof ForgetRunInput>): Promise<ForgetResult>;
    /**
     * Keeps what the Mac captured in the last 2 minutes, speech or not, still
     * in the spool or in a recording still open (`keepRecentAudio`).
     */
    keepRecent(): Promise<KeepRecentResult>;
  };
  /**
   * People the user named. `get`, `rename` and `delete` throw
   * `ServiceFailure("not-found")` for an unknown person (`delete` answers
   * `deleted: false` instead).
   */
  readonly people: {
    list(): Promise<PeopleListOutput>;
    get(input: z.output<typeof PersonGetInput>): Promise<PersonDetail>;
    rename(input: z.output<typeof PersonRenameInput>): Promise<PersonRef>;
    merge(input: z.output<typeof PersonMergeInput>): Promise<PersonRef>;
    /** Deletes the person and every name given to their voices (ADR 012). */
    delete(input: z.output<typeof PersonInput>): Promise<PersonDeleteResult>;
    unnamed(): Promise<PeopleUnnamedOutput>;
    doubts(): Promise<PeopleDoubtsOutput>;
    recognition(): Promise<Recognition>;
    setRecognition(input: z.output<typeof Recognition>): Promise<Recognition>;
    dictationLearning(): Promise<DictationLearning>;
    setDictationLearning(input: z.output<typeof DictationLearning>): Promise<DictationLearning>;
  };
  /**
   * Naming a voice of one transcript version. Throws `not-found` for an
   * unknown episode, voice or person, and `invalid-input` when the
   * transcript was replaced, in media, or where voices are not identified.
   */
  readonly speakers: {
    name(input: z.output<typeof SpeakerNameInput>): Promise<SpeakerNameResult>;
    unname(input: z.output<typeof SpeakerUnnameInput>): Promise<SpeakerUnnameResult>;
    refuse(input: z.output<typeof SpeakerRefuseInput>): Promise<SpeakerUnnameResult>;
    likeness(input: z.output<typeof SpeakerUnnameInput>): Promise<SpeakerLikenessOutput>;
    /** Throws `invalid-input` when either voice is named. */
    merge(input: z.output<typeof SpeakerMergeInput>): Promise<SpeakerMergeResult>;
  };
  readonly calls: {
    context(): Promise<CallContext>;
    /** Yields the call context at once, then on every change until `signal` aborts. */
    watch(signal: AbortSignal | undefined): AsyncIterable<CallContext>;
    dismiss(input: z.output<typeof CallDismissInput>): Promise<CallContext>;
    notch(): Promise<NotchSettings>;
    setNotch(input: z.output<typeof NotchSettings>): Promise<NotchSettings>;
  };
  readonly search: {
    query(input: z.output<typeof SearchInput>): Promise<SearchOutput>;
    foregroundApps(): Promise<ForegroundApps>;
  };
  readonly analysis: {
    /** Throws `ServiceFailure("not-found")` for an unknown or deleted episode. */
    request(input: z.output<typeof EpisodeInput>): Promise<AnalysisRequestResult>;
    check(): Promise<AnalysisCheck>;
    setWaitFor(input: z.output<typeof AnalysisWaitForInput>): Promise<AnalysisCheck>;
  };
  readonly compute: {
    get(): Promise<ComputeStatus>;
    /** Throws `ServiceFailure("invalid-input")` for a destination that is not set up. */
    choose(input: z.output<typeof ComputeChooseInput>): Promise<ComputeStatus>;
    connect(input: z.output<typeof ComputeConnectInput>): Promise<ComputeConnectResult>;
    disconnect(): Promise<ComputeStatus>;
    joinBeta(input: z.output<typeof ComputeJoinInput>): Promise<ComputeJoinResult>;
    leaveBeta(): Promise<ComputeStatus>;
    quota(): Promise<ComputeQuota | null>;
    /** How full the Cloud's wave is; null when this build or its server has none. */
    wave(): Promise<ComputeWave | null>;
    /** Opens a Stripe page in the browser; the app never talks to Stripe (ADR 047). */
    openBilling(input: z.output<typeof ComputeBillingInput>): Promise<ComputeBillingResult>;
  };
  readonly live: {
    setEnabled(input: z.output<typeof LiveEnabledInput>): Promise<LiveStatus>;
    partial(input: z.output<typeof EpisodeInput>): Promise<LivePartial>;
  };
  readonly imports: {
    pick(): Promise<ImportPickResult>;
    add(input: z.output<typeof ImportsAddInput>): Promise<ImportsAddResult>;
    list(input: z.output<typeof ImportsListInput>): Promise<ImportsListOutput>;
  };
  /**
   * A conversation's context (ADR 024). `add`, `paste` and `pick` throw
   * `not-found` for an unknown episode or sentence; the item methods throw
   * `not-found` for an item that is gone and `invalid-input` for an edit of
   * the wrong kind.
   */
  readonly context: {
    add(input: z.output<typeof ContextAddInput>): Promise<ContextAddResult>;
    paste(input: z.output<typeof ContextTargetInput>): Promise<ContextAddResult>;
    pick(input: z.output<typeof ContextTargetInput>): Promise<ContextAddResult>;
    edit(input: z.output<typeof ContextEditInput>): Promise<Record<string, never>>;
    unpin(input: z.output<typeof ContextItemInput>): Promise<Record<string, never>>;
    remove(input: z.output<typeof ContextItemInput>): Promise<Record<string, never>>;
    open(input: z.output<typeof ContextItemInput>): Promise<ContextOpenResult>;
    get(input: z.output<typeof ContextItemInput>): Promise<ContextItemDetail>;
    transcribe(input: z.output<typeof ContextItemInput>): Promise<ImportPickResult>;
    pasteOngoing(): Promise<ContextOngoingResult>;
  };
  /**
   * The daily journal (ADR 028). `mark` throws `not-found` for a line or a
   * mark that is gone (regenerated or deleted since the window read it).
   */
  readonly journal: {
    day(input: z.output<typeof JournalDayInput>): Promise<JournalDay>;
    commitments(input: z.output<typeof JournalCommitmentsInput>): Promise<JournalCommitmentsOutput>;
    mark(input: z.output<typeof JournalMarkInput>): Promise<JournalMarkResult>;
    request(input: z.output<typeof JournalRequestInput>): Promise<JournalState>;
    settings(input: z.output<typeof JournalSettingsInput>): Promise<JournalSettings>;
    claude(): Promise<ChatProvider>;
  };
  readonly player: {
    state(input: z.output<typeof PlayerStateInput>): Promise<PlayerStateResult>;
  };
  readonly browser: {
    status(): Promise<BrowserStatus>;
    setEnabled(input: z.output<typeof BrowserEnabledInput>): Promise<BrowserStatus>;
    showExtension(): Promise<BrowserShowExtensionResult>;
  };
  readonly phone: {
    status(): Promise<PhoneStatus>;
    setEnabled(input: z.output<typeof PhoneEnabledInput>): Promise<PhoneStatus>;
    setTailnet(input: z.output<typeof PhoneEnabledInput>): Promise<PhoneStatus>;
    /** Throws `invalid-input` when this build has no relay, or it does not start. */
    pair(): Promise<PhoneStatus>;
    answer(input: z.output<typeof PhoneAnswerInput>): Promise<PhoneStatus>;
    /** Throws `not-found` for a phone that is not paired. */
    revoke(input: z.output<typeof PhoneRevokeInput>): Promise<PhoneStatus>;
    reset(): Promise<PhoneStatus>;
  };
  readonly privacy: {
    status(): Promise<PrivacyStatus>;
    addZone(input: z.output<typeof PrivacyAddZoneInput>): Promise<PrivacyStatus>;
    updateZone(input: z.output<typeof PrivacyUpdateZoneInput>): Promise<PrivacyStatus>;
    removeZone(input: z.output<typeof PrivacyZoneIdInput>): Promise<PrivacyStatus>;
    setMediaSite(input: z.output<typeof PrivacyMediaSiteInput>): Promise<PrivacyStatus>;
    setDuration(input: z.output<typeof PrivacyDurationInput>): Promise<PrivacyDurationResult>;
    lift(input: z.output<typeof PrivacyLiftInput>): Promise<ListeningStatus>;
  };
  readonly dictation: {
    apps(): Promise<DictationApps>;
    setApp(input: z.output<typeof DictationAppInput>): Promise<DictationApps>;
    setText(input: z.output<typeof DictationTextInput>): Promise<DictationApps>;
  };
  readonly updates: {
    setAutomatic(input: z.output<typeof UpdatesAutomaticInput>): Promise<UpdatesStatus>;
    /** Asks GitHub now, whether or not the daily check is on. */
    check(): Promise<UpdatesStatus>;
    /** Installs a ready update as soon as nothing is cut, without waiting for an idle Mac. */
    install(): Promise<UpdatesStatus>;
    closeNote(): Promise<UpdatesStatus>;
  };
  /**
   * Corrections of a segment's text. Both throw `not-found` for a segment not
   * in the transcript `runId`, and `invalid-input` when that transcript was
   * replaced.
   */
  readonly transcript: {
    /** Says what the Vocabulary learned from the correction (ADR 046). */
    edit(input: z.output<typeof TranscriptEditInput>): Promise<TranscriptCorrectResult>;
    restore(input: z.output<typeof TranscriptRestoreInput>): Promise<TranscriptEditResult>;
  };
  /** ⌘Z and ⇧⌘Z over the edits made in the app this session (splits, merges, types, text, names). */
  readonly history: {
    undo(): Promise<UndoStep>;
    redo(): Promise<UndoStep>;
  };
  /**
   * Agents connected through MCP (ADR 011). `revoke` and `remove` throw
   * `ServiceFailure("not-found")` for an unknown agent; `remove` throws
   * `invalid-input` for one that still has access.
   */
  readonly agents: {
    status(): Promise<AgentsStatus>;
    /** Off closes every agent session at once; the tokens stay for when it is back on. */
    setEnabled(input: z.output<typeof AgentsEnabledInput>): Promise<AgentsStatus>;
    create(input: z.output<typeof AgentCreateInput>): Promise<AgentCreateResult>;
    /** Throws `not-found` for an app not found on this Mac, `invalid-input` without a relay. */
    connectApp(input: z.output<typeof AgentAppInput>): Promise<AgentAppConnectResult>;
    /**
     * Refuses the agent's next call, closes its sessions, and takes Sondine's
     * server back from the app files holding its key.
     */
    revoke(input: z.output<typeof AgentInput>): Promise<AgentRevokeResult>;
    remove(input: z.output<typeof AgentInput>): Promise<AgentsStatus>;
  };
  /**
   * Discussions with an agent (ADR 027). Off: `status` asks no CLI, `send`
   * throws `invalid-input`; `stop` and `remove` throw `not-found` for a
   * discussion that does not exist (any more).
   */
  readonly chat: {
    status(input: z.output<typeof ChatStatusInput>): Promise<ChatStatus>;
    /** Off ends every discussion and its processes at once. */
    setEnabled(input: z.output<typeof ChatEnabledInput>): Promise<ChatStatus>;
    watch(input: z.output<typeof ChatWatchInput>, signal?: AbortSignal): AsyncIterable<ChatView>;
    send(input: z.output<typeof ChatSendInput>): Promise<ChatSendResult>;
    stop(input: z.output<typeof ChatDiscussionInput>): Promise<Record<string, never>>;
    remove(input: z.output<typeof ChatDiscussionInput>): Promise<Record<string, never>>;
    setLimited(input: z.output<typeof ChatLimitInput>): Promise<Record<string, never>>;
  };
  /**
   * Model artifacts (ADR 016 "Models"). Starting what already runs, or what is
   * already installed, returns the current status. Every method but `status`
   * and `watch` throws `ServiceFailure("not-found")` for an artifact id the
   * catalog does not have.
   */
  readonly models: {
    status(): Promise<ModelsStatus>;
    /** Yields the current status at once, then on every change (progress at most 4 times a second) until `signal` aborts. */
    watch(signal: AbortSignal | undefined): AsyncIterable<ModelsStatus>;
    /** Imports `path`, or the found file; throws `ServiceFailure("not-found")` when neither exists. */
    import(input: z.output<typeof ModelImportInput>): Promise<ModelsStatus>;
    /** Asks main for an open panel limited to the artifact's extension, then imports the chosen file. */
    pick(input: z.output<typeof ModelInput>): Promise<ModelPickResult>;
    download(input: z.output<typeof ModelInput>): Promise<ModelsStatus>;
    /** Stops an import or a download; a download keeps its bytes for resume unless `discard`. */
    cancel(input: z.output<typeof ModelCancelInput>): Promise<ModelsStatus>;
  };
  /**
   * The user's voice read (ADR 034). Each returns the status after the
   * action; a refusal (recognition off, no microphone, a read already
   * running) shows as `session.phase` `failed` with its reason.
   */
  readonly voiceRead: {
    get(): Promise<VoiceReadStatus>;
    /** Yields the status at once, then on every change (the level about 10 times a second) until `signal` aborts. */
    watch(signal: AbortSignal | undefined): AsyncIterable<VoiceReadStatus>;
    start(input: z.output<typeof VoiceReadStartInput>): Promise<VoiceReadStatus>;
    finish(): Promise<VoiceReadStatus>;
    cancel(): Promise<VoiceReadStatus>;
    forget(): Promise<VoiceReadStatus>;
  };
  /** The first run (architecture §11). */
  readonly onboarding: {
    get(): Promise<OnboardingStatus>;
    advance(input: z.output<typeof OnboardingAdvanceInput>): Promise<OnboardingStatus>;
    /** Marks the first run done, once; with `startListening`, resumes listening. */
    complete(input: z.output<typeof OnboardingCompleteInput>): Promise<OnboardingCompleteResult>;
  };
  /** How the window shows things, kept in the settings table. */
  readonly display: {
    get(): Promise<DisplaySettings>;
    update(input: z.output<typeof DisplayUpdateInput>): Promise<DisplaySettings>;
  };
  /** Tags on recordings (ADR 039). */
  readonly tags: {
    list(): Promise<TagList>;
    /** `invalid-input` for an empty or long name, or a 21st tag; `not-found` for a missing episode. */
    set(input: z.output<typeof TagSetInput>): Promise<TagSetResult>;
    rename(input: z.output<typeof TagRenameInput>): Promise<TagRenameResult>;
    delete(input: z.output<typeof TagDeleteInput>): Promise<TagDeleteResult>;
  };
  /**
   * The Vocabulary (ADR 046). `add` and `update` throw `invalid-input` for a
   * word already in the list (without case or accents) or a full list;
   * `update` and `remove` throw `not-found` for a word gone.
   */
  readonly vocabulary: {
    list(): Promise<VocabularyList>;
    add(input: z.output<typeof VocabularyAddInput>): Promise<VocabularyEntry>;
    update(input: z.output<typeof VocabularyUpdateInput>): Promise<VocabularyEntry>;
    remove(input: z.output<typeof VocabularyRemoveInput>): Promise<Record<string, never>>;
  };
  readonly statistics: {
    get(): Promise<Statistics>;
    month(input: z.output<typeof StatisticsMonthInput>): Promise<StatisticsMonth>;
  };
  /** Anonymous statistics (ADR 042). */
  readonly usage: {
    get(): Promise<UsageStatus>;
    setSharing(input: z.output<typeof UsageSharingInput>): Promise<UsageStatus>;
    processCrashed(input: z.output<typeof UsageCrashInput>): Promise<Record<string, never>>;
  };
  /** A whole backup and its restore (ADR 048). */
  readonly backup: {
    status(): Promise<BackupStatus>;
    /** Yields the status at once, then on every change (progress at most 4 times a second). */
    watch(signal: AbortSignal | undefined): AsyncIterable<BackupStatus>;
    export(input: z.output<typeof BackupExportInput>): Promise<BackupExportResult>;
    choose(): Promise<BackupChooseResult>;
    inspect(input: z.output<typeof BackupPassphraseInput>): Promise<BackupInspectResult>;
    restore(input: z.output<typeof BackupPassphraseInput>): Promise<BackupRestoreResult>;
    cancel(): Promise<Record<string, never>>;
    deletePrevious(): Promise<BackupStatus>;
    closeNote(): Promise<BackupStatus>;
  };
  readonly diagnostics: {
    report(): Promise<DiagnosticReport>;
    health(input: z.output<typeof HealthInput>): Promise<HealthOutput>;
    spans(input: z.output<typeof SpansInput>): Promise<SpansOutput>;
  };
}

/**
 * What the router's middleware counts on (ADR 042). Core implements it: it
 * counts nothing without the user's yes.
 */
export interface UsageCounter {
  /** The consent a call begins under; null when nothing is counted. */
  begin(): number | null;
  /** Counted only if that consent still holds. */
  succeeded(begun: number, surface: UsageSurface, event: string): void;
  failed(begun: number, code: UsageError): void;
}

export interface ApiContext {
  readonly services: ApiServices;
  /** Who calls; absent for Sondine's own calls, which are not use. */
  readonly usage?: { readonly counter: UsageCounter; readonly surface: UsageSurface };
}
