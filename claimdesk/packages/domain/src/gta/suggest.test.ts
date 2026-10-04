import { describe, expect, it } from 'vitest';
import type { GtaRate } from '../types.js';
import { GTA_NON_SUBSCRIBER_NOTE } from './rates.js';
import { suggestGtaGroup, type GtaSuggestInput } from './suggest.js';

const RATES: GtaRate[] = [
  { group: 'S1', dailyRatePence: 4232, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: { status: 'unverified' } },
  { group: 'M', dailyRatePence: 5666, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: { status: 'unverified' } },
  { group: 'M1', dailyRatePence: 6549, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: { status: 'unverified' } },
  { group: 'S3', dailyRatePence: 5100, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: { status: 'unverified' } },
];
const DEFAULTS = { city: 'S1', 'small-family': 'S3', 'suv-small': 'M1', 'van-medium': 'PV2' };

const base = (over: Partial<GtaSuggestInput> = {}): GtaSuggestInput => ({
  segmentDefaults: DEFAULTS,
  vehicle: { make: 'Volkswagen', model: 'Golf', engineCapacityCc: 1498, bodyType: 'Hatchback' },
  date: '2026-10-04',
  rates: RATES,
  ...over,
});

describe('suggestGtaGroup', () => {
  it('uses the recorded group first (high)', () => {
    const s = suggestGtaGroup(base({ recordedGroup: 'm1', customOverride: 'S1', catalogue: { trimGroup: 'S3', segment: 'small-family' } }));
    expect(s).toMatchObject({ group: 'M1', confidence: 'high', basis: 'recorded', segment: 'small-family' });
    expect(s.rate).toMatchObject({ group: 'M1', dailyRatePence: 6549 });
  });
  it('then a custom catalogue override (medium)', () => {
    expect(suggestGtaGroup(base({ customOverride: 'S1', catalogue: { trimGroup: 'S3' } }))).toMatchObject({ group: 'S1', confidence: 'medium', basis: 'custom_override' });
  });
  it('then catalogue trim, generation and model groups (medium)', () => {
    expect(suggestGtaGroup(base({ catalogue: { trimGroup: 'S3', generationGroup: 'M', modelGroup: 'M1' } }))).toMatchObject({ group: 'S3', basis: 'catalogue_trim', confidence: 'medium' });
    expect(suggestGtaGroup(base({ catalogue: { generationGroup: 'M', modelGroup: 'M1' } }))).toMatchObject({ group: 'M', basis: 'catalogue_generation' });
    expect(suggestGtaGroup(base({ catalogue: { modelGroup: 'M1', segment: 'city' } }))).toMatchObject({ group: 'M1', basis: 'catalogue_model' });
  });
  it('then the segment default (low)', () => {
    const s = suggestGtaGroup(base({ catalogue: { segment: 'city' } }));
    expect(s).toMatchObject({ group: 'S1', basis: 'segment_default', confidence: 'low', segment: 'city' });
    expect(s.reason).toContain('city');
  });
  it('then the mapGtaGroup heuristic (low)', () => {
    const s = suggestGtaGroup(base({ catalogue: { segment: 'unknown-segment' } }));
    expect(s).toMatchObject({ group: 'M', basis: 'heuristic', confidence: 'low' });
  });
  it('returns none when nothing is known', () => {
    const s = suggestGtaGroup(base({ vehicle: { make: '', model: 'UNKNOWN' } }));
    expect(s).toMatchObject({ group: null, basis: 'none', confidence: 'none', rate: null });
  });
  it('ignores malformed group codes and falls through', () => {
    expect(suggestGtaGroup(base({ recordedGroup: 'not a group', catalogue: { segment: 'city' } }))).toMatchObject({ group: 'S1', basis: 'segment_default' });
  });
  it('gives rate null and says so when no benchmark rate is loaded for the group on the date', () => {
    const s = suggestGtaGroup(base({ catalogue: { segment: 'van-medium' } }));
    expect(s.group).toBe('PV2');
    expect(s.rate).toBeNull();
    expect(s.reason).toContain('No benchmark rate is loaded for group PV2 on 2026-10-04 — add it in Settings → GTA benchmark rates');
    const old = suggestGtaGroup(base({ recordedGroup: 'S1', date: '2025-01-01' }));
    expect(old.rate).toBeNull();
  });
  it('always carries the non-subscriber note', () => {
    const s = suggestGtaGroup(base({ recordedGroup: 'S1' }));
    expect(s.note).toContain(GTA_NON_SUBSCRIBER_NOTE);
    expect(s.note).toMatch(/suggestion only — confirm the group/);
  });
  it('passes merged-rate origin through', () => {
    const s = suggestGtaGroup(base({ recordedGroup: 'S1', rates: [{ ...RATES[0]!, dailyRatePence: 4500, origin: 'manual' } as GtaRate] }));
    expect(s.rate).toMatchObject({ dailyRatePence: 4500, origin: 'manual' });
  });
});
