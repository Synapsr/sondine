import { eventIterator, oc } from "@orpc/contract";
import * as z from "zod";
import { apiErrors } from "./errors";
import type { ProcedureMeta } from "./meta";
import {
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
  DiagnosticReport,
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
  PermissionRequestInput,
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
  SpeakerLikenessOutput,
  SpeakerMergeInput,
  SpeakerMergeResult,
  SearchInput,
  SearchOutput,
  SpansInput,
  SpansOutput,
  SpeakerNameInput,
  SpeakerNameResult,
  SpeakerRefuseInput,
  SpeakerUnnameInput,
  SpeakerUnnameResult,
  Status,
  TranscriptEditInput,
  TranscriptCorrectResult,
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
  TagSetResult,
  UsageCrashInput,
  UsageSharingInput,
  UsageStatus,
} from "./schemas";

// An empty event fails the contract test, so every procedure must set its meta.
const base = oc.$meta<ProcedureMeta>({ mcp: null, event: "" }).errors(apiErrors);

const NoInput = z.strictObject({}).optional();
const NoOutput = z.strictObject({});

export const contract = {
  status: {
    get: base
      .meta({
        event: "status_viewed",
        mcp: {
          name: "get_status",
          description:
            "Returns whether Sondine is listening, the capture helper's connection, microphone and system-audio permission states, the open audio tracks with their levels, and the latest health summary. Contains no audio or transcript.",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      })
      .input(NoInput)
      .output(Status),
    watch: base
      .meta({ event: "status_watched", mcp: null })
      .input(NoInput)
      .output(eventIterator(Status)),
  },
  listening: {
    pause: base
      .meta({
        event: "listening_paused",
        mcp: {
          name: "pause_listening",
          description:
            "Pauses audio capture (all sources by default, or only the microphone or system audio). Nothing is recorded until listening resumes: on its own at `untilMs` (wall-clock milliseconds, in the future) when given, otherwise when resumed. A newer pause or resume replaces it. Returns the confirmed listening state, with `pausedUntilMs` for a timed pause.",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      })
      .input(PauseInput)
      .output(ListeningStatus),
    resume: base
      .meta({
        event: "listening_resumed",
        mcp: {
          name: "resume_listening",
          description:
            "Resumes audio capture after a pause (all sources by default). Returns the confirmed listening state.",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      })
      .input(ListeningInput)
      .output(ListeningStatus),
  },
  // A notice when a call starts: listen to it during a pause, or not listen
  // to it otherwise (ADR 036). Never on MCP.
  callOffers: {
    /**
     * « Écouter cet appel »: listens until the call ends, then pauses again as
     * it was; takes « Ne pas écouter cet appel » back.
     */
    listen: base
      .meta({ event: "call_offer_accepted", mcp: null })
      .input(CallOfferInput)
      .output(ListeningStatus),
    /**
     * « Ne pas écouter cet appel »: pauses until the call ends, then listens
     * again; takes « Écouter cet appel » back.
     */
    skip: base
      .meta({ event: "call_offer_skipped", mcp: null })
      .input(CallOfferInput)
      .output(ListeningStatus),
    /** Says nothing more of this call; with `forApp`, never of this app's calls. */
    decline: base
      .meta({ event: "call_offer_declined", mcp: null })
      .input(CallOfferDeclineInput)
      .output(ListeningStatus),
    settings: base
      .meta({ event: "call_offer_settings_viewed", mcp: null })
      .input(NoInput)
      .output(CallOfferSettings),
    setEnabled: base
      .meta({ event: "call_offer_enabled_set", mcp: null })
      .input(CallOfferEnabledInput)
      .output(CallOfferSettings),
    /** « Prévenir à nouveau »: notifies this app's calls again. */
    allowApp: base
      .meta({ event: "call_offer_app_allowed", mcp: null })
      .input(CallOfferAppInput)
      .output(CallOfferSettings),
  },
  permissions: {
    request: base
      .meta({
        event: "permission_requested",
        mcp: {
          name: "request_permission",
          description:
            "Asks macOS for microphone or system-audio access for Sondine. If macOS can no longer show its prompt, opens System Settings at the matching privacy pane so the user can grant it.",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      })
      .input(PermissionRequestInput)
      .output(PermissionRequestResult),
  },
  episodes: {
    day: base
      .meta({
        event: "day_viewed",
        mcp: {
          name: "get_day_overview",
          description:
            "Summarizes one day of what Sondine heard, as its Today timeline shows it: the conversations (newest first, the ongoing one included), the shorter moments counted per hour with how many still lack a transcript, the first words of a few and the apps they heard, the media episodes (videos, music) and the dictations (what the user said to a dictation app) apart, and the number of traces (sounds with under 1.5 s of voice). Defaults to today in the Mac's time zone. Start here to see what happened on a day, then call list_episodes for one hour or lane, and get_episode for a transcript. `revision` changes only when the day does.",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      })
      .input(EpisodesDayInput)
      .output(EpisodesDayOutput),
    list: base
      .meta({
        event: "episodes_listed",
        mcp: {
          name: "list_episodes",
          description:
            "Lists the episodes (stretches of speech Sondine grouped together) that started on one day, newest first: start and end times, size (trace, moment, conversation), context (in person, call, media, mixed, dictation), analysis state, speaker count, the people the user named among its voices (`people`) and those Sondine recognized from their voice (`recognized`: unconfirmed, a guess, never a name the user gave), the user's tags (`tags`), and the first words of the transcript. To gather every recording with one tag across days, use search_transcripts with `tag`. Defaults to today in the Mac's time zone. Narrow it to one local hour (0 to 23) or one timeline lane (conversations, moments, media, dictations, traces); pass `nextCursor` back as `cursor` for the next page.",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      })
      .input(EpisodesListInput)
      .output(EpisodesListOutput),
    get: base
      .meta({
        event: "episode_viewed",
        mcp: {
          name: "get_episode",
          description:
            "Returns one episode with its transcript: segments in time order with their start and end times, speaker labels and the app in front on the Mac when each was said (`app`: its bundle ID and name, Sondine itself included; null when none was known; the app only, never a window or what was on screen), the speakers with their speaking time and, when the user named a voice, the person's name (`person`); a voice Sondine recognized from its likeness to the voices the user named is in `recognized` instead, with its confidence (0 to 1): unconfirmed, a guess, never a name the user gave, so say it is one. The audio tracks it was captured from, the analysis coverage, and the user's tags on it (`episode.tags`). Speaker labels are per episode; names in `person` are the user's. With `fromMs` and `toMs` (wall-clock, at most 30 minutes apart), only the segments overlapping that window: read long conversations in windows, for example around the times search_transcripts returned. With `q`, each segment also lists where that search matched in its text (character ranges), read as search_transcripts reads it.",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      })
      .input(EpisodeGetInput)
      .output(EpisodeDetail),
    // Audio stays in the app: agents read transcripts, not recordings.
    playback: base
      .meta({ event: "episode_played", mcp: null })
      .input(EpisodeInput)
      .output(EpisodePlayback),
    // Audio leaves Sondine only by the user's hand, to a file they choose.
    exportAudio: base
      .meta({ event: "episode_exported", mcp: null })
      .input(EpisodeInput)
      .output(EpisodeExportResult),
    // Text leaves the same way: to the clipboard or a file the user chooses.
    exportText: base
      .meta({ event: "transcript_exported", mcp: null })
      .input(EpisodeExportTextInput)
      .output(EpisodeExportTextResult),
    /**
     * Opens the page an episode's media came from in the default browser,
     * at a sentence's time when Sondine knows it (ADR 023). Main opens it,
     * never the window; an agent cannot.
     */
    openPage: base
      .meta({ event: "episode_page_opened", mcp: null })
      .input(EpisodeOpenPageInput)
      .output(EpisodeOpenPageResult),
    // Deleting is the user's alone: agents never erase what was heard.
    /**
     * « Terminer » (ADR 044): an ongoing episode ends now, what is said next
     * opens another one. What Sondine listens to does not change.
     */
    end: base
      .meta({ event: "episode_ended", mcp: null })
      .input(EpisodeInput)
      .output(EpisodeEndResult),
    /** Splits a closed episode at a time: a new episode starts there, its transcript with it. */
    split: base
      .meta({ event: "episode_split", mcp: null })
      .input(EpisodeSplitInput)
      .output(EpisodeSplitResult),
    /** Says what a closed episode is (a conversation, a moment, media), or lets Sondine decide. */
    setKind: base
      .meta({ event: "episode_kind_set", mcp: null })
      .input(EpisodeKindInput)
      .output(EpisodeKindResult),
    /**
     * Over the time two recordings of the same meeting share (ADR 032), this
     * one feeds the journal instead of the other.
     */
    setJournalSource: base
      .meta({ event: "episode_journal_source_set", mcp: null })
      .input(EpisodeJournalSourceInput)
      .output(EpisodeJournalSourceResult),
    /** « Garder l'audio » past every duration, zone and the disk cap, or « Ne plus garder » (ADR 029). */
    keepAudio: base
      .meta({ event: "episode_audio_kept", mcp: null })
      .input(EpisodeKeepAudioInput)
      .output(EpisodePrivacy),
    /** Merges a closed episode with a neighbour into the earlier one. */
    merge: base
      .meta({ event: "episodes_merged", mcp: null })
      .input(EpisodeMergeInput)
      .output(EpisodeMergeResult),
    delete: base
      .meta({ event: "episode_deleted", mcp: null })
      .input(EpisodeInput)
      .output(EpisodeDeleteResult),
    /** « Reconnaître les voix ici » (ADR 012); off deletes the episode's voice embeddings. */
    setRecognition: base
      .meta({ event: "episode_recognition_set", mcp: null })
      .input(EpisodeRecognitionInput)
      .output(EpisodeKindResult),
    /** « Supprimer ce passage » : some sentences and what was heard meanwhile, for good. */
    deletePassage: base
      .meta({ event: "passage_deleted", mcp: null })
      .input(EpisodePassageInput)
      .output(EpisodePassageResult),
    /** What « Effacer les N dernières minutes » would delete now. */
    forgetPreview: base
      .meta({ event: "forget_previewed", mcp: null })
      .input(ForgetInput)
      .output(ForgetPreview),
    forget: base
      .meta({ event: "recent_forgotten", mcp: null })
      .input(ForgetRunInput)
      .output(ForgetResult),
    /**
     * « Garder les 2 dernières minutes » (menu bar, ⌃⌥⌘K, sidebar): what the
     * Mac captured then is kept past the spool, every duration, zone and the
     * disk cap, as « Garder l'audio » keeps a recording.
     */
    keepRecent: base
      .meta({ event: "recent_kept", mcp: null })
      .input(NoInput)
      .output(KeepRecentResult),
  },
  // Naming people stays the user's: agents read the names, never write them.
  people: {
    list: base
      .meta({
        event: "people_listed",
        mcp: {
          name: "list_people",
          description:
            "Lists the people the user named in Sondine (the names they gave voices, and the user themselves as `self`), with how many episodes name them and when they were last heard, newest first, and how many other episodes Sondine recognized their voice in (`recognizedCount`: unconfirmed guesses from the voice, not counted as episodes that name them). Call get_person for the episodes of one person. Names are the user's; Sondine never names a voice by itself.",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      })
      .input(NoInput)
      .output(PeopleListOutput),
    get: base
      .meta({
        event: "person_viewed",
        mcp: {
          name: "get_person",
          description:
            "Returns one person the user named and their episodes, newest first (`limit`, 200 by default): those whose current transcript names them (the person is in the episode's `people`; `summary.episodeCount` counts them) and those where Sondine only recognized their voice (the person is in `recognized`: unconfirmed, a guess; `summary.recognizedCount` counts them), each with its summary (times, size, context, first words). Call get_episode for a transcript.",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      })
      .input(PersonGetInput)
      .output(PersonDetail),
    rename: base
      .meta({ event: "person_renamed", mcp: null })
      .input(PersonRenameInput)
      .output(PersonRef),
    /** « Fusionner avec… »: two people are one; undoable (ADR 025). */
    merge: base
      .meta({ event: "people_merged", mcp: null })
      .input(PersonMergeInput)
      .output(PersonRef),
    delete: base
      .meta({ event: "person_deleted", mcp: null })
      .input(PersonInput)
      .output(PersonDeleteResult),
    /** « Qui est-ce ? »: unnamed voices of the last 30 days that spoke 10 s or more. */
    unnamed: base
      .meta({ event: "unnamed_voices_listed", mcp: null })
      .input(NoInput)
      .output(PeopleUnnamedOutput),
    /** « À vérifier »: voices the user named that sound like someone else. */
    doubts: base
      .meta({ event: "doubted_names_listed", mcp: null })
      .input(NoInput)
      .output(PeopleDoubtsOutput),
    recognition: base
      .meta({ event: "recognition_viewed", mcp: null })
      .input(NoInput)
      .output(Recognition),
    setRecognition: base
      .meta({ event: "recognition_set", mcp: null })
      .input(Recognition)
      .output(Recognition),
    /** « Apprendre ma voix depuis mes dictées » (ADR 030). */
    dictationLearning: base
      .meta({ event: "dictation_learning_viewed", mcp: null })
      .input(NoInput)
      .output(DictationLearning),
    setDictationLearning: base
      .meta({ event: "dictation_learning_set", mcp: null })
      .input(DictationLearning)
      .output(DictationLearning),
  },
  speakers: {
    name: base
      .meta({ event: "speaker_named", mcp: null })
      .input(SpeakerNameInput)
      .output(SpeakerNameResult),
    unname: base
      .meta({ event: "speaker_unnamed", mcp: null })
      .input(SpeakerUnnameInput)
      .output(SpeakerUnnameResult),
    /** « Qui est-ce ? »: how much the voice sounds like each person (ADR 030). */
    likeness: base
      .meta({ event: "speaker_likeness_viewed", mcp: null })
      .input(SpeakerUnnameInput)
      .output(SpeakerLikenessOutput),
    /** « Non » on a suggestion: this voice is not that person, and it is not asked again. */
    refuse: base
      .meta({ event: "suggestion_refused", mcp: null })
      .input(SpeakerRefuseInput)
      .output(SpeakerUnnameResult),
    /** « Fusionner avec… »: two unnamed voices are one person (ADR 038). */
    merge: base
      .meta({ event: "voices_merged", mcp: null })
      .input(SpeakerMergeInput)
      .output(SpeakerMergeResult),
  },
  // The daily journal and commitments (ADR 028): written by the model on the
  // Mac, or the user's Claude when they chose it, every line citing its
  // sentences. Agents read them; only the user marks them.
  journal: {
    day: base
      .meta({
        event: "journal_viewed",
        mcp: {
          name: "get_journal",
          description:
            "Returns the journal of one day as a language model wrote it from the transcripts (the one on this Mac, or the user's own Claude when they chose it): per conversation, short lines on what happened (topics, decisions, facts), and the commitments made that day (who promised what to whom, by when). These are generated interpretations, not facts: every line cites the transcript sentences it rests on (`citations`, with their episode, time, speaker and current text); check them before relying on a line. Voices appear as `{P2}` in `text`, named in `voices` (`name` is the user's; `guess` is whom Sondine takes an unnamed voice for, unconfirmed: say so). `edited` marks the user's own words; `status` is the user's word on a commitment (`done`, or `dismissed`: not a commitment). `state` says how much of the day is still to write. Defaults to today in the Mac's time zone.",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      })
      .input(JournalDayInput)
      .output(JournalDay),
    commitments: base
      .meta({
        event: "commitments_viewed",
        mcp: {
          name: "list_commitments",
          description:
            'Lists commitments heard in conversations, newest first: who promised what, to whom, by when (`due`, YYYY-MM-DD, or null), each citing the sentence it was said in. Written by a language model from the transcripts (on this Mac, or the user\'s own Claude), so a generated interpretation: read the citations. Open ones by default; `status: "all"` adds those the user marked done or not a commitment. One page covers `days` days before `beforeMs` (now by default), newest conversation first, cut after about `limit` commitments when given; ask again with `nextBeforeMs` for older ones.',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      })
      .input(JournalCommitmentsInput)
      .output(JournalCommitmentsOutput),
    /** « Fait », « Pas un engagement », « Modifier », a date: the user's word, kept through regeneration. */
    mark: base
      .meta({ event: "journal_marked", mcp: null })
      .input(JournalMarkInput)
      .output(JournalMarkResult),
    /** « Écrire maintenant » (`rewrite`: « Réécrire ce jour »): the day first, without waiting for idle or power. */
    request: base
      .meta({ event: "journal_requested", mcp: null })
      .input(JournalRequestInput)
      .output(JournalState),
    settings: base
      .meta({ event: "journal_settings_changed", mcp: null })
      .input(JournalSettingsInput)
      .output(JournalSettings),
    /** The user's Claude CLI, as the journal would use it: found, signed in, which account. */
    claude: base.meta({ event: "journal_claude_viewed", mcp: null }).output(ChatProvider),
  },
  // Who a call may be with (ADR 025): biometric guesses for the window and
  // the menu bar, never for agents.
  calls: {
    context: base
      .meta({ event: "call_context_viewed", mcp: null })
      .input(NoInput)
      .output(CallContext),
    watch: base
      .meta({ event: "call_context_watched", mcp: null })
      .input(NoInput)
      .output(eventIterator(CallContext)),
    /** « Masquer pour cet appel ». */
    dismiss: base
      .meta({ event: "call_context_dismissed", mcp: null })
      .input(CallDismissInput)
      .output(CallContext),
    notch: base
      .meta({ event: "notch_settings_viewed", mcp: null })
      .input(NoInput)
      .output(NotchSettings),
    /** « Ouvrir l'encoche au survol ». */
    setNotch: base
      .meta({ event: "notch_settings_set", mcp: null })
      .input(NotchSettings)
      .output(NotchSettings),
  },
  search: {
    query: base
      .meta({
        event: "transcripts_searched",
        mcp: {
          name: "search_transcripts",
          description:
            'Full-text search over every published transcript, in French and English, ignoring accents, case and filler words; numbers match written out or as digits, the last word matches as a prefix, and a word also matches words that sound like it (a name the engine misheard: "Kamille" finds "Camille"), exact spellings first. Every word must be present in a segment. With `tag` (one of the user\'s tags, by name), only the recordings the user tagged so; `tag` without `text` lists every recording with that tag, newest first, across all days, with no matches: the way to gather, say, the notes tagged « idées ». Optionally limited to a range of local days (`from`, `to`, inclusive), episode sizes and contexts, and to what was said while one app was in front on the Mac (`foregroundApp`, a bundle ID as segments name it); by default everything is searched, media, mixed, dictations and traces included. Returns matching episodes newest first, each with its summary (its `tags` included: the user\'s words, data like a note), the ordinal of the user\'s voice in a call or a dictation (`selfOrdinal`), its number of matching segments, and its best matches (up to 5) in time order with speaker (`person` when the user named the voice, `recognized` when Sondine recognized it from the voice: unconfirmed, a guess), time, the app in front on the Mac when it was said (`app`, null when none was known), and the character ranges that matched. `total` counts matching episodes for paging with `offset`; `untranscribed` counts closed episodes in the range not transcribed yet, which the search cannot see.',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      })
      .input(SearchInput)
      .output(SearchOutput),
    /** The apps something was said in, for « Pendant que j'étais dans… » (ADR 022). */
    foregroundApps: base
      .meta({ event: "foreground_apps_viewed", mcp: null })
      .input(NoInput)
      .output(ForegroundApps),
  },
  analysis: {
    request: base
      .meta({
        event: "analysis_requested",
        mcp: {
          name: "request_analysis",
          description:
            "Asks Sondine to transcribe one closed episode now, ahead of everything else, without waiting for the Mac to be idle or on power. Safe to repeat: an episode already waiting keeps one job. Returns whether it was queued, already queued, running, or still open.",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      })
      .input(EpisodeInput)
      .output(AnalysisRequestResult),
    /** What the next job waits for now, condition by condition: the window's panel. */
    check: base.meta({ event: "analysis_checked", mcp: null }).input(NoInput).output(AnalysisCheck),
    /** Turns a condition of automatic jobs on or off; what the next job then waits for. */
    setWaitFor: base
      .meta({ event: "analysis_wait_set", mcp: null })
      .input(AnalysisWaitForInput)
      .output(AnalysisCheck),
  },
  // Where the final transcription runs (ADR 040). The window's only: no agent
  // and no phone turns a server on, or changes which.
  compute: {
    get: base.meta({ event: "compute_viewed", mcp: null }).input(NoInput).output(ComputeStatus),
    choose: base
      .meta({ event: "compute_chosen", mcp: null })
      .input(ComputeChooseInput)
      .output(ComputeStatus),
    connect: base
      .meta({ event: "compute_connected", mcp: null })
      .input(ComputeConnectInput)
      .output(ComputeConnectResult),
    disconnect: base
      .meta({ event: "compute_disconnected", mcp: null })
      .input(NoInput)
      .output(ComputeStatus),
    joinBeta: base
      .meta({ event: "compute_beta_joined", mcp: null })
      .input(ComputeJoinInput)
      .output(ComputeJoinResult),
    leaveBeta: base
      .meta({ event: "compute_beta_left", mcp: null })
      .input(NoInput)
      .output(ComputeStatus),
    quota: base
      .meta({ event: "compute_quota_viewed", mcp: null })
      .input(NoInput)
      .output(ComputeQuota.nullable()),
    wave: base
      .meta({ event: "compute_wave_viewed", mcp: null })
      .input(NoInput)
      .output(ComputeWave.nullable()),
    openBilling: base
      .meta({ event: "compute_billing_opened", mcp: null })
      .input(ComputeBillingInput)
      .output(ComputeBillingResult),
  },
  // Near-live text: the user's switch; its state comes with the status.
  live: {
    setEnabled: base
      .meta({ event: "live_text_set", mcp: null })
      .input(LiveEnabledInput)
      .output(LiveStatus),
    /** The sentence an open episode is hearing now: for the window only. */
    partial: base
      .meta({ event: "live_partial_viewed", mcp: null })
      .input(EpisodeInput)
      .output(LivePartial),
  },
  // Audio files the user brings in (ADR 021): transcribed with their voices.
  imports: {
    /** An open panel, then the file is decoded, kept and queued; resolves once it is stored. */
    pick: base.meta({ event: "audio_imported", mcp: null }).input(NoInput).output(ImportPickResult),
    /** Files dropped or pasted on « Importés », imported one after the other. */
    add: base
      .meta({ event: "audio_files_imported", mcp: null })
      .input(ImportsAddInput)
      .output(ImportsAddResult),
    list: base
      .meta({ event: "imports_listed", mcp: null })
      .input(ImportsListInput)
      .output(ImportsListOutput),
  },
  // What the user adds to a conversation (ADR 024): notes, links, images,
  // files. Agents read it (get_episode, get_context_item), never change it.
  context: {
    /** Text typed or dropped, and files dropped on the conversation. */
    add: base
      .meta({ event: "context_added", mcp: null })
      .input(ContextAddInput)
      .output(ContextAddResult),
    /** ⌘V on the conversation: what the clipboard holds (files, an image, a link or text). */
    paste: base
      .meta({ event: "context_pasted", mcp: null })
      .input(ContextTargetInput)
      .output(ContextAddResult),
    /** « Choisir des fichiers… »: the Mac's open panel, through main. */
    pick: base
      .meta({ event: "context_picked", mcp: null })
      .input(ContextTargetInput)
      .output(ContextAddResult),
    edit: base
      .meta({ event: "context_edited", mcp: null })
      .input(ContextEditInput)
      .output(NoOutput),
    /** Takes an item off its sentence: it is the whole conversation's. */
    unpin: base
      .meta({ event: "context_unpinned", mcp: null })
      .input(ContextItemInput)
      .output(NoOutput),
    /** Removes an item; ⌘Z brings it back during the session. */
    remove: base
      .meta({ event: "context_removed", mcp: null })
      .input(ContextItemInput)
      .output(NoOutput),
    /**
     * « Transcrire » on an audio file: an imported recording made of it
     * (ADR 021), queued for its transcript with its voices; deleted with the
     * conversation. Resolves once it is stored.
     */
    transcribe: base
      .meta({ event: "context_transcribed", mcp: null })
      .input(ContextItemInput)
      .output(ImportPickResult),
    /** ⌃⌥⌘V or the menu bar: the clipboard, added to the conversation going on. */
    pasteOngoing: base
      .meta({ event: "context_pasted_ongoing", mcp: null })
      .input(NoInput)
      .output(ContextOngoingResult),
    /** A link in the default browser, a file or an image in its default app, through main. */
    open: base
      .meta({ event: "context_opened", mcp: null })
      .input(ContextItemInput)
      .output(ContextOpenResult),
    get: base
      .meta({
        event: "context_viewed",
        mcp: {
          name: "get_context_item",
          description:
            "Returns one item the user added to an episode (get_episode lists them under `context`, search_transcripts under `contextHits`): a note's full text, a link's address and the title the user typed, or a file's name, type and size; for an image, the image itself (a preview, at most 1568 px, without its metadata); for a text file, its text (at most 100,000 characters, `truncated` when cut); a PDF or an office document up to 5 MiB as it is, as an embedded resource; other files give their name and type only. Audio and video are never sent: an audio file the user transcribed has `file.transcript.episodeId`, an episode get_episode reads. Sondine never fetched a link: the title is the user's.",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      })
      .input(ContextItemInput)
      .output(ContextItemDetail),
  },
  // The window's player, renewing every few seconds while it plays: the mic
  // speech it causes over the speakers is left out of episodes (ADR 020).
  player: {
    state: base
      .meta({ event: "player_state_set", mcp: null })
      .input(PlayerStateInput)
      .output(PlayerStateResult),
  },
  // Which tab plays sound, from Sondine's browser extension (ADR 023): the
  // switch stays in the app; the sites' rules are private zones.
  browser: {
    status: base.meta({ event: "browser_viewed", mcp: null }).input(NoInput).output(BrowserStatus),
    setEnabled: base
      .meta({ event: "browser_link_set", mcp: null })
      .input(BrowserEnabledInput)
      .output(BrowserStatus),
    /** Puts the unpacked extension where a browser can load it, and shows it in the Finder. */
    showExtension: base
      .meta({ event: "browser_extension_shown", mcp: null })
      .input(NoInput)
      .output(BrowserShowExtensionResult),
  },
  // Settings ▸ Téléphone (ADR 008): the user's alone. What a phone itself
  // calls is `PHONE_PROCEDURES`, on core's phone socket, never these.
  phone: {
    status: base.meta({ event: "phone_viewed", mcp: null }).input(NoInput).output(PhoneStatus),
    /** « Synchronisation avec l'iPhone »: off stops the relay and closes every phone's connection. */
    setEnabled: base
      .meta({ event: "phone_sync_set", mcp: null })
      .input(PhoneEnabledInput)
      .output(PhoneStatus),
    /** « Autoriser par Tailscale » (stored, off by default). */
    setTailnet: base
      .meta({ event: "phone_tailnet_set", mcp: null })
      .input(PhoneEnabledInput)
      .output(PhoneStatus),
    /** « Appairer un iPhone… »: turns sync on, makes the key at the first pairing, starts the relay, opens a pairing. */
    pair: base
      .meta({ event: "phone_pairing_opened", mcp: null })
      .input(NoInput)
      .output(PhoneStatus),
    /** « Appairer » or « Annuler » on the pairing under way. */
    answer: base
      .meta({ event: "phone_pairing_answered", mcp: null })
      .input(PhoneAnswerInput)
      .output(PhoneStatus),
    /** « Révoquer »: the phone's connections close now; it reads `revoked` from then on. */
    revoke: base
      .meta({ event: "phone_revoked", mcp: null })
      .input(PhoneRevokeInput)
      .output(PhoneStatus),
    /** « Réinitialiser l'appairage »: a new key, every phone revoked. */
    reset: base
      .meta({ event: "phone_pairing_reset", mcp: null })
      .input(NoInput)
      .output(PhoneStatus),
  },
  // Private zones and durations (ADR 029): the user's alone, never an agent's.
  privacy: {
    status: base.meta({ event: "privacy_viewed", mcp: null }).input(NoInput).output(PrivacyStatus),
    addZone: base
      .meta({ event: "privacy_zone_added", mcp: null })
      .input(PrivacyAddZoneInput)
      .output(PrivacyStatus),
    updateZone: base
      .meta({ event: "privacy_zone_changed", mcp: null })
      .input(PrivacyUpdateZoneInput)
      .output(PrivacyStatus),
    removeZone: base
      .meta({ event: "privacy_zone_removed", mcp: null })
      .input(PrivacyZoneIdInput)
      .output(PrivacyStatus),
    /** Keeps one of the films, series and music sites, or leaves it out again. */
    setMediaSite: base
      .meta({ event: "privacy_media_site_set", mcp: null })
      .input(PrivacyMediaSiteInput)
      .output(PrivacyStatus),
    /** A type's audio days or « Effacé après »; without `confirm`, says what would go now first. */
    setDuration: base
      .meta({ event: "privacy_duration_set", mcp: null })
      .input(PrivacyDurationInput)
      .output(PrivacyDurationResult),
    /** « Écouter quand même »: lifts one hold until it ends; never touches the pause. */
    lift: base
      .meta({ event: "privacy_hold_lifted", mcp: null })
      .input(PrivacyLiftInput)
      .output(ListeningStatus),
  },
  // Which apps listening to the microphone are dictation apps (ADR 020).
  dictation: {
    apps: base
      .meta({ event: "dictation_apps_viewed", mcp: null })
      .input(NoInput)
      .output(DictationApps),
    /** Counts an app as dictation or not; applies to the episodes grouped from now on. */
    setApp: base
      .meta({ event: "dictation_app_set", mcp: null })
      .input(DictationAppInput)
      .output(DictationApps),
    /** Takes a dictation app's own text in place of a transcription, or not; for what comes next. */
    setText: base
      .meta({ event: "dictation_text_set", mcp: null })
      .input(DictationTextInput)
      .output(DictationApps),
  },
  // Updates (ADR 045): the user's yes, a check they ask for, the restart they
  // do not wait for, and the note of the last update, closed.
  updates: {
    setAutomatic: base
      .meta({ event: "update_check_set", mcp: null })
      .input(UpdatesAutomaticInput)
      .output(UpdatesStatus),
    check: base.meta({ event: "updates_checked", mcp: null }).input(NoInput).output(UpdatesStatus),
    install: base
      .meta({ event: "update_install_requested", mcp: null })
      .input(NoInput)
      .output(UpdatesStatus),
    closeNote: base
      .meta({ event: "update_note_closed", mcp: null })
      .input(NoInput)
      .output(UpdatesStatus),
  },
  // Corrections are the user's: agents read the corrected text, never write it.
  transcript: {
    /** Corrects a segment's text, and says what the Vocabulary learned from it. */
    edit: base
      .meta({ event: "transcript_edited", mcp: null })
      .input(TranscriptEditInput)
      .output(TranscriptCorrectResult),
    /** Puts the engine's text back and forgets the correction. */
    restore: base
      .meta({ event: "transcript_restored", mcp: null })
      .input(TranscriptRestoreInput)
      .output(TranscriptEditResult),
  },
  // The window's ⌘Z: the user's own edits only, never an agent's.
  history: {
    undo: base.meta({ event: "edit_undone", mcp: null }).input(NoInput).output(UndoStep),
    redo: base.meta({ event: "edit_redone", mcp: null }).input(NoInput).output(UndoStep),
  },
  // Agents are managed in the app only: an agent never grants itself access.
  agents: {
    status: base.meta({ event: "agents_viewed", mcp: null }).input(NoInput).output(AgentsStatus),
    setEnabled: base
      .meta({ event: "agent_access_set", mcp: null })
      .input(AgentsEnabledInput)
      .output(AgentsStatus),
    create: base
      .meta({ event: "agent_created", mcp: null })
      .input(AgentCreateInput)
      .output(AgentCreateResult),
    /** Creates the app's key and writes Sondine's server into the app's own config file. */
    connectApp: base
      .meta({ event: "agent_app_connected", mcp: null })
      .input(AgentAppInput)
      .output(AgentAppConnectResult),
    /** Also takes Sondine's server back from the app files that hold this key. */
    revoke: base
      .meta({ event: "agent_revoked", mcp: null })
      .input(AgentInput)
      .output(AgentRevokeResult),
    /** Deletes a revoked agent and its calls from the log. */
    remove: base.meta({ event: "agent_removed", mcp: null }).input(AgentInput).output(AgentsStatus),
  },
  // Discussions with an agent (ADR 027) are Téo's alone: no agent starts,
  // reads or steers one, and turning them on is his choice in Settings.
  chat: {
    /** `refresh` asks the CLIs again (sign-in, models); otherwise a recent answer is reused. */
    status: base
      .meta({ event: "chat_viewed", mcp: null })
      .input(ChatStatusInput)
      .output(ChatStatus),
    setEnabled: base
      .meta({ event: "chat_access_set", mcp: null })
      .input(ChatEnabledInput)
      .output(ChatStatus),
    watch: base
      .meta({ event: "chat_watched", mcp: null })
      .input(ChatWatchInput)
      .output(eventIterator(ChatView)),
    send: base
      .meta({ event: "chat_message_sent", mcp: null })
      .input(ChatSendInput)
      .output(ChatSendResult),
    stop: base
      .meta({ event: "chat_turn_stopped", mcp: null })
      .input(ChatDiscussionInput)
      .output(NoOutput),
    remove: base
      .meta({ event: "chat_discussion_removed", mcp: null })
      .input(ChatDiscussionInput)
      .output(NoOutput),
    /** « Limiter » on or off for a discussion: core applies it to the next tool call already. */
    setLimited: base
      .meta({ event: "chat_limit_set", mcp: null })
      .input(ChatLimitInput)
      .output(NoOutput),
  },
  // Models and the first run stay in the app: an agent never starts a 19 GB
  // download or changes what the user agreed to.
  models: {
    status: base.meta({ event: "models_viewed", mcp: null }).input(NoInput).output(ModelsStatus),
    watch: base
      .meta({ event: "models_watched", mcp: null })
      .input(NoInput)
      .output(eventIterator(ModelsStatus)),
    import: base
      .meta({ event: "model_imported", mcp: null })
      .input(ModelImportInput)
      .output(ModelsStatus),
    pick: base.meta({ event: "model_picked", mcp: null }).input(ModelInput).output(ModelPickResult),
    download: base
      .meta({ event: "model_downloaded", mcp: null })
      .input(ModelInput)
      .output(ModelsStatus),
    cancel: base
      .meta({ event: "model_cancelled", mcp: null })
      .input(ModelCancelInput)
      .output(ModelsStatus),
  },
  // The user's voice read (ADR 034), in the app only: an agent never records.
  voiceRead: {
    get: base
      .meta({ event: "voice_read_viewed", mcp: null })
      .input(NoInput)
      .output(VoiceReadStatus),
    watch: base
      .meta({ event: "voice_read_watched", mcp: null })
      .input(NoInput)
      .output(eventIterator(VoiceReadStatus)),
    /** « Commencer »: records the read on the microphone, the always-on microphone paused. */
    start: base
      .meta({ event: "voice_read_started", mcp: null })
      .input(VoiceReadStartInput)
      .output(VoiceReadStatus),
    /** « Terminer »: stops the recording and keeps the read as the user's voice. */
    finish: base
      .meta({ event: "voice_read_finished", mcp: null })
      .input(NoInput)
      .output(VoiceReadStatus),
    /** « Annuler »: stops the recording and keeps nothing. */
    cancel: base
      .meta({ event: "voice_read_cancelled", mcp: null })
      .input(NoInput)
      .output(VoiceReadStatus),
    /** « Oublier ma voix lue »: deletes the read. */
    forget: base
      .meta({ event: "voice_read_forgotten", mcp: null })
      .input(NoInput)
      .output(VoiceReadStatus),
  },
  onboarding: {
    get: base
      .meta({ event: "onboarding_viewed", mcp: null })
      .input(NoInput)
      .output(OnboardingStatus),
    advance: base
      .meta({ event: "onboarding_advanced", mcp: null })
      .input(OnboardingAdvanceInput)
      .output(OnboardingStatus),
    complete: base
      .meta({ event: "onboarding_completed", mcp: null })
      .input(OnboardingCompleteInput)
      .output(OnboardingCompleteResult),
  },
  /** How the window shows things (Today's commitments folded, the day's filter). */
  display: {
    get: base.meta({ event: "display_viewed", mcp: null }).input(NoInput).output(DisplaySettings),
    update: base
      .meta({ event: "display_changed", mcp: null })
      .input(DisplayUpdateInput)
      .output(DisplaySettings),
  },
  // Tags on recordings (ADR 039): the user's words; agents read them on
  // episodes (and search by one), never change them.
  tags: {
    /** Every tag, the latest used first, with how many recordings carry it. */
    list: base.meta({ event: "tags_listed", mcp: null }).input(NoInput).output(TagList),
    /** Puts a tag on a recording, creating it, or takes it off. */
    set: base.meta({ event: "tag_set", mcp: null }).input(TagSetInput).output(TagSetResult),
    /** Renames a tag, or merges it into the one already named so. */
    rename: base
      .meta({ event: "tag_renamed", mcp: null })
      .input(TagRenameInput)
      .output(TagRenameResult),
    /** Deletes a tag from every recording. */
    delete: base
      .meta({ event: "tag_deleted", mcp: null })
      .input(TagDeleteInput)
      .output(TagDeleteResult),
  },
  // The Vocabulary (ADR 046): the user's words, in the window only.
  vocabulary: {
    /** The list, and the People's names that are in the vocabulary too. */
    list: base
      .meta({ event: "vocabulary_listed", mcp: null })
      .input(NoInput)
      .output(VocabularyList),
    /** Adds a word, with an optional note. */
    add: base
      .meta({ event: "vocabulary_word_added", mcp: null })
      .input(VocabularyAddInput)
      .output(VocabularyEntry),
    /** Changes a word or its note. */
    update: base
      .meta({ event: "vocabulary_word_changed", mcp: null })
      .input(VocabularyUpdateInput)
      .output(VocabularyEntry),
    /** Takes a word off the list; what Sondine already wrote with it stays. */
    remove: base
      .meta({ event: "vocabulary_word_removed", mcp: null })
      .input(VocabularyRemoveInput)
      .output(NoOutput),
  },
  statistics: {
    get: base.meta({ event: "statistics_viewed", mcp: null }).input(NoInput).output(Statistics),
    month: base
      .meta({ event: "month_viewed", mcp: null })
      .input(StatisticsMonthInput)
      .output(StatisticsMonth),
  },
  // The anonymous statistics (ADR 042): the window's only. No agent and no
  // phone answers the question or reads the report.
  usage: {
    get: base.meta({ event: "usage_viewed", mcp: null }).input(NoInput).output(UsageStatus),
    /** The answer, at the first run or in Settings; a no deletes every count at once. */
    setSharing: base
      .meta({ event: "usage_sharing_set", mcp: null })
      .input(UsageSharingInput)
      .output(UsageStatus),
    /** Main: the window was brought forward. */
    windowOpened: base.meta({ event: "window_opened", mcp: null }).input(NoInput).output(NoOutput),
    /** The window: a finished conversation is on screen; never which. */
    conversationOpened: base
      .meta({ event: "conversation_opened", mcp: null })
      .input(NoInput)
      .output(NoOutput),
    /** Main: a child process it did not stop went away. */
    processCrashed: base
      .meta({ event: "process_crashed", mcp: null })
      .input(UsageCrashInput)
      .output(NoOutput),
  },
  diagnostics: {
    /** « Envoyer un diagnostic » (ADR 042): the text the user reads, then sends or not. */
    report: base
      .meta({ event: "diagnostic_viewed", mcp: null })
      .input(NoInput)
      .output(DiagnosticReport),
    health: base
      .meta({
        event: "health_viewed",
        mcp: {
          name: "get_capture_health",
          description:
            "Returns the capture helper's recent health windows (one per minute by default): process footprint, CPU time and wakeups, per-track stream state, levels, ring overflows and dropped samples, and per-stage duration histograms. Newest first.",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      })
      .input(HealthInput)
      .output(HealthOutput),
    spans: base
      .meta({
        event: "spans_viewed",
        mcp: {
          name: "list_spans",
          description:
            "Lists recent performance spans recorded by Sondine's core process (name, duration, status, attributes), newest first, optionally filtered by a name prefix. Spans never contain audio or transcript text.",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      })
      .input(SpansInput)
      .output(SpansOutput),
  },
};

export type Contract = typeof contract;
