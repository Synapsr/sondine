CREATE TABLE `journal_citations` (
	`item_id` integer NOT NULL,
	`ord` integer NOT NULL,
	`segment_id` integer NOT NULL,
	CONSTRAINT `journal_citations_pk` PRIMARY KEY(`item_id`, `ord`),
	CONSTRAINT `fk_journal_citations_item_id_journal_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `journal_items`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `journal_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`run_id` integer NOT NULL,
	`episode_id` integer NOT NULL,
	`kind` text NOT NULL,
	`seq` integer NOT NULL,
	`text` text NOT NULL,
	`who_ref` text,
	`to_ref` text,
	`due` text,
	`due_text` text,
	`start_ms` integer NOT NULL,
	CONSTRAINT `fk_journal_items_run_id_journal_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `journal_runs`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_journal_items_episode_id_episodes_id_fk` FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON DELETE CASCADE,
	CONSTRAINT "journal_items_kind_check" CHECK("kind" in ('event', 'commitment'))
);
--> statement-breakpoint
CREATE TABLE `journal_mark_spans` (
	`mark_id` integer NOT NULL,
	`track_run_id` integer NOT NULL,
	`sample_start` integer NOT NULL,
	`sample_end` integer NOT NULL,
	`wall_start_ms` integer NOT NULL,
	`wall_end_ms` integer NOT NULL,
	CONSTRAINT `journal_mark_spans_pk` PRIMARY KEY(`mark_id`, `track_run_id`, `sample_start`),
	CONSTRAINT `fk_journal_mark_spans_mark_id_journal_marks_id_fk` FOREIGN KEY (`mark_id`) REFERENCES `journal_marks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_journal_mark_spans_track_run_id_track_runs_id_fk` FOREIGN KEY (`track_run_id`) REFERENCES `track_runs`(`id`),
	CONSTRAINT "journal_mark_spans_range_check" CHECK("sample_end" >= "sample_start")
);
--> statement-breakpoint
CREATE TABLE `journal_marks` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`kind` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`text` text,
	`due` text,
	`due_edited` integer DEFAULT false NOT NULL,
	`generated_text` text NOT NULL,
	`source_start_ms` integer NOT NULL,
	`source_end_ms` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "journal_marks_kind_check" CHECK("kind" in ('event', 'commitment')),
	CONSTRAINT "journal_marks_status_check" CHECK("status" in ('open', 'done', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE `journal_runs` (
	`id` integer PRIMARY KEY,
	`episode_id` integer NOT NULL,
	`asr_run_id` integer NOT NULL,
	`input_hash` text NOT NULL,
	`config_key` text NOT NULL,
	`engine_id` text NOT NULL,
	`model_sha256` text,
	`status` text DEFAULT 'running' NOT NULL,
	`stale` integer DEFAULT false NOT NULL,
	`speaker_refs` text DEFAULT '{}' NOT NULL,
	`metrics` text DEFAULT '{}' NOT NULL,
	`error_code` text,
	`started_at_ms` integer NOT NULL,
	`finished_at_ms` integer,
	CONSTRAINT `fk_journal_runs_episode_id_episodes_id_fk` FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_journal_runs_asr_run_id_analysis_runs_id_fk` FOREIGN KEY (`asr_run_id`) REFERENCES `analysis_runs`(`id`) ON DELETE CASCADE,
	CONSTRAINT "journal_runs_status_check" CHECK("status" in ('running', 'published', 'failed', 'cancelled', 'abandoned')),
	CONSTRAINT "journal_runs_speaker_refs_check" CHECK(json_valid("speaker_refs")),
	CONSTRAINT "journal_runs_metrics_check" CHECK(json_valid("metrics"))
);
--> statement-breakpoint
CREATE INDEX `journal_citations_segment_idx` ON `journal_citations` (`segment_id`);--> statement-breakpoint
CREATE INDEX `journal_items_run_idx` ON `journal_items` (`run_id`);--> statement-breakpoint
CREATE INDEX `journal_items_episode_idx` ON `journal_items` (`episode_id`);--> statement-breakpoint
CREATE INDEX `journal_items_kind_start_idx` ON `journal_items` (`kind`,`start_ms`);--> statement-breakpoint
CREATE INDEX `journal_mark_spans_anchor_idx` ON `journal_mark_spans` (`track_run_id`,`sample_start`);--> statement-breakpoint
CREATE INDEX `journal_mark_spans_wall_idx` ON `journal_mark_spans` (`wall_start_ms`);--> statement-breakpoint
CREATE INDEX `journal_runs_episode_idx` ON `journal_runs` (`episode_id`,`status`);