// owned by ap-autopilot
/** claim_autopilot, autopilot_log (append-only) and hire_offers (docs/SUPREME-AUTOPILOT.md §A.2, §A.7, §D.2). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { AutopilotPlan, HireOfferTerms } from '@ccguk/domain';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { createTestDatabase } from '../testing.js';
import {
  appendAutopilotLog,
  countAutoOffersSince,
  createHireOffer,
  ensureClaimAutopilot,
  getClaimAutopilot,
  getHireOfferByOutbox,
  lastAutopilotActions,
  listAutopilotLog,
  listClaimAutopilotDue,
  listHireOffers,
  saveAutopilotPlan,
  setClaimAutopilotMode,
  setStepOverride,
  updateHireOffer,
} from './autopilot.js';

const AT = '2026-10-10T09:00:00.000Z';
let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

const terms: HireOfferTerms = {
  reservationId: 'r1', fleetUnitId: 'u1', registration: 'AB12 CDE', makeModel: 'Ford Focus', transmission: 'automatic', seats: 5, fuel: 'petrol', gtaGroup: 'C2', clientGtaGroup: 'C2',
  likeForLike: 'Same group.', startAt: AT, expectedEndAt: '2026-10-24T09:00:00.000Z', delivery: null, expiresAt: '2026-10-11T09:00:00.000Z', alternatives: [],
};

describe('claim_autopilot', () => {
  it('creates the row once, pauses / resumes with who and why, stores overrides and the plan', () => {
    const rec = ensureClaimAutopilot(h.db, 'c1', 'on', AT);
    expect(rec).toMatchObject({ claimId: 'c1', mode: 'on', stepOverrides: {} });
    expect(ensureClaimAutopilot(h.db, 'c1', 'paused', AT).mode).toBe('on');
    expect(setClaimAutopilotMode(h.db, 'c1', 'paused', { userId: 'u1', reason: 'client on holiday' }, AT)).toMatchObject({ mode: 'paused', pausedBy: 'u1', pausedReason: 'client on holiday', pausedAt: AT });
    expect(setClaimAutopilotMode(h.db, 'c1', 'on', { userId: 'u1' }, AT).pausedBy).toBeUndefined();
    setStepOverride(h.db, 'c1', 'intake.cctv', { action: 'skip', reason: 'no cameras', by: 'u1', at: AT }, AT);
    expect(getClaimAutopilot(h.db, 'c1')!.stepOverrides['intake.cctv']).toMatchObject({ action: 'skip' });
    setStepOverride(h.db, 'c1', 'intake.cctv', null, AT);
    expect(getClaimAutopilot(h.db, 'c1')!.stepOverrides['intake.cctv']).toBeUndefined();
    expect(listClaimAutopilotDue(h.db, AT).map((r) => r.claimId)).toEqual(['c1']);
    const plan = { version: 'autopilot/1', claimId: 'c1', evaluatedAt: AT, stage: 'intake', stageIndex: 2, mode: 'on', steps: [], due: [], waiting: [], done: [], nextCheckAt: '2026-10-10T15:00:00.000Z', planHash: 'h1' } as AutopilotPlan;
    saveAutopilotPlan(h.db, 'c1', plan, AT);
    expect(getClaimAutopilot(h.db, 'c1')).toMatchObject({ stage: 'intake', planHash: 'h1', nextCheckAt: '2026-10-10T15:00:00.000Z', lastEvaluatedAt: AT });
    expect(listClaimAutopilotDue(h.db, AT)).toEqual([]);
    expect(listClaimAutopilotDue(h.db, '2026-10-10T15:00:00.000Z')).toHaveLength(1);
  });
});

describe('autopilot_log', () => {
  it('appends in order, filters, gives the last action per step and refuses updates and deletes', () => {
    appendAutopilotLog(h.db, { claimId: 'c1', stepId: 'hire.search', fromStatus: 'upcoming', toStatus: 'due', actor: 'agent:autopilot', at: AT });
    appendAutopilotLog(h.db, { claimId: 'c1', stepId: 'hire.search', toStatus: 'done', action: 'tool:booking_hold', actor: 'agent:autopilot', refs: { reservationId: 'r1' }, at: AT });
    appendAutopilotLog(h.db, { claimId: 'c2', stepId: 'intake.cctv', toStatus: 'due', actor: 'agent:autopilot', at: AT });
    const rows = listAutopilotLog(h.db, { claimId: 'c1' });
    expect(rows.map((r) => r.toStatus)).toEqual(['due', 'done']);
    expect(rows[1]!.refs).toEqual({ reservationId: 'r1' });
    expect(listAutopilotLog(h.db, { claimId: 'c1', order: 'desc', limit: 1 })[0]!.toStatus).toBe('done');
    expect(lastAutopilotActions(h.db, 'c1')).toEqual({ 'hire.search': AT });
    expect(() => h.db.run(sql`UPDATE autopilot_log SET note = 'x'`)).toThrow();
    expect(() => h.db.run(sql`DELETE FROM autopilot_log`)).toThrow();
  });
});

describe('hire_offers', () => {
  it('creates a draft bound to an outbox, finds it by outbox, patches status and counts automatic offers', () => {
    const o = createHireOffer(h.db, { claimId: 'c1', reservationId: 'r1', channel: 'email', terms, termsSha256: 'abc', outboxId: 'ob1', authorisedBy: 'autopilot_green', expiresAt: terms.expiresAt, createdBy: 'agent:autopilot', at: AT });
    expect(o).toMatchObject({ status: 'draft', outboxId: 'ob1', terms });
    expect(getHireOfferByOutbox(h.db, 'ob1')!.id).toBe(o.id);
    const sent = updateHireOffer(h.db, o.id, { status: 'sent', sentAt: AT }, AT);
    expect(sent.sentAt).toBe(AT);
    updateHireOffer(h.db, o.id, { status: 'accepted', response: { at: AT, how: 'email_reply', decision: 'accept', recordedBy: 'agent:autopilot', confidence: 0.95 }, respondedAt: AT }, AT);
    expect(listHireOffers(h.db, { claimId: 'c1', status: 'accepted' })).toHaveLength(1);
    createHireOffer(h.db, { claimId: 'c1', reservationId: 'r2', channel: 'email', terms, termsSha256: 'abc', authorisedBy: 'owner-user', expiresAt: terms.expiresAt, createdBy: 'owner-user', at: AT });
    expect(countAutoOffersSince(h.db, '2026-10-10T00:00:00.000Z')).toBe(1);
    expect(() => createHireOffer(h.db, { claimId: 'c1', reservationId: 'r3', channel: 'email', terms, termsSha256: 'abc', outboxId: 'ob1', authorisedBy: 'autopilot_green', expiresAt: terms.expiresAt, createdBy: 'x', at: AT })).toThrow();
  });
});
