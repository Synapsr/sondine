// What counts as use (ADR 042): one rule for each event of `packages/api`'s
// procedures (`ProcedureMeta.event`). Here rather than in the API, so the
// Worker that receives the reports (`apps/stats`) knows the same closed list.
// A test of `packages/api` fails when a procedure has no rule, and one of
// `docs/analytics.md` when the document and this list differ. A name once
// released stays: Macs that have not updated still send it.

/**
 * - `action`: each success counts.
 * - `read`: the same, but calls less than a minute apart are one (a search
 *   typed letter by letter, a page read again after an edit).
 * - `remote`: a read the window repeats alone (polling); it counts from an
 *   agent or a phone only.
 * - `never`: streams, previews, settings the window reads, what it calls alone.
 */
export type UsageRule = "action" | "read" | "remote" | "never";

export const USAGE_RULES = {
  agent_access_set: "action",
  agent_app_connected: "action",
  agent_created: "action",
  agent_removed: "action",
  agent_revoked: "action",
  agents_viewed: "never",
  analysis_checked: "never",
  analysis_requested: "action",
  analysis_wait_set: "action",
  audio_files_imported: "action",
  audio_imported: "action",
  browser_extension_shown: "action",
  browser_link_set: "action",
  browser_viewed: "never",
  call_context_dismissed: "action",
  call_context_viewed: "never",
  call_context_watched: "never",
  call_offer_accepted: "action",
  call_offer_app_allowed: "action",
  call_offer_declined: "action",
  call_offer_enabled_set: "action",
  call_offer_settings_viewed: "never",
  call_offer_skipped: "action",
  chat_access_set: "action",
  chat_discussion_removed: "action",
  chat_limit_set: "action",
  chat_message_sent: "action",
  chat_turn_stopped: "action",
  chat_viewed: "never",
  chat_watched: "never",
  commitments_viewed: "remote",
  // The beta has a handful of places: its people would be recognized.
  compute_beta_joined: "never",
  compute_beta_left: "never",
  compute_chosen: "action",
  compute_connected: "action",
  compute_disconnected: "action",
  compute_quota_viewed: "never",
  // The wave has a handful of places: its people would be recognized (ADR 047).
  compute_wave_viewed: "never",
  compute_billing_opened: "never",
  compute_viewed: "never",
  context_added: "action",
  context_edited: "action",
  context_opened: "action",
  context_pasted: "action",
  context_pasted_ongoing: "action",
  context_picked: "action",
  context_removed: "action",
  context_transcribed: "action",
  context_unpinned: "action",
  context_viewed: "remote",
  conversation_opened: "action",
  day_viewed: "remote",
  diagnostic_viewed: "never",
  dictation_app_set: "action",
  dictation_apps_viewed: "never",
  dictation_learning_set: "action",
  dictation_learning_viewed: "never",
  // Not in what the user said yes to: counting it needs a new version of the question.
  dictation_text_set: "never",
  display_changed: "action",
  display_viewed: "never",
  doubted_names_listed: "never",
  edit_redone: "action",
  edit_undone: "action",
  episode_audio_kept: "action",
  episode_deleted: "action",
  episode_ended: "action",
  episode_exported: "action",
  episode_journal_source_set: "action",
  episode_kind_set: "action",
  episode_page_opened: "action",
  // A playback plan, which the window also asks for to export or to get ready.
  episode_played: "never",
  episode_recognition_set: "action",
  episode_split: "action",
  episode_viewed: "remote",
  episodes_listed: "remote",
  episodes_merged: "action",
  foreground_apps_viewed: "never",
  forget_previewed: "never",
  health_viewed: "never",
  imports_listed: "never",
  journal_claude_viewed: "never",
  journal_marked: "action",
  journal_requested: "action",
  // The window also calls it alone, when its language is not the journal's.
  journal_settings_changed: "never",
  journal_viewed: "remote",
  listening_paused: "action",
  listening_resumed: "action",
  live_partial_viewed: "never",
  live_text_set: "action",
  model_cancelled: "action",
  model_downloaded: "action",
  model_imported: "action",
  model_picked: "action",
  models_viewed: "never",
  models_watched: "never",
  month_viewed: "never",
  notch_settings_set: "action",
  notch_settings_viewed: "never",
  onboarding_advanced: "never",
  onboarding_completed: "action",
  onboarding_viewed: "never",
  passage_deleted: "action",
  people_listed: "remote",
  people_merged: "action",
  permission_requested: "action",
  person_deleted: "action",
  person_renamed: "action",
  person_viewed: "read",
  phone_pairing_answered: "action",
  phone_pairing_opened: "action",
  phone_pairing_reset: "action",
  phone_revoked: "action",
  phone_sync_set: "action",
  phone_tailnet_set: "action",
  phone_viewed: "never",
  player_state_set: "never",
  privacy_duration_set: "action",
  privacy_hold_lifted: "action",
  privacy_media_site_set: "action",
  privacy_viewed: "never",
  privacy_zone_added: "action",
  privacy_zone_changed: "action",
  privacy_zone_removed: "action",
  process_crashed: "never",
  recent_forgotten: "action",
  recent_kept: "action",
  recognition_set: "action",
  recognition_viewed: "never",
  spans_viewed: "never",
  speaker_likeness_viewed: "never",
  speaker_named: "action",
  speaker_unnamed: "action",
  statistics_viewed: "read",
  status_viewed: "remote",
  status_watched: "never",
  suggestion_refused: "action",
  tag_deleted: "action",
  tag_renamed: "action",
  tag_set: "action",
  tags_listed: "never",
  transcript_edited: "action",
  transcript_exported: "action",
  transcript_restored: "action",
  transcripts_searched: "read",
  unnamed_voices_listed: "never",
  update_check_set: "action",
  // Not in what the user said yes to: counting them needs a new version of the question.
  update_install_requested: "never",
  update_note_closed: "never",
  updates_checked: "action",
  usage_sharing_set: "never",
  usage_viewed: "never",
  // Not in what the user said yes to (ADR 042): counting them needs a new version of the question.
  vocabulary_listed: "never",
  vocabulary_word_added: "never",
  vocabulary_word_changed: "never",
  vocabulary_word_removed: "never",
  voice_read_cancelled: "action",
  voice_read_finished: "action",
  voice_read_forgotten: "action",
  voice_read_started: "action",
  voice_read_viewed: "never",
  voice_read_watched: "never",
  voices_merged: "action",
  window_opened: "read",
} as const satisfies Record<string, UsageRule>;

