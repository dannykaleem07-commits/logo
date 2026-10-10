// owned by ap-autopilot
/**
 * Autopilot lifecycle scenario (docs/SUPREME-AUTOPILOT.md §J.3), driven job by job with the FakeDriver fixtures
 * (apps/api/src/ai/fixtures/autopilot/) and the fake mail transports — never a real model, never the network.
 *
 * Covered here: the booking path from a qualified claim to the delivery confirmation on the client's inbox (offer
 * held 10 minutes for Undo, sent, "YES" read by code, booking confirmed with an agreement number, delivery slot,
 * booking_update sent), the plan at each point, the append-only log and the daily log; and the variants — client
 * declines, an unclear reply read by the reply reader and confirmed by the owner, a late "yes" after the hold expired
 * (re-held and confirmed), shadow mode (nothing sent without approval).
 *
 * Not driven end to end here (each has its own slice tests): the sign-up and hire-start packs through kiosk signing
 * (paperwork.test.ts), handover / return (bookings.test.ts), billing and payment packs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Claim } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { fleetCar, seedClaim } from './bookingFixtures.js';
import { drain, queued, run, runJob, setUpMail } from './fixtures/mail/helpers.js';
import type { FakeSmtp } from '../mail/transport.js';
import { ensureAutopilotInstalled } from '../autopilot/install.js';

const OWNER = { userId: 'courtesycars' };
const T0 = '2026-10-19T08:00:00.000Z'; // Monday 09:00 London
const at = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString();

let t: TestApp;
let smtp: FakeSmtp;
let accountId: string;
let regSeq = 0;

async function readyClaim(): Promise<Claim> {
  const c = await seedClaim(t, { automaticOnly: true });
  t.ctx.repos.updateParty(t.ctx.db, c.claimantId, { dateOfBirth: '1992-04-01' });
  expect((await t.api('PUT', `/parties/${c.claimantId}/driver-profile`, { licenceCountry: 'GB', licenceType: 'full', fullLicenceSince: '2014-01-01', restrictionCodes: ['78'], points: 3, endorsements: [{ code: 'SP30', offenceDate: '2024-03-01', points: 3 }], source: 'dvla_check', dvlaCheck: { checkedAt: t.ctx.now(), summary: 'Full licence, 3 points (SP30), code 78' } })).status).toBe(200);
  await t.api('PUT', `/claims/${c.id}/hire-needs`, { otherVehicles: 'none', occupation: 'Nurse', journeys: 'Hospital shifts', clientWantsHire: true, automaticOnly: true });
  t.ctx.repos.appendEligibilityAssessment(t.ctx.db, { claimId: c.id, kind: 'acceptance', outcome: 'accept', reasons: { decision: 'accept', conditions: [] }, inputsSha256: randomUUID(), createdBy: 'test', createdAt: t.ctx.now() });
  const client = t.ctx.repos.getParty(t.ctx.db, c.claimantId)!.email!;
  const ack = t.ctx.repos.createOutbox(t.ctx.db, { claimId: c.id, accountId, kind: 'ack', to: [client], subject: 'Thank you', bodyText: 'x', createdBy: 'courtesycars', now: t.ctx.now() });
  for (const [s, who] of [['queued', 'courtesycars'], ['sending', 'agent:mail'], ['sent', 'agent:mail']] as const) t.ctx.repos.transitionOutbox(t.ctx.db, ack.id, s, who, s, { now: t.ctx.now() });
  return t.ctx.repos.requireClaim(t.ctx.db, c.id);
}

async function tick(claimId: string): Promise<{ acted: Array<{ stepId: string; action: string; ok: boolean; note?: string }>; skipped?: string }> {
  return (await run(t.ctx, 'autopilot.tick', { claimId }, { claimId })).outcome.result as never;
}

async function settleMail(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    const n = (await drain(t.ctx, 'review.check')).length + (await drain(t.ctx, 'outbox.after_review')).length;
    if (!n) break;
  }
}

async function release(now: string): Promise<void> {
  t.setNow(now);
  for (const j of queued(t.ctx, 'outbox.release')) await runJob(t.ctx, j);
}

function reply(claim: Claim, text: string, opts: { from?: string; offerSubject: string; inReplyTo?: string | null; now: string }) {
  return t.ctx.repos.insertMailMessage(t.ctx.db, {
    accountId,
    direction: 'in',
    threadKey: `thread-${claim.id}`,
    fromAddr: opts.from ?? t.ctx.repos.getParty(t.ctx.db, claim.claimantId)!.email!,
    to: ['claims@ccguk-test.example'],
    cc: [],
    subject: `Re: ${opts.offerSubject}`,
    inReplyTo: opts.inReplyTo ?? null,
    receivedAt: opts.now,
    rawEvidenceId: `raw-${randomUUID()}`,
    rawSha256: randomUUID(),
    bodyText: text,
    claimId: claim.id,
    source: 'imap',
    status: 'matched',
    now: opts.now,
  });
}

/** A fresh S1 automatic car that is the clear winner: free cars left over from earlier variants are disposed of. */
function soleFreeCar(registration: string): void {
  const busy = new Set(t.ctx.repos.listReservations(t.ctx.db, {}).filter((r) => r.status === 'held' || r.status === 'confirmed').map((r) => r.fleetUnitId));
  for (const u of t.ctx.repos.listFleetUnits(t.ctx.db)) if (!busy.has(u.id) && u.status !== 'disposed') t.ctx.repos.updateFleetUnit(t.ctx.db, u.id, { status: 'disposed' });
  fleetCar(t, registration, 'S1');
}

