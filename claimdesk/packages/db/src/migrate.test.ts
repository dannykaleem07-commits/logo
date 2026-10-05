import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, createDatabase, type DatabaseHandle } from './client.js';
import { migrationsFolder, runMigrations } from './migrate.js';

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
  'sessions',
  'gta_rates',
  'gta_segment_defaults',
  'vehicle_catalogue_custom',
  'document_templates',
];

/** Number of migrations in the journal (each slice that adds one keeps this test right without editing it). */
const JOURNAL_ENTRIES = (JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] }).entries.length;

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
    expect(indexes).toEqual(expect.arrayContaining(['users_username_uq', 'sessions_user_idx', 'sessions_expires_idx']));
    // Sessions are deleted on logout / expiry: no append-only triggers on them.
    expect(triggers.some((n) => n.startsWith('sessions_'))).toBe(false);
    // The cross-file registration rule is a flag, not a constraint.
    expect(indexes.some((n) => n.includes('occurred'))).toBe(false);
  });

  it('are idempotent', () => {
    const h = createDatabase({ path: ':memory:' });
    handles.push(h);
    runMigrations(h.db);
    expect(() => runMigrations(h.db)).not.toThrow();
    const n = h.sqlite.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number };
    expect(n.n).toBe(JOURNAL_ENTRIES);
  });

  it('0002 upgrades a database created by 0000–0001 without losing existing users', () => {
    // A folder holding only the first two migrations, as an existing install would have applied them.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'claimdesk-mig-'));
    try {
      mkdirSync(path.join(dir, 'meta'));
      const journal = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
      const firstTwo = journal.entries.slice(0, 2);
      expect(firstTwo.map((e) => e.tag)).toEqual(['0000_init', '0001_append_only_triggers']);
      writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: firstTwo }));
      for (const e of firstTwo) copyFileSync(path.join(migrationsFolder, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));

      const h = createDatabase({ path: ':memory:' });
      handles.push(h);
      runMigrations(h.db, { migrationsFolder: dir });
      h.sqlite.prepare("insert into users (id, name, email, role, mfa_enabled, created_at) values ('handler', 'Handler', 'handler@ccguk.local', 'handler', 0, '2026-01-01T00:00:00.000Z')").run();

      runMigrations(h.db);
      const row = h.sqlite.prepare("select id, name, username, password_hash, password_changed_at from users where id = 'handler'").get();
      expect(row).toEqual({ id: 'handler', name: 'Handler', username: null, password_hash: null, password_changed_at: null });
      const n = h.sqlite.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number };
      expect(n.n).toBe(JOURNAL_ENTRIES);
      // The 0001 append-only triggers are untouched by 0002.
      expect(() => h.sqlite.prepare("insert into audit_log (id, at, user_id, action, entity, entity_id) values ('a1', '2026-01-01T00:00:00.000Z', 'system', 'x', 'y', 'z')").run()).not.toThrow();
      expect(() => h.sqlite.prepare("delete from audit_log where id = 'a1'").run()).toThrow(/append-only/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('0003 upgrades a database created by 0000–0002: vehicles keep their rows and gain an empty spec', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'claimdesk-mig-'));
    try {
      mkdirSync(path.join(dir, 'meta'));
      const journal = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
      const firstThree = journal.entries.slice(0, 3);
      expect(firstThree.map((e) => e.tag)).toEqual(['0000_init', '0001_append_only_triggers', '0002_auth_sessions']);
      writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: firstThree }));
      for (const e of firstThree) copyFileSync(path.join(migrationsFolder, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));

      const h = createDatabase({ path: ':memory:' });
      handles.push(h);
      runMigrations(h.db, { migrationsFolder: dir });
      h.sqlite
        .prepare("insert into vehicles (id, registration, make, model, odometer, ownership, lookups, created_at, updated_at) values ('v1', 'AB12CDE', 'FORD', 'FIESTA', '[]', 'client', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')")
        .run();

      runMigrations(h.db);
      expect(h.sqlite.prepare("select registration, make, spec from vehicles where id = 'v1'").get()).toEqual({ registration: 'AB12CDE', make: 'FORD', spec: null });
      const tables = h.sqlite.prepare("select name from sqlite_master where type = 'table'").all().map((r) => (r as { name: string }).name);
      expect(tables).toEqual(expect.arrayContaining(['gta_rates', 'gta_segment_defaults', 'vehicle_catalogue_custom']));
      const indexes = h.sqlite.prepare("select name from sqlite_master where type = 'index'").all().map((r) => (r as { name: string }).name);
      expect(indexes).toEqual(expect.arrayContaining(['gta_rates_group_period_uq', 'vehicle_catalogue_custom_make_idx']));
      const n = h.sqlite.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number };
      expect(n.n).toBe(JOURNAL_ENTRIES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('0004 upgrades a database created by 0000–0003: documents keep their rows as format html', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'claimdesk-mig-'));
    try {
      mkdirSync(path.join(dir, 'meta'));
      const journal = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string; when: number }> };
      const firstFour = journal.entries.slice(0, 4);
      expect(firstFour.map((e) => e.tag)).toEqual(['0000_init', '0001_append_only_triggers', '0002_auth_sessions', '0003_vehicle_catalogue_gta']);
      // drizzle applies a migration only when its timestamp is later than the last one applied
      expect(journal.entries[4]?.tag).toBe('0004_document_templates');
      expect(journal.entries[4]!.when).toBeGreaterThan(firstFour[3]!.when);
      writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: firstFour }));
      for (const e of firstFour) copyFileSync(path.join(migrationsFolder, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));

      const h = createDatabase({ path: ':memory:' });
      handles.push(h);
      runMigrations(h.db, { migrationsFolder: dir });
      h.sqlite
        .prepare(
          "insert into documents (id, claim_id, template_id, template_version, title, status, html, sha256, created_at, created_by, data_snapshot, updated_at) values ('d1', 'c1', 'letter.chaser_7', '1.0.0', 'Chaser', 'draft', '<p>x</p>', 'abc', '2026-01-01T00:00:00.000Z', 'handler', '{}', '2026-01-01T00:00:00.000Z')",
        )
        .run();

      runMigrations(h.db);
      expect(h.sqlite.prepare("select format, docx_path, docx_sha256, pdf_converter from documents where id = 'd1'").get()).toEqual({ format: 'html', docx_path: null, docx_sha256: null, pdf_converter: null });
      const indexes = h.sqlite.prepare("select name from sqlite_master where type = 'index'").all().map((r) => (r as { name: string }).name);
      expect(indexes).toEqual(expect.arrayContaining(['document_templates_source_idx', 'document_templates_sha_idx']));
      const cols = h.sqlite.prepare('pragma table_info(document_templates)').all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
      expect(cols.find((c) => c.name === 'warnings')).toMatchObject({ notnull: 1, dflt_value: "'[]'" });
      expect(cols.find((c) => c.name === 'file_version')).toMatchObject({ notnull: 1, dflt_value: '1' });
      expect(cols.find((c) => c.name === 'mapping_revision')).toMatchObject({ notnull: 1, dflt_value: '0' });
      const n = h.sqlite.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number };
      expect(n.n).toBe(JOURNAL_ENTRIES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('set the connection pragmas', () => {
    const h = createDatabase({ path: ':memory:' });
    handles.push(h);
    expect(h.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(h.sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
  });
});
