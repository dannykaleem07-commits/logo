// owned by ap-autopilot
/** Autopilot catalogue, predicates, planner and offer helpers (docs/SUPREME-AUTOPILOT.md §A, §D, §J.1). */
import { describe, expect, it } from 'vitest';
import { AUTOPILOT_PRINCIPAL_TOOLS } from '../agents/types.js';
import { CLASH_CODES } from '../clash/types.js';
import { playbookRuleCodes } from '../playbook/rules.js';
import { PACK_PREDICATE_IDS } from '../signing/packs.js';
import { day0Bundle, event, T0, claim as claimFx, hire as hireFx, ledger as ledgerFx } from '../playbook/fixture.js';
import type { AvailabilityCandidate, AvailabilityResult, Reservation } from '../booking/types.js';
import type { EligibilitySummary } from '../eligibility/types.js';
import type { ClaimBundle } from '../types.js';
import { DEFAULT_AUTOPILOT_SETTINGS, STEP_FLOORS } from './settings.js';
import { AUTOPILOT_STEP_IDS, STEP_MODE_RANK, type AutopilotStepId, type HireOffer, type HireOfferTerms } from './types.js';
import { STEP_CATALOGUE } from './steps.js';
import { DATE_FACTS, PREDICATES, REQUIREMENTS, headsResolved, statusTarget } from './predicates.js';
import { diffPlans, planAutopilot, trimPlan } from './plan.js';
import type { AutopilotFacts } from './facts.js';
import { buildBookingUpdateEmail, buildHireOfferEmail, firstReplyLine, hireOfferChecks, hireOfferTermsSha256, INTERVENTION_SENTENCE, parseHireReplyCode } from './offers.js';

const NOW = '2026-09-21T10:00:00.000Z';

function eligibility(extra: Partial<EligibilitySummary> = {}): EligibilitySummary {
  return {
    overall: 'eligible',
    driver: { partyId: 'p-claimant', outcome: 'eligible', reasons: [], missing: [], criteriaSource: 'settings_default', automaticOnly: true },
    additionalDrivers: [],
    need: { level: 'strong', reasons: ['needs a car for work'], missing: [], mitigationRisks: [], automaticOnly: true, use: 'credit_hire' },
    means: { basis: 'not_impecunious', readiness: 'none', missing: [], warning: null },
    roadworthiness: { driveable: false, hireFrom: 'now', repairStartAt: null, clientCarOnAccidentDate: { mot: 'valid', tax: 'valid' }, warnings: [] },
    injury: { referralNeeded: false, referred: false },
    green: true,
    reasons: [],
    ...extra,
  };
}

function candidate(id: string, reg: string, score: number, extra: Partial<AvailabilityCandidate> = {}): AvailabilityCandidate {
  return {
    fleetUnitId: id,
    registration: reg,
    label: 'Ford Focus 1.0 auto, 5 seats, petrol (C2)',
    score,
    factors: {} as never,
    likeForLike: { score: 0.95, group: { client: 'C2', car: 'C2', relation: 'same', clientRatePence: 5000, carRatePence: 5000 }, parts: { group: 1, body: 1, seats: 1, transmission: 1, fuel: 1 }, sentence: 'Same hire group as your own car (C2), automatic, 5 seats.' },
    pricing: {} as never,
    readyBy: NOW,
    marginDays: 200,
    lapses: [],
    warnings: [],
    driverOutcome: 'eligible',
    ...extra,
  };
}

function availability(ranked: AvailabilityCandidate[]): AvailabilityResult {
  return { period: { startAt: NOW, expectedEndAt: '2026-10-05T10:00:00.000Z' }, use: 'credit_hire', ranked, excluded: [], clearWinner: true, green: true, explanation: [] };
}

function reservation(extra: Partial<Reservation> = {}): Reservation {
  return {
    id: 'res-1', fleetUnitId: 'unit-a', claimId: 'claim-1', status: 'held', use: 'credit_hire', startAt: NOW, expectedEndAt: '2026-10-05T10:00:00.000Z',
    holdExpiresAt: '2026-09-22T10:00:00.000Z', hirerPartyId: 'p-claimant', driverPartyIds: ['p-claimant'], dailyRatePence: 5000, gtaGroup: 'C2', source: 'autopilot',
    createdBy: 'agent:autopilot', createdAt: NOW, updatedAt: NOW, ranking: candidate('unit-a', 'AB12 CDE', 90), ...extra,
  };
}

