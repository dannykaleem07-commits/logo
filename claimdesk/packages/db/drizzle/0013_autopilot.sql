-- ClaimDesk Supreme Autopilot (docs/SUPREME-AUTOPILOT.md §G.2): claim autopilot state and log, the fleet diary
-- (reservations with an overlap trigger on integer epoch-ms periods), locations, readiness, damage, movements, hire offers,
-- driver profiles, hire needs, eligibility assessments, clash findings, document packs, signature requests and kiosk
-- sessions; new columns on fleet_units, insurance_policies, hire_agreements, agent_settings, signatures and outbox; and a
-- back-fill of one reservation per existing hire (source 'backfill': legacy overlaps are kept, never refused).
-- Journal `when` 1792250000000 (§G.1). settlement_offers is NOT created here: 0012_settlement_offers already did.
-- autopilot_log, fleet_reservation_events, eligibility_assessments and signature_request_events are append-only.
-- unixepoch(…, 'subsec') needs SQLite >= 3.42 (bundled 3.53.x); an unparseable legacy date back-fills as epoch 0.
CREATE TABLE `claim_autopilot` (`claim_id` text PRIMARY KEY NOT NULL,
  `mode` text NOT NULL DEFAULT 'on' CHECK (`mode` IN ('on','paused','off')), `paused_by` text, `paused_reason` text, `paused_at` text,
  `step_overrides` text NOT NULL DEFAULT '{}', `stage` text, `plan` text, `plan_hash` text, `plan_version` text,
  `last_evaluated_at` text, `next_check_at` text, `updated_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `claim_autopilot_next_idx` ON `claim_autopilot` (`mode`, `next_check_at`);
--> statement-breakpoint
CREATE TABLE `autopilot_log` (`id` text PRIMARY KEY NOT NULL, `claim_id` text NOT NULL, `step_id` text NOT NULL, `from_status` text,
  `to_status` text NOT NULL, `action` text, `actor` text NOT NULL, `decision` text, `job_id` text, `run_id` text, `needs_you_id` text,
  `refs` text NOT NULL DEFAULT '{}', `note` text, `at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `autopilot_log_claim_idx` ON `autopilot_log` (`claim_id`, `at`);
--> statement-breakpoint
CREATE TABLE `fleet_locations` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `address` text, `postcode` text, `lat` real, `lon` real,
  `is_default` integer NOT NULL DEFAULT 0, `created_at` text NOT NULL, `updated_at` text NOT NULL);
--> statement-breakpoint
ALTER TABLE `fleet_units` ADD `location_id` text;
--> statement-breakpoint
ALTER TABLE `fleet_units` ADD `current_mileage` integer;
--> statement-breakpoint
ALTER TABLE `fleet_units` ADD `mileage_at` text;
--> statement-breakpoint
ALTER TABLE `fleet_units` ADD `service_due_miles` integer;
--> statement-breakpoint
ALTER TABLE `fleet_units` ADD `phv_licence_number` text;
--> statement-breakpoint
ALTER TABLE `fleet_units` ADD `phv_licence_expiry` text;
--> statement-breakpoint
ALTER TABLE `fleet_units` ADD `turnaround_minutes` integer;
--> statement-breakpoint
ALTER TABLE `insurance_policies` ADD `driver_criteria` text;
--> statement-breakpoint
ALTER TABLE `insurance_policies` ADD `renews_policy_id` text;
--> statement-breakpoint
CREATE TABLE `fleet_readiness_tasks` (`id` text PRIMARY KEY NOT NULL, `fleet_unit_id` text NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('valet','inspection','service','damage_repair','mot','tax','tyres','keys','phv_licence','other')),
  `status` text NOT NULL CHECK (`status` IN ('open','done','cancelled')), `blocks_hire` integer NOT NULL DEFAULT 0,
  `due_at` text, `ready_by_at` text, `reservation_id` text, `damage_id` text, `note` text,
  `created_by` text NOT NULL, `created_at` text NOT NULL, `done_by` text, `done_at` text);
