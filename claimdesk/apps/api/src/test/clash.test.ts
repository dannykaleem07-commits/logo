// owned by ap-clash
/**
 * Clash and eligibility API (docs/SUPREME-AUTOPILOT.md §C, §F, §J.4): the owner's example, enforcement through the
 * manager-mode gate (class A override, class C never), persistence (the sweep keeps an overridden finding overridden),
 * acknowledge / resolve (human-only), driver profiles, policy criteria, hire needs, eligibility, Needs-you resolvers,
 * the clash.check / clash.sweep handlers, the tools' shapes and the daily-log lines. No model, no network.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { Claim, ClashSubject, FleetUnit, Reservation } from '@ccguk/domain';
import { createTestApp, FNOL, type TestApp } from './helpers.js';
import { clashDailyLogLines, checkClashes, enforceClashes, persistFindings, runClashSweep } from '../clash/service.js';
import { gateFor, setManagerMode, STRICT_GATE } from '../services/override.js';
import { HttpError } from '../errors.js';
import { getJobHandler, getNeedsYouResolver } from '../agent/handlers/index.js';
import { getTool } from '../agent/tools/index.js';
import { mintRunToken, revokeRunToken } from '../agent/principal.js';

const NOW = '2026-10-12T09:00:00.000Z';
let t: TestApp;

async function newClaim(registration: string, extra: Record<string, unknown> = {}): Promise<Claim> {
  const res = await t.api<Claim>('POST', '/claims', { ...FNOL, vehicle: { ...FNOL.vehicle, registration }, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

function fleetCar(registration: string, extra: Partial<FleetUnit> = {}): FleetUnit {
  const { repos, db } = t.ctx;
  const v = repos.upsertVehicle(db, { registration, make: 'Ford', model: 'Focus', ownership: 'fleet', motExpiryDate: '2027-06-01', taxDueDate: '2027-06-01', transmission: 'automatic' });
  const policy = repos.createPolicy(db, { insurerName: 'Fleet Insurer Ltd', policyNumber: `FP-${registration}`, coveredUses: ['credit_hire'], startDate: '2026-01-01', endDate: '2027-12-31' });
  return repos.createFleetUnit(db, { vehicleId: v.id, declaredUses: ['credit_hire'], policyId: policy.id, dailyRatePence: 4500, gtaGroup: 'C2', keeperAddressCurrent: true, ...extra });
}

function reservation(claim: Claim, unit: FleetUnit, extra: Partial<Reservation> = {}): Reservation {
  return t.ctx.repos.insertReservation(t.ctx.db, {
    fleetUnitId: unit.id,
    claimId: claim.id,
    status: 'held',
    use: 'credit_hire',
    startAt: '2026-10-13T09:00:00.000Z',
    expectedEndAt: '2026-10-27T09:00:00.000Z',
    hirerPartyId: claim.driverId ?? claim.claimantId,
    driverPartyIds: [claim.driverId ?? claim.claimantId],
    dailyRatePence: 4500,
    gtaGroup: 'C2',
    source: 'handler',
    createdBy: 'test',
    ...extra,
  });
}

/** A minimal request whose gate is real (header auth mode; the assumed dev user may use manager mode). */
function fakeRequest(override?: string): FastifyRequest {
  return {
    user: { id: 'boss', name: 'Boss', email: 'b@x', role: 'admin', mfaEnabled: false, assumed: false },
    headers: override ? { 'x-manager-override': encodeURIComponent(override) } : {},
    routeOptions: { url: '/api/claims/:id/bookings' },
    params: {},
    url: '/api/test',
    actor: { userId: 'boss' },
  } as unknown as FastifyRequest;
}

const proposed = (claim: Claim, unit: FleetUnit, extra: Partial<Extract<ClashSubject, { kind: 'proposed_booking' }>> = {}): ClashSubject => ({
  kind: 'proposed_booking',
  claimId: claim.id,
  fleetUnitId: unit.id,
  use: 'credit_hire',
  startAt: '2026-10-13T09:00:00.000Z',
  expectedEndAt: '2026-10-27T09:00:00.000Z',
  hirerPartyId: claim.driverId ?? claim.claimantId,
  driverPartyIds: [claim.driverId ?? claim.claimantId],
  stage: 'hold',
  ...extra,
});