const terms: HireOfferTerms = {
  reservationId: 'res-1', fleetUnitId: 'unit-a', registration: 'AB12 CDE', makeModel: 'Ford Focus', transmission: 'automatic', seats: 5, fuel: 'petrol', gtaGroup: 'C2', clientGtaGroup: 'C2',
  likeForLike: 'Same hire group as your own car (C2).', startAt: NOW, expectedEndAt: '2026-10-05T10:00:00.000Z', delivery: null, expiresAt: '2026-09-22T10:00:00.000Z', alternatives: [],
};

function offer(extra: Partial<HireOffer> = {}): HireOffer {
  return { id: 'offer-1', claimId: 'claim-1', reservationId: 'res-1', status: 'sent', channel: 'email', terms, termsSha256: hireOfferTermsSha256(terms), authorisedBy: 'autopilot_green', sentAt: NOW, expiresAt: '2026-09-22T10:00:00.000Z', createdBy: 'agent:autopilot', createdAt: NOW, updatedAt: NOW, ...extra };
}

/** A claim accepted, client eligible with a strong need, nothing booked yet. */
function facts(extra: Partial<AutopilotFacts> = {}, bundleExtra: Partial<ClaimBundle> = {}): AutopilotFacts {
  const bundle = day0Bundle({ claim: claimFx({ status: 'accepted', liability: 'admitted' }), events: [event('fnol', T0)], ...bundleExtra });
  bundle.claimant = { ...bundle.claimant, email: 'client@example.test' };
  return {
    now: NOW,
    bundle,
    acceptance: null,
    recordedAcceptance: { decision: 'accept', conditions: [], at: NOW },
    gates: [],
    playbook: [],
    needs: { neededFrom: null, deliveryAddress: null, deliveryPostcode: null, seatsMin: null, automaticOnly: true, automaticPreferred: true, towbar: false, wheelchairAccessible: false, handControls: false, isofixCount: 0, evOk: null, phvWork: false, largeBoot: false, occupation: 'nurse', journeys: 'work', dependants: null, otherVehicles: 'none', ownInsurerCourtesyCar: 'not_offered', clientCoverType: 'comprehensive', clientWantsHire: true, notes: null, source: {} },
    eligibility: eligibility(),
    reservations: [],
    hireOffers: [],
    movements: [],
    packs: [],
    signatures: [],
    clashes: [],
    availability: null,
    outbox: [{ id: 'o-ack', kind: 'ack', status: 'sent', autopilotStepId: 'intake.acknowledge', createdAt: NOW, sentAt: NOW }],
    openNeedsYou: [],
    openJobs: [],
    settlementOffers: [],
    lastInbound: null,
    claimAutopilot: { mode: 'on', overrides: {} },
    agentPaused: false,
    settings: DEFAULT_AUTOPILOT_SETTINGS,
    fnol: { valid: true, missing: [] },
    clientEmail: { onFile: true, bounced: false },
    autoOffersToday: 0,
    lastPersonStatusAt: null,
    lastRun: { 'intake.cross_file': NOW },
    ownerChosenReservationIds: [],
    ...extra,
  };
}

const step = (plan: ReturnType<typeof planAutopilot>, id: AutopilotStepId) => plan.steps.find((s) => s.id === id)!;

