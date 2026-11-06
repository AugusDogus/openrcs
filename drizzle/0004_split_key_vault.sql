-- Rows written under the old server-held-key scheme cannot be read under the
-- split-key vault (docs/security.md), so they are removed. SQLite cannot add a
-- NOT NULL column without a default, hence DEFAULT '' on the new columns; the
-- app always writes real values.
DELETE FROM `message`;--> statement-breakpoint
DELETE FROM `conversation`;--> statement-breakpoint
DELETE FROM `sync_state`;--> statement-breakpoint
DELETE FROM `gm_session`;--> statement-breakpoint
CREATE TABLE `key_slot` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`dek_id` text NOT NULL,
	`verifier` text NOT NULL,
	`wrapped_dek` text NOT NULL,
	`grant_id` text,
	`payload_json` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`consumed_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grant_id`) REFERENCES `oauth_grant`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "key_slot_kind_check" CHECK("key_slot"."kind" in ('device', 'oauth_code', 'oauth_refresh'))
);
--> statement-breakpoint
CREATE INDEX `key_slot_user_kind_idx` ON `key_slot` (`user_id`,`kind`);--> statement-breakpoint
CREATE INDEX `key_slot_grant_idx` ON `key_slot` (`grant_id`);--> statement-breakpoint
CREATE TABLE `oauth_client` (
	`client_id` text PRIMARY KEY NOT NULL,
	`client_secret_hash` text,
	`client_name` text NOT NULL,
	`redirect_uris_json` text NOT NULL,
	`token_endpoint_auth_method` text NOT NULL,
	`scope` text NOT NULL,
	`client_uri` text,
	`logo_uri` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`scope` text NOT NULL,
	`dek_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`revoked_reason` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_grant_user_idx` ON `oauth_grant` (`user_id`);--> statement-breakpoint
CREATE TABLE `request_throttle` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `conversation` ADD `content_enc` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversation` ADD `synced_message_ts` integer;--> statement-breakpoint
ALTER TABLE `conversation` ADD `status` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `gm_session` ADD `dek_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `message` ADD `content_enc` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `message` ADD `tmp_id` text;