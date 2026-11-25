CREATE TABLE `speaker_embeddings` (
	`id` integer PRIMARY KEY,
	`run_id` integer NOT NULL,
	`episode_id` integer NOT NULL,
	`label` text NOT NULL,
	`embedder_version` text NOT NULL,
	`vector` blob NOT NULL,
	`speech_ms` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	CONSTRAINT `fk_speaker_embeddings_run_id_analysis_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `analysis_runs`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_speaker_embeddings_episode_id_episodes_id_fk` FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON DELETE CASCADE,
	CONSTRAINT "speaker_embeddings_vector_check" CHECK(length("vector") = 1024)
);
--> statement-breakpoint
CREATE TABLE `voice_passes` (
	`run_id` integer NOT NULL,
	`embedder_version` text NOT NULL,
	`finished_at_ms` integer NOT NULL,
	CONSTRAINT `voice_passes_pk` PRIMARY KEY(`run_id`, `embedder_version`),
	CONSTRAINT `fk_voice_passes_run_id_analysis_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `analysis_runs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `speaker_embeddings_unique` ON `speaker_embeddings` (`run_id`,`label`,`embedder_version`);--> statement-breakpoint
CREATE INDEX `speaker_embeddings_episode_idx` ON `speaker_embeddings` (`episode_id`);