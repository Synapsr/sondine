CREATE TABLE `phone_recordings` (
	`recording_id` text PRIMARY KEY,
	`device_id` text NOT NULL,
	`state` text DEFAULT 'stored' NOT NULL,
	`track_run_id` integer,
	`sha256` text,
	`time_uncertain` integer DEFAULT false NOT NULL,
	`received_at_ms` integer NOT NULL,
	`deleted_at_ms` integer,
	CONSTRAINT `fk_phone_recordings_track_run_id_track_runs_id_fk` FOREIGN KEY (`track_run_id`) REFERENCES `track_runs`(`id`),
	CONSTRAINT "phone_recordings_state_check" CHECK("state" in ('stored', 'deleted')),
	CONSTRAINT "phone_recordings_tombstone_check" CHECK(("state" = 'stored' and "track_run_id" is not null and "sha256" is not null and "deleted_at_ms" is null)
        or ("state" = 'deleted' and "track_run_id" is null and "sha256" is null and "deleted_at_ms" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `phone_recordings_track_run_idx` ON `phone_recordings` (`track_run_id`);