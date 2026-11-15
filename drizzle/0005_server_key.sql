-- Data from before the server key (docs/security.md) is sealed under keys
-- only clients held, so the server can never open it again. It is removed;
-- users pair once more and openrcs syncs from the phone.
DELETE FROM `message`;--> statement-breakpoint
DELETE FROM `conversation`;--> statement-breakpoint
DELETE FROM `sync_state`;--> statement-breakpoint
DELETE FROM `gm_session`;--> statement-breakpoint
CREATE TABLE `user_key` (
	`user_id` text PRIMARY KEY NOT NULL,
	`dek_id` text NOT NULL,
	`wrapped_dek` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
