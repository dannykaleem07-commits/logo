// owned by casework
/**
 * Settlement figures for `quantum_settlement` and `offer.analyse` (docs/SUPREME-DESIGN.md §B.4, §C.1, §D.1): code
 * computes every number — the ledger position, `settlementArithmetic` / `expectedValue` from @ccguk/domain (money.md
 * §4 and §1), the GTA benchmark for the hire group (a benchmark only: CCGUK is not a GTA subscriber) and the PAV on
 * file. Probabilities that code cannot know are stated as assumptions the owner can change; the model only cites.
 */
import { expectedValue, formatGBP, gtaRate, settlementArithmetic, type ExpectedValueResult, type SettlementResult } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { loadBundle } from '../services/claimView.js';
import { gtaRatesFor } from '../services/kb.js';
import { offerFigures } from './caseBrief.js';

export interface FigureRow {
  label: string;
  /** Case Brief fact id when the figure is one (cite it as {{fact:<id>}}). */
  factId: string | null;
  pence: number | null;
  note?: string;
}

export interface SettlementFigures {
  claimId: string;
  head: string;
  offerId: string | null;
  offerPence: number | null;
  perDay: boolean;
  position: { claimedPence: number; paidPence: number; outstandingPence: number };
  assumptions: { costsIncurredPence: number; pBetter: number; expectedBetterPence: number; extraCostPence: number; delayMonths: number; pWorse: number; worsePence: number; note: string };
  settlement: SettlementResult | null;
  expectedValue: ExpectedValueResult | null;
  gtaBenchmark: { group: string; dailyRatePence: number; note: string } | null;
  hireDailyRatePence: number | null;
  pavPence: number | null;
  figures: FigureRow[];
}

/** Default assumptions (owner can change them on the offer screen; they are labelled as assumptions everywhere). */
export const DEFAULT_ASSUMPTIONS = { pBetter: 0.6, pWorse: 0.1, delayMonths: 3, loadedHourlyPence: 3_500, hoursToFight: 6 } as const;

