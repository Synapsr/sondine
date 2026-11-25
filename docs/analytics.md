# Analytics

What the handbook asks every app to write down. The decision, its limits and
the report field by field are in
[ADR 042](decisions/042-usage-statistics.md). `docs-analytics.test.ts`
(`packages/protocol`) fails when the lists below and the code differ.

- **Provider**: PostHog Cloud EU (`eu.i.posthog.com`), through the Worker
  `apps/stats` at `stats.sondine.app`. No SDK in the app.
- **Project**: « Default project » (367615) of the organization « sondine »,
  PostHog Cloud EU, free plan, nothing else in it. Client IPs discarded, GeoIP
  transformation off. Retention: 12 months.
- **Event**: `usage_reported`, one per Mac and day, opt-in, with no person
  profile. Its distinct id is the report's: « unique users » in PostHog counts
  reports, so it counts days of Macs, not people.
- **Daily use**: `usage_reported` with any `desktop.*` or `mobile.*` property.
- **Activation**: `desktop.conversation_opened`, the user came back to something
  that was said.
- **Coming back**: `installed` by `active_days` (null until both the install and
  the yes are 7 days old), among Macs that still report.
- **Trouble**: `error.*`, and where `onboarding` stops short of `done`.
- **Numbers**: counts are rounded down to 1, 2, 3, 5, 10, 20, 50, 100, 200, 500.
  Count reports by distinct id: PostHog merges retries, but not at once.
- **Internal traffic**: there is no internal user to filter. Development, tests,
  CI, the fake hardware and any build but a release have no endpoint and send
  nothing; the maintainer's own Sondine Exp is such a build. The development
  Worker forwards nothing. A control report has `app_version` `0.0.0`:
  leave it out. Anyone can send a false report: look for days that jump.
- **Verified**: 2026-11-25. Locally, the real core against a local server and
  the Worker in workerd. In production, one control report (`0.0.0`): one
  `usage_reported` in the right project, with the properties below, no `$ip`,
  no `$geoip_*`, no person. The headers that leave the Worker, on a copy of
  it: nothing of the Mac's (ADR 042, Limits). **Not yet verified**: a report
  from a released Mac.

## Properties

`report_version`, `day`, `app_version`, `macos`, `memory`, `installed`,
`active_days`, `onboarding`, then one property per count:
`<surface>.<event>` and `error.<code>`.

## Events

`action`: each success. `read`: calls less than a minute apart are one.
`remote`: counted from an agent or a phone only. A success can be a panel the
user closed. Every other procedure is never counted
(`packages/protocol/src/usage-events.ts`).

