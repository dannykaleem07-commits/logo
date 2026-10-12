-- Smart intake (docs/SMART-INTAKE.md §3). Journal `when` 1792450000000 (after 0014_knowledge 1792350000000).
-- Case bundles: owner decisions and AI reasoning results are append-only (triggers below). Bundle files carry
-- derived per-file facts (duplicates, split ranges, photo facts, filing result) that are re-derivable.
CREATE TABLE `intake_bundles` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('open','reading','reconciling','ready','needs_you','registering','registered','attached','cancelled')),
  `source` text NOT NULL CHECK (`source` IN ('upload','folder','split')),
  `folder_key` text, `parent_bundle_id` text, `split_from_group` text,
  `claim_id` text, `outcome` text CHECK (`outcome` IS NULL OR `outcome` IN ('registered','attached')),
  `revision` integer NOT NULL DEFAULT 0, `computed_revision` integer, `computed` text,
  `reasoning_status` text NOT NULL DEFAULT 'none' CHECK (`reasoning_status` IN ('none','queued','waiting_ai','done','failed','skipped')),
  `reasoning_fileset` text, `auto_eligible` integer NOT NULL DEFAULT 0, `needs_you_id` text, `error` text,
  `created_by` text NOT NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL,
  `closed_by` text, `closed_at` text);
--> statement-breakpoint
CREATE INDEX `intake_bundles_status_idx` ON `intake_bundles` (`status`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `intake_bundles_claim_idx` ON `intake_bundles` (`claim_id`);
--> statement-breakpoint
-- One open bundle per inbox folder (Windows is case-insensitive: compare lower-case).
CREATE UNIQUE INDEX `intake_bundles_folder_open_uq` ON `intake_bundles` (lower(`folder_key`))
  WHERE `folder_key` IS NOT NULL AND `status` NOT IN ('registered','attached','cancelled');
--> statement-breakpoint
CREATE TABLE `intake_bundle_files` (`id` text PRIMARY KEY NOT NULL, `bundle_id` text NOT NULL, `intake_item_id` text NOT NULL,
  `evidence_id` text NOT NULL, `parent_file_id` text, `position` integer NOT NULL,
  `role` text NOT NULL DEFAULT 'document' CHECK (`role` IN ('document','pack','segment','attachment','archive','email')),
  `page_from` integer, `page_to` integer,
  `phash` text, `facts` text,
  `filed_evidence_id` text, `filed_claim_id` text, `filed_kind` text, `filed_at` text,
  `added_by` text NOT NULL, `added_at` text NOT NULL, `updated_at` text NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `intake_bundle_files_item_uq` ON `intake_bundle_files` (`bundle_id`, `intake_item_id`);
--> statement-breakpoint
CREATE INDEX `intake_bundle_files_bundle_idx` ON `intake_bundle_files` (`bundle_id`, `position`);
--> statement-breakpoint
CREATE INDEX `intake_bundle_files_item_idx` ON `intake_bundle_files` (`intake_item_id`);
--> statement-breakpoint
CREATE TABLE `intake_bundle_decisions` (`id` text PRIMARY KEY NOT NULL, `bundle_id` text NOT NULL, `revision` integer NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('create','rename','add_files','move_file','exclude_file','include_file','unsplit',
    'set_field','clear_field','choose_conflict','accept_preselected','confirm_new','link_party','tick_timeline','untick_timeline',
    'ack_signal','split_off','think_again','register','attach','cancel','reopen')),
  `subject` text, `before` text, `after` text, `note` text, `actor` text NOT NULL, `run_id` text, `at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `intake_bundle_decisions_bundle_idx` ON `intake_bundle_decisions` (`bundle_id`, `at`);
--> statement-breakpoint
CREATE TABLE `intake_bundle_reasonings` (`id` text PRIMARY KEY NOT NULL, `bundle_id` text NOT NULL, `fileset` text NOT NULL,
  `engine` text NOT NULL CHECK (`engine` IN ('ai')), `run_id` text, `result` text NOT NULL, `checks` text NOT NULL, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `intake_bundle_reasonings_bundle_idx` ON `intake_bundle_reasonings` (`bundle_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `claim_damage_observations` (`id` text PRIMARY KEY NOT NULL, `claim_id` text NOT NULL, `evidence_id` text,
  `zone_id` text NOT NULL, `severity` integer NOT NULL CHECK (`severity` BETWEEN 0 AND 3), `confidence` real NOT NULL,
  `source` text NOT NULL CHECK (`source` IN ('ai_photo','estimate_text','owner')), `bundle_id` text, `run_id` text,
  `created_by` text NOT NULL, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_damage_obs_uq` ON `claim_damage_observations` (`claim_id`, coalesce(`evidence_id`, ''), `zone_id`, `source`, coalesce(`bundle_id`, ''));
--> statement-breakpoint
CREATE INDEX `claim_damage_obs_claim_idx` ON `claim_damage_observations` (`claim_id`, `created_at`);
--> statement-breakpoint
-- Per-file extras of an extraction: {engine:'ai'|'rules', documentDate, docSide, photo, segments, pdfMeta}.
ALTER TABLE `intake_extractions` ADD COLUMN `extras` text;
--> statement-breakpoint
-- Settings > Intake (merged over DEFAULT_INTAKE_SETTINGS on read).
ALTER TABLE `agent_settings` ADD COLUMN `intake` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
CREATE TRIGGER `intake_bundle_decisions_no_update` BEFORE UPDATE ON `intake_bundle_decisions`
BEGIN SELECT RAISE(ABORT, 'intake_bundle_decisions is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `intake_bundle_decisions_no_delete` BEFORE DELETE ON `intake_bundle_decisions`
BEGIN SELECT RAISE(ABORT, 'intake_bundle_decisions is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `intake_bundle_reasonings_no_update` BEFORE UPDATE ON `intake_bundle_reasonings`
BEGIN SELECT RAISE(ABORT, 'intake_bundle_reasonings is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `intake_bundle_reasonings_no_delete` BEFORE DELETE ON `intake_bundle_reasonings`
BEGIN SELECT RAISE(ABORT, 'intake_bundle_reasonings is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `claim_damage_obs_no_update` BEFORE UPDATE ON `claim_damage_observations`
BEGIN SELECT RAISE(ABORT, 'claim_damage_observations is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `claim_damage_obs_no_delete` BEFORE DELETE ON `claim_damage_observations`
BEGIN SELECT RAISE(ABORT, 'claim_damage_observations is append-only'); END;
