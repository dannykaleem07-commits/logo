// owned by ap-autopilot (integration fixes found by the Autopilot verification run, docs/SUPREME-AUTOPILOT.md §J)
/**
 * Integration fixes, each found by running the §J scenario end to end:
 *   - pack.prepare retries a pack that could not be prepared (hourly) and prepares a superseded pack again;
 *   - a drafter step that waits on its draft (being written, reviewed or approved by the owner) is not re-drafted every
 *     tick and every day;
 *   - an approved letter (e.g. the NCAF) is emailed to the recipient with the letter attached, once;
 *   - claim, vehicle, party and off-hire event changes queue a clash check and nudge the autopilot (§C.3);
 *   - the owner's one-time art 60F confirmation of the CCGUK-03 agreement is used by the enforceability sync (§E.5).
 * FakeDriver only (no model), fake mail transports, the app clock.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Claim } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { fleetCar, holdBody, seedClaim } from './bookingFixtures.js';
import { queued, run, setUpMail } from './fixtures/mail/helpers.js';
import { enqueueJob } from '../agent/core.js';
import { packPrepareKey } from '../agent/tools/signing.js';
import { draftInFlight } from '../autopilot/runner.js';
import { ensureAutopilotInstalled } from '../autopilot/install.js';
import { provenFromPack } from '../signing/enforceability.js';

const OWNER = { userId: 'courtesycars' };
const T0 = '2026-10-19T08:00:00.000Z'; // Monday 09:00 London

let t: TestApp;
let accountId: string;

beforeAll(async () => {
  t = await createTestApp(T0, { config: { aiDriverOverride: 'fake' } });
  ({ accountId } = await setUpMail(t.ctx));
  t.ctx.repos.patchAgentSettings(t.ctx.db, { ai: { driver: 'subscription_cli' }, agents: { enabled: true }, autonomy: { quietHours: null } }, OWNER);
  ensureAutopilotInstalled(t.ctx);
});
afterAll(async () => {
  await t.close();
});

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function draftDoc(claimId: string, templateId: string, title = 'A letter') {
  const html = `<p>${title} ${randomUUID()}</p>`;
  return t.ctx.repos.createDraft(t.ctx.db, { claimId, templateId, templateVersion: '1', title, html, sha256: sha(html), dataSnapshot: {}, createdBy: 'agent:drafter', createdAt: t.ctx.now() } as never);
}

const jobsOf = (type: string, claimId: string) => queued(t.ctx, type as never).filter((j) => j.claimId === claimId);

describe('pack.prepare idempotency (recovers once the cause is fixed)', () => {
  it('one key per pack generation; while the open pack is still preparing, one retry per hour', async () => {
    const claim = await seedClaim(t);
    const k0 = packPrepareKey(t.ctx, claim.id, 'signup', null);
    expect(k0).toBe(`pack.prepare:${claim.id}:signup:-:0`);
    const pack = t.ctx.repos.createDocumentPack(t.ctx.db, { claimId: claim.id, stage: 'signup', items: [], createdBy: 'agent:autopilot', at: t.ctx.now() } as never);
    const k1 = packPrepareKey(t.ctx, claim.id, 'signup', null);
    expect(k1).toBe(`pack.prepare:${claim.id}:signup:-:0:retry:${T0.slice(0, 13)}`);
    t.setNow('2026-10-19T08:40:00.000Z');
    expect(packPrepareKey(t.ctx, claim.id, 'signup', null)).toBe(k1); // same hour: no second attempt
    t.setNow('2026-10-19T09:05:00.000Z');
    expect(packPrepareKey(t.ctx, claim.id, 'signup', null)).not.toBe(k1); // next hour: one retry
    t.ctx.repos.updateDocumentPack(t.ctx.db, pack.id, { status: 'superseded' }, t.ctx.now());
    expect(packPrepareKey(t.ctx, claim.id, 'signup', null)).toBe(`pack.prepare:${claim.id}:signup:-:1`); // a new pack may be prepared
    t.setNow(T0);
  });
});

describe('a drafter step waiting on its draft is not re-drafted', () => {
  it('the same day, or a later day while the earlier draft is still open; a cancelled draft lets it draft again', async () => {
    const claim = await seedClaim(t);
    const key = (day: string) => `draft.compose:${claim.id}:CHECK_NEED:${day}`;
    expect(draftInFlight(t.ctx, key('2026-10-19'))).toBe(false);
    const job = enqueueJob(t.ctx, { type: 'draft.compose', claimId: claim.id, payload: { claimId: claim.id }, idempotencyKey: key('2026-10-19'), createdBy: 'agent:autopilot' });
    expect(draftInFlight(t.ctx, key('2026-10-19'))).toBe(true); // asked for today
    expect(draftInFlight(t.ctx, key('2026-10-20'))).toBe(true); // still being written
    const ob = t.ctx.repos.createOutbox(t.ctx.db, { claimId: claim.id, accountId, kind: 'ack', to: ['client@example.test'], subject: 'Thank you', bodyText: 'x', createdBy: 'agent:drafter', now: t.ctx.now() });
    t.ctx.repos.markAgentJobSucceeded(t.ctx.db, job.id, { result: { drafts: [{ kind: 'outbox', id: ob.id }] }, now: t.ctx.now() });
    t.ctx.repos.transitionOutbox(t.ctx.db, ob.id, 'reviewing', 'agent:reviewer', 'review', { now: t.ctx.now() });
    expect(draftInFlight(t.ctx, key('2026-10-20'))).toBe(true); // being reviewed
    t.ctx.repos.transitionOutbox(t.ctx.db, ob.id, 'awaiting_approval', 'agent:mail', 'first contact', { now: t.ctx.now() });
    expect(draftInFlight(t.ctx, key('2026-10-20'))).toBe(true); // waiting for the owner's approval
    t.ctx.repos.transitionOutbox(t.ctx.db, ob.id, 'cancelled', 'courtesycars', 'not needed', { now: t.ctx.now() });
    expect(draftInFlight(t.ctx, key('2026-10-20'))).toBe(false);
    // An approved letter that has not gone out yet also counts as in flight.
    const job2 = enqueueJob(t.ctx, { type: 'draft.compose', claimId: claim.id, payload: { claimId: claim.id }, idempotencyKey: `draft.compose:${claim.id}:SEND_NCAF:2026-10-19`, createdBy: 'agent:autopilot' });
    const doc = draftDoc(claim.id, 'letter.ncaf', 'New Claim Advice Form');
    t.ctx.repos.markAgentJobSucceeded(t.ctx.db, job2.id, { result: { drafts: [{ kind: 'document', id: doc.id }] }, now: t.ctx.now() });
    t.ctx.repos.approveDocument(t.ctx.db, doc.id, { userId: 'agent:reviewer' }, t.ctx.now());
    expect(draftInFlight(t.ctx, `draft.compose:${claim.id}:SEND_NCAF:2026-10-21`)).toBe(true);
  });
});

describe('an approved letter is emailed by the autopilot (notify.ncaf)', () => {
  let claim: Claim;
  beforeAll(async () => {
    claim = await seedClaim(t);
    t.ctx.repos.updateParty(t.ctx.db, claim.atFaultInsurerId!, { email: 'thirdparty.claims@example-insurer.test' });
  });

  it('emails the approved NCAF with the letter attached, tagged to the step, once', async () => {
    const doc = draftDoc(claim.id, 'letter.ncaf', 'New Claim Advice Form');
    t.ctx.repos.approveDocument(t.ctx.db, doc.id, { userId: 'agent:reviewer' }, t.ctx.now());
    const r1 = await run(t.ctx, 'autopilot.tick', { claimId: claim.id, forceStepId: 'notify.ncaf' }, { claimId: claim.id });
    const acted = (r1.outcome.result as { acted: Array<{ stepId: string; action: string; ok: boolean; note?: string }> }).acted;
    expect(acted.find((a) => a.stepId === 'notify.ncaf'), JSON.stringify(acted)).toMatchObject({ action: 'tool:email_draft:letter', ok: true });
    const mails = t.ctx.repos.listOutbox(t.ctx.db, { claimId: claim.id }).filter((o) => (o.attachmentsJson ?? []).some((a) => a.documentId === doc.id));
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ kind: 'ncaf_cover', toJson: ['thirdparty.claims@example-insurer.test'], autopilotStepId: 'notify.ncaf' });
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'outbox.draft', entityId: mails[0]!.id })[0]?.userId).toBe('agent:autopilot');
    // A second tick does not email it again while that email is in progress.
    await run(t.ctx, 'autopilot.tick', { claimId: claim.id, forceStepId: 'notify.ncaf' }, { claimId: claim.id });
    expect(t.ctx.repos.listOutbox(t.ctx.db, { claimId: claim.id }).filter((o) => (o.attachmentsJson ?? []).some((a) => a.documentId === doc.id))).toHaveLength(1);
  });

  it('without an email address for the recipient the owner is asked to post it (no email drafted)', async () => {
    const c2 = await seedClaim(t);
    t.ctx.repos.updateParty(t.ctx.db, c2.atFaultInsurerId!, { email: null } as never);
    const doc = draftDoc(c2.id, 'letter.ncaf', 'New Claim Advice Form');
    t.ctx.repos.approveDocument(t.ctx.db, doc.id, { userId: 'agent:reviewer' }, t.ctx.now());
    await run(t.ctx, 'autopilot.tick', { claimId: c2.id, forceStepId: 'notify.ncaf' }, { claimId: c2.id });
    expect(t.ctx.repos.listOutbox(t.ctx.db, { claimId: c2.id }).filter((o) => (o.attachmentsJson ?? []).length)).toEqual([]);
    const card = t.ctx.repos.listNeedsYou(t.ctx.db, { claimId: c2.id, status: 'open' }).find((n) => n.kind === 'autopilot_step' && n.dedupeKey === `autopilot:${c2.id}:notify.ncaf:post:${doc.id}`);
    expect(card?.summary).toMatch(/no email address/);
  });
});

describe('claim changes queue a clash check and nudge the autopilot (§C.3)', () => {
  it('claim created, claim edited, status changed, vehicle edited, party DOB edited, off-hire event recorded', async () => {
    const claim = await seedClaim(t);
    const both = () => ({ clash: jobsOf('clash.check', claim.id).length, tick: jobsOf('autopilot.tick', claim.id).length });
    expect(both().clash).toBeGreaterThan(0); // POST /claims (seedClaim)
    expect(both().tick).toBeGreaterThan(0);
    const steps: Array<[string, () => Promise<{ status: number }>]> = [
      ['PATCH /claims/:id', () => t.api('PATCH', `/claims/${claim.id}`, { accident: { location: 'A4 Bath Road, Reading' } })],
      ['PATCH /vehicles/:id', () => t.api('PATCH', `/vehicles/${claim.clientVehicleId}`, { colour: 'Blue', source: { provider: 'manual', appliedFields: ['colour'] } })],
      ['PATCH /parties/:id (date of birth)', () => t.api('PATCH', `/parties/${claim.claimantId}`, { dateOfBirth: '1990-01-01' })],
      ['POST /claims/:id/events (repair_completed)', () => t.api('POST', `/claims/${claim.id}/events`, { type: 'repair_completed', at: t.ctx.now(), summary: 'Repair completed' })],
      ['POST /claims/:id/status', () => t.api('POST', `/claims/${claim.id}/status`, { status: 'triage' })],
    ];
    let minute = 1;
    for (const [label, call] of steps) {
      t.setNow(new Date(Date.parse(T0) + minute * 60_000).toISOString()); // the jobs are idempotent per minute
      minute += 1;
      const before = both();
      const res = await call();
      expect(res.status, `${label}: ${JSON.stringify(res)}`).toBeLessThan(300);
      const after = both();
      expect(after.clash, label).toBe(before.clash + 1);
      expect(after.tick, label).toBe(before.tick + 1);
    }
    // A change that does not touch identity (a phone number) does not queue anything.
    t.setNow(new Date(Date.parse(T0) + minute * 60_000).toISOString());
    const before = both();
    expect((await t.api('PATCH', `/parties/${claim.claimantId}`, { phone: '07700 900999' })).status).toBe(200);
    expect(both()).toEqual(before);
    t.setNow(T0);
  });
});

describe("the owner's art 60F confirmation of the CCGUK-03 agreement (§E.5)", () => {
  it('a signed CCGUK-03 proves art 60F only once the owner has confirmed the template in Settings > Autopilot', async () => {
    const claim = await seedClaim(t);
    const unit = fleetCar(t, `AF60 ${String.fromCharCode(65 + Math.floor(Math.random() * 26))}AA`, 'S1');
    const b = await t.api<{ reservation: { id: string } }>('POST', `/claims/${claim.id}/bookings`, holdBody(unit, { confirm: true, startAt: '2026-10-20T09:00:00.000Z', expectedEndAt: '2026-10-30T09:00:00.000Z' }));
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const reservationId = b.body.reservation.id;
    const doc = draftDoc(claim.id, 'agreement.ccguk_03_credit_hire', 'Credit hire agreement (CCGUK-03)');
    t.ctx.repos.attachSignature(t.ctx.db, doc.id, { signerPartyId: claim.claimantId, signerName: 'Client', signerContact: 'client@example.test', otpChannel: 'email', otpVerifiedAt: t.ctx.now(), ipAddress: '127.0.0.1', userAgent: 'test', signedAt: t.ctx.now(), documentSha256: doc.sha256, certificateId: randomUUID(), method: 'kiosk_otp_email' });
    t.ctx.repos.createDocumentPack(t.ctx.db, { claimId: claim.id, stage: 'hire_start', reservationId, items: [{ templateId: 'agreement.ccguk_03_credit_hire', variant: 'hirer', format: 'docx', purpose: 'sign', signer: 'hirer', status: 'signed', documentId: doc.id }], status: 'signed', createdBy: 'agent:autopilot', at: t.ctx.now() } as never);
    expect(provenFromPack(t.ctx, t.ctx.db, reservationId)).toMatchObject({ documentId: doc.id });
    expect(provenFromPack(t.ctx, t.ctx.db, reservationId).enforceability?.cca60fCompliant).toBeUndefined();
    const bad = await t.api('PATCH', '/settings/autopilot', { signing: { art60fTemplates: 'agreement.ccguk_03_credit_hire' } });
    expect(bad.status).toBe(400);
    const ok = await t.api<{ settings: { signing: { art60fTemplates: string[] } } }>('PATCH', '/settings/autopilot', { signing: { art60fTemplates: ['agreement.ccguk_03_credit_hire'] } });
    expect(ok.status).toBe(200);
    expect(ok.body.settings.signing.art60fTemplates).toEqual(['agreement.ccguk_03_credit_hire']);
    expect(provenFromPack(t.ctx, t.ctx.db, reservationId).enforceability?.cca60fCompliant).toBe(true);
    // Agents can never record the confirmation.
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'autopilot.settings' }).every((a) => !a.userId.startsWith('agent:'))).toBe(true);
    await t.api('PATCH', '/settings/autopilot', { signing: { art60fTemplates: [] } });
  });
});

describe('autonomy settings: the default auto-send templates are real templates (§0.6)', () => {
  it('no exemption is needed: every default auto-send template is registered and the defaults pass the checks', async () => {
    const { autonomyProblems } = await import('../routes/autonomySettings.js');
    const { listTemplates } = await import('@ccguk/documents');
    const { DEFAULT_AUTONOMY, DEFAULT_AUTO_SEND_TEMPLATES } = await import('@ccguk/domain');
    const known = new Set(listTemplates().map((x: { id: string }) => x.id));
    expect(DEFAULT_AUTO_SEND_TEMPLATES.filter((id) => !known.has(id))).toEqual([]);
    expect(autonomyProblems(DEFAULT_AUTONOMY, known)).toEqual([]);
    expect(autonomyProblems({ ...DEFAULT_AUTONOMY, autoSendTemplates: [...DEFAULT_AUTONOMY.autoSendTemplates, 'letter.not_a_template'] }, known)).toContain('Unknown template "letter.not_a_template".');
    const res = await t.api('PATCH', '/settings/autonomy', { limits: { perClaimPerDay: 6, perHour: 20, perDay: 100 } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe('daily log: autopilot lines are written for the owner', () => {
  it('a drafter hand-off reads "draft asked for", without internal job ids', async () => {
    const { autopilotDailyLogSections } = await import('../autopilot/dailyLog.js');
    const claim = await seedClaim(t);
    const jobId = randomUUID();
    t.ctx.repos.appendAutopilotLog(t.ctx.db, { claimId: claim.id, stepId: 'intake.acknowledge', toStatus: 'in_progress', actor: 'agent:autopilot', action: 'draft:CHECK_NEED', note: `draft.compose ${jobId}`, refs: {}, at: t.ctx.now() } as never);
    const sections = autopilotDailyLogSections(t.ctx, T0.slice(0, 10), { start: '2026-10-18T23:00:00.000Z', end: '2026-10-19T23:00:00.000Z' });
    const line = (sections.autopilot ?? []).find((l) => l.claimId === claim.id && /Acknowledge/.test(l.text));
    expect(line?.text).toMatch(/draft asked for/);
    expect(line?.text).not.toContain(jobId);
  });
});