beforeAll(async () => {
  t = await createTestApp(NOW);
  t.ctx.repos.createUser(t.ctx.db, { id: 'boss', name: 'Boss Admin', email: 'boss@ccguk.test', role: 'admin' });
});
afterAll(async () => {
  await t.close();
});

describe("the owner's example (§J.4)", () => {
  let X: Claim;
  let Y: Claim;
  let carA: FleetUnit;
  let carB: FleetUnit;
  beforeAll(async () => {
    carA = fleetCar('FA70AAA');
    carB = fleetCar('FB70BBB');
    X = await newClaim('AB12 CDE');
    reservation(X, carA, { status: 'on_hire', startAt: '2026-10-04T09:00:00.000Z', expectedEndAt: '2026-10-25T09:00:00.000Z' });
    Y = await newClaim('AB12CDE');
  });

  it('a claim check on Y raises DUPLICATE_CLAIM_OPEN and SAME_REG_ON_HIRE, stored, never naming X', async () => {
    const res = await t.api<{ findings: Array<{ code: string; severity: string; message: string; id?: string; status?: string }> }>('POST', '/clashes/check', { claimId: Y.id });
    expect(res.status).toBe(200);
    const codes = res.body.findings.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['DUPLICATE_CLAIM_OPEN', 'SAME_REG_ON_HIRE']));
    for (const f of res.body.findings) {
      expect(f.message).not.toContain(X.reference);
      expect(f.id).toBeTruthy();
      expect(f.status).toBe('open');
    }
    const stored = await t.api<{ findings: Array<{ code: string; relatedClaims: Array<{ reference: string }> }>; counts: { block: number } }>('GET', `/claims/${Y.id}/clashes`);
    expect(stored.body.counts.block).toBeGreaterThanOrEqual(2);
    // the owner's view shows the related claim
    expect(stored.body.findings.find((f) => f.code === 'SAME_REG_ON_HIRE')!.relatedClaims.map((c) => c.reference)).toEqual([X.reference]);
  });

  it('booking any car on Y is refused SAME_REG_ON_HIRE (class A) through the gate', () => {
    let err: unknown;
    try {
      enforceClashes(t.ctx, STRICT_GATE, proposed(Y, carB), { claimId: Y.id, entity: 'fleet_reservations', entityId: '(new)' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    // the first block in catalogue order wins the refusal; both are class A
    expect(['SAME_REG_ON_HIRE', 'DUPLICATE_CLAIM_OPEN']).toContain((err as HttpError).code);
    expect((err as HttpError).statusCode).toBe(409);
    expect(JSON.stringify((err as HttpError).details)).toContain('SAME_REG_ON_HIRE');
  });

  it('a request gate without manager mode attaches the override offer; with manager mode the manager proceeds and it is stored overridden', () => {
    const req = fakeRequest('Same client, different accident: checked the police reports');
    const offGate = gateFor(t.ctx, fakeRequest());
    try {
      enforceClashes(t.ctx, offGate, proposed(Y, carB), { claimId: Y.id, entity: 'fleet_reservations', entityId: '(new)' });
      expect.unreachable();
    } catch (e) {
      expect((e as HttpError).override).toMatchObject({ class: 'A', allowed: true, managerMode: 'off' });
    }
    setManagerMode(t.ctx, req, true);
    const gate = gateFor(t.ctx, req);
    const subject = proposed(Y, carB);
    const out = enforceClashes(t.ctx, gate, subject, { claimId: Y.id, entity: 'fleet_reservations', entityId: '(new)' });
    expect(gate.applied.map((a) => a.code)).toEqual(expect.arrayContaining(['SAME_REG_ON_HIRE', 'DUPLICATE_CLAIM_OPEN']));
    expect(gate.applied[0]!.reason).toBe('Same client, different accident: checked the police reports');
    t.ctx.db.transaction((tx) => persistFindings(t.ctx, tx, subject, out.findings, { overriddenKeys: out.overriddenKeys, reason: gate.reason, by: 'boss' }));
    const same = t.ctx.repos.listClashFindings(t.ctx.db, { claimId: Y.id, code: 'SAME_REG_ON_HIRE' })[0]!;
    expect(same).toMatchObject({ status: 'overridden', resolvedBy: 'boss', resolutionNote: 'Same client, different accident: checked the police reports' });
    setManagerMode(t.ctx, req, false);
  });

  it('the nightly sweep keeps the finding overridden, not open', async () => {
    reservation(Y, carB, { status: 'confirmed' });
    const summary = runClashSweep(t.ctx);
    expect(summary.subjects).toBeGreaterThan(0);
    const rows = t.ctx.repos.listClashFindings(t.ctx.db, { claimId: Y.id, code: 'SAME_REG_ON_HIRE' });
    expect(rows.map((r) => r.status)).toEqual(['overridden']);
  });

  it('class C is never overridable, even for a manager in manager mode', () => {
    const disposed = fleetCar('FC70CCC', { status: 'disposed' });
    const req = fakeRequest('try');
    setManagerMode(t.ctx, req, true);
    try {
      enforceClashes(t.ctx, gateFor(t.ctx, req), proposed(X, disposed, { startAt: '2026-11-01T09:00:00.000Z', expectedEndAt: '2026-11-05T09:00:00.000Z' }), { claimId: X.id, entity: 'fleet_reservations', entityId: '(new)' });
      expect.unreachable();
    } catch (e) {
      expect((e as HttpError).code).toBe('UNIT_DISPOSED');
      expect((e as HttpError).override).toBeUndefined();
    } finally {
      setManagerMode(t.ctx, req, false);
    }
  });

  it('the sweep raises an urgent clash_review for a new block finding within 48 h of a start', async () => {
    const Z = await newClaim('ZZ66ZZZ');
    const offRoad = fleetCar('FD70DDD');
    reservation(Z, offRoad, { status: 'confirmed', startAt: '2026-10-13T10:00:00.000Z', expectedEndAt: '2026-10-20T10:00:00.000Z' });
    t.ctx.repos.updateFleetUnit(t.ctx.db, offRoad.id, { status: 'off_road' });
    runClashSweep(t.ctx);
    const items = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'clash_review', claimId: Z.id });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ priority: 'urgent' });
    expect(items[0]!.title).toContain('Car marked off the road');
    runClashSweep(t.ctx);
    expect(t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'clash_review', claimId: Z.id })).toHaveLength(1);
    // the cause goes away → resolved by the system
    t.ctx.repos.updateFleetUnit(t.ctx.db, offRoad.id, { status: 'available' });
    runClashSweep(t.ctx);
    expect(t.ctx.repos.listClashFindings(t.ctx.db, { claimId: Z.id, code: 'UNIT_OFF_ROAD' })[0]).toMatchObject({ status: 'resolved', resolvedBy: 'system' });
    // resolving the Needs-you as the owner records the reason
    const resolver = getNeedsYouResolver('clash_review')!;
    await resolver.resolve(t.ctx, items[0] as never, { optionId: 'resolved', note: 'Car back on the road' }, { userId: 'boss' });
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'clash.resolve', limit: 10 }).length).toBeGreaterThan(0);
  });

  it('daily-log lines list new and overridden findings with their codes', () => {
    const lines = clashDailyLogLines(t.ctx, { start: '2026-10-11T23:00:00.000Z', end: '2026-10-12T23:00:00.000Z' });
    expect(lines.some((l) => l.ruleIds.includes('SAME_REG_ON_HIRE') && /overridden/.test(l.text))).toBe(true);
    expect(lines.some((l) => /^New block clash/.test(l.text))).toBe(true);
  });
});

