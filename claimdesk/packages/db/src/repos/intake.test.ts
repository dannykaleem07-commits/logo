// owned by intake
/**
 * Intake persistence (docs/SUPREME-DESIGN.md §G, §N.3): items, append-only extractions, proposals with a one-way
 * pending → applied | rejected | superseded decision and duplicate suppression. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { createTestDatabase } from '../testing.js';
import {
  appendIntakeExtraction,
  countIntakeItems,
  createIntakeItem,
  decideClaimUpdateProposal,
  findIntakeItemByEvidence,
  getIntakeItem,
  insertClaimUpdateProposal,
  latestIntakeExtraction,
  listClaimUpdateProposals,
  listIntakeExtractions,
  listIntakeItems,
  requireIntakeItem,
  setClaimUpdateProposalPolicy,
  supersedeClaimUpdateProposals,
  updateIntakeItem,
} from './intake.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

const T0 = '2026-10-07T09:00:00.000Z';
const T1 = '2026-10-07T09:05:00.000Z';

describe('intake items', () => {
  it('create, read, update and list by claim / status / parent', () => {
    const a = createIntakeItem(h.db, { source: 'upload', evidenceId: 'ev-1', createdBy: 'owner', now: T0 });
    expect(a).toMatchObject({ source: 'upload', evidenceId: 'ev-1', status: 'queued', createdBy: 'owner', createdAt: T0, updatedAt: T0 });
    expect(a.claimId).toBeUndefined();
    const child = createIntakeItem(h.db, { source: 'email', evidenceId: 'ev-2', parentItemId: a.id, claimId: 'claim-1', createdBy: 'agent:mail', now: T1 });

    const updated = updateIntakeItem(h.db, a.id, { status: 'extracting', sniffedType: 'pdf', pages: 2, normalised: { kind: 'pdf', pageTexts: ['one', 'two'] }, textSha256: 'abc' }, T1);
    expect(updated).toMatchObject({ status: 'extracting', sniffedType: 'pdf', pages: 2, textSha256: 'abc', updatedAt: T1 });
    expect(updated.normalised).toEqual({ kind: 'pdf', pageTexts: ['one', 'two'] });
    expect(getIntakeItem(h.db, a.id)?.normalised).toEqual({ kind: 'pdf', pageTexts: ['one', 'two'] });

    expect(listIntakeItems(h.db).map((i) => i.id)).toEqual([child.id, a.id]); // newest first
    expect(listIntakeItems(h.db, { claimId: null }).map((i) => i.id)).toEqual([a.id]);
    expect(listIntakeItems(h.db, { claimId: 'claim-1' }).map((i) => i.id)).toEqual([child.id]);
    expect(listIntakeItems(h.db, { parentItemId: a.id }).map((i) => i.id)).toEqual([child.id]);
    expect(listIntakeItems(h.db, { status: ['extracting', 'failed'] }).map((i) => i.id)).toEqual([a.id]);
    expect(countIntakeItems(h.db, { status: 'queued' })).toBe(1);

    expect(findIntakeItemByEvidence(h.db, 'ev-2')?.id).toBe(child.id);
    expect(findIntakeItemByEvidence(h.db, 'ev-2', { parentItemId: null })).toBeUndefined();
    expect(findIntakeItemByEvidence(h.db, 'ev-2', { parentItemId: a.id })?.id).toBe(child.id);

    // clearing the claim and setting an error
    const cleared = updateIntakeItem(h.db, child.id, { claimId: null, status: 'failed', error: 'broken' }, T1);
    expect(cleared.claimId).toBeUndefined();
    expect(cleared.error).toBe('broken');
  });

  it('refuses unknown sources and statuses; missing items throw', () => {
    expect(() => createIntakeItem(h.db, { source: 'fax' as never, evidenceId: 'e', createdBy: 'x' })).toThrow(/Unknown intake source/);
    const a = createIntakeItem(h.db, { source: 'folder', evidenceId: 'e', createdBy: 'x' });
    expect(() => updateIntakeItem(h.db, a.id, { status: 'done' as never })).toThrow(/Unknown intake status/);
    expect(() => requireIntakeItem(h.db, 'nope')).toThrow();
    // the CHECK constraint holds even without the repo
    expect(() => h.sqlite.prepare(`UPDATE intake_items SET status = 'weird' WHERE id = ?`).run(a.id)).toThrow();
  });
});

describe('intake extractions (append-only)', () => {
  it('append, list oldest first, latest; UPDATE and DELETE are refused', () => {
    const item = createIntakeItem(h.db, { source: 'upload', evidenceId: 'ev-1', createdBy: 'owner' });
    const one = appendIntakeExtraction(h.db, { intakeItemId: item.id, runId: 'run-1', schemaId: 'intake_extraction', fields: [{ name: 'VIN', value: 'X' }], summary: 'first', now: T0 });
    const two = appendIntakeExtraction(h.db, { intakeItemId: item.id, schemaId: 'intake_extraction', fields: [], warnings: ['blurred'], now: T1 });
    expect(one).toMatchObject({ runId: 'run-1', schemaId: 'intake_extraction', summary: 'first', warnings: [] });
    expect(two.warnings).toEqual(['blurred']);
    expect(listIntakeExtractions(h.db, item.id).map((e) => e.id)).toEqual([one.id, two.id]);
    expect(latestIntakeExtraction(h.db, item.id)?.id).toBe(two.id);
    expect(() => h.sqlite.prepare(`UPDATE intake_extractions SET summary = 'changed' WHERE id = ?`).run(one.id)).toThrow(/append-only/);
    expect(() => h.sqlite.prepare(`DELETE FROM intake_extractions WHERE id = ?`).run(one.id)).toThrow(/append-only/);
    expect(() => appendIntakeExtraction(h.db, { intakeItemId: 'missing', schemaId: 'intake_extraction', fields: [] })).toThrow();
  });
});

describe('claim update proposals', () => {
  const base = { claimId: 'claim-1', intakeItemId: 'item-1', target: 'vehicle:client.vin', proposedValue: 'WVWZZZ1JZXW000001', confidence: 0.95, sensitive: false, source: { intakeItemId: 'item-1', evidenceId: 'ev-1', page: 1, quote: 'VIN WVWZZZ1JZXW000001' }, policyDecision: 'auto' as const };

  it('insert with checks, dedupe a pending duplicate, list by claim / item / status / policy', () => {
    const { proposal: p, created } = insertClaimUpdateProposal(h.db, { ...base, currentValue: null, checks: { validator: { name: 'vin', ok: true }, policy: { ruleIds: ['internal_ok'], reasons: [] } }, now: T0 });
    expect(created).toBe(true);
    expect(p).toMatchObject({ status: 'pending', policyDecision: 'auto', sensitive: false, confidence: 0.95, source: { page: 1, quote: 'VIN WVWZZZ1JZXW000001' } });
    expect(p.currentValue).toBeUndefined();
    expect(p.validator?.validator).toEqual({ name: 'vin', ok: true });
    const again = insertClaimUpdateProposal(h.db, { ...base, now: T1 });
    expect(again.created).toBe(false);
    expect(again.proposal.id).toBe(p.id);
    const other = insertClaimUpdateProposal(h.db, { ...base, target: 'party:client.dateOfBirth', proposedValue: '1990-01-02', sensitive: true, policyDecision: 'confirm', now: T1 }).proposal;
    expect(other.sensitive).toBe(true);

    expect(listClaimUpdateProposals(h.db, { claimId: 'claim-1' }).map((x) => x.id)).toEqual([p.id, other.id]);
    expect(listClaimUpdateProposals(h.db, { intakeItemId: 'item-1', policyDecision: 'confirm' }).map((x) => x.id)).toEqual([other.id]);
    expect(listClaimUpdateProposals(h.db, { ids: [] })).toEqual([]);
    expect(listClaimUpdateProposals(h.db, { ids: [other.id] }).map((x) => x.id)).toEqual([other.id]);
    expect(() => insertClaimUpdateProposal(h.db, { ...base, confidence: 1.5 })).toThrow(/Confidence/);
  });

  it('decides once (pending → applied | rejected | superseded) and keeps the reason', () => {
    const p = insertClaimUpdateProposal(h.db, base).proposal;
    const rejected = decideClaimUpdateProposal(h.db, p.id, { status: 'rejected', decidedBy: 'owner', decidedAt: T1, reason: 'wrong vehicle' });
    expect(rejected).toMatchObject({ status: 'rejected', decidedBy: 'owner', decidedAt: T1 });
    expect(rejected.validator?.decision?.reason).toBe('wrong vehicle');
    expect(() => decideClaimUpdateProposal(h.db, p.id, { status: 'applied', decidedBy: 'owner' })).toThrow(/already rejected/);
    // a decided proposal no longer suppresses a new identical one
    expect(insertClaimUpdateProposal(h.db, base).created).toBe(true);
  });

  it('policy changes only while pending; supersede the other pending proposals on a target', () => {
    const a = insertClaimUpdateProposal(h.db, { ...base, now: T0 }).proposal;
    const b = insertClaimUpdateProposal(h.db, { ...base, proposedValue: 'WVWZZZ1JZXW000002', now: T1 }).proposal;
    const c = setClaimUpdateProposalPolicy(h.db, a.id, 'confirm', { decision: { error: 'route refused' } });
    expect(c.policyDecision).toBe('confirm');
    expect(c.validator?.decision?.error).toBe('route refused');
    expect(supersedeClaimUpdateProposals(h.db, { claimId: 'claim-1', target: base.target, keepId: b.id, decidedBy: 'agent:intake' })).toBe(1);
    expect(listClaimUpdateProposals(h.db, { status: 'superseded' }).map((x) => x.id)).toEqual([a.id]);
    expect(() => setClaimUpdateProposalPolicy(h.db, a.id, 'auto')).toThrow(/only a pending/);
    const applied = decideClaimUpdateProposal(h.db, b.id, { status: 'applied', decidedBy: 'owner', appliedValue: 'WVWZZZ1JZXW000003' });
    expect(applied.validator?.decision?.note).toMatch(/applied as edited: WVWZZZ1JZXW000003/);
  });
});
