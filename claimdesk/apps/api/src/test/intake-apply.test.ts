// owned by intake
/**
 * Proposals and applying them (docs/SUPREME-DESIGN.md §G.2 steps 5–6, §G.3, §D.2 rules 7–9, §C.7):
 *  - empty + confident + valid + not sensitive → applied through the routes as agent:intake, audited with the source;
 *  - overwrite / sensitive / low confidence → ONE grouped Needs-you confirm_fields card per document;
 *  - the confirm_fields resolver applies the ticked values AS THE OWNER and rejects the rest with the reason;
 *  - `never` targets are refused; agents can never apply a confirmation;
 *  - a new-claim draft built from files is accepted by POST /claims once the owner adds the account.
 * Synthetic documents and FakeDriver fixtures only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, FNOL, type TestApp } from './helpers.js';
import { auditRows, drainIntake, makeTextPdf } from './fixtures/intake/helpers.js';
import { agentApplier, applyProposal } from '../intake/apply.js';
import { proposeField } from '../intake/proposals.js';
import { claimFieldProposeInput, intakeTools } from '../agent/tools/intake.js';
import { enqueueJob } from '../agent/core.js';
import { agentRouteAllowlist } from '../agent/tools/index.js';
import { mintRunToken, revokeRunToken } from '../agent/principal.js';
import type { NewClaimDraft } from '../intake/newClaimDraft.js';
import { ensureDefaultLogin } from '../services/auth.js';
import { DEFAULT_LOGIN } from '../config.js';

const NOW = '2026-10-07T09:00:00.000Z';
const OWNER = 'handler'; // the test app's default (header-auth) user

let t: TestApp;
let claimId: string;

beforeEach(async () => {
  t = await createTestApp(NOW, { config: { aiDriverOverride: 'fake' } });
  const r = await t.api<{ id: string }>('POST', '/claims', FNOL);
  expect(r.status).toBe(201);
  claimId = r.body.id;
});
afterEach(async () => {
  await t.close();
});

function multipart(file: { filename: string; mime: string; content: Buffer }, fields: Record<string, string> = {}) {
  const boundary = '----intake-apply-boundary';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`), file.content, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function uploadPdf(lines: string[][], fields: Record<string, string> = {}): Promise<string> {
  const m = multipart({ filename: 'document.pdf', mime: 'application/pdf', content: await makeTextPdf(lines) }, fields);
  const res = await t.app.inject({ method: 'POST', url: '/api/intake', payload: m.payload, headers: m.headers });
  expect(res.statusCode).toBe(201);
  return (JSON.parse(res.body) as { items: Array<{ id: string }> }).items[0]!.id;
}

const v5cOnClaim = () => uploadPdf([['INTAKE-FIXTURE-V5C', 'Registration mark KX21 ABC']], { claimId });

function claimVehicle() {
  const c = t.ctx.repos.requireClaim(t.ctx.db, claimId);
  return t.ctx.repos.getVehicle(t.ctx.db, c.clientVehicleId)!;
}
function claimant() {
  const c = t.ctx.repos.requireClaim(t.ctx.db, claimId);
  return t.ctx.repos.getParty(t.ctx.db, c.claimantId)!;
}

describe('automatic fills', () => {
  it('empty + confident + valid + not sensitive → applied through the routes as agent:intake, with the source in the audit', async () => {
    const itemId = await v5cOnClaim();
    await drainIntake(t.ctx, NOW);
    const v = claimVehicle();
    expect(v).toMatchObject({ vin: 'WVWZZZ1JZXW000001', colour: 'Blue', monthOfFirstRegistration: '2021-03', model: 'Yaris' });
    const item = t.ctx.repos.requireIntakeItem(t.ctx.db, itemId);
    const applied = auditRows(t.ctx, 'intake.apply');
    expect(applied.map((a) => a.after.target).sort()).toEqual(['vehicle:client.colour', 'vehicle:client.firstRegistered', 'vehicle:client.vin']);
    for (const a of applied) {
      expect(a.user_id).toBe('agent:intake');
      expect(a.run_id).toBeTruthy();
      expect(a.after).toMatchObject({ claimId, intakeItemId: itemId, evidenceId: item.evidenceId, page: 1, policy: 'auto', confirmedBy: null });
      expect(String(a.after.quote)).toBeTruthy();
    }
    // The existing route wrote its own audit row as the agent (vehicle.update), with the provenance it was given.
    const routeRows = auditRows(t.ctx, 'vehicle.update').filter((r) => r.user_id === 'agent:intake');
    expect(routeRows.length).toBe(3);
    // The vehicle's lookup records say where the values came from (unverified).
    expect(v.lookups.some((l) => JSON.stringify(l).includes(itemId))).toBe(true);
  });

  it('every write route intake uses is on the agent allow-list (declared by claim_field_apply)', () => {
    const allow = agentRouteAllowlist();
    for (const r of ['PATCH /api/claims/:id', 'PATCH /api/vehicles/:id', 'PATCH /api/parties/:id', 'POST /api/vehicles', 'POST /api/parties', 'POST /api/claims/:id/events', 'POST /api/proposals/apply']) expect(allow.has(r), r).toBe(true);
    expect(allow.has('POST /api/proposals/reject')).toBe(false);
    expect(allow.has('POST /api/claims/:id/status')).toBe(false);
  });
});

describe('confirmations', () => {
  it('overwrite, sensitive and low-confidence values go to ONE grouped confirm_fields card', async () => {
    const itemId = await v5cOnClaim();
    await drainIntake(t.ctx, NOW);
    const cards = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'confirm_fields' });
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card).toMatchObject({ claimId, status: 'open', title: 'V5C: 3 fields filled, 3 need you', dedupeKey: `confirm_fields:${itemId}` });
    const payload = card.payload as { itemId: string; proposals: Array<{ target: string; sensitive: boolean; reasons: string[]; currentValue: string | null }> };
    expect(payload.itemId).toBe(itemId);
    const byTarget = Object.fromEntries(payload.proposals.map((p) => [p.target, p]));
    expect(Object.keys(byTarget).sort()).toEqual(['party:client.address', 'party:client.dateOfBirth', 'vehicle:client.model']);
    expect(byTarget['party:client.dateOfBirth']!.sensitive).toBe(true);
    expect(byTarget['vehicle:client.model']!.currentValue).toBe('Yaris');
    expect(byTarget['party:client.address']!.reasons.join(' ')).toMatch(/confidence 70%/);
    expect(t.ctx.repos.requireIntakeItem(t.ctx.db, itemId).status).toBe('needs_you');
    // Nothing that needs the owner was written.
    expect(claimant().dateOfBirth).toBeUndefined();
    expect(claimVehicle().model).toBe('Yaris');
    // A re-run of apply does not raise a second card.
    const again = await t.api('POST', `/intake/${itemId}/retry`, { from: 'apply' });
    expect(again.status).toBe(200);
    await drainIntake(t.ctx, NOW);
    expect(t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'confirm_fields' })).toHaveLength(1);
  });

  it('the resolver applies the ticked values AS THE OWNER through the routes and rejects the rest with the reason', async () => {
    const itemId = await v5cOnClaim();
    await drainIntake(t.ctx, NOW);
    const card = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'confirm_fields' })[0]!;
    const ps = (card.payload as { proposals: Array<{ id: string; target: string }> }).proposals;
    const id = (target: string) => ps.find((p) => p.target === target)!.id;
    const res = await t.api('POST', `/needs-you/${card.id}/resolve`, { optionId: 'apply', edits: { apply: [id('party:client.dateOfBirth'), id('vehicle:client.model')] }, note: 'The address on the V5C is an old one' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(claimant().dateOfBirth).toBe('1990-04-12');
    expect(claimVehicle().model).toBe('Yaris Icon');
    expect(claimant().address?.line1).toBe('12 High Street');
    const rejected = t.ctx.repos.getClaimUpdateProposal(t.ctx.db, id('party:client.address'))!;
    expect(rejected).toMatchObject({ status: 'rejected', decidedBy: OWNER });
    expect(rejected.validator?.decision?.reason).toBe('The address on the V5C is an old one');
    // Audited as the owner — both intake's row and the routes' own rows.
    const ownerApplied = auditRows(t.ctx, 'intake.apply').filter((a) => a.after.policy === 'confirm');
    expect(ownerApplied.map((a) => a.user_id)).toEqual([OWNER, OWNER]);
    expect(ownerApplied.every((a) => a.after.confirmedBy === OWNER)).toBe(true);
    expect(auditRows(t.ctx, 'party.patch').some((a) => a.user_id === OWNER)).toBe(true);
    expect(auditRows(t.ctx, 'intake.reject')[0]).toMatchObject({ user_id: OWNER, after: { reason: 'The address on the V5C is an old one' } });
    expect(t.ctx.repos.requireIntakeItem(t.ctx.db, itemId).status).toBe('applied');
    expect(t.ctx.repos.getNeedsYouItem(t.ctx.db, card.id)?.status).toBe('resolved');
  });

  it('"Reject all" needs a reason and rejects every pending value', async () => {
    await v5cOnClaim();
    await drainIntake(t.ctx, NOW);
    const card = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'confirm_fields' })[0]!;
    expect((await t.api('POST', `/needs-you/${card.id}/resolve`, { optionId: 'reject' })).status).toBe(400);
    expect((await t.api('POST', `/needs-you/${card.id}/resolve`, { optionId: 'reject', note: 'Wrong vehicle entirely' })).status).toBe(200);
    expect(t.ctx.repos.listClaimUpdateProposals(t.ctx.db, { claimId, status: 'pending' })).toHaveLength(0);
    expect(t.ctx.repos.listClaimUpdateProposals(t.ctx.db, { claimId, status: 'rejected' }).length).toBe(3);
  });

  it('the Intake screen routes: apply (owner, with an edited value) and reject; the card closes when nothing is left', async () => {
    const itemId = await v5cOnClaim();
    await drainIntake(t.ctx, NOW);
    const pending = (await t.api<{ items: Array<{ id: string; target: string; label: string }> }>('GET', `/claims/${claimId}/proposals?status=pending`)).body.items;
    expect(pending).toHaveLength(3);
    const dob = pending.find((p) => p.target === 'party:client.dateOfBirth')!;
    const applied = await t.api<{ results: Array<{ ok: boolean }> }>('POST', '/proposals/apply', { ids: [dob.id], values: { [dob.id]: '13/04/1990' } });
    expect(applied.status).toBe(200);
    expect(applied.body.results[0]!.ok).toBe(true);
    expect(claimant().dateOfBirth).toBe('1990-04-13');
    expect((await t.api('POST', '/proposals/reject', { ids: pending.filter((p) => p.id !== dob.id).map((p) => p.id), reason: 'no' })).status).toBe(400);
    expect((await t.api('POST', '/proposals/reject', { ids: pending.filter((p) => p.id !== dob.id).map((p) => p.id), reason: 'Not this document' })).status).toBe(200);
    expect(t.ctx.repos.findOpenNeedsYouByDedupeKey(t.ctx.db, `confirm_fields:${itemId}`)).toBeUndefined();
    expect(t.ctx.repos.requireIntakeItem(t.ctx.db, itemId).status).toBe('applied');
  });
});

describe('never, kill switch and agents', () => {
  it('a target that cannot apply is refused (never); targets outside the closed union are invalid input', () => {
    const r = proposeField(t.ctx, { claimId, target: 'vehicle:client.registration', value: 'ZZ99 ZZZ', confidence: 0.99, source: { evidenceId: 'ev-x', page: 1, quote: 'ZZ99 ZZZ' } });
    expect(r.kind).toBe('proposed');
    if (r.kind !== 'proposed') return;
    expect(r.proposal).toMatchObject({ policyDecision: 'never', status: 'rejected', decidedBy: 'agent:intake' });
    expect(r.proposal.validator?.decision?.reason).toMatch(/never changed from a document/);
    expect(claimFieldProposeInput.safeParse({ claimId, target: 'claim.status', value: 'settled', confidence: 1, source: { evidenceId: 'e', page: null, quote: null } }).success).toBe(false);
    expect(claimFieldProposeInput.safeParse({ claimId, target: 'claim.liability', value: 'admitted', confidence: 1, source: { evidenceId: 'e', page: null, quote: null } }).success).toBe(false);
    expect(proposeField(t.ctx, { claimId, target: 'ledger.paid', value: '100', confidence: 1, source: {} })).toMatchObject({ kind: 'skipped' });
  });

  it('claim_field_propose works only for the claim the document is on (a claimless document proposes nothing)', async () => {
    const itemId = await uploadPdf([['A letter with no claim', 'nothing else to read here']]);
    const item = t.ctx.repos.requireIntakeItem(t.ctx.db, itemId);
    const job = enqueueJob(t.ctx, { type: 'intake.extract', payload: { itemId }, idempotencyKey: `test-extract:${itemId}`, createdBy: 'test' });
    const tool = intakeTools.find((x) => x.name === 'claim_field_propose')!;
    const rc = { runId: 'r', jobId: job.id, agent: 'intake' as const, token: 't', allowedTools: new Set(['claim_field_propose']), runDir: '/tmp', correlationId: 'c' };
    const input = { claimId, target: 'vehicle:client.vin', value: 'WVWZZZ1JZXW000001', confidence: 0.99, source: { evidenceId: item.evidenceId, page: 1, quote: 'VIN' } };
    await expect(tool.run!(input, rc, t.ctx)).rejects.toMatchObject({ code: 'NO_CLAIM' });
    expect(t.ctx.repos.listClaimUpdateProposals(t.ctx.db, { claimId })).toHaveLength(0);
  });

  it('agents never apply a confirmation; with the kill switch on nothing is automatic', async () => {
    const confirm = proposeField(t.ctx, { claimId, target: 'party:client.dateOfBirth', value: '1990-04-12', confidence: 0.99, source: {} });
    if (confirm.kind !== 'proposed') throw new Error('expected a proposal');
    expect(confirm.proposal.policyDecision).toBe('confirm');
    const out = await applyProposal(t.ctx, confirm.proposal, agentApplier(t.ctx, { claimId, jobId: 'job-test' }));
    expect(out).toMatchObject({ ok: false, error: { code: 'NEEDS_OWNER' } });

    t.ctx.repos.patchAgentSettings(t.ctx.db, { autonomy: { killSwitch: true } }, { userId: 'test' });
    const vin = proposeField(t.ctx, { claimId, target: 'vehicle:client.vin', value: 'WVWZZZ1JZXW000001', confidence: 0.99, source: {} });
    if (vin.kind !== 'proposed') throw new Error('expected a proposal');
    expect(vin.proposal.policyDecision).toBe('confirm');
    expect(vin.proposal.validator?.policy?.ruleIds).toContain('kill_switch');
  });

  it('an agent run may apply automatic proposals on its own claim through POST /proposals/apply, nothing else', async () => {
    const auto = proposeField(t.ctx, { claimId, target: 'vehicle:client.colour', value: 'Red', confidence: 0.97, source: { page: 1, quote: 'Colour RED' } });
    const sensitive = proposeField(t.ctx, { claimId, target: 'party:client.dateOfBirth', value: '1990-04-12', confidence: 0.99, source: {} });
    if (auto.kind !== 'proposed' || sensitive.kind !== 'proposed') throw new Error('expected proposals');
    expect(auto.proposal.policyDecision).toBe('auto');
    const token = mintRunToken({ name: 'intake', runId: 'run-agent-test', jobId: 'job-agent-test', claimScope: claimId }, 60_000);
    try {
      const call = (ids: string[]) => t.app.inject({ method: 'POST', url: '/api/proposals/apply', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: JSON.stringify({ ids }) });
      const refused = await call([sensitive.proposal.id]);
      expect(refused.statusCode).toBe(403);
      const ok = await call([auto.proposal.id]);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(claimVehicle().colour).toBe('Red');
      expect(auditRows(t.ctx, 'intake.apply').at(-1)).toMatchObject({ user_id: 'agent:intake', run_id: 'run-agent-test' });
      const reject = await t.app.inject({ method: 'POST', url: '/api/proposals/reject', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: JSON.stringify({ ids: [sensitive.proposal.id], reason: 'agent tries' }) });
      expect(reject.statusCode).toBe(403);
    } finally {
      revokeRunToken(token);
    }
  });
});

describe('new claim from files (§G.3)', () => {
  it('an FNOL-like document with no claim raises new_claim; the draft is accepted by POST /claims once the owner adds the account', async () => {
    const itemId = await uploadPdf([['INTAKE-FIXTURE-FNOL', 'Accident report form'], ['Other vehicle GH70 JKL']]);
    await drainIntake(t.ctx, NOW);
    const item = t.ctx.repos.requireIntakeItem(t.ctx.db, itemId);
    expect(item).toMatchObject({ status: 'needs_you', docType: 'fnol_form' });
    expect(item.claimId).toBeUndefined();
    const card = t.ctx.repos.findOpenNeedsYouByDedupeKey(t.ctx.db, `new_claim:${itemId}`)!;
    expect(card.kind).toBe('new_claim');
    expect(t.ctx.repos.listClaimUpdateProposals(t.ctx.db, { intakeItemId: itemId })).toHaveLength(0); // nothing proposed without a claim

    const draftRes = await t.api<NewClaimDraft>('POST', '/intake/new-claim-draft', { itemIds: [itemId] });
    expect(draftRes.status).toBe(201);
    const draft = draftRes.body;
    expect(draft.body).toMatchObject({
      claimant: { kind: 'individual', name: 'Daniel Okafor', phone: '07700 900456', email: 'd.okafor@example.test', dateOfBirth: '1985-07-30', drivingLicenceNumber: 'OKAFO807305D99XY', address: { line1: '4 Mill Lane', town: 'Bristol', postcode: 'BS1 4XY' }, roles: ['claimant', 'driver'] },
      vehicle: { registration: 'AB19CDE', make: 'Ford', model: 'Focus', ownership: 'client' },
      accident: { occurredAt: '2026-10-05T13:30:00.000Z', location: 'Station Road, Bristol' },
      thirdParty: { registration: 'GH70JKL', driverName: 'Peter Lane', insurerPolicyNumber: 'POL12345678' },
    });
    expect(draft.body.driver).toBeUndefined();
    expect(draft.sources['vehicle.registration']).toMatchObject({ itemId, evidenceId: item.evidenceId, page: 1, quote: 'Your vehicle: AB19 CDE', confidence: 0.98, label: 'from Accident report form, page 1' });
    expect(draft.sources['thirdParty.registration']?.label).toBe('from Accident report form, page 2');
    expect(draft.stillNeeded.join(' ')).toMatch(/taken cold/);
    expect((await t.api<NewClaimDraft>('GET', `/intake/new-claim-draft/${draft.id}`)).body.id).toBe(draft.id);

    // The owner takes the account cold and answers the script questions in the wizard, then creates the claim.
    const body = { ...draft.body, accident: { ...draft.body.accident, circumstances: 'The client says the other car pulled out of a side road and hit the front of their car.' }, liability: 'unknown', callRecordingDisclosed: true };
    const created = await t.api<{ id: string; reference: string }>('POST', '/claims', body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const claim = t.ctx.repos.requireClaim(t.ctx.db, created.body.id);
    expect(t.ctx.repos.getParty(t.ctx.db, claim.claimantId)).toMatchObject({ name: 'Daniel Okafor', dateOfBirth: '1985-07-30' });
    expect(t.ctx.repos.getVehicle(t.ctx.db, claim.clientVehicleId)?.registration).toBe('AB19CDE');
  });

  it('new_claim resolver: "Prepare a new claim" stores a draft on the item; "Attach to a claim" re-runs apply on that claim', async () => {
    const itemId = await uploadPdf([['INTAKE-FIXTURE-FNOL', 'Accident report form completed by the client']]);
    await drainIntake(t.ctx, NOW);
    const card = t.ctx.repos.findOpenNeedsYouByDedupeKey(t.ctx.db, `new_claim:${itemId}`)!;
    expect((await t.api('POST', `/needs-you/${card.id}/resolve`, { optionId: 'start' })).status).toBe(200);
    const draftId = (t.ctx.repos.requireIntakeItem(t.ctx.db, itemId).normalised as { newClaimDraftId?: string }).newClaimDraftId;
    expect(draftId).toBeTruthy();
    expect((await t.api<NewClaimDraft>('GET', `/intake/new-claim-draft/${draftId}`)).body.itemIds).toEqual([itemId]);

    const other = await uploadPdf([['INTAKE-FIXTURE-FNOL', 'second copy']]);
    await drainIntake(t.ctx, NOW);
    const card2 = t.ctx.repos.findOpenNeedsYouByDedupeKey(t.ctx.db, `new_claim:${other}`)!;
    expect((await t.api('POST', `/needs-you/${card2.id}/resolve`, { optionId: 'attach' })).status).toBe(400); // needs the claim
    expect((await t.api('POST', `/needs-you/${card2.id}/resolve`, { optionId: 'attach', edits: { claimId } })).status).toBe(200);
    expect(t.ctx.repos.requireIntakeItem(t.ctx.db, other).claimId).toBe(claimId);
    await drainIntake(t.ctx, NOW);
    const proposals = t.ctx.repos.listClaimUpdateProposals(t.ctx.db, { intakeItemId: other });
    expect(proposals.length).toBeGreaterThan(0);
    // A different client name on the claim is an overwrite → owner; a new third party is a new record → owner.
    expect(proposals.find((p) => p.target === 'party:client.name')).toMatchObject({ policyDecision: 'confirm', currentValue: 'Amina Yusuf' });
    expect(proposals.find((p) => p.target === 'party:third_party.name')).toMatchObject({ policyDecision: 'confirm' });
    expect(t.ctx.repos.findOpenNeedsYouByDedupeKey(t.ctx.db, `confirm_fields:${other}`)).toBeTruthy();
  });
});

describe('as the signed-in owner (session cookies)', () => {
  it('the confirm_fields resolver forwards the owner’s own session to the routes', async () => {
    await t.close();
    t = await createTestApp(NOW, { config: { aiDriverOverride: 'fake', authMode: 'session' } });
    await ensureDefaultLogin(t.ctx);
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: DEFAULT_LOGIN.username, password: DEFAULT_LOGIN.password } });
    expect(login.statusCode).toBe(200);
    const raw = login.headers['set-cookie'];
    const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!;
    const me = JSON.parse((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).body) as { id?: string; user?: { id: string } };
    const ownerId = me.user?.id ?? me.id!;
    const created = await t.app.inject({ method: 'POST', url: '/api/claims', headers: { cookie, 'content-type': 'application/json' }, payload: JSON.stringify(FNOL) });
    expect(created.statusCode).toBe(201);
    claimId = (JSON.parse(created.body) as { id: string }).id;
    const m = multipart({ filename: 'v5c.pdf', mime: 'application/pdf', content: await makeTextPdf([['INTAKE-FIXTURE-V5C', 'Registration mark KX21 ABC']]) }, { claimId });
    expect((await t.app.inject({ method: 'POST', url: '/api/intake', payload: m.payload, headers: { ...m.headers, cookie } })).statusCode).toBe(201);
    await drainIntake(t.ctx, NOW);
    const card = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'confirm_fields' })[0]!;
    const dob = (card.payload as { proposals: Array<{ id: string; target: string }> }).proposals.find((p) => p.target === 'party:client.dateOfBirth')!;
    const res = await t.app.inject({ method: 'POST', url: `/api/needs-you/${card.id}/resolve`, headers: { cookie, 'content-type': 'application/json' }, payload: JSON.stringify({ optionId: 'apply', edits: { apply: [dob.id] }, note: 'Only the date of birth is right' }) });
    expect(res.statusCode, res.body).toBe(200);
    expect(claimant().dateOfBirth).toBe('1990-04-12');
    expect(auditRows(t.ctx, 'party.patch').at(-1)?.user_id).toBe(ownerId);
    expect(auditRows(t.ctx, 'intake.apply').at(-1)).toMatchObject({ user_id: ownerId, after: { confirmedBy: ownerId } });
  });
});
