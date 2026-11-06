DROP TABLE `jwks`;--> statement-breakpoint
DROP TABLE `oauth_access_token`;--> statement-breakpoint
DROP TABLE `oauth_client`;--> statement-breakpoint
DROP TABLE `oauth_client_assertion`;--> statement-breakpoint
DROP TABLE `oauth_client_resource`;--> statement-breakpoint
DROP TABLE `oauth_consent`;--> statement-breakpoint
DROP TABLE `oauth_refresh_token`;--> statement-breakpoint
DROP TABLE `oauth_resource`;--> statement-breakpoint
ALTER TABLE `conversation` DROP COLUMN `name`;--> statement-breakpoint
ALTER TABLE `conversation` DROP COLUMN `participants_json`;--> statement-breakpoint
ALTER TABLE `conversation` DROP COLUMN `last_message_preview`;--> statement-breakpoint
ALTER TABLE `message` DROP COLUMN `sender_name`;--> statement-breakpoint
ALTER TABLE `message` DROP COLUMN `sender_number`;--> statement-breakpoint
ALTER TABLE `message` DROP COLUMN `body`;--> statement-breakpoint
ALTER TABLE `message` DROP COLUMN `media_json`;--> statement-breakpoint
ALTER TABLE `message` DROP COLUMN `reactions_json`;