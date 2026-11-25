CREATE TABLE `analysis_runs` (
	`id` integer PRIMARY KEY,
	`episode_id` integer NOT NULL,
	`stage` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`pass_uid` text,
	`engine_id` text NOT NULL,
	`engine_version` text NOT NULL,
	`engine_runtime` text NOT NULL,
	`adapter_class` text NOT NULL,
	`model_sha256` text,
	`engine_config` text DEFAULT '{}' NOT NULL,
	`input_hash` text NOT NULL,
	`input_generation` integer NOT NULL,
	`coverage` real,
	`metrics` text DEFAULT '{}' NOT NULL,
	`error_code` text,
	`started_at_ms` integer NOT NULL,
	`finished_at_ms` integer,
	`published_at_ms` integer,
	CONSTRAINT `fk_analysis_runs_episode_id_episodes_id_fk` FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON DELETE CASCADE,
	CONSTRAINT "analysis_runs_stage_check" CHECK("stage" in ('asr', 'asr_live', 'align', 'diarize', 'embed_speaker')),
	CONSTRAINT "analysis_runs_status_check" CHECK("status" in ('running', 'succeeded', 'failed', 'cancelled', 'published', 'discarded', 'superseded')),
	CONSTRAINT "analysis_runs_adapter_class_check" CHECK("adapter_class" in ('product', 'probe')),
	CONSTRAINT "analysis_runs_coverage_check" CHECK("coverage" between 0 and 1),
	CONSTRAINT "analysis_runs_engine_config_check" CHECK(json_valid("engine_config")),
	CONSTRAINT "analysis_runs_metrics_check" CHECK(json_valid("metrics"))
);
--> statement-breakpoint
CREATE TABLE `episode_analysis` (
	`episode_id` integer NOT NULL,
	`stage` text NOT NULL,
	`run_id` integer NOT NULL CONSTRAINT `episode_analysis_run_unique` UNIQUE,
	`input_generation` integer NOT NULL,
	`published_at_ms` integer NOT NULL,
	CONSTRAINT `episode_analysis_pk` PRIMARY KEY(`episode_id`, `stage`),
	CONSTRAINT `fk_episode_analysis_episode_id_episodes_id_fk` FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_episode_analysis_run_id_analysis_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `analysis_runs`(`id`) ON DELETE CASCADE,
	CONSTRAINT "episode_analysis_stage_check" CHECK("stage" in ('asr', 'asr_live', 'align', 'diarize', 'embed_speaker'))
);
--> statement-breakpoint
CREATE TABLE `episode_speakers` (
	`id` integer PRIMARY KEY,
	`episode_id` integer NOT NULL,
	`run_id` integer NOT NULL,
	`label` text NOT NULL,
	`ordinal` integer NOT NULL,
	`voiced_ms` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_episode_speakers_episode_id_episodes_id_fk` FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_episode_speakers_run_id_analysis_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `analysis_runs`(`id`) ON DELETE CASCADE,
	CONSTRAINT `episode_speakers_run_label_unique` UNIQUE(`run_id`,`label`),
	CONSTRAINT `episode_speakers_run_ordinal_unique` UNIQUE(`run_id`,`ordinal`)
);
--> statement-breakpoint
CREATE TABLE `segments` (
	`id` integer PRIMARY KEY,
	`run_id` integer NOT NULL,
	`episode_id` integer NOT NULL,
	`track_run_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`sample_start` integer NOT NULL,
	`sample_end` integer NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`speaker_label` text,
	`episode_speaker_id` integer,
	`text` text NOT NULL,
	`lang` text,
	`confidence` real,
	`words` blob,
	CONSTRAINT `fk_segments_run_id_analysis_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `analysis_runs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_segments_episode_id_episodes_id_fk` FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_segments_track_run_id_track_runs_id_fk` FOREIGN KEY (`track_run_id`) REFERENCES `track_runs`(`id`),
	CONSTRAINT `fk_segments_episode_speaker_id_episode_speakers_id_fk` FOREIGN KEY (`episode_speaker_id`) REFERENCES `episode_speakers`(`id`) ON DELETE SET NULL,
	CONSTRAINT `segments_run_seq_unique` UNIQUE(`run_id`,`seq`),
	CONSTRAINT "segments_samples_check" CHECK("sample_end" >= "sample_start"),
	CONSTRAINT "segments_time_check" CHECK("end_ms" >= "start_ms"),
	CONSTRAINT "segments_confidence_check" CHECK("confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE `speaker_turns` (
	`id` integer PRIMARY KEY,
	`run_id` integer NOT NULL,
	`episode_id` integer NOT NULL,
	`track_run_id` integer NOT NULL,
	`sample_start` integer NOT NULL,
	`sample_end` integer NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`speaker_label` text NOT NULL,
	`episode_speaker_id` integer,
	`confidence` real,
	CONSTRAINT `fk_speaker_turns_run_id_analysis_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `analysis_runs`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_speaker_turns_episode_id_episodes_id_fk` FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_speaker_turns_track_run_id_track_runs_id_fk` FOREIGN KEY (`track_run_id`) REFERENCES `track_runs`(`id`),
	CONSTRAINT `fk_speaker_turns_episode_speaker_id_episode_speakers_id_fk` FOREIGN KEY (`episode_speaker_id`) REFERENCES `episode_speakers`(`id`) ON DELETE SET NULL,
	CONSTRAINT "speaker_turns_samples_check" CHECK("sample_end" > "sample_start"),
	CONSTRAINT "speaker_turns_time_check" CHECK("end_ms" >= "start_ms"),
	CONSTRAINT "speaker_turns_confidence_check" CHECK("confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE `deleted_ranges` (
	`id` integer PRIMARY KEY,
	`scope` text NOT NULL,
	`track_run_id` integer,
	`sample_start` integer,
	`sample_end` integer,
	`wall_start_ms` integer NOT NULL,
	`wall_end_ms` integer NOT NULL,
	`origin` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	CONSTRAINT `fk_deleted_ranges_track_run_id_track_runs_id_fk` FOREIGN KEY (`track_run_id`) REFERENCES `track_runs`(`id`),
	CONSTRAINT "deleted_ranges_scope_check" CHECK("scope" in ('all', 'track_run')),
	CONSTRAINT "deleted_ranges_origin_check" CHECK("origin" in ('app', 'tray', 'agent', 'phone')),
	CONSTRAINT "deleted_ranges_wall_check" CHECK("wall_end_ms" > "wall_start_ms"),
	CONSTRAINT "deleted_ranges_shape_check" CHECK(("scope" = 'all' and "track_run_id" is null and "sample_start" is null and "sample_end" is null) or ("scope" = 'track_run' and "track_run_id" is not null and "sample_start" is not null and "sample_end" is not null and "sample_start" >= 0 and "sample_end" > "sample_start"))
);
--> statement-breakpoint
CREATE TABLE `user_assertions` (
	`id` integer PRIMARY KEY,
	`kind` text NOT NULL,
	`track_run_id` integer NOT NULL,
	`sample_start` integer NOT NULL,
	`sample_end` integer NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`origin` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`revoked_at_ms` integer,
	CONSTRAINT `fk_user_assertions_track_run_id_track_runs_id_fk` FOREIGN KEY (`track_run_id`) REFERENCES `track_runs`(`id`),
	CONSTRAINT "user_assertions_kind_check" CHECK("kind" in ('transcript_edit', 'force_boundary', 'forbid_boundary', 'size_override', 'context_override', 'speaker_is', 'speaker_is_not')),
	CONSTRAINT "user_assertions_origin_check" CHECK("origin" in ('app', 'tray', 'agent', 'phone')),
	CONSTRAINT "user_assertions_range_check" CHECK("sample_end" >= "sample_start"),
	CONSTRAINT "user_assertions_payload_check" CHECK(json_valid("payload"))
);
--> statement-breakpoint
CREATE TABLE `apps` (
	`id` integer PRIMARY KEY,
	`bundle_id` text NOT NULL UNIQUE,
	`name` text,
	`first_seen_ms` integer NOT NULL,
	`last_seen_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chunks` (
	`id` integer PRIMARY KEY,
	`spool_file_id` integer NOT NULL,
	`track_run_id` integer NOT NULL,
	`byte_offset` integer NOT NULL,
	`byte_length` integer NOT NULL,
	`sample_start` integer NOT NULL,
	`sample_count` integer NOT NULL,
	`host_ticks` integer,
	`continuous_us` integer,
	`wall_ms` integer NOT NULL,
	`crc32` integer NOT NULL,
	`audio_state` text DEFAULT 'present' NOT NULL,
	`archive_rel_path` text,
	CONSTRAINT `fk_chunks_spool_file_id_spool_files_id_fk` FOREIGN KEY (`spool_file_id`) REFERENCES `spool_files`(`id`),
	CONSTRAINT `fk_chunks_track_run_id_track_runs_id_fk` FOREIGN KEY (`track_run_id`) REFERENCES `track_runs`(`id`),
	CONSTRAINT `chunks_spool_offset_unique` UNIQUE(`spool_file_id`,`byte_offset`),
	CONSTRAINT "chunks_audio_state_check" CHECK("audio_state" in ('present', 'archived', 'expired', 'deleted')),
	CONSTRAINT "chunks_pcm16_check" CHECK("sample_count" > 0 and "byte_length" = "sample_count" * 2),
	CONSTRAINT "chunks_offset_check" CHECK("byte_offset" >= 0),
	CONSTRAINT "chunks_crc32_check" CHECK("crc32" between 0 and 4294967295)
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` integer PRIMARY KEY,
	`uid` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`transport` text DEFAULT 'unknown' NOT NULL,
	`has_input` integer DEFAULT false NOT NULL,
	`has_output` integer DEFAULT false NOT NULL,
	`first_seen_ms` integer NOT NULL,
	`last_seen_ms` integer NOT NULL,
	CONSTRAINT "devices_transport_check" CHECK("transport" in ('built_in', 'usb', 'thunderbolt', 'pci', 'bluetooth', 'bluetooth_le', 'airplay', 'hdmi', 'display_port', 'continuity', 'virtual', 'aggregate', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE `epochs` (
	`id` integer PRIMARY KEY,
	`track_run_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`reason` text NOT NULL,
	`sample_start` integer NOT NULL,
	`measured_rate_hz` real,
	`timebase_numer` integer NOT NULL,
	`timebase_denom` integer NOT NULL,
	`anchor_host_ticks` integer NOT NULL,
	`anchor_continuous_us` integer NOT NULL,
	`anchor_wall_ms` integer NOT NULL,
	`drift_ppm` real,
	`alignment_uncertainty_us` integer,
	CONSTRAINT `fk_epochs_track_run_id_track_runs_id_fk` FOREIGN KEY (`track_run_id`) REFERENCES `track_runs`(`id`),
	CONSTRAINT `epochs_run_seq_unique` UNIQUE(`track_run_id`,`seq`),
	CONSTRAINT "epochs_reason_check" CHECK("reason" in ('run_start', 'device_change', 'rate_change', 'wake', 'daemon_restart', 'discontinuity')),
	CONSTRAINT "epochs_timebase_check" CHECK("timebase_numer" > 0 and "timebase_denom" > 0)
);
--> statement-breakpoint
CREATE TABLE `gaps` (
	`id` integer PRIMARY KEY,
	`track_run_id` integer,
	`track_key` text,
	`reason` text NOT NULL,
	`wall_start_ms` integer NOT NULL,
	`wall_end_ms` integer NOT NULL,
	`sample_start` integer,
	`sample_end` integer,
	`lost_bytes` integer,
	`detail` text,
	CONSTRAINT `fk_gaps_track_run_id_track_runs_id_fk` FOREIGN KEY (`track_run_id`) REFERENCES `track_runs`(`id`),
	CONSTRAINT "gaps_reason_check" CHECK("reason" in ('helper_exit', 'core_exit', 'power_loss', 'disk_full', 'write_error', 'permission_revoked', 'device_lost', 'ring_overflow', 'sleep', 'paused', 'recovery_truncated')),
	CONSTRAINT "gaps_range_check" CHECK("wall_end_ms" >= "wall_start_ms")
);
--> statement-breakpoint
CREATE TABLE `process_incarnations` (
	`id` integer PRIMARY KEY,
	`pid` integer NOT NULL,
	`started_wall_ms` integer NOT NULL,
	`bundle_id` text,
	`app_id` integer,
	`responsible_pid` integer,
	`evidence` text,
	`confidence` real,
	`first_seen_ms` integer NOT NULL,
	`last_seen_ms` integer NOT NULL,
	`exited_wall_ms` integer,
	CONSTRAINT `fk_process_incarnations_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`),
	CONSTRAINT `process_incarnations_pid_start_unique` UNIQUE(`pid`,`started_wall_ms`),
	CONSTRAINT "process_incarnations_evidence_check" CHECK("evidence" in ('responsibility', 'ancestry', 'path', 'daemon_map')),
	CONSTRAINT "process_incarnations_confidence_check" CHECK("confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE `speech_regions` (
	`id` integer PRIMARY KEY,
	`track_run_id` integer NOT NULL,
	`sample_start` integer NOT NULL,
	`sample_end` integer,
	`wall_start_ms` integer NOT NULL,
	`wall_end_ms` integer,
	`continuous_start_us` integer,
	`continuous_end_us` integer,
	`state` text DEFAULT 'open' NOT NULL,
	`end_reason` text,
	`vad_version` text NOT NULL,
	CONSTRAINT `fk_speech_regions_track_run_id_track_runs_id_fk` FOREIGN KEY (`track_run_id`) REFERENCES `track_runs`(`id`),
	CONSTRAINT `speech_regions_run_start_unique` UNIQUE(`track_run_id`,`sample_start`),
	CONSTRAINT "speech_regions_state_check" CHECK("state" in ('open', 'closed')),
	CONSTRAINT "speech_regions_end_reason_check" CHECK("end_reason" in ('silence', 'max_length', 'track_closed', 'recovery', 'deleted')),
	CONSTRAINT "speech_regions_end_check" CHECK(("state" = 'open' and "sample_end" is null) or ("state" = 'closed' and "sample_end" is not null and "wall_end_ms" is not null and "sample_end" > "sample_start"))
);
--> statement-breakpoint
CREATE TABLE `spool_files` (
	`id` integer PRIMARY KEY,
	`track_run_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`rel_path` text NOT NULL UNIQUE,
	`sample_start` integer NOT NULL,
	`committed_bytes` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`created_wall_ms` integer NOT NULL,
	`closed_wall_ms` integer,
	CONSTRAINT `fk_spool_files_track_run_id_track_runs_id_fk` FOREIGN KEY (`track_run_id`) REFERENCES `track_runs`(`id`),
	CONSTRAINT `spool_files_run_seq_unique` UNIQUE(`track_run_id`,`seq`),
	CONSTRAINT "spool_files_state_check" CHECK("state" in ('open', 'closed', 'expired', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE `track_runs` (
	`id` integer PRIMARY KEY,
	`uid` text NOT NULL UNIQUE,
	`track_key` text NOT NULL,
	`source_kind` text NOT NULL,
	`device_id` integer,
	`app_id` integer,
	`sample_rate` integer DEFAULT 16000 NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`end_reason` text,
	`started_wall_ms` integer NOT NULL,
	`ended_wall_ms` integer,
	`sample_end` integer,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT `fk_track_runs_device_id_devices_id_fk` FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`),
	CONSTRAINT `fk_track_runs_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`),
	CONSTRAINT "track_runs_source_kind_check" CHECK("source_kind" in ('input', 'app', 'system', 'phone')),
	CONSTRAINT "track_runs_state_check" CHECK("state" in ('open', 'closed', 'sealed')),
	CONSTRAINT "track_runs_end_reason_check" CHECK("end_reason" in ('stopped', 'paused', 'device_lost', 'device_changed', 'format_changed', 'sleep', 'released', 'helper_exit', 'recovered')),
	CONSTRAINT "track_runs_sample_rate_check" CHECK("sample_rate" > 0),
	CONSTRAINT "track_runs_end_check" CHECK(("state" = 'open' and "ended_wall_ms" is null) or ("state" <> 'open' and "ended_wall_ms" is not null))
);
--> statement-breakpoint
CREATE TABLE `episode_regions` (
	`episode_id` integer NOT NULL,
	`speech_region_id` integer NOT NULL,
	`grouping_version` text NOT NULL,
	CONSTRAINT `episode_regions_pk` PRIMARY KEY(`episode_id`, `speech_region_id`),
	CONSTRAINT `fk_episode_regions_episode_id_episodes_id_fk` FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_episode_regions_speech_region_id_speech_regions_id_fk` FOREIGN KEY (`speech_region_id`) REFERENCES `speech_regions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `episode_regions_region_version_unique` UNIQUE(`speech_region_id`,`grouping_version`)
);
--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` integer PRIMARY KEY,
	`state` text DEFAULT 'open' NOT NULL,
	`context` text,
	`size` text,
	`size_state` text DEFAULT 'provisional' NOT NULL,
	`analysis_state` text DEFAULT 'pending' NOT NULL,
	`input_generation` integer DEFAULT 1 NOT NULL,
	`started_at_ms` integer NOT NULL,
	`ended_at_ms` integer,
	`voiced_ms` integer DEFAULT 0 NOT NULL,
	`primary_app_id` integer,
	`label` text,
	`grouping_version` text NOT NULL,
	`classifier_version` text NOT NULL,
	`kind_inputs` text DEFAULT '{}' NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT `fk_episodes_primary_app_id_apps_id_fk` FOREIGN KEY (`primary_app_id`) REFERENCES `apps`(`id`),
	CONSTRAINT "episodes_state_check" CHECK("state" in ('open', 'closed')),
	CONSTRAINT "episodes_context_check" CHECK("context" in ('call', 'in_person', 'media', 'mixed')),
	CONSTRAINT "episodes_size_check" CHECK("size" in ('trace', 'moment', 'conversation')),
	CONSTRAINT "episodes_size_state_check" CHECK("size_state" in ('provisional', 'final')),
	CONSTRAINT "episodes_analysis_state_check" CHECK("analysis_state" in ('pending', 'queued', 'running', 'complete', 'failed', 'stale')),
	CONSTRAINT "episodes_generation_check" CHECK("input_generation" > 0),
	CONSTRAINT "episodes_kind_inputs_check" CHECK(json_valid("kind_inputs")),
	CONSTRAINT "episodes_end_check" CHECK("ended_at_ms" is null or "ended_at_ms" >= "started_at_ms")
);
--> statement-breakpoint
CREATE TABLE `identity_rules` (
	`id` integer PRIMARY KEY,
	`scope` text NOT NULL,
	`app_id` integer,
	`device_id` integer,
	`episode_id` integer,
	`recognize` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT `fk_identity_rules_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_identity_rules_device_id_devices_id_fk` FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_identity_rules_episode_id_episodes_id_fk` FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON DELETE CASCADE,
	CONSTRAINT "identity_rules_scope_check" CHECK("scope" in ('global', 'app', 'device', 'episode')),
	CONSTRAINT "identity_rules_target_check" CHECK((case "scope"
        when 'global' then "app_id" is null and "device_id" is null and "episode_id" is null
        when 'app' then "app_id" is not null and "device_id" is null and "episode_id" is null
        when 'device' then "device_id" is not null and "app_id" is null and "episode_id" is null
        when 'episode' then "episode_id" is not null and "app_id" is null and "device_id" is null
        else 0 end))
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "settings_key_check" CHECK("key" is not null and length("key") > 0),
	CONSTRAINT "settings_value_check" CHECK(json_valid("value"))
);
--> statement-breakpoint
CREATE TABLE `job_attempts` (
	`id` integer PRIMARY KEY,
	`job_id` integer NOT NULL,
	`attempt` integer NOT NULL,
	`outcome` text DEFAULT 'running' NOT NULL,
	`run_id` integer,
	`worker_pid` integer,
	`error_code` text,
	`error_message` text,
	`started_at_ms` integer NOT NULL,
	`finished_at_ms` integer,
	CONSTRAINT `fk_job_attempts_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_job_attempts_run_id_analysis_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `analysis_runs`(`id`) ON DELETE SET NULL,
	CONSTRAINT `job_attempts_job_attempt_unique` UNIQUE(`job_id`,`attempt`),
	CONSTRAINT "job_attempts_outcome_check" CHECK("outcome" in ('running', 'succeeded', 'failed', 'cancelled', 'abandoned'))
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY,
	`kind` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`episode_id` integer,
	`stage` text,
	`input_generation` integer,
	`dedupe_key` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`not_before_ms` integer,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`finished_at_ms` integer,
	CONSTRAINT `fk_jobs_episode_id_episodes_id_fk` FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON DELETE SET NULL,
	CONSTRAINT "jobs_kind_check" CHECK("kind" in ('analysis', 'live_analysis', 'retention', 'deletion', 'maintenance')),
	CONSTRAINT "jobs_state_check" CHECK("state" in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "jobs_stage_check" CHECK("stage" in ('asr', 'asr_live', 'align', 'diarize', 'embed_speaker')),
	CONSTRAINT "jobs_attempts_check" CHECK("attempts" >= 0 and "max_attempts" > 0),
	CONSTRAINT "jobs_payload_check" CHECK(json_valid("payload"))
);
--> statement-breakpoint
CREATE INDEX `analysis_runs_episode_stage_idx` ON `analysis_runs` (`episode_id`,`stage`);--> statement-breakpoint
CREATE INDEX `analysis_runs_pass_idx` ON `analysis_runs` (`pass_uid`);--> statement-breakpoint
CREATE INDEX `episode_speakers_episode_idx` ON `episode_speakers` (`episode_id`);--> statement-breakpoint
CREATE INDEX `segments_episode_start_idx` ON `segments` (`episode_id`,`start_ms`);--> statement-breakpoint
CREATE INDEX `segments_run_idx` ON `segments` (`run_id`);--> statement-breakpoint
CREATE INDEX `speaker_turns_run_idx` ON `speaker_turns` (`run_id`);--> statement-breakpoint
CREATE INDEX `speaker_turns_episode_start_idx` ON `speaker_turns` (`episode_id`,`start_ms`);--> statement-breakpoint
CREATE INDEX `deleted_ranges_wall_idx` ON `deleted_ranges` (`wall_start_ms`,`wall_end_ms`);--> statement-breakpoint
CREATE INDEX `deleted_ranges_run_idx` ON `deleted_ranges` (`track_run_id`,`sample_start`);--> statement-breakpoint
CREATE INDEX `user_assertions_anchor_idx` ON `user_assertions` (`track_run_id`,`sample_start`);--> statement-breakpoint
CREATE INDEX `user_assertions_active_kind_idx` ON `user_assertions` (`kind`) WHERE "user_assertions"."revoked_at_ms" is null;--> statement-breakpoint
CREATE INDEX `chunks_run_sample_idx` ON `chunks` (`track_run_id`,`sample_start`);--> statement-breakpoint
CREATE INDEX `chunks_wall_idx` ON `chunks` (`wall_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `gaps_identity_unique` ON `gaps` (coalesce("track_run_id", 0),coalesce("track_key", ''),`reason`,`wall_start_ms`);--> statement-breakpoint
CREATE INDEX `gaps_wall_start_idx` ON `gaps` (`wall_start_ms`);--> statement-breakpoint
CREATE INDEX `speech_regions_wall_start_idx` ON `speech_regions` (`wall_start_ms`);--> statement-breakpoint
CREATE INDEX `track_runs_track_key_started_idx` ON `track_runs` (`track_key`,`started_wall_ms`);--> statement-breakpoint
CREATE INDEX `track_runs_started_idx` ON `track_runs` (`started_wall_ms`);--> statement-breakpoint
CREATE INDEX `episodes_started_idx` ON `episodes` (`started_at_ms`);--> statement-breakpoint
CREATE INDEX `episodes_size_started_idx` ON `episodes` (`size`,`started_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `identity_rules_global_unique` ON `identity_rules` (`scope`) WHERE "identity_rules"."scope" = 'global';--> statement-breakpoint
CREATE UNIQUE INDEX `identity_rules_app_unique` ON `identity_rules` (`app_id`) WHERE "identity_rules"."scope" = 'app';--> statement-breakpoint
CREATE UNIQUE INDEX `identity_rules_device_unique` ON `identity_rules` (`device_id`) WHERE "identity_rules"."scope" = 'device';--> statement-breakpoint
CREATE UNIQUE INDEX `identity_rules_episode_unique` ON `identity_rules` (`episode_id`) WHERE "identity_rules"."scope" = 'episode';--> statement-breakpoint
CREATE INDEX `jobs_runnable_idx` ON `jobs` (`state`,`priority`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `jobs_episode_idx` ON `jobs` (`episode_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_active_dedupe_unique` ON `jobs` (`dedupe_key`) WHERE "jobs"."state" in ('queued', 'running') and "jobs"."dedupe_key" is not null;