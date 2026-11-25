CREATE TABLE `foreground_spans` (
	`id` integer PRIMARY KEY,
	`speech_region_id` integer NOT NULL,
	`track_run_id` integer NOT NULL,
	`sample_start` integer NOT NULL,
	`sample_end` integer NOT NULL,
	`wall_start_ms` integer NOT NULL,
	`wall_end_ms` integer NOT NULL,
	`app_id` integer NOT NULL,
	CONSTRAINT `fk_foreground_spans_speech_region_id_speech_regions_id_fk` FOREIGN KEY (`speech_region_id`) REFERENCES `speech_regions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_foreground_spans_track_run_id_track_runs_id_fk` FOREIGN KEY (`track_run_id`) REFERENCES `track_runs`(`id`),
	CONSTRAINT `fk_foreground_spans_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`),
	CONSTRAINT `foreground_spans_region_start_unique` UNIQUE(`speech_region_id`,`sample_start`),
	CONSTRAINT "foreground_spans_samples_check" CHECK("sample_end" > "sample_start"),
	CONSTRAINT "foreground_spans_wall_check" CHECK("wall_end_ms" >= "wall_start_ms")
);
--> statement-breakpoint
CREATE INDEX `foreground_spans_track_run_sample_idx` ON `foreground_spans` (`track_run_id`,`sample_start`);--> statement-breakpoint
CREATE INDEX `foreground_spans_app_idx` ON `foreground_spans` (`app_id`,`wall_start_ms`);--> statement-breakpoint
CREATE INDEX `foreground_spans_wall_start_idx` ON `foreground_spans` (`wall_start_ms`);