/**
 * Hire pricing guide (docs/V03-MANAGER-MODE-HIRE-PRICING.md §B). When a fleet car is chosen for a hire, show its own
 * daily rate next to the GTA guide for the car we give and the GTA guide for the client's accident-damaged car (like
 * for like), so the agreed rate can be decided with both in view.
 *
 * "Higher group" is decided by comparing benchmark DAILY RATES, never group codes: S/M/F/CP codes do not order across
 * families. GTA rates are a benchmark only — CCGUK is not a GTA subscriber — so every guide carries that note. The
 * verification status of a rate is reported as it is and never upgraded. Pure: no I/O.
 */
import type { GtaRate, ISODate, Pence, Verification } from '../types.js';
import { formatGBP } from '../money.js';
import { GTA_NON_SUBSCRIBER_NOTE, gtaRate } from './rates.js';
import { noBenchmarkRateReason } from './suggest.js';

export type ClientGroupSource = 'recorded' | 'manual' | 'suggested' | 'none';

export interface PricingGuideLine {
  group: string | null;
  dailyRatePence: Pence | null;
  period?: string;
  verification?: Verification['status'];
  /** Why there is no rate (no group, or noBenchmarkRateReason()). */
  missingReason?: string;
}

export interface PricingSuggestion {
  id: 'fleet' | 'hire_guide' | 'like_for_like';
  label: string;
  dailyRatePence: Pence;
}

export interface HirePricingGuide {
  date: ISODate;
  fleetDailyRatePence: Pence;
  /** GTA guide for the car we give (the fleet car's group). */
  hireCar: PricingGuideLine;
  /** GTA guide for the client's accident-damaged car (like for like). */
  clientCar: PricingGuideLine & { source: ClientGroupSource };
  /** hireCar − clientCar guide, null when either is missing. */
  differencePerDayPence: Pence | null;
  /** True when the car we give has a higher benchmark rate than the client's car (rates compared, never codes). */
  higherGroup: boolean;
  /** Fleet rate − client's guide (positive = above like for like), null without a client guide. */
  fleetAboveLikeForLikePence: Pence | null;
  /** Plain-English sentences, most important first. */
  notices: string[];
  suggestions: PricingSuggestion[];
  /** GTA_NON_SUBSCRIBER_NOTE. */
  note: string;
}

export interface HirePricingGuideInput {
  date: ISODate;
  fleetDailyRatePence: Pence;
  hireGroup: string;
  clientGroup: string | null;
  clientGroupSource: ClientGroupSource;
  rates: GtaRate[];
}

export const PRICING_SUGGESTION_LABELS = {
  fleet: 'Fleet rate',
  hire_guide: 'Car we give — guide',
  like_for_like: "Client's car — guide (like for like)",
} as const satisfies Record<PricingSuggestion['id'], string>;

/** Sentence shown when the client's car has no GTA group. */
export const CLIENT_GROUP_MISSING = "The client's car has no GTA group yet — choose one to see the like-for-like guide.";
/** Sentence shown when the fleet car has no GTA group. */
export const HIRE_GROUP_MISSING = 'The fleet car has no GTA group — set one on the fleet unit to see its guide.';

const UNGROUPED = 'UNGROUPED';

function normaliseGroup(group: string | null | undefined): string | null {
  if (typeof group !== 'string') return null;
  const g = group.trim().toUpperCase();
  return g.length ? g : null;
}

function guideLine(group: string | null, date: ISODate, rates: GtaRate[], noGroupReason: string): { line: PricingGuideLine; rate?: GtaRate } {
  if (!group) return { line: { group: null, dailyRatePence: null, missingReason: noGroupReason } };
  const rate = group === UNGROUPED ? undefined : gtaRate(group, date, rates);
  if (!rate) return { line: { group, dailyRatePence: null, missingReason: noBenchmarkRateReason(group, date) } };
  return { line: { group, dailyRatePence: rate.dailyRatePence, period: rate.period, verification: rate.verification.status }, rate };
}

const perDay = (p: Pence): string => `${formatGBP(p)}/day`;

export function hirePricingGuide(input: HirePricingGuideInput): HirePricingGuide {
  const { date, fleetDailyRatePence: fleet, rates } = input;
  const hireGroup = normaliseGroup(input.hireGroup);
  const clientGroup = normaliseGroup(input.clientGroup);

  const hire = guideLine(hireGroup, date, rates, HIRE_GROUP_MISSING);
  const client = guideLine(clientGroup, date, rates, CLIENT_GROUP_MISSING);
  const hireRate = hire.line.dailyRatePence;
  const clientRate = client.line.dailyRatePence;

  const differencePerDayPence = hireRate !== null && clientRate !== null ? hireRate - clientRate : null;
  const higherGroup = differencePerDayPence !== null && differencePerDayPence > 0;
  const fleetAboveLikeForLikePence = clientRate !== null ? fleet - clientRate : null;

  const notices: string[] = [];
  if (differencePerDayPence !== null && hireRate !== null && clientRate !== null) {
    if (differencePerDayPence > 0) {
      notices.push(
        `Higher group than the damaged car: the car you are giving (${hireGroup}, ${perDay(hireRate)} guide) is in a higher group than the client's damaged car (${clientGroup}, ${perDay(clientRate)} guide). Like-for-like guide ${perDay(clientRate)}; difference ${perDay(differencePerDayPence)}.`,
      );
    } else if (differencePerDayPence < 0) {
      notices.push(
        `Lower group than the damaged car: the car you are giving (${hireGroup}, ${perDay(hireRate)} guide) is in a lower group than the client's damaged car (${clientGroup}, ${perDay(clientRate)} guide). Like-for-like guide ${perDay(clientRate)}; difference ${perDay(-differencePerDayPence)} below it.`,
      );
    }
  }
  if (fleetAboveLikeForLikePence !== null && fleetAboveLikeForLikePence > 0) {
    notices.push(`Your fleet rate ${perDay(fleet)} is ${perDay(fleetAboveLikeForLikePence)} above the like-for-like guide.`);
  }
  for (const line of [hire.line, client.line]) {
    if (line.missingReason && !notices.includes(line.missingReason)) notices.push(line.missingReason);
  }
  const seen = new Set<string>();
  for (const r of [hire.rate, client.rate]) {
    if (!r || r.verification.status === 'verified') continue;
    const key = `${r.group.toUpperCase()}|${r.period}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notices.push(`The guide rate for group ${r.group.toUpperCase()} (period ${r.period}) is ${r.verification.status}.`);
  }

  const suggestions: PricingSuggestion[] = [{ id: 'fleet', label: PRICING_SUGGESTION_LABELS.fleet, dailyRatePence: fleet }];
  if (hireRate !== null) suggestions.push({ id: 'hire_guide', label: PRICING_SUGGESTION_LABELS.hire_guide, dailyRatePence: hireRate });
  if (clientRate !== null) suggestions.push({ id: 'like_for_like', label: PRICING_SUGGESTION_LABELS.like_for_like, dailyRatePence: clientRate });

  return {
    date,
    fleetDailyRatePence: fleet,
    hireCar: hire.line,
    clientCar: { ...client.line, source: clientGroup ? input.clientGroupSource : 'none' },
    differencePerDayPence,
    higherGroup,
    fleetAboveLikeForLikePence,
    notices,
    suggestions,
    note: GTA_NON_SUBSCRIBER_NOTE,
  };
}
