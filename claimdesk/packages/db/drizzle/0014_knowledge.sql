-- Knowledge Builder (docs/SUPREME-KNOWLEDGE-BUILDER.md §5). Journal `when` 1792350000000 — the contract value: it sits
-- after 0012_settlement_offers (1792210000000) and 0013_autopilot (1792250000000). A later Phase 2 / Phase 3 migration
-- must take a `when` greater than every applied one (drizzle only applies a migration newer than the last applied).
-- Learned knowledge, fetched source copies, corrections and observations are private: they live only in the owner's
-- DATA_DIR (this database and DATA_DIR\knowledge-store\). KR-1: code never upgrades a verification status — the
-- triggers below refuse it.
-- ===== core store (knowledge-core) =====
CREATE TABLE `knowledge_items` (`rowid_key` integer PRIMARY KEY AUTOINCREMENT, `id` text NOT NULL, `item_key` text NOT NULL,
  `version` integer NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('fact','rule','strategy','contact','insurer_profile','template_snippet','engineering_figure','precedent','procedure')),
  `area` text NOT NULL CHECK (`area` IN ('legal','quantum','procedural','contact','statistics','style','engineering','strategy')),
  `title` text NOT NULL, `body` text NOT NULL, `data` text NOT NULL, `tags` text NOT NULL DEFAULT '[]',
  `scope_kind` text NOT NULL CHECK (`scope_kind` IN ('global','insurer','claim_type')), `scope_value` text,
  `business` text NOT NULL DEFAULT '["ccguk"]',
  `use_limit` text NOT NULL CHECK (`use_limit` IN ('outbound_ok','internal','code_only')),
  `origin` text NOT NULL CHECK (`origin` IN ('computed','observed','owner','curated','researched','imported')),
  `verification` text NOT NULL DEFAULT 'unverified' CHECK (`verification` IN ('unverified','owner_confirmed','source_verified')),
  `last_check_id` text, `confidence` real NOT NULL, `support_n` integer NOT NULL DEFAULT 1,
  `status` text NOT NULL CHECK (`status` IN ('proposed','active','rejected','superseded','retired','quarantined')),
  `health` text NOT NULL DEFAULT 'ok' CHECK (`health` IN ('ok','stale','source_changed','conflicted','expired')),
  `valid_from` text, `valid_to` text, `review_by` text, `provenance` text NOT NULL, `supersedes_id` text, `gap_id` text,
  `content_sha256` text NOT NULL, `autonomy` text NOT NULL,
  `created_by` text NOT NULL, `created_at` text NOT NULL, `origin_job_id` text, `origin_run_id` text,
  `decided_by` text, `decided_at` text, `decision_note` text, `needs_you_id` text, `updated_at` text NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_items_id_uq` ON `knowledge_items` (`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_items_key_ver_uq` ON `knowledge_items` (`item_key`, `version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_items_one_active_uq` ON `knowledge_items` (`item_key`) WHERE `status` = 'active';
--> statement-breakpoint
CREATE INDEX `knowledge_items_status_idx` ON `knowledge_items` (`status`, `kind`, `area`);
--> statement-breakpoint
CREATE INDEX `knowledge_items_scope_idx` ON `knowledge_items` (`scope_kind`, `scope_value`, `status`);
--> statement-breakpoint
CREATE INDEX `knowledge_items_sha_idx` ON `knowledge_items` (`content_sha256`);
--> statement-breakpoint
CREATE INDEX `knowledge_items_needs_you_idx` ON `knowledge_items` (`needs_you_id`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `knowledge_fts` USING fts5(`title`, `body`, `tags`, content='knowledge_items', content_rowid='rowid_key',
  tokenize='porter unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER `knowledge_items_fts_ai` AFTER INSERT ON `knowledge_items`
BEGIN
  INSERT INTO `knowledge_fts` (`rowid`, `title`, `body`, `tags`) VALUES (new.`rowid_key`, new.`title`, new.`body`, new.`tags`);
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_items_fts_ad` AFTER DELETE ON `knowledge_items`
BEGIN
  INSERT INTO `knowledge_fts` (`knowledge_fts`, `rowid`, `title`, `body`, `tags`) VALUES ('delete', old.`rowid_key`, old.`title`, old.`body`, old.`tags`);
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_items_fts_au` AFTER UPDATE OF `title`, `body`, `tags` ON `knowledge_items`
BEGIN
  INSERT INTO `knowledge_fts` (`knowledge_fts`, `rowid`, `title`, `body`, `tags`) VALUES ('delete', old.`rowid_key`, old.`title`, old.`body`, old.`tags`);
  INSERT INTO `knowledge_fts` (`rowid`, `title`, `body`, `tags`) VALUES (new.`rowid_key`, new.`title`, new.`body`, new.`tags`);
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_items_no_delete` BEFORE DELETE ON `knowledge_items`
BEGIN
  SELECT RAISE(ABORT, 'KNOWLEDGE_APPEND_ONLY');
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_items_content_immutable` BEFORE UPDATE OF `item_key`, `version`, `kind`, `area`, `title`, `body`, `data`, `tags`,
  `scope_kind`, `scope_value`, `business`, `use_limit`, `origin`, `provenance`, `content_sha256`, `created_by`, `created_at` ON `knowledge_items`
BEGIN
  SELECT RAISE(ABORT, 'KNOWLEDGE_CONTENT_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_items_insert_unverified` BEFORE INSERT ON `knowledge_items` WHEN NEW.`verification` <> 'unverified'
