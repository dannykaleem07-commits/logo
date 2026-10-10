// owned by ap-clash
/**
 * Overall eligibility (docs/SUPREME-AUTOPILOT.md §F.7) — pure. Combines the drivers, need, means, roadworthiness and
 * injury into one summary used by the availability filter, the green test, the qualify.* steps, clash codes 26–27 and
 * the handover guard.
 */
import { worstOutcome } from './driver.js';
import { ELIGIBILITY_OUTCOME_RANK, type DriverEligibility, type EligibilityOutcome, type EligibilitySummary, type MeansAssessment, type NeedAssessment, type RoadworthinessAssessment } from './types.js';

export interface SummariseInput {
  driver: DriverEligibility;
  additionalDrivers: DriverEligibility[];
  need: NeedAssessment;
  means: MeansAssessment;
  roadworthiness: RoadworthinessAssessment;
  injury: { referralNeeded: boolean; referred: boolean };
  requireMeansBeforeOffer: boolean;
}

const atLeast = (o: EligibilityOutcome, floor: EligibilityOutcome): EligibilityOutcome => (ELIGIBILITY_OUTCOME_RANK[o] >= ELIGIBILITY_OUTCOME_RANK[floor] ? o : floor);

export function summariseEligibility(i: SummariseInput): EligibilitySummary {
  const reasons: string[] = [];
  const drivers = [i.driver, ...i.additionalDrivers];
  let overall = worstOutcome(drivers.map((d) => d.outcome));
  drivers.forEach((d, n) => {
    const who = n === 0 ? 'Main driver' : `Additional driver ${n}`;
    if (d.outcome === 'eligible') return;
    const why = d.reasons.filter((r) => r.outcome === d.outcome).map((r) => r.message);
    if (d.outcome === 'unknown') reasons.push(`${who}: missing ${d.missing.join(', ') || 'details'}.`);
    else reasons.push(`${who} ${d.outcome === 'refer' ? 'needs referral to the insurer' : 'is not eligible'}: ${why.join(' ')}`);
  });
  if (i.need.level === 'none') {
    overall = 'ineligible';
    reasons.push('The client does not need a car.');
  } else if (i.need.level === 'unknown') {
    overall = atLeast(overall, 'unknown');
    reasons.push(`Need not established: ${i.need.missing.join(', ') || 'ask the client'}.`);
  } else if (i.need.level === 'weak') {
    reasons.push('Need is weak: hire may be challenged (mitigation).');
  }
  if (i.requireMeansBeforeOffer && i.means.basis !== 'impecunious') {
    overall = atLeast(overall, 'unknown');
    reasons.push('Means are required before an offer and are not evidenced yet.');
  } else if (i.means.warning) reasons.push(i.means.warning);
  for (const w of i.roadworthiness.warnings) reasons.push(w);
  if (i.injury.referralNeeded && !i.injury.referred) reasons.push('Personal injury on file and not referred (never blocks hire; no referral fee — LASPO 2012 ss.56–60).');
  const green = overall === 'eligible' && (i.need.level === 'strong' || i.need.level === 'moderate') && (!i.requireMeansBeforeOffer || i.means.basis === 'impecunious');
  return { overall, driver: i.driver, additionalDrivers: i.additionalDrivers, need: i.need, means: i.means, roadworthiness: i.roadworthiness, injury: i.injury, green, reasons };
}
