CREATE TABLE `same_moment_links` (
	`phone_episode_id` integer NOT NULL,
	`mac_episode_id` integer NOT NULL,
	`phone_generation` integer NOT NULL,
	`mac_generation` integer NOT NULL,
	`method` text NOT NULL,
	`linked` integer NOT NULL,
	`offset_ms` integer,
	`drift_ppm` real,
	`anchor_ms` integer,
	`score` real,
	`shared_from_ms` integer,
	`shared_to_ms` integer,
	`journal_source` text,
	`source_chosen` integer DEFAULT false NOT NULL,
	`measure` text DEFAULT '{}' NOT NULL,
	`checked_at_ms` integer NOT NULL,
	CONSTRAINT `same_moment_links_pk` PRIMARY KEY(`phone_episode_id`, `mac_episode_id`),
	CONSTRAINT `fk_same_moment_links_phone_episode_id_episodes_id_fk` FOREIGN KEY (`phone_episode_id`) REFERENCES `episodes`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_same_moment_links_mac_episode_id_episodes_id_fk` FOREIGN KEY (`mac_episode_id`) REFERENCES `episodes`(`id`) ON DELETE CASCADE,
	CONSTRAINT "same_moment_links_source_check" CHECK("journal_source" in ('phone', 'mac')),
	CONSTRAINT "same_moment_links_measure_check" CHECK(json_valid("measure")),
	CONSTRAINT "same_moment_links_linked_check" CHECK(("linked" = 1 and "offset_ms" is not null and "drift_ppm" is not null
          and "anchor_ms" is not null and "score" is not null
          and "shared_from_ms" is not null and "shared_to_ms" >= "shared_from_ms"
          and "journal_source" is not null)
        or ("linked" = 0 and "offset_ms" is null and "shared_from_ms" is null
          and "shared_to_ms" is null and "journal_source" is null)),
	CONSTRAINT "same_moment_links_pair_check" CHECK("phone_episode_id" <> "mac_episode_id")
);
--> statement-breakpoint
CREATE INDEX `same_moment_links_mac_idx` ON `same_moment_links` (`mac_episode_id`);