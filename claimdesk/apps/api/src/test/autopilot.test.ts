// owned by ap-autopilot
/**
 * Autopilot API (docs/SUPREME-AUTOPILOT.md §A.7, §D, §H, §J.2): the deterministic booking path driven job by job with
 * the fake AI driver and the fake mail transports — plan → search → hold → offer email (code-built, reviewed,
 * commitment verified, held 10 minutes for Undo) → sent → client's "yes" read by code → booking confirmed → delivery
 * slot and confirmation email → hire-start pack queued. Plus pause / overrides, human-only routes, commitment
 * verification failures and the settlement-offer register.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Claim, FleetUnit } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { MONDAY, fleetCar, seedClaim } from './bookingFixtures.js';
import { drain, queued, run, runJob, setUpMail, TOUCHES_NONE } from './fixtures/mail/helpers.js';
import type { FakeSmtp } from '../mail/transport.js';
import { ensureAutopilotInstalled } from '../autopilot/install.js';
import { applyAutopilotCommitment } from '../autopilot/commitment.js';
import { mintRunToken, revokeRunToken } from '../agent/principal.js';
import { getJobHandler, getNeedsYouResolver } from '../agent/handlers/index.js';
import { getTool } from '../agent/tools/index.js';
import type { JobRecord } from '../agent/contracts.js';

const OWNER = { userId: 'courtesycars' };
const at = (base: string, min: number): string => new Date(Date.parse(base) + min * 60_000).toISOString();

let t: TestApp;
let smtp: FakeSmtp;
let accountId: string;

async function readyClaim(): Promise<Claim> {
  const claim = await seedClaim(t, { automaticOnly: true });
  const c = t.ctx.repos.requireClaim(t.ctx.db, claim.id);
  t.ctx.repos.updateParty(t.ctx.db, c.claimantId, { dateOfBirth: '1992-04-01' });
  const put = await t.api('PUT', `/parties/${c.claimantId}/driver-profile`, { licenceCountry: 'GB', licenceType: 'full', fullLicenceSince: '2014-01-01', restrictionCodes: ['78'], points: 3, endorsements: [{ code: 'SP30', offenceDate: '2024-03-01', points: 3 }], source: 'dvla_check', dvlaCheck: { checkedAt: t.ctx.now(), summary: 'Full licence, 3 points (SP30)' } });
  expect(put.status).toBe(200);
  await t.api('PUT', `/claims/${c.id}/hire-needs`, { otherVehicles: 'none', occupation: 'Nurse', journeys: 'Hospital shifts', clientWantsHire: true, automaticOnly: true });
  t.ctx.repos.appendEligibilityAssessment(t.ctx.db, { claimId: c.id, kind: 'acceptance', outcome: 'accept', reasons: { decision: 'accept', conditions: [] }, inputsSha256: randomUUID(), createdBy: 'test', createdAt: t.ctx.now() });
  // The acknowledgement already went to the client (so the offer is not a first contact).
  const client = t.ctx.repos.getParty(t.ctx.db, c.claimantId)!.email!;
  const prior = t.ctx.repos.createOutbox(t.ctx.db, { claimId: c.id, accountId, kind: 'ack', to: [client], subject: 'Thank you', bodyText: 'x', createdBy: 'courtesycars', now: t.ctx.now() });
  t.ctx.repos.transitionOutbox(t.ctx.db, prior.id, 'queued', 'courtesycars', 'approved', { now: t.ctx.now() });
  t.ctx.repos.transitionOutbox(t.ctx.db, prior.id, 'sending', 'agent:mail', 'smtp', { now: t.ctx.now() });
  t.ctx.repos.transitionOutbox(t.ctx.db, prior.id, 'sent', 'agent:mail', 'ok', { now: t.ctx.now() });
  return t.ctx.repos.requireClaim(t.ctx.db, c.id);
}

async function tick(claimId: string): Promise<{ acted: Array<{ stepId: string; action: string; ok: boolean; note?: string }>; stage: string; skipped?: string }> {
  const r = await run(t.ctx, 'autopilot.tick', { claimId }, { claimId });
  return r.outcome.result as never;
}

/** Run the review → after_review → release chain for whatever is queued. */
async function settleMail(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    const n = (await drain(t.ctx, 'review.check')).length + (await drain(t.ctx, 'outbox.after_review')).length;
    if (!n) break;
  }
}