describe('acknowledge and resolve (human-only)', () => {
  it('acknowledges a warn, refuses to acknowledge a block, resolves with an audit row, and refuses agents', async () => {
    const c = await newClaim('KK11KKK');
    const car = fleetCar('FE70EEE', { keeperAddressCurrent: false });
    const check = await t.api<{ findings: Array<{ id: string; code: string; severity: string }> }>('POST', '/clashes/check', { claimId: c.id, fleetUnitId: car.id, startAt: '2026-10-14T09:00:00.000Z', expectedEndAt: '2026-10-20T09:00:00.000Z' });
    const warn = check.body.findings.find((f) => f.code === 'KEEPER_ADDRESS_STALE')!;
    expect(warn.severity).toBe('warn');
    const token = mintRunToken({ name: 'autopilot', runId: 'run-clash-1', jobId: 'job-1', claimScope: c.id }, 60_000);
    try {
      const agent = await t.api('POST', `/clashes/${warn.id}/acknowledge`, { reason: 'read it' }, { authorization: `Bearer ${token}` });
      expect(agent.status).toBe(403);
    } finally {
      revokeRunToken(token);
    }
    expect((await t.api('POST', `/clashes/${warn.id}/acknowledge`, { reason: 'x' })).status).toBe(400);
    const ack = await t.api<{ finding: { status: string } }>('POST', `/clashes/${warn.id}/acknowledge`, { reason: 'Keeper address change sent to DVLA' });
    expect(ack.body.finding.status).toBe('acknowledged');
    // the persisted acknowledgement survives the next check
    const again = await t.api<{ findings: Array<{ code: string; status: string }>; greenBlocking: string[] }>('POST', '/clashes/check', { claimId: c.id, fleetUnitId: car.id, startAt: '2026-10-14T09:00:00.000Z', expectedEndAt: '2026-10-20T09:00:00.000Z' });
    expect(again.body.findings.find((f) => f.code === 'KEEPER_ADDRESS_STALE')!.status).toBe('acknowledged');
    const blocked = await t.api<{ findings: Array<{ id: string; code: string; severity: string }> }>('POST', '/clashes/check', { claimId: c.id, fleetUnitId: car.id, startAt: '2026-10-01T09:00:00.000Z', expectedEndAt: '2026-10-20T09:00:00.000Z' });
    const block = blocked.body.findings.find((f) => f.code === 'HIRE_BEFORE_ACCIDENT')!;
    expect(block.severity).toBe('block');
    expect((await t.api<{ error: { code: string } }>('POST', `/clashes/${block.id}/acknowledge`, { reason: 'fine by me' })).body.error.code).toBe('CLASH_BLOCK');
    const res = await t.api<{ finding: { status: string; resolvedBy: string } }>('POST', `/clashes/${block.id}/resolve`, { reason: 'Proposal abandoned' });
    expect(res.body.finding.status).toBe('resolved');
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'clash.resolve', limit: 50 }).some((a) => a.entityId === block.id)).toBe(true);
    const fleet = await t.api<{ findings: Array<{ code: string; registration?: string }> }>('GET', '/fleet/clashes?severity=warn');
    expect(fleet.status).toBe(200);
  });
});

