-- Browser device slots are gone, and codes and refresh tokens no longer
-- carry a DEK copy: the server key (user_key) replaces both. Existing codes
-- and refresh tokens keep their ids and verifiers, so connected clients stay
-- connected.
DELETE FROM `key_slot` WHERE `kind` = 'device';--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_key_slot` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`verifier` text NOT NULL,
	`grant_id` text,
	`payload_json` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`consumed_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grant_id`) REFERENCES `oauth_grant`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "key_slot_kind_check" CHECK("__new_key_slot"."kind" in ('oauth_code', 'oauth_refresh'))
);
--> statement-breakpoint
INSERT INTO `__new_key_slot`("id", "user_id", "kind", "verifier", "grant_id", "payload_json", "created_at", "expires_at", "last_used_at", "consumed_at", "revoked_at") SELECT "id", "user_id", "kind", "verifier", "grant_id", "payload_json", "created_at", "expires_at", "last_used_at", "consumed_at", "revoked_at" FROM `key_slot`;--> statement-breakpoint
DROP TABLE `key_slot`;--> statement-breakpoint
ALTER TABLE `__new_key_slot` RENAME TO `key_slot`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `key_slot_user_kind_idx` ON `key_slot` (`user_id`,`kind`);--> statement-breakpoint
CREATE INDEX `key_slot_grant_idx` ON `key_slot` (`grant_id`);--> statement-breakpoint
ALTER TABLE `oauth_grant` DROP COLUMN `dek_id`;