async function releaseDue(): Promise<void> {
  for (const j of queued(t.ctx, 'outbox.release')) await runJob(t.ctx, j);
}

const plan = async (claimId: string) => (await t.api<{ plan: { stage: string; due: string[]; steps: Array<{ id: string; status: string; mode: string; modeReasons: string[]; green: boolean; next: string; refs: Record<string, unknown> }> } }>('GET', `/claims/${claimId}/autopilot`)).body.plan;

beforeAll(async () => {
  t = await createTestApp(MONDAY, { config: { aiDriverOverride: 'fake' } });
  ({ smtp, accountId } = await setUpMail(t.ctx));
  t.ctx.repos.patchAgentSettings(t.ctx.db, { ai: { driver: 'subscription_cli' }, agents: { enabled: true }, autonomy: { quietHours: null } }, OWNER);
  ensureAutopilotInstalled(t.ctx);
});
afterAll(async () => {
  await t.close();
});

describe('registries', () => {
  it('registers the four job handlers, the two resolvers and the five tools', () => {
    for (const type of ['autopilot.tick', 'autopilot.sweep', 'autopilot.judge', 'hire_offer.parse_reply'] as const) expect(getJobHandler(type), type).toBeTruthy();
    expect(getNeedsYouResolver('choose_car')).toBeTruthy();
    expect(getNeedsYouResolver('autopilot_step')).toBeTruthy();
    for (const n of ['autopilot_plan', 'hire_offers_list', 'hire_offer_prepare', 'hire_acceptance_record', 'claim_status_set']) expect(getTool(n), n).toBeTruthy();
  });
});

