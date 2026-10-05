import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { ValidationError } from '../errors.js';
import { seedFileOne, type FileOneIds } from '../fixtures/fileOne.js';
import { createTestDatabase } from '../testing.js';
import { correctHire, createHire, endHire, listHireWithRecordedAt, requireHire } from './hire.js';

let h: DatabaseHandle;
let ids: FileOneIds;
beforeEach(() => {
  h = createTestDatabase();
  ids = seedFileOne(h.db);
});
afterEach(() => closeDatabase(h));

const base = () => ({ claimId: ids.claimId, fleetUnitId: ids.fleetUnitId, startAt: '2026-09-10T09:00:00.000Z', dailyRatePence: 4980, vatRate: 0, gtaGroup: 'S1', excessPence: 0 });

describe('hire repo — 0.3 pricing snapshot and corrections', () => {
  it('createHire stores the five pricing fields and an end given up front', () => {
    const hire = createHire(h.db, {
      ...base(),
      endAt: '2026-09-17T09:00:00.000Z',
      endTrigger: 'client_returned',
      clientGtaGroup: 'S1',
      clientGtaDailyRatePence: 4232,
      hireGtaDailyRatePence: 7468,
      fleetDailyRatePence: 7468,
      pricingNote: 'Higher group than the damaged car',
    });
    expect(hire).toMatchObject({ endAt: '2026-09-17T09:00:00.000Z', endTrigger: 'client_returned', clientGtaGroup: 'S1', clientGtaDailyRatePence: 4232, hireGtaDailyRatePence: 7468, fleetDailyRatePence: 7468, pricingNote: 'Higher group than the damaged car' });
    const listed = listHireWithRecordedAt(h.db, ids.claimId).find((x) => x.id === hire.id);
    expect(listed?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('createHire without the pricing fields leaves them absent (pre-0.3 shape)', () => {
    const hire = requireHire(h.db, ids.hireId);
    expect(hire.clientGtaGroup).toBeUndefined();
    expect(hire.pricingNote).toBeUndefined();
  });

  it('end before start is refused unless allowEndBeforeStart', () => {
    expect(() => createHire(h.db, { ...base(), endAt: '2026-09-09T09:00:00.000Z' })).toThrow(ValidationError);
    const hire = createHire(h.db, { ...base(), endAt: '2026-09-09T09:00:00.000Z' }, { allowEndBeforeStart: true });
    expect(hire.endAt).toBe('2026-09-09T09:00:00.000Z');
    const open = createHire(h.db, { ...base(), startAt: '2026-10-01T09:00:00.000Z' });
    expect(() => endHire(h.db, open.id, { endAt: '2026-09-30T09:00:00.000Z', endTrigger: 'manual' })).toThrow(ValidationError);
    expect(endHire(h.db, open.id, { endAt: '2026-09-30T09:00:00.000Z', endTrigger: 'manual' }, { allowEndBeforeStart: true }).endAt).toBe('2026-09-30T09:00:00.000Z');
  });

  it('correctHire moves the dates, writes explicit nulls and leaves undefined fields alone', () => {
    const hire = createHire(h.db, { ...base(), endAt: '2026-09-17T09:00:00.000Z', endTrigger: 'client_returned', clientGtaGroup: 'S1', clientGtaDailyRatePence: 4232, pricingNote: 'note' });
    const moved = correctHire(h.db, hire.id, { startAt: '2026-09-12T09:00:00.000Z', dailyRatePence: 4232 });
    expect(moved).toMatchObject({ startAt: '2026-09-12T09:00:00.000Z', endAt: '2026-09-17T09:00:00.000Z', endTrigger: 'client_returned', dailyRatePence: 4232, clientGtaGroup: 'S1' });
    const reopened = correctHire(h.db, hire.id, { endAt: null, endTrigger: null, clientGtaGroup: null, clientGtaDailyRatePence: null, pricingNote: null });
    expect(reopened.endAt).toBeUndefined();
    expect(reopened.endTrigger).toBeUndefined();
    expect(reopened.clientGtaGroup).toBeUndefined();
    expect(reopened.clientGtaDailyRatePence).toBeUndefined();
    expect(reopened.pricingNote).toBeUndefined();
    expect(reopened.startAt).toBe('2026-09-12T09:00:00.000Z');
    expect(correctHire(h.db, hire.id, {})).toEqual(reopened);
  });

  it('correctHire validates the rate and the merged dates', () => {
    const hire = createHire(h.db, { ...base(), endAt: '2026-09-17T09:00:00.000Z' });
    expect(() => correctHire(h.db, hire.id, { dailyRatePence: 0 })).toThrow(ValidationError);
    expect(() => correctHire(h.db, hire.id, { dailyRatePence: 12.5 })).toThrow(ValidationError);
    expect(() => correctHire(h.db, hire.id, { startAt: '2026-09-18T09:00:00.000Z' })).toThrow(ValidationError);
    const odd = correctHire(h.db, hire.id, { startAt: '2026-09-18T09:00:00.000Z' }, { allowEndBeforeStart: true });
    expect(odd.startAt).toBe('2026-09-18T09:00:00.000Z');
    expect(requireHire(h.db, hire.id).startAt).toBe('2026-09-18T09:00:00.000Z');
  });
});
