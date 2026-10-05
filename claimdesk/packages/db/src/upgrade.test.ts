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
import { getClaim } from './repos/claims.js';
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

/** The migrations folder as 0.2.6 shipped it: journal entries idx ≤ 5 (0000_init … 0005_no_default_vat). */
function migrations026(): string {
  const dir = tempDir('claimdesk-mig026-');
  mkdirSync(path.join(dir, 'meta'));
  const journal = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
  const kept = journal.entries.filter((e) => e.idx <= 5);
  expect(kept.map((e) => e.tag).at(-1)).toBe('0005_no_default_vat');
  writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }));
  for (const e of kept) copyFileSync(path.join(migrationsFolder, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

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