| Event                        | Rule   | Surfaces             |
| ---------------------------- | ------ | -------------------- |
| `agent_access_set`           | action | desktop              |
| `agent_app_connected`        | action | desktop              |
| `agent_created`              | action | desktop              |
| `agent_removed`              | action | desktop              |
| `agent_revoked`              | action | desktop              |
| `analysis_requested`         | action | desktop              |
| `analysis_wait_set`          | action | desktop              |
| `audio_files_imported`       | action | desktop              |
| `audio_imported`             | action | desktop              |
| `browser_extension_shown`    | action | desktop              |
| `browser_link_set`           | action | desktop              |
| `call_context_dismissed`     | action | desktop              |
| `call_offer_accepted`        | action | desktop              |
| `call_offer_app_allowed`     | action | desktop              |
| `call_offer_declined`        | action | desktop              |
| `call_offer_enabled_set`     | action | desktop              |
| `call_offer_skipped`         | action | desktop              |
| `chat_access_set`            | action | desktop              |
| `chat_discussion_removed`    | action | desktop              |
| `chat_limit_set`             | action | desktop              |
| `chat_message_sent`          | action | desktop              |
| `chat_turn_stopped`          | action | desktop              |
| `commitments_viewed`         | remote | mcp, mobile          |
| `compute_chosen`             | action | desktop              |
| `compute_connected`          | action | desktop              |
| `compute_disconnected`       | action | desktop              |
| `context_added`              | action | desktop              |
| `context_edited`             | action | desktop              |
| `context_opened`             | action | desktop              |
| `context_pasted`             | action | desktop              |
| `context_pasted_ongoing`     | action | desktop              |
| `context_picked`             | action | desktop              |
| `context_removed`            | action | desktop              |
| `context_transcribed`        | action | desktop              |
| `context_unpinned`           | action | desktop              |
| `context_viewed`             | remote | mcp, mobile          |
| `conversation_opened`        | action | desktop              |
| `day_viewed`                 | remote | mcp, mobile          |
| `dictation_app_set`          | action | desktop              |
| `dictation_learning_set`     | action | desktop              |
| `display_changed`            | action | desktop              |
| `edit_redone`                | action | desktop              |
| `edit_undone`                | action | desktop              |
| `episode_audio_kept`         | action | desktop              |
| `episode_deleted`            | action | desktop              |
| `episode_ended`              | action | desktop              |
| `episode_exported`           | action | desktop              |
| `episode_journal_source_set` | action | desktop              |
| `episode_kind_set`           | action | desktop              |
| `episode_page_opened`        | action | desktop              |
| `episode_recognition_set`    | action | desktop              |
| `episode_split`              | action | desktop              |
| `episode_viewed`             | remote | mcp, mobile          |
| `episodes_listed`            | remote | mcp, mobile          |
| `episodes_merged`            | action | desktop              |
| `journal_marked`             | action | desktop              |
| `journal_requested`          | action | desktop              |
| `journal_viewed`             | remote | mcp, mobile          |
| `listening_paused`           | action | desktop              |
| `listening_resumed`          | action | desktop              |
| `live_text_set`              | action | desktop              |
| `model_cancelled`            | action | desktop              |
| `model_downloaded`           | action | desktop              |
| `model_imported`             | action | desktop              |
| `model_picked`               | action | desktop              |
| `notch_settings_set`         | action | desktop              |
| `onboarding_completed`       | action | desktop              |
| `passage_deleted`            | action | desktop              |
| `people_listed`              | remote | mcp, mobile          |
| `people_merged`              | action | desktop              |
| `permission_requested`       | action | desktop              |
| `person_deleted`             | action | desktop              |
| `person_renamed`             | action | desktop              |
| `person_viewed`              | read   | desktop, mcp, mobile |
| `phone_pairing_answered`     | action | desktop              |
| `phone_pairing_opened`       | action | desktop              |
| `phone_pairing_reset`        | action | desktop              |
| `phone_revoked`              | action | desktop              |
| `phone_sync_set`             | action | desktop              |
| `phone_tailnet_set`          | action | desktop              |
| `privacy_duration_set`       | action | desktop              |
| `privacy_hold_lifted`        | action | desktop              |
| `privacy_media_site_set`     | action | desktop              |
| `privacy_zone_added`         | action | desktop              |
| `privacy_zone_changed`       | action | desktop              |
| `privacy_zone_removed`       | action | desktop              |
| `recent_forgotten`           | action | desktop              |
| `recent_kept`                | action | desktop              |
| `recognition_set`            | action | desktop              |
| `speaker_named`              | action | desktop              |
| `speaker_unnamed`            | action | desktop              |
| `statistics_viewed`          | read   | desktop              |
| `status_viewed`              | remote | mcp, mobile          |
| `suggestion_refused`         | action | desktop              |
| `tag_deleted`                | action | desktop              |
| `tag_renamed`                | action | desktop              |
| `tag_set`                    | action | desktop              |
| `transcript_edited`          | action | desktop              |
| `transcript_exported`        | action | desktop              |
| `transcript_restored`        | action | desktop              |
| `transcripts_searched`       | read   | desktop, mcp, mobile |
| `update_check_set`           | action | desktop              |
| `updates_checked`            | action | desktop              |
| `voice_read_cancelled`       | action | desktop              |
| `voice_read_finished`        | action | desktop              |
| `voice_read_forgotten`       | action | desktop              |
| `voice_read_started`         | action | desktop              |
| `voices_merged`              | action | desktop              |
| `window_opened`              | read   | desktop              |

## Error codes

- `api_helper_rejected`
- `api_helper_unavailable`
- `api_internal`
- `api_timeout`
- `core_crashed`
- `helper_crashed`
- `renderer_crashed`
- `journal_bad_shape`
- `journal_check_shape`
- `journal_crashed`
- `journal_deadline`
- `journal_internal`
- `journal_load_failed`
- `journal_not_json`
- `journal_other`
- `journal_output_limit`
- `model_bad_response`
- `model_corrupt`
- `model_disk_full`
- `model_hash_mismatch`
- `model_http_status`
- `model_io`
- `model_network`
- `model_not_a_file`
- `model_other`
- `model_redirect_refused`
- `model_size_mismatch`
- `model_too_large`
- `transcription_audio_read`
- `transcription_audio_unavailable`
- `transcription_crashed`
- `transcription_deadline`
- `transcription_internal`
- `transcription_invalid_output`
- `transcription_load_failed`
- `transcription_model_limit`
- `transcription_network_unavailable`
- `transcription_other`
- `transcription_protocol`
- `transcription_quota_exhausted`
- `transcription_rejected`
- `transcription_server_busy`
- `transcription_server_mismatch`
- `transcription_unauthorized`
- `transcription_worker_running`
- `update_bad_response`
- `update_network`

## Site

sondine.app (ADR 043, its own repository) counts visits with Umami, loaded on
`sondine.app` and `www.sondine.app` only: page views, and the clicks
`download_clicked`, `github_clicked` (both with `place`), `waitlist_clicked`
and `language_switched` (with `to`). No content, e-mail or identity. The e-mail
form at `/cloud` is not counted. **Not yet verified in production**: the site
is not deployed.
