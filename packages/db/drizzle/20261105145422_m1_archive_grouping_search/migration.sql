ALTER TABLE `segments` ADD `search_text` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `chunks` ADD `archive_byte_offset` integer;--> statement-breakpoint
ALTER TABLE `episodes` ADD `grouping_key` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chunks` (
	`id` integer PRIMARY KEY,
	`spool_file_id` integer NOT NULL,
	`track_run_id` integer NOT NULL,
	`byte_offset` integer NOT NULL,
	`byte_length` integer NOT NULL,
	`sample_start` integer NOT NULL,
	`sample_count` integer NOT NULL,
	`host_ticks` integer,
	`continuous_us` integer,
	`wall_ms` integer NOT NULL,
	`crc32` integer NOT NULL,
	`audio_state` text DEFAULT 'present' NOT NULL,
	`archive_rel_path` text,
	`archive_byte_offset` integer,
	CONSTRAINT `fk_chunks_spool_file_id_spool_files_id_fk` FOREIGN KEY (`spool_file_id`) REFERENCES `spool_files`(`id`),
	CONSTRAINT `fk_chunks_track_run_id_track_runs_id_fk` FOREIGN KEY (`track_run_id`) REFERENCES `track_runs`(`id`),
	CONSTRAINT `chunks_spool_offset_unique` UNIQUE(`spool_file_id`,`byte_offset`),
	CONSTRAINT "chunks_audio_state_check" CHECK("audio_state" in ('present', 'archived', 'expired', 'deleted')),
	CONSTRAINT "chunks_pcm16_check" CHECK("sample_count" > 0 and "byte_length" = "sample_count" * 2),
	CONSTRAINT "chunks_offset_check" CHECK("byte_offset" >= 0),
	CONSTRAINT "chunks_crc32_check" CHECK("crc32" between 0 and 4294967295),
	CONSTRAINT "chunks_archive_check" CHECK(("archive_rel_path" is null) = ("archive_byte_offset" is null) and ("archive_byte_offset" is null or "archive_byte_offset" >= 0))
);
--> statement-breakpoint
INSERT INTO `__new_chunks`(`id`, `spool_file_id`, `track_run_id`, `byte_offset`, `byte_length`, `sample_start`, `sample_count`, `host_ticks`, `continuous_us`, `wall_ms`, `crc32`, `audio_state`, `archive_rel_path`) SELECT `id`, `spool_file_id`, `track_run_id`, `byte_offset`, `byte_length`, `sample_start`, `sample_count`, `host_ticks`, `continuous_us`, `wall_ms`, `crc32`, `audio_state`, `archive_rel_path` FROM `chunks`;--> statement-breakpoint
DROP TABLE `chunks`;--> statement-breakpoint
ALTER TABLE `__new_chunks` RENAME TO `chunks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `chunks_run_sample_idx` ON `chunks` (`track_run_id`,`sample_start`);--> statement-breakpoint
CREATE INDEX `chunks_wall_idx` ON `chunks` (`wall_ms`);--> statement-breakpoint
-- The full-text index moves from segments.text to segments.search_text, the
-- fr-norm form of the text (ADR 016). Rows are reindexed by core at startup
-- (ensureSearchNormalizer) whenever the stored normalizer id differs.
DROP TABLE `segments_fts`;--> statement-breakpoint
CREATE VIRTUAL TABLE `segments_fts` USING fts5(
	search_text,
	content='segments',
	content_rowid='id',
	tokenize='unicode61 remove_diacritics 2',
	prefix='2 3'
);
--> statement-breakpoint
INSERT INTO `segments_fts`(`segments_fts`, `rank`) VALUES ('secure-delete', 1);
