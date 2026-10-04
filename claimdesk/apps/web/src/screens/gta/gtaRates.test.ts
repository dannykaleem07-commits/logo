import { describe, expect, it } from 'vitest';
import type { GtaRate, HireAgreement } from '@ccguk/domain';
import type { GtaRateListItem } from '../../api/vehiclesApi';
import { hireTotals } from '../claim/lib/hire';
import {
  emptyRateForm,
  gtaPeriodFor,
  knownGroups,
  ORIGIN_LABEL,
  rateActions,
  rateBodyFrom,
  rateFormFromItem,
  rateOrigin,
  segmentChanged,
  segmentGroupError,
  sortRates,
  validateRateForm,
  verifiedByText
} from './gtaRates';

const unverified = { status: 'unverified' as const, sourceUrl: 'https://www.gtacredithire.com/rates/' };
const kbS1: GtaRate = { group: 'S1', description: 'Small car', dailyRatePence: 4232, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: unverified };

const KB_ROW: GtaRateListItem = { ...kbS1, origin: 'kb' };
const OVERRIDE: GtaRateListItem = { ...kbS1, dailyRatePence: 4500, origin: 'manual', id: 'r1', overridesKb: true, kbRate: kbS1, suppressed: false, verification: { status: 'verified', sourceUrl: 'https://example.org/gta-2026-27.pdf', verifiedBy: 'u1', verifiedAt: '2026-09-01' } };
const HIDDEN: GtaRateListItem = { ...kbS1, group: 'M', origin: 'kb', id: 'r2', overridesKb: false, kbRate: { ...kbS1, group: 'M' }, suppressed: true };
const MINE: GtaRateListItem = { group: 'PV2', dailyRatePence: 7100, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', origin: 'manual', id: 'r3', overridesKb: false, suppressed: false, verification: { status: 'unverified' } };

describe('origin badges', () => {
  it('knowledge base, your rate, overrides knowledge base, hidden', () => {
    expect(ORIGIN_LABEL[rateOrigin(KB_ROW)]).toBe('Knowledge base');
    expect(ORIGIN_LABEL[rateOrigin(MINE)]).toBe('Your rate');
    expect(ORIGIN_LABEL[rateOrigin(OVERRIDE)]).toBe('Overrides knowledge base');
    expect(ORIGIN_LABEL[rateOrigin(HIDDEN)]).toBe('Hidden');
  });
  it('actions per row', () => {
    expect(rateActions(KB_ROW)).toEqual({ edit: 'create', hide: true, show: false, delete: false });
    expect(rateActions(OVERRIDE)).toEqual({ edit: 'update', hide: true, show: false, delete: true });
    expect(rateActions(HIDDEN)).toEqual({ edit: null, hide: false, show: true, delete: false });
    expect(rateActions(MINE)).toEqual({ edit: 'update', hide: false, show: false, delete: true });
  });
});

describe('rate form', () => {
  it('a KB row starts an override with the KB figures, unverified, group and period locked', () => {
    const f = rateFormFromItem({ ...KB_ROW, verification: { status: 'verified', sourceUrl: 'https://x.example/', verifiedBy: 'kb' } });
    expect(f).toMatchObject({ group: 'S1', period: '2026-27', dailyRatePence: 4232, verificationStatus: 'unverified', sourceUrl: '', lockKey: true });
    expect(f.id).toBeUndefined();
  });
  it('your row edits in place with its verification', () => {
    const f = rateFormFromItem(OVERRIDE);
    expect(f).toMatchObject({ id: 'r1', dailyRatePence: 4500, verificationStatus: 'verified', sourceUrl: 'https://example.org/gta-2026-27.pdf' });
    expect(f.lockKey).toBeUndefined();
  });
  it('verified requires an https source URL client-side', () => {
    const f = { ...emptyRateForm('2026-10-04'), group: 'cp1', dailyRatePence: 7000, verificationStatus: 'verified' as const };
    expect(validateRateForm(f)).toEqual({ sourceUrl: expect.stringMatching(/https:\/\//) });
    expect(validateRateForm({ ...f, sourceUrl: 'http://example.org/rates' })).toEqual({ sourceUrl: expect.any(String) });
    expect(validateRateForm({ ...f, sourceUrl: 'https://example.org/rates.pdf' })).toEqual({});
    // unverified needs no URL
    expect(validateRateForm({ ...f, verificationStatus: 'unverified' })).toEqual({});
  });
  it('checks the group, the rate, the period and the dates', () => {
    const e = validateRateForm({ ...emptyRateForm('2026-10-04'), group: 'small', dailyRatePence: 0, period: '2026/27', effectiveFrom: '2027-01-01', effectiveTo: '2026-12-31' });
    expect(Object.keys(e).sort()).toEqual(['dailyRatePence', 'effectiveTo', 'group', 'period']);
  });
  it('builds the body without verifiedBy/verifiedAt (the server sets them)', () => {
    const body = rateBodyFrom({ ...emptyRateForm('2026-10-04'), group: ' cp1 ', dailyRatePence: 7000, verificationStatus: 'verified', sourceUrl: 'https://example.org/rates.pdf', note: ' from the 2026-27 table ' });
    expect(body).toEqual({ group: 'CP1', dailyRatePence: 7000, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: { status: 'verified', sourceUrl: 'https://example.org/rates.pdf' }, note: 'from the 2026-27 table' });
    expect(JSON.stringify(body)).not.toMatch(/verifiedBy|verifiedAt/);
  });
  it('GTA periods run 1 July to 30 June', () => {
    expect(gtaPeriodFor('2026-10-04')).toEqual({ period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30' });
    expect(gtaPeriodFor('2026-06-30')).toEqual({ period: '2025-26', effectiveFrom: '2025-07-01', effectiveTo: '2026-06-30' });
    expect(gtaPeriodFor('2099-07-01').period).toBe('2099-00');
  });
});

describe('verification and listing helpers', () => {
  it('"Verified by" only for verified rows', () => {
    expect(verifiedByText(OVERRIDE, 'Sam Smith')).toBe('Verified by Sam Smith on 2026-09-01');
    expect(verifiedByText(MINE)).toBeUndefined();
  });
  it('sorting, known groups and segment edits', () => {
    expect(sortRates([MINE, OVERRIDE, { ...KB_ROW, group: 'M1' }]).map((r) => r.group)).toEqual(['M1', 'PV2', 'S1']);
    expect(knownGroups([MINE, OVERRIDE, KB_ROW])).toEqual(['PV2', 'S1']);
    expect(segmentGroupError('m1')).toBeUndefined();
    expect(segmentGroupError('medium')).toMatch(/S1, M, M1/);
    expect(segmentChanged({ segment: 'city', label: 'City car', group: 'S1', origin: 'kb' }, 's1')).toBe(false);
    expect(segmentChanged({ segment: 'city', label: 'City car', group: 'S1', origin: 'kb' }, 'S2')).toBe(true);
  });
});

describe('hire totals take the merged rates (useGtaRates)', () => {
  const hire: HireAgreement = {
    id: 'h1',
    claimId: 'c1',
    agreementNumber: 'CCG-H-000001',
    fleetUnitId: 'u1',
    startAt: '2026-09-01T10:00:00Z',
    endAt: '2026-09-11T10:00:00Z',
    gtaGroup: 'S1',
    dailyRatePence: 5000,
    vatRate: 0.2,
    excessPence: 0,
    additionalDrivers: [],
    enforceability: { cca60fCompliant: true }
  };
  it('uses your rate for the benchmark line when given, the built-in table otherwise, none for an empty list', () => {
    const mine: GtaRate = { ...kbS1, dailyRatePence: 4500, verification: { status: 'verified', sourceUrl: 'https://example.org/rates.pdf' } };
    const withRates = hireTotals(hire, '2026-10-04T10:00:00Z', [mine]);
    expect(withRates?.benchmark?.gtaDailyRatePence).toBe(4500);
    expect(withRates?.benchmark?.verification.status).toBe('verified');
    const builtIn = hireTotals(hire, '2026-10-04T10:00:00Z');
    expect(builtIn?.benchmark?.gtaDailyRatePence).toBe(4232);
    expect(hireTotals(hire, '2026-10-04T10:00:00Z', [])?.benchmark).toBeUndefined();
    expect(withRates?.hirePence).toBe(builtIn?.hirePence);
  });
});