describe('the deterministic booking path (§D.1–§D.5)', () => {
  let claim: Claim;
  let A: FleetUnit;
  let B: FleetUnit;
  let C: FleetUnit;

  beforeAll(async () => {
    A = fleetCar(t, 'AP26 AAA', 'S1');
    B = fleetCar(t, 'AP26 BBB', 'S1', { transmission: 'manual' });
    C = fleetCar(t, 'AP26 CCC', 'M2', { bodyType: 'SUV', model: 'Kuga' }, { dailyRatePence: 7000 });
    claim = await readyClaim();
  });

  it('plans the claim: qualification done, the hire search due and green, the sign-up pack asks the owner', async () => {
    const p = await plan(claim.id);
    const step = (id: string) => p.steps.find((s) => s.id === id)!;
    expect(step('qualify.acceptance').status).toBe('done');
    expect(step('qualify.driver').status).toBe('done');
    expect(step('qualify.need').status).toBe('done');
    expect(p.due).toContain('hire.search');
    expect(step('hire.choose').green).toBe(true);
    expect(step('signup.pack').mode).toBe('confirm');
  });

  it('a tick holds the like-for-like automatic car (B excluded: manual) and drafts the offer bound to the hold', async () => {
    const r = await tick(claim.id);
    const r2 = r.acted.some((a) => a.action === 'tool:hire_offer_prepare') ? r : await tick(claim.id);
    expect(r.skipped).toBeUndefined();
    const res = t.ctx.repos.listReservations(t.ctx.db, { claimId: claim.id });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ fleetUnitId: A.id, status: 'held', createdBy: 'agent:autopilot' });
    expect(res.some((x) => x.fleetUnitId === B.id || x.fleetUnitId === C.id)).toBe(false);
    const holdAudit = t.ctx.repos.listAudit(t.ctx.db, { entityId: res[0]!.id, action: 'booking.hold' })[0]!;
    expect(holdAudit.userId).toBe('agent:autopilot');
    expect(holdAudit.runId).toBeTruthy();
    const offers = t.ctx.repos.listHireOffers(t.ctx.db, { claimId: claim.id });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ status: 'draft', reservationId: res[0]!.id, authorisedBy: 'autopilot_green' });
    const ob = t.ctx.repos.requireOutbox(t.ctx.db, offers[0]!.outboxId!);
    expect(ob).toMatchObject({ kind: 'hire_offer', autopilotStepId: 'hire.offer', status: 'reviewing' });
    expect(ob.bodyText).toContain('AP26 AAA');
    expect(ob.bodyText).toContain('reply YES');
    expect(ob.bodyText).not.toMatch(/\{\{fact:/);
    expect(ob.bodyText).not.toMatch(/\bfree of charge\b|£/);
    expect([...r.acted, ...r2.acted].map((a) => a.action)).toEqual(expect.arrayContaining(['tool:booking_hold', 'tool:hire_offer_prepare']));
  });

  it('the reviewer passes it, the commitment is verified and the policy holds it 10 minutes; then it goes', async () => {
    await settleMail();
    const offer = t.ctx.repos.listHireOffers(t.ctx.db, { claimId: claim.id })[0]!;
    const ob = t.ctx.repos.requireOutbox(t.ctx.db, offer.outboxId!);
    const review = t.ctx.repos.latestReviewFor(t.ctx.db, { kind: 'outbox', id: ob.id })!;
    expect(review.verdict).toBe('pass');
    expect(ob.status, JSON.stringify(ob.policy)).toBe('held');
    expect((ob.policy as { outcome: string }).outcome).toBe('auto_held');
    t.setNow(at(MONDAY, 11));
    await releaseDue();
    expect(t.ctx.repos.requireOutbox(t.ctx.db, ob.id).status).toBe('sent');
    expect(smtp.sent.at(-1)!.to).toEqual([t.ctx.repos.getParty(t.ctx.db, claim.claimantId)!.email]);
    await tick(claim.id);
    const sent = t.ctx.repos.getHireOffer(t.ctx.db, offer.id)!;
    expect(sent.status).toBe('sent');
    expect(t.ctx.repos.listEvents(t.ctx.db, claim.id, { type: 'hire_offered' })).toHaveLength(1);
    const p = await plan(claim.id);
    expect(p.steps.find((s) => s.id === 'hire.acceptance')).toMatchObject({ status: 'waiting' });
  });

  it('the client replies "Yes please" → read by code (0.95) → accepted → booking confirmed → delivery slot + confirmation email', async () => {
    const offer = t.ctx.repos.listHireOffers(t.ctx.db, { claimId: claim.id })[0]!;
    const ob = t.ctx.repos.requireOutbox(t.ctx.db, offer.outboxId!);
    const client = t.ctx.repos.getParty(t.ctx.db, claim.claimantId)!.email!;
    t.setNow(at(MONDAY, 40));
    t.ctx.repos.insertMailMessage(t.ctx.db, { accountId, direction: 'in', threadKey: 'thread-offer', fromAddr: client, to: ['claims@ccguk-test.example'], cc: [], subject: `Re: ${ob.subject}`, inReplyTo: ob.smtpMessageId ?? null, receivedAt: t.ctx.now(), rawEvidenceId: 'raw-1', rawSha256: randomUUID(), bodyText: 'Yes please, that is great.\n\n> On Monday the Claims Team wrote:\n> ...', claimId: claim.id, source: 'imap', status: 'matched', now: t.ctx.now() });
    const r = await tick(claim.id);
    expect(r.acted.map((a) => a.action)).toEqual(expect.arrayContaining(['tool:hire_acceptance_record', 'tool:booking_confirm']));
    expect(t.ctx.repos.getHireOffer(t.ctx.db, offer.id)!.status).toBe('accepted');
    const res = t.ctx.repos.listReservations(t.ctx.db, { claimId: claim.id }).find((x) => x.status === 'confirmed')!;
    expect(res.agreementNumber).toMatch(/^CCG-H-/);
    expect(t.ctx.repos.listEvents(t.ctx.db, claim.id, { type: 'hire_offer_accepted' })).toHaveLength(1);
    expect(t.ctx.repos.listEvents(t.ctx.db, claim.id, { type: 'services_agreed' })).toHaveLength(1);
    const delivery = t.ctx.repos.listMovements(t.ctx.db, { reservationId: res.id }).find((m) => m.kind === 'delivery')!;
    expect(delivery).toBeTruthy();
    expect(delivery.noticeOutboxId).toBeTruthy();
    const notice = t.ctx.repos.requireOutbox(t.ctx.db, delivery.noticeOutboxId!);
    expect(notice.kind).toBe('booking_update');
    expect(notice.bodyText).toContain(res.agreementNumber!);
    await settleMail();
    expect(t.ctx.repos.requireOutbox(t.ctx.db, notice.id).status, JSON.stringify(t.ctx.repos.requireOutbox(t.ctx.db, notice.id).policy)).toBe('held');
    // the hire-start pack is queued for the owner's approval (pack.prepare) by the same or the next tick
    await tick(claim.id);
    expect(t.ctx.repos.listAgentJobs(t.ctx.db, { claimId: claim.id, type: 'pack.prepare', limit: 10 }).length).toBeGreaterThan(0);
  });

  it('the daily log lists the hold, the offer and the booking with the claim reference and rule ids', async () => {
    const day = '2026-10-12';
    const res = await t.api<{ log: { sections: { autopilot?: Array<{ text: string; reference?: string; ruleIds?: string[] }> } } }>('POST', '/daily-log/compile', { day });
    const lines = res.body.log?.sections.autopilot ?? [];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => /held/.test(l.text) && l.reference === claim.reference)).toBe(true);
    expect(lines.some((l) => /Hire offer of AP26 AAA: (sent|accepted)/.test(l.text))).toBe(true);
  });
});

