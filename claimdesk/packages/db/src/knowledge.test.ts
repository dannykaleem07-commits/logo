// owned by knowledge-core
/**
 * Knowledge migration and store persistence (docs/SUPREME-KNOWLEDGE-BUILDER.md §5, KR-1, KR-12): the DB triggers make
 * content immutable, items undeletable, every verification upgrade depend on a person's recorded check, checks from
 * `system` / `agent:*` impossible, source checks carry a source, and the audit tables append-only. All content is
 * invented.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KnowledgeItem } from '@ccguk/domain';
import { closeDatabase, type DatabaseHandle } from './client.js';
import { migrationsFolder } from './migrate.js';
import { createTestDatabase } from './testing.js';
import {
  activeKnowledgeByKey,
  appendKnowledgeChange,
  getKnowledgePackState,
  insertKnowledgeCheck,
  insertKnowledgeItem,
  insertKnowledgePackVersion,
  latestKnowledgePackVersion,
  listKnowledgeChanges,
  listKnowledgeChecks,
  listKnowledgeItems,
  listKnowledgePackMembers,
  openKnowledgeConflict,
  putInsurerLink,
  getInsurerLink,
  putStoredKnowledgeSettings,
  getStoredKnowledgeSettings,
  setKnowledgePackState,
  updateKnowledgeItemState,
} from './repos/knowledge.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

const T0 = '2026-10-10T09:00:00.000Z';
let seq = 0;
function item(over: Partial<KnowledgeItem> = {}): Omit<KnowledgeItem, 'verification' | 'lastCheckId'> {
  seq += 1;
  return {
    id: `ki-${seq}`,
    itemKey: `procedure:insurer:example-insurer:${seq}`,
    version: 1,
    kind: 'procedure',
    area: 'procedural',
    title: `Portal upload steps ${seq}`,
    body: 'Upload the payment pack through the insurer portal, then email the handler the portal reference.',
    data: { steps: ['Log in', 'Upload'], forWhom: 'insurer', channel: 'portal', insurerSlug: 'example-insurer' },
    tags: ['portal'],
    scope: { kind: 'insurer', slug: 'example-insurer' },
    business: ['ccguk'],
    useLimit: 'internal',
    origin: 'observed',
    confidence: 0.9,
    supportN: 2,
    status: 'proposed',
    health: 'ok',
    validFrom: null,
    validTo: null,
    reviewBy: null,
    provenance: [],
    supersedesId: null,
    gapId: null,
    contentSha256: `sha-${seq}`,
    autonomy: { outcome: 'queue', ruleIds: ['KN-19'], reasons: [], priority: 'low' },
    createdBy: 'agent:supervisor',
    createdAt: T0,
    originJobId: null,
    originRunId: null,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    needsYouId: null,
    updatedAt: T0,
    ...over,
  };
}

describe('the knowledge migration', () => {
  it('is journalled at when 1792350000000 with the next free file number', () => {
    const journal = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string; when: number }[] };
    const entry = journal.entries.find((e) => /_knowledge$/.test(e.tag));
    expect(entry?.when).toBe(1792350000000);
    expect(journal.entries.filter((e) => /_knowledge$/.test(e.tag))).toHaveLength(1);
  });

  it('creates every knowledge table and the FTS index', () => {
    const names = (h.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
    for (const t of ['knowledge_items', 'knowledge_fts', 'knowledge_checks', 'knowledge_changes', 'knowledge_pack_versions', 'knowledge_pack_members', 'knowledge_pack_state', 'knowledge_conflicts', 'insurer_links', 'knowledge_settings', 'contact_observations', 'offer_observations', 'claim_outcomes', 'corrections', 'knowledge_watermarks', 'knowledge_gaps', 'knowledge_sources', 'source_snapshots', 'knowledge_usage', 'eval_cases', 'eval_runs', 'knowledge_alarms']) {
      expect(names).toContain(t);
    }
  });
});

describe('knowledge_items guards (KR-1, KR-12)', () => {
  it('refuses an insert that is not unverified', () => {
    expect(() =>
      h.sqlite
        .prepare(`INSERT INTO knowledge_items (id, item_key, version, kind, area, title, body, data, scope_kind, use_limit, origin, verification, confidence, status, provenance, content_sha256, autonomy, created_by, created_at, updated_at)
                  VALUES ('x', 'k', 1, 'fact', 'legal', 't', 'b', '{}', 'global', 'internal', 'owner', 'owner_confirmed', 1, 'proposed', '[]', 's', '{}', 'u', ?, ?)`)
        .run(T0, T0),
    ).toThrow(/KNOWLEDGE_VERIFICATION_NEEDS_HUMAN_CHECK/);
  });

  it('content is immutable and rows are never deleted', () => {
    const it1 = insertKnowledgeItem(h.db, item());
    expect(() => h.sqlite.prepare(`UPDATE knowledge_items SET body = 'changed' WHERE id = ?`).run(it1.id)).toThrow(/KNOWLEDGE_CONTENT_IMMUTABLE/);
    expect(() => h.sqlite.prepare(`UPDATE knowledge_items SET data = '{}' WHERE id = ?`).run(it1.id)).toThrow(/KNOWLEDGE_CONTENT_IMMUTABLE/);
    expect(() => h.sqlite.prepare(`DELETE FROM knowledge_items WHERE id = ?`).run(it1.id)).toThrow(/KNOWLEDGE_APPEND_ONLY/);
    // status, health and decision fields are mutable
    const updated = updateKnowledgeItemState(h.db, it1.id, { status: 'active', health: 'stale', decidedBy: 'owner', decidedAt: T0, updatedAt: T0 });
    expect(updated).toMatchObject({ status: 'active', health: 'stale', decidedBy: 'owner' });
  });

  it('verification changes only with a matching human check on the same item', () => {
    const it1 = insertKnowledgeItem(h.db, item());
    expect(() => updateKnowledgeItemState(h.db, it1.id, { verification: 'owner_confirmed', updatedAt: T0 })).toThrow(/KNOWLEDGE_VERIFICATION_NEEDS_HUMAN_CHECK/);
    // a check from an agent is refused at insert
    expect(() => insertKnowledgeCheck(h.db, { target: `item:${it1.id}`, result: 'owner_confirmed', method: 'owner_review', snapshotId: null, sourceUrl: null, quote: null, quoteMatch: 'not_applicable', note: null, checkedBy: 'agent:researcher', checkedAt: T0, needsYouId: null })).toThrow(/KNOWLEDGE_CHECK_NEEDS_HUMAN/);
    expect(() => insertKnowledgeCheck(h.db, { target: `item:${it1.id}`, result: 'failed', method: 'owner_review', snapshotId: null, sourceUrl: null, quote: null, quoteMatch: 'not_applicable', note: null, checkedBy: 'system', checkedAt: T0, needsYouId: null })).toThrow(/KNOWLEDGE_CHECK_NEEDS_HUMAN/);
    // a source check needs a source
    expect(() => insertKnowledgeCheck(h.db, { target: `item:${it1.id}`, result: 'source_verified', method: 'source_compare', snapshotId: null, sourceUrl: null, quote: null, quoteMatch: 'not_applicable', note: null, checkedBy: 'owner', checkedAt: T0, needsYouId: null })).toThrow(/KNOWLEDGE_SOURCE_CHECK_NEEDS_SOURCE/);
    // a check on another item does not unlock this one
    const other = insertKnowledgeItem(h.db, item());
    const wrong = insertKnowledgeCheck(h.db, { target: `item:${other.id}`, result: 'owner_confirmed', method: 'owner_review', snapshotId: null, sourceUrl: null, quote: null, quoteMatch: 'not_applicable', note: null, checkedBy: 'owner', checkedAt: T0, needsYouId: null });
    expect(() => updateKnowledgeItemState(h.db, it1.id, { verification: 'owner_confirmed', lastCheckId: wrong.id, updatedAt: T0 })).toThrow(/KNOWLEDGE_VERIFICATION_NEEDS_HUMAN_CHECK/);
    // the owner's own check does
    const c = insertKnowledgeCheck(h.db, { target: `item:${it1.id}`, result: 'owner_confirmed', method: 'owner_review', snapshotId: null, sourceUrl: null, quote: null, quoteMatch: 'not_applicable', note: 'right', checkedBy: 'owner', checkedAt: T0, needsYouId: null });
    expect(updateKnowledgeItemState(h.db, it1.id, { verification: 'owner_confirmed', lastCheckId: c.id, updatedAt: T0 }).verification).toBe('owner_confirmed');
    // and a mismatched result does not
    expect(() => updateKnowledgeItemState(h.db, it1.id, { verification: 'source_verified', lastCheckId: c.id, updatedAt: T0 })).toThrow(/KNOWLEDGE_VERIFICATION_NEEDS_HUMAN_CHECK/);
    expect(listKnowledgeChecks(h.db, [`item:${it1.id}`])).toHaveLength(1);
  });

  it('allows at most one active version per item key', () => {
    const a = insertKnowledgeItem(h.db, item({ itemKey: 'procedure:global:same', status: 'active' }));
    expect(() => insertKnowledgeItem(h.db, item({ itemKey: 'procedure:global:same', version: 2, status: 'active' }))).toThrow(/UNIQUE/);
    insertKnowledgeItem(h.db, item({ itemKey: 'procedure:global:same', version: 2, status: 'proposed' }));
    expect(activeKnowledgeByKey(h.db, 'procedure:global:same')?.id).toBe(a.id);
  });

  it('the FTS index follows inserts', () => {
    insertKnowledgeItem(h.db, item({ title: 'Courier delivery for the payment pack', body: 'Send the hard copy by tracked courier.' }));
    expect(listKnowledgeItems(h.db, { q: 'courier' }).items).toHaveLength(1);
    expect(listKnowledgeItems(h.db, { q: 'zebra' }).items).toHaveLength(0);
  });
});

describe('append-only audit tables', () => {
  it('knowledge_changes, knowledge_checks, pack versions and members refuse update and delete', () => {
    const ch = appendKnowledgeChange(h.db, { at: T0, actor: 'owner', action: 'knowledge.item.approve', itemId: 'x' });
    expect(() => h.sqlite.prepare(`UPDATE knowledge_changes SET actor = 'x' WHERE id = ?`).run(ch.id)).toThrow(/append-only/);
    expect(() => h.sqlite.prepare(`DELETE FROM knowledge_changes WHERE id = ?`).run(ch.id)).toThrow(/append-only/);
    const c = insertKnowledgeCheck(h.db, { target: 'kb:k1', result: 'unverified', method: 'owner_review', snapshotId: null, sourceUrl: null, quote: null, quoteMatch: 'not_applicable', note: null, checkedBy: 'owner', checkedAt: T0, needsYouId: null });
    expect(() => h.sqlite.prepare(`DELETE FROM knowledge_checks WHERE id = ?`).run(c.id)).toThrow(/append-only/);
    insertKnowledgePackVersion(h.db, { version: 1, label: 'learned@1.1.0', itemsSha256: 's', itemCount: 1, diff: { added: [], removed: [], changed: [] }, reason: 'test', basedOnVersion: null, rollbackOf: null, replayRunId: null, createdBy: 'system', createdAt: T0 }, ['a']);
    expect(() => h.sqlite.prepare(`UPDATE knowledge_pack_versions SET reason = 'x' WHERE version = 1`).run()).toThrow(/append-only/);
    expect(() => h.sqlite.prepare(`DELETE FROM knowledge_pack_members WHERE version = 1`).run()).toThrow(/append-only/);
    for (const t of ['contact_observations', 'offer_observations', 'corrections', 'source_snapshots', 'knowledge_usage', 'eval_cases', 'eval_runs']) {
      const triggers = (h.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`).all(t) as { name: string }[]).map((r) => r.name);
      expect(triggers.sort()).toEqual([`${t}_no_delete`, `${t}_no_update`]);
    }
    expect(listKnowledgeChanges(h.db, { actionPrefix: 'knowledge.item.' })).toHaveLength(1);
  });
});

describe('versions, conflicts, links and settings', () => {
  it('stores pack versions with members and the active pointer', () => {
    expect(latestKnowledgePackVersion(h.db)).toBe(0);
    insertKnowledgePackVersion(h.db, { version: 1, label: 'learned@1.1.0', itemsSha256: 's1', itemCount: 2, diff: { added: [], removed: [], changed: [] }, reason: 'publish', basedOnVersion: null, rollbackOf: null, replayRunId: null, createdBy: 'system', createdAt: T0 }, ['b', 'a', 'a']);
    setKnowledgePackState(h.db, { activeVersion: 1, activatedBy: 'system', activatedAt: T0 });
    expect(listKnowledgePackMembers(h.db, 1)).toEqual(['a', 'b']);
    expect(getKnowledgePackState(h.db).activeVersion).toBe(1);
    expect(latestKnowledgePackVersion(h.db)).toBe(1);
  });

  it('an identical open conflict is not recorded twice', () => {
    const a = openKnowledgeConflict(h.db, { kind: 'directory_mismatch', leftRef: 'ki:x', rightRef: 'dir:example-insurer', detail: 'phone differs', detectedBy: 'agent:supervisor', at: T0 });
    const b = openKnowledgeConflict(h.db, { kind: 'directory_mismatch', leftRef: 'ki:x', rightRef: 'dir:example-insurer', detail: 'phone differs', detectedBy: 'agent:supervisor', at: T0 });
    expect(a.created).toBe(true);
    expect(b).toEqual({ conflict: a.conflict, created: false });
  });

  it('insurer links and the settings row upsert', () => {
    putInsurerLink(h.db, { partyId: 'p1', insurerSlug: 'admiral', method: 'exact_name', confidence: 1, decidedBy: 'agent:supervisor', decidedAt: T0 });
    putInsurerLink(h.db, { partyId: 'p1', insurerSlug: 'aviva', method: 'owner', confidence: 1, decidedBy: 'owner', decidedAt: T0 });
    expect(getInsurerLink(h.db, 'p1')).toMatchObject({ insurerSlug: 'aviva', method: 'owner' });
    putStoredKnowledgeSettings(h.db, { learningEnabled: false }, 'owner', T0);
    putStoredKnowledgeSettings(h.db, { learningEnabled: true }, 'owner', T0);
    expect(getStoredKnowledgeSettings(h.db)?.settings).toEqual({ learningEnabled: true });
  });
});
