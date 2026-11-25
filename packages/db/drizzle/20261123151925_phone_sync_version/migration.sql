ALTER TABLE `phone_devices` ADD `sync_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_phone_operations` (
	`device_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`kind` text NOT NULL,
	`recording_id` text NOT NULL,
	`done_at_ms` integer NOT NULL,
	CONSTRAINT `phone_operations_pk` PRIMARY KEY(`device_id`, `operation_id`),
	CONSTRAINT `fk_phone_operations_device_id_phone_devices_device_id_fk` FOREIGN KEY (`device_id`) REFERENCES `phone_devices`(`device_id`) ON DELETE CASCADE,
	CONSTRAINT "phone_operations_kind_check" CHECK("kind" in ('delete', 'rename', 'note', 'tag', 'voice'))
);
--> statement-breakpoint
INSERT INTO `__new_phone_operations`(`device_id`, `operation_id`, `kind`, `recording_id`, `done_at_ms`) SELECT `device_id`, `operation_id`, `kind`, `recording_id`, `done_at_ms` FROM `phone_operations`;--> statement-breakpoint
DROP TABLE `phone_operations`;--> statement-breakpoint
ALTER TABLE `__new_phone_operations` RENAME TO `phone_operations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;