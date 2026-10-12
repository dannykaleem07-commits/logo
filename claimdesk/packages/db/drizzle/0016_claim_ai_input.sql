-- Claim AI input (docs/CLAIM-AI-INPUT.md §2). Journal `when` 1792550000000 (after 0015_smart_intake 1792450000000).
-- The owner's words are kept verbatim (immutable columns), the action log and off-system correspondence are
-- append-only, standing instructions may only be retired.
CREATE TABLE `claim_ai_inputs` (`id` text PRIMARY KEY NOT NULL, `claim_id` text NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('update','catch_up')),
  `channel` text NOT NULL CHECK (`channel` IN ('typed','call_note','voice_note','upload')),
  `text` text NOT NULL DEFAULT '', `extra_text` text,
  `status` text NOT NULL CHECK (`status` IN ('interpreting','waiting_ai','clarify','preview','reading','applying','applied','partly_applied','nothing_to_do','cancelled','failed','undone')),
  `engine` text CHECK (`engine` IS NULL OR `engine` IN ('rules','ai','rules_ai','catch_up')),
  `revision` integer NOT NULL DEFAULT 0, `interpretation` text, `answers` text NOT NULL DEFAULT '[]',
  `bundle_id` text, `auto_apply` integer NOT NULL DEFAULT 1, `files_done` integer NOT NULL DEFAULT 0,
  `run_id` text, `needs_you_id` text, `error` text, `summary` text,
  `created_by` text NOT NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL, `applied_by` text, `applied_at` text);
