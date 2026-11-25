CREATE TABLE `calls` (
	`id` integer PRIMARY KEY,
	`uid` text NOT NULL UNIQUE,
	`session_id` text NOT NULL,
	`bundle_id` text NOT NULL,
	`app_id` integer,
	`via` text NOT NULL,
	`input_device_uid` text,
	`started_wall_ms` integer NOT NULL,
	`started_continuous_us` integer NOT NULL,
	`ended_wall_ms` integer,
	`ended_continuous_us` integer,
	`end_reason` text,
	`last_seen_wall_ms` integer NOT NULL,
	`last_seen_continuous_us` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT `fk_calls_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`),
	CONSTRAINT "calls_via_check" CHECK("via" in ('call_app', 'call_daemon', 'browser')),
	CONSTRAINT "calls_end_reason_check" CHECK("end_reason" in ('ended', 'lost')),
	CONSTRAINT "calls_end_check" CHECK(("ended_wall_ms" is null and "ended_continuous_us" is null and "end_reason" is null) or ("ended_wall_ms" is not null and "ended_continuous_us" is not null and "end_reason" is not null and "ended_continuous_us" >= "started_continuous_us")),
	CONSTRAINT "calls_last_seen_check" CHECK("last_seen_continuous_us" >= "started_continuous_us")
);
--> statement-breakpoint
ALTER TABLE `speech_regions` ADD `attributed_app_id` integer REFERENCES apps(id);--> statement-breakpoint
CREATE INDEX `calls_started_idx` ON `calls` (`started_wall_ms`);