ALTER TABLE `kept_audio` ADD `origin` text DEFAULT 'recording' NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_kept_audio` (
	`id` integer PRIMARY KEY,
	`track_run_id` integer NOT NULL,
	`sample_start` integer NOT NULL,
	`sample_end` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`origin` text DEFAULT 'recording' NOT NULL,
	CONSTRAINT `fk_kept_audio_track_run_id_track_runs_id_fk` FOREIGN KEY (`track_run_id`) REFERENCES `track_runs`(`id`) ON DELETE CASCADE,
	CONSTRAINT "kept_audio_span_check" CHECK("sample_end" > "sample_start"),
	CONSTRAINT "kept_audio_origin_check" CHECK("origin" in ('recording', 'moment'))
);
--> statement-breakpoint
INSERT INTO `__new_kept_audio`(`id`, `track_run_id`, `sample_start`, `sample_end`, `created_at_ms`) SELECT `id`, `track_run_id`, `sample_start`, `sample_end`, `created_at_ms` FROM `kept_audio`;--> statement-breakpoint
DROP TABLE `kept_audio`;--> statement-breakpoint
ALTER TABLE `__new_kept_audio` RENAME TO `kept_audio`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `kept_audio_run_idx` ON `kept_audio` (`track_run_id`,`sample_start`);