ALTER TABLE `chat_discussions` ADD `focus` text;--> statement-breakpoint
ALTER TABLE `chat_discussions` ADD `limited` integer DEFAULT false NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chat_discussions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`title` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`started_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`focus` text,
	`limited` integer DEFAULT false NOT NULL,
	CONSTRAINT "chat_discussions_focus_check" CHECK("focus" is null or json_valid("focus")),
	CONSTRAINT "chat_discussions_title_check" CHECK(length("title") between 1 and 200)
);
--> statement-breakpoint
INSERT INTO `__new_chat_discussions`(`id`, `title`, `provider`, `model`, `effort`, `started_at_ms`, `updated_at_ms`) SELECT `id`, `title`, `provider`, `model`, `effort`, `started_at_ms`, `updated_at_ms` FROM `chat_discussions`;--> statement-breakpoint
DROP TABLE `chat_discussions`;--> statement-breakpoint
ALTER TABLE `__new_chat_discussions` RENAME TO `chat_discussions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `chat_discussions_updated_idx` ON `chat_discussions` (`updated_at_ms`);