// owned by ap-clash
/**
 * Eligibility service (docs/SUPREME-AUTOPILOT.md §F.7): loads driver profiles, hire needs and criteria for a claim and
 * runs the pure assessments; records them (append-only `eligibility_assessments`) when an input changes.
 *
 * Criteria: the policy of the claim's car (its live reservation's fleet unit, else an open hire's) when the policy has
 * its own `driver_criteria`, else the Settings default (Settings > Fleet > Driver criteria) — generic UK hire-insurer
 * norms the owner must check against the real policy wording. A driver the insurer accepted in writing (recorded by the
 * eligibility_review resolver with the evidence id, after the profile last changed) is `eligible`.
 */
import { createHash } from 'node:crypto';
import {
  assessDriver,
  assessMeans,
  assessNeed,
  assessRoadworthiness,
  londonDate,
  summariseEligibility,
  type ClaimBundle,
  type DriverCriteria,
  type DriverEligibility,
  type EligibilityAssessmentKind,
  type EligibilitySummary,
  type HireNeeds,
  type Id,
  type InsurancePolicy,
} from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { loadBundle, gatesFor } from '../services/claimView.js';
import { autopilotSettingsOf, insurerAcceptance } from '../clash/service.js';
import { createNeedsYou } from '../agent/core.js';

const LIVE = ['held', 'confirmed', 'on_hire'] as const;

export interface DriverContext {
  claimId: Id;
  /** Main driver first, then additional drivers. */
  partyIds: Id[];
  policy?: InsurancePolicy;
  criteria: DriverCriteria;
  criteriaSource: 'policy' | 'settings_default';
  /** The day the drivers are assessed at: the booking start, else today. */
  at: string;
  reservationId?: Id;
}

/** Which drivers, which policy, which criteria and which date apply to the claim now. */
export function driverContext(ctx: AppContext, claimId: Id): DriverContext | undefined {
  const claim = ctx.repos.getClaim(ctx.db, claimId);
  if (!claim) return undefined;
  const settings = autopilotSettingsOf(ctx);
  const reservation = ctx.repos.listReservations(ctx.db, { claimId, status: [...LIVE] })[0];
  const hire = ctx.repos.listHire(ctx.db, claimId).find((h) => !h.endAt);
  const unitId = reservation?.fleetUnitId ?? hire?.fleetUnitId;
  const unit = unitId ? ctx.repos.getFleetUnit(ctx.db, unitId) : undefined;
  const policy = unit?.policyId ? ctx.repos.getPolicy(ctx.db, unit.policyId) : undefined;
  const main = reservation?.hirerPartyId ?? hire?.hirerPartyId ?? claim.driverId ?? claim.claimantId;
  const extra = reservation?.driverPartyIds ?? hire?.driverPartyIds ?? hire?.additionalDrivers.map((d) => d.partyId) ?? [];
  const partyIds = Array.from(new Set([main, ...extra].filter(Boolean)));
  const start = reservation?.startAt ?? hire?.startAt;
  const at = start && Date.parse(start) > Date.parse(ctx.now()) ? londonDate(start) : londonDate(ctx.now());
  return {
    claimId,
    partyIds,
    ...(policy ? { policy } : {}),
    criteria: policy?.driverCriteria ?? settings.eligibility.defaultCriteria,
    criteriaSource: policy?.driverCriteria ? 'policy' : 'settings_default',
    at,
    ...(reservation ? { reservationId: reservation.id } : {}),
  };
}

function assessOne(ctx: AppContext, dc: DriverContext, partyId: Id): DriverEligibility {
  const party = ctx.repos.getParty(ctx.db, partyId);
  const profile = ctx.repos.getDriverProfile(ctx.db, partyId);
  const e = assessDriver(profile, party ?? { name: '' }, dc.criteria, dc.at);
  const out: DriverEligibility = { ...e, partyId, criteriaSource: dc.criteriaSource, ...(dc.policy ? { policyId: dc.policy.id } : {}) };
  if (out.outcome === 'refer') {
    const accepted = insurerAcceptance(ctx, dc.claimId, partyId, profile?.updatedAt);
    if (accepted) {
      out.outcome = 'eligible';
      out.reasons = [...out.reasons, { code: 'INSURER_ACCEPTED', outcome: 'eligible', message: `The fleet insurer accepted this driver in writing (evidence ${accepted.evidenceId}, recorded by ${accepted.by}).` }];
    }
  }
  return out;
}

