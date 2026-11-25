CREATE TABLE `self_echoes` (
	`speech_region_id` integer PRIMARY KEY,
	`method` text NOT NULL,
	`verdict` text NOT NULL,
	`voiced_ms` integer NOT NULL,
	`covered_ms` integer NOT NULL,
	`echo_ms` integer NOT NULL,
	`near_end_ms` integer NOT NULL,
	`lag_ms` integer,
	`correlation` real NOT NULL,
	`spans` text NOT NULL,
	`judged_at_ms` integer NOT NULL,
	CONSTRAINT `fk_self_echoes_speech_region_id_speech_regions_id_fk` FOREIGN KEY (`speech_region_id`) REFERENCES `speech_regions`(`id`) ON DELETE CASCADE,
	CONSTRAINT "self_echoes_verdict_check" CHECK("verdict" in ('echo', 'near_end', 'no_reference')),
	CONSTRAINT "self_echoes_spans_check" CHECK(json_valid("spans") and json_type("spans") = 'array'),
	CONSTRAINT "self_echoes_ms_check" CHECK("voiced_ms" >= 0 and "covered_ms" >= 0 and "echo_ms" >= 0 and "near_end_ms" >= 0)
);
