// owned by knowledge-learners
/**
 * L1 outcome statistics (docs/SUPREME-KNOWLEDGE-BUILDER.md §6.1): nearest-rank percentiles, minimum n = 3, insurer
 * profiles and step effectiveness ("followed by", never "caused"). STUB created by knowledge-core: the signatures
 * below are the contract; bodies throw NOT_IMPLEMENTED until knowledge-learners fills them.
 */
import { notImplemented } from './notImplemented.js';
import type { Dist, InsurerProfileData, StatFactData } from './types.js';
import type { HeadOfLoss, ISODateTime } from '../types.js';
import type { MailIntent } from '../agents/types.js';

/** One `claim_outcomes` row (claim × head), as the learner rebuilds it nightly. */
export interface ClaimOutcomeInput {
  claimId: string;
  head: HeadOfLoss;
  insurerSlug: string | null;
  claimTypes: string[];
  gtaSubscriber: boolean | null;
  claimedPence: number;
  firstOfferPence: number | null;
  paidPence: number;
  reducedPence: number;
  packSentAt: ISODateTime | null;
  firstPaidAt: ISODateTime | null;
  fullyPaidAt: ISODateTime | null;
  workingDaysToPay: number | null;
  chasersBeforePay: number;
  objections: MailIntent[];
  docsRequested: string[];
  steps: { step: string; at: ISODateTime }[];
  status: string;
}

/** Nearest-rank percentile (p in 0..100) of a non-empty list. */
export function percentileNearestRank(_values: readonly number[], _p: number): number {
  return notImplemented('knowledge-learners', 'percentileNearestRank');
}

/** median / p25 / p75 with n, or null when n < minN. */
export function distOf(_values: readonly number[], _minN: number): Dist | null {
  return notImplemented('knowledge-learners', 'distOf');
}

export function buildInsurerProfile(_insurerSlug: string, _rows: readonly ClaimOutcomeInput[], _opts: { window: '12m' | 'all'; minN: number; computedAt: ISODateTime }): InsurerProfileData {
  return notImplemented('knowledge-learners', 'buildInsurerProfile');
}

export function stepEffectiveness(_rows: readonly ClaimOutcomeInput[], _opts: { withinWorkingDays: number; minNPerInsurer: number; window: '12m' | 'all' }): StatFactData[] {
  return notImplemented('knowledge-learners', 'stepEffectiveness');
}
