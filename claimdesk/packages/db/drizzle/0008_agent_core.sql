-- ClaimDesk Supreme phase 1 (docs/SUPREME-DESIGN.md §N.1): durable agent queue, runs, tool calls, usage state, settings,
-- Needs-you inbox, tasks, reviews, notifications, daily logs, audit run ids. Append-only: agent_job_attempts,
-- agent_tool_calls, needs_you_events, reviews (BEFORE UPDATE / DELETE triggers, as 0001).
CREATE TABLE `agent_jobs` (
  `id` text PRIMARY KEY NOT NULL, `type` text NOT NULL, `agent` text NOT NULL, `claim_id` text, `payload` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('queued','leased','waiting_usage','waiting_user','succeeded','failed','cancelled','dead')),
  `lane` text NOT NULL CHECK (`lane` IN ('ai','io','cpu')), `mutates` integer NOT NULL DEFAULT 0,
  `priority` integer NOT NULL DEFAULT 5, `run_after` text NOT NULL, `attempts` integer NOT NULL DEFAULT 0,
  `max_attempts` integer NOT NULL DEFAULT 3, `lease_owner` text, `lease_until` text, `idempotency_key` text,
  `parent_job_id` text, `correlation_id` text NOT NULL, `depth` integer NOT NULL DEFAULT 0,
  `result` text, `error` text, `needs_you_id` text, `created_by` text NOT NULL,
  `created_at` text NOT NULL, `updated_at` text NOT NULL, `finished_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_jobs_idem_uq` ON `agent_jobs` (`idempotency_key`) WHERE `idempotency_key` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `agent_jobs_ready_idx` ON `agent_jobs` (`status`, `lane`, `priority`, `run_after`);
--> statement-breakpoint
CREATE INDEX `agent_jobs_claim_idx` ON `agent_jobs` (`claim_id`, `status`);
--> statement-breakpoint
CREATE INDEX `agent_jobs_corr_idx` ON `agent_jobs` (`correlation_id`);
--> statement-breakpoint
CREATE TABLE `agent_job_attempts` (`id` text PRIMARY KEY NOT NULL, `job_id` text NOT NULL, `attempt` integer NOT NULL,
  `started_at` text NOT NULL, `finished_at` text, `outcome` text NOT NULL, `error` text, `run_id` text);
--> statement-breakpoint
CREATE INDEX `agent_job_attempts_job_idx` ON `agent_job_attempts` (`job_id`, `attempt`);
--> statement-breakpoint
CREATE TABLE `agent_schedules` (`id` text PRIMARY KEY NOT NULL, `job_type` text NOT NULL, `payload` text NOT NULL DEFAULT '{}',
  `every_minutes` integer, `at_local` text, `weekdays` text, `enabled` integer NOT NULL DEFAULT 1,
  `next_run_at` text NOT NULL, `last_run_at` text, `last_job_id` text, `updated_at` text NOT NULL);
--> statement-breakpoint
CREATE TABLE `agent_runs` (`id` text PRIMARY KEY NOT NULL, `job_id` text NOT NULL, `agent` text NOT NULL, `job_type` text NOT NULL,
  `claim_id` text, `driver` text NOT NULL, `model` text NOT NULL, `effort` text NOT NULL, `prompt_version` text NOT NULL,
  `input_sha256` text NOT NULL, `started_at` text NOT NULL, `ended_at` text,
  `outcome` text CHECK (`outcome` IN ('ok','usage_limited','auth_failed','refused','invalid_output','timeout','error','cancelled')),
  `num_turns` integer, `tool_calls` integer NOT NULL DEFAULT 0, `input_tokens` integer, `output_tokens` integer,
  `cache_read_tokens` integer, `cache_write_tokens` integer, `cost_usd` real, `rate_limit` text, `result` text, `error` text);