const planOf = async (claimId: string) => (await t.api<{ plan: { stage: string; due: string[]; waiting: string[]; done: string[]; steps: Array<{ id: string; status: string; mode: string }> } }>('GET', `/claims/${claimId}/autopilot`)).body.plan;

/** Hold → offer drafted → reviewed → held → released → sent → offer `sent`. */
async function offerSent(claim: Claim, start: string): Promise<{ offerId: string; subject: string; smtpMessageId: string | null }> {
  t.setNow(start);
  let r = await tick(claim.id);
  if (!r.acted.some((a) => a.action === 'tool:hire_offer_prepare')) r = await tick(claim.id);
  const offer = t.ctx.repos.listHireOffers(t.ctx.db, { claimId: claim.id }).pop()!;
  expect(offer, JSON.stringify(r)).toBeTruthy();
  await settleMail();
  await release(new Date(Date.parse(start) + 11 * 60_000).toISOString());
  await tick(claim.id);
  const sent = t.ctx.repos.getHireOffer(t.ctx.db, offer.id)!;
  expect(sent.status).toBe('sent');
  const ob = t.ctx.repos.requireOutbox(t.ctx.db, offer.outboxId!);
  return { offerId: offer.id, subject: ob.subject, smtpMessageId: ob.smtpMessageId ?? null };
}

beforeAll(async () => {
  t = await createTestApp(T0, { config: { aiDriverOverride: 'fake' } });
  ({ smtp, accountId } = await setUpMail(t.ctx));
  t.ctx.repos.patchAgentSettings(t.ctx.db, { ai: { driver: 'subscription_cli' }, agents: { enabled: true }, autonomy: { quietHours: null } }, OWNER);
  ensureAutopilotInstalled(t.ctx);
});
afterAll(async () => {
  await t.close();
});

