CREATE TABLE `kept_audio` (
	`id` integer PRIMARY KEY,
	`track_run_id` integer NOT NULL,
	`sample_start` integer NOT NULL,
	`sample_end` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	CONSTRAINT `fk_kept_audio_track_run_id_track_runs_id_fk` FOREIGN KEY (`track_run_id`) REFERENCES `track_runs`(`id`) ON DELETE CASCADE,
	CONSTRAINT "kept_audio_span_check" CHECK("sample_end" > "sample_start")
);
--> statement-breakpoint
CREATE TABLE `privacy_zone_spans` (
	`id` integer PRIMARY KEY,
	`zone_id` text NOT NULL,
	`outcome` text NOT NULL,
	`situation` text NOT NULL,
	`started_wall_ms` integer NOT NULL,
	`ended_wall_ms` integer,
	CONSTRAINT "privacy_zone_spans_outcome_check" CHECK("outcome" in ('nothing', 'text_only', 'audio_only', 'delete_week', 'delete_day')),
	CONSTRAINT "privacy_zone_spans_situation_check" CHECK(json_valid("situation")),
	CONSTRAINT "privacy_zone_spans_span_check" CHECK("ended_wall_ms" is null or "ended_wall_ms" >= "started_wall_ms")
);
--> statement-breakpoint
CREATE TABLE `situation_spans` (
	`id` integer PRIMARY KEY,
	`kind` text NOT NULL,
	`network_hash` text,
	`started_wall_ms` integer NOT NULL,
	`ended_wall_ms` integer,
	CONSTRAINT "situation_spans_kind_check" CHECK("kind" in ('screen_away', 'network')),
	CONSTRAINT "situation_spans_network_check" CHECK(("kind" = 'network') = ("network_hash" is not null)),
	CONSTRAINT "situation_spans_span_check" CHECK("ended_wall_ms" is null or "ended_wall_ms" >= "started_wall_ms")
);
--> statement-breakpoint
ALTER TABLE `episodes` ADD `audio_gone_at_ms` integer;--> statement-breakpoint
CREATE INDEX `kept_audio_run_idx` ON `kept_audio` (`track_run_id`,`sample_start`);--> statement-breakpoint
CREATE INDEX `privacy_zone_spans_started_idx` ON `privacy_zone_spans` (`started_wall_ms`);--> statement-breakpoint
CREATE INDEX `privacy_zone_spans_open_idx` ON `privacy_zone_spans` (`zone_id`) WHERE "privacy_zone_spans"."ended_wall_ms" is null;--> statement-breakpoint
CREATE INDEX `situation_spans_started_idx` ON `situation_spans` (`started_wall_ms`);