describe('commitment verification (§D.3)', () => {
  it('an offer whose booking changed after drafting is not verified; an owner-chosen car is', async () => {
    const A = fleetCar(t, 'CV26 AAA', 'S1');
    const claim = await readyClaim();
    const hold = await t.api<{ reservation: { id: string } }>('POST', `/claims/${claim.id}/bookings`, { fleetUnitId: A.id, use: 'credit_hire', startAt: at(t.ctx.now(), 120), expectedEndAt: at(t.ctx.now(), 14 * 1440) });
    expect(hold.status).toBe(201);
    const client = t.ctx.repos.getParty(t.ctx.db, claim.claimantId)!.email!;
    const ob = t.ctx.repos.createOutbox(t.ctx.db, { claimId: claim.id, accountId, kind: 'hire_offer', to: [client], subject: 'Your replacement car', bodyText: 'x', createdBy: 'agent:autopilot', now: t.ctx.now() });
    const prepared = await t.api<{ offer: { id: string; authorisedBy: string } }>('POST', `/claims/${claim.id}/hire-offers`, { reservationId: hold.body.reservation.id, outboxId: ob.id, alternatives: [] });
    expect(prepared.status).toBe(201);
    expect(prepared.body.offer.authorisedBy).not.toBe('autopilot_green');
    const base = { class: 'external_send' as const, kind: 'email.hire_offer', claimId: claim.id, confidence: 1, review: { verdict: 'pass' as const, touches: { ...TOUCHES_NONE, newCommitment: true, settlement: true } } };
    const ok = applyAutopilotCommitment(t.ctx, t.ctx.repos.requireOutbox(t.ctx.db, ob.id), base);
    expect(ok.commitment, JSON.stringify(ok.commitment)).toMatchObject({ kind: 'hire_offer', verified: true });
    // the period changes after drafting → the terms hash no longer matches
    await t.api('PATCH', `/bookings/${hold.body.reservation.id}`, { expectedEndAt: at(t.ctx.now(), 20 * 1440), reason: 'repair longer' });
    const changed = applyAutopilotCommitment(t.ctx, t.ctx.repos.requireOutbox(t.ctx.db, ob.id), base);
    expect(changed.commitment?.verified).toBe(false);
    expect(changed.commitment?.reasons.join(' ')).toMatch(/changed after the offer was drafted/);
    // a released hold → refused
    await t.api('POST', `/bookings/${hold.body.reservation.id}/release`, { reason: 'test release' });
    const gone = applyAutopilotCommitment(t.ctx, t.ctx.repos.requireOutbox(t.ctx.db, ob.id), base);
    expect(gone.commitment?.verified).toBe(false);
    expect(gone.commitment?.reasons.join(' ')).toMatch(/no longer held/);
  });
});

