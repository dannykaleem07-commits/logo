import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, createDatabase, type DatabaseHandle } from './client.js';
import { runMigrations } from './migrate.js';

const handles: DatabaseHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) closeDatabase(h);
});

const EXPECTED_TABLES = [
  'users',
  'parties',
  'vehicles',
  'fleet_units',
  'insurance_policies',
  'penalty_notices',
  'claim_sequences',
  'claims',
  'ledger_entries',
  'claim_events',
  'hire_agreements',
  'storage_records',
  'recovery_records',
  'intervention_offers',
  'clocks',
  'evidence',
  'documents',
  'signatures',
  'pav_assessments',
  'estimates',
  'engineer_reports',
  'company_watch',
  'directory_overrides',
  'settings',
  'audit_log',
  'labour_library',
];

describe('migrations', () => {
  it('apply to an in-memory database and create every table', () => {
    const h = createDatabase({ path: ':memory:' });
    handles.push(h);
    runMigrations(h.db);
    const tables = h.sqlite
      .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of EXPECTED_TABLES) expect(tables, `table ${t}`).toContain(t);
    expect(tables).toContain('__drizzle_migrations');
  });

  it('create the append-only triggers and indexes', () => {
    const h = createDatabase({ path: ':memory:' });
    handles.push(h);
    runMigrations(h.db);
    const triggers = h.sqlite.prepare("select name from sqlite_master where type = 'trigger'").all().map((r) => (r as { name: string }).name);
    expect(triggers).toEqual(
      expect.arrayContaining(['ledger_entries_no_update', 'ledger_entries_no_delete', 'claim_events_no_update', 'claim_events_no_delete', 'evidence_no_update', 'evidence_no_delete', 'audit_log_no_update', 'audit_log_no_delete']),
    );
    const indexes = h.sqlite.prepare("select name from sqlite_master where type = 'index'").all().map((r) => (r as { name: string }).name);
    expect(indexes).toEqual(expect.arrayContaining(['vehicles_registration_uq', 'claims_reference_uq', 'ledger_entries_claim_idx', 'claim_events_claim_idx', 'evidence_claim_idx', 'documents_claim_idx']));
    // The cross-file registration rule is a flag, not a constraint.
    expect(indexes.some((n) => n.includes('occurred'))).toBe(false);
  });

  it('are idempotent', () => {
    const h = createDatabase({ path: ':memory:' });
    handles.push(h);
    runMigrations(h.db);
    expect(() => runMigrations(h.db)).not.toThrow();
    const n = h.sqlite.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number };
    expect(n.n).toBe(2);
  });

  it('set the connection pragmas', () => {
    const h = createDatabase({ path: ':memory:' });
    handles.push(h);
    expect(h.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(h.sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
  });
});
