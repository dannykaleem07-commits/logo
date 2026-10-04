import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERIMETER_FLAG_INJURY, type Claim, type Clock, type GateResult, type PlaybookAction, type CaseAcceptance, type LedgerEntry } from '@ccguk/domain';
import { createTestApp, FNOL, type TestApp } from './helpers.js';

type Created = { claim: Claim; intake: { validation: { ok: boolean }; crossFile: { severity: string; duplicateClaimIds: string[] }; liability: { score: number }; injury?: { feeTaken: false; referredTo: string }; offer?: { id: string; replyDueBy: string }; flags: Array<{ code: string; severity: string }> } };

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp('2026-10-05T09:00:00.000Z');
});
afterEach(async () => {
  await t.close();
});

describe('health and auth placeholder', () => {
  it('reports health with a request id', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.json()).toMatchObject({ ok: true, database: 'ok' });
  });

  it('rejects an unknown X-User-Id and accepts the default handler', async () => {
    const bad = await t.api('GET', '/claims', undefined, { 'x-user-id': 'nobody' });
    expect(bad.status).toBe(401);
    const ok = await t.api('GET', '/claims');
    expect(ok.status).toBe(200);
  });

  it('maps zod errors to 400 VALIDATION with details', async () => {
    const res = await t.api<{ error: { code: string; details: unknown[] } }>('POST', '/claims', { accident: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it('maps unknown ids to 404', async () => {
    const res = await t.api<{ error: { code: string } }>('GET', '/claims/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('claims: FNOL → bundle → clocks/gates/actions', () => {
  it('creates a claim and serves the full view with derived data', async () => {
    const created = await t.api<Created>('POST', '/claims', FNOL);
    expect(created.status).toBe(201);
    const { claim, intake } = created.body;
    expect(claim.reference).toMatch(/^CCG-2026-\d{5}$/);
    expect(claim.status).toBe('fnol');
    expect(intake.validation.ok).toBe(true);
    expect(intake.crossFile.severity).toBe('none');
    expect(intake.liability.score).toBeGreaterThan(50); // CCTV available bumps the unknown baseline

    const view = await t.api<{ claim: Claim; clocks: Clock[]; gates: GateResult[]; actions: PlaybookAction[]; acceptance: CaseAcceptance; events: unknown[] }>('GET', `/claims/${claim.id}`);
    expect(view.status).toBe(200);
    expect(view.body.claim.id).toBe(claim.id);
    expect(view.body.events.length).toBe(1);
    expect(view.body.clocks.some((c) => c.kind === 'gta_4_1_ncaf_1wd' && c.status === 'running')).toBe(true);
    expect(view.body.gates.map((g) => g.gate)).toContain('liability');
    expect(view.body.actions.map((a) => a.code)).toEqual(expect.arrayContaining(['SEND_NCAF', 'REQUEST_CCTV']));
    expect(['accept', 'accept_with_conditions', 'decline']).toContain(view.body.acceptance.decision);

    const clocks = await t.api<{ clocks: Clock[] }>('GET', `/claims/${claim.id}/clocks`);
    expect(clocks.body.clocks.length).toBeGreaterThan(0);
    const gates = await t.api<{ gates: GateResult[] }>('GET', `/claims/${claim.id}/gates`);
    expect(gates.body.gates.length).toBe(8);
    const actions = await t.api<{ actions: PlaybookAction[] }>('GET', `/claims/${claim.id}/actions`);
    expect(actions.body.actions.length).toBeGreaterThan(0);
    const acceptance = await t.api<CaseAcceptance>('GET', `/claims/${claim.id}/acceptance`);
    expect(acceptance.body.liabilityScore).toBe(intake.liability.score);

    // every mutation writes an audit row
    const audit = await t.api<{ entries: Array<{ action: string }> }>('GET', `/claims/${claim.id}/audit`);
    expect(audit.body.entries.map((e) => e.action)).toContain('claim.create');
  });

  it('lists and searches claims, and changes status with audit', async () => {
    const created = await t.api<Created>('POST', '/claims', FNOL);
    const list = await t.api<{ items: Array<{ id: string; claimantName: string; registration: string }>; total: number }>('GET', '/claims?search=KX21');
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({ id: created.body.claim.id, claimantName: 'Amina Yusuf', registration: 'KX21ABC' });

    const status = await t.api<Claim>('POST', `/claims/${created.body.claim.id}/status`, { status: 'accepted', reason: 'Liability clear, evidence gates amber' });
    expect(status.status).toBe(200);
    expect(status.body.status).toBe('accepted');
    const audit = await t.api<{ entries: Array<{ action: string }> }>('GET', `/claims/${created.body.claim.id}/audit`);
    expect(audit.body.entries.map((e) => e.action)).toContain('claim.status');

    const patched = await t.api<Claim>('PATCH', `/claims/${created.body.claim.id}`, { liability: 'admitted', atFaultInsurerRef: 'EX/123456' });
    expect(patched.body.liability).toBe('admitted');
    expect(patched.body.atFaultInsurerRef).toBe('EX/123456');
  });

  it('rejects an FNOL missing mandatory fields', async () => {
    const res = await t.api<{ error: { code: string; details: { missing: string[] } } }>('POST', '/claims', { ...FNOL, accident: { ...FNOL.accident, circumstances: 'Hit' } });
    expect(res.status).toBe(400);
    expect(res.body.error.details.missing.join(' ')).toMatch(/circumstances/);
  });
});

describe('cross-file registration check', () => {
  it('links a second claim on the same registration and raises DUPLICATE_REGISTRATION', async () => {
    const first = await t.api<Created>('POST', '/claims', FNOL);
    const second = await t.api<Created>('POST', '/claims', { ...FNOL, claimant: { ...FNOL.claimant, name: 'Bilal Yusuf', phone: '07700 900999', email: 'bilal@example.com' } });
    expect(second.status).toBe(201);
    expect(second.body.intake.crossFile.duplicateClaimIds).toEqual([first.body.claim.id]);
    expect(second.body.claim.flags.map((f) => f.code)).toContain('DUPLICATE_REGISTRATION');
    expect(second.body.claim.linkedClaimIds).toEqual([first.body.claim.id]);
    const refreshedFirst = await t.api<{ claim: Claim }>('GET', `/claims/${first.body.claim.id}`);
    expect(refreshedFirst.body.claim.linkedClaimIds).toEqual([second.body.claim.id]);
  });

  it('hard-stops a fleet unit presented as the client vehicle', async () => {
    // Register a fleet unit on KX21 ABC first.
    const fleetVehicle = t.ctx.repos.upsertVehicle(t.ctx.db, { registration: 'KX21ABC', make: 'Toyota', model: 'Yaris', ownership: 'fleet' });
    t.ctx.repos.createFleetUnit(t.ctx.db, { vehicleId: fleetVehicle.id, declaredUses: ['credit_hire'], dailyRatePence: 4980, gtaGroup: 'S1' });
    const res = await t.api<Created>('POST', '/claims', FNOL);
    expect(res.status).toBe(201);
    const flag = res.body.claim.flags.find((f) => f.code === 'FLEET_UNIT_AS_CLIENT_VEHICLE');
    expect(flag?.severity).toBe('block');
    // Progression is refused until the hard stop is cleared with a reason.
    const blocked = await t.api<{ error: { code: string } }>('POST', `/claims/${res.body.claim.id}/status`, { status: 'accepted' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('HARD_STOP');
  });
});

describe('injury routing and script-guard offer capture', () => {
  it('creates the injury referral (no fee) as a flag + task and records the FNOL offer in the register', async () => {
    const res = await t.api<Created>('POST', '/claims', {
      ...FNOL,
      accident: { ...FNOL.accident, injuries: true },
      injuryReferralTo: 'Example PI Solicitors LLP',
      interventionOffer: { offerorName: 'Example Insurance plc', channel: 'phone', receivedAt: '2026-10-05T08:30:00.000Z', dailyRatePence: 2037, vehicleClassOffered: 'small hatchback' },
    });
    expect(res.status).toBe(201);
    const { claim, intake } = res.body;
    expect(claim.injuryReferral).toMatchObject({ referredTo: 'Example PI Solicitors LLP', feeTaken: false });
    expect(claim.flags.map((f) => f.code)).toContain('INJURY_REFERRAL');
    expect(intake.injury?.feeTaken).toBe(false);

    const events = await t.api<{ events: Array<{ type: string; data?: Record<string, unknown> }> }>('GET', `/claims/${claim.id}/events`);
    expect(events.body.events.some((e) => e.type === 'note' && e.data?.task === 'INJURY_REFERRAL')).toBe(true);
    expect(events.body.events.some((e) => e.type === 'intervention_offer')).toBe(true);

    const offers = await t.api<{ offers: Array<{ id: string; offerorName: string; dailyRatePence: number; clientDecision: string }>; replyClocks: Clock[] }>('GET', `/claims/${claim.id}/offers`);
    expect(offers.body.offers).toHaveLength(1);
    expect(offers.body.offers[0]).toMatchObject({ offerorName: 'Example Insurance plc', dailyRatePence: 2037, clientDecision: 'pending' });
    expect(intake.offer?.id).toBe(offers.body.offers[0]!.id);
    // 1 working day reply clock: received Mon 5 Oct 2026 → due Tue 6 Oct 2026.
    expect(new Date(offers.body.replyClocks[0]!.dueAt).toISOString().slice(0, 10)).toBe('2026-10-06');
    expect(offers.body.replyClocks[0]?.status).toBe('running');

    // Decision + reply → event and clock met (advance the clock past the reply instant).
    t.setNow('2026-10-05T17:00:00.000Z');
    const patched = await t.api<{ offer: { clientDecision: string; replySentAt: string }; replyClock: Clock }>('PATCH', `/claims/${claim.id}/offers/${offers.body.offers[0]!.id}`, {
      clientDecision: 'declined',
      clientReasons: 'Offered vehicle two groups smaller than the client car; no delivery; needed for school run with child seats.',
      replySentAt: '2026-10-05T16:00:00.000Z',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.offer.clientDecision).toBe('declined');
    expect(patched.body.replyClock.status).toBe('met');
    const events2 = await t.api<{ events: Array<{ type: string }> }>('GET', `/claims/${claim.id}/events`);
    expect(events2.body.events.some((e) => e.type === 'intervention_reply_sent')).toBe(true);

    const acceptance = await t.api<CaseAcceptance>('GET', `/claims/${claim.id}/acceptance`);
    expect(acceptance.body.perimeterFlags).toContain(PERIMETER_FLAG_INJURY);
  });

  it('refuses the script-guard violation (client told to ignore an offer)', async () => {
    const res = await t.api<{ error: { code: string } }>('POST', '/claims', { ...FNOL, interventionOffer: { offerorName: 'X', clientToldToIgnore: true } });
    expect(res.status).toBe(400);
  });
});

describe('ledger', () => {
  it('appends, sums and refuses update/delete with 409', async () => {
    const created = await t.api<Created>('POST', '/claims', FNOL);
    const id = created.body.claim.id;
    const entry = await t.api<LedgerEntry>('POST', `/claims/${id}/ledger`, { head: 'hire', kind: 'claimed', amountPence: 114540, vatPence: 22908, date: '2026-09-02', description: 'Hire 23 days at £49.80' });
    expect(entry.status).toBe(201);
    expect(entry.body.amountPence).toBe(114540);

    const list = await t.api<{ entries: LedgerEntry[]; position: { totals: { claimedPence: number } } }>('GET', `/claims/${id}/ledger`);
    expect(list.body.entries).toHaveLength(1);
    expect(list.body.position.totals.claimedPence).toBe(114540);

    const upd = await t.api<{ error: { code: string } }>('PATCH', `/claims/${id}/ledger/${entry.body.id}`, { amountPence: 1 });
    expect(upd.status).toBe(409);
    expect(upd.body.error.code).toBe('IMMUTABLE');
    const del = await t.api<{ error: { code: string } }>('DELETE', `/claims/${id}/ledger/${entry.body.id}`);
    expect(del.status).toBe(409);

    // The database triggers also refuse a direct update.
    expect(() => t.ctx.handle.sqlite.prepare('update ledger_entries set amount_pence = 1 where id = ?').run(entry.body.id)).toThrow();

    // A correction is a new row that supersedes the old one.
    const corr = await t.api<LedgerEntry>('POST', `/claims/${id}/ledger`, { head: 'hire', kind: 'claimed', amountPence: 111200, date: '2026-09-02', description: 'Corrected hire claimed', supersedesId: entry.body.id });
    expect(corr.status).toBe(201);
    const after = await t.api<{ entries: LedgerEntry[] }>('GET', `/claims/${id}/ledger`);
    expect(after.body.entries.map((e) => e.id)).toEqual([corr.body.id]);
  });
});

describe('recovery', () => {
  it('writes a claimed ledger entry equal to 9000 + 300 × miles + 2500 (+VAT)', async () => {
    const created = await t.api<Created>('POST', '/claims', FNOL);
    const id = created.body.claim.id;
    const res = await t.api<{ recovery: { loadedMiles: number }; ledgerEntry: LedgerEntry; charge: { netPence: number; vatPence: number; grossPence: number } }>('POST', `/claims/${id}/recovery`, {
      at: '2026-10-03T10:00:00.000Z',
      fromLocation: 'A329 London Road, Reading',
      toLocation: 'CCGUK yard',
      loadedMiles: 12,
    });
    expect(res.status).toBe(201);
    const expectedNet = 9000 + 300 * 12 + 2500; // 15100
    expect(res.body.charge.netPence).toBe(expectedNet);
    expect(res.body.charge.vatPence).toBe(Math.round(expectedNet * 0.2));
    expect(res.body.charge.grossPence).toBe(expectedNet + Math.round(expectedNet * 0.2));
    expect(res.body.ledgerEntry).toMatchObject({ head: 'recovery', kind: 'claimed', amountPence: expectedNet, vatPence: Math.round(expectedNet * 0.2) });
    const ledger = await t.api<{ entries: LedgerEntry[] }>('GET', `/claims/${id}/ledger?head=recovery`);
    expect(ledger.body.entries).toHaveLength(1);
    const events = await t.api<{ events: Array<{ type: string }> }>('GET', `/claims/${id}/events?type=recovery`);
    expect(events.body.events).toHaveLength(1);
  });
});

describe('hire, storage and event side effects', () => {
  async function seedFleet() {
    const v = t.ctx.repos.upsertVehicle(t.ctx.db, { registration: 'CC26HIR', make: 'Kia', model: 'Picanto', ownership: 'fleet' });
    const policy = t.ctx.repos.createPolicy(t.ctx.db, { insurerName: 'Fleet Insurer Ltd', policyNumber: 'FL-001', coveredUses: ['credit_hire', 'self_drive'], startDate: '2026-01-01', endDate: '2026-12-31' });
    const unit = t.ctx.repos.createFleetUnit(t.ctx.db, { vehicleId: v.id, declaredUses: ['credit_hire'], policyId: policy.id, dailyRatePence: 4232, gtaGroup: 'S1' });
    return unit;
  }

  it('creates hire via fleet allocation guard, ends it on repair completion and marks the off-hire clock met', async () => {
    const unit = await seedFleet();
    const created = await t.api<Created>('POST', '/claims', FNOL);
    const id = created.body.claim.id;

    const refused = await t.api<{ error: { code: string; details: { reasons: string[] } } }>('POST', `/claims/${id}/hire`, { fleetUnitId: unit.id, startAt: '2026-10-05T10:00:00.000Z', use: 'pco' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('ALLOCATION_REFUSED');

    const hire = await t.api<{ hire: { id: string; agreementNumber: string; endTrigger?: string }; enforceabilityGaps: string[] }>('POST', `/claims/${id}/hire`, {
      fleetUnitId: unit.id,
      startAt: '2026-10-05T10:00:00.000Z',
      odometerOut: 12000,
      enforceability: { cancellationInfoProvidedAt: '2026-10-05T10:00:00.000Z' },
    });
    expect(hire.status).toBe(201);
    expect(hire.body.enforceabilityGaps.length).toBeGreaterThan(0);
    const claimAfterHire = await t.api<{ claim: Claim }>('GET', `/claims/${id}`);
    expect(claimAfterHire.body.claim.flags.map((f) => f.code)).toContain('HIRE_ENFORCEABILITY_GAP');
    expect(t.ctx.repos.requireFleetUnit(t.ctx.db, unit.id).status).toBe('on_hire');

    // Second hire on the same unit is refused while it is on hire.
    const dup = await t.api<{ error: { code: string } }>('POST', `/claims/${id}/hire`, { fleetUnitId: unit.id, startAt: '2026-10-06T10:00:00.000Z' });
    expect(dup.status).toBe(409);

    // repair_completed → off-hire deadline (GTA 4.8, 24 h) stored as the expected end trigger + clock.
    t.setNow('2026-10-20T12:00:00.000Z');
    const ev = await t.api<{ effects: { offHire?: { trigger: string; dueAt: string; hireIds: string[] } }; clocks: Clock[] }>('POST', `/claims/${id}/events`, { type: 'repair_completed', at: '2026-10-20T11:00:00.000Z', summary: 'Repairs completed at the bodyshop', attributableTo: 'repairer' });
    expect(ev.status).toBe(201);
    expect(ev.body.effects.offHire).toMatchObject({ trigger: 'repair_complete_24h', hireIds: [hire.body.hire.id] });
    const offhire = ev.body.clocks.find((c) => c.kind === 'gta_4_8_offhire_repair_24h');
    expect(offhire?.status).toBe('running');
    expect(new Date(offhire!.dueAt).getTime() - new Date('2026-10-20T11:00:00.000Z').getTime()).toBe(24 * 3600 * 1000);
    // the clock cache is materialised for the dashboard
    expect(t.ctx.repos.listDueClocks(t.ctx.db, { dueBefore: '2026-10-22T00:00:00.000Z' }).some((c) => c.kind === 'gta_4_8_offhire_repair_24h')).toBe(true);
    expect(t.ctx.repos.requireHire(t.ctx.db, hire.body.hire.id).endTrigger).toBe('repair_complete_24h');

    const missingTrigger = await t.api<{ error: { code: string } }>('POST', `/claims/${id}/hire/${hire.body.hire.id}/end`, { endAt: '2026-10-21T09:00:00.000Z' });
    expect(missingTrigger.status).toBe(400);

    t.setNow('2026-10-21T10:00:00.000Z');
    const ended = await t.api<{ hire: { endAt: string; endTrigger: string }; calculation: { days: number }; clocks: Clock[] }>('POST', `/claims/${id}/hire/${hire.body.hire.id}/end`, {
      endTrigger: 'repair_complete_24h',
      endAt: '2026-10-21T09:00:00.000Z',
      odometerIn: 12420,
    });
    expect(ended.status).toBe(200);
    expect(ended.body.hire.endAt).toBe('2026-10-21T09:00:00.000Z');
    expect(ended.body.calculation.days).toBe(16);
    expect(ended.body.clocks.find((c) => c.kind === 'gta_4_8_offhire_repair_24h')?.status).toBe('met');
    const events = await t.api<{ events: Array<{ type: string; data?: Record<string, unknown> }> }>('GET', `/claims/${id}/events?type=hire_ended`);
    expect(events.body.events).toHaveLength(1);
    expect(events.body.events[0]!.data?.endTrigger).toBe('repair_complete_24h');
    expect(t.ctx.repos.requireFleetUnit(t.ctx.db, unit.id).status).toBe('available');
    const actions = await t.api<{ actions: PlaybookAction[] }>('GET', `/claims/${id}/actions`);
    expect(actions.body.actions.map((a) => a.code)).toContain('SEND_PAYMENT_PACK');
  });

  it('report_issued while storage is open adds the storage_report_plus_48h clock and SEND_COLLECT_OR_PAY flag', async () => {
    const created = await t.api<Created>('POST', '/claims', FNOL);
    const id = created.body.claim.id;
    const storage = await t.api<{ id: string; dailyRatePence: number }>('POST', `/claims/${id}/storage`, { location: 'CCGUK yard, Reading', startAt: '2026-10-03T11:00:00.000Z' });
    expect(storage.status).toBe(201);
    expect(storage.body.dailyRatePence).toBe(4500);

    t.setNow('2026-10-07T16:00:00.000Z');
    const ev = await t.api<{ effects: { flags: string[] }; clocks: Clock[] }>('POST', `/claims/${id}/events`, { type: 'report_issued', at: '2026-10-07T15:00:00.000Z', summary: "Engineer's report issued", attributableTo: 'engineer' });
    expect(ev.body.effects.flags).toContain('SEND_COLLECT_OR_PAY');
    const clock = ev.body.clocks.find((c) => c.kind === 'storage_report_plus_48h');
    expect(clock).toBeTruthy();
    expect(new Date(clock!.dueAt).toISOString()).toBe('2026-10-09T15:00:00.000Z');
    const view = await t.api<{ claim: Claim; actions: PlaybookAction[] }>('GET', `/claims/${id}`);
    expect(view.body.claim.flags.map((f) => f.code)).toContain('SEND_COLLECT_OR_PAY');
    expect(view.body.actions.map((a) => a.code)).toContain('SEND_COLLECT_OR_PAY');

    t.setNow('2026-10-09T12:00:00.000Z');
    const ended = await t.api<{ storage: { endAt: string }; charge: { days: number; netPence: number }; clocks: Clock[] }>('POST', `/claims/${id}/storage/${storage.body.id}/end`, { endAt: '2026-10-09T11:00:00.000Z', endTrigger: 'report_issued' });
    expect(ended.status).toBe(200);
    expect(ended.body.charge.days).toBe(6);
    expect(ended.body.charge.netPence).toBe(6 * 4500);
    // Ended within 48 h of the report: the clock is satisfied ('met' from the API supplement, 'stopped' from the domain engine).
    expect(['met', 'stopped']).toContain(ended.body.clocks.find((c) => c.kind === 'storage_report_plus_48h')?.status);
  });

  it('intervention_offer event creates the register entry', async () => {
    const created = await t.api<Created>('POST', '/claims', FNOL);
    const id = created.body.claim.id;
    const ev = await t.api<{ effects: { offer?: { id: string; offerorName: string } } }>('POST', `/claims/${id}/events`, { type: 'intervention_offer', at: '2026-10-05T10:00:00.000Z', summary: 'Insurer rang client offering a courtesy car', data: { offerorName: 'Example Insurance plc', channel: 'phone', dailyRatePence: 2037 } });
    expect(ev.body.effects.offer?.offerorName).toBe('Example Insurance plc');
    const offers = await t.api<{ offers: unknown[] }>('GET', `/claims/${id}/offers`);
    expect(offers.body.offers).toHaveLength(1);
  });
});

describe('vehicles, parties and lookups', () => {
  it('manual vehicle entry stores an unverified lookup; odometer append reports conflicts', async () => {
    const v = await t.api<{ id: string; lookups: Array<{ provider: string; verification: { status: string } }> }>('POST', '/vehicles', { registration: 'AB12 CDE', make: 'Honda', model: 'Jazz', odometer: [{ source: 'client', date: '2026-10-01', miles: 50000 }] });
    expect(v.status).toBe(201);
    expect(v.body.lookups[0]).toMatchObject({ provider: 'manual', verification: { status: 'unverified' } });
    const odo = await t.api<{ conflicts: Array<{ code: string }> }>('POST', `/vehicles/${v.body.id}/odometer`, { source: 'engineer', date: '2026-10-04', miles: 48000 });
    expect(odo.status).toBe(201);
    expect(odo.body.conflicts.some((c) => c.code === 'NON_MONOTONIC')).toBe(true);
    const conflicts = await t.api<{ conflicts: unknown[] }>('GET', `/vehicles/${v.body.id}/mileage-conflicts`);
    expect(conflicts.body.conflicts.length).toBeGreaterThan(0);
  });

  it('lookup without keys returns manual_required with the fields to show', async () => {
    const res = await t.api<{ status: string; fields: string[]; providers: Record<string, string> }>('POST', '/vehicles/lookup', { registration: 'KX21 ABC' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('manual_required');
    expect(res.body.fields).toContain('make');
    expect(res.body.providers).toEqual({ dvla_ves: 'no_key', dvsa_mot: 'no_key' });
  });

  it('party connections surface shared phone numbers and witness non-independence', async () => {
    const created = await t.api<Created>('POST', '/claims', FNOL);
    const witness = await t.api<{ id: string; connectionCandidates: Array<{ matchedOn: string[] }> }>('POST', '/parties', { kind: 'individual', name: 'Khalid Yusuf', phone: '07700 900123', roles: ['witness'] });
    expect(witness.status).toBe(201);
    expect(witness.body.connectionCandidates[0]?.matchedOn).toContain('phone');
    await t.api('PATCH', `/claims/${created.body.claim.id}`, { thirdPartyIds: [witness.body.id] });
    const conn = await t.api<{ connections: Array<{ field: string }>; witnessIndependence: Array<{ independent: boolean }> }>('GET', `/parties/${witness.body.id}/connections`);
    expect(conn.status).toBe(200);
    expect(conn.body.connections.some((c) => c.field === 'phone')).toBe(true);
    expect(conn.body.witnessIndependence[0]?.independent).toBe(false);
  });
});