describe('owner controls and the perimeter (§A.8, §H.5)', () => {
  let claim: Claim;
  beforeAll(async () => {
    claim = await readyClaim();
  });

  it('pause / resume are audited, human-only, and a paused claim is planned but not acted on', async () => {
    const tok = mintRunToken({ name: 'autopilot', runId: `run-${randomUUID()}`, jobId: 'j', claimScope: claim.id }, 60_000);
    try {
      const refused = await t.api<{ error: { code: string } }>('POST', `/claims/${claim.id}/autopilot/pause`, { reason: 'agent should not' }, { authorization: `Bearer ${tok}` });
      expect(refused.status).toBe(403);
      const accept = await t.api('POST', `/hire-offers/x/accept`, { how: 'phone' }, { authorization: `Bearer ${tok}` });
      expect(accept.status).toBe(403);
    } finally {
      revokeRunToken(tok);
    }
    expect((await t.api('POST', `/claims/${claim.id}/autopilot/pause`, { reason: 'Client on holiday' })).status).toBe(200);
    const r = await tick(claim.id);
    expect(r.skipped).toMatch(/paused/);
    expect(t.ctx.repos.listReservations(t.ctx.db, { claimId: claim.id })).toHaveLength(0);
    const p = await plan(claim.id);
    expect(p.steps.some((s) => s.status === 'paused')).toBe(true);
    expect((await t.api('POST', `/claims/${claim.id}/autopilot/resume`, {})).status).toBe(200);
    expect(t.ctx.repos.listAudit(t.ctx.db, { entityId: claim.id }).map((a) => a.action)).toEqual(expect.arrayContaining(['autopilot.pause', 'autopilot.resume']));
  });

  it('step overrides: skip / done need a reason, ask raises the mode, auto never goes below the floor; all logged', async () => {
    expect((await t.api('POST', `/claims/${claim.id}/autopilot/steps/intake.cctv/skip`, {})).status).toBe(400);
    expect((await t.api('POST', `/claims/${claim.id}/autopilot/steps/intake.cctv/skip`, { reason: 'No cameras nearby' })).status).toBe(200);
    expect((await t.api('POST', `/claims/${claim.id}/autopilot/steps/hire.search/ask`, {})).status).toBe(200);
    expect((await t.api('POST', `/claims/${claim.id}/autopilot/steps/hire.pack/auto`, {})).status).toBe(200);
    expect((await t.api('POST', `/claims/${claim.id}/autopilot/steps/nope.step/skip`, { reason: 'xxx' })).status).toBe(400);
    const p = await plan(claim.id);
    const step = (id: string) => p.steps.find((s) => s.id === id)!;
    expect(['skipped', 'not_applicable']).toContain(step('intake.cctv').status);
    expect(step('hire.search').mode).toBe('confirm');
    expect(step('hire.search').modeReasons.join(' ')).toMatch(/asked to be asked/);
    expect(step('hire.pack').mode).toBe('confirm');
    expect(t.ctx.repos.listAutopilotLog(t.ctx.db, { claimId: claim.id }).filter((e) => e.action?.startsWith('override:')).length).toBe(3);
  });

  it('a step set to "ask me" places a protective hold and asks the owner to choose (choose_car); the owner picks → owner-authorised offer', async () => {
    const A = fleetCar(t, 'OW26 AAA', 'S1');
    const r = await tick(claim.id);
    const item = t.ctx.repos.listNeedsYou(t.ctx.db, { claimId: claim.id, kind: 'choose_car', status: 'open' })[0];
    expect(r.acted.some((a) => a.action === 'needs_you:choose_car'), JSON.stringify(r.acted)).toBe(true);
    expect(item).toBeTruthy();
    const options = (item!.options as Array<{ id: string }>).map((o) => o.id);
    expect(options).toEqual(expect.arrayContaining(['search_again', 'no_hire']));
    const unit = options.find((o) => o.startsWith('unit:'))!;
    expect(unit).toBeTruthy();
    const resolved = await t.api(`POST`, `/needs-you/${item!.id}/resolve`, { optionId: unit });
    expect(resolved.status).toBe(200);
    expect(t.ctx.repos.listAutopilotLog(t.ctx.db, { claimId: claim.id, action: 'owner_choice' })).toHaveLength(1);
    await t.api('POST', `/claims/${claim.id}/autopilot/steps/hire.search/clear`, {});
    await tick(claim.id);
    const offer = t.ctx.repos.listHireOffers(t.ctx.db, { claimId: claim.id })[0];
    expect(offer?.authorisedBy).toBeTruthy();
    expect(offer?.authorisedBy).not.toBe('autopilot_green');
    expect(A).toBeTruthy();
  });
});

