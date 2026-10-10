// owned by ap-autopilot
/**
 * loadAutopilotFacts (docs/SUPREME-AUTOPILOT.md §A.4, §A.7 step 1): everything the pure planner reads, assembled from
 * the claim bundle and the Autopilot tables. The availability search (the one expensive part) runs only when the
 * plan says the hire search or the choice of car is due (`withAvailability`).
 */
import {
  mergeAutopilotSettings,
  planAutopilot,
  withHireNeedsDefaults,
  type AutopilotFacts,
  type AutopilotPlan,
  type AutopilotStepId,
  type ClaimBundle,
  type Clock,
  type MailIntent,
} from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { londonDayStart } from '../agent/core.js';
import { acceptanceFor, actionsFor, deriveClocksFor, gatesFor, loadBundle } from '../services/claimView.js';
import { eligibilityFor } from '../eligibility/service.js';
import { availabilityFor } from '../booking/service.js';
import { claimAutopilotFor } from './install.js';

const LIVE_JOB_STATUSES = ['queued', 'leased', 'waiting_usage', 'waiting_user'] as const;

export interface LoadFactsOptions {
  /** Run the availability search (only when hire.search / hire.choose may be due). */
  withAvailability?: boolean;
  forceStepId?: AutopilotStepId;
}

/** The claim bundle with derived clocks (the planner reads clock deadlines). */
export function bundleWithClocks(ctx: AppContext, claimId: string): ClaimBundle {
  const base = loadBundle(ctx, claimId);
  const clocks = deriveClocksFor(ctx, base).map((c, i) => ({ ...c, id: c.id ?? `derived-${i}`, claimId }) as Clock);
  return { ...base, clocks };
}

/** Basic first-notification completeness (the cold account, place, time, cars, contact). */
export function fnolCompleteness(bundle: ClaimBundle): { valid: boolean; missing: string[] } {
  const missing: string[] = [];
  const a = bundle.claim.accident;
  if (!a.occurredAt) missing.push('accident date and time');
  if (!a.location?.trim()) missing.push('accident location');
  if ((a.circumstances ?? '').trim().length < 10) missing.push("the client's own account of the accident");
  if (!bundle.vehicle.registration) missing.push("the client's registration");
  if (!bundle.claimant.email && !bundle.claimant.phone) missing.push("the client's email or phone");
  if (!bundle.thirdPartyVehicle?.registration && !bundle.atFaultInsurer) missing.push("the other driver's registration or insurer");
  return { valid: missing.length === 0, missing };
}