--> statement-breakpoint
CREATE INDEX `fleet_readiness_unit_idx` ON `fleet_readiness_tasks` (`fleet_unit_id`, `status`);
--> statement-breakpoint
CREATE TABLE `fleet_damage` (`id` text PRIMARY KEY NOT NULL, `fleet_unit_id` text NOT NULL, `panel` text NOT NULL, `description` text NOT NULL,
  `severity` text NOT NULL CHECK (`severity` IN ('cosmetic','minor','major','unroadworthy')), `found_at` text NOT NULL, `found_by` text NOT NULL,
  `reservation_id` text, `movement_id` text, `evidence_ids` text NOT NULL DEFAULT '[]', `repaired_at` text, `repair_task_id` text,
  `chargeable` text NOT NULL DEFAULT 'tbc' CHECK (`chargeable` IN ('none','hirer','third_party','tbc')), `created_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `fleet_damage_unit_idx` ON `fleet_damage` (`fleet_unit_id`, `repaired_at`);
--> statement-breakpoint
CREATE TABLE `fleet_reservations` (`id` text PRIMARY KEY NOT NULL, `fleet_unit_id` text NOT NULL, `claim_id` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('held','confirmed','on_hire','returned','cancelled','expired')),
  `use` text NOT NULL CHECK (`use` IN ('credit_hire','self_drive','pco')),
  `start_at` text NOT NULL, `expected_end_at` text, `end_at` text, `collected_at` text,
  `block_start_ms` integer NOT NULL, `block_end_ms` integer,
  `hold_expires_at` text, `hold_expires_ms` integer,
  `hirer_party_id` text NOT NULL, `driver_party_ids` text NOT NULL DEFAULT '[]',
  `agreement_number` text, `hire_agreement_id` text, `hire_offer_id` text,
  `daily_rate_pence` integer NOT NULL, `gta_group` text NOT NULL, `client_gta_group` text, `pricing_note` text, `substitution_reason` text,
  `ranking` text, `clash_report` text, `overlap_override_audit_id` text,
  `source` text NOT NULL CHECK (`source` IN ('autopilot','handler','backfill')),
  `created_by` text NOT NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL, `cancelled_reason` text);
--> statement-breakpoint
CREATE INDEX `fleet_reservations_unit_idx` ON `fleet_reservations` (`fleet_unit_id`, `status`, `block_start_ms`);
--> statement-breakpoint
CREATE INDEX `fleet_reservations_claim_idx` ON `fleet_reservations` (`claim_id`, `status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `fleet_reservations_agreement_uq` ON `fleet_reservations` (`agreement_number`) WHERE `agreement_number` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `fleet_reservations_hire_uq` ON `fleet_reservations` (`hire_agreement_id`) WHERE `hire_agreement_id` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `fleet_reservation_events` (`id` text PRIMARY KEY NOT NULL, `reservation_id` text NOT NULL, `from_status` text,
  `to_status` text NOT NULL, `actor` text NOT NULL, `reason` text, `data` text, `at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `fleet_reservation_events_res_idx` ON `fleet_reservation_events` (`reservation_id`, `at`);
--> statement-breakpoint
CREATE TRIGGER `fleet_reservations_overlap_ins` BEFORE INSERT ON `fleet_reservations`
WHEN NEW.`status` IN ('held','confirmed','on_hire','returned') AND NEW.`overlap_override_audit_id` IS NULL AND NEW.`source` <> 'backfill'
BEGIN
  SELECT RAISE(ABORT, 'RESERVATION_OVERLAP') WHERE EXISTS (SELECT 1 FROM `fleet_reservations` r
    WHERE r.`fleet_unit_id` = NEW.`fleet_unit_id` AND r.`id` <> NEW.`id` AND r.`status` IN ('held','confirmed','on_hire','returned')
      AND r.`block_start_ms` < COALESCE(NEW.`block_end_ms`, 9007199254740991)
      AND NEW.`block_start_ms` < COALESCE(r.`block_end_ms`, 9007199254740991));
END;
--> statement-breakpoint
CREATE TRIGGER `fleet_reservations_overlap_upd` BEFORE UPDATE OF `status`, `fleet_unit_id`, `block_start_ms`, `block_end_ms` ON `fleet_reservations`
WHEN NEW.`status` IN ('held','confirmed') AND NEW.`overlap_override_audit_id` IS NULL
BEGIN
  SELECT RAISE(ABORT, 'RESERVATION_OVERLAP') WHERE EXISTS (SELECT 1 FROM `fleet_reservations` r
    WHERE r.`fleet_unit_id` = NEW.`fleet_unit_id` AND r.`id` <> NEW.`id` AND r.`status` IN ('held','confirmed','on_hire','returned')
      AND r.`block_start_ms` < COALESCE(NEW.`block_end_ms`, 9007199254740991)
      AND NEW.`block_start_ms` < COALESCE(r.`block_end_ms`, 9007199254740991));
END;
--> statement-breakpoint
CREATE TABLE `fleet_movements` (`id` text PRIMARY KEY NOT NULL, `reservation_id` text NOT NULL, `claim_id` text NOT NULL, `fleet_unit_id` text NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('delivery','collection','swap_out','swap_in','transfer')),
  `window_start` text NOT NULL, `window_end` text NOT NULL, `address` text, `postcode` text, `assigned_to` text,
  `status` text NOT NULL CHECK (`status` IN ('planned','confirmed','done','failed','cancelled')), `done_at` text, `odometer` integer,
  `fuel_eighths` integer, `condition_document_id` text, `evidence_ids` text NOT NULL DEFAULT '[]', `client_notified_at` text,
  `notice_outbox_id` text, `notes` text,
  `created_by` text NOT NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `fleet_movements_window_idx` ON `fleet_movements` (`status`, `window_start`);
--> statement-breakpoint
CREATE INDEX `fleet_movements_reservation_idx` ON `fleet_movements` (`reservation_id`);
--> statement-breakpoint
CREATE TABLE `hire_offers` (`id` text PRIMARY KEY NOT NULL, `claim_id` text NOT NULL, `reservation_id` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('draft','sent','accepted','declined','expired','withdrawn','superseded')),
  `channel` text NOT NULL CHECK (`channel` IN ('email','sms','phone','in_person')), `terms` text NOT NULL, `terms_sha256` text NOT NULL,
  `outbox_id` text, `authorised_by` text NOT NULL, `sent_at` text, `expires_at` text NOT NULL, `response` text, `responded_at` text,
  `created_by` text NOT NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `hire_offers_claim_idx` ON `hire_offers` (`claim_id`, `status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `hire_offers_outbox_uq` ON `hire_offers` (`outbox_id`) WHERE `outbox_id` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `driver_profiles` (`party_id` text PRIMARY KEY NOT NULL, `profile` text NOT NULL, `source` text NOT NULL,
  `updated_by` text NOT NULL, `updated_at` text NOT NULL);
--> statement-breakpoint
CREATE TABLE `claim_hire_needs` (`claim_id` text PRIMARY KEY NOT NULL, `needs` text NOT NULL, `updated_by` text NOT NULL, `updated_at` text NOT NULL);
--> statement-breakpoint
CREATE TABLE `eligibility_assessments` (`id` text PRIMARY KEY NOT NULL, `claim_id` text NOT NULL, `party_id` text, `policy_id` text,
  `kind` text NOT NULL CHECK (`kind` IN ('driver','need','means','roadworthiness','injury','acceptance','overall')),
  `outcome` text NOT NULL, `reasons` text NOT NULL, `inputs_sha256` text NOT NULL, `created_by` text NOT NULL, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `eligibility_claim_idx` ON `eligibility_assessments` (`claim_id`, `kind`, `created_at`);
--> statement-breakpoint
CREATE TABLE `clash_findings` (`id` text PRIMARY KEY NOT NULL, `code` text NOT NULL,
  `severity` text NOT NULL CHECK (`severity` IN ('block','warn','info')), `override_class` text,
  `claim_id` text, `fleet_unit_id` text, `reservation_id` text, `hire_id` text, `related` text NOT NULL DEFAULT '{}',
  `message` text NOT NULL, `data` text, `dedupe_key` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('open','acknowledged','overridden','resolved')),
  `first_seen_at` text NOT NULL, `last_seen_at` text NOT NULL, `resolved_at` text, `resolved_by` text, `resolution_note` text, `override_audit_id` text);
--> statement-breakpoint
CREATE UNIQUE INDEX `clash_findings_open_uq` ON `clash_findings` (`dedupe_key`) WHERE `status` IN ('open','acknowledged');
--> statement-breakpoint
CREATE INDEX `clash_findings_claim_idx` ON `clash_findings` (`claim_id`, `status`);
--> statement-breakpoint
CREATE INDEX `clash_findings_unit_idx` ON `clash_findings` (`fleet_unit_id`, `status`);
--> statement-breakpoint
CREATE TABLE `document_packs` (`id` text PRIMARY KEY NOT NULL, `claim_id` text NOT NULL,
  `stage` text NOT NULL CHECK (`stage` IN ('signup','hire_offer','hire_start','off_hire','billing','payment','closure')),
  `reservation_id` text, `items` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('preparing','reviewing','awaiting_approval','approved','sent','signed','superseded','cancelled')),
  `approved_by` text, `approved_at` text, `sent_at` text, `outbox_id` text, `created_by` text NOT NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `document_packs_claim_idx` ON `document_packs` (`claim_id`, `stage`, `status`);
--> statement-breakpoint
CREATE TABLE `signature_requests` (`id` text PRIMARY KEY NOT NULL, `pack_id` text, `document_id` text NOT NULL, `claim_id` text NOT NULL,
  `signer_party_id` text NOT NULL, `method` text NOT NULL CHECK (`method` IN ('kiosk_otp_email','kiosk_handler_code','wet_email','wet_post')),
  `status` text NOT NULL CHECK (`status` IN ('prepared','sent','chased','returned','signed','declined','cancelled')),
  `sent_at` text, `chase_count` integer NOT NULL DEFAULT 0, `last_chased_at` text, `next_chase_at` text, `returned_evidence_id` text,
  `signed_at` text, `confirmed_by` text, `created_at` text NOT NULL, `updated_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `signature_requests_open_idx` ON `signature_requests` (`status`, `next_chase_at`);
--> statement-breakpoint
CREATE INDEX `signature_requests_claim_idx` ON `signature_requests` (`claim_id`, `status`);
--> statement-breakpoint
CREATE TABLE `signature_request_events` (`id` text PRIMARY KEY NOT NULL, `signature_request_id` text NOT NULL, `from_status` text,
  `to_status` text NOT NULL, `actor` text NOT NULL, `note` text, `at` text NOT NULL);
--> statement-breakpoint
CREATE TABLE `kiosk_sessions` (`id` text PRIMARY KEY NOT NULL, `pack_id` text NOT NULL, `claim_id` text NOT NULL, `signer_party_id` text NOT NULL,
  `token_sha256` text NOT NULL, `lan` integer NOT NULL DEFAULT 0, `created_by` text NOT NULL, `created_at` text NOT NULL, `expires_at` text NOT NULL,
  `opened_at` text, `opened_ip` text, `opened_user_agent` text, `completed_at` text, `closed_reason` text);
--> statement-breakpoint
CREATE UNIQUE INDEX `kiosk_sessions_token_uq` ON `kiosk_sessions` (`token_sha256`);
--> statement-breakpoint
ALTER TABLE `hire_agreements` ADD `use` text;
--> statement-breakpoint
ALTER TABLE `hire_agreements` ADD `hirer_party_id` text;
--> statement-breakpoint
ALTER TABLE `hire_agreements` ADD `driver_party_ids` text;
--> statement-breakpoint
ALTER TABLE `hire_agreements` ADD `reservation_id` text;
--> statement-breakpoint
ALTER TABLE `hire_agreements` ADD `expected_end_at` text;
--> statement-breakpoint
ALTER TABLE `agent_settings` ADD `autopilot` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE `signatures` ADD `method` text;
--> statement-breakpoint
ALTER TABLE `signatures` ADD `drawn_signature_sha256` text;
--> statement-breakpoint
ALTER TABLE `signatures` ADD `evidence_id` text;
--> statement-breakpoint
ALTER TABLE `signatures` ADD `pack_id` text;
--> statement-breakpoint
ALTER TABLE `signatures` ADD `pack_sha256` text;
--> statement-breakpoint
ALTER TABLE `outbox` ADD `autopilot_step_id` text;
--> statement-breakpoint
INSERT INTO `fleet_reservations` (`id`, `fleet_unit_id`, `claim_id`, `status`, `use`, `start_at`, `expected_end_at`, `end_at`, `collected_at`,
  `block_start_ms`, `block_end_ms`, `hirer_party_id`, `driver_party_ids`, `agreement_number`, `hire_agreement_id`, `daily_rate_pence`, `gta_group`,
  `client_gta_group`, `pricing_note`, `source`, `created_by`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), h.`fleet_unit_id`, h.`claim_id`,
  CASE WHEN h.`end_at` IS NULL OR unixepoch(h.`end_at`, 'subsec') > unixepoch('now', 'subsec') THEN 'on_hire' ELSE 'returned' END,
  COALESCE((SELECT json_extract(e.`data`, '$.use') FROM `claim_events` e WHERE e.`claim_id` = h.`claim_id` AND e.`type` = 'hire_started'
            AND json_valid(e.`data`) AND json_extract(e.`data`, '$.hireId') = h.`id`
            AND json_extract(e.`data`, '$.use') IN ('credit_hire','self_drive','pco') ORDER BY e.`recorded_at` LIMIT 1), 'credit_hire'),
  h.`start_at`, h.`end_at`, h.`end_at`, h.`collected_at`,
  COALESCE(CAST(unixepoch(h.`start_at`, 'subsec') * 1000 AS INTEGER), 0),
  CASE WHEN h.`end_at` IS NULL THEN NULL
       ELSE MAX(COALESCE(CAST(unixepoch(h.`end_at`, 'subsec') * 1000 AS INTEGER), 0), COALESCE(CAST(unixepoch(h.`collected_at`, 'subsec') * 1000 AS INTEGER), 0)) END,
  c.`claimant_id`, '[]', h.`agreement_number`, h.`id`, h.`daily_rate_pence`, h.`gta_group`, h.`client_gta_group`, h.`pricing_note`,
  'backfill', 'system', h.`created_at`, h.`created_at`
FROM `hire_agreements` h JOIN `claims` c ON c.`id` = h.`claim_id`;
--> statement-breakpoint
UPDATE `hire_agreements` SET `reservation_id` = (SELECT r.`id` FROM `fleet_reservations` r WHERE r.`hire_agreement_id` = `hire_agreements`.`id`),
  `use` = (SELECT r.`use` FROM `fleet_reservations` r WHERE r.`hire_agreement_id` = `hire_agreements`.`id`),
  `hirer_party_id` = (SELECT c.`claimant_id` FROM `claims` c WHERE c.`id` = `hire_agreements`.`claim_id`), `driver_party_ids` = '[]';
--> statement-breakpoint
CREATE TRIGGER `autopilot_log_no_update` BEFORE UPDATE ON `autopilot_log`
BEGIN
  SELECT RAISE(ABORT, 'autopilot_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `autopilot_log_no_delete` BEFORE DELETE ON `autopilot_log`
BEGIN
  SELECT RAISE(ABORT, 'autopilot_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `fleet_reservation_events_no_update` BEFORE UPDATE ON `fleet_reservation_events`
BEGIN
  SELECT RAISE(ABORT, 'fleet_reservation_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `fleet_reservation_events_no_delete` BEFORE DELETE ON `fleet_reservation_events`
BEGIN
  SELECT RAISE(ABORT, 'fleet_reservation_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `eligibility_assessments_no_update` BEFORE UPDATE ON `eligibility_assessments`
BEGIN
  SELECT RAISE(ABORT, 'eligibility_assessments is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `eligibility_assessments_no_delete` BEFORE DELETE ON `eligibility_assessments`
BEGIN
  SELECT RAISE(ABORT, 'eligibility_assessments is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `signature_request_events_no_update` BEFORE UPDATE ON `signature_request_events`
BEGIN
  SELECT RAISE(ABORT, 'signature_request_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `signature_request_events_no_delete` BEFORE DELETE ON `signature_request_events`
BEGIN
  SELECT RAISE(ABORT, 'signature_request_events is append-only');
END;
