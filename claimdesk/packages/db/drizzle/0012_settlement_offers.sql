-- Settlement-offer register (docs/SUPREME-AUTOPILOT.md §D.9): insurer offers to settle a head of loss, kept apart from the
-- intervention register (intervention_offers), which starts the 1-WD intervention reply clock and feeds the mitigation
-- gate. Decision fields are written by the owner only. Journal `when` 1792210000000 sits between 0011_brain and the
-- reserved 0012_autopilot value (1792250000000); that migration must not create this table again.
CREATE TABLE `settlement_offers` (`id` text PRIMARY KEY NOT NULL, `claim_id` text NOT NULL, `head` text NOT NULL, `amount_pence` integer,
  `received_at` text NOT NULL, `offeror_name` text NOT NULL, `channel` text NOT NULL, `terms` text, `evidence_ids` text NOT NULL DEFAULT '[]',
  `mail_message_id` text, `status` text NOT NULL CHECK (`status` IN ('open','accepted','countered','rejected','lapsed','superseded')),
  `decided_by` text, `decided_at` text, `decision_note` text, `created_by` text NOT NULL, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `settlement_offers_claim_idx` ON `settlement_offers` (`claim_id`, `status`);
