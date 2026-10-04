import { describe, it, expect } from 'vitest';
import { checkDraft, extractAmounts, extractDeadlines, bannedPhraseCheck, type DraftContext } from './index.js';
import { chargeableDays } from './text.js';
import { greenBundle, fixtureClock, fixtureHire, fixtureStorage } from '../evidence/bundle.fixture.js';
import type { ClaimBundle, ConsistencyFlag } from '../types.js';

const DRAFT_AT = '2026-10-04T10:00:00Z';
function ctx(bundle: ClaimBundle, overrides: Partial<DraftContext> = {}): DraftContext {
  return { bundle, priorOutgoing: [], draftCreatedAt: DRAFT_AT, templateId: 'letter.chaser_7', ...overrides };
}
const of = (flags: ConsistencyFlag[], code: ConsistencyFlag['code']) => flags.filter((f) => f.code === code);

describe('PROBE', () => {
  it('P1 paid keyword loses to nearer "charges" → £1,287 case missed', () => {
    const r = checkDraft('You have paid the storage charges of £1,287.', ctx(greenBundle()));
    console.log('P1', r.flags.map((f) => [f.code, f.severity]));
    expect(of(r.flags, 'AMOUNT_PAID_MISMATCH')).toHaveLength(1);
  });
  it('P2 "offering" not recognised → false paid block', () => {
    const a = extractAmounts('We received your letter of 1 October 2026 offering £900 for the PAV.');
    console.log('P2', a);
    expect(a[0]!.context).toBe('offered');
  });
  it('P3 chargeable days across October clock change', () => {
    console.log('P3', chargeableDays('2026-10-20T09:00:00Z', '2026-10-30T10:00:00Z'));
    expect(chargeableDays('2026-10-20T09:00:00Z', '2026-10-30T10:00:00Z')).toBe(10);
  });
  it('P4 storage end in BST near midnight UTC', () => {
    const b = greenBundle();
    b.storage = [fixtureStorage({ startAt: '2026-06-24T14:00:00Z', endAt: '2026-06-30T23:30:00Z' })];
    const r = checkDraft('Storage ran from 24 June 2026 until 1 July 2026.', ctx(b));
    console.log('P4', r.flags.map((f) => f.message));
    expect(of(r.flags, 'STORAGE_END_MISMATCH')).toEqual([]);
  });
  it('P5 "has not made any offer of settlement" false block', () => {
    const r = checkDraft('You have not made any offer in respect of the pre-accident value.', ctx(greenBundle()));
    console.log('P5', r.flags.map((f) => f.code));
    expect(of(r.flags, 'OFFER_DENIED_BUT_LOGGED')).toEqual([]);
  });
  it('P6 chaser_7 deadline vs chaser_day_7 clock', () => {
    const b = greenBundle();
    b.clocks = [fixtureClock('chaser_day_7', '2026-10-01T09:00:00Z', '2026-10-08T17:00:00+01:00'), fixtureClock('chaser_day_14', '2026-10-01T09:00:00Z', '2026-10-15T17:00:00+01:00')];
    const r = checkDraft('Please remit within 7 days.', ctx(b, { templateId: 'letter.chaser_7', draftCreatedAt: '2026-10-08T10:00:00Z' }));
    console.log('P6', r.flags.map((f) => f.message));
    expect(r.flags).toEqual([]);
  });
  it('P7 deadline time formats', () => {
    const d = extractDeadlines('We require your response by 5:00pm on Friday 16 October 2026.');
    console.log('P7', d);
    expect(d).toHaveLength(1);
  });
  it('P8 hire 11 days inclusive accepted (inflation)', () => {
    const r = checkDraft('The vehicle was on hire for 11 days.', ctx(greenBundle()));
    console.log('P8', r.flags.map((f) => f.code));
    expect(of(r.flags, 'HIRE_PERIOD_MISMATCH')).toHaveLength(1);
  });
  it('P9 Solicitors Regulation Authority long form', () => {
    const f = bannedPhraseCheck('We are regulated by the Solicitors Regulation Authority.');
    console.log('P9', f);
    expect(f).toHaveLength(1);
  });
  it('P10 "+44 (0)7700" phone', () => {
    // in linkage probe
  });
  it('P11 hire wall clock Oct', () => {
    const b = greenBundle();
    b.hire = [fixtureHire({ startAt: '2026-10-20T09:00:00Z', deliveredAt: '2026-10-20T09:00:00Z', endAt: '2026-10-30T10:00:00Z', collectedAt: '2026-10-30T10:00:00Z' })];
    const r = checkDraft('The vehicle was on hire from 20 October 2026 to 30 October 2026 (10 days).', ctx(b, { draftCreatedAt: '2026-11-01T10:00:00Z' }));
    console.log('P11', r.flags.map((f) => f.message));
    expect(of(r.flags, 'HIRE_PERIOD_MISMATCH')).toEqual([]);
  });
});
