import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeGtaRates, type GtaRate } from '@ccguk/domain';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { NotFoundError, ValidationError, VerificationError } from '../errors.js';
import { createTestDatabase } from '../testing.js';
import {
  createGtaRate,
  deleteGtaRate,
  deleteGtaSegmentDefault,
  findGtaRate,
  getGtaRate,
  GtaRateExistsError,
  listGtaRates,
  listGtaSegmentDefaults,
  setGtaRateSuppressed,
  setGtaSegmentDefault,
  updateGtaRate,
  type GtaRateInput,
} from './gtaRates.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

const actor = { userId: 'u1' };
const input = (over: Partial<GtaRateInput> = {}): GtaRateInput => ({
  group: 'S1',
  description: 'Small car',
  dailyRatePence: 4400,
  period: '2026-27',
  effectiveFrom: '2026-07-01',
  effectiveTo: '2027-06-30',
  verification: { status: 'unverified', sourceNote: 'typed by hand' },
  ...over,
});
const KB: GtaRate[] = [
  { group: 'S1', dailyRatePence: 4232, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: { status: 'unverified' } },
  { group: 'CP1', dailyRatePence: 6464, period: '2025-26', effectiveFrom: '2025-07-01', effectiveTo: '2026-06-30', verification: { status: 'unverified' } },
];

describe('gta rates repository', () => {
  it('creates, reads, updates and deletes a manual rate', () => {
    const r = createGtaRate(h.db, input({ group: 's1' }), actor);
    expect(r).toMatchObject({ group: 'S1', dailyRatePence: 4400, suppressed: false, createdBy: 'u1', updatedBy: 'u1', verification: { status: 'unverified' } });
    expect(getGtaRate(h.db, r.id)?.description).toBe('Small car');
    expect(findGtaRate(h.db, 'S1', '2026-27')?.id).toBe(r.id);
    const u = updateGtaRate(h.db, r.id, input({ dailyRatePence: 4500, note: 'from the 2026-27 sheet' }), { userId: 'u2' });
    expect(u).toMatchObject({ dailyRatePence: 4500, note: 'from the 2026-27 sheet', updatedBy: 'u2', createdBy: 'u1' });
    expect(listGtaRates(h.db)).toHaveLength(1);
    deleteGtaRate(h.db, r.id);
    expect(listGtaRates(h.db)).toEqual([]);
    expect(() => deleteGtaRate(h.db, r.id)).toThrow(NotFoundError);
  });

  it('refuses a second row for the same group and period', () => {
    createGtaRate(h.db, input(), actor);
    expect(() => createGtaRate(h.db, input({ dailyRatePence: 1 }), actor)).toThrow(GtaRateExistsError);
    const other = createGtaRate(h.db, input({ group: 'M' }), actor);
    expect(() => updateGtaRate(h.db, other.id, input(), actor)).toThrow(GtaRateExistsError);
  });

  it('validates group, period, dates and pence', () => {
    expect(() => createGtaRate(h.db, input({ group: 'small' }), actor)).toThrow(ValidationError);
    expect(() => createGtaRate(h.db, input({ period: '2026/27' }), actor)).toThrow(ValidationError);
    expect(() => createGtaRate(h.db, input({ effectiveFrom: '2027-07-01' }), actor)).toThrow(/on or before/);
    expect(() => createGtaRate(h.db, input({ effectiveTo: '2027-02-30' }), actor)).toThrow(ValidationError);
    expect(() => createGtaRate(h.db, input({ dailyRatePence: 0 }), actor)).toThrow(/positive/);
    expect(() => createGtaRate(h.db, input({ dailyRatePence: 12.5 }), actor)).toThrow(/whole/);
  });

  it('never stores verified without a person, an https source and who/when', () => {
    const verified = { status: 'verified' as const, sourceUrl: 'https://www.gtacredithire.com/rates/', verifiedBy: 'u1', verifiedAt: '2026-10-04' };
    expect(() => createGtaRate(h.db, input({ verification: verified }), { userId: 'system' })).toThrow(VerificationError);
    expect(() => createGtaRate(h.db, input({ verification: { ...verified, sourceUrl: 'http://example.com' } }), actor)).toThrow(/https/);
    expect(() => createGtaRate(h.db, input({ verification: { status: 'verified', sourceUrl: 'https://x.test' } }), actor)).toThrow(/who verified/);
    expect(createGtaRate(h.db, input({ verification: verified }), actor).verification).toEqual(verified);
  });

  it('hides and shows a KB row (suppress rows) and feeds mergeGtaRates', () => {
    expect(() => setGtaRateSuppressed(h.db, { group: 'CP1', period: '2025-26', suppressed: true }, actor)).toThrow(NotFoundError);
    const s = setGtaRateSuppressed(h.db, { group: 'cp1', period: '2025-26', suppressed: true }, actor, { effectiveFrom: '2025-07-01', effectiveTo: '2026-06-30' });
    expect(s).toMatchObject({ group: 'CP1', suppressed: true });
    expect(s?.dailyRatePence).toBeUndefined();
    expect(mergeGtaRates(KB, listGtaRates(h.db)).map((r) => r.group)).toEqual(['S1']);
    expect(setGtaRateSuppressed(h.db, { group: 'CP1', period: '2025-26', suppressed: false }, actor)).toBeUndefined();
    expect(listGtaRates(h.db)).toEqual([]);
    // A row with its own rate keeps the rate when shown again.
    createGtaRate(h.db, input(), actor);
    expect(setGtaRateSuppressed(h.db, { group: 'S1', period: '2026-27', suppressed: true }, actor)).toMatchObject({ suppressed: true, dailyRatePence: 4400 });
    expect(mergeGtaRates(KB, listGtaRates(h.db)).find((r) => r.group === 'S1')).toBeUndefined();
    expect(setGtaRateSuppressed(h.db, { group: 'S1', period: '2026-27', suppressed: false }, actor)).toMatchObject({ suppressed: false, dailyRatePence: 4400 });
    expect(mergeGtaRates(KB, listGtaRates(h.db)).find((r) => r.group === 'S1')).toMatchObject({ dailyRatePence: 4400, origin: 'manual', overridesKb: true });
  });
});

describe('gta segment defaults repository', () => {
  it('sets, lists and resets segment overrides', () => {
    expect(listGtaSegmentDefaults(h.db)).toEqual([]);
    expect(setGtaSegmentDefault(h.db, 'city', 's2', actor)).toMatchObject({ segment: 'city', group: 'S2', updatedBy: 'u1' });
    setGtaSegmentDefault(h.db, 'city', 'S1', { userId: 'u2' });
    expect(listGtaSegmentDefaults(h.db)).toMatchObject([{ segment: 'city', group: 'S1', updatedBy: 'u2' }]);
    expect(() => setGtaSegmentDefault(h.db, 'City Cars', 'S1', actor)).toThrow(ValidationError);
    expect(() => setGtaSegmentDefault(h.db, 'city', 'xx-1', actor)).toThrow(ValidationError);
    expect(deleteGtaSegmentDefault(h.db, 'city')).toBe(true);
    expect(deleteGtaSegmentDefault(h.db, 'city')).toBe(false);
  });
});