const unknownDriver = (partyId: string, dc?: DriverContext): DriverEligibility => ({
  partyId,
  outcome: 'unknown',
  reasons: [],
  missing: ['driver details'],
  criteriaSource: dc?.criteriaSource ?? 'settings_default',
  automaticOnly: false,
});

/** The claim's drivers (main driver first) with their eligibility. */
export function driversFor(ctx: AppContext, claimId: string): DriverEligibility[] {
  const dc = driverContext(ctx, claimId);
  if (!dc) return [];
  return dc.partyIds.map((p) => assessOne(ctx, dc, p));
}

function needsOf(ctx: AppContext, claimId: Id): HireNeeds | null {
  try {
    return ctx.repos.getHireNeeds(ctx.db, claimId)?.needs ?? null;
  } catch {
    return null;
  }
}

export function eligibilityFor(ctx: AppContext, claimId: string, bundle?: ClaimBundle): EligibilitySummary {
  const settings = autopilotSettingsOf(ctx);
  const dc = driverContext(ctx, claimId);
  const [driver = unknownDriver('', dc), ...additionalDrivers] = driversFor(ctx, claimId);
  const b = bundle ?? loadBundle(ctx, claimId);
  const needs = needsOf(ctx, claimId);
  const need = assessNeed(needs, b, driver);
  const means = assessMeans(b, gatesFor(b));
  const roadworthiness = assessRoadworthiness(b, needs);
  const injury = { referralNeeded: b.claim.accident?.injuries === true, referred: !!b.claim.injuryReferral };
  return summariseEligibility({ driver, additionalDrivers, need, means, roadworthiness, injury, requireMeansBeforeOffer: settings.eligibility.requireMeansBeforeOffer });
}

const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/**
 * Record the current assessment (`eligibility_assess`): one row per kind whose inputs changed since the last row of
 * that kind (driver rows per party). Returns the summary and the kinds written.
 */
export function recordEligibility(ctx: AppContext, claimId: Id, createdBy: string): { summary: EligibilitySummary; written: Array<{ kind: EligibilityAssessmentKind; partyId?: Id; outcome: string }> } {
  const bundle = loadBundle(ctx, claimId);
  const summary = eligibilityFor(ctx, claimId, bundle);
  const dc = driverContext(ctx, claimId);
  const written: Array<{ kind: EligibilityAssessmentKind; partyId?: Id; outcome: string }> = [];
  const at = ctx.now();
  const write = (kind: EligibilityAssessmentKind, outcome: string, reasons: unknown, inputs: unknown, partyId?: Id): void => {
    const inputsSha256 = sha({ inputs, outcome, reasons });
    const last = ctx.repos.latestEligibilityAssessment(ctx.db, claimId, kind, partyId);
    if (last && last.inputsSha256 === inputsSha256) return;
    ctx.repos.appendEligibilityAssessment(ctx.db, { claimId, kind, outcome, reasons, inputsSha256, createdBy, createdAt: at, ...(partyId ? { partyId } : {}), ...(dc?.policy ? { policyId: dc.policy.id } : {}) });
    written.push({ kind, outcome, ...(partyId ? { partyId } : {}) });
  };
  ctx.db.transaction(() => {
    for (const d of [summary.driver, ...summary.additionalDrivers]) {
      if (!d.partyId) continue;
      const profile = ctx.repos.getDriverProfile(ctx.db, d.partyId);
      if (d.reasons.some((r) => r.code === 'INSURER_ACCEPTED')) continue; // the acceptance row itself is the record
      write('driver', d.outcome, d.reasons, { profile: profile ?? null, criteria: dc?.criteria, at: dc?.at }, d.partyId);
    }
    write('need', summary.need.level, summary.need, { needs: needsOf(ctx, claimId) });
    write('means', summary.means.basis, summary.means, { means: summary.means });
    write('roadworthiness', summary.roadworthiness.hireFrom, summary.roadworthiness, { r: summary.roadworthiness });
    write('injury', summary.injury.referralNeeded && !summary.injury.referred ? 'not_referred' : summary.injury.referralNeeded ? 'referred' : 'none', summary.injury, summary.injury);
    write('overall', summary.overall, { green: summary.green, reasons: summary.reasons }, { summary });
  });
  raiseEligibilityReviews(ctx, claimId, summary, written, dc);
  return { summary, written };
}