describe('driver profiles, criteria, needs and eligibility', () => {
  let c: Claim;
  let car: FleetUnit;
  let partyId: string;
  beforeAll(async () => {
    c = await newClaim('PP22PPP');
    car = fleetCar('FF70FFF');
    partyId = c.driverId ?? c.claimantId;
    t.ctx.repos.updateParty(t.ctx.db, partyId, { dateOfBirth: '1992-05-01' });
  });
  const profile = (extra: Record<string, unknown> = {}) => ({ licenceCountry: 'GB', licenceType: 'full', fullLicenceSince: '2014-01-01', restrictionCodes: ['78'], points: 3, endorsements: [{ code: 'SP30', offenceDate: '2024-03-01', points: 3 }], source: 'dvla_check', dvlaCheck: { checkedAt: NOW, summary: 'Full licence, 3 points (SP30)' }, ...extra });

  it('no profile → unknown with what is missing', async () => {
    const res = await t.api<{ summary: { overall: string; driver: { outcome: string; missing: string[] } }; criteriaSource: string; notice: string }>('GET', `/claims/${c.id}/eligibility`);
    expect(res.body.summary.driver.outcome).toBe('unknown');
    expect(res.body.summary.driver.missing).toEqual(expect.arrayContaining(['licence type', 'penalty points']));
    expect(res.body.criteriaSource).toBe('settings_default');
    expect(res.body.notice).toMatch(/Check them against your policy wording/);
  });

  it('saves a profile (human-only, audited) → eligible, automatic only', async () => {
    const token = mintRunToken({ name: 'autopilot', runId: 'run-clash-2', jobId: 'job-2' }, 60_000);
    try {
      expect((await t.api('PUT', `/parties/${partyId}/driver-profile`, profile(), { authorization: `Bearer ${token}` })).status).toBe(403);
    } finally {
      revokeRunToken(token);
    }
    expect((await t.api('PUT', `/parties/${partyId}/driver-profile`, { ...profile(), licenceType: 'learner' })).status).toBe(400);
    const put = await t.api<{ profile: { restrictionCodes: string[]; dvlaCheck: { checkedBy: string } } }>('PUT', `/parties/${partyId}/driver-profile`, profile());
    expect(put.status).toBe(200);
    expect(put.body.profile.dvlaCheck.checkedBy).toBeTruthy();
    const e = await t.api<{ summary: { driver: { outcome: string; automaticOnly: boolean } } }>('GET', `/claims/${c.id}/eligibility`);
    expect(e.body.summary.driver).toMatchObject({ outcome: 'eligible', automaticOnly: true });
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'driver_profile.update', limit: 10 }).length).toBe(1);
  });

  it('hire needs: partial PUT merged; weak need raises NEED_WEAK', async () => {
    const put = await t.api<{ needs: { otherVehicles: string; occupation: string | null; source: Record<string, string> } }>('PUT', `/claims/${c.id}/hire-needs`, { otherVehicles: 'none', occupation: 'Care worker' });
    expect(put.body.needs).toMatchObject({ otherVehicles: 'none', occupation: 'Care worker' });
    expect(put.body.needs.source.occupation).toBe('handler');
    let e = await t.api<{ summary: { need: { level: string }; green: boolean; overall: string } }>('GET', `/claims/${c.id}/eligibility`);
    expect(e.body.summary.need.level).toBe('strong');
    expect(e.body.summary).toMatchObject({ overall: 'eligible', green: true });
    await t.api('PUT', `/claims/${c.id}/hire-needs`, { otherVehicles: 'available' });
    e = await t.api('GET', `/claims/${c.id}/eligibility`);
    expect(e.body.summary.need.level).toBe('weak');
    const check = await t.api<{ findings: Array<{ code: string }>; greenBlocking: string[] }>('POST', '/clashes/check', { claimId: c.id });
    expect(check.body.greenBlocking).toContain('NEED_WEAK');
    await t.api('PUT', `/claims/${c.id}/hire-needs`, { otherVehicles: 'none' });
  });

  it('assess records only what changed (append-only) and the tools shape the result', async () => {
    const first = await t.api<{ written: Array<{ kind: string }> }>('POST', `/claims/${c.id}/eligibility/assess`, {});
    expect(first.body.written.map((w) => w.kind)).toEqual(expect.arrayContaining(['driver', 'need', 'overall']));
    const second = await t.api<{ written: unknown[] }>('POST', `/claims/${c.id}/eligibility/assess`, {});
    expect(second.body.written).toEqual([]);
    const shaped = getTool('eligibility_get')!.shape!({ summary: { overall: 'eligible', green: true, driver: { outcome: 'eligible', reasons: [{ code: 'X', outcome: 'eligible', message: 'm', extra: 1 }] } }, criteriaSource: 'policy' }) as Record<string, unknown>;
    expect(shaped).toMatchObject({ overall: 'eligible', criteriaSource: 'policy' });
    const clash = getTool('clash_check')!.shape!({ blocks: ['SAME_REG_ON_HIRE'], findings: [{ code: 'SAME_REG_ON_HIRE', severity: 'block', message: 'm', related: { claimIds: ['other-claim'] } }] }) as { findings: Array<Record<string, unknown>> };
    expect(JSON.stringify(clash)).not.toContain('other-claim');
    expect(clash.findings[0]!.otherClaims).toBe(1);
  });

  it('policy criteria: per-policy criteria win; refer → eligibility_review; insurer acceptance (evidence) lets the booking proceed', async () => {
    const policyId = car.policyId!;
    const get = await t.api<{ source: string; notice: string; effective: { maxPointsEligible: number } }>('GET', `/fleet/policies/${policyId}/criteria`);
    expect(get.body).toMatchObject({ source: 'settings_default' });
    expect(get.body.notice).toMatch(/Check them against your fleet policy wording/);
    const strict = { ...get.body.effective, maxPointsEligible: 2 };
    expect((await t.api('PUT', `/fleet/policies/${policyId}/criteria`, { criteria: { ...strict, minAge: 30, referBelowAge: 25 } })).status).toBe(400);
    expect((await t.api('PUT', `/fleet/policies/${policyId}/criteria`, { criteria: strict })).status).toBe(200);
    // the claim's car is this unit (a hold), so its policy's criteria apply: 3 points → refer
    reservation(c, car, { startAt: '2026-10-15T09:00:00.000Z', expectedEndAt: '2026-10-25T09:00:00.000Z' });
    const assess = await t.api<{ summary: { driver: { outcome: string } } }>('POST', `/claims/${c.id}/eligibility/assess`, {});
    expect(assess.body.summary.driver.outcome).toBe('refer');
    const review = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'eligibility_review', claimId: c.id });
    expect(review).toHaveLength(1);
    const blocked = checkClashes(t.ctx, { kind: 'reservation', reservationId: t.ctx.repos.listReservations(t.ctx.db, { claimId: c.id })[0]!.id, stage: 'confirm' });
    expect(blocked.blocks.map((b) => b.code)).toContain('DRIVER_REFERRAL');
    // insurer accepted: evidence must be on the claim
    const resolver = getNeedsYouResolver('eligibility_review')!;
    await expect(resolver.resolve(t.ctx, review[0] as never, { optionId: 'insurer_accepted', edits: {} }, { userId: 'boss' })).rejects.toMatchObject({ code: 'EVIDENCE_REQUIRED' });
    const ev = t.ctx.repos.insertEvidence(t.ctx.db, { claimId: c.id, kind: 'correspondence', filename: 'acceptance.pdf', mime: 'application/pdf', bytes: 10, sha256: 'b'.repeat(64), storagePath: `evidence/${c.id}/acceptance.pdf`, uploadedBy: 'boss' });
    await resolver.resolve(t.ctx, review[0] as never, { optionId: 'insurer_accepted', edits: { evidenceId: ev.id }, note: 'Email from the underwriter' }, { userId: 'boss' });
    const after = checkClashes(t.ctx, { kind: 'reservation', reservationId: t.ctx.repos.listReservations(t.ctx.db, { claimId: c.id })[0]!.id, stage: 'confirm' });
    expect(after.blocks.map((b) => b.code)).not.toContain('DRIVER_REFERRAL');
    expect(after.findings.find((f) => f.code === 'DRIVER_REFERRAL')).toMatchObject({ severity: 'info' });
    const e = await t.api<{ summary: { driver: { outcome: string } } }>('GET', `/claims/${c.id}/eligibility`);
    expect(e.body.summary.driver.outcome).toBe('eligible');
    // clearing the policy's criteria falls back to the default
    expect((await t.api<{ criteria: unknown }>('PUT', `/fleet/policies/${policyId}/criteria`, { criteria: null })).body.criteria).toBeNull();
  });
});

describe('handlers and registry', () => {
  it('registers clash.check and clash.sweep with the §H.1 lanes and priorities; the job runs', async () => {
    expect(getJobHandler('clash.check')).toMatchObject({ lane: 'io', defaultPriority: 2, usesAi: false, mutatesClaim: false });
    expect(getJobHandler('clash.sweep')).toMatchObject({ lane: 'io', defaultPriority: 6 });
    const c = await newClaim('JJ33JJJ');
    t.ctx.repos.updateVehicle(t.ctx.db, c.clientVehicleId, { motExpiryDate: '2026-09-01' });
    const out = await getJobHandler('clash.check')!.run({ ctx: t.ctx, job: {} as never, payload: { subjectKind: 'claim', id: c.id }, signal: new AbortController().signal, log: t.ctx.logger });
    expect(out).toMatchObject({ kind: 'done' });
    expect((out as { result: { codes: string[] } }).result.codes).toContain('CLIENT_CAR_NOT_LEGAL');
  });
});