describe('step catalogue integrity', () => {
  it('has the 46 steps in catalogue order with floors equal to STEP_FLOORS and defaults at or above them', () => {
    expect(STEP_CATALOGUE.map((s) => s.id)).toEqual([...AUTOPILOT_STEP_IDS]);
    for (const s of STEP_CATALOGUE) {
      expect(s.floor, s.id).toBe(STEP_FLOORS[s.id]);
      expect(STEP_MODE_RANK[s.defaultMode], s.id).toBeGreaterThanOrEqual(STEP_MODE_RANK[s.floor]);
      expect(s.basis.length, s.id).toBeGreaterThan(0);
    }
  });

  it('references only existing predicates, requirements, date facts, clash codes, steps, tools and playbook codes', () => {
    const ids = new Set<string>(AUTOPILOT_STEP_IDS);
    for (const s of STEP_CATALOGUE) {
      for (const p of [s.appliesWhen, s.doneWhen, ...s.readyWhen, ...(s.waitingOn ? [s.waitingOn.when] : [])]) expect(PREDICATES[p], `${s.id} → ${p}`).toBeTypeOf('function');
      for (const r of s.requires) expect(REQUIREMENTS[r], `${s.id} → ${r}`).toBeDefined();
      if (s.deadline?.fromFact) expect(DATE_FACTS[s.deadline.fromFact], `${s.id} → ${s.deadline.fromFact}`).toBeTypeOf('function');
      for (const c of s.blockingClashes) expect(CLASH_CODES, s.id).toContain(c);
      for (const a of s.after) {
        expect(ids.has(a), `${s.id} after ${a}`).toBe(true);
        expect(AUTOPILOT_STEP_IDS.indexOf(a), `${s.id} after ${a} (catalogue order)`).toBeLessThan(AUTOPILOT_STEP_IDS.indexOf(s.id));
      }
      if (s.actionCode) expect(playbookRuleCodes, `${s.id} → ${s.actionCode}`).toContain(s.actionCode);
      if (s.action.kind === 'draft') expect(playbookRuleCodes, `${s.id} → ${s.action.actionCode}`).toContain(s.action.actionCode);
      if (s.action.kind === 'tool') expect(AUTOPILOT_PRINCIPAL_TOOLS, `${s.id} → ${s.action.tool}`).toContain(s.action.tool);
    }
  });

  it('evaluates every pack predicate of §D.6 and adds the 15 Autopilot playbook codes', () => {
    for (const p of PACK_PREDICATE_IDS) expect(PREDICATES[p], p).toBeTypeOf('function');
    for (const c of ['OFFER_HIRE', 'CONFIRM_BOOKING', 'SCHEDULE_DELIVERY', 'PREPARE_HIRE_PACK', 'SIGNUP_PACK', 'CHASE_SIGNATURES', 'NOTIFY_HIRE_START', 'INSTRUCT_ENGINEER', 'ARRANGE_RECOVERY', 'BOOK_COLLECTION', 'RAISE_INVOICES', 'PAY_CLIENT', 'CLOSE_FILE', 'CHECK_NEED', 'DRIVER_ELIGIBILITY']) {
      expect(playbookRuleCodes).toContain(c);
    }
  });
});

