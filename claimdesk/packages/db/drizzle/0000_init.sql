CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`user_id` text NOT NULL,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`before` text,
	`after` text,
	`ip` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `audit_log_user_idx` ON `audit_log` (`user_id`);--> statement-breakpoint
CREATE TABLE `claim_events` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`type` text NOT NULL,
	`at` text NOT NULL,
	`recorded_at` text NOT NULL,
	`summary` text NOT NULL,
	`data` text,
	`attributable_to` text,
	`evidence_ids` text NOT NULL,
	`document_id` text,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `claim_events_claim_idx` ON `claim_events` (`claim_id`);--> statement-breakpoint
CREATE INDEX `claim_events_claim_at_idx` ON `claim_events` (`claim_id`,`at`);--> statement-breakpoint
CREATE INDEX `claim_events_type_idx` ON `claim_events` (`claim_id`,`type`);--> statement-breakpoint
CREATE TABLE `claim_sequences` (
	`year` integer PRIMARY KEY NOT NULL,
	`last` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `claims` (
	`id` text PRIMARY KEY NOT NULL,
	`reference` text NOT NULL,
	`status` text NOT NULL,
	`opened_at` text NOT NULL,
	`accident` text NOT NULL,
	`liability` text NOT NULL,
	`liability_score` integer,
	`claimant_id` text NOT NULL,
	`driver_id` text,
	`client_vehicle_id` text NOT NULL,
	`third_party_ids` text NOT NULL,
	`third_party_vehicle_id` text,
	`at_fault_insurer_id` text,
	`at_fault_insurer_ref` text,
	`client_insurer_id` text,
	`client_policy_number` text,
	`handler_id` text,
	`gta_subscriber` integer DEFAULT false NOT NULL,
	`injury_referral` text,
	`track` text,
	`linked_claim_ids` text NOT NULL,
	`flags` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claims_reference_uq` ON `claims` (`reference`);--> statement-breakpoint
CREATE INDEX `claims_status_idx` ON `claims` (`status`);--> statement-breakpoint
CREATE INDEX `claims_claimant_idx` ON `claims` (`claimant_id`);--> statement-breakpoint
CREATE INDEX `claims_client_vehicle_idx` ON `claims` (`client_vehicle_id`);--> statement-breakpoint
CREATE INDEX `claims_third_party_vehicle_idx` ON `claims` (`third_party_vehicle_id`);--> statement-breakpoint
CREATE INDEX `claims_handler_idx` ON `claims` (`handler_id`);--> statement-breakpoint
CREATE INDEX `claims_at_fault_insurer_idx` ON `claims` (`at_fault_insurer_id`);--> statement-breakpoint
CREATE INDEX `claims_opened_at_idx` ON `claims` (`opened_at`);--> statement-breakpoint
CREATE TABLE `clocks` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`basis` text NOT NULL,
	`starts_at` text NOT NULL,
	`due_at` text NOT NULL,
	`status` text NOT NULL,
	`met_at` text,
	`stopped_at` text,
	`stopped_reason` text,
	`attributable_to` text,
	`source_event_id` text,
	`computed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `clocks_claim_idx` ON `clocks` (`claim_id`);--> statement-breakpoint
CREATE INDEX `clocks_due_idx` ON `clocks` (`status`,`due_at`);--> statement-breakpoint
CREATE TABLE `company_watch` (
	`company_number` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`last_polled_at` text,
	`status` text,
	`accounts_overdue` integer,
	`confirmation_statement_overdue` integer,
	`gazette_notices` text NOT NULL,
	`officer_changes` text NOT NULL,
	`risk_level` text NOT NULL,
	`risk_reasons` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `company_watch_risk_idx` ON `company_watch` (`risk_level`);--> statement-breakpoint
CREATE TABLE `directory_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`verification` text,
	`last_used_ok` text,
	`last_failed` text,
	`notes` text,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text,
	`template_id` text NOT NULL,
	`template_version` text NOT NULL,
	`title` text NOT NULL,
	`recipient_party_id` text,
	`status` text NOT NULL,
	`html` text NOT NULL,
	`pdf_path` text,
	`sha256` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`approved_at` text,
	`approved_by` text,
	`sent_at` text,
	`sent_via` text,
	`supersedes_id` text,
	`re_executed_on` text,
	`consistency` text,
	`signature` text,
	`data_snapshot` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `documents_claim_idx` ON `documents` (`claim_id`);--> statement-breakpoint
CREATE INDEX `documents_template_idx` ON `documents` (`template_id`);--> statement-breakpoint
CREATE INDEX `documents_status_idx` ON `documents` (`status`);--> statement-breakpoint
CREATE INDEX `documents_supersedes_idx` ON `documents` (`supersedes_id`);--> statement-breakpoint
CREATE TABLE `engineer_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`vehicle_id` text NOT NULL,
	`engineer_party_id` text NOT NULL,
	`engineer_qualifications` text NOT NULL,
	`instructed_by` text NOT NULL,
	`instructed_at` text NOT NULL,
	`inspection_at` text,
	`inspection_place` text,
	`inspection_basis` text NOT NULL,
	`inspection_conditions` text,
	`odometer_miles` integer,
	`pre_accident_condition` text NOT NULL,
	`damage_description` text NOT NULL,
	`consistent_with_circumstances` integer NOT NULL,
	`consistency_note` text,
	`repair_method` text,
	`estimate_id` text,
	`roadworthy` integer NOT NULL,
	`roadworthy_reason` text NOT NULL,
	`repair_duration_working_days` integer,
	`total_loss` text,
	`pav_assessment_id` text,
	`salvage_category` text,
	`salvage_value_pence` integer,
	`adas_notes` text,
	`ev_notes` text,
	`diagnostic_fault_codes` text,
	`photo_evidence_ids` text NOT NULL,
	`for_court` integer NOT NULL,
	`fee_pence` integer NOT NULL,
	`issued_at` text,
	`document_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `engineer_reports_claim_idx` ON `engineer_reports` (`claim_id`);--> statement-breakpoint
CREATE TABLE `estimates` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`vehicle_id` text NOT NULL,
	`lines` text NOT NULL,
	`labour_rate_pence` integer NOT NULL,
	`paint_rate_pence` integer NOT NULL,
	`paint_materials_method` text NOT NULL,
	`paint_materials_per_hour_pence` integer,
	`vat_rate` real NOT NULL,
	`imported_from_evidence_id` text,
	`imported_total_pence` integer,
	`reconciled` integer,
	`totals` text NOT NULL,
	`created_at` text NOT NULL,
	`approved_by` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `estimates_claim_idx` ON `estimates` (`claim_id`);--> statement-breakpoint
CREATE INDEX `estimates_vehicle_idx` ON `estimates` (`vehicle_id`);--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text,
	`kind` text NOT NULL,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_path` text NOT NULL,
	`captured_at` text,
	`uploaded_at` text NOT NULL,
	`uploaded_by` text NOT NULL,
	`exif` text,
	`capture_shot` text,
	`source_url` text,
	`description` text
);
--> statement-breakpoint
CREATE INDEX `evidence_claim_idx` ON `evidence` (`claim_id`);--> statement-breakpoint
CREATE INDEX `evidence_sha256_idx` ON `evidence` (`sha256`);--> statement-breakpoint
CREATE TABLE `fleet_units` (
	`id` text PRIMARY KEY NOT NULL,
	`vehicle_id` text NOT NULL,
	`declared_uses` text NOT NULL,
	`policy_id` text,
	`daily_rate_pence` integer NOT NULL,
	`gta_group` text NOT NULL,
	`keeper_address_on_v5c` text,
	`keeper_address_current` integer NOT NULL,
	`service_due_date` text,
	`status` text NOT NULL,
	`phv_licensed` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `fleet_units_vehicle_idx` ON `fleet_units` (`vehicle_id`);--> statement-breakpoint
CREATE INDEX `fleet_units_status_idx` ON `fleet_units` (`status`);--> statement-breakpoint
CREATE TABLE `hire_agreements` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`fleet_unit_id` text NOT NULL,
	`agreement_number` text NOT NULL,
	`start_at` text NOT NULL,
	`end_at` text,
	`end_trigger` text,
	`daily_rate_pence` integer NOT NULL,
	`vat_rate` real NOT NULL,
	`gta_group` text NOT NULL,
	`excess_pence` integer NOT NULL,
	`excess_waiver_daily_pence` integer,
	`additional_drivers` text NOT NULL,
	`delivered_at` text,
	`collected_at` text,
	`odometer_out` integer,
	`odometer_in` integer,
	`signed_at` text,
	`document_id` text,
	`enforceability` text NOT NULL,
	`need_statement_evidence_id` text,
	`mitigation_questionnaire_document_id` text,
	`statement_of_means_document_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hire_agreements_claim_idx` ON `hire_agreements` (`claim_id`);--> statement-breakpoint
CREATE INDEX `hire_agreements_fleet_unit_idx` ON `hire_agreements` (`fleet_unit_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `hire_agreements_number_uq` ON `hire_agreements` (`agreement_number`);--> statement-breakpoint
CREATE TABLE `insurance_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`insurer_name` text NOT NULL,
	`policy_number` text NOT NULL,
	`covered_uses` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`evidence_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `intervention_offers` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`received_at` text NOT NULL,
	`channel` text NOT NULL,
	`offeror_party_id` text,
	`offeror_name` text NOT NULL,
	`vehicle_class_offered` text,
	`daily_rate_pence` integer,
	`rate_includes_vat` integer,
	`terms` text NOT NULL,
	`suitable` integer,
	`suitability_reasons` text NOT NULL,
	`client_decision` text NOT NULL,
	`client_reasons` text,
	`client_decision_at` text,
	`reply_sent_at` text,
	`reply_document_id` text,
	`evidence_ids` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `intervention_offers_claim_idx` ON `intervention_offers` (`claim_id`);--> statement-breakpoint
CREATE TABLE `labour_library` (
	`id` text PRIMARY KEY NOT NULL,
	`make` text NOT NULL,
	`model` text NOT NULL,
	`panel` text NOT NULL,
	`operation` text NOT NULL,
	`hours` real NOT NULL,
	`rate_pence` integer,
	`source` text NOT NULL,
	`estimate_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `labour_library_lookup_idx` ON `labour_library` (`make`,`model`,`panel`,`operation`);--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`head` text NOT NULL,
	`kind` text NOT NULL,
	`amount_pence` integer NOT NULL,
	`vat_pence` integer,
	`date` text NOT NULL,
	`description` text NOT NULL,
	`counterparty_id` text,
	`reference` text,
	`source_document_id` text,
	`source_evidence_id` text,
	`supersedes_id` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ledger_entries_claim_idx` ON `ledger_entries` (`claim_id`);--> statement-breakpoint
CREATE INDEX `ledger_entries_claim_head_kind_idx` ON `ledger_entries` (`claim_id`,`head`,`kind`);--> statement-breakpoint
CREATE INDEX `ledger_entries_supersedes_idx` ON `ledger_entries` (`supersedes_id`);--> statement-breakpoint
CREATE TABLE `parties` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`trading_name` text,
	`date_of_birth` text,
	`address` text,
	`email` text,
	`phone` text,
	`company_number` text,
	`vat_registered` integer,
	`driving_licence_number` text,
	`bank` text,
	`roles` text NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`phone_normalised` text,
	`email_normalised` text,
	`postcode_normalised` text,
	`bank_key` text
);
--> statement-breakpoint
CREATE INDEX `parties_name_idx` ON `parties` (`name`);--> statement-breakpoint
CREATE INDEX `parties_phone_idx` ON `parties` (`phone_normalised`);--> statement-breakpoint
CREATE INDEX `parties_email_idx` ON `parties` (`email_normalised`);--> statement-breakpoint
CREATE INDEX `parties_postcode_idx` ON `parties` (`postcode_normalised`);--> statement-breakpoint
CREATE INDEX `parties_bank_idx` ON `parties` (`bank_key`);--> statement-breakpoint
CREATE INDEX `parties_company_number_idx` ON `parties` (`company_number`);--> statement-breakpoint
CREATE TABLE `pav_assessments` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`subject` text NOT NULL,
	`comparables` text NOT NULL,
	`per_mile_pence` real NOT NULL,
	`per_mile_source` text NOT NULL,
	`median_pence` integer NOT NULL,
	`iqr_low_pence` integer NOT NULL,
	`iqr_high_pence` integer NOT NULL,
	`trade_guide_pence` integer,
	`trade_guide_source` text,
	`pav_pence` integer NOT NULL,
	`override_reason` text,
	`reasoning` text NOT NULL,
	`approved_by` text,
	`approved_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pav_assessments_claim_idx` ON `pav_assessments` (`claim_id`);--> statement-breakpoint
CREATE TABLE `penalty_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`fleet_unit_id` text NOT NULL,
	`kind` text NOT NULL,
	`issuer` text NOT NULL,
	`notice_number` text NOT NULL,
	`contravention_at` text NOT NULL,
	`received_at` text NOT NULL,
	`amount_pence` integer NOT NULL,
	`discount_deadline` text,
	`response_deadline` text NOT NULL,
	`hire_agreement_id` text,
	`stage` text NOT NULL,
	`notes` text,
	`document_ids` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `penalty_notices_fleet_unit_idx` ON `penalty_notices` (`fleet_unit_id`);--> statement-breakpoint
CREATE INDEX `penalty_notices_stage_idx` ON `penalty_notices` (`stage`);--> statement-breakpoint
CREATE TABLE `recovery_records` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`at` text NOT NULL,
	`from_location` text NOT NULL,
	`to_location` text NOT NULL,
	`callout_pence` integer NOT NULL,
	`loaded_miles` real NOT NULL,
	`per_loaded_mile_pence` integer NOT NULL,
	`admin_pence` integer NOT NULL,
	`vat_rate` real NOT NULL,
	`evidence_ids` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recovery_records_claim_idx` ON `recovery_records` (`claim_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`company_name` text NOT NULL,
	`company_number` text,
	`registered_office` text,
	`vat_number` text,
	`bank` text,
	`ico_registration` text,
	`rate_card` text NOT NULL,
	`api_keys_present` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `signatures` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`signer_party_id` text NOT NULL,
	`signer_name` text NOT NULL,
	`signer_contact` text NOT NULL,
	`otp_channel` text NOT NULL,
	`otp_verified_at` text NOT NULL,
	`ip_address` text NOT NULL,
	`user_agent` text NOT NULL,
	`signed_at` text NOT NULL,
	`document_sha256` text NOT NULL,
	`certificate_pdf_path` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `signatures_document_idx` ON `signatures` (`document_id`);--> statement-breakpoint
CREATE INDEX `signatures_signer_idx` ON `signatures` (`signer_party_id`);--> statement-breakpoint
CREATE TABLE `storage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`location` text NOT NULL,
	`start_at` text NOT NULL,
	`end_at` text,
	`end_trigger` text,
	`daily_rate_pence` integer NOT NULL,
	`vat_rate` real NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `storage_records_claim_idx` ON `storage_records` (`claim_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`mfa_enabled` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `vehicles` (
	`id` text PRIMARY KEY NOT NULL,
	`registration` text NOT NULL,
	`vin` text,
	`make` text NOT NULL,
	`model` text NOT NULL,
	`variant` text,
	`body_type` text,
	`year_of_manufacture` integer,
	`month_of_first_registration` text,
	`fuel_type` text,
	`transmission` text,
	`colour` text,
	`engine_capacity_cc` integer,
	`co2_gkm` integer,
	`euro_status` text,
	`tax_status` text,
	`tax_due_date` text,
	`mot_status` text,
	`mot_expiry_date` text,
	`marked_for_export` integer,
	`date_of_last_v5c_issued` text,
	`mot_history` text,
	`odometer` text NOT NULL,
	`gta_group` text,
	`previous_write_off_category` text,
	`ownership` text NOT NULL,
	`lookups` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vehicles_registration_uq` ON `vehicles` (`registration`);--> statement-breakpoint
CREATE INDEX `vehicles_vin_idx` ON `vehicles` (`vin`);