--> statement-breakpoint
CREATE INDEX `agent_runs_claim_idx` ON `agent_runs` (`claim_id`, `started_at`);
--> statement-breakpoint
CREATE INDEX `agent_runs_agent_idx` ON `agent_runs` (`agent`, `started_at`);
--> statement-breakpoint
CREATE INDEX `agent_runs_job_idx` ON `agent_runs` (`job_id`);
--> statement-breakpoint
CREATE TABLE `agent_tool_calls` (`id` text PRIMARY KEY NOT NULL, `run_id` text NOT NULL, `seq` integer NOT NULL, `tool` text NOT NULL,
  `action_class` text NOT NULL, `decision` text NOT NULL CHECK (`decision` IN ('allowed','asked','denied','invalid','error')),
  `rule_ids` text, `input_redacted` text, `output_summary` text, `http_status` integer, `needs_you_id` text,
  `duration_ms` integer, `at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `agent_tool_calls_run_idx` ON `agent_tool_calls` (`run_id`, `seq`);
--> statement-breakpoint
CREATE TABLE `ai_usage_state` (`id` text PRIMARY KEY NOT NULL, `driver` text NOT NULL, `paused_until` text, `pause_reason` text,
  `five_hour` text, `seven_day` text, `cost_today_usd` real NOT NULL DEFAULT 0, `cost_day` text, `updated_at` text NOT NULL);
--> statement-breakpoint
CREATE TABLE `agent_settings` (`id` text PRIMARY KEY NOT NULL, `ai` text NOT NULL, `autonomy` text NOT NULL,
  `notifications` text NOT NULL, `agents` text NOT NULL, `checklist` text NOT NULL, `updated_at` text NOT NULL, `updated_by` text NOT NULL);
--> statement-breakpoint
CREATE TABLE `claim_agent_state` (`claim_id` text PRIMARY KEY NOT NULL, `paused` integer NOT NULL DEFAULT 0, `paused_by` text,
  `paused_reason` text, `paused_at` text, `last_review_at` text, `last_review_run_id` text, `next_review_at` text,
  `runs_today` integer NOT NULL DEFAULT 0, `runs_day` text);
--> statement-breakpoint
CREATE TABLE `needs_you` (`id` text PRIMARY KEY NOT NULL, `kind` text NOT NULL, `claim_id` text, `title` text NOT NULL,
  `summary` text NOT NULL, `recommendation` text, `options` text NOT NULL, `payload` text NOT NULL,
  `priority` text NOT NULL CHECK (`priority` IN ('urgent','high','normal','low')), `due_at` text,
  `status` text NOT NULL CHECK (`status` IN ('open','snoozed','resolved','expired','superseded')),
  `snoozed_until` text, `resolution` text, `dedupe_key` text, `correlation_id` text, `resumes_job_id` text,
  `created_by` text NOT NULL, `created_at` text NOT NULL, `resolved_by` text, `resolved_at` text);
--> statement-breakpoint
CREATE UNIQUE INDEX `needs_you_dedupe_uq` ON `needs_you` (`dedupe_key`) WHERE `dedupe_key` IS NOT NULL AND `status` IN ('open','snoozed');
--> statement-breakpoint
CREATE INDEX `needs_you_open_idx` ON `needs_you` (`status`, `priority`, `created_at`);
--> statement-breakpoint
CREATE INDEX `needs_you_claim_idx` ON `needs_you` (`claim_id`, `status`);
--> statement-breakpoint
CREATE TABLE `needs_you_events` (`id` text PRIMARY KEY NOT NULL, `needs_you_id` text NOT NULL, `from_status` text, `to_status` text NOT NULL,
  `actor` text NOT NULL, `option_id` text, `note` text, `at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `needs_you_events_item_idx` ON `needs_you_events` (`needs_you_id`, `at`);
--> statement-breakpoint
CREATE TABLE `tasks` (`id` text PRIMARY KEY NOT NULL, `claim_id` text NOT NULL, `kind` text NOT NULL, `title` text NOT NULL,
  `note` text, `action_code` text, `due_at` text NOT NULL, `status` text NOT NULL CHECK (`status` IN ('open','done','cancelled')),
  `created_by` text NOT NULL, `created_at` text NOT NULL, `completed_by` text, `completed_at` text, `source_run_id` text);
--> statement-breakpoint
CREATE INDEX `tasks_due_idx` ON `tasks` (`status`, `due_at`);
--> statement-breakpoint
CREATE INDEX `tasks_claim_idx` ON `tasks` (`claim_id`, `status`);
--> statement-breakpoint
CREATE TABLE `reviews` (`id` text PRIMARY KEY NOT NULL, `target_kind` text NOT NULL CHECK (`target_kind` IN ('outbox','document','docx')),
  `target_id` text NOT NULL, `claim_id` text, `loop` integer NOT NULL, `rules` text NOT NULL, `facts` text NOT NULL,
  `critic` text, `verdict` text NOT NULL CHECK (`verdict` IN ('pass','repair','escalate')), `touches` text NOT NULL,
  `run_id` text, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `reviews_target_idx` ON `reviews` (`target_kind`, `target_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `notifications` (`id` text PRIMARY KEY NOT NULL, `needs_you_id` text, `level` text NOT NULL, `title` text NOT NULL,
  `body` text NOT NULL, `link` text, `channels` text NOT NULL, `deliveries` text NOT NULL DEFAULT '[]',
  `created_at` text NOT NULL, `read_at` text);
--> statement-breakpoint
CREATE INDEX `notifications_created_idx` ON `notifications` (`created_at`);
--> statement-breakpoint
CREATE TABLE `daily_logs` (`day` text PRIMARY KEY NOT NULL, `compiled_at` text NOT NULL, `log` text NOT NULL, `emailed_at` text);
--> statement-breakpoint
ALTER TABLE `audit_log` ADD `run_id` text;
--> statement-breakpoint
CREATE INDEX `audit_log_run_idx` ON `audit_log` (`run_id`);
--> statement-breakpoint
CREATE TRIGGER `agent_job_attempts_no_update` BEFORE UPDATE ON `agent_job_attempts`
BEGIN
  SELECT RAISE(ABORT, 'agent_job_attempts is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `agent_job_attempts_no_delete` BEFORE DELETE ON `agent_job_attempts`
BEGIN
  SELECT RAISE(ABORT, 'agent_job_attempts is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `agent_tool_calls_no_update` BEFORE UPDATE ON `agent_tool_calls`
BEGIN
  SELECT RAISE(ABORT, 'agent_tool_calls is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `agent_tool_calls_no_delete` BEFORE DELETE ON `agent_tool_calls`
BEGIN
  SELECT RAISE(ABORT, 'agent_tool_calls is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `needs_you_events_no_update` BEFORE UPDATE ON `needs_you_events`
BEGIN
  SELECT RAISE(ABORT, 'needs_you_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `needs_you_events_no_delete` BEFORE DELETE ON `needs_you_events`
BEGIN
  SELECT RAISE(ABORT, 'needs_you_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `reviews_no_update` BEFORE UPDATE ON `reviews`
BEGIN
  SELECT RAISE(ABORT, 'reviews is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `reviews_no_delete` BEFORE DELETE ON `reviews`
BEGIN
  SELECT RAISE(ABORT, 'reviews is append-only');
END;
