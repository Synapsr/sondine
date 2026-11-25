CREATE TABLE `web_play_marks` (
	`play_id` integer NOT NULL,
	`wall_ms` integer NOT NULL,
	`position_ms` integer NOT NULL,
	`rate` real NOT NULL,
	`duration_ms` integer,
	`ad` integer NOT NULL,
	CONSTRAINT `web_play_marks_pk` PRIMARY KEY(`play_id`, `wall_ms`),
	CONSTRAINT `fk_web_play_marks_play_id_web_plays_id_fk` FOREIGN KEY (`play_id`) REFERENCES `web_plays`(`id`) ON DELETE CASCADE,
	CONSTRAINT "web_play_marks_position_check" CHECK("position_ms" >= 0 and "rate" >= 0)
);
--> statement-breakpoint
CREATE TABLE `web_plays` (
	`id` integer PRIMARY KEY,
	`app_id` integer NOT NULL,
	`site` text NOT NULL,
	`page_key` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`started_wall_ms` integer NOT NULL,
	`ended_wall_ms` integer,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT `fk_web_plays_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`),
	CONSTRAINT "web_plays_span_check" CHECK("ended_wall_ms" is null or "ended_wall_ms" >= "started_wall_ms")
);
--> statement-breakpoint
ALTER TABLE `episodes` ADD `page_key` text;--> statement-breakpoint
CREATE INDEX `web_plays_started_idx` ON `web_plays` (`started_wall_ms`);--> statement-breakpoint
CREATE INDEX `web_plays_page_idx` ON `web_plays` (`page_key`,`started_wall_ms`);--> statement-breakpoint
CREATE INDEX `episodes_page_idx` ON `episodes` (`page_key`) WHERE "episodes"."page_key" is not null;