BEGIN
  SELECT RAISE(ABORT, 'KNOWLEDGE_VERIFICATION_NEEDS_HUMAN_CHECK');
END;
--> statement-breakpoint
CREATE TABLE `knowledge_checks` (`id` text PRIMARY KEY NOT NULL, `target` text NOT NULL,
  `result` text NOT NULL CHECK (`result` IN ('unverified','owner_confirmed','source_verified','failed')),
  `method` text NOT NULL CHECK (`method` IN ('owner_review','source_compare','owner_answer','downgrade')),
  `snapshot_id` text, `source_url` text, `quote` text,
  `quote_match` text NOT NULL CHECK (`quote_match` IN ('exact','normalised','not_found','not_applicable')),
  `note` text, `checked_by` text NOT NULL, `checked_at` text NOT NULL, `needs_you_id` text);
--> statement-breakpoint
CREATE INDEX `knowledge_checks_target_idx` ON `knowledge_checks` (`target`, `checked_at`);
--> statement-breakpoint
CREATE TRIGGER `knowledge_items_verification_guard` BEFORE UPDATE OF `verification` ON `knowledge_items`
  WHEN NEW.`verification` <> OLD.`verification` AND NOT EXISTS (SELECT 1 FROM `knowledge_checks` c
    WHERE c.`id` = NEW.`last_check_id` AND c.`target` = 'item:' || NEW.`id` AND c.`result` = NEW.`verification`
      AND c.`checked_by` <> 'system' AND c.`checked_by` NOT LIKE 'agent:%')
BEGIN
  SELECT RAISE(ABORT, 'KNOWLEDGE_VERIFICATION_NEEDS_HUMAN_CHECK');
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_checks_human` BEFORE INSERT ON `knowledge_checks`
  WHEN NEW.`result` IN ('owner_confirmed','source_verified','failed') AND (NEW.`checked_by` = 'system' OR NEW.`checked_by` LIKE 'agent:%')
BEGIN
  SELECT RAISE(ABORT, 'KNOWLEDGE_CHECK_NEEDS_HUMAN');
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_checks_source` BEFORE INSERT ON `knowledge_checks`
  WHEN NEW.`result` = 'source_verified' AND NEW.`snapshot_id` IS NULL AND NEW.`source_url` IS NULL
BEGIN
  SELECT RAISE(ABORT, 'KNOWLEDGE_SOURCE_CHECK_NEEDS_SOURCE');
