// owned by casework
/** The offer card never shows a recommendation that contradicts its own figures (settlementFigures). Invented data. */
import { describe, expect, it } from 'vitest';
import { checkRecommendation } from '../casework/offers.js';
import type { SettlementFigures } from '../casework/quantum.js';

const figures = (o: Partial<SettlementFigures> = {}): SettlementFigures =>
  ({
    claimId: 'c',
    head: 'pav',
    offerId: 'o',
    offerPence: 640_000,
    perDay: false,
    position: { claimedPence: 650_000, paidPence: 0, outstandingPence: 650_000 },
    assumptions: {} as SettlementFigures['assumptions'],
    settlement: { walkAwayPence: 293_530 } as SettlementFigures['settlement'],
    expectedValue: null,
    gtaBenchmark: null,
    hireDailyRatePence: null,
    pavPence: null,
    figures: [],
    ...o,
  }) as SettlementFigures;

describe('checkRecommendation', () => {
  it('a counter below the offer on another head is not shown, and the figures favouring acceptance are said', () => {
    const r = checkRecommendation({ recommendation: 'counter', counterPence: 120_000, basis: [{ kind: 'fact', id: 'ledger.hire.outstandingPence', label: null }] }, figures());
    expect(r.counterPence).toBeNull();
    expect(r.capConfidence).toBe(0.5);
    expect(r.dissent).toMatch(/figures favour accepting/);
    expect(r.warnings.join(' ')).toMatch(/not above the offer/);
    expect(r.warnings.join(' ')).toMatch(/ledger\.hire\.outstandingPence/);
  });

  it('a sensible counter on the same head passes untouched', () => {
    const r = checkRecommendation({ recommendation: 'counter', counterPence: 645_000, basis: [{ kind: 'fact', id: 'ledger.pav.outstandingPence', label: null }] }, figures({ settlement: { walkAwayPence: 642_000 } as SettlementFigures['settlement'] }));
    expect(r).toEqual({ counterPence: 645_000, warnings: [] });
  });

  it('a counter above the figure on file is refused; accepting an offer above walk-away is not challenged', () => {
    expect(checkRecommendation({ recommendation: 'counter', counterPence: 900_000, basis: [] }, figures({ settlement: { walkAwayPence: 700_000 } as SettlementFigures['settlement'] })).counterPence).toBeNull();
    expect(checkRecommendation({ recommendation: 'accept', counterPence: null, basis: [] }, figures())).toEqual({ counterPence: null, warnings: [] });
  });
});
