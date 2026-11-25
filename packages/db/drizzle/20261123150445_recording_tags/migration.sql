CREATE TABLE `recording_tags` (
	`tag_id` integer NOT NULL,
	`track_run_id` integer NOT NULL,
	`anchor_sample` integer NOT NULL,
	`origin` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	CONSTRAINT `recording_tags_pk` PRIMARY KEY(`tag_id`, `track_run_id`, `anchor_sample`),
	CONSTRAINT `fk_recording_tags_tag_id_tags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_recording_tags_track_run_id_track_runs_id_fk` FOREIGN KEY (`track_run_id`) REFERENCES `track_runs`(`id`),
	CONSTRAINT "recording_tags_origin_check" CHECK("origin" in ('app', 'tray', 'agent', 'phone')),
	CONSTRAINT "recording_tags_anchor_check" CHECK("anchor_sample" >= 0)
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY,
	`name` text NOT NULL,
	`key` text NOT NULL UNIQUE,
	`created_at_ms` integer NOT NULL,
	`used_at_ms` integer NOT NULL,
	CONSTRAINT "tags_name_check" CHECK(length("name") between 1 and 400),
	CONSTRAINT "tags_key_check" CHECK(length("key") between 1 and 400)
);
--> statement-breakpoint
CREATE INDEX `recording_tags_anchor_idx` ON `recording_tags` (`track_run_id`,`anchor_sample`);--> statement-breakpoint
CREATE INDEX `tags_used_idx` ON `tags` (`used_at_ms`);