END;
--> statement-breakpoint
CREATE TABLE `knowledge_changes` (`id` text PRIMARY KEY NOT NULL, `at` text NOT NULL, `actor` text NOT NULL, `action` text NOT NULL,
  `item_id` text, `item_key` text, `gap_id` text, `pack_version` integer, `before` text, `after` text, `reason` text,
  `rule_ids` text, `run_id` text, `job_id` text, `needs_you_id` text);
--> statement-breakpoint
CREATE INDEX `knowledge_changes_at_idx` ON `knowledge_changes` (`at`);
--> statement-breakpoint
CREATE INDEX `knowledge_changes_item_idx` ON `knowledge_changes` (`item_key`, `at`);
--> statement-breakpoint
CREATE TABLE `knowledge_pack_versions` (`version` integer PRIMARY KEY NOT NULL, `label` text NOT NULL, `items_sha256` text NOT NULL,
  `item_count` integer NOT NULL, `diff` text NOT NULL, `reason` text NOT NULL, `based_on_version` integer, `rollback_of` integer,
  `replay_run_id` text, `created_by` text NOT NULL, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE TABLE `knowledge_pack_members` (`version` integer NOT NULL, `item_id` text NOT NULL, PRIMARY KEY (`version`, `item_id`));
--> statement-breakpoint
CREATE TABLE `knowledge_pack_state` (`id` text PRIMARY KEY NOT NULL, `active_version` integer, `activated_by` text, `activated_at` text);
--> statement-breakpoint
CREATE TABLE `knowledge_conflicts` (`id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('contradicts','duplicate','directory_mismatch','red_line','perimeter','kb_contradiction','stats_vs_note')),
  `left_ref` text NOT NULL, `right_ref` text NOT NULL, `detail` text NOT NULL, `detected_by` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('open','resolved','dismissed')), `resolution` text, `needs_you_id` text,
  `created_at` text NOT NULL, `resolved_by` text, `resolved_at` text);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_conflicts_open_uq` ON `knowledge_conflicts` (`left_ref`, `right_ref`, `kind`) WHERE `status` = 'open';
--> statement-breakpoint
CREATE TABLE `insurer_links` (`party_id` text PRIMARY KEY NOT NULL, `insurer_slug` text NOT NULL,
  `method` text NOT NULL CHECK (`method` IN ('exact_name','brand','email_domain','owner')), `confidence` real NOT NULL,
  `decided_by` text NOT NULL, `decided_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `insurer_links_slug_idx` ON `insurer_links` (`insurer_slug`);
--> statement-breakpoint
CREATE TABLE `knowledge_settings` (`id` text PRIMARY KEY NOT NULL, `settings` text NOT NULL, `updated_at` text NOT NULL, `updated_by` text NOT NULL);
--> statement-breakpoint
-- ===== learners (knowledge-learners) =====
CREATE TABLE `contact_observations` (`id` text PRIMARY KEY NOT NULL, `mail_message_id` text NOT NULL, `thread_key` text, `insurer_slug` text,
  `from_domain` text NOT NULL, `dmarc` text NOT NULL CHECK (`dmarc` IN ('pass','fail','none','unknown')),
  `domain_check` text NOT NULL CHECK (`domain_check` IN ('own_domain','unknown_domain','copycat','spoof_suspect')),
  `name` text, `role` text, `phone_norm` text, `phone_kind` text, `email` text, `ivr_text` text, `hours_text` text, `copycat` text,
  `signature_sha256` text NOT NULL, `observed_at` text NOT NULL, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_obs_uq` ON `contact_observations` (`mail_message_id`, `signature_sha256`);
--> statement-breakpoint
CREATE INDEX `contact_obs_insurer_idx` ON `contact_observations` (`insurer_slug`, `observed_at`);
--> statement-breakpoint
CREATE TABLE `offer_observations` (`id` text PRIMARY KEY NOT NULL, `claim_id` text NOT NULL, `insurer_slug` text,
  `offer_kind` text NOT NULL CHECK (`offer_kind` IN ('settlement','pav','part36','interim','intervention')), `head` text,
  `amount_pence` integer, `claimed_pence` integer, `received_at` text NOT NULL,
  `source` text NOT NULL CHECK (`source` IN ('needs_you','ledger','event','intervention_register','settlement_register')), `source_id` text NOT NULL,
  `decision` text CHECK (`decision` IN ('accept','counter','reject','hold','lapsed')), `decided_at` text, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `offer_obs_uq` ON `offer_observations` (`source`, `source_id`, coalesce(`decision`, ''));
--> statement-breakpoint
CREATE TABLE `claim_outcomes` (`claim_id` text NOT NULL, `head` text NOT NULL, `insurer_slug` text, `claim_types` text NOT NULL,
  `gta_subscriber` integer, `claimed_pence` integer NOT NULL DEFAULT 0, `first_offer_pence` integer, `paid_pence` integer NOT NULL DEFAULT 0,
  `reduced_pence` integer NOT NULL DEFAULT 0, `pack_sent_at` text, `first_paid_at` text, `fully_paid_at` text, `working_days_to_pay` integer,
  `chasers_before_pay` integer NOT NULL DEFAULT 0, `objections` text NOT NULL DEFAULT '[]', `docs_requested` text NOT NULL DEFAULT '[]',
  `steps` text NOT NULL DEFAULT '[]', `status` text NOT NULL, `computed_at` text NOT NULL, PRIMARY KEY (`claim_id`, `head`));
--> statement-breakpoint
CREATE INDEX `claim_outcomes_insurer_idx` ON `claim_outcomes` (`insurer_slug`);
--> statement-breakpoint
CREATE TABLE `corrections` (`id` text PRIMARY KEY NOT NULL,
  `source` text NOT NULL CHECK (`source` IN ('needs_you_edit','outbox_edit','document_supersede','memory_item','owner_reject')),
  `source_id` text NOT NULL, `needs_you_id` text, `claim_id` text, `target_kind` text, `target_id` text, `agent` text, `template_id` text,
  `email_kind` text, `insurer_slug` text, `before_text` text NOT NULL, `after_text` text NOT NULL, `diff` text NOT NULL, `stats` text NOT NULL,
  `categories` text NOT NULL, `cluster_key` text, `owner_note` text, `captured_at` text NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `corrections_src_uq` ON `corrections` (`source`, `source_id`);
--> statement-breakpoint
CREATE INDEX `corrections_cluster_idx` ON `corrections` (`cluster_key`, `captured_at`);
--> statement-breakpoint
CREATE TABLE `knowledge_watermarks` (`source` text PRIMARY KEY NOT NULL, `last_at` text NOT NULL, `last_id` text, `updated_at` text NOT NULL);
--> statement-breakpoint
-- ===== research (knowledge-research) =====
CREATE TABLE `knowledge_gaps` (`id` text PRIMARY KEY NOT NULL, `gap_key` text NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('insurer_process','legal_point','quantum_point','missing_contact','unfamiliar_document','procedure','engineering','kb_verification','other')),
  `question` text NOT NULL, `area` text NOT NULL, `scope_kind` text NOT NULL, `scope_value` text,
  `origin` text NOT NULL CHECK (`origin` IN ('agent_report','review_failure','research_no_answer','needs_you','directory_ageing','kb_unverified','intake_unknown','triage_other','source_changed','owner')),
  `origin_ref` text, `claim_ids` text NOT NULL DEFAULT '[]', `blocking` integer NOT NULL DEFAULT 0, `occurrences` integer NOT NULL DEFAULT 1,
  `priority` integer NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('open','researching','answered_pending','answered','needs_owner','no_answer','out_of_scope','dismissed')),
  `attempts` integer NOT NULL DEFAULT 0, `next_attempt_at` text, `answer_item_ids` text NOT NULL DEFAULT '[]', `spend` text NOT NULL DEFAULT '{}',
  `raised_by` text NOT NULL, `created_at` text NOT NULL, `last_seen_at` text NOT NULL, `closed_by` text, `closed_at` text,
  `close_note` text, `needs_you_id` text, `updated_at` text NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_gaps_open_uq` ON `knowledge_gaps` (`gap_key`) WHERE `status` IN ('open','researching','answered_pending','needs_owner');
--> statement-breakpoint
CREATE INDEX `knowledge_gaps_queue_idx` ON `knowledge_gaps` (`status`, `priority`, `next_attempt_at`);
--> statement-breakpoint
CREATE TABLE `knowledge_sources` (`domain` text PRIMARY KEY NOT NULL,
  `policy` text NOT NULL CHECK (`policy` IN ('api','code_fetch','agent_fetch','link_only','deny')), `access` text NOT NULL,
  `licence` text NOT NULL, `extract_allowed` integer NOT NULL, `max_quote_words` integer NOT NULL, `tags` text NOT NULL DEFAULT '[]',
  `per_minute` integer NOT NULL, `per_day` integer NOT NULL, `enabled` integer NOT NULL DEFAULT 1,
  `origin` text NOT NULL CHECK (`origin` IN ('builtin','insurer_directory','owner')), `robots` text, `robots_checked_at` text,
  `selftest` text, `last_fetch_at` text, `last_status` integer, `fetches_today` integer NOT NULL DEFAULT 0, `fetch_day` text,
  `updated_by` text NOT NULL, `updated_at` text NOT NULL);
--> statement-breakpoint
CREATE TABLE `source_snapshots` (`id` text PRIMARY KEY NOT NULL, `url` text NOT NULL, `final_url` text NOT NULL, `domain` text NOT NULL,
  `fetched_at` text NOT NULL, `http_status` integer NOT NULL, `content_type` text, `bytes` integer NOT NULL, `sha256` text NOT NULL,
  `storage_path` text NOT NULL, `text_path` text, `text_sha256` text, `title` text, `licence` text NOT NULL, `extract_allowed` integer NOT NULL,
  `previous_id` text, `changed` integer NOT NULL DEFAULT 0, `injection_flags` text NOT NULL DEFAULT '[]', `reason` text NOT NULL,
  `gap_id` text, `job_id` text, `run_id` text, `created_by` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `source_snapshots_url_idx` ON `source_snapshots` (`url`, `fetched_at`);
--> statement-breakpoint
-- ===== use + evals (knowledge-use) =====
CREATE TABLE `knowledge_usage` (`id` text PRIMARY KEY NOT NULL, `run_id` text NOT NULL, `claim_id` text, `ref` text NOT NULL,
  `badges` text NOT NULL, `rank` integer NOT NULL, `injected` integer NOT NULL, `cited` integer NOT NULL DEFAULT 0,
  `target_kind` text, `target_id` text, `at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `knowledge_usage_run_idx` ON `knowledge_usage` (`run_id`);
--> statement-breakpoint
CREATE INDEX `knowledge_usage_ref_idx` ON `knowledge_usage` (`ref`, `at`);
--> statement-breakpoint
CREATE INDEX `knowledge_usage_target_idx` ON `knowledge_usage` (`target_kind`, `target_id`);
--> statement-breakpoint
CREATE TABLE `eval_cases` (`id` text PRIMARY KEY NOT NULL, `claim_id` text NOT NULL, `decision_point` text NOT NULL, `at` text NOT NULL,
  `facts` text NOT NULL, `historic` text NOT NULL, `outcome` text NOT NULL, `insurer_slug` text, `outcome_quartile` integer,
  `created_at` text NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `eval_cases_uq` ON `eval_cases` (`claim_id`, `decision_point`, `at`);
--> statement-breakpoint
CREATE TABLE `eval_runs` (`id` text PRIMARY KEY NOT NULL, `mode` text NOT NULL CHECK (`mode` IN ('gate','nightly','drafts')),
  `baseline_version` integer, `candidate` text NOT NULL, `cases` integer NOT NULL, `metrics` text NOT NULL,
  `verdict` text NOT NULL CHECK (`verdict` IN ('no_worse','worse','inconclusive','error')), `details` text NOT NULL,
  `started_at` text NOT NULL, `finished_at` text, `job_id` text, `created_by` text NOT NULL);
--> statement-breakpoint
CREATE TABLE `knowledge_alarms` (`id` text PRIMARY KEY NOT NULL, `metric` text NOT NULL, `pack_version` integer, `baseline` real,
  `current` real, `n` integer NOT NULL, `threshold` real NOT NULL, `severity` text NOT NULL CHECK (`severity` IN ('warn','severe')),
  `status` text NOT NULL CHECK (`status` IN ('open','acknowledged','resolved')), `action_taken` text, `needs_you_id` text,
  `raised_at` text NOT NULL, `resolved_by` text, `resolved_at` text);
--> statement-breakpoint
CREATE TRIGGER `knowledge_checks_no_update` BEFORE UPDATE ON `knowledge_checks`
BEGIN
  SELECT RAISE(ABORT, 'knowledge_checks is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_checks_no_delete` BEFORE DELETE ON `knowledge_checks`
BEGIN
  SELECT RAISE(ABORT, 'knowledge_checks is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_changes_no_update` BEFORE UPDATE ON `knowledge_changes`
BEGIN
  SELECT RAISE(ABORT, 'knowledge_changes is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_changes_no_delete` BEFORE DELETE ON `knowledge_changes`
BEGIN
  SELECT RAISE(ABORT, 'knowledge_changes is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_pack_versions_no_update` BEFORE UPDATE ON `knowledge_pack_versions`
BEGIN
  SELECT RAISE(ABORT, 'knowledge_pack_versions is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_pack_versions_no_delete` BEFORE DELETE ON `knowledge_pack_versions`
BEGIN
  SELECT RAISE(ABORT, 'knowledge_pack_versions is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_pack_members_no_update` BEFORE UPDATE ON `knowledge_pack_members`
BEGIN
  SELECT RAISE(ABORT, 'knowledge_pack_members is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_pack_members_no_delete` BEFORE DELETE ON `knowledge_pack_members`
BEGIN
  SELECT RAISE(ABORT, 'knowledge_pack_members is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `contact_observations_no_update` BEFORE UPDATE ON `contact_observations`
BEGIN
  SELECT RAISE(ABORT, 'contact_observations is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `contact_observations_no_delete` BEFORE DELETE ON `contact_observations`
BEGIN
  SELECT RAISE(ABORT, 'contact_observations is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `offer_observations_no_update` BEFORE UPDATE ON `offer_observations`
BEGIN
  SELECT RAISE(ABORT, 'offer_observations is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `offer_observations_no_delete` BEFORE DELETE ON `offer_observations`
BEGIN
  SELECT RAISE(ABORT, 'offer_observations is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `corrections_no_update` BEFORE UPDATE ON `corrections`
BEGIN
  SELECT RAISE(ABORT, 'corrections is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `corrections_no_delete` BEFORE DELETE ON `corrections`
BEGIN
  SELECT RAISE(ABORT, 'corrections is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `source_snapshots_no_update` BEFORE UPDATE ON `source_snapshots`
BEGIN
  SELECT RAISE(ABORT, 'source_snapshots is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `source_snapshots_no_delete` BEFORE DELETE ON `source_snapshots`
BEGIN
  SELECT RAISE(ABORT, 'source_snapshots is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_usage_no_update` BEFORE UPDATE ON `knowledge_usage`
BEGIN
  SELECT RAISE(ABORT, 'knowledge_usage is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_usage_no_delete` BEFORE DELETE ON `knowledge_usage`
BEGIN
  SELECT RAISE(ABORT, 'knowledge_usage is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `eval_cases_no_update` BEFORE UPDATE ON `eval_cases`
BEGIN
  SELECT RAISE(ABORT, 'eval_cases is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `eval_cases_no_delete` BEFORE DELETE ON `eval_cases`
BEGIN
  SELECT RAISE(ABORT, 'eval_cases is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `eval_runs_no_update` BEFORE UPDATE ON `eval_runs`
BEGIN
  SELECT RAISE(ABORT, 'eval_runs is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `eval_runs_no_delete` BEFORE DELETE ON `eval_runs`
BEGIN
  SELECT RAISE(ABORT, 'eval_runs is append-only');
END;
