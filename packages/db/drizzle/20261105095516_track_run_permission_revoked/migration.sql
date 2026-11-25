PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_track_runs` (
	`id` integer PRIMARY KEY,
	`uid` text NOT NULL UNIQUE,
	`track_key` text NOT NULL,
	`source_kind` text NOT NULL,
	`device_id` integer,
	`app_id` integer,
	`sample_rate` integer DEFAULT 16000 NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`end_reason` text,
	`started_wall_ms` integer NOT NULL,
	`ended_wall_ms` integer,
	`sample_end` integer,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT `fk_track_runs_device_id_devices_id_fk` FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`),
	CONSTRAINT `fk_track_runs_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`),
	CONSTRAINT "track_runs_source_kind_check" CHECK("source_kind" in ('input', 'app', 'system', 'phone')),
	CONSTRAINT "track_runs_state_check" CHECK("state" in ('open', 'closed', 'sealed')),
	CONSTRAINT "track_runs_end_reason_check" CHECK("end_reason" in ('stopped', 'paused', 'device_lost', 'device_changed', 'format_changed', 'sleep', 'released', 'helper_exit', 'recovered', 'permission_revoked')),
	CONSTRAINT "track_runs_sample_rate_check" CHECK("sample_rate" > 0),
	CONSTRAINT "track_runs_end_check" CHECK(("state" = 'open' and "ended_wall_ms" is null) or ("state" <> 'open' and "ended_wall_ms" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_track_runs`(`id`, `uid`, `track_key`, `source_kind`, `device_id`, `app_id`, `sample_rate`, `state`, `end_reason`, `started_wall_ms`, `ended_wall_ms`, `sample_end`, `updated_at_ms`) SELECT `id`, `uid`, `track_key`, `source_kind`, `device_id`, `app_id`, `sample_rate`, `state`, `end_reason`, `started_wall_ms`, `ended_wall_ms`, `sample_end`, `updated_at_ms` FROM `track_runs`;--> statement-breakpoint
DROP TABLE `track_runs`;--> statement-breakpoint
ALTER TABLE `__new_track_runs` RENAME TO `track_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `track_runs_track_key_started_idx` ON `track_runs` (`track_key`,`started_wall_ms`);--> statement-breakpoint
CREATE INDEX `track_runs_started_idx` ON `track_runs` (`started_wall_ms`);