describe('planAutopilot', () => {
  it('a claim with no acceptance recorded is in qualification with qualify.acceptance due (automatic)', () => {
    const plan = planAutopilot(facts({ recordedAcceptance: null }, { claim: claimFx({ status: 'fnol' }) }));
    expect(plan.stage).toBe('qualification');
    expect(plan.due).toContain('qualify.acceptance');
    expect(step(plan, 'qualify.acceptance').mode).toBe('auto');
    expect(step(plan, 'hire.search').status).toBe('upcoming');
    expect(step(plan, 'intake.new_claim').status).toBe('done');
    expect(plan.version).toBe('autopilot/1');
  });

  it('an accepted, eligible, strong-need claim with no car yet is in hire_search and the search is due and green', () => {
    const f = facts({ availability: availability([candidate('unit-a', 'AB12 CDE', 90), candidate('unit-c', 'CD34 EFG', 70)]) });
    const plan = planAutopilot(f);
    expect(plan.stage).toBe('sign_up');
    expect(plan.due).toContain('hire.search');
    const search = step(plan, 'hire.search');
    expect(search.mode).toBe('auto');
    expect(search.options?.[0]).toMatchObject({ id: 'unit:unit-a', recommended: true });
    expect(step(plan, 'hire.choose').green).toBe(true);
    expect(step(plan, 'signup.pack').status).toBe('due');
    expect(step(plan, 'signup.pack').mode).toBe('confirm');
    expect(step(plan, 'signup.pack').modeReasons.join(' ')).toMatch(/Agreements and forms always need you/);
  });

  it('green gating raises a step to Ask me with the reasons (driver referral, weak need, not green car)', () => {
    const refer = eligibility({ driver: { partyId: 'p-claimant', outcome: 'refer', reasons: [{ code: 'AGE', outcome: 'refer', message: 'Age 23' }], missing: [], criteriaSource: 'settings_default', automaticOnly: false }, need: { level: 'weak', reasons: [], missing: [], mitigationRisks: [], automaticOnly: false, use: 'credit_hire' } });
    const plan = planAutopilot(facts({ eligibility: refer }));
    expect(step(plan, 'qualify.driver').mode).toBe('confirm');
    expect(step(plan, 'qualify.driver').modeReasons.join(' ')).toMatch(/Not green/);
    expect(step(plan, 'qualify.need').mode).toBe('confirm');
    const notGreen = planAutopilot(facts({ availability: availability([candidate('unit-c', 'CD34 EFG', 70, { likeForLike: { ...candidate('x', 'x', 1).likeForLike, score: 0.5 } })]) }));
    expect(step(notGreen, 'hire.choose').green).toBe(false);
    expect(step(notGreen, 'hire.choose').mode).toBe('confirm');
  });

  it('overrides: skip, done, snooze, ask; auto never goes below the floor', () => {
    const at = NOW;
    const plan = planAutopilot(
      facts({
        claimAutopilot: {
          mode: 'on',
          overrides: {
            'intake.cctv': { action: 'skip', reason: 'no cameras', by: 'u1', at },
            'qualify.need': { action: 'done', reason: 'spoke to client', by: 'u1', at },
            'hire.search': { action: 'snooze', until: '2026-09-23T10:00:00.000Z', reason: 'client away', by: 'u1', at },
            'qualify.acceptance': { action: 'ask', reason: 'tricky', by: 'u1', at },
            'signup.pack': { action: 'auto', reason: 'please', by: 'u1', at },
          },
        },
        playbook: [{ code: 'REQUEST_CCTV', title: 'CCTV', why: 'x', basis: [], priority: 'today' }],
      }),
    );
    expect(step(plan, 'intake.cctv').status).toBe('skipped');
    expect(step(plan, 'qualify.need').status).toBe('done');
    expect(step(plan, 'hire.search')).toMatchObject({ status: 'waiting', waitingOn: 'time' });
    expect(step(plan, 'qualify.acceptance').mode).toBe('confirm');
    expect(step(plan, 'signup.pack').mode).toBe('confirm');
  });

  it('pausing the claim turns due steps into paused (still listed with their deadlines)', () => {
    const plan = planAutopilot(facts({ claimAutopilot: { mode: 'paused', overrides: {} } }));
    expect(plan.due).toEqual([]);
    expect(plan.steps.some((s) => s.status === 'paused')).toBe(true);
    expect(plan.mode).toBe('paused');
    const sd = planAutopilot(facts({ agentPaused: true }));
    expect(sd.due).toEqual([]);
  });

  it('a held car with an offer sent waits on the client; a reply after the offer makes the acceptance due', () => {
    const f = facts({ reservations: [reservation()], hireOffers: [offer()] });
    const plan = planAutopilot(f);
    expect(plan.stage).toBe('sign_up');
    expect(step(plan, 'hire.offer').status).toBe('done');
    expect(step(plan, 'hire.acceptance')).toMatchObject({ status: 'waiting', waitingOn: 'client' });
    expect(step(plan, 'hire.acceptance').refs.hireOfferId).toBe('offer-1');
    const replied = planAutopilot({ ...f, lastInbound: { at: '2026-09-21T11:00:00.000Z', intent: 'client_message', messageId: 'm1' }, now: '2026-09-21T11:05:00.000Z' });
    expect(replied.due).toContain('hire.acceptance');
    const accepted = planAutopilot({ ...f, hireOffers: [offer({ status: 'accepted' })] });
    expect(accepted.due).toContain('hire.confirm');
  });

  it('a confirmed booking makes delivery and the hire-start pack due; the pack step asks the owner', () => {
    const plan = planAutopilot(facts({ reservations: [reservation({ status: 'confirmed', agreementNumber: 'CCG-H-000001' })], hireOffers: [offer({ status: 'accepted' })] }));
    expect(plan.due).toEqual(expect.arrayContaining(['hire.delivery', 'hire.pack']));
    expect(step(plan, 'hire.pack').mode).toBe('confirm');
    expect(step(plan, 'hire.handover').status).toBe('upcoming');
  });

  it('blocks on missing requirements and on open block clashes', () => {
    const plan = planAutopilot(facts({ eligibility: eligibility({ driver: { partyId: 'p', outcome: 'unknown', reasons: [], missing: ['date of birth'], criteriaSource: 'settings_default', automaticOnly: false } }) }));
    expect(step(plan, 'qualify.driver')).toMatchObject({ status: 'blocked' });
    expect(step(plan, 'qualify.driver').blockedBy[0]!.kind).toBe('requirement');
    const clash = planAutopilot(
      facts({ availability: availability([candidate('unit-a', 'AB12 CDE', 90)]), clashes: [{ code: 'SAME_REG_ON_HIRE', severity: 'block', overrideClass: 'A', message: 'The client’s registration is already on another hire', related: { claimIds: [], reservationIds: [], hireIds: [], fleetUnitIds: [], partyIds: [] }, dedupeKey: 'k' }] }),
    );
    expect(step(clash, 'hire.search')).toMatchObject({ status: 'blocked' });
    expect(step(clash, 'hire.search').blockedBy[0]).toMatchObject({ kind: 'clash', code: 'SAME_REG_ON_HIRE' });
  });

  it('an open Needs-you item or job for the step shows it in progress / waiting on the owner', () => {
    const plan = planAutopilot(
      facts({
        availability: availability([candidate('unit-a', 'AB12 CDE', 90)]),
        openNeedsYou: [{ id: 'ny1', kind: 'choose_car', dedupeKey: 'autopilot:claim-1:hire.choose:1' }],
        openJobs: [{ id: 'j1', type: 'pack.prepare', idempotencyKey: 'pack.prepare:claim-1:signup:-:0', status: 'queued' }],
      }),
    );
    expect(step(plan, 'hire.search')).toMatchObject({ status: 'waiting', waitingOn: 'owner' });
    expect(step(plan, 'signup.pack').status).toBe('in_progress');
    expect(step(plan, 'signup.pack').refs.jobId).toBe('j1');
  });

  it('the plan hash is identical for identical facts and changes with any fact', () => {
    const a = planAutopilot(facts());
    const b = planAutopilot(facts());
    expect(a.planHash).toBe(b.planHash);
    expect(a.planHash).toMatch(/^[0-9a-f]{64}$/);
    const c = planAutopilot(facts({ reservations: [reservation()] }));
    expect(c.planHash).not.toBe(a.planHash);
  });

  it('reports a done step that is no longer done as reopened', () => {
    const before = planAutopilot(facts({ packs: [{ id: 'pk', claimId: 'claim-1', stage: 'signup', items: [], status: 'approved', createdBy: 'x', createdAt: NOW, updatedAt: NOW }] }));
    expect(step(before, 'signup.pack').status).toBe('done');
    const after = planAutopilot(facts({ packs: [{ id: 'pk', claimId: 'claim-1', stage: 'signup', items: [], status: 'superseded', createdBy: 'x', createdAt: NOW, updatedAt: NOW }] }));
    const t = diffPlans(before, after).filter((x) => x.stepId === 'signup.pack');
    expect(t[0]).toMatchObject({ from: 'done', to: 'reopened' });
    expect(t[1]!.to).toBe(after.steps.find((s) => s.id === 'signup.pack')!.status);
  });

  it('follows the stages through hire, billing, recovery and terminal states', () => {
    const onHire = planAutopilot(facts({ reservations: [reservation({ status: 'on_hire' })] }, { hire: [hireFx({ startAt: NOW, endAt: undefined })], events: [event('fnol', T0), event('services_agreed', T0), event('ncaf_sent', T0)] }));
    expect(['handover', 'on_hire', 'sign_up', 'vehicle_secured']).toContain(onHire.stage);
    expect(onHire.steps.find((s) => s.id === 'hire.monitor')!.status).not.toBe('not_applicable');
    expect(planAutopilot(facts({}, { claim: claimFx({ status: 'declined' }) })).stage).toBe('declined');
    expect(planAutopilot(facts({}, { claim: claimFx({ status: 'litigation' }) })).stage).toBe('legal');
    const closed = planAutopilot(facts({}, { claim: claimFx({ status: 'closed' }) }));
    expect(closed.stage).toBe('closed');
    expect(closed.due).toEqual([]);
  });

  it('trimPlan gives the brief its due / waiting / blocked lists', () => {
    const t = trimPlan(planAutopilot(facts()));
    expect(t.due.length).toBeGreaterThan(0);
    expect(t.due[0]).toHaveProperty('title');
  });
});

