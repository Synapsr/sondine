ALTER TABLE `phone_recordings` ADD `name` text;--> statement-breakpoint
ALTER TABLE `phone_recordings` ADD `name_typed_at_ms` integer;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_phone_recordings` (
	`recording_id` text PRIMARY KEY,
	`device_id` text NOT NULL,
	`state` text DEFAULT 'stored' NOT NULL,
	`track_run_id` integer,
	`sha256` text,
	`time_uncertain` integer DEFAULT false NOT NULL,
	`name` text,
	`name_typed_at_ms` integer,
	`received_at_ms` integer NOT NULL,
	`deleted_at_ms` integer,
	CONSTRAINT `fk_phone_recordings_track_run_id_track_runs_id_fk` FOREIGN KEY (`track_run_id`) REFERENCES `track_runs`(`id`),
	CONSTRAINT "phone_recordings_state_check" CHECK("state" in ('stored', 'deleted')),
	CONSTRAINT "phone_recordings_tombstone_check" CHECK(("state" = 'stored' and "track_run_id" is not null and "sha256" is not null and "deleted_at_ms" is null)
        or ("state" = 'deleted' and "track_run_id" is null and "sha256" is null and "deleted_at_ms" is not null
          and "name" is null and "name_typed_at_ms" is null)),
	CONSTRAINT "phone_recordings_name_check" CHECK("name" is null or length("name") between 1 and 200)
);
--> statement-breakpoint
INSERT INTO `__new_phone_recordings`(`recording_id`, `device_id`, `state`, `track_run_id`, `sha256`, `time_uncertain`, `received_at_ms`, `deleted_at_ms`) SELECT `recording_id`, `device_id`, `state`, `track_run_id`, `sha256`, `time_uncertain`, `received_at_ms`, `deleted_at_ms` FROM `phone_recordings`;--> statement-breakpoint
DROP TABLE `phone_recordings`;--> statement-breakpoint
ALTER TABLE `__new_phone_recordings` RENAME TO `phone_recordings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_phone_operations` (
	`device_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`kind` text NOT NULL,
	`recording_id` text NOT NULL,
	`done_at_ms` integer NOT NULL,
	CONSTRAINT `phone_operations_pk` PRIMARY KEY(`device_id`, `operation_id`),
	CONSTRAINT `fk_phone_operations_device_id_phone_devices_device_id_fk` FOREIGN KEY (`device_id`) REFERENCES `phone_devices`(`device_id`) ON DELETE CASCADE,
	CONSTRAINT "phone_operations_kind_check" CHECK("kind" in ('delete', 'rename', 'note'))
);
--> statement-breakpoint
INSERT INTO `__new_phone_operations`(`device_id`, `operation_id`, `kind`, `recording_id`, `done_at_ms`) SELECT `device_id`, `operation_id`, `kind`, `recording_id`, `done_at_ms` FROM `phone_operations`;--> statement-breakpoint
DROP TABLE `phone_operations`;--> statement-breakpoint
ALTER TABLE `__new_phone_operations` RENAME TO `phone_operations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `phone_recordings_track_run_idx` ON `phone_recordings` (`track_run_id`);