describe('the booking path end to end (§J.3 steps 5–9)', () => {
  let claim: Claim;
  beforeAll(async () => {
    regSeq += 1;
    fleetCar(t, `EA2${regSeq} AAA`, 'S1');
    fleetCar(t, `EB2${regSeq} BBB`, 'S1', { transmission: 'manual' });
    fleetCar(t, `EC2${regSeq} CCC`, 'M2', { bodyType: 'SUV', model: 'Kuga' }, { dailyRatePence: 7000 });
    claim = await readyClaim();
  });

  it('offer → YES → confirmed → delivery confirmation; FakeSmtp holds exactly the offer and the booking update to the client', async () => {
    const before = smtp.sent.length;
    const p0 = await planOf(claim.id);
    expect(p0.due).toContain('hire.search');
    const { subject, smtpMessageId } = await offerSent(claim, T0);
    const p7 = await planOf(claim.id);
    expect(p7.done).toEqual(expect.arrayContaining(['hire.search', 'hire.choose', 'hire.hold', 'hire.offer']));
    expect(p7.waiting).toContain('hire.acceptance');
    reply(claim, 'YES please.\n\n> If you would like this car, simply reply YES', { offerSubject: subject, inReplyTo: smtpMessageId, now: at(60) });
    t.setNow(at(61));
    const r = await tick(claim.id);
    expect(r.acted.map((a) => a.action)).toEqual(expect.arrayContaining(['tool:hire_acceptance_record', 'tool:booking_confirm']));
    await settleMail();
    await release(at(75));
    await tick(claim.id);
    const res = t.ctx.repos.listReservations(t.ctx.db, { claimId: claim.id });
    expect(res.map((x) => x.status)).toEqual(['confirmed']);
    expect(t.ctx.repos.listReservationEvents(t.ctx.db, res[0]!.id).map((e) => e.toStatus)).toEqual(['held', 'confirmed']);
    const client = t.ctx.repos.getParty(t.ctx.db, claim.claimantId)!.email!;
    const mine = smtp.sent.slice(before);
    expect(mine.map((m) => m.to.join(','))).toEqual([client, client]);
    expect(mine[0]!.subject).toMatch(/Your replacement car/);
    expect(mine[1]!.subject).toMatch(/is booked/);
    const delivery = t.ctx.repos.listMovements(t.ctx.db, { reservationId: res[0]!.id }).find((m) => m.kind === 'delivery')!;
    expect(delivery.clientNotifiedAt).toBeTruthy();
    const p9 = await planOf(claim.id);
    expect(p9.done).toEqual(expect.arrayContaining(['hire.acceptance', 'hire.confirm', 'hire.delivery']));
    expect(p9.steps.find((s) => s.id === 'hire.pack')!.mode).toBe('confirm');
  });

  it('the log is append-only and in order; every outbound email passed review; no agent decided money or an offer', async () => {
    const log = t.ctx.repos.listAutopilotLog(t.ctx.db, { claimId: claim.id });
    const acted = log.filter((e) => e.action).map((e) => e.action!);
    const iHold = acted.findIndex((a) => a === 'tool:booking_hold');
    const iOffer = acted.findIndex((a) => a === 'tool:hire_offer_prepare');
    const iConfirm = acted.findIndex((a) => a === 'tool:booking_confirm');
    expect(iHold).toBeGreaterThanOrEqual(0);
    expect(iOffer).toBeGreaterThan(iHold);
    expect(iConfirm).toBeGreaterThan(iOffer);
    expect(() => t.ctx.handle.sqlite.prepare('DELETE FROM autopilot_log').run()).toThrow();
    for (const o of t.ctx.repos.listOutbox(t.ctx.db, { claimId: claim.id }).filter((x) => x.status === 'sent' && x.subject !== 'Thank you')) {
      expect(t.ctx.repos.latestReviewFor(t.ctx.db, { kind: 'outbox', id: o.id })?.verdict, o.subject).toBe('pass');
    }
    const agentMoney = t.ctx.handle.sqlite.prepare(`SELECT count(*) AS n FROM audit_log WHERE user_id LIKE 'agent:%' AND (action LIKE 'ledger.%' OR action LIKE 'settlement_offer.decide%' OR action = 'offer.decide')`).get() as { n: number };
    expect(agentMoney.n).toBe(0);
  });
});

