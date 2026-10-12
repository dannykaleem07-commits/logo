// owned by ap-foundation
/**
 * Migration order guards (docs/SUPREME-AUTOPILOT.md §G.1): drizzle applies only a migration whose journal `when` is
 * greater than the last applied one, so a migration landed "in the past" would be skipped silently. Guard 1: the
 * journal is in order and complete. Guard 2: `runMigrations` refuses with MIGRATION_ORDER instead of skipping.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, createDatabase, type DatabaseHandle } from './client.js';
import { MigrationOrderError, migrationsFolder, runMigrations, skippedMigrations } from './migrate.js';

interface Entry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}
const journal = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: Entry[] };

const handles: DatabaseHandle[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) closeDatabase(h);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A migrations folder holding exactly `entries` (copied from the real folder). */
function folderWith(entries: Entry[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'claimdesk-order-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'meta'));
  writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: entries.map((e, idx) => ({ ...e, idx })) }));
  for (const e of entries) copyFileSync(path.join(migrationsFolder, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

describe('migration journal (guard 1)', () => {
  it('journal `when` values strictly increase in array order and idx follows the order', () => {
    journal.entries.forEach((e, i) => {
      expect(e.idx, e.tag).toBe(i);
      if (i > 0) expect(e.when, `${e.tag} after ${journal.entries[i - 1]!.tag}`).toBeGreaterThan(journal.entries[i - 1]!.when);
    });
  });

  it('file numbers are unique, every journal tag has a file and every file is in the journal', () => {
    const numbers = journal.entries.map((e) => e.tag.slice(0, 4));
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const e of journal.entries) expect(existsSync(path.join(migrationsFolder, `${e.tag}.sql`)), e.tag).toBe(true);
    const files = readdirSync(migrationsFolder).filter((f) => f.endsWith('.sql')).map((f) => f.replace(/\.sql$/, ''));
    expect(files.sort()).toEqual(journal.entries.map((e) => e.tag).sort());
    // No two files differ only by case (Windows is case-insensitive).
    const lower = files.map((f) => f.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });

  it('0013_autopilot takes `when` 1792250000000, after 0012_settlement_offers', () => {
    const autopilot = journal.entries.find((e) => e.tag === '0013_autopilot');
    expect(autopilot?.when).toBe(1792250000000);
    const settlement = journal.entries.find((e) => e.tag === '0012_settlement_offers');
    expect(settlement?.when).toBe(1792210000000);
    // 0013 must not create the settlement-offer register again.
    expect(readFileSync(path.join(migrationsFolder, '0013_autopilot.sql'), 'utf8')).not.toMatch(/CREATE TABLE `settlement_offers`/);
  });
});

describe('runMigrations order guard (guard 2)', () => {
  it('does nothing special for a new database or an in-order upgrade', () => {
    const h = createDatabase({ path: ':memory:' });
    handles.push(h);
    expect(skippedMigrations(h.db).tags).toEqual([]);
    runMigrations(h.db, { migrationsFolder: folderWith(journal.entries.slice(0, 12)) });
    expect(skippedMigrations(h.db).tags).toEqual([]);
    runMigrations(h.db);
    expect(skippedMigrations(h.db)).toEqual({ tags: [], lastAppliedWhen: journal.entries.at(-1)!.when });
  });

  it('refuses with MIGRATION_ORDER when a journal entry with a lower `when` was never applied', () => {
    const h = createDatabase({ path: ':memory:' });
    handles.push(h);
    const all = journal.entries;
    const autopilotIdx = all.findIndex((e) => e.tag === '0013_autopilot');
    // An install that applied everything except 0013_autopilot (e.g. a later migration landed first).
    const without = all.filter((_, i) => i !== autopilotIdx);
    runMigrations(h.db, { migrationsFolder: folderWith(without.length ? without : all) });
    // Make the skipped entry look "in the past": a later migration was applied (simulated with a bigger created_at).
    h.sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run('later-migration', 1792999999999);
    let caught: unknown;
    try {
      runMigrations(h.db);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MigrationOrderError);
    expect((caught as MigrationOrderError).code).toBe('MIGRATION_ORDER');
    expect((caught as MigrationOrderError).tags).toContain('0013_autopilot');
    expect((caught as Error).message).toMatch(/0013_autopilot/);
    // Nothing was applied by the refused run.
    const tables = h.sqlite.prepare("select name from sqlite_master where type = 'table' and name = 'fleet_reservations'").all();
    expect(tables).toEqual([]);
  });
});
