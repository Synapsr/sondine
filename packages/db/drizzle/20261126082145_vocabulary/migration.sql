CREATE TABLE `vocabulary_checks` (
	`id` integer PRIMARY KEY,
	`segment_id` integer NOT NULL,
	`char_start` integer NOT NULL,
	`name` text NOT NULL,
	`verdict` text NOT NULL,
	`config_key` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	CONSTRAINT `fk_vocabulary_checks_segment_id_segments_id_fk` FOREIGN KEY (`segment_id`) REFERENCES `segments`(`id`) ON DELETE CASCADE,
	CONSTRAINT `vocabulary_checks_word_unique` UNIQUE(`segment_id`,`char_start`,`name`),
	CONSTRAINT "vocabulary_checks_verdict_check" CHECK("verdict" in ('user_word', 'as_written'))
);
--> statement-breakpoint
CREATE TABLE `vocabulary_passes` (
	`episode_id` integer PRIMARY KEY,
	`run_id` integer NOT NULL,
	`names_key` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`candidates` integer NOT NULL,
	`corrected` integer NOT NULL,
	`finished_at_ms` integer NOT NULL,
	CONSTRAINT `fk_vocabulary_passes_episode_id_episodes_id_fk` FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_vocabulary_passes_run_id_analysis_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `analysis_runs`(`id`) ON DELETE CASCADE,
	CONSTRAINT "vocabulary_passes_status_check" CHECK("status" in ('done', 'failed')),
	CONSTRAINT "vocabulary_passes_counts_check" CHECK("attempts" >= 0 and "candidates" >= 0)
);
--> statement-breakpoint
CREATE TABLE `vocabulary_words` (
	`id` integer PRIMARY KEY,
	`word` text NOT NULL,
	`key` text NOT NULL UNIQUE,
	`note` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "vocabulary_words_word_check" CHECK(length("word") between 1 and 60),
	CONSTRAINT "vocabulary_words_key_check" CHECK(length("key") between 1 and 60),
	CONSTRAINT "vocabulary_words_note_check" CHECK("note" is null or length("note") <= 200)
);