describe('variants', () => {
  it('client declines ("no thanks, my partner will lend me theirs") → hold released, hire steps no longer apply', async () => {
    regSeq += 1;
    soleFreeCar(`ED2${regSeq} DDD`);
    const claim = await readyClaim();
    const start = at(24 * 60);
    const { subject, smtpMessageId } = await offerSent(claim, start);
    reply(claim, 'no thanks, my partner will lend me theirs', { offerSubject: subject, inReplyTo: smtpMessageId, now: new Date(Date.parse(start) + 60 * 60_000).toISOString() });
    t.setNow(new Date(Date.parse(start) + 61 * 60_000).toISOString());
    await tick(claim.id);
    const res = t.ctx.repos.listReservations(t.ctx.db, { claimId: claim.id });
    expect(res[0]).toMatchObject({ status: 'cancelled', cancelledReason: 'client_declined_hire' });
    expect(t.ctx.repos.listEvents(t.ctx.db, claim.id, { type: 'hire_offer_declined' })).toHaveLength(1);
    const p = await planOf(claim.id);
    for (const id of ['hire.search', 'hire.offer', 'hire.confirm']) expect(p.steps.find((s) => s.id === id)!.status, id).toBe('not_applicable');
    expect(p.steps.find((s) => s.id === 'vehicle.engineer')!.status).not.toBe('not_applicable');
  });

  it('an unclear reply goes to the reply reader (fixture: a question) → the owner is asked; "Treat it as a yes" confirms the booking', async () => {
    regSeq += 1;
    soleFreeCar(`EE2${regSeq} EEE`);
    const claim = await readyClaim();
    const start = at(2 * 24 * 60);
    const { subject, smtpMessageId } = await offerSent(claim, start);
    reply(claim, 'AP-E2E-QUESTION Before I say, can it have a child seat?', { offerSubject: subject, inReplyTo: smtpMessageId, now: new Date(Date.parse(start) + 30 * 60_000).toISOString() });
    t.setNow(new Date(Date.parse(start) + 31 * 60_000).toISOString());
    const r = await tick(claim.id);
    expect(r.acted.map((a) => a.action)).toContain('judge:parse_reply');
    await drain(t.ctx, 'hire_offer.parse_reply');
    const card = t.ctx.repos.listNeedsYou(t.ctx.db, { claimId: claim.id, kind: 'autopilot_step', status: 'open' }).find((n) => (n.payload as { purpose?: string }).purpose === 'reply_unclear')!;
    expect(card).toBeTruthy();
    expect(card.summary).toMatch(/child seat/);
    expect((await t.api('POST', `/needs-you/${card.id}/resolve`, { optionId: 'accepted' })).status).toBe(200);
    await tick(claim.id);
    expect(t.ctx.repos.listReservations(t.ctx.db, { claimId: claim.id }).some((x) => x.status === 'confirmed')).toBe(true);
  });

  it('the hold expires unanswered → "call them?" card and a call task; a late "yes" re-holds the free car and confirms it', async () => {
    regSeq += 1;
    soleFreeCar(`EF2${regSeq} FFF`);
    const claim = await readyClaim();
    const start = at(3 * 24 * 60);
    const { subject, smtpMessageId } = await offerSent(claim, start);
    const later = new Date(Date.parse(start) + 25 * 60 * 60_000).toISOString();
    t.setNow(later);
    await run(t.ctx, 'booking.expire_holds', {});
    await tick(claim.id);
    const offer = t.ctx.repos.listHireOffers(t.ctx.db, { claimId: claim.id }).pop()!;
    expect(offer.status).toBe('expired');
    const card = t.ctx.repos.listNeedsYou(t.ctx.db, { claimId: claim.id, kind: 'autopilot_step', status: 'open' }).find((n) => (n.payload as { purpose?: string }).purpose === 'offer_expired');
    expect(card?.title).toMatch(/call them/);
    expect(t.ctx.repos.listTasks(t.ctx.db, { claimId: claim.id, status: 'open', limit: 50 }).some((x) => x.kind === 'call')).toBe(true);
    // no new search while the expired offer waits for the call
    expect(t.ctx.repos.listReservations(t.ctx.db, { claimId: claim.id }).filter((x) => x.status === 'held')).toHaveLength(0);
    const lateYes = new Date(Date.parse(later) + 30 * 60_000).toISOString();
    reply(claim, 'Yes please, sorry for the delay', { offerSubject: subject, inReplyTo: smtpMessageId, now: lateYes });
    t.setNow(new Date(Date.parse(lateYes) + 60_000).toISOString());
    await tick(claim.id);
    const confirmed = t.ctx.repos.listReservations(t.ctx.db, { claimId: claim.id }).find((x) => x.status === 'confirmed');
    expect(confirmed?.agreementNumber).toMatch(/^CCG-H-/);
    expect(t.ctx.repos.getHireOffer(t.ctx.db, offer.id)!.status).toBe('accepted');
  });

  it('shadow mode: the offer is prepared and reviewed but waits for the owner (approve_send); nothing is sent', async () => {
    regSeq += 1;
    soleFreeCar(`EG2${regSeq} GGG`);
    const claim = await readyClaim();
    t.ctx.repos.patchAgentSettings(t.ctx.db, { autonomy: { mode: 'shadow' } }, OWNER);
    try {
      const sentBefore = smtp.sent.length;
      t.setNow(at(4 * 24 * 60));
      let r = await tick(claim.id);
      // In shadow mode even the hold needs the owner: the owner picks the car on a choose_car card.
      expect(r.acted.map((a) => a.action)).toContain('needs_you:choose_car');
      const choose = t.ctx.repos.listNeedsYou(t.ctx.db, { claimId: claim.id, kind: 'choose_car', status: 'open' })[0]!;
      expect(choose.summary).toMatch(/Shadow mode/);
      const unit = choose.options.find((o) => o.id.startsWith('unit:'))!;
      expect((await t.api('POST', `/needs-you/${choose.id}/resolve`, { optionId: unit.id })).status).toBe(200);
      expect(t.ctx.repos.listReservations(t.ctx.db, { claimId: claim.id }).filter((x) => x.status === 'held')).toHaveLength(1);
      r = await tick(claim.id);
      if (!r.acted.some((a) => a.action === 'tool:hire_offer_prepare')) r = await tick(claim.id);
      await settleMail();
      const offer = t.ctx.repos.listHireOffers(t.ctx.db, { claimId: claim.id }).pop()!;
      expect(offer, JSON.stringify(r)).toBeTruthy();
      expect(offer.authorisedBy).not.toBe('autopilot_green');
      const ob = t.ctx.repos.requireOutbox(t.ctx.db, offer.outboxId!);
      expect(ob.status).toBe('awaiting_approval');
      expect(t.ctx.repos.listNeedsYou(t.ctx.db, { claimId: claim.id, kind: 'approve_send', status: 'open' })).toHaveLength(1);
      await release(at(4 * 24 * 60 + 15));
      expect(smtp.sent.length).toBe(sentBefore);
    } finally {
      t.ctx.repos.patchAgentSettings(t.ctx.db, { autonomy: { mode: 'automatic' } }, OWNER);
    }
  });
});