describe('status sync and closure readiness', () => {
  it('moves the status forward with the stage, never backwards, and a person wins for 24 hours', () => {
    const f = { ...facts({}, { claim: claimFx({ status: 'fnol' }) }), stage: 'hire_search' as const };
    expect(statusTarget(f)).toBe('accepted');
    expect(statusTarget({ ...f, lastPersonStatusAt: '2026-09-21T09:30:00.000Z' })).toBeNull();
    expect(statusTarget({ ...facts({}, { claim: claimFx({ status: 'chasing' }) }), stage: 'qualification' as const })).toBeNull();
    expect(statusTarget({ ...facts({}, { claim: claimFx({ status: 'disputed' }) }), stage: 'billing' as const })).toBeNull();
  });

  it('heads resolved: every claimed head paid or written off', () => {
    expect(headsResolved(facts())).toBe(false);
    expect(headsResolved(facts({}, { ledger: ledgerFx([{ head: 'hire', kind: 'claimed', amountPence: 1000 }, { head: 'hire', kind: 'paid', amountPence: 1000 }]) }))).toBe(true);
    expect(headsResolved(facts({}, { ledger: ledgerFx([{ head: 'hire', kind: 'claimed', amountPence: 1000 }, { head: 'hire', kind: 'paid', amountPence: 600 }]) }))).toBe(false);
    expect(headsResolved(facts({}, { ledger: ledgerFx([{ head: 'hire', kind: 'claimed', amountPence: 1000 }, { head: 'hire', kind: 'written_off', amountPence: 400 }]) }))).toBe(true);
  });
});

