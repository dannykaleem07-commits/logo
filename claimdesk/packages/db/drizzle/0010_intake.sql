-- ClaimDesk Supreme phase 1 (docs/SUPREME-DESIGN.md §N.3): intake items (any file → normalised text), extractions
-- (append-only) and claim update proposals (auto / confirm / never).
CREATE TABLE `intake_items` (`id` text PRIMARY KEY NOT NULL, `source` text NOT NULL CHECK (`source` IN ('upload','email','folder','capture')),
  `evidence_id` text NOT NULL, `parent_item_id` text, `claim_id` text,
  `status` text NOT NULL CHECK (`status` IN ('queued','normalising','extracting','proposed','applied','needs_you','failed','quota_wait','skipped')),
  `sniffed_type` text, `doc_type` text, `doc_type_confidence` real, `pages` integer, `text_sha256` text, `normalised` text,
  `error` text, `created_by` text NOT NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `intake_items_claim_idx` ON `intake_items` (`claim_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `intake_items_status_idx` ON `intake_items` (`status`, `created_at`);
--> statement-breakpoint
CREATE TABLE `intake_extractions` (`id` text PRIMARY KEY NOT NULL, `intake_item_id` text NOT NULL, `run_id` text, `schema_id` text NOT NULL,
  `fields` text NOT NULL, `summary` text, `warnings` text NOT NULL, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `intake_extractions_item_idx` ON `intake_extractions` (`intake_item_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `claim_update_proposals` (`id` text PRIMARY KEY NOT NULL, `claim_id` text NOT NULL, `intake_item_id` text, `target` text NOT NULL,
  `current_value` text, `proposed_value` text NOT NULL, `confidence` real NOT NULL, `sensitive` integer NOT NULL,
  `validator` text, `source` text NOT NULL, `policy_decision` text NOT NULL CHECK (`policy_decision` IN ('auto','confirm','never')),
  `status` text NOT NULL CHECK (`status` IN ('pending','applied','rejected','superseded')),
  `decided_by` text, `decided_at` text, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `proposals_claim_idx` ON `claim_update_proposals` (`claim_id`, `status`);
--> statement-breakpoint
CREATE TRIGGER `intake_extractions_no_update` BEFORE UPDATE ON `intake_extractions`
BEGIN
  SELECT RAISE(ABORT, 'intake_extractions is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `intake_extractions_no_delete` BEFORE DELETE ON `intake_extractions`
BEGIN
  SELECT RAISE(ABORT, 'intake_extractions is append-only');
END;