--> statement-breakpoint
CREATE INDEX `claim_ai_inputs_claim_idx` ON `claim_ai_inputs` (`claim_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `claim_ai_inputs_status_idx` ON `claim_ai_inputs` (`status`, `updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_ai_inputs_bundle_uq` ON `claim_ai_inputs` (`bundle_id`) WHERE `bundle_id` IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `claim_ai_inputs_words_immutable` BEFORE UPDATE OF `text`, `extra_text`, `claim_id`, `kind`, `channel`, `created_by`, `created_at` ON `claim_ai_inputs`
WHEN NEW.`text` IS NOT OLD.`text` OR NEW.`extra_text` IS NOT OLD.`extra_text` OR NEW.`claim_id` IS NOT OLD.`claim_id` OR NEW.`kind` IS NOT OLD.`kind`
  OR NEW.`channel` IS NOT OLD.`channel` OR NEW.`created_by` IS NOT OLD.`created_by` OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN SELECT RAISE(ABORT, 'claim_ai_inputs keeps the owner''s words unchanged'); END;
--> statement-breakpoint
CREATE TRIGGER `claim_ai_inputs_no_delete` BEFORE DELETE ON `claim_ai_inputs`
BEGIN SELECT RAISE(ABORT, 'claim_ai_inputs rows are never deleted'); END;
--> statement-breakpoint
CREATE TABLE `claim_ai_input_log` (`id` text PRIMARY KEY NOT NULL, `input_id` text NOT NULL, `claim_id` text NOT NULL,
  `seq` integer NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('created','interpreted','question','answered','edited','applied','skipped','failed','needs_you',
    'undone','undo_failed','file_override','files_done','cancelled','think_again','instruction_due')),
  `action_key` text, `action` text, `refs` text, `note` text, `actor` text NOT NULL, `run_id` text, `at` text NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_ai_input_log_seq_uq` ON `claim_ai_input_log` (`input_id`, `seq`);
--> statement-breakpoint
CREATE INDEX `claim_ai_input_log_claim_idx` ON `claim_ai_input_log` (`claim_id`, `at`);
--> statement-breakpoint
CREATE TABLE `claim_instructions` (`id` text PRIMARY KEY NOT NULL, `claim_id` text NOT NULL, `text` text NOT NULL,
  `applies_to` text NOT NULL, `effect` text, `active_from` text NOT NULL, `until` text,
  `status` text NOT NULL DEFAULT 'active' CHECK (`status` IN ('active','retired')),
  `source_input_id` text, `source_action_key` text, `created_by` text NOT NULL, `created_at` text NOT NULL,
  `retired_by` text, `retired_at` text, `retired_reason` text);
--> statement-breakpoint
CREATE INDEX `claim_instructions_claim_idx` ON `claim_instructions` (`claim_id`, `status`);
--> statement-breakpoint
CREATE TRIGGER `claim_instructions_retire_only` BEFORE UPDATE ON `claim_instructions`
WHEN OLD.`status` = 'retired' OR NEW.`text` IS NOT OLD.`text` OR NEW.`applies_to` IS NOT OLD.`applies_to` OR NEW.`effect` IS NOT OLD.`effect`
  OR NEW.`active_from` IS NOT OLD.`active_from` OR NEW.`until` IS NOT OLD.`until` OR NEW.`claim_id` IS NOT OLD.`claim_id`
  OR NEW.`created_by` IS NOT OLD.`created_by` OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN SELECT RAISE(ABORT, 'a standing instruction can only be retired'); END;
--> statement-breakpoint
CREATE TRIGGER `claim_instructions_no_delete` BEFORE DELETE ON `claim_instructions`
BEGIN SELECT RAISE(ABORT, 'claim_instructions rows are never deleted'); END;
--> statement-breakpoint
CREATE TABLE `claim_correspondence` (`id` text PRIMARY KEY NOT NULL, `claim_id` text NOT NULL,
  `direction` text NOT NULL CHECK (`direction` IN ('out','in')),
  `channel` text NOT NULL CHECK (`channel` IN ('email','post','hand','phone','portal','unknown')),
  `kind` text NOT NULL, `template_id` text, `email_kind` text, `counterparty_role` text, `counterparty_name` text,
  `at` text NOT NULL, `date_source` text NOT NULL CHECK (`date_source` IN ('document','email_header','owner','file_metadata')),
  `subject` text, `summary` text NOT NULL, `evidence_id` text, `event_id` text, `input_id` text, `bundle_id` text,
  `bundle_file_id` text, `supersedes_id` text, `withdrawn` integer NOT NULL DEFAULT 0,
  `created_by` text NOT NULL, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `claim_correspondence_claim_idx` ON `claim_correspondence` (`claim_id`, `at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_correspondence_evidence_uq` ON `claim_correspondence` (`claim_id`, `evidence_id`, `direction`)
  WHERE `evidence_id` IS NOT NULL AND `supersedes_id` IS NULL;
--> statement-breakpoint
-- Catch-up bundles: the smart-intake bundle machinery with the claim fixed (docs/CLAIM-AI-INPUT.md §8).
ALTER TABLE `intake_bundles` ADD COLUMN `mode` text NOT NULL DEFAULT 'intake' CHECK (`mode` IN ('intake','catch_up'));
--> statement-breakpoint
ALTER TABLE `intake_bundles` ADD COLUMN `target_claim_id` text;
--> statement-breakpoint
-- Per-file catch-up facts (direction, real date, correspondence kind, record ids) — derived, re-derivable.
ALTER TABLE `intake_bundle_files` ADD COLUMN `catch_up` text;
--> statement-breakpoint
CREATE TRIGGER `claim_ai_input_log_no_update` BEFORE UPDATE ON `claim_ai_input_log`
BEGIN SELECT RAISE(ABORT, 'claim_ai_input_log is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `claim_ai_input_log_no_delete` BEFORE DELETE ON `claim_ai_input_log`
BEGIN SELECT RAISE(ABORT, 'claim_ai_input_log is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `claim_correspondence_no_update` BEFORE UPDATE ON `claim_correspondence`
BEGIN SELECT RAISE(ABORT, 'claim_correspondence is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `claim_correspondence_no_delete` BEFORE DELETE ON `claim_correspondence`
BEGIN SELECT RAISE(ABORT, 'claim_correspondence is append-only'); END;
