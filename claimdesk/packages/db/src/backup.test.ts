import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKUP_PREFIX, backupBeforeMigrate, backupDatabase, backupFileName, pendingMigrationCount, pruneBackups, readMigrationJournal } from './backup.js';
import { closeDatabase, createDatabase, type DatabaseHandle } from './client.js';
import { migrationsFolder, runMigrations } from './migrate.js';

const handles: DatabaseHandle[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) closeDatabase(h);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'claimdesk-backup-'));
  dirs.push(d);
  return d;
}

function open(file: string): DatabaseHandle {
  const h = createDatabase({ path: file });
  handles.push(h);
  return h;
}

/** A copy of the migrations folder holding only the first `count` journal entries. */
function truncatedMigrations(count: number): string {
  const dir = tempDir();
  mkdirSync(path.join(dir, 'meta'));
  const journal = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
  const kept = journal.entries.slice(0, count);
  writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }));
  for (const e of kept) copyFileSync(path.join(migrationsFolder, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

const ALL = readMigrationJournal().length;

describe('pendingMigrationCount', () => {
  it('counts every journal entry on a database that was never migrated', () => {
    const h = open(':memory:');
    expect(ALL).toBeGreaterThanOrEqual(6);
    expect(pendingMigrationCount(h)).toBe(ALL);
  });

  it('is 0 once all migrations ran, and counts only the later entries on a partly migrated database', () => {
    const h = open(':memory:');
    runMigrations(h.db, { migrationsFolder: truncatedMigrations(3) });
    expect(pendingMigrationCount(h)).toBe(ALL - 3);
    runMigrations(h.db);
    expect(pendingMigrationCount(h)).toBe(0);
  });

  it('reads the folder it is given', () => {
    const h = open(':memory:');
    const folder = truncatedMigrations(2);
    expect(pendingMigrationCount(h, folder)).toBe(2);
    runMigrations(h.db, { migrationsFolder: folder });
    expect(pendingMigrationCount(h, folder)).toBe(0);
  });
});

describe('backupDatabase', () => {
  it('writes a consistent copy with VACUUM INTO, including rows still in the WAL', () => {
    const dir = tempDir();
    const h = open(path.join(dir, 'claimdesk.sqlite'));
    runMigrations(h.db);
    h.sqlite.prepare("insert into users (id, name, email, role, mfa_enabled, created_at) values ('u1', 'Ann', 'ann@example.com', 'admin', 0, '2026-01-01T00:00:00.000Z')").run();
    const dest = path.join(dir, 'backups', 'copy.sqlite');
    backupDatabase(h, dest);
    expect(existsSync(dest)).toBe(true);
    const copy = new Database(dest, { readonly: true });
    try {
      expect(copy.prepare('select name from users where id = ?').get('u1')).toEqual({ name: 'Ann' });
      expect((copy.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number }).n).toBe(ALL);
    } finally {
      copy.close();
    }
  });

  it('refuses to overwrite an existing file', () => {
    const dir = tempDir();
    const h = open(path.join(dir, 'claimdesk.sqlite'));
    const dest = path.join(dir, 'exists.sqlite');
    writeFileSync(dest, 'keep me');
    expect(() => backupDatabase(h, dest)).toThrow(/already exists/);
    expect(readFileSync(dest, 'utf8')).toBe('keep me');
  });
});

describe('backupFileName and pruneBackups', () => {
  it('names the file claimdesk-before-<version>-<yyyyMMdd-HHmmss>.sqlite', () => {
    const at = new Date(2026, 9, 5, 9, 4, 7);
    expect(backupFileName('0.3.12', at)).toBe('claimdesk-before-0.3.12-20261005-090407.sqlite');
    expect(backupFileName('0.3.0 beta/1', at)).toBe('claimdesk-before-0.3.0_beta_1-20261005-090407.sqlite');
  });

  it('keeps the newest N backups and ignores other files', () => {
    const dir = tempDir();
    const names = [1, 2, 3, 4, 5, 6, 7].map((i) => `${BACKUP_PREFIX}0.3.${i}-20261005-00000${i}.sqlite`);
    names.forEach((n, i) => {
      const f = path.join(dir, n);
      writeFileSync(f, 'x');
      const t = new Date(2026, 9, 5, 0, 0, i);
      utimesSync(f, t, t);
    });
    writeFileSync(path.join(dir, 'my-own-copy.sqlite'), 'x');
    const removed = pruneBackups(dir, 5);
    expect(removed.map((f) => path.basename(f)).sort()).toEqual([names[0], names[1]].sort());
    expect(readdirSync(dir).sort()).toEqual([...names.slice(2), 'my-own-copy.sqlite'].sort());
    expect(pruneBackups(path.join(dir, 'missing'))).toEqual([]);
  });
});

describe('backupBeforeMigrate', () => {
  it('skips in-memory and brand-new databases, and up-to-date ones', () => {
    const mem = open(':memory:');
    expect(backupBeforeMigrate(mem, { databasePath: ':memory:', existedBefore: false, version: '0.3.0' })).toMatchObject({ skipped: 'memory' });

    const dir = tempDir();
    const file = path.join(dir, 'claimdesk.sqlite');
    const fresh = open(file);
    expect(backupBeforeMigrate(fresh, { databasePath: file, existedBefore: false, version: '0.3.0' })).toMatchObject({ skipped: 'new_database', pending: ALL });
    runMigrations(fresh.db);
    expect(backupBeforeMigrate(fresh, { databasePath: file, existedBefore: true, version: '0.3.0' })).toMatchObject({ skipped: 'up_to_date', pending: 0 });
    expect(existsSync(path.join(dir, 'backups'))).toBe(false);
  });

  it('backs up an existing database with pending migrations, never overwrites a same-second backup, and keeps the newest 5', () => {
    const dir = tempDir();
    const file = path.join(dir, 'claimdesk.sqlite');
    const h = open(file);
    runMigrations(h.db, { migrationsFolder: truncatedMigrations(6) });
    const files: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      // the first two in the same second, then one a second
      const at = new Date(2026, 9, 5, 10, 42, Math.max(0, i - 1));
      const r = backupBeforeMigrate(h, { databasePath: file, existedBefore: true, version: '0.3.0', now: at });
      expect(r.pending).toBe(ALL - 6);
      expect(r.file).toBeDefined();
      files.push(r.file!);
    }
    expect(path.basename(files[0]!)).toBe('claimdesk-before-0.3.0-20261005-104200.sqlite');
    expect(path.basename(files[1]!)).toBe('claimdesk-before-0.3.0-20261005-104200-2.sqlite');
    expect(new Set(files).size).toBe(7);
    const left = readdirSync(path.join(dir, 'backups'));
    expect(left).toHaveLength(5);
    expect(left).toContain(path.basename(files[6]!));
  });
});
