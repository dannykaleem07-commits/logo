-- ClaimDesk Supreme phase 1 (docs/SUPREME-DESIGN.md §N.2): IONOS mailbox, ingested messages, attachments, claim matches,
-- triage classifications, the outbox and its transitions. Append-only: mail_matches, mail_classifications, outbox_events.
-- Passwords never live here: mail_accounts.secret_ref names the DPAPI secret (§K.2).
CREATE TABLE `mail_accounts` (`id` text PRIMARY KEY NOT NULL, `label` text NOT NULL, `imap_host` text NOT NULL, `imap_port` integer NOT NULL,
  `imap_tls` integer NOT NULL, `smtp_host` text NOT NULL, `smtp_port` integer NOT NULL,
  `smtp_security` text NOT NULL CHECK (`smtp_security` IN ('tls','starttls')), `username` text NOT NULL, `secret_ref` text NOT NULL,
  `from_name` text NOT NULL DEFAULT 'Claims Team, Courtesy Cars Group UK Ltd', `from_address` text NOT NULL,
  `signature_text` text, `signature_html` text, `processed_folder` text NOT NULL DEFAULT 'ClaimDesk-Processed',
  `quarantine_folder` text NOT NULL DEFAULT 'ClaimDesk-Quarantine', `move_after_ingest` integer NOT NULL DEFAULT 1,
  `enabled` integer NOT NULL DEFAULT 0, `created_at` text NOT NULL, `updated_at` text NOT NULL);
--> statement-breakpoint
CREATE TABLE `mail_folder_state` (`account_id` text NOT NULL, `folder` text NOT NULL, `uidvalidity` integer, `last_uid` integer NOT NULL DEFAULT 0,
  `highest_modseq` text, `last_sync_at` text, `last_error` text, PRIMARY KEY (`account_id`, `folder`));
--> statement-breakpoint
CREATE TABLE `mail_messages` (`id` text PRIMARY KEY NOT NULL, `account_id` text NOT NULL, `folder` text, `uid` integer, `uidvalidity` integer,
  `message_id` text, `message_id_norm` text, `in_reply_to` text, `references_json` text, `thread_key` text NOT NULL,
  `direction` text NOT NULL CHECK (`direction` IN ('in','out')), `from_addr` text, `from_name` text, `reply_to` text,
  `to_json` text NOT NULL, `cc_json` text NOT NULL, `subject` text, `sent_at` text, `received_at` text NOT NULL,
  `raw_evidence_id` text NOT NULL, `raw_sha256` text NOT NULL, `body_text` text, `has_attachments` integer NOT NULL DEFAULT 0,
  `auth_json` text, `spoof_suspect` integer NOT NULL DEFAULT 0,
  `status` text NOT NULL CHECK (`status` IN ('new','matched','needs_match','unmatched','quarantined','processed','ignored')),
  `claim_id` text, `source` text NOT NULL CHECK (`source` IN ('imap','file','smtp')), `created_at` text NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_messages_raw_uq` ON `mail_messages` (`account_id`, `raw_sha256`);
--> statement-breakpoint
CREATE INDEX `mail_messages_claim_idx` ON `mail_messages` (`claim_id`, `received_at`);
--> statement-breakpoint
CREATE INDEX `mail_messages_thread_idx` ON `mail_messages` (`thread_key`);
--> statement-breakpoint
CREATE INDEX `mail_messages_msgid_idx` ON `mail_messages` (`message_id_norm`);
--> statement-breakpoint
CREATE TABLE `mail_attachments` (`id` text PRIMARY KEY NOT NULL, `mail_message_id` text NOT NULL, `evidence_id` text NOT NULL,
  `filename` text NOT NULL, `mime` text NOT NULL, `bytes` integer NOT NULL, `sha256` text NOT NULL, `content_id` text,
  `inline` integer NOT NULL DEFAULT 0, `intake_item_id` text);
--> statement-breakpoint
CREATE INDEX `mail_attachments_message_idx` ON `mail_attachments` (`mail_message_id`);
--> statement-breakpoint
CREATE TABLE `mail_matches` (`id` text PRIMARY KEY NOT NULL, `mail_message_id` text NOT NULL, `claim_id` text, `score` integer NOT NULL,
  `signals` text NOT NULL, `decided_by` text NOT NULL CHECK (`decided_by` IN ('auto','agent','owner')), `decided_at` text NOT NULL,
  `superseded_by` text);
--> statement-breakpoint
CREATE INDEX `mail_matches_message_idx` ON `mail_matches` (`mail_message_id`, `decided_at`);
--> statement-breakpoint
CREATE TABLE `mail_classifications` (`id` text PRIMARY KEY NOT NULL, `mail_message_id` text NOT NULL, `run_id` text, `driver` text, `model` text,
  `prompt_version` text, `intent` text NOT NULL, `secondary` text NOT NULL, `confidence` real NOT NULL, `extracted` text NOT NULL,
  `summary` text NOT NULL, `injection` text NOT NULL, `deterministic` text NOT NULL, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `mail_classifications_message_idx` ON `mail_classifications` (`mail_message_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `outbox` (`id` text PRIMARY KEY NOT NULL, `claim_id` text, `account_id` text NOT NULL, `kind` text NOT NULL,
  `to_json` text NOT NULL, `cc_json` text NOT NULL, `bcc_json` text NOT NULL, `subject` text NOT NULL, `body_text` text NOT NULL,
  `body_html` text, `attachments_json` text NOT NULL, `in_reply_to` text, `references_json` text, `thread_key` text,
  `policy` text, `review_id` text, `confidence` real,
  `status` text NOT NULL CHECK (`status` IN ('draft','reviewing','awaiting_approval','held','queued','sending','sent','failed','cancelled')),
  `hold_until` text, `approved_by` text, `approved_at` text, `smtp_message_id` text, `raw_sent_evidence_id` text,
  `attempts` integer NOT NULL DEFAULT 0, `last_error` text, `created_by` text NOT NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `outbox_status_idx` ON `outbox` (`status`, `hold_until`);
--> statement-breakpoint
CREATE INDEX `outbox_claim_idx` ON `outbox` (`claim_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `outbox_events` (`id` text PRIMARY KEY NOT NULL, `outbox_id` text NOT NULL, `from_status` text, `to_status` text NOT NULL,
  `actor` text NOT NULL, `reason` text, `at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `outbox_events_outbox_idx` ON `outbox_events` (`outbox_id`, `at`);
--> statement-breakpoint
CREATE TRIGGER `mail_matches_no_update` BEFORE UPDATE ON `mail_matches`
BEGIN
  SELECT RAISE(ABORT, 'mail_matches is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `mail_matches_no_delete` BEFORE DELETE ON `mail_matches`
BEGIN
  SELECT RAISE(ABORT, 'mail_matches is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `mail_classifications_no_update` BEFORE UPDATE ON `mail_classifications`
BEGIN
  SELECT RAISE(ABORT, 'mail_classifications is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `mail_classifications_no_delete` BEFORE DELETE ON `mail_classifications`
BEGIN
  SELECT RAISE(ABORT, 'mail_classifications is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `outbox_events_no_update` BEFORE UPDATE ON `outbox_events`
BEGIN
  SELECT RAISE(ABORT, 'outbox_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `outbox_events_no_delete` BEFORE DELETE ON `outbox_events`
BEGIN
  SELECT RAISE(ABORT, 'outbox_events is append-only');
END;
