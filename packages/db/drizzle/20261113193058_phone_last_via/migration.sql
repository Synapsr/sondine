ALTER TABLE `phone_devices` ADD `last_via` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_phone_devices` (
	`device_id` text PRIMARY KEY,
	`name` text NOT NULL,
	`credential_hash` blob NOT NULL,
	`paired_at_ms` integer NOT NULL,
	`last_contact_at_ms` integer,
	`last_via` text,
	`revoked_at_ms` integer,
	`uploads` integer DEFAULT 0 NOT NULL,
	`reads` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "phone_devices_name_check" CHECK(length("name") between 1 and 64),
	CONSTRAINT "phone_devices_credential_check" CHECK(length("credential_hash") = 32),
	CONSTRAINT "phone_devices_last_via_check" CHECK("last_via" in ('lan', 'tailnet', 'loopback')),
	CONSTRAINT "phone_devices_counts_check" CHECK("uploads" >= 0 and "reads" >= 0 and "deletions" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_phone_devices`(`device_id`, `name`, `credential_hash`, `paired_at_ms`, `last_contact_at_ms`, `revoked_at_ms`, `uploads`, `reads`, `deletions`) SELECT `device_id`, `name`, `credential_hash`, `paired_at_ms`, `last_contact_at_ms`, `revoked_at_ms`, `uploads`, `reads`, `deletions` FROM `phone_devices`;--> statement-breakpoint
DROP TABLE `phone_devices`;--> statement-breakpoint
ALTER TABLE `__new_phone_devices` RENAME TO `phone_devices`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `phone_devices_credential_unique` ON `phone_devices` (`credential_hash`);