-- ClaimDesk Supreme phase 1 (docs/SUPREME-DESIGN.md §N.4): brain packs (private content lives under DATA_DIR only),
-- their entries with an external-content FTS5 index (brain_fts, kept in sync by triggers), the claim corpus FTS5
-- table search_docs, and memory items. FTS5 tables are read with raw SQL in the repos (not in schema.ts).
CREATE TABLE `brain_packs` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `kind` text NOT NULL CHECK (`kind` IN ('ccguk','playbook','learned','other')),
  `active_version` text, `business` text NOT NULL, `precedence` integer NOT NULL, `use_for_ccguk` integer NOT NULL DEFAULT 1,
  `created_at` text NOT NULL, `updated_at` text NOT NULL);
--> statement-breakpoint
CREATE TABLE `brain_pack_versions` (`pack_id` text NOT NULL, `version` text NOT NULL, `sha256` text NOT NULL, `source` text NOT NULL,
  `storage_path` text NOT NULL, `manifest` text NOT NULL, `entries` integer NOT NULL, `imported_by` text NOT NULL,
  `imported_at` text NOT NULL, PRIMARY KEY (`pack_id`, `version`));
--> statement-breakpoint
CREATE TABLE `brain_entries` (`rowid_key` integer PRIMARY KEY AUTOINCREMENT, `id` text NOT NULL, `pack_id` text NOT NULL, `version` text NOT NULL,
  `kind` text NOT NULL, `title` text NOT NULL, `body` text NOT NULL, `tags` text NOT NULL, `business` text NOT NULL,
  `data` text NOT NULL, `verification` text);
--> statement-breakpoint
CREATE UNIQUE INDEX `brain_entries_uq` ON `brain_entries` (`pack_id`, `version`, `id`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `brain_fts` USING fts5(`title`, `body`, `tags`, content='brain_entries', content_rowid='rowid_key',
  tokenize='porter unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER `brain_entries_fts_ai` AFTER INSERT ON `brain_entries`
BEGIN
  INSERT INTO `brain_fts` (`rowid`, `title`, `body`, `tags`) VALUES (new.`rowid_key`, new.`title`, new.`body`, new.`tags`);
END;
--> statement-breakpoint
CREATE TRIGGER `brain_entries_fts_ad` AFTER DELETE ON `brain_entries`
BEGIN
  INSERT INTO `brain_fts` (`brain_fts`, `rowid`, `title`, `body`, `tags`) VALUES ('delete', old.`rowid_key`, old.`title`, old.`body`, old.`tags`);
END;
--> statement-breakpoint
CREATE TRIGGER `brain_entries_fts_au` AFTER UPDATE ON `brain_entries`
BEGIN
  INSERT INTO `brain_fts` (`brain_fts`, `rowid`, `title`, `body`, `tags`) VALUES ('delete', old.`rowid_key`, old.`title`, old.`body`, old.`tags`);
  INSERT INTO `brain_fts` (`rowid`, `title`, `body`, `tags`) VALUES (new.`rowid_key`, new.`title`, new.`body`, new.`tags`);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE `search_docs` USING fts5(`title`, `body`, `claim_id` UNINDEXED, `source_kind` UNINDEXED, `source_id` UNINDEXED,
  `at` UNINDEXED, tokenize='porter unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TABLE `memory_items` (`id` text PRIMARY KEY NOT NULL, `kind` text NOT NULL CHECK (`kind` IN ('note','correction','outcome','preference','research')),
  `scope` text NOT NULL, `text` text NOT NULL, `basis` text NOT NULL, `data` text,
  `status` text NOT NULL CHECK (`status` IN ('proposed','approved','retired')), `created_by` text NOT NULL, `created_at` text NOT NULL,
  `decided_by` text, `decided_at` text);
--> statement-breakpoint
CREATE INDEX `memory_scope_idx` ON `memory_items` (`scope`, `status`);
