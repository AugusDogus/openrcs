-- Message content is now encrypted per user (docs/security.md), so the
-- plaintext full-text index and its triggers go away. Dropped before the
-- schema migration that removes the indexed columns.
DROP TRIGGER IF EXISTS `message_fts_after_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `message_fts_after_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `message_fts_after_update`;
--> statement-breakpoint
DROP TABLE IF EXISTS `message_fts`;
