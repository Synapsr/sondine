// Every status column is a CHECK enum built from one of these lists, so the
// TypeScript union and the SQL constraint cannot drift apart.

export const trackSourceKinds = ["input", "app", "system", "phone"] as const;
export const trackRunStates = ["open", "closed", "sealed"] as const;
export const trackRunEndReasons = [
  "stopped",
  "paused",
  "device_lost",
  "device_changed",
  "format_changed",
  "sleep",
  "released",
  "helper_exit",
  "recovered",
  "permission_revoked",
] as const;
export const deviceTransports = [
  "built_in",
  "usb",
  "thunderbolt",
  "pci",
  "bluetooth",
  "bluetooth_le",
  "airplay",
  "hdmi",
  "display_port",
  "continuity",
  "virtual",
  "aggregate",
  "unknown",
] as const;
export const processEvidence = ["responsibility", "ancestry", "path", "daemon_map"] as const;
export const epochReasons = [
  "run_start",
  "device_change",
  "rate_change",
  "wake",
  "daemon_restart",
  "discontinuity",
] as const;
export const spoolFileStates = ["open", "closed", "expired", "deleted"] as const;
export const audioStates = ["present", "archived", "expired", "deleted"] as const;
/** What kept a `kept_audio` range: « Garder l'audio » on a recording, or « Garder les 2 dernières minutes ». */
export const keptAudioOrigins = ["recording", "moment"] as const;
export const speechRegionStates = ["open", "closed"] as const;
export const speechRegionEndReasons = [
  "silence",
  "max_length",
  "track_closed",
  "recovery",
  "deleted",
] as const;
export const gapReasons = [
  "helper_exit",
  "core_exit",
  "power_loss",
  "disk_full",
  "write_error",
  "permission_revoked",
  "device_lost",
  "ring_overflow",
  "sleep",
  "paused",
  "recovery_truncated",
] as const;

/** How the helper knew a call: a call app, a call daemon, or a browser using a microphone. */
export const callVias = ["call_app", "call_daemon", "browser"] as const;
/** `ended`: the helper said so. `lost`: no snapshot vouched for it any more (see `calls`). */
export const callEndReasons = ["ended", "lost"] as const;
/** How an app other than a call listened: as itself, or as the system's speech recognition. */
export const listenVias = ["app", "speech"] as const;
/** Where Sondine's own playback went: the room hears speakers, not headphones. */
export const playbackRoutes = ["speakers", "headphones"] as const;
/**
 * What a mic region heard during a playback on the speakers (ADR 035):
 * Sondine's echo, someone in the room, or too little reference to tell.
 */
export const selfEchoVerdicts = ["echo", "near_end", "no_reference"] as const;

/** What a private zone keeps (ADR 029): nothing, the text alone, the audio alone, or all for a while. */
export const zoneOutcomes = [
  "nothing",
  "text_only",
  "audio_only",
  "delete_week",
  "delete_day",
] as const;
/** A situation the helper reports (ADR 029): the screen away, or the Mac on a network. */
export const situationKinds = ["screen_away", "network"] as const;

export const episodeStates = ["open", "closed"] as const;
export const episodeContexts = [
  "call",
  "in_person",
  "media",
  "mixed",
  "dictation",
  "imported",
] as const;
export const episodeSizes = ["trace", "moment", "conversation"] as const;
export const classificationStates = ["provisional", "final"] as const;
export const analysisStates = [
  "pending",
  "queued",
  "running",
  "complete",
  "failed",
  "stale",
] as const;

export const analysisStages = ["asr", "asr_live", "align", "diarize", "embed_speaker"] as const;
export const analysisRunStatuses = [
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "published",
  "discarded",
  "superseded",
] as const;
export const adapterClasses = ["product", "probe"] as const;

export const assertionKinds = [
  "transcript_edit",
  "force_boundary",
  "forbid_boundary",
  "size_override",
  "context_override",
  "speaker_is",
  "speaker_is_not",
] as const;
export const assertionOrigins = ["app", "tray", "agent", "phone"] as const;
export const deletedRangeScopes = ["all", "track_run"] as const;

/** What the user added to a conversation (ADR 024). */
export const contextKinds = ["note", "link", "image", "file"] as const;
/** The format of an image's preview. */
export const contextPreviews = ["jpeg", "png"] as const;

export const jobKinds = [
  "analysis",
  "live_analysis",
  "retention",
  "deletion",
  "maintenance",
] as const;
export const jobStates = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export const jobAttemptOutcomes = [
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "abandoned",
] as const;

