CREATE TABLE `chat_discussions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`title` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`started_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "chat_discussions_title_check" CHECK(length("title") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` integer PRIMARY KEY,
	`discussion_id` integer NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`at_ms` integer NOT NULL,
	`tools` text DEFAULT '[]' NOT NULL,
	`streaming` integer DEFAULT false NOT NULL,
	`stopped` integer DEFAULT false NOT NULL,
	`failure` text,
	CONSTRAINT `fk_chat_messages_discussion_id_chat_discussions_id_fk` FOREIGN KEY (`discussion_id`) REFERENCES `chat_discussions`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chat_messages_role_check" CHECK("role" in ('user', 'agent')),
	CONSTRAINT "chat_messages_tools_check" CHECK(json_valid("tools")),
	CONSTRAINT "chat_messages_failure_check" CHECK("failure" is null or json_valid("failure"))
);
--> statement-breakpoint
CREATE TABLE `chat_reads` (
	`discussion_id` integer NOT NULL,
	`kind` text NOT NULL,
	`ref_id` integer NOT NULL,
	`generation` integer,
	CONSTRAINT `chat_reads_pk` PRIMARY KEY(`discussion_id`, `kind`, `ref_id`),
	CONSTRAINT `fk_chat_reads_discussion_id_chat_discussions_id_fk` FOREIGN KEY (`discussion_id`) REFERENCES `chat_discussions`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chat_reads_kind_check" CHECK("kind" in ('episode', 'person', 'item'))
);
--> statement-breakpoint
CREATE INDEX `chat_discussions_updated_idx` ON `chat_discussions` (`updated_at_ms`);--> statement-breakpoint
CREATE INDEX `chat_messages_discussion_idx` ON `chat_messages` (`discussion_id`,`id`);--> statement-breakpoint
CREATE INDEX `chat_reads_ref_idx` ON `chat_reads` (`kind`,`ref_id`);