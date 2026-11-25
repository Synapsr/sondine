ALTER TABLE `segments` ADD `original_text` text;--> statement-breakpoint
ALTER TABLE `segments` ADD `edit_id` integer REFERENCES user_assertions(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `segments_edit_idx` ON `segments` (`edit_id`) WHERE "segments"."edit_id" is not null;