describe('settlement offers stay with the owner (§D.9)', () => {
  it('offer_record writes the settlement register, starts no intervention clock, and the money.offer step waits on the owner', async () => {
    const claim = await readyClaim();
    const tok = mintRunToken({ name: 'case_manager', runId: `run-${randomUUID()}`, jobId: 'j', claimScope: claim.id }, 60_000);
    try {
      const res = await t.api<{ offer: { id: string } }>('POST', `/claims/${claim.id}/settlement-offers`, { head: 'hire', amountPence: 50000, receivedAt: t.ctx.now(), offerorName: 'Example Insurance plc', channel: 'email' }, { authorization: `Bearer ${tok}` });
      expect(res.status).toBeLessThan(300);
      const decide = await t.api(`PATCH`, `/claims/${claim.id}/settlement-offers/${res.body.offer.id}`, { status: 'accepted' }, { authorization: `Bearer ${tok}` });
      expect(decide.status).toBe(403);
    } finally {
      revokeRunToken(tok);
    }
    expect(t.ctx.repos.listSettlementOffers(t.ctx.db, claim.id)).toHaveLength(1);
    expect(t.ctx.repos.listOffers(t.ctx.db, claim.id)).toHaveLength(0);
    const p = await plan(claim.id);
    const step = p.steps.find((s) => s.id === 'money.offer')!;
    expect(step.mode).toBe('owner');
    expect(['due', 'waiting', 'paused']).toContain(step.status);
  });
});

describe('the sweep', () => {
  it('installs once, ticks new claims and skips closed ones', async () => {
    const claim = await readyClaim();
    const job = { id: 'sweep-test', correlationId: 'sweep-test' } as JobRecord;
    const handler = getJobHandler('autopilot.sweep')!;
    const out = await handler.run({ ctx: t.ctx, job, payload: {}, signal: new AbortController().signal, log: t.ctx.logger });
    expect(out.kind).toBe('done');
    expect(t.ctx.repos.listAgentJobs(t.ctx.db, { claimId: claim.id, type: 'autopilot.tick', limit: 50 }).length).toBeGreaterThan(0);
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'autopilot.installed' })).toHaveLength(1);
  });
});
