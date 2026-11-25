CREATE TABLE `phone_devices` (
	`device_id` text PRIMARY KEY,
	`name` text NOT NULL,
	`credential_hash` blob NOT NULL,
	`paired_at_ms` integer NOT NULL,
	`last_contact_at_ms` integer,
	`revoked_at_ms` integer,
	`uploads` integer DEFAULT 0 NOT NULL,
	`reads` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "phone_devices_name_check" CHECK(length("name") between 1 and 64),
	CONSTRAINT "phone_devices_credential_check" CHECK(length("credential_hash") = 32),
	CONSTRAINT "phone_devices_counts_check" CHECK("uploads" >= 0 and "reads" >= 0 and "deletions" >= 0)
);
--> statement-breakpoint
CREATE TABLE `phone_operations` (
	`device_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`kind` text NOT NULL,
	`recording_id` text NOT NULL,
	`done_at_ms` integer NOT NULL,
	CONSTRAINT `phone_operations_pk` PRIMARY KEY(`device_id`, `operation_id`),
	CONSTRAINT `fk_phone_operations_device_id_phone_devices_device_id_fk` FOREIGN KEY (`device_id`) REFERENCES `phone_devices`(`device_id`) ON DELETE CASCADE,
	CONSTRAINT "phone_operations_kind_check" CHECK("kind" in ('delete'))
);
--> statement-breakpoint
CREATE TABLE `phone_uploads` (
	`recording_id` text PRIMARY KEY,
	`device_id` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`announced_at_ms` integer NOT NULL,
	CONSTRAINT "phone_uploads_bytes_check" CHECK("bytes" > 0),
	CONSTRAINT "phone_uploads_sha_check" CHECK(length("sha256") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `phone_devices_credential_unique` ON `phone_devices` (`credential_hash`);--> statement-breakpoint
CREATE INDEX `phone_uploads_device_idx` ON `phone_uploads` (`device_id`);