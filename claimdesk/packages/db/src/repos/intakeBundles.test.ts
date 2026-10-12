// owned by intake-server
/**
 * Smart intake persistence (docs/SMART-INTAKE.md §3, §16.2): bundles, files, append-only decisions / reasonings /
 * damage observations, the case-insensitive open-folder index, the register lock and the best extraction. Synthetic data.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, createDatabase, type DatabaseHandle } from '../client.js';
import { migrationsFolder, runMigrations } from '../migrate.js';
import { createTestDatabase } from '../testing.js';
import { appendIntakeExtraction, bestIntakeExtraction, createIntakeItem, latestIntakeExtraction } from './intake.js';
import { getAgentSettings, patchAgentSettings } from './agentSettings.js';
import {
  addBundleFile,
  appendBundleDecision,
  appendBundleReasoning,
  bumpBundleRevision,
  bundleFilesByItem,
  casBundleStatus,
  countIntakeBundles,
  createIntakeBundle,
  findOpenBundleByFolder,
  getIntakeBundle,
  insertDamageObservation,
  latestBundleReasoning,
  listBundleDecisions,
  listBundleFiles,
  listDamageObservations,
  listIntakeBundles,
  requireIntakeBundle,
  updateBundleFile,
  updateIntakeBundle,
} from './intakeBundles.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

const T0 = '2026-10-08T09:00:00.000Z';
const T1 = '2026-10-08T09:05:00.000Z';

describe('intake bundles', () => {
  it('create, read, list, count and update', () => {
    const b = createIntakeBundle(h.db, { name: '  Jane Doe –  Corsa crash ', source: 'upload', createdBy: 'owner', now: T0 });
    expect(b).toMatchObject({ name: 'Jane Doe – Corsa crash', status: 'open', source: 'upload', revision: 0, reasoningStatus: 'none', autoEligible: false, createdAt: T0 });
    expect(requireIntakeBundle(h.db, b.id).id).toBe(b.id);
    expect(getIntakeBundle(h.db, 'nope')).toBeUndefined();
    expect(() => createIntakeBundle(h.db, { name: ' ', source: 'upload', createdBy: 'o' })).toThrow();
    const u = updateIntakeBundle(h.db, b.id, { status: 'ready', computed: { a: 1 }, computedRevision: 0, autoEligible: true }, T1);
    expect(u).toMatchObject({ status: 'ready', computed: { a: 1 }, computedRevision: 0, autoEligible: true, updatedAt: T1 });
    createIntakeBundle(h.db, { name: 'Other', source: 'upload', createdBy: 'owner', now: T0 });
    expect(listIntakeBundles(h.db, { status: ['ready'] }).map((x) => x.id)).toEqual([b.id]);
    expect(countIntakeBundles(h.db)).toBe(2);
    expect(() => updateIntakeBundle(h.db, b.id, { status: 'bogus' as never })).toThrow();
  });

  it('revision bumps atomically; casBundleStatus has exactly one winner', () => {
    const b = createIntakeBundle(h.db, { name: 'X', source: 'upload', createdBy: 'o' });
    expect(bumpBundleRevision(h.db, b.id)).toBe(1);
    expect(bumpBundleRevision(h.db, b.id)).toBe(2);
    updateIntakeBundle(h.db, b.id, { status: 'ready' });
    expect(casBundleStatus(h.db, b.id, ['ready', 'needs_you'], 'registering')).toBe(true);
    expect(casBundleStatus(h.db, b.id, ['ready', 'needs_you'], 'registering')).toBe(false);
    expect(getIntakeBundle(h.db, b.id)!.status).toBe('registering');
  });

  it('the open-folder index is case-insensitive and ignores closed bundles', () => {
    const a = createIntakeBundle(h.db, { name: 'Jane Folder Test', source: 'folder', folderKey: 'Jane Folder Test', createdBy: 'agent:intake' });
    expect(findOpenBundleByFolder(h.db, 'jane folder test')?.id).toBe(a.id);
    expect(() => createIntakeBundle(h.db, { name: 'dup', source: 'folder', folderKey: 'JANE FOLDER TEST', createdBy: 'agent:intake' })).toThrow();
    updateIntakeBundle(h.db, a.id, { status: 'registered' });
    expect(findOpenBundleByFolder(h.db, 'Jane Folder Test')).toBeUndefined();
    const b = createIntakeBundle(h.db, { name: 'Jane Folder Test (2)', source: 'folder', folderKey: 'Jane Folder Test', createdBy: 'agent:intake' });
    expect(findOpenBundleByFolder(h.db, 'JANE folder TEST')?.id).toBe(b.id);
  });
});

describe('bundle files', () => {
  it('addBundleFile is idempotent per (bundle, item); positions increase; an item may be in two bundles', () => {
    const b1 = createIntakeBundle(h.db, { name: 'B1', source: 'upload', createdBy: 'o' });
    const b2 = createIntakeBundle(h.db, { name: 'B2', source: 'upload', createdBy: 'o' });
    const f1 = addBundleFile(h.db, { bundleId: b1.id, intakeItemId: 'i1', evidenceId: 'e1', addedBy: 'o' });
    const f2 = addBundleFile(h.db, { bundleId: b1.id, intakeItemId: 'i2', evidenceId: 'e2', parentFileId: f1.file.id, role: 'attachment', addedBy: 'o' });
    const again = addBundleFile(h.db, { bundleId: b1.id, intakeItemId: 'i1', evidenceId: 'e1', addedBy: 'o' });
    expect(f1.created).toBe(true);
    expect(again).toMatchObject({ created: false, file: { id: f1.file.id } });
    expect(f2.file).toMatchObject({ position: 2, role: 'attachment', parentFileId: f1.file.id });
    expect(addBundleFile(h.db, { bundleId: b2.id, intakeItemId: 'i1', evidenceId: 'e1', addedBy: 'o' }).created).toBe(true);
    expect(listBundleFiles(h.db, b1.id).map((f) => f.intakeItemId)).toEqual(['i1', 'i2']);
    expect(bundleFilesByItem(h.db, 'i1').map((f) => f.bundleId).sort()).toEqual([b1.id, b2.id].sort());
    const u = updateBundleFile(h.db, f1.file.id, { phash: 'ffff0000ffff0000', facts: { pixels: 10 }, role: 'pack' });
    expect(u).toMatchObject({ phash: 'ffff0000ffff0000', facts: { pixels: 10 }, role: 'pack' });
  });
});

describe('append-only tables', () => {
  it('decisions, reasonings and damage observations refuse UPDATE and DELETE', () => {
    const b = createIntakeBundle(h.db, { name: 'X', source: 'upload', createdBy: 'o' });
    const d = appendBundleDecision(h.db, { bundleId: b.id, revision: 1, kind: 'set_field', subject: 'client.name', before: null, after: { value: 'Jane Doe' }, actor: 'owner', at: T0 });
    expect(listBundleDecisions(h.db, b.id)).toEqual([d]);
    expect(d.after).toEqual({ value: 'Jane Doe' });
    expect(() => appendBundleDecision(h.db, { bundleId: b.id, revision: 1, kind: 'bogus' as never, actor: 'o' })).toThrow();
    appendBundleReasoning(h.db, { bundleId: b.id, fileset: 'fs1', runId: 'run-1', result: { caseSummary: 'x' }, checks: { capped: 1 }, now: T0 });
    const r2 = appendBundleReasoning(h.db, { bundleId: b.id, fileset: 'fs2', runId: 'run-2', result: { caseSummary: 'y' }, checks: {}, now: T1 });
    expect(latestBundleReasoning(h.db, b.id)?.id).toBe(r2.id);
    expect(latestBundleReasoning(h.db, b.id, 'fs1')?.result).toEqual({ caseSummary: 'x' });
    expect(insertDamageObservation(h.db, { claimId: 'c1', evidenceId: 'e1', zoneId: 'bonnet', severity: 2, confidence: 0.8, source: 'ai_photo', bundleId: b.id, createdBy: 'agent:intake' })).toEqual({ created: true });
    expect(insertDamageObservation(h.db, { claimId: 'c1', evidenceId: 'e1', zoneId: 'bonnet', severity: 3, confidence: 0.9, source: 'ai_photo', bundleId: b.id, createdBy: 'agent:intake' })).toEqual({ created: false });
    expect(insertDamageObservation(h.db, { claimId: 'c1', zoneId: 'bonnet', severity: 1, confidence: 0.5, source: 'estimate_text', createdBy: 'agent:intake' })).toEqual({ created: true });
    expect(insertDamageObservation(h.db, { claimId: 'c1', zoneId: 'bonnet', severity: 1, confidence: 0.5, source: 'estimate_text', createdBy: 'agent:intake' })).toEqual({ created: false });
    expect(listDamageObservations(h.db, 'c1')).toHaveLength(2);
    for (const table of ['intake_bundle_decisions', 'intake_bundle_reasonings', 'claim_damage_observations']) {
      expect(() => h.sqlite.prepare(`UPDATE ${table} SET id = id`).run(), table).toThrow(/append-only/);
      expect(() => h.sqlite.prepare(`DELETE FROM ${table}`).run(), table).toThrow(/append-only/);
    }
  });
});

describe('extractions with extras', () => {
  it('bestIntakeExtraction prefers the AI row over a newer rules row', () => {
    const item = createIntakeItem(h.db, { source: 'upload', evidenceId: 'ev-1', createdBy: 'o' });
    appendIntakeExtraction(h.db, { intakeItemId: item.id, schemaId: 'intake_rules/1', fields: [], extras: { engine: 'rules' }, now: '2026-10-08T09:00:00.000Z' });
    const ai = appendIntakeExtraction(h.db, { intakeItemId: item.id, schemaId: 'intake_extraction', runId: 'run-1', fields: [], extras: { engine: 'ai', documentDate: '2026-10-07' }, now: '2026-10-08T09:01:00.000Z' });
    const rules2 = appendIntakeExtraction(h.db, { intakeItemId: item.id, schemaId: 'intake_rules/1', fields: [], extras: { engine: 'rules' }, now: '2026-10-08T09:02:00.000Z' });
    expect(latestIntakeExtraction(h.db, item.id)?.id).toBe(rules2.id);
    expect(bestIntakeExtraction(h.db, item.id)).toMatchObject({ id: ai.id, extras: { engine: 'ai', documentDate: '2026-10-07' } });
    const only = createIntakeItem(h.db, { source: 'upload', evidenceId: 'ev-2', createdBy: 'o' });
    const r = appendIntakeExtraction(h.db, { intakeItemId: only.id, schemaId: 'intake_rules/1', fields: [], extras: { engine: 'rules' } });
    expect(bestIntakeExtraction(h.db, only.id)?.id).toBe(r.id);
    // a legacy AI row without extras still counts as AI
    const legacy = createIntakeItem(h.db, { source: 'upload', evidenceId: 'ev-3', createdBy: 'o' });
    const l = appendIntakeExtraction(h.db, { intakeItemId: legacy.id, schemaId: 'intake_extraction', fields: [] });
    appendIntakeExtraction(h.db, { intakeItemId: legacy.id, schemaId: 'intake_rules/1', fields: [], extras: { engine: 'rules' } });
    expect(bestIntakeExtraction(h.db, legacy.id)?.id).toBe(l.id);
  });
});

describe('agent_settings.intake', () => {
  it('defaults to {} in the row and merges/clamps on read; patches are audited as intake.settings', () => {
    const raw = h.sqlite.prepare("SELECT dflt_value AS d FROM pragma_table_info('agent_settings') WHERE name = 'intake'").get() as { d: string };
    expect(raw.d).toBe("'{}'");
    expect(getAgentSettings(h.db).intake.bundles.autoRegister).toBe(false);
    const s = patchAgentSettings(h.db, { intake: { bundles: { autoRegister: true, quietSeconds: 5000 } } }, { userId: 'owner' });
    expect(s.intake.bundles).toMatchObject({ autoRegister: true, quietSeconds: 600 });
    expect(getAgentSettings(h.db).intake.bundles.autoRegister).toBe(true);
    const audit = h.sqlite.prepare("SELECT action FROM audit_log WHERE action = 'intake.settings'").all();
    expect(audit).toHaveLength(1);
  });
});

describe('migration 0015 on a database at 0014', () => {
  it('upgrades an existing 0014 database in place', () => {
    const journal = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
    const dir = mkdtempSync(path.join(os.tmpdir(), 'claimdesk-0015-'));
    try {
      mkdirSync(path.join(dir, 'meta'));
      const upTo14 = journal.entries.filter((e) => e.tag !== '0015_smart_intake');
      writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: upTo14 }));
      for (const e of upTo14) copyFileSync(path.join(migrationsFolder, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
      const db = createDatabase({ path: ':memory:' });
      try {
        runMigrations(db.db, { migrationsFolder: dir });
        db.sqlite.prepare("INSERT INTO agent_settings (id, ai, autonomy, notifications, agents, checklist, autopilot, updated_at, updated_by) VALUES ('default', '{}', '{}', '{}', '{}', '{}', '{}', 'x', 'y')").run();
        expect(db.sqlite.prepare("select name from sqlite_master where name = 'intake_bundles'").all()).toEqual([]);
        runMigrations(db.db);
        expect(db.sqlite.prepare("select name from sqlite_master where name = 'intake_bundles'").all()).toHaveLength(1);
        expect((db.sqlite.prepare("SELECT intake FROM agent_settings WHERE id = 'default'").get() as { intake: string }).intake).toBe('{}');
      } finally {
        closeDatabase(db);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