export const identityRuleScopes = ["global", "app", "device", "episode"] as const;

/** The daily journal (ADR 028): a line of what happened, or a commitment. */
export const journalItemKinds = ["event", "commitment"] as const;
/** A journal pass over one episode: `cancelled` and `abandoned` are not failures. */
export const journalRunStatuses = [
  "running",
  "published",
  "failed",
  "cancelled",
  "abandoned",
] as const;
/** The user's word on an item: a line `dismissed` is wrong; a commitment is open, done or not one. */
export const journalMarkStatuses = ["open", "done", "dismissed"] as const;

export type TrackSourceKind = (typeof trackSourceKinds)[number];
export type TrackRunState = (typeof trackRunStates)[number];
export type TrackRunEndReason = (typeof trackRunEndReasons)[number];
export type DeviceTransport = (typeof deviceTransports)[number];
export type ProcessEvidence = (typeof processEvidence)[number];
export type EpochReason = (typeof epochReasons)[number];
export type SpoolFileState = (typeof spoolFileStates)[number];
export type AudioState = (typeof audioStates)[number];
export type SpeechRegionState = (typeof speechRegionStates)[number];
export type SpeechRegionEndReason = (typeof speechRegionEndReasons)[number];
export type GapReason = (typeof gapReasons)[number];
export type CallVia = (typeof callVias)[number];
export type CallEndReason = (typeof callEndReasons)[number];
export type ListenVia = (typeof listenVias)[number];
export type PlaybackRoute = (typeof playbackRoutes)[number];
export type SelfEchoVerdict = (typeof selfEchoVerdicts)[number];
export type EpisodeState = (typeof episodeStates)[number];
export type EpisodeContext = (typeof episodeContexts)[number];
export type EpisodeSize = (typeof episodeSizes)[number];
export type ClassificationState = (typeof classificationStates)[number];
export type AnalysisState = (typeof analysisStates)[number];
export type AnalysisStage = (typeof analysisStages)[number];
export type AnalysisRunStatus = (typeof analysisRunStatuses)[number];
export type AdapterClass = (typeof adapterClasses)[number];
export type AssertionKind = (typeof assertionKinds)[number];
export type ZoneOutcome = (typeof zoneOutcomes)[number];
export type SituationKind = (typeof situationKinds)[number];
export type AssertionOrigin = (typeof assertionOrigins)[number];
export type DeletedRangeScope = (typeof deletedRangeScopes)[number];
export type ContextKind = (typeof contextKinds)[number];
export type ContextPreview = (typeof contextPreviews)[number];
export type JobKind = (typeof jobKinds)[number];
export type JobState = (typeof jobStates)[number];
export type JobAttemptOutcome = (typeof jobAttemptOutcomes)[number];
export type IdentityRuleScope = (typeof identityRuleScopes)[number];
export type JournalItemKind = (typeof journalItemKinds)[number];
export type JournalRunStatus = (typeof journalRunStatuses)[number];
export type JournalMarkStatus = (typeof journalMarkStatuses)[number];

/** How an agent's tool call ended: answered, failed, or refused (revoked, access off). */
export const agentCallOutcomes = ["ok", "error", "refused"] as const;
export type AgentCallOutcome = (typeof agentCallOutcomes)[number];

/** Who wrote a message of a discussion with an agent (ADR 027). */
export const chatRoles = ["user", "agent"] as const;
export type ChatRole = (typeof chatRoles)[number];

/** What a discussion's agent read (ADR 027): a deletion of it erases the discussion. */
export const chatReadKinds = ["episode", "person", "item"] as const;
export type ChatReadKind = (typeof chatReadKinds)[number];

/** A phone recording the Mac received (ADR 032): stored, or deleted and kept as a tombstone. */
export const phoneRecordingStates = ["stored", "deleted"] as const;
export type PhoneRecordingState = (typeof phoneRecordingStates)[number];
/** What a phone's outbox asks of the Mac (ADR 008): a deletion (M5.2), a name or a note (M5.3). */
export const phoneOperationKinds = ["delete", "rename", "note", "tag", "voice"] as const;
export type PhoneOperationKind = (typeof phoneOperationKinds)[number];
/** How a phone's last request reached the Mac (ADR 008, M5.5): the relay's `via`. */
export const phonePaths = ["lan", "tailnet", "loopback"] as const;
export type PhonePath = (typeof phonePaths)[number];

/** Which of two recordings of the same meeting feeds the journal over their shared time (ADR 032). */
export const sameMomentSources = ["phone", "mac"] as const;
export type SameMomentSource = (typeof sameMomentSources)[number];
