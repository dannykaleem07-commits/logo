-- Append-only enforcement at the database level (ARCHITECTURE convention 3).
-- ledger_entries, claim_events, evidence and audit_log are never updated or deleted;
-- corrections are new rows that reference the superseded row (supersedesId).
CREATE TRIGGER `ledger_entries_no_update` BEFORE UPDATE ON `ledger_entries`
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `ledger_entries_no_delete` BEFORE DELETE ON `ledger_entries`
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `claim_events_no_update` BEFORE UPDATE ON `claim_events`
BEGIN
  SELECT RAISE(ABORT, 'claim_events is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `claim_events_no_delete` BEFORE DELETE ON `claim_events`
BEGIN
  SELECT RAISE(ABORT, 'claim_events is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `evidence_no_update` BEFORE UPDATE ON `evidence`
BEGIN
  SELECT RAISE(ABORT, 'evidence is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `evidence_no_delete` BEFORE DELETE ON `evidence`
BEGIN
  SELECT RAISE(ABORT, 'evidence is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `audit_log_no_update` BEFORE UPDATE ON `audit_log`
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `audit_log_no_delete` BEFORE DELETE ON `audit_log`
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