export type UsageEvent = keyof typeof USAGE_RULES;

/** Who called: the window and the menu bar, an agent (ADR 011, 027), a paired phone (ADR 008). */
export const USAGE_SURFACES = ["desktop", "mcp", "mobile"] as const;
export type UsageSurface = (typeof USAGE_SURFACES)[number];

const names = Object.keys(USAGE_RULES) as UsageEvent[];
const counted: readonly UsageEvent[] = names.filter((name) => USAGE_RULES[name] !== "never");

/** What agents and phones do is read: the procedures they reach write nothing. */
const REMOTE_READS = [
  "commitments_viewed",
  "context_viewed",
  "day_viewed",
  "episode_viewed",
  "episodes_listed",
  "journal_viewed",
  "people_listed",
  "person_viewed",
  "status_viewed",
  "transcripts_searched",
] as const satisfies readonly UsageEvent[];

/** The events a report may count on each surface. */
export const COUNTED_EVENTS: Readonly<Record<UsageSurface, readonly UsageEvent[]>> = {
  desktop: counted.filter((name) => USAGE_RULES[name] !== "remote"),
  mcp: REMOTE_READS,
  mobile: REMOTE_READS,
};

/** The event that means the user came back to something that was said (ADR 042). */
export const ACTIVATION = { surface: "desktop", event: "conversation_opened" } as const satisfies {
  surface: UsageSurface;
  event: UsageEvent;
};

/**
 * Failures of Sondine's own, as codes: never a message. `…_other` gathers
 * a code this list does not know.
 */
export const USAGE_ERRORS = [
  "api_helper_rejected",
  "api_helper_unavailable",
  "api_internal",
  "api_timeout",
  "core_crashed",
  "helper_crashed",
  "renderer_crashed",
  "journal_bad_shape",
  "journal_check_shape",
  "journal_crashed",
  "journal_deadline",
  "journal_internal",
  "journal_load_failed",
  "journal_not_json",
  "journal_other",
  "journal_output_limit",
  "model_bad_response",
  "model_corrupt",
  "model_disk_full",
  "model_hash_mismatch",
  "model_http_status",
  "model_io",
  "model_network",
  "model_not_a_file",
  "model_other",
  "model_redirect_refused",
  "model_size_mismatch",
  "model_too_large",
  "transcription_audio_read",
  "transcription_audio_unavailable",
  "transcription_crashed",
  "transcription_deadline",
  "transcription_internal",
  "transcription_invalid_output",
  "transcription_load_failed",
  "transcription_model_limit",
  "transcription_network_unavailable",
  "transcription_other",
  "transcription_protocol",
  "transcription_quota_exhausted",
  "transcription_rejected",
  "transcription_server_busy",
  "transcription_server_mismatch",
  "transcription_unauthorized",
  "transcription_worker_running",
  "update_bad_response",
  "update_network",
] as const;
export type UsageError = (typeof USAGE_ERRORS)[number];

const known: ReadonlySet<string> = new Set(USAGE_ERRORS);

/** A failure's code in its area, as the closed list names it. */
export function usageError(
  area: "api" | "journal" | "model" | "transcription" | "update",
  code: string,
): UsageError {
  const name = `${area}_${code.replaceAll("-", "_").toLowerCase()}`;
  if (known.has(name)) return name as UsageError;
  switch (area) {
    case "journal":
      return "journal_other";
    case "model":
      return "model_other";
    case "transcription":
      return "transcription_other";
    case "api":
      return "api_internal";
    case "update":
      return "update_network";
  }
}
