CREATE TABLE `voice_links` (
	`run_id` integer PRIMARY KEY,
	`merged` integer NOT NULL,
	`finished_at_ms` integer NOT NULL,
	CONSTRAINT `fk_voice_links_run_id_analysis_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `analysis_runs`(`id`) ON DELETE CASCADE
);
