CREATE TABLE `people` (
	`id` integer PRIMARY KEY,
	`name` text NOT NULL,
	`is_self` integer DEFAULT false NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "people_name_check" CHECK(length(trim("name")) between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE `user_assertions` ADD `person_id` integer REFERENCES people(id) ON DELETE CASCADE;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user_assertions` (
	`id` integer PRIMARY KEY,
	`kind` text NOT NULL,
	`track_run_id` integer NOT NULL,
	`sample_start` integer NOT NULL,
	`sample_end` integer NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`origin` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`revoked_at_ms` integer,
	`person_id` integer,
	CONSTRAINT `fk_user_assertions_track_run_id_track_runs_id_fk` FOREIGN KEY (`track_run_id`) REFERENCES `track_runs`(`id`),
	CONSTRAINT `fk_user_assertions_person_id_people_id_fk` FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON DELETE CASCADE,
	CONSTRAINT "user_assertions_person_check" CHECK(("kind" in ('speaker_is', 'speaker_is_not')) = ("person_id" is not null)),
	CONSTRAINT "user_assertions_kind_check" CHECK("kind" in ('transcript_edit', 'force_boundary', 'forbid_boundary', 'size_override', 'context_override', 'speaker_is', 'speaker_is_not')),
	CONSTRAINT "user_assertions_origin_check" CHECK("origin" in ('app', 'tray', 'agent', 'phone')),
	CONSTRAINT "user_assertions_range_check" CHECK("sample_end" >= "sample_start"),
	CONSTRAINT "user_assertions_payload_check" CHECK(json_valid("payload"))
);
--> statement-breakpoint
INSERT INTO `__new_user_assertions`(`id`, `kind`, `track_run_id`, `sample_start`, `sample_end`, `payload`, `origin`, `created_at_ms`, `revoked_at_ms`) SELECT `id`, `kind`, `track_run_id`, `sample_start`, `sample_end`, `payload`, `origin`, `created_at_ms`, `revoked_at_ms` FROM `user_assertions`;--> statement-breakpoint
DROP TABLE `user_assertions`;--> statement-breakpoint
ALTER TABLE `__new_user_assertions` RENAME TO `user_assertions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `user_assertions_anchor_idx` ON `user_assertions` (`track_run_id`,`sample_start`);--> statement-breakpoint
CREATE INDEX `user_assertions_person_idx` ON `user_assertions` (`person_id`) WHERE "user_assertions"."person_id" is not null;--> statement-breakpoint
CREATE INDEX `user_assertions_active_kind_idx` ON `user_assertions` (`kind`) WHERE "user_assertions"."revoked_at_ms" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `people_self_unique` ON `people` (`is_self`) WHERE "people"."is_self" = 1;