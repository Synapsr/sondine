CREATE TABLE `listens` (
	`id` integer PRIMARY KEY,
	`uid` text NOT NULL UNIQUE,
	`session_id` text NOT NULL,
	`bundle_id` text NOT NULL,
	`app_id` integer,
	`via` text NOT NULL,
	`started_wall_ms` integer NOT NULL,
	`started_continuous_us` integer NOT NULL,
	`ended_wall_ms` integer,
	`ended_continuous_us` integer,
	`end_reason` text,
	`last_seen_wall_ms` integer NOT NULL,
	`last_seen_continuous_us` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT `fk_listens_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`),
	CONSTRAINT "listens_via_check" CHECK("via" in ('app', 'speech')),
	CONSTRAINT "listens_end_reason_check" CHECK("end_reason" in ('ended', 'lost')),
	CONSTRAINT "listens_end_check" CHECK(("ended_wall_ms" is null and "ended_continuous_us" is null and "end_reason" is null) or ("ended_wall_ms" is not null and "ended_continuous_us" is not null and "end_reason" is not null and "ended_continuous_us" >= "started_continuous_us")),
	CONSTRAINT "listens_last_seen_check" CHECK("last_seen_continuous_us" >= "started_continuous_us")
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_episodes` (
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
	`grouping_key` text,
	`classifier_version` text NOT NULL,
	`kind_inputs` text DEFAULT '{}' NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT `fk_episodes_primary_app_id_apps_id_fk` FOREIGN KEY (`primary_app_id`) REFERENCES `apps`(`id`),
	CONSTRAINT "episodes_state_check" CHECK("state" in ('open', 'closed')),
	CONSTRAINT "episodes_context_check" CHECK("context" in ('call', 'in_person', 'media', 'mixed', 'dictation')),
	CONSTRAINT "episodes_size_check" CHECK("size" in ('trace', 'moment', 'conversation')),
	CONSTRAINT "episodes_size_state_check" CHECK("size_state" in ('provisional', 'final')),
	CONSTRAINT "episodes_analysis_state_check" CHECK("analysis_state" in ('pending', 'queued', 'running', 'complete', 'failed', 'stale')),
	CONSTRAINT "episodes_generation_check" CHECK("input_generation" > 0),
	CONSTRAINT "episodes_kind_inputs_check" CHECK(json_valid("kind_inputs")),
	CONSTRAINT "episodes_end_check" CHECK("ended_at_ms" is null or "ended_at_ms" >= "started_at_ms")
);
--> statement-breakpoint
INSERT INTO `__new_episodes`(`id`, `state`, `context`, `size`, `size_state`, `analysis_state`, `input_generation`, `started_at_ms`, `ended_at_ms`, `voiced_ms`, `primary_app_id`, `label`, `grouping_version`, `grouping_key`, `classifier_version`, `kind_inputs`, `created_at_ms`, `updated_at_ms`) SELECT `id`, `state`, `context`, `size`, `size_state`, `analysis_state`, `input_generation`, `started_at_ms`, `ended_at_ms`, `voiced_ms`, `primary_app_id`, `label`, `grouping_version`, `grouping_key`, `classifier_version`, `kind_inputs`, `created_at_ms`, `updated_at_ms` FROM `episodes`;--> statement-breakpoint
DROP TABLE `episodes`;--> statement-breakpoint
ALTER TABLE `__new_episodes` RENAME TO `episodes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `episodes_started_idx` ON `episodes` (`started_at_ms`);--> statement-breakpoint
CREATE INDEX `episodes_size_started_idx` ON `episodes` (`size`,`started_at_ms`);--> statement-breakpoint
CREATE INDEX `listens_started_idx` ON `listens` (`started_wall_ms`);