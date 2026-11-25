CREATE TABLE `self_playbacks` (
	`id` integer PRIMARY KEY,
	`started_wall_ms` integer NOT NULL,
	`ended_wall_ms` integer NOT NULL,
	`route` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "self_playbacks_route_check" CHECK("route" in ('speakers', 'headphones')),
	CONSTRAINT "self_playbacks_span_check" CHECK("ended_wall_ms" >= "started_wall_ms")
);
--> statement-breakpoint
CREATE INDEX `self_playbacks_started_idx` ON `self_playbacks` (`started_wall_ms`);