export function loadAutopilotFacts(ctx: AppContext, claimId: string, opts: LoadFactsOptions = {}): AutopilotFacts {
  const now = ctx.now();
  const settingsAll = ctx.repos.getAgentSettings(ctx.db);
  const settings = mergeAutopilotSettings(settingsAll.autopilot);
  const bundle = bundleWithClocks(ctx, claimId);
  const gates = gatesFor(bundle);
  let playbook: AutopilotFacts['playbook'] = [];
  try {
    playbook = actionsFor(ctx, bundle, gates);
  } catch (err) {
    ctx.logger.warn('autopilot: playbook failed', { claimId, error: String(err) });
  }
  let acceptance: AutopilotFacts['acceptance'] = null;
  try {
    acceptance = acceptanceFor(ctx, bundle, gates);
  } catch {
    acceptance = null;
  }
  const rec = ctx.repos.latestEligibilityAssessment(ctx.db, claimId, 'acceptance');
  const recReasons = (rec?.reasons ?? {}) as { conditions?: unknown };
  const recordedAcceptance = rec ? { decision: rec.outcome, conditions: Array.isArray(recReasons.conditions) ? (recReasons.conditions as string[]) : [], at: rec.createdAt } : null;
  const storedNeeds = ctx.repos.getHireNeeds(ctx.db, claimId);
  let eligibility: AutopilotFacts['eligibility'] = null;
  try {
    eligibility = eligibilityFor(ctx, claimId, bundle);
  } catch (err) {
    ctx.logger.warn('autopilot: eligibility failed', { claimId, error: String(err) });
  }
  const record = claimAutopilotFor(ctx, claimId);
  const reservations = ctx.repos.listReservations(ctx.db, { claimId });
  const outbox = ctx.repos.listOutbox(ctx.db, { claimId }).map((o) => ({
    id: o.id,
    kind: o.kind,
    status: o.status,
    autopilotStepId: o.autopilotStepId ?? null,
    createdAt: o.createdAt,
    sentAt: o.status === 'sent' ? o.updatedAt : null,
  }));
  const lastIn = ctx.repos.listMailMessages(ctx.db, { claimId, direction: 'in', limit: 1 })[0];
  const lastInbound = lastIn ? { at: lastIn.receivedAt, intent: (ctx.repos.latestMailClassification(ctx.db, lastIn.id)?.intent ?? 'other') as MailIntent, messageId: lastIn.id } : null;
  const bounced = ctx.repos
    .listMailMessages(ctx.db, { claimId, direction: 'in', limit: 50 })
    .some((m) => ctx.repos.latestMailClassification(ctx.db, m.id)?.intent === 'bounce' && Date.parse(m.receivedAt) > Date.parse(now) - 30 * 86_400_000);
  const statusAudit = ctx.repos.listAudit(ctx.db, { entityId: claimId, action: 'claim.status' }).filter((a) => !a.userId.startsWith('agent:') && a.userId !== 'system');
  const lastPersonStatusAt = statusAudit.map((a) => a.at).sort().pop() ?? null;
  const facts: AutopilotFacts = {
    now,
    bundle,
    acceptance,
    recordedAcceptance,
    gates,
    playbook,
    needs: storedNeeds ? withHireNeedsDefaults(storedNeeds.needs) : null,
    eligibility,
    reservations,
    hireOffers: ctx.repos.listHireOffers(ctx.db, { claimId }),
    movements: ctx.repos.listMovements(ctx.db, { claimId }),
    packs: ctx.repos.listDocumentPacks(ctx.db, { claimId }),
    signatures: ctx.repos.listSignatureRequests(ctx.db, { claimId }),
    clashes: ctx.repos.listClashFindings(ctx.db, { claimId, status: 'open' }),
    availability: null,
    outbox,
    openNeedsYou: ctx.repos.listNeedsYou(ctx.db, { claimId, status: ['open', 'snoozed'], limit: 500 }).map((n) => ({ id: n.id, kind: n.kind, dedupeKey: n.dedupeKey ?? null })),
    openJobs: ctx.repos.listAgentJobs(ctx.db, { claimId, status: [...LIVE_JOB_STATUSES], limit: 500 }).map((j) => ({ id: j.id, type: j.type, idempotencyKey: j.idempotencyKey ?? null, status: j.status })),
    settlementOffers: ctx.repos.listSettlementOffers(ctx.db, claimId),
    lastInbound,
    claimAutopilot: { mode: record.mode, overrides: record.stepOverrides },
    agentPaused: ctx.repos.getClaimAgentState(ctx.db, claimId).paused,
    settings,
    fnol: fnolCompleteness(bundle),
    clientEmail: { onFile: Boolean(bundle.claimant.email), bounced },
    autoOffersToday: ctx.repos.countAutoOffersSince(ctx.db, londonDayStart(now)),
    lastPersonStatusAt,
    lastRun: ctx.repos.lastAutopilotActions(ctx.db, claimId) as AutopilotFacts['lastRun'],
    ownerChosenReservationIds: [
      ...new Set([
        ...reservations.filter((r) => !r.createdBy.startsWith('agent:') && r.createdBy !== 'system' && r.source !== 'backfill').map((r) => r.id),
        ...ctx.repos.listAutopilotLog(ctx.db, { claimId, action: 'owner_choice' }).map((e) => e.refs.reservationId).filter((x): x is string => Boolean(x)),
      ]),
    ],
    ...(opts.forceStepId ? { forceStepId: opts.forceStepId } : {}),
  };
  if (opts.withAvailability) facts.availability = searchFor(ctx, facts);
  return facts;
}

/** The availability search for the claim (projected period, the claim's own needs and drivers). */
function searchFor(ctx: AppContext, f: AutopilotFacts): AutopilotFacts['availability'] {
  try {
    const { projection: _p, needs: _n, claimId: _c, ...result } = availabilityFor(ctx, { claimId: f.bundle.claim.id, limit: 10 });
    return result;
  } catch (err) {
    ctx.logger.warn('autopilot: availability search failed', { claimId: f.bundle.claim.id, error: String(err) });
    return null;
  }
}

/**
 * Facts + plan: plan once; when the hire search or the choice is due (or waiting on the owner's choice), run the
 * availability search and plan again with it.
 */
export function evaluate(ctx: AppContext, claimId: string, opts: { forceStepId?: AutopilotStepId } = {}): { facts: AutopilotFacts; plan: AutopilotPlan } {
  let facts = loadAutopilotFacts(ctx, claimId, opts);
  let plan = planAutopilot(facts);
  const needsSearch = plan.steps.some((s) => (s.id === 'hire.search' || s.id === 'hire.choose') && ['due', 'paused', 'waiting', 'blocked'].includes(s.status));
  if (needsSearch) {
    facts = { ...facts, availability: searchFor(ctx, facts) };
    plan = planAutopilot(facts);
  }
  return { facts, plan };
}
