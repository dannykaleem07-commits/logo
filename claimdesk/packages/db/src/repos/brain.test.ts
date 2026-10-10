// owned by casework
/**
 * Brain persistence (docs/SUPREME-DESIGN.md §E.4–E.6, §N.4): packs and side-by-side versions, entries indexed by the
 * external-content FTS5 table through the 0011 triggers, active version switching (rollback), the claim corpus
 * `search_docs`, and memory items with their approve/retire lifecycle. All content is invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { createTestDatabase } from '../testing.js';
import {
  countBrainEntriesByKind,
  countSearchDocs,
  ensureBrainPack,
  findBrainPackVersionBySha,
  ftsQuery,
  getBrainPack,
  hasSearchDoc,
  insertBrainPackVersion,
  listBrainEntries,
  listBrainPacks,
  listBrainPackVersions,
  rebuildBrainFts,
  searchBrainFts,
  searchClaimDocs,
  updateBrainPack,
  upsertSearchDoc,
  type NewBrainEntry,
} from './brain.js';
import { countMemoryItems, createMemoryItem, decideMemoryItem, isMemoryScope, listMemoryItems, recallMemory } from './memory.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

const T0 = '2026-10-07T09:00:00.000Z';
const entry = (id: string, title: string, body: string, extra: Partial<NewBrainEntry> = {}): NewBrainEntry => ({ id, kind: 'strategy', title, body, tags: ['test'], business: [], data: {}, ...extra });

function seedPack(id = 'synthetic-rules', version = '1.0.0', entries: NewBrainEntry[] = [entry('s1', 'Chasing a silent insurer', 'Send the seven day chaser then escalate to the complaints team.')]) {
  ensureBrainPack(h.db, { id, name: `Pack ${id}`, kind: 'ccguk', business: ['ccguk'], precedence: 30, now: T0 });
  return insertBrainPackVersion(h.db, { packId: id, version, sha256: `sha-${id}-${version}`, source: 'test', storagePath: `/tmp/${id}/${version}`, manifest: { id, version }, importedBy: 'owner', entries, now: T0 });
}

describe('brain packs and versions', () => {
  it('creates a pack once, stores versions side by side and keeps the owner choices on re-ensure', () => {
    seedPack();
    seedPack('synthetic-rules', '1.1.0', [entry('s1', 'Chasing a silent insurer v2', 'Updated wording about chasers.')]);
    const again = ensureBrainPack(h.db, { id: 'synthetic-rules', name: 'Renamed', kind: 'other', business: ['fixmyfile'], precedence: 99 });
    expect(again).toMatchObject({ name: 'Pack synthetic-rules', kind: 'ccguk', precedence: 30, useForCcguk: false, business: ['ccguk'] });
    expect(listBrainPackVersions(h.db, 'synthetic-rules').map((v) => v.version).sort()).toEqual(['1.0.0', '1.1.0']);
    expect(findBrainPackVersionBySha(h.db, 'sha-synthetic-rules-1.1.0')?.version).toBe('1.1.0');
    expect(() => seedPack()).toThrow(/already has version 1.0.0/);
  });

  it('activates, rolls back and deactivates; an unknown version is refused', () => {
    seedPack();
    seedPack('synthetic-rules', '2.0.0');
    expect(updateBrainPack(h.db, 'synthetic-rules', { activeVersion: '2.0.0' }).activeVersion).toBe('2.0.0');
    expect(updateBrainPack(h.db, 'synthetic-rules', { activeVersion: '1.0.0' }).activeVersion).toBe('1.0.0');
    expect(() => updateBrainPack(h.db, 'synthetic-rules', { activeVersion: '9.9.9' })).toThrow(/not found/);
    expect(getBrainPack(h.db, 'synthetic-rules')?.activeVersion).toBe('1.0.0');
    expect(updateBrainPack(h.db, 'synthetic-rules', { activeVersion: null, business: ['ccguk', 'fixmyfile'], precedence: 45, useForCcguk: false })).toMatchObject({ business: ['ccguk', 'fixmyfile'], precedence: 45, useForCcguk: false });
    expect(getBrainPack(h.db, 'synthetic-rules')?.activeVersion).toBeUndefined();
  });

  it('refuses duplicate entry ids inside one version', () => {
    ensureBrainPack(h.db, { id: 'p', name: 'P', kind: 'other', business: ['ccguk'], precedence: 50 });
    expect(() => insertBrainPackVersion(h.db, { packId: 'p', version: '1', sha256: 'x', source: 't', storagePath: '/x', manifest: {}, importedBy: 'o', entries: [entry('a', 'A', 'a'), entry('a', 'B', 'b')] })).toThrow(/duplicate/);
  });

  it('lists packs by precedence and counts entries by kind', () => {
    seedPack('b-pack', '1', [entry('x', 'X', 'x'), entry('y', 'Y', 'y', { kind: 'redLine' })]);
    ensureBrainPack(h.db, { id: 'a-pack', name: 'A', kind: 'playbook', business: ['fixmyfile'], precedence: 40 });
    expect(listBrainPacks(h.db).map((p) => p.id)).toEqual(['b-pack', 'a-pack']);
    expect(getBrainPack(h.db, 'a-pack')?.useForCcguk).toBe(false);
    expect(countBrainEntriesByKind(h.db, 'b-pack', '1')).toEqual({ redLine: 1, strategy: 1 });
    expect(listBrainEntries(h.db, { packId: 'b-pack', version: '1', kinds: ['redLine'] }).map((e) => e.id)).toEqual(['y']);
  });
});

describe('brain FTS', () => {
  it('builds a safe MATCH expression from free text', () => {
    expect(ftsQuery('Chaser? "silent" insurer -- OR NEAR(')).toBe('"chaser" OR "silent" OR "insurer" OR "or" OR "near"');
    expect(ftsQuery('!!')).toBe('');
  });

  it('finds entries through the trigger-maintained index, only in the requested versions and kinds', () => {
    seedPack();
    seedPack('synthetic-rules', '2.0.0', [entry('s1', 'Storage charges', 'Storage must be mitigated quickly.'), entry('r1', 'Never threaten', 'Do not threaten proceedings.', { kind: 'redLine' })]);
    const v1 = searchBrainFts(h.db, { q: 'chasers', versions: [{ packId: 'synthetic-rules', version: '1.0.0' }] });
    expect(v1.map((x) => `${x.entry.version}:${x.entry.id}`)).toEqual(['1.0.0:s1']); // porter stemming: chasers → chaser
    expect(v1[0]!.bm25).toBeLessThan(0);
    expect(searchBrainFts(h.db, { q: 'chaser', versions: [{ packId: 'synthetic-rules', version: '2.0.0' }] })).toEqual([]);
    expect(searchBrainFts(h.db, { q: 'threaten storage', versions: [{ packId: 'synthetic-rules', version: '2.0.0' }], kinds: ['redLine'] }).map((x) => x.entry.id)).toEqual(['r1']);
    expect(searchBrainFts(h.db, { q: 'chaser', versions: [] })).toEqual([]);
    rebuildBrainFts(h.db);
    expect(searchBrainFts(h.db, { q: 'mitigated', versions: [{ packId: 'synthetic-rules', version: '2.0.0' }] }).map((x) => x.entry.id)).toEqual(['s1']);
  });
});

describe('search_docs', () => {
  it('indexes per source (re-index replaces) and searches by claim', () => {
    upsertSearchDoc(h.db, { sourceKind: 'email', sourceId: 'm1', claimId: 'c1', title: 'Your client', body: 'Please send the V5C registration document.', at: T0 });
    upsertSearchDoc(h.db, { sourceKind: 'email', sourceId: 'm1', claimId: 'c1', title: 'Your client', body: 'Please send the V5C logbook.', at: T0 });
    upsertSearchDoc(h.db, { sourceKind: 'note', sourceId: 'n1', claimId: 'c2', title: 'Note', body: 'Logbook received.', at: T0 });
    expect(hasSearchDoc(h.db, 'email', 'm1')).toBe(true);
    expect(countSearchDocs(h.db)).toBe(2);
    expect(countSearchDocs(h.db, 'c1')).toBe(1);
    const hits = searchClaimDocs(h.db, { q: 'logbook', claimId: 'c1' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ sourceKind: 'email', sourceId: 'm1', claimId: 'c1' });
    expect(hits[0]!.snippet).toContain('[logbook]');
    expect(searchClaimDocs(h.db, { q: 'registration' })).toEqual([]);
  });
});

describe('memory items', () => {
  it('validates scope and kind; proposed → approved → retired; retired is final', () => {
    expect(isMemoryScope('claim:abc-123')).toBe(true);
    expect(isMemoryScope('claims:abc')).toBe(false);
    expect(() => createMemoryItem(h.db, { kind: 'note', scope: 'nowhere', text: 'x', createdBy: 'agent:case_manager' })).toThrow(/scope/);
    const m = createMemoryItem(h.db, { kind: 'note', scope: 'claim:c1', text: 'Insurer prefers email to post', basis: [{ kind: 'message', id: 'm1', label: null }], createdBy: 'agent:case_manager', now: T0 });
    expect(m).toMatchObject({ status: 'proposed', basis: [{ kind: 'message', id: 'm1', label: null }] });
    expect(m.decidedBy).toBeUndefined();
    const a = decideMemoryItem(h.db, m.id, { status: 'approved', actor: { userId: 'owner' }, now: T0 });
    expect(a).toMatchObject({ status: 'approved', decidedBy: 'owner', decidedAt: T0 });
    const r = decideMemoryItem(h.db, m.id, { status: 'retired', actor: { userId: 'owner' } });
    expect(r.status).toBe('retired');
    expect(() => decideMemoryItem(h.db, m.id, { status: 'approved', actor: { userId: 'owner' } })).toThrow(/retired/);
  });

  it('auto-approved research notes record the creator as the decider; recall returns approved items by overlap', () => {
    createMemoryItem(h.db, { kind: 'research', scope: 'claim:c1', text: 'Storage is recoverable while the insurer delays inspection.', status: 'approved', createdBy: 'agent:researcher', now: '2026-10-07T09:00:00.000Z' });
    createMemoryItem(h.db, { kind: 'note', scope: 'claim:c1', text: 'Proposed storage note', createdBy: 'agent:case_manager', now: '2026-10-07T09:01:00.000Z' });
    createMemoryItem(h.db, { kind: 'preference', scope: 'global', text: 'Owner prefers short emails.', status: 'approved', createdBy: 'owner', now: '2026-10-07T09:02:00.000Z' });
    expect(listMemoryItems(h.db, { scope: 'claim:c1', status: 'approved' })[0]).toMatchObject({ kind: 'research', decidedBy: 'agent:researcher' });
    expect(recallMemory(h.db, { q: 'storage inspection', scopes: ['claim:c1', 'global'] }).map((m) => m.kind)).toEqual(['research']);
    expect(recallMemory(h.db, { q: '', scopes: ['claim:c1', 'global'] }).map((m) => m.kind)).toEqual(['preference', 'research']);
    expect(countMemoryItems(h.db, { status: 'proposed' })).toBe(1);
  });
});
