// owned by ap-booking
/**
 * The "green" test (docs/SUPREME-AUTOPILOT.md §D.1). Pure. Every failure is a plain-English reason for the owner's
 * card. A step is green only when all six hold:
 *
 *  1 top candidate like-for-like ≥ settings.green.minLikeForLike (0.8) and not above the client's group;
 *  2 every hard need met (availability filter) and no green-blocking warn finding;
 *  3 acceptance `accept`, or `accept_with_conditions` with every condition met;
 *  4 driver(s) `eligible` against this car's policy (a `refer` is never green);
 *  5 need strong or moderate; no intervention offer unanswered; the client wants hire;
 *  6 client email on file and not bounced; the claim is not paused; the daily auto-offer cap is not reached.
 *
 * `candidateGreen` checks 1, 2 and 4 (what the availability search knows about a car); `greenTest` adds the claim-level
 * facts (3, 5, 6) the autopilot assembles.
 */
import type { ClashFinding } from '../clash/types.js';
import { GREEN_BLOCKING_CLASH_CODES } from '../clash/catalogue.js';
import type { AvailabilityCandidate } from './types.js';

/** §C.2 warn codes marked "green-blocking" in the clash catalogue: they stop the autopilot acting alone (→ confirm). */
export const GREEN_BLOCKING_WARN_CODES: readonly string[] = GREEN_BLOCKING_CLASH_CODES;

export const DEFAULT_MIN_LIKE_FOR_LIKE = 0.8;

export interface GreenResult {
  green: boolean;
  reasons: string[];
}

/** Criteria 1, 2 (warn findings) and 4 for one candidate. `acknowledged` lists finding dedupe keys a person has read. */
export function candidateGreen(c: Pick<AvailabilityCandidate, 'likeForLike' | 'warnings' | 'driverOutcome' | 'registration'>, opts: { minLikeForLike?: number; extraFindings?: readonly ClashFinding[]; acknowledged?: readonly string[] } = {}): GreenResult {
  const min = opts.minLikeForLike ?? DEFAULT_MIN_LIKE_FOR_LIKE;
  const reasons: string[] = [];
  if (c.likeForLike.score < min) reasons.push(`Like-for-like match ${c.likeForLike.score.toFixed(2)} is below ${min.toFixed(2)}.`);
  if (c.likeForLike.group.relation === 'higher') reasons.push(`${c.registration} is in a higher hire group than the client's car — only the like-for-like rate is recoverable.`);
  const ack = new Set(opts.acknowledged ?? []);
  const findings = [...c.warnings, ...(opts.extraFindings ?? [])];
  for (const f of findings) {
    if (f.severity === 'block') reasons.push(f.message);
    else if (f.severity === 'warn' && GREEN_BLOCKING_WARN_CODES.includes(f.code) && !ack.has(f.dedupeKey) && !reasons.includes(f.message)) reasons.push(f.message);
  }
  if (c.driverOutcome === 'refer') reasons.push('The driver needs a referral to the insurer — never booked without the owner.');
  else if (c.driverOutcome === 'ineligible') reasons.push('The driver is not eligible to drive this car.');
  else if (c.driverOutcome === 'unknown') reasons.push('Driver eligibility is not known yet.');
  return { green: reasons.length === 0, reasons };
}

export interface GreenInput {
  candidate: Pick<AvailabilityCandidate, 'likeForLike' | 'warnings' | 'driverOutcome' | 'registration'> | null;
  minLikeForLike?: number;
  /** Other open findings on the claim/booking (green-blocking warns and blocks count). */
  findings?: readonly ClashFinding[];
  acknowledged?: readonly string[];
  acceptance: { decision: 'accept' | 'accept_with_conditions' | 'decline' | 'refer' | string | null; conditionsMet: boolean };
  need: 'strong' | 'moderate' | 'weak' | 'none' | 'unknown';
  interventionUnanswered: boolean;
  clientWantsHire: boolean | null;
  clientEmail: { onFile: boolean; bounced: boolean };
  claimPaused: boolean;
  autoOffersToday: number;
  maxAutoOffersPerDay: number;
}

export function greenTest(input: GreenInput): GreenResult {
  const reasons: string[] = [];
  if (!input.candidate) reasons.push('No car is available to offer.');
  else reasons.push(...candidateGreen(input.candidate, { minLikeForLike: input.minLikeForLike, extraFindings: input.findings, acknowledged: input.acknowledged }).reasons);
  const a = input.acceptance;
  if (a.decision !== 'accept' && !(a.decision === 'accept_with_conditions' && a.conditionsMet)) {
    reasons.push(a.decision === 'accept_with_conditions' ? 'The claim was accepted with conditions that are not met yet.' : a.decision ? `The acceptance decision is "${a.decision.replace(/_/g, ' ')}".` : 'The claim has not been accepted yet.');
  }
  if (input.need !== 'strong' && input.need !== 'moderate') reasons.push(input.need === 'unknown' ? "The client's need for a car is not established yet." : `The client's need for a car is ${input.need}.`);
  if (input.interventionUnanswered) reasons.push("An insurer's intervention offer has not been answered in writing.");
  if (input.clientWantsHire !== true) reasons.push(input.clientWantsHire === false ? 'The client does not want a hire car.' : 'The client has not said they want a hire car.');
  if (!input.clientEmail.onFile) reasons.push("There is no email address for the client.");
  else if (input.clientEmail.bounced) reasons.push("The client's email address has bounced.");
  if (input.claimPaused) reasons.push('The autopilot is paused on this claim.');
  if (input.autoOffersToday >= input.maxAutoOffersPerDay) reasons.push(`Today's limit of ${input.maxAutoOffersPerDay} automatic offers has been reached.`);
  const unique = [...new Set(reasons)];
  return { green: unique.length === 0, reasons: unique };
}