describe('hire offers', () => {
  it('the terms hash is stable and changes with any term', () => {
    expect(hireOfferTermsSha256(terms)).toBe(hireOfferTermsSha256({ ...terms }));
    expect(hireOfferTermsSha256({ ...terms, registration: 'ZZ99 ZZZ' })).not.toBe(hireOfferTermsSha256(terms));
  });

  it('the offer email uses placeholders, the neutral intervention sentence, YES to reply and no free / rate wording', () => {
    const e = buildHireOfferEmail({ salutationName: 'Ms Example', delivery: true });
    expect(e.bodyText).toContain(INTERVENTION_SENTENCE);
    expect(e.bodyText).toContain('reply YES');
    expect(e.bodyText).toContain('{{fact:booking.unit.registration}}');
    expect(e.bodyText).toContain('Claims Team, Courtesy Cars Group UK Ltd');
    expect(e.bodyText.replace(INTERVENTION_SENTENCE, '').replace(/\{\{[^}]+\}\}/g, 'x')).not.toMatch(/\bfree\b|£|\bper day\b|\baccept\b|\bfault\b|\boffer\b/i);
    const resolved = e.bodyText.replace(/\{\{fact:booking\.unit\.registration\}\}/g, 'AB12 CDE').replace(/\{\{fact:[^}]+\}\}/g, 'x');
    expect(hireOfferChecks(resolved, terms)).toEqual([]);
    expect(buildBookingUpdateEmail({ salutationName: 'Ms Example', kind: 'delivery' }).bodyText.replace(/\{\{[^}]+\}\}/g, 'x')).not.toMatch(/\bfree\b|£|\baccept\b|\boffer\b/i);
  });

  it('offer checks catch free wording, the script guard, a wrong registration or date and a stated rate', () => {
    const codes = (t: string) => hireOfferChecks(t, terms).map((i) => `${i.code}:${i.severity}`);
    expect(codes('Car AB12 CDE is free of charge.')).toContain('HIRE_OFFER_FREE_WORDING:block');
    expect(codes('Car AB12 CDE is a free car for you.')).toContain('HIRE_OFFER_FREE_WORDING:block');
    expect(codes(`Car AB12 CDE. ${INTERVENTION_SENTENCE}`)).toEqual([]);
    expect(codes('Car AB12 CDE. You should decline their offer of a car.')).toContain('HIRE_OFFER_INTERVENTION_GUARD:block');
    expect(codes('Car XY99 ZZZ for you.')).toContain('HIRE_OFFER_TERMS_MISMATCH:block');
    expect(codes('Car AB12 CDE from 30 September 2026.')).toContain('HIRE_OFFER_TERMS_MISMATCH:block');
    expect(codes('Car AB12 CDE from 21 September 2026.')).toEqual([]);
    expect(codes('Car AB12 CDE at £49.80 per day.')).toContain('HIRE_OFFER_RATE_STATED:warn');
  });

  it('reads a clear yes / no from the first own line only', () => {
    expect(parseHireReplyCode('Yes please!\n\n> On Monday the Claims Team wrote:\n> ...')).toMatchObject({ decision: 'accept', confidence: 0.95 });
    expect(parseHireReplyCode('no thanks, my partner will lend me theirs')).toMatchObject({ decision: 'decline' });
    expect(parseHireReplyCode('\n> quoted\nOK that is fine')).toMatchObject({ decision: 'accept' });
    expect(parseHireReplyCode('Can it be a bigger car? yes otherwise')).toBeNull();
    expect(parseHireReplyCode('On Mon, 21 Sep 2026 the Claims Team wrote:\n> yes')).toBeNull();
    expect(firstReplyLine('\n\n  Hello  \n')).toBe('Hello');
  });
});