export function settlementFigures(ctx: AppContext, input: { claimId: string; offerId?: string | null; offerPence?: number | null; head?: string | null }): SettlementFigures {
  const bundle = loadBundle(ctx, input.claimId);
  // the settlement-offer register first (§D.9), then the intervention register (a per-day hire offer)
  const settlementOffer = input.offerId ? (bundle.settlementOffers ?? []).find((o) => o.id === input.offerId) : undefined;
  const interventionOffer = input.offerId && !settlementOffer ? bundle.offers.find((o) => o.id === input.offerId) : undefined;
  const offer = settlementOffer ?? interventionOffer;
  if (input.offerId && !offer) throw Object.assign(new Error(`Offer ${input.offerId} is not on this claim`), { code: 'WRONG_CLAIM' });
  const of: { head: string; amountPence: number | null; perDay: boolean } | undefined = settlementOffer
    ? { head: settlementOffer.head, amountPence: settlementOffer.amountPence, perDay: false }
    : interventionOffer
      ? offerFigures(interventionOffer)
      : undefined;
  const head = input.head ?? of?.head ?? 'hire';
  const perDay = Boolean(of?.perDay && input.offerPence == null);
  const offerPence = input.offerPence ?? of?.amountPence ?? null;
  const position = ctx.repos.ledgerPosition(ctx.db, input.claimId);
  // a whole-claim ('global') offer is measured against the claim totals
  const hp = head === 'global' ? position.totals : position.heads.find((h) => h.head === head);
  const pos = { claimedPence: hp?.claimedPence ?? 0, paidPence: hp?.paidPence ?? 0, outstandingPence: hp?.outstandingPence ?? 0 };
  const hires = [...bundle.hire].sort((a, b) => a.startAt.localeCompare(b.startAt));
  const hire = hires[hires.length - 1];
  const group = hire?.gtaGroup ?? bundle.vehicle.gtaGroup;
  const bench = group ? gtaRate(group, ctx.now(), gtaRatesFor(ctx)) : undefined;
  const pavPence = bundle.pav?.medianPence ?? null;

  const extraCostPence = DEFAULT_ASSUMPTIONS.hoursToFight * DEFAULT_ASSUMPTIONS.loadedHourlyPence;
  const expectedBetterPence = pos.outstandingPence;
  const assumptions = {
    costsIncurredPence: 0,
    pBetter: DEFAULT_ASSUMPTIONS.pBetter,
    expectedBetterPence,
    extraCostPence,
    delayMonths: DEFAULT_ASSUMPTIONS.delayMonths,
    pWorse: DEFAULT_ASSUMPTIONS.pWorse,
    worsePence: offerPence ?? 0,
    note: `Assumptions, not facts: ${Math.round(DEFAULT_ASSUMPTIONS.pBetter * 100)}% chance of recovering the outstanding ${head} figure by fighting on, ${DEFAULT_ASSUMPTIONS.delayMonths} months' delay, ${DEFAULT_ASSUMPTIONS.hoursToFight} hours at ${formatGBP(DEFAULT_ASSUMPTIONS.loadedHourlyPence)}, ${Math.round(DEFAULT_ASSUMPTIONS.pWorse * 100)}% chance of losing the offer.`,
  };
  let settlement: SettlementResult | null = null;
  let ev: ExpectedValueResult | null = null;
  if (offerPence !== null && !perDay) {
    settlement = settlementArithmetic({ offerPence, ...assumptions });
    ev = expectedValue({ pWin: assumptions.pBetter, recoveryPence: expectedBetterPence, ourRate: 1, fixedFeesPence: 0, hours: DEFAULT_ASSUMPTIONS.hoursToFight, loadedHourlyPence: DEFAULT_ASSUMPTIONS.loadedHourlyPence, disbursementsPence: 0, pComplaint: 0, refundPence: 0 });
  }
  const offerFact = offer ? `offer.${offer.id}.amountPence` : null;
  const figures: FigureRow[] = [
    { label: perDay ? 'Offer (per day)' : 'Offer', factId: offerFact, pence: offerPence },
    { label: `Claimed (${head})`, factId: head === 'global' ? null : `ledger.${head}.claimedPence`, pence: pos.claimedPence },
    { label: `Paid (${head})`, factId: head === 'global' ? null : `ledger.${head}.paidPence`, pence: pos.paidPence },
    { label: `Outstanding (${head})`, factId: head === 'global' ? null : `ledger.${head}.outstandingPence`, pence: pos.outstandingPence },
    ...(offerPence !== null && !perDay ? [{ label: 'Shortfall against outstanding', factId: null, pence: pos.outstandingPence - offerPence }] : []),
    ...(settlement
      ? [
          { label: 'Accept now (net)', factId: null, pence: settlement.acceptNowPence, note: 'settlementArithmetic' },
          { label: 'Fight on (net, expected)', factId: null, pence: settlement.fightOnPence, note: 'settlementArithmetic — on the stated assumptions' },
          { label: 'Walk-away number', factId: null, pence: settlement.walkAwayPence, note: 'accept any offer at or above it' },
        ]
      : []),
    ...(hire ? [{ label: 'Hire daily rate charged', factId: 'hire.current.dailyRatePence', pence: hire.dailyRatePence }] : []),
    ...(bench && group ? [{ label: `GTA benchmark daily rate (group ${group})`, factId: null, pence: bench.dailyRatePence, note: 'industry benchmark only — CCGUK is not a GTA subscriber' }] : []),
    ...(pavPence !== null ? [{ label: 'Pre-accident value (PAV, median of comparables)', factId: null, pence: pavPence }] : []),
  ];
  return {
    claimId: input.claimId,
    head,
    offerId: offer?.id ?? null,
    offerPence,
    perDay,
    position: pos,
    assumptions,
    settlement,
    expectedValue: ev,
    gtaBenchmark: bench && group ? { group, dailyRatePence: bench.dailyRatePence, note: 'industry benchmark only — CCGUK is not a GTA subscriber' } : null,
    hireDailyRatePence: hire?.dailyRatePence ?? null,
    pavPence,
    figures,
  };
}