/**
 * Needs-you `eligibility_review` (§H.3) for what the owner must decide: a driver who needs referral to the fleet
 * insurer, a weak need, or means not evidenced when Settings require them before an offer. Raised only when the
 * assessment row was newly written (an input changed); deduplicated per claim and subject.
 */
export function raiseEligibilityReviews(ctx: AppContext, claimId: Id, summary: EligibilitySummary, written: Array<{ kind: EligibilityAssessmentKind; partyId?: Id; outcome: string }>, dc?: DriverContext): void {
  const claim = ctx.repos.getClaim(ctx.db, claimId);
  if (!claim || ['declined', 'settled', 'closed'].includes(claim.status)) return;
  const options = [
    { id: 'insurer_accepted', label: 'The insurer accepted in writing', tone: 'primary' as const, requiresEdit: true },
    { id: 'request_info', label: 'Ask the client for more', tone: 'neutral' as const },
    { id: 'decline_hire', label: 'Decline hire', tone: 'danger' as const, requiresReason: true },
  ];
  const raise = (key: string, title: string, text: string, payload: Record<string, unknown>, opts = options): void => {
    try {
      createNeedsYou(ctx, { kind: 'eligibility_review', claimId, title, summary: text, payload: { claimId, ...payload, criteria: dc?.criteria ?? null, criteriaSource: dc?.criteriaSource ?? 'settings_default', policyId: dc?.policy?.id ?? null }, options: opts, priority: 'high', createdBy: 'agent:autopilot', dedupeKey: `eligibility_review:${claimId}:${key}` });
    } catch (err) {
      ctx.logger.warn('could not raise eligibility_review', { claimId, key, error: String(err) });
    }
  };
  for (const w of written) {
    if (w.kind === 'driver' && w.outcome === 'refer' && w.partyId) {
      const d = [summary.driver, ...summary.additionalDrivers].find((x) => x.partyId === w.partyId);
      const why = d?.reasons.filter((r) => r.outcome === 'refer').map((r) => r.message).join(' ') ?? '';
      raise(`driver:${w.partyId}`, `Driver needs referral to the fleet insurer (${claim.reference})`, `${why} Book only with the insurer's written acceptance.`, { partyId: w.partyId, outcome: 'refer', reasons: d?.reasons ?? [] });
    }
    if (w.kind === 'need' && w.outcome === 'weak')
      raise('need', `Weak need for a hire car (${claim.reference})`, `${summary.need.reasons.join(' ')} ${summary.need.mitigationRisks.join(' ')} The hire offer will ask you first.`.trim(), { subject: 'need', need: summary.need }, options.filter((o) => o.id !== 'insurer_accepted'));
  }
  if (autopilotSettingsOf(ctx).eligibility.requireMeansBeforeOffer && summary.means.basis !== 'impecunious' && written.some((w) => w.kind === 'means'))
    raise('means', `Means not evidenced before the offer (${claim.reference})`, summary.means.warning ?? 'Means are required before an offer.', { subject: 'means', means: summary.means }, options.filter((o) => o.id !== 'insurer_accepted'));
}

/** Record the case-acceptance assessment (kind 'acceptance'; reasons = the AcceptanceAssessment the clash detector reads). */
export function recordAcceptance(ctx: AppContext, claimId: Id, acceptance: { decision: string } & Record<string, unknown>, createdBy: string): void {
  const inputsSha256 = sha(acceptance);
  const last = ctx.repos.latestEligibilityAssessment(ctx.db, claimId, 'acceptance');
  if (last && last.inputsSha256 === inputsSha256) return;
  ctx.repos.appendEligibilityAssessment(ctx.db, { claimId, kind: 'acceptance', outcome: acceptance.decision, reasons: acceptance, inputsSha256, createdBy, createdAt: ctx.now() });
}
