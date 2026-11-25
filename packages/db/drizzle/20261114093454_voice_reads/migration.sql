CREATE TABLE `voice_reads` (
	`id` integer PRIMARY KEY,
	`person_id` integer NOT NULL,
	`embedder_version` text NOT NULL,
	`vector` blob NOT NULL,
	`speech_ms` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	CONSTRAINT `fk_voice_reads_person_id_people_id_fk` FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON DELETE CASCADE,
	CONSTRAINT "voice_reads_vector_check" CHECK(length("vector") = 1024)
);
--> statement-breakpoint
CREATE INDEX `voice_reads_person_idx` ON `voice_reads` (`person_id`);