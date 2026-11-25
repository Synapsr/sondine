CREATE TABLE `agent_calls` (
	`id` integer PRIMARY KEY,
	`client_id` integer NOT NULL,
	`at_ms` integer NOT NULL,
	`tool` text NOT NULL,
	`detail` text NOT NULL,
	`outcome` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`result_bytes` integer NOT NULL,
	CONSTRAINT `fk_agent_calls_client_id_agent_clients_id_fk` FOREIGN KEY (`client_id`) REFERENCES `agent_clients`(`id`) ON DELETE CASCADE,
	CONSTRAINT "agent_calls_outcome_check" CHECK("outcome" in ('ok', 'error', 'refused')),
	CONSTRAINT "agent_calls_detail_check" CHECK(json_valid("detail") and length("detail") <= 200)
);
--> statement-breakpoint
CREATE TABLE `agent_clients` (
	`id` integer PRIMARY KEY,
	`name` text NOT NULL,
	`token_hash` blob NOT NULL,
	`created_at_ms` integer NOT NULL,
	`last_used_at_ms` integer,
	`revoked_at_ms` integer,
	CONSTRAINT "agent_clients_name_check" CHECK(length(trim("name")) between 1 and 60),
	CONSTRAINT "agent_clients_token_check" CHECK(length("token_hash") = 32)
);
--> statement-breakpoint
CREATE INDEX `agent_calls_at_idx` ON `agent_calls` (`at_ms`);--> statement-breakpoint
CREATE INDEX `agent_calls_client_idx` ON `agent_calls` (`client_id`,`at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_clients_token_unique` ON `agent_clients` (`token_hash`);