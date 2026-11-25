CREATE TABLE `context_items` (
	`id` integer PRIMARY KEY,
	`kind` text NOT NULL,
	`track_run_id` integer NOT NULL,
	`anchor_sample` integer NOT NULL,
	`span_start` integer,
	`span_end` integer,
	`body` text DEFAULT '' NOT NULL,
	`title` text,
	`file_sha256` text,
	`file_bytes` integer,
	`media_type` text,
	`preview` text,
	`search_text` text DEFAULT '' NOT NULL,
	`origin` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT `fk_context_items_track_run_id_track_runs_id_fk` FOREIGN KEY (`track_run_id`) REFERENCES `track_runs`(`id`),
	CONSTRAINT "context_items_kind_check" CHECK("kind" in ('note', 'link', 'image', 'file')),
	CONSTRAINT "context_items_origin_check" CHECK("origin" in ('app', 'tray', 'agent', 'phone')),
	CONSTRAINT "context_items_preview_check" CHECK("preview" in ('jpeg', 'png')),
	CONSTRAINT "context_items_anchor_check" CHECK("anchor_sample" >= 0),
	CONSTRAINT "context_items_span_check" CHECK(("span_start" is null and "span_end" is null) or ("span_start" is not null and "span_end" > "span_start")),
	CONSTRAINT "context_items_file_check" CHECK(("kind" in ('image', 'file')) = ("file_sha256" is not null and "file_bytes" is not null and "media_type" is not null)),
	CONSTRAINT "context_items_preview_kind_check" CHECK("preview" is null or "kind" = 'image')
);
--> statement-breakpoint
CREATE INDEX `context_items_anchor_idx` ON `context_items` (`track_run_id`,`anchor_sample`);--> statement-breakpoint
CREATE INDEX `context_items_span_idx` ON `context_items` (`track_run_id`,`span_start`) WHERE "context_items"."span_start" is not null;--> statement-breakpoint
CREATE INDEX `context_items_file_idx` ON `context_items` (`file_sha256`) WHERE "context_items"."file_sha256" is not null;--> statement-breakpoint
-- Full-text index over context_items.search_text (ADR 024): a note's text, a
-- link's title and address words, a file's name, in the fr-norm form of
-- segments_fts. Maintained explicitly with the rows, never by triggers.
CREATE VIRTUAL TABLE `context_fts` USING fts5(
	search_text,
	content='context_items',
	content_rowid='id',
	tokenize='unicode61 remove_diacritics 2',
	prefix='2 3'
);
--> statement-breakpoint
INSERT INTO `context_fts`(`context_fts`, `rank`) VALUES ('secure-delete', 1);
