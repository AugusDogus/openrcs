-- Full-text search over message bodies and sender names.
-- External-content FTS5 table keyed by message.id (INTEGER PRIMARY KEY rowid
-- alias). Triggers keep it in sync; the update trigger only fires when an
-- indexed column changes, so status/reaction updates do not touch the index.
-- Query with: SELECT m.* FROM message_fts f JOIN message m ON m.id = f.rowid
--             WHERE message_fts MATCH ? AND m.user_id = ? ORDER BY m.timestamp DESC
CREATE VIRTUAL TABLE `message_fts` USING fts5(
	`body`,
	`sender_name`,
	content='message',
	content_rowid='id',
	tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `message_fts_after_insert` AFTER INSERT ON `message` BEGIN
	INSERT INTO `message_fts` (`rowid`, `body`, `sender_name`) VALUES (new.`id`, new.`body`, new.`sender_name`);
END;
--> statement-breakpoint
CREATE TRIGGER `message_fts_after_delete` AFTER DELETE ON `message` BEGIN
	INSERT INTO `message_fts` (`message_fts`, `rowid`, `body`, `sender_name`) VALUES ('delete', old.`id`, old.`body`, old.`sender_name`);
END;
--> statement-breakpoint
CREATE TRIGGER `message_fts_after_update` AFTER UPDATE OF `body`, `sender_name` ON `message` BEGIN
	INSERT INTO `message_fts` (`message_fts`, `rowid`, `body`, `sender_name`) VALUES ('delete', old.`id`, old.`body`, old.`sender_name`);
	INSERT INTO `message_fts` (`rowid`, `body`, `sender_name`) VALUES (new.`id`, new.`body`, new.`sender_name`);
END;
--> statement-breakpoint
INSERT INTO `message_fts` (`message_fts`) VALUES ('rebuild');
