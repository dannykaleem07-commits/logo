-- Branded HTML email footer (Settings > Email "HTML footer", default on). Journal `when` 1792560000000 (after
-- 0016_claim_ai_input 1792550000000). Off: emails go as plain text only, as before.
ALTER TABLE `mail_accounts` ADD `html_footer` integer DEFAULT 1 NOT NULL;
