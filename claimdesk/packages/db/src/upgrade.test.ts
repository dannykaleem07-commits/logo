/**
 * Upgrade from 0.2.6 (docs/V03-MANAGER-MODE-HIRE-PRICING.md §F.2.2, §I.8): a FILE database migrated by the 0.2.6
 * journal (0000–0005) and holding rows of the 0.2.6 shape is opened by the new start-up path — backup first, then the
 * full migrations — and keeps every row. A second start finds nothing to migrate and makes no new backup.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { backupBeforeMigrate, pendingMigrationCount, readMigrationJournal } from './backup.js';
import { closeDatabase, createDatabase, type DatabaseHandle } from './client.js';
import { migrationsFolder, runMigrations } from './migrate.js';
import { enqueueAgentJob, leaseAgentJob } from './repos/agentJobs.js';
import { getAgentSettings } from './repos/agentSettings.js';
import { listAudit } from './repos/audit.js';
import { getClaim } from './repos/claims.js';
import { countNeedsYou } from './repos/needsYou.js';
import { listUserSessions } from './repos/sessions.js';
import { getSettings } from './repos/settings.js';
import { getUser } from './repos/users.js';

const dirs: string[] = [];
const handles: DatabaseHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) closeDatabase(h);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** The migrations folder as an older release shipped it: journal entries idx ≤ maxIdx (0.2.6: 5 → 0005_no_default_vat; 0.3.x: 7 → 0007_hire_pricing). */
function migrationsUpTo(maxIdx: number, lastTag: string): string {
  const dir = tempDir(`claimdesk-mig${maxIdx}-`);
  mkdirSync(path.join(dir, 'meta'));
  const journal = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
  const kept = journal.entries.filter((e) => e.idx <= maxIdx);
  expect(kept.map((e) => e.tag).at(-1)).toBe(lastTag);
  writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }));
  for (const e of kept) copyFileSync(path.join(migrationsFolder, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

const migrations026 = (): string => migrationsUpTo(5, '0005_no_default_vat');

const T = '2026-09-30T08:00:00.000Z';

/** Rows exactly as 0.2.6 wrote them (raw SQL: the 0.3 repos would name the new columns). */
function seed026(h: DatabaseHandle): void {
  const s = h.sqlite;
  s.prepare(
    "insert into users (id, name, email, role, mfa_enabled, created_at, username, password_hash, password_changed_at) values ('courtesycars', 'Courtesy Cars', 'claims@courtesycars.net', 'admin', 0, ?, 'courtesycars', 'scrypt$16384$8$1$c2FsdA$aGFzaA', ?)",
  ).run(T, T);
  s.prepare("insert into sessions (id, user_id, created_at, expires_at, last_seen_at, ip, user_agent) values ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'courtesycars', ?, '2026-09-30T20:00:00.000Z', ?, '127.0.0.1', 'Edge')").run(T, T);
  s.prepare('insert into settings (id, company_name, company_number, vat_number, rate_card, api_keys_present, updated_at) values (?, ?, ?, ?, ?, ?, ?)').run(
    'default',
    'Courtesy Cars Group UK Ltd',
    '17430389',
    null,
    JSON.stringify({ recoveryCalloutPence: 9000, perMilePence: 300, adminPence: 2500, storageDailyPence: 4500, engineerFeePence: 28500, vatRate: 0 }),
    JSON.stringify({ dvlaVes: false, dvsaMot: false, companiesHouse: false, gateway: false, esign: false }),
    T,
  );
  s.prepare("insert into parties (id, kind, name, roles, created_at) values ('p1', 'individual', 'Amina Yusuf', '[\"claimant\",\"driver\"]', ?)").run(T);
  s.prepare(
    "insert into vehicles (id, registration, make, model, odometer, gta_group, ownership, lookups, created_at, updated_at) values ('v1', 'KX21ABC', 'TOYOTA', 'YARIS', '[]', 'S1', 'client', '[]', ?, ?)",
  ).run(T, T);
  s.prepare('insert into claim_sequences (year, last) values (2026, 1)').run();
  s.prepare(
    "insert into claims (id, reference, status, opened_at, accident, liability, claimant_id, driver_id, client_vehicle_id, third_party_ids, handler_id, gta_subscriber, linked_claim_ids, flags, created_at, updated_at) values ('c1', 'CCG-2026-00001', 'intake', ?, ?, 'unknown', 'p1', 'p1', 'v1', '[]', 'courtesycars', 0, '[]', '[]', ?, ?)",
  ).run(T, JSON.stringify({ occurredAt: '2026-09-29T08:15:00.000Z', location: 'A329 London Road, Reading', circumstances: 'Rear-ended in traffic.' }), T, T);
}

/** The db half of the API start-up (apps/api/src/context.ts buildContext): note whether the file existed, open, back up, migrate. */
function startUp(file: string, version: string): { handle: DatabaseHandle; backup?: string; pendingBefore: number } {
  const existedBefore = existsSync(file);
  const handle = createDatabase({ path: file });
  handles.push(handle);
  const r = backupBeforeMigrate(handle, { databasePath: file, existedBefore, version });
  runMigrations(handle.db);
  return { handle, backup: r.file, pendingBefore: r.pending };
}

const columns = (h: DatabaseHandle, table: string): string[] => (h.sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

describe('upgrade from 0.2.6', () => {
  it('backs up, applies the 0.3 migrations and keeps every 0.2.6 row; a second start makes no new backup', () => {
    const dataDir = tempDir('claimdesk-upgrade-');
    const file = path.join(dataDir, 'claimdesk.sqlite');

    // 1. The 0.2.6 install: migrations 0000–0005 into a file database, then its rows.
    const old = createDatabase({ path: file });
    runMigrations(old.db, { migrationsFolder: migrations026() });
    seed026(old);
    expect(columns(old, 'sessions')).not.toContain('manager_mode_until');
    closeDatabase(old);

    // 2. The 0.3 start-up.
    const allEntries = readMigrationJournal();
    const newer = allEntries.filter((e) => e.idx > 5);
    expect(newer.length).toBeGreaterThan(0);
    const first = startUp(file, '0.3.7');
    expect(first.pendingBefore).toBe(newer.length);
    expect(first.backup).toBeDefined();
    expect(path.dirname(first.backup!)).toBe(path.join(dataDir, 'backups'));
    expect(path.basename(first.backup!)).toMatch(/^claimdesk-before-0\.3\.7-\d{8}-\d{6}\.sqlite$/);
    expect(existsSync(first.backup!)).toBe(true);

    // The backup is the database as 0.2.6 left it: its rows, 6 migrations, no 0.3 columns.
    const copy = new Database(first.backup!, { readonly: true });
    try {
      expect((copy.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number }).n).toBe(6);
      expect(copy.prepare("select reference from claims where id = 'c1'").get()).toEqual({ reference: 'CCG-2026-00001' });
      expect((copy.prepare('pragma table_info(hire_agreements)').all() as Array<{ name: string }>).map((c) => c.name)).not.toContain('client_gta_group');
    } finally {
      copy.close();
    }

    // The 0006 / 0007 columns now exist (each column of whichever newer migrations are in the journal).
    const h = first.handle;
    expect(pendingMigrationCount(h)).toBe(0);
    expect((h.sqlite.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number }).n).toBe(allEntries.length);
    const expected: Record<string, Record<string, string[]>> = {
      '0006_manager_mode': { sessions: ['manager_mode_until'], settings: ['manager_mode_idle_minutes'] },
      '0007_hire_pricing': { hire_agreements: ['client_gta_group', 'client_gta_daily_rate_pence', 'hire_gta_daily_rate_pence', 'fleet_daily_rate_pence', 'pricing_note'] },
    };
    for (const e of newer) {
      for (const [table, cols] of Object.entries(expected[e.tag] ?? {})) expect(columns(h, table), `${e.tag} ${table}`).toEqual(expect.arrayContaining(cols));
    }

    // The 0.2.6 rows are intact and readable by the 0.3 repositories.
    expect(getUser(h.db, 'courtesycars')).toMatchObject({ name: 'Courtesy Cars', role: 'admin', username: 'courtesycars' });
    const sessions = listUserSessions(h.db, 'courtesycars');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', expiresAt: '2026-09-30T20:00:00.000Z' });
    expect(sessions[0]!.managerModeUntil).toBeUndefined();
    const settings = getSettings(h.db);
    expect(settings).toMatchObject({ companyName: 'Courtesy Cars Group UK Ltd', companyNumber: '17430389', rateCard: { storageDailyPence: 4500, vatRate: 0 } });
    expect(settings.managerModeIdleMinutes).toBe(60);
    expect(getClaim(h.db, 'c1')).toMatchObject({ reference: 'CCG-2026-00001', status: 'intake', claimantId: 'p1', clientVehicleId: 'v1', handlerId: 'courtesycars' });
    expect(h.sqlite.prepare("select registration, gta_group as g from vehicles where id = 'v1'").get()).toEqual({ registration: 'KX21ABC', g: 'S1' });
    closeDatabase(h);

    // 3. A second start: nothing to migrate, no new backup.
    const second = startUp(file, '0.3.7');
    expect(second.pendingBefore).toBe(0);
    expect(second.backup).toBeUndefined();
    expect(readdirSync(path.join(dataDir, 'backups'))).toEqual([path.basename(first.backup!)]);
    expect(getClaim(second.handle.db, 'c1')?.reference).toBe('CCG-2026-00001');
  });
});

describe('upgrade from 0.3.x to 0.4 (Supreme migrations 0008–0011)', () => {
  it('backs up, adds the agent, mail, intake and brain tables and keeps every 0.3 row', () => {
    const dataDir = tempDir('claimdesk-upgrade04-');
    const file = path.join(dataDir, 'claimdesk.sqlite');

    // 1. The 0.3.x install: migrations 0000–0007, then its rows (incl. an audit row and a 0007 hire pricing column).
    const old = createDatabase({ path: file });
    runMigrations(old.db, { migrationsFolder: migrationsUpTo(7, '0007_hire_pricing') });
    seed026(old);
    old.sqlite
      .prepare("insert into audit_log (id, at, user_id, action, entity, entity_id, before, after, ip) values ('a1', ?, 'courtesycars', 'claim.patch', 'claims', 'c1', null, '{\"claimId\":\"c1\"}', '127.0.0.1')")
      .run(T);
    old.sqlite.prepare("update sessions set manager_mode_until = ? where user_id = 'courtesycars'").run('2026-09-30T09:00:00.000Z');
    expect(columns(old, 'audit_log')).not.toContain('run_id');
    expect((old.sqlite.prepare("select count(*) as n from sqlite_master where name = 'agent_jobs'").get() as { n: number }).n).toBe(0);
    closeDatabase(old);

    // 2. The 0.4 start-up.
    const first = startUp(file, '0.4.0');
    // 0008–0011, 0012_settlement_offers, 0013_autopilot and any later foundation migration.
    expect(first.pendingBefore).toBe(readMigrationJournal().length - 8);
    expect(path.basename(first.backup!)).toMatch(/^claimdesk-before-0\.4\.0-\d{8}-\d{6}\.sqlite$/);
    const h = first.handle;
    expect(pendingMigrationCount(h)).toBe(0);
    expect((h.sqlite.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number }).n).toBe(readMigrationJournal().length);
    const tables = (h.sqlite.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    for (const t of ['agent_jobs', 'needs_you', 'audit_log', 'mail_messages', 'outbox', 'intake_items', 'claim_update_proposals', 'brain_entries', 'brain_fts', 'search_docs', 'memory_items', 'settlement_offers']) expect(tables).toContain(t);
    expect(columns(h, 'audit_log')).toContain('run_id');

    // 0.3 rows intact.
    expect(getUser(h.db, 'courtesycars')).toMatchObject({ role: 'admin', username: 'courtesycars' });
    expect(listUserSessions(h.db, 'courtesycars')[0]!.managerModeUntil).toBe('2026-09-30T09:00:00.000Z');
    expect(getClaim(h.db, 'c1')).toMatchObject({ reference: 'CCG-2026-00001', status: 'intake' });
    expect(getSettings(h.db).companyName).toBe('Courtesy Cars Group UK Ltd');
    const audit = listAudit(h.db, { entityId: 'c1' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ id: 'a1', userId: 'courtesycars', action: 'claim.patch', after: { claimId: 'c1' } });
    expect(audit[0]!.runId).toBeUndefined();
    // The old audit row is still append-only.
    expect(() => h.sqlite.prepare("update audit_log set action = 'x' where id = 'a1'").run()).toThrow(/append-only/);

    // Agents start switched off with default settings; the new tables work.
    expect(getAgentSettings(h.db)).toMatchObject({ ai: { driver: 'off' }, agents: { enabled: false }, autonomy: { mode: 'automatic', killSwitch: false } });
    expect(countNeedsYou(h.db).total).toBe(0);
    const job = enqueueAgentJob(h.db, { type: 'mail.sync', payload: {}, createdBy: 'system', now: T });
    expect(leaseAgentJob(h.db, { lane: 'io', maxPriority: 9, now: T, owner: 'boot', leaseMs: 1000 })?.id).toBe(job.id);
    closeDatabase(h);

    // 3. A second start: nothing to migrate, no new backup.
    const second = startUp(file, '0.4.0');
    expect(second.pendingBefore).toBe(0);
    expect(second.backup).toBeUndefined();
  });
});
