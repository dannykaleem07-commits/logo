// owned by claimai-server
/**
 * Claim AI input persistence (docs/CLAIM-AI-INPUT.md §2, §16.2): the owner's words are immutable, inputs are never
 * deleted, the log and correspondence are append-only, instructions are retire-only, the apply lock has one winner,
 * catch-up bundles stay out of the intake list. Synthetic data.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { createTestDatabase } from '../testing.js';
import {
  appendAiInputLog,
  appendCorrespondence,
  bumpAiInputRevision,
  casAiInputStatus,
  countAiInputs,
  createAiInput,
  createInstruction,
  findAiInputByBundle,
  getAiInput,
  listAiInputLog,
  listAiInputLogForClaim,
  listAiInputs,
  listCorrespondence,
  listInstructions,
  requireAiInput,
  retireInstruction,
  updateAiInput,
  withdrawCorrespondence,
} from './claimAi.js';
import { countIntakeBundles, createIntakeBundle, listIntakeBundles, updateBundleFile, addBundleFile, listBundleFiles } from './intakeBundles.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

const T0 = '2026-10-12T09:00:00.000Z';
const T1 = '2026-10-12T09:05:00.000Z';
const T2 = '2026-10-12T09:10:00.000Z';

describe('claim_ai_inputs', () => {
  it('create, read, list, count, update, revision and the bundle lookup', () => {
    const a = createAiInput(h.db, { claimId: 'c1', kind: 'update', channel: 'typed', text: 'client called', status: 'interpreting', createdBy: 'owner-1', now: T0 });
    expect(a).toMatchObject({ claimId: 'c1', kind: 'update', channel: 'typed', text: 'client called', status: 'interpreting', revision: 0, answers: [], autoApply: true, filesDone: false });
    const b = createAiInput(h.db, { claimId: 'c1', kind: 'catch_up', channel: 'upload', text: '', status: 'reading', bundleId: 'bun-1', autoApply: false, createdBy: 'owner-1', now: T1 });
    createAiInput(h.db, { claimId: 'c2', kind: 'update', channel: 'call_note', text: '', extraText: 'note', status: 'preview', createdBy: 'owner-1', now: T2 });
    expect(listAiInputs(h.db, { claimId: 'c1' }).map((x) => x.id)).toEqual([b.id, a.id]);
    expect(listAiInputs(h.db, { claimId: 'c1', kind: 'update' }).map((x) => x.id)).toEqual([a.id]);
    expect(countAiInputs(h.db, { claimId: 'c1', status: ['reading'] })).toBe(1);
    expect(findAiInputByBundle(h.db, 'bun-1')?.id).toBe(b.id);
    expect(getAiInput(h.db, 'nope')).toBeUndefined();
    expect(() => requireAiInput(h.db, 'nope')).toThrow();
    const u = updateAiInput(h.db, a.id, { status: 'preview', engine: 'rules', interpretation: { actions: [] }, answers: [{ q: 1 }], summary: { lines: [] }, filesDone: true }, T1);
    expect(u).toMatchObject({ status: 'preview', engine: 'rules', interpretation: { actions: [] }, answers: [{ q: 1 }], summary: { lines: [] }, filesDone: true, updatedAt: T1 });
    expect(bumpAiInputRevision(h.db, a.id)).toBe(1);
    expect(bumpAiInputRevision(h.db, a.id)).toBe(2);
    expect(() => updateAiInput(h.db, a.id, { status: 'bogus' as never })).toThrow();
    expect(() => createAiInput(h.db, { claimId: 'c1', kind: 'nope' as never, channel: 'typed', text: '', status: 'preview', createdBy: 'o' })).toThrow();
  });

  it('one bundle belongs to at most one input', () => {
    createAiInput(h.db, { claimId: 'c1', kind: 'catch_up', channel: 'upload', text: '', status: 'reading', bundleId: 'bun-x', createdBy: 'o' });
    expect(() => createAiInput(h.db, { claimId: 'c1', kind: 'catch_up', channel: 'upload', text: '', status: 'reading', bundleId: 'bun-x', createdBy: 'o' })).toThrow();
  });

  it("keeps the owner's words: UPDATE of text / extra_text / claim / kind refused, status still updatable; DELETE refused", () => {
    const a = createAiInput(h.db, { claimId: 'c1', kind: 'update', channel: 'typed', text: 'hire ended yesterday', extraText: 'call', status: 'preview', createdBy: 'o' });
    expect(() => h.sqlite.prepare('UPDATE claim_ai_inputs SET text = ? WHERE id = ?').run('changed', a.id)).toThrow(/owner's words/);
    expect(() => h.sqlite.prepare('UPDATE claim_ai_inputs SET extra_text = NULL WHERE id = ?').run(a.id)).toThrow(/owner's words/);
    expect(() => h.sqlite.prepare("UPDATE claim_ai_inputs SET claim_id = 'c9' WHERE id = ?").run(a.id)).toThrow();
    expect(() => h.sqlite.prepare("UPDATE claim_ai_inputs SET created_by = 'x' WHERE id = ?").run(a.id)).toThrow();
    expect(() => h.sqlite.prepare('DELETE FROM claim_ai_inputs WHERE id = ?').run(a.id)).toThrow(/never deleted/);
    h.sqlite.prepare("UPDATE claim_ai_inputs SET status = 'applied' WHERE id = ?").run(a.id);
    expect(getAiInput(h.db, a.id)).toMatchObject({ status: 'applied', text: 'hire ended yesterday', extraText: 'call' });
  });

  it('casAiInputStatus has exactly one winner', () => {
    const a = createAiInput(h.db, { claimId: 'c1', kind: 'update', channel: 'typed', text: 'x', status: 'preview', createdBy: 'o' });
    expect(casAiInputStatus(h.db, a.id, ['preview', 'clarify'], 'applying')).toBe(true);
    expect(casAiInputStatus(h.db, a.id, ['preview', 'clarify'], 'applying')).toBe(false);
    expect(getAiInput(h.db, a.id)!.status).toBe('applying');
  });
});

describe('claim_ai_input_log', () => {
  it('seq increments per input; append-only', () => {
    const a = createAiInput(h.db, { claimId: 'c1', kind: 'update', channel: 'typed', text: 'x', status: 'preview', createdBy: 'o' });
    const b = createAiInput(h.db, { claimId: 'c1', kind: 'update', channel: 'typed', text: 'y', status: 'preview', createdBy: 'o' });
    const l1 = appendAiInputLog(h.db, { inputId: a.id, claimId: 'c1', kind: 'created', actor: 'o', at: T0 });
    const l2 = appendAiInputLog(h.db, { inputId: a.id, claimId: 'c1', kind: 'applied', actionKey: 'a1', action: { type: 'note' }, refs: { eventId: 'e1' }, actor: 'o', at: T1 });
    const m1 = appendAiInputLog(h.db, { inputId: b.id, claimId: 'c1', kind: 'created', actor: 'o', at: T2 });
    expect([l1.seq, l2.seq, m1.seq]).toEqual([1, 2, 1]);
    expect(l2).toMatchObject({ actionKey: 'a1', action: { type: 'note' }, refs: { eventId: 'e1' } });
    expect(listAiInputLog(h.db, a.id).map((x) => x.seq)).toEqual([1, 2]);
    expect(listAiInputLogForClaim(h.db, 'c1', { since: T1 }).map((x) => x.id)).toEqual([l2.id, m1.id]);
    expect(listAiInputLogForClaim(h.db, null, { until: T1 }).map((x) => x.id)).toEqual([l1.id]);
    expect(() => appendAiInputLog(h.db, { inputId: a.id, claimId: 'c1', kind: 'bogus' as never, actor: 'o' })).toThrow();
    expect(() => h.sqlite.prepare("UPDATE claim_ai_input_log SET note = 'x' WHERE id = ?").run(l1.id)).toThrow(/append-only/);
    expect(() => h.sqlite.prepare('DELETE FROM claim_ai_input_log WHERE id = ?').run(l1.id)).toThrow(/append-only/);
  });
});

describe('claim_instructions', () => {
  it('lists active at an instant; retire only active → retired; no other update; no delete', () => {
    const i1 = createInstruction(h.db, { claimId: 'c1', text: "  Don't chase the client  until Monday ", effect: { kind: 'hold_contact', contacts: ['client'] }, activeFrom: T0, until: '2026-10-18T23:00:00.000Z', createdBy: 'o', now: T0 });
    expect(i1).toMatchObject({ text: "Don't chase the client until Monday", appliesTo: ['all'], status: 'active', effect: { kind: 'hold_contact', contacts: ['client'] } });
    const i2 = createInstruction(h.db, { claimId: 'c1', text: 'Weekly client update', appliesTo: ['case_manager', 'drafter'], createdBy: 'o', now: T1, activeFrom: T1 });
    expect(i2.effect).toBeNull();
    expect(listInstructions(h.db, { claimId: 'c1' }).map((x) => x.id)).toEqual([i2.id, i1.id]);
    expect(listInstructions(h.db, { claimId: 'c1', activeAt: '2026-10-19T00:00:00.000Z' }).map((x) => x.id)).toEqual([i2.id]);
    expect(listInstructions(h.db, { claimId: 'c1', activeAt: '2026-10-12T09:01:00.000Z' }).map((x) => x.id)).toEqual([i1.id]);
    expect(() => h.sqlite.prepare("UPDATE claim_instructions SET text = 'x' WHERE id = ?").run(i1.id)).toThrow(/only be retired/);
    expect(() => h.sqlite.prepare("UPDATE claim_instructions SET until = NULL WHERE id = ?").run(i1.id)).toThrow(/only be retired/);
    const r = retireInstruction(h.db, i1.id, { by: 'o', reason: 'done', now: T2 });
    expect(r).toMatchObject({ status: 'retired', retiredBy: 'o', retiredReason: 'done', retiredAt: T2 });
    expect(() => retireInstruction(h.db, i1.id, { by: 'o' })).toThrow();
    expect(() => h.sqlite.prepare("UPDATE claim_instructions SET status = 'active' WHERE id = ?").run(i1.id)).toThrow(/only be retired/);
    expect(listInstructions(h.db, { claimId: 'c1', status: 'retired' }).map((x) => x.id)).toEqual([i1.id]);
    expect(listInstructions(h.db, { claimId: 'c1', status: 'all' })).toHaveLength(2);
    expect(() => h.sqlite.prepare('DELETE FROM claim_instructions WHERE id = ?').run(i2.id)).toThrow(/never deleted/);
    expect(() => createInstruction(h.db, { claimId: 'c1', text: '  ', createdBy: 'o' })).toThrow();
  });
});

describe('claim_correspondence', () => {
  it('append-only; evidence unique for live records; withdraw by a superseding row; live list', () => {
    const base = { claimId: 'c1', channel: 'post' as const, kind: 'ncaf', templateId: 'letter.ncaf', dateSource: 'document' as const, summary: 'NCAF sent', createdBy: 'agent:intake' };
    const a = appendCorrespondence(h.db, { ...base, direction: 'out', at: '2026-10-02T11:00:00.000Z', evidenceId: 'ev-1' });
    expect(a.created).toBe(true);
    const again = appendCorrespondence(h.db, { ...base, direction: 'out', at: '2026-10-03T11:00:00.000Z', evidenceId: 'ev-1' });
    expect(again).toMatchObject({ created: false, record: { id: a.record.id, at: '2026-10-02T11:00:00.000Z' } });
    const inbound = appendCorrespondence(h.db, { ...base, direction: 'in', kind: 'insurer_letter', at: '2026-10-06T11:00:00.000Z', evidenceId: 'ev-1' });
    expect(inbound.created).toBe(true);
    const noEv = appendCorrespondence(h.db, { ...base, direction: 'out', kind: 'chaser', at: '2026-10-01T11:00:00.000Z' });
    expect(listCorrespondence(h.db, 'c1').map((r) => r.id)).toEqual([noEv.record.id, a.record.id, inbound.record.id]);
    expect(listCorrespondence(h.db, 'c1', { direction: 'out' })).toHaveLength(2);
    const w = withdrawCorrespondence(h.db, a.record.id, { by: 'owner' });
    expect(w).toMatchObject({ supersedesId: a.record.id, withdrawn: true, evidenceId: 'ev-1' });
    expect(listCorrespondence(h.db, 'c1').map((r) => r.id)).toEqual([noEv.record.id, inbound.record.id]);
    expect(listCorrespondence(h.db, 'c1', { includeWithdrawn: true })).toHaveLength(4);
    expect(() => withdrawCorrespondence(h.db, a.record.id, { by: 'owner' })).toThrow();
    // Re-recording after a withdrawal: a row superseding the withdrawal is live again.
    const re = appendCorrespondence(h.db, { ...base, direction: 'out', at: '2026-10-05T11:00:00.000Z', evidenceId: 'ev-1', supersedesId: w.id });
    expect(re.created).toBe(true);
    expect(listCorrespondence(h.db, 'c1', { direction: 'out' }).map((r) => r.at)).toEqual(['2026-10-01T11:00:00.000Z', '2026-10-05T11:00:00.000Z']);
    expect(() => h.sqlite.prepare("UPDATE claim_correspondence SET summary = 'x' WHERE id = ?").run(a.record.id)).toThrow(/append-only/);
    expect(() => h.sqlite.prepare('DELETE FROM claim_correspondence WHERE id = ?').run(a.record.id)).toThrow(/append-only/);
    expect(() => appendCorrespondence(h.db, { ...base, direction: 'sideways' as never, at: T0 })).toThrow();
    expect(() => appendCorrespondence(h.db, { ...base, direction: 'out', dateSource: 'upload' as never, at: T0 })).toThrow();
  });
});

describe('catch-up bundles (intake_bundles.mode)', () => {
  it('need a target claim, default list/count to intake bundles, keep per-file catch-up facts', () => {
    const intake = createIntakeBundle(h.db, { name: 'Jane', source: 'upload', createdBy: 'o' });
    expect(intake).toMatchObject({ mode: 'intake' });
    expect(intake.targetClaimId).toBeUndefined();
    expect(() => createIntakeBundle(h.db, { name: 'Catch-up', source: 'upload', mode: 'catch_up', createdBy: 'o' })).toThrow();
    const cu = createIntakeBundle(h.db, { name: 'Catch-up CCG-2026-00001', source: 'upload', mode: 'catch_up', targetClaimId: 'c1', createdBy: 'o' });
    expect(cu).toMatchObject({ mode: 'catch_up', targetClaimId: 'c1' });
    expect(listIntakeBundles(h.db).map((b) => b.id)).toEqual([intake.id]);
    expect(countIntakeBundles(h.db)).toBe(1);
    expect(listIntakeBundles(h.db, { mode: 'catch_up' }).map((b) => b.id)).toEqual([cu.id]);
    expect(countIntakeBundles(h.db, { mode: 'all' })).toBe(2);
    expect(listIntakeBundles(h.db, { mode: 'catch_up', targetClaimId: 'c1' })).toHaveLength(1);
    expect(() => h.sqlite.prepare("UPDATE intake_bundles SET mode = 'other' WHERE id = ?").run(cu.id)).toThrow();
    const f = addBundleFile(h.db, { bundleId: cu.id, intakeItemId: 'i1', evidenceId: 'e1', addedBy: 'o' }).file;
    updateBundleFile(h.db, f.id, { catchUp: { direction: 'out' } });
    expect(listBundleFiles(h.db, cu.id)[0]!.catchUp).toEqual({ direction: 'out' });
  });
});
