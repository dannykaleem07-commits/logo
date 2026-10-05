/**
 * Manager mode (docs/V03-MANAGER-MODE-HIRE-PRICING.md §A, verification §I.3): the state routes, the central override
 * gate and its audit trail, the bypass matrix for every class A/B code owned by the API slice, and class C refusals
 * that stay refused with manager mode on.
 *
 * Header auth mode: `boss` (admin) and `clerk` (handler) are named with X-User-Id. A session-mode suite repeats the
 * essentials with real sign-ins.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { isValidUkRegistration, normaliseRegistration, OVERRIDE_RULES, type Claim, type GeneratedDocument } from '@ccguk/domain';
import type { AuditEntry } from '@ccguk/db';
import { createTestApp, FNOL, type TestApp } from './helpers.js';
import { recomputeClocks } from '../services/claimView.js';
import { hashPassword, SESSION_COOKIE } from '../services/auth.js';

const CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
if (!process.env.CHROMIUM_PATH && existsSync(CHROMIUM)) process.env.CHROMIUM_PATH = CHROMIUM;

type OverrideInfo = { code: string; class: 'A' | 'B'; label: string; warning?: string; allowed: boolean; managerMode: 'on' | 'off' };
type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown>; override?: OverrideInfo } };
type ModeView = { allowed: boolean; on: boolean; until?: string; idleMinutes: number; defaultReason: string };
interface Res<T = unknown> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | number | undefined>;
}

const BOSS = { 'x-user-id': 'boss' };
const CLERK = { 'x-user-id': 'clerk' };
const OVR = { 'x-manager-override': 'Verify%20test' };
const NOW = '2026-10-05T09:00:00.000Z';

let t: TestApp;

async function call<T = unknown>(method: InjectOptions['method'], url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
  const res = await t.app.inject({ method, url: `/api${url}`, ...(payload !== undefined ? { payload: payload as InjectOptions['payload'] } : {}), headers });
  let body: unknown = res.body;
  try {
    body = res.body ? JSON.parse(res.body) : undefined;
  } catch {
    /* not JSON */
  }
  return { status: res.statusCode, body: body as T, headers: res.headers };
}

function addUsers(): void {
  t.ctx.repos.createUser(t.ctx.db, { id: 'boss', name: 'Boss Admin', email: 'boss@ccguk.test', role: 'admin' });
  t.ctx.repos.createUser(t.ctx.db, { id: 'clerk', name: 'Clerk Handler', email: 'clerk@ccguk.test', role: 'handler' });
}

const overrideRows = (code?: string): AuditEntry[] => t.ctx.repos.listAuditByActions(t.ctx.db, { prefixes: [code ? `override.${code}` : 'override.'], limit: 1000 }).filter((a) => !code || a.action === `override.${code}`);
const modeRows = (action: 'manager_mode.on' | 'manager_mode.off'): AuditEntry[] => t.ctx.repos.listAudit(t.ctx.db, { action, limit: 1000 });
const appliedHeader = (res: Res): Array<{ code: string; label: string; reason: string }> => {
  const h = res.headers['x-manager-overrides'];
  return typeof h === 'string' ? (JSON.parse(decodeURIComponent(h)) as Array<{ code: string; label: string; reason: string }>) : [];
};

async function managerMode(on: boolean, headers: Record<string, string> = BOSS): Promise<Res<ModeView>> {
  return call<ModeView>('POST', '/auth/manager-mode', { on }, headers);
}

async function newClaim(body: unknown = FNOL, headers: Record<string, string> = BOSS): Promise<Claim> {
  const res = await call<Claim>('POST', '/claims', body, headers);
  expect(res.status).toBe(201);
  return res.body;
}

function seedFileOne() {
  const ids = t.ctx.repos.seedFileOne(t.ctx.db);
  recomputeClocks(t.ctx, ids.claimId);
  return ids;
}

interface MatrixCase {
  code: string;
  status: number;
  /** The claim the override is keyed to (checked in the audit row and GET /claims/:id/audit). */
  claimId?: string;
  /** When a role gate (class C) stops a handler before the rule is reached: the handler's status (no override info). */
  handlerStatus?: number;
  send(headers: Record<string, string>): Promise<Res>;
}

/**
 * §I.3 bypass matrix for one code:
 *  1. manager mode off, header absent → the refusal with error.override { code, allowed: true, managerMode: 'off' };
 *  3. handler with the header → the refusal with override.allowed false, no audit row;
 *  2. manager mode on + header → 2xx, x-manager-overrides lists the code, exactly one override.<CODE> audit row with
 *     the reason and actor, keyed to the claim and visible in GET /claims/:id/audit.
 */
async function matrix(c: MatrixCase): Promise<Res> {
  const rule = OVERRIDE_RULES[c.code]!;
  expect(rule, c.code).toBeDefined();

  const off = await c.send(BOSS);
  expect(off.status, `${c.code} off: ${JSON.stringify(off.body)}`).toBe(c.status);
  const offErr = (off.body as ErrorBody).error;
  expect(offErr.code).toBe(c.code);
  expect(offErr.override).toEqual({ code: c.code, class: rule.class, label: rule.label, ...(rule.warning ? { warning: rule.warning } : {}), allowed: true, managerMode: 'off' });

  const handler = await c.send({ ...CLERK, ...OVR });
  expect(handler.status, `${c.code} handler`).toBe(c.handlerStatus ?? c.status);
  if (c.handlerStatus) expect((handler.body as ErrorBody).error.override).toBeUndefined();
  else expect((handler.body as ErrorBody).error.override).toMatchObject({ code: c.code, allowed: false, managerMode: 'off' });
  expect(overrideRows(c.code)).toHaveLength(0);

  expect((await managerMode(true)).body.on).toBe(true);
  const on = await c.send({ ...BOSS, ...OVR });
  expect(on.status, `${c.code} on: ${String(JSON.stringify(on.body)).slice(0, 600)}`).toBeLessThan(300);
  expect(appliedHeader(on).map((a) => a.code)).toContain(c.code);
  expect(appliedHeader(on).find((a) => a.code === c.code)).toEqual({ code: c.code, label: rule.label, reason: 'Verify test' });
  const rows = overrideRows(c.code);
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.userId).toBe('boss');
  expect(row.after).toMatchObject({ reason: 'Verify test', class: rule.class, label: rule.label });
  expect(row.before).toMatchObject({ code: c.code });
  if (c.claimId) {
    expect(row.entity).toBe('claims');
    expect(row.entityId).toBe(c.claimId);
    const trail = await call<{ entries: AuditEntry[] }>('GET', `/claims/${c.claimId}/audit`, undefined, BOSS);
    expect(trail.body.entries.filter((e) => e.action === `override.${c.code}`)).toHaveLength(1);
  }
  return on;
}

beforeEach(async () => {
  t = await createTestApp(NOW, { config: { docxPdfConverter: 'browser' } });
  addUsers();
});
afterEach(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------
// State routes
// ---------------------------------------------------------------------------

describe('manager mode state (header auth)', () => {
  it('turns on and off, audits only real changes (heartbeats are silent), and shows in /auth/me', async () => {
    const before = await call<ModeView>('GET', '/auth/manager-mode', undefined, BOSS);
    expect(before.body).toEqual({ allowed: true, on: false, idleMinutes: 60, defaultReason: 'Manager override' });
    const on = await managerMode(true);
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ allowed: true, on: true, until: '2026-10-05T10:02:00.000Z', idleMinutes: 60, defaultReason: 'Manager override' });
    expect(modeRows('manager_mode.on')).toHaveLength(1);
    expect(modeRows('manager_mode.on')[0]).toMatchObject({ userId: 'boss', entity: 'user', entityId: 'boss', after: { until: '2026-10-05T10:02:00.000Z', idleMinutes: 60 } });

    // heartbeat 10 minutes later: extends, no new row
    t.setNow('2026-10-05T09:10:00.000Z');
    const beat = await managerMode(true);
    expect(beat.body.until).toBe('2026-10-05T10:12:00.000Z');
    expect(modeRows('manager_mode.on')).toHaveLength(1);
    const me = await call<{ user: { id: string }; managerMode: ModeView }>('GET', '/auth/me', undefined, BOSS);
    expect(me.body.managerMode).toMatchObject({ allowed: true, on: true, until: '2026-10-05T10:12:00.000Z' });
    // another user's state is separate
    expect((await call<ModeView>('GET', '/auth/manager-mode', undefined, CLERK)).body).toMatchObject({ allowed: false, on: false });

    const off = await managerMode(false);
    expect(off.body).toEqual({ allowed: true, on: false, idleMinutes: 60, defaultReason: 'Manager override' });
    expect(modeRows('manager_mode.off').map((r) => r.after)).toEqual([{ why: 'user' }]);
    // off again: no second row
    await managerMode(false);
    const idle = await call<ModeView>('POST', '/auth/manager-mode', { on: false, why: 'idle' }, BOSS);
    expect(idle.status).toBe(200);
    expect(modeRows('manager_mode.off')).toHaveLength(1);
  });

  it('expires after the idle minutes: cleared on read and audited once', async () => {
    await managerMode(true);
    // the client switches off after the idle minutes; the stored expiry adds a 2-minute grace as a backstop
    t.setNow('2026-10-05T10:01:59.000Z');
    expect((await call<ModeView>('GET', '/auth/manager-mode', undefined, BOSS)).body.on).toBe(true);
    t.setNow('2026-10-05T10:02:00.000Z');
    expect((await call<ModeView>('GET', '/auth/manager-mode', undefined, BOSS)).body.on).toBe(false);
    expect((await call<ModeView>('GET', '/auth/manager-mode', undefined, BOSS)).body.on).toBe(false);
    const offs = modeRows('manager_mode.off');
    expect(offs).toHaveLength(1);
    expect(offs[0]!.after).toMatchObject({ why: 'expired' });
  });

  it('the client idle switch-off is audited as idle, even when the stored value has just expired', async () => {
    await managerMode(true);
    t.setNow('2026-10-05T10:00:30.000Z'); // idle minutes passed, still inside the grace
    const idle = await call<ModeView>('POST', '/auth/manager-mode', { on: false, why: 'idle' }, BOSS);
    expect(idle.body.on).toBe(false);
    expect(modeRows('manager_mode.off').map((r) => r.after)).toEqual([{ why: 'idle' }]);
    // the race the grace guards against: the client's idle POST arrives after the backstop expiry
    await managerMode(true);
    t.setNow('2026-10-05T11:30:00.000Z');
    await call<ModeView>('POST', '/auth/manager-mode', { on: false, why: 'idle' }, BOSS);
    expect(modeRows('manager_mode.off').map((r) => (r.after as { why: string }).why).sort()).toEqual(['idle', 'idle']);
    // nothing stored: no row
    await call<ModeView>('POST', '/auth/manager-mode', { on: false, why: 'idle' }, BOSS);
    expect(modeRows('manager_mode.off')).toHaveLength(2);
  });

  it('a gated request extends the idle expiry (at most one write per 30 s)', async () => {
    const claim = await newClaim();
    await managerMode(true);
    t.setNow('2026-10-05T09:00:20.000Z');
    await call('PATCH', `/claims/${claim.id}`, { atFaultInsurerRef: 'REF-1' }, { ...BOSS, ...OVR });
    expect((await call<ModeView>('GET', '/auth/manager-mode', undefined, BOSS)).body.until).toBe('2026-10-05T10:02:00.000Z');
    t.setNow('2026-10-05T09:40:00.000Z');
    await call('PATCH', `/claims/${claim.id}`, { atFaultInsurerRef: 'REF-2' }, { ...BOSS, ...OVR });
    expect((await call<ModeView>('GET', '/auth/manager-mode', undefined, BOSS)).body.until).toBe('2026-10-05T10:42:00.000Z');
    // without the header the request is not "active" and does not extend
    t.setNow('2026-10-05T10:20:00.000Z');
    await call('PATCH', `/claims/${claim.id}`, { atFaultInsurerRef: 'REF-3' }, BOSS);
    expect((await call<ModeView>('GET', '/auth/manager-mode', undefined, BOSS)).body.until).toBe('2026-10-05T10:42:00.000Z');
  });

  it('uses the idle minutes from Settings', async () => {
    expect((await call<{ managerModeIdleMinutes: number }>('GET', '/settings', undefined, BOSS)).body.managerModeIdleMinutes).toBe(60);
    const patched = await call<{ managerModeIdleMinutes: number }>('PATCH', '/settings', { managerModeIdleMinutes: 5 }, BOSS);
    expect(patched.status).toBe(200);
    expect(patched.body.managerModeIdleMinutes).toBe(5);
    expect((await managerMode(true)).body).toMatchObject({ on: true, idleMinutes: 5, until: '2026-10-05T09:07:00.000Z' });
    expect((await call<ErrorBody>('PATCH', '/settings', { managerModeIdleMinutes: 0 }, BOSS)).status).toBe(400);
    expect((await call<ErrorBody>('PATCH', '/settings', { managerModeIdleMinutes: 481 }, BOSS)).status).toBe(400);
    expect((await call<ErrorBody>('PATCH', '/settings', { managerModeIdleMinutes: 2.5 }, BOSS)).status).toBe(400);
  });

  it('sign-out ends manager mode and audits why', async () => {
    await managerMode(true);
    const out = await call('POST', '/auth/logout', undefined, BOSS);
    expect(out.status).toBe(204);
    expect(modeRows('manager_mode.off').map((r) => r.after)).toEqual([{ why: 'sign_out' }]);
    expect((await call<ModeView>('GET', '/auth/manager-mode', undefined, BOSS)).body.on).toBe(false);
  });

  it('a handler cannot turn it on (403) but may ask for the state; the log is admin/approver only', async () => {
    const res = await managerMode(true, CLERK);
    expect(res.status).toBe(403);
    expect((res.body as unknown as ErrorBody).error.code).toBe('FORBIDDEN');
    expect((res.body as unknown as ErrorBody).error.override).toBeUndefined();
    expect(modeRows('manager_mode.on')).toHaveLength(0);
    expect((await managerMode(false, CLERK)).status).toBe(200);
    expect((await call<ErrorBody>('GET', '/auth/manager-mode/log', undefined, CLERK)).status).toBe(403);
    // the header-mode default (assumed dev) user is allowed, like requireRole
    expect((await call<ModeView>('GET', '/auth/manager-mode')).body.allowed).toBe(true);
    expect((await call<ModeView>('POST', '/auth/manager-mode', { on: true })).status).toBe(200);
    expect((await call<ErrorBody>('POST', '/auth/manager-mode', { on: 'yes' }, BOSS)).status).toBe(400);
  });

  it('the log lists overrides and on/off rows newest first with the user name and claim reference', async () => {
    const claim = await newClaim();
    t.ctx.repos.addClaimFlag(t.ctx.db, claim.id, { code: 'FLEET_UNIT_AS_CLIENT_VEHICLE', severity: 'block', message: 'Test hard stop', raisedBy: 'system' });
    await managerMode(true);
    t.setNow('2026-10-05T09:01:00.000Z');
    expect((await call('POST', `/claims/${claim.id}/status`, { status: 'accepted' }, { ...BOSS, ...OVR })).status).toBe(200);
    t.setNow('2026-10-05T09:02:00.000Z');
    await managerMode(false);
    const log = await call<{ items: Array<AuditEntry & { userName?: string; claimReference?: string }> }>('GET', '/auth/manager-mode/log?limit=10', undefined, BOSS);
    expect(log.status).toBe(200);
    expect(log.body.items.map((i) => i.action)).toEqual(['manager_mode.off', 'override.HARD_STOP', 'manager_mode.on']);
    expect(log.body.items[1]).toMatchObject({ userName: 'Boss Admin', claimReference: claim.reference, entityId: claim.id });
    expect(log.body.items[0]!.userName).toBe('Boss Admin');
    expect((await call('GET', '/auth/manager-mode/log?limit=0', undefined, BOSS)).status).toBe(400);
  });
});

describe('settings route', () => {
  it('PATCH /settings is admin/approver only; GET shows managerModeIdleMinutes 60', async () => {
    const res = await call<ErrorBody>('PATCH', '/settings', { icoRegistration: 'ZA000001' }, CLERK);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect((await call<{ managerModeIdleMinutes: number }>('GET', '/settings', undefined, CLERK)).body.managerModeIdleMinutes).toBe(60);
    expect((await call('PATCH', '/settings', { icoRegistration: 'ZA000001' }, BOSS)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// §I.3 bypass matrix — codes owned by the API slice (hire codes are covered by the hire tests)
// ---------------------------------------------------------------------------

describe('bypass matrix: claims, fleet, vehicles', () => {
  it('HARD_STOP — status change past accepted with an uncleared block flag', async () => {
    const claim = await newClaim();
    t.ctx.repos.addClaimFlag(t.ctx.db, claim.id, { code: 'FLEET_UNIT_AS_CLIENT_VEHICLE', severity: 'block', message: 'Test hard stop', raisedBy: 'system' });
    const on = await matrix({ code: 'HARD_STOP', status: 409, claimId: claim.id, send: (h) => call('POST', `/claims/${claim.id}/status`, { status: 'accepted' }, h) });
    expect((on.body as Claim).status).toBe('accepted');
    // the flag stays on the file
    expect(t.ctx.repos.requireClaim(t.ctx.db, claim.id).flags.find((f) => f.code === 'FLEET_UNIT_AS_CLIENT_VEHICLE')?.clearedAt).toBeUndefined();
  });

  it('B15 — moving to pre_action without a reason uses the override reason in manager mode', async () => {
    const claim = await newClaim();
    expect((await call<ErrorBody>('POST', `/claims/${claim.id}/status`, { status: 'pre_action' }, BOSS)).status).toBe(400);
    await managerMode(true);
    const res = await call<Claim>('POST', `/claims/${claim.id}/status`, { status: 'pre_action' }, { ...BOSS, ...OVR });
    expect(res.status).toBe(200);
    const row = t.ctx.repos.listAudit(t.ctx.db, { entityId: claim.id, action: 'claim.status' })[0];
    expect(row?.after).toMatchObject({ status: 'pre_action', reason: 'Verify test' });
  });

  it('FNOL_INCOMPLETE — the claim opens with an INTAKE_INCOMPLETE flag and the override is keyed to it', async () => {
    const bad = { ...FNOL, thirdPartyVehicle: { ...FNOL.thirdPartyVehicle, registration: '1NVALID!!' } };
    const before = t.ctx.repos.listClaims(t.ctx.db, { limit: 100 }).length;
    const off = await call<ErrorBody>('POST', '/claims', bad, BOSS);
    expect(off.status).toBe(400);
    expect(off.body.error.code).toBe('FNOL_INCOMPLETE');
    expect(off.body.error.details?.missing).toBeDefined();
    expect(off.body.error.details?.errors).toBeDefined();
    expect(t.ctx.repos.listClaims(t.ctx.db, { limit: 100 })).toHaveLength(before);
    let created: Claim | undefined;
    await matrix({
      code: 'FNOL_INCOMPLETE',
      status: 400,
      send: async (h) => {
        const res = await call<Claim>('POST', '/claims', bad, h);
        if (res.status === 201) created = res.body;
        return res;
      },
    });
    expect(created).toBeDefined();
    const flag = created!.flags.find((f) => f.code === 'INTAKE_INCOMPLETE' && !f.clearedAt);
    expect(flag?.severity).toBe('warn');
    expect(flag?.message).toMatch(/\(opened in manager mode\)$/);
    expect(flag?.message).toMatch(/registration/i);
    expect(created!.flags.filter((f) => f.code === 'INTAKE_INCOMPLETE' && !f.clearedAt)).toHaveLength(1);
    const row = overrideRows('FNOL_INCOMPLETE')[0]!;
    expect(row).toMatchObject({ entity: 'claims', entityId: created!.id });
    expect(row.after).toMatchObject({ target: { entity: 'claims', entityId: created!.id } });
    const trail = await call<{ entries: AuditEntry[] }>('GET', `/claims/${created!.id}/audit`, undefined, BOSS);
    expect(trail.body.entries.map((e) => e.action)).toContain('override.FNOL_INCOMPLETE');
  });

  it('REGISTRATION_ON_CLAIM — a client vehicle on a claim added as a fleet unit', async () => {
    const claim = await newClaim();
    const body = { vehicle: { registration: 'KX21 ABC', make: 'Toyota', model: 'Yaris' }, declaredUses: ['credit_hire'], gtaGroup: 'B', dailyRatePence: 4000 };
    const on = await matrix({ code: 'REGISTRATION_ON_CLAIM', status: 409, claimId: claim.id, send: (h) => call('POST', '/fleet', body, h) });
    expect(on.status).toBe(201);
    expect(overrideRows('REGISTRATION_ON_CLAIM')[0]!.after).toMatchObject({ target: { entity: 'vehicles' } });
  });

  it('UNIT_ON_HIRE — disposing a car on hire leaves the hire open and flags its claim', async () => {
    const claim = await newClaim();
    const unit = await call<{ id: string }>('POST', '/fleet', { vehicle: { registration: 'FL25 MXX', make: 'NISSAN', model: 'QASHQAI' }, declaredUses: ['credit_hire'], gtaGroup: 'M2', dailyRatePence: 7468 }, BOSS);
    expect(unit.status).toBe(201);
    const hire = t.ctx.repos.createHire(t.ctx.db, { claimId: claim.id, fleetUnitId: unit.body.id, startAt: '2026-10-04T09:00:00.000Z', dailyRatePence: 7468, vatRate: 0, gtaGroup: 'M2', excessPence: 0 });
    const on = await matrix({ code: 'UNIT_ON_HIRE', status: 409, claimId: claim.id, send: (h) => call('DELETE', `/fleet/${unit.body.id}`, undefined, h) });
    expect(on.status).toBe(204);
    expect(t.ctx.repos.requireFleetUnit(t.ctx.db, unit.body.id).status).toBe('disposed');
    expect(t.ctx.repos.requireHire(t.ctx.db, hire.id).endAt).toBeUndefined();
    const flag = t.ctx.repos.requireClaim(t.ctx.db, claim.id).flags.find((f) => f.code === 'HIRE_ON_DISPOSED_UNIT');
    expect(flag).toMatchObject({ severity: 'warn' });
    expect(flag?.message).toContain(hire.agreementNumber);
  });

  it('GTA_SUGGESTION_UNAVAILABLE — a typed rate with no group is saved UNGROUPED; no rate stays refused', async () => {
    const body = { vehicle: { registration: 'AB18 UNK' }, declaredUses: ['credit_hire'], dailyRatePence: 5000 };
    const on = await matrix({ code: 'GTA_SUGGESTION_UNAVAILABLE', status: 422, send: (h) => call('POST', '/fleet', body, h) });
    expect(on.status).toBe(201);
    expect(on.body).toMatchObject({ gtaGroup: 'UNGROUPED', dailyRatePence: 5000 });
    // the vehicle record is not given the placeholder group
    expect((on.body as { vehicle?: { gtaGroup?: string } }).vehicle?.gtaGroup).toBeUndefined();
    const noRate = await call<ErrorBody>('POST', '/fleet', { vehicle: { registration: 'AB19 UNK' }, declaredUses: ['credit_hire'] }, { ...BOSS, ...OVR });
    expect(noRate.status).toBe(422);
    expect(noRate.body.error.override).toBeUndefined();
  });

  it('GTA_SUGGESTION_UNAVAILABLE — "no group yet" with make and model is saved UNGROUPED, not a guessed group', async () => {
    const body = { vehicle: { registration: 'B123 XYZ', make: 'FORD', model: 'FIESTA' }, declaredUses: ['credit_hire'], dailyRatePence: 4500, gtaGroupUnknown: true };
    const on = await matrix({ code: 'GTA_SUGGESTION_UNAVAILABLE', status: 422, send: (h) => call('POST', '/fleet', body, h) });
    expect(on.status).toBe(201);
    expect(on.body).toMatchObject({ gtaGroup: 'UNGROUPED', dailyRatePence: 4500 });
    const vehicle = t.ctx.repos.findByRegistration(t.ctx.db, 'B123XYZ');
    expect(vehicle?.gtaGroup).toBeUndefined();
    // without the flag the suggestion is used for the unit, but a low-confidence guess is not written onto the vehicle
    const guessed = await call<{ gtaGroup: string }>('POST', '/fleet', { vehicle: { registration: 'B124 XYZ', make: 'FORD', model: 'FIESTA' }, declaredUses: ['credit_hire'], dailyRatePence: 4500 }, BOSS);
    expect(guessed.status).toBe(201);
    expect(guessed.body.gtaGroup).not.toBe('UNGROUPED');
    expect(t.ctx.repos.findByRegistration(t.ctx.db, 'B124XYZ')?.gtaGroup).toBeUndefined();
  });

  it('REGISTRATION_FORMAT — POST /vehicles and /vehicles/lookup (no live providers)', async () => {
    const plate = 'D-ABC 12345';
    expect(isValidUkRegistration(normaliseRegistration(plate))).toBe(false);
    const on = await matrix({ code: 'REGISTRATION_FORMAT', status: 400, send: (h) => call('POST', '/vehicles', { registration: plate, make: 'BMW', model: 'X1' }, h) });
    expect(on.status).toBe(201);
    expect((on.body as { registration: string }).registration).toBe(normaliseRegistration(plate));
    const lookupOff = await call<ErrorBody>('POST', '/vehicles/lookup', { registration: 'D-XYZ 98765' }, { ...CLERK, ...OVR });
    expect(lookupOff.status).toBe(400);
    expect(lookupOff.body.error.override?.allowed).toBe(false);
    const lookup = await call<{ status: string; providers: Record<string, string> }>('POST', '/vehicles/lookup', { registration: 'D-XYZ 98765' }, { ...BOSS, ...OVR });
    expect(lookup.status).toBe(200);
    expect(lookup.body.status).toBe('manual_required');
    expect(lookup.body.providers).toEqual({ dvla_ves: 'no_key', dvsa_mot: 'no_key' });
    // max length 15 for everyone (zod)
    expect((await call('POST', '/vehicles', { registration: 'ABCDEFGHIJKLMNOP' }, { ...BOSS, ...OVR })).status).toBe(400);
  });

  it('TRANSITION_REFUSED — an out-of-order penalty stage (appeal before representations), keyed to the hire claim', async () => {
    const ids = seedFileOne();
    const pen = await call<{ id: string }>('POST', '/fleet/penalties', { fleetUnitId: ids.fleetUnitId, kind: 'pcn_council', issuer: 'Example Council', noticeNumber: 'PCN/1', contraventionAt: '2026-08-20T08:00:00.000Z', receivedAt: '2026-08-25T00:00:00.000Z', amountPence: 7000, responseDeadline: '2026-10-31' }, BOSS);
    expect(pen.status).toBe(201);
    const on = await matrix({ code: 'TRANSITION_REFUSED', status: 409, claimId: ids.claimId, send: (h) => call('POST', `/fleet/penalties/${pen.body.id}/transition`, { stage: 'appeal', hireAgreementId: ids.hireId }, h) });
    expect((on.body as { stage: string }).stage).toBe('appeal');
  });
});

describe('bypass matrix: engineering', () => {
  it('LINES_UNCONFIRMED — approving an estimate with unconfirmed lines', async () => {
    const ids = seedFileOne();
    const est = await call<{ id: string }>('POST', `/claims/${ids.claimId}/estimate`, {
      labourRatePence: 4800,
      paintRatePence: 4800,
      paintMaterialsMethod: 'per_hour',
      paintMaterialsPerHourPence: 2200,
      lines: [{ kind: 'labour', operation: 'Replace', panel: 'Rear bumper', description: 'Remove and replace rear bumper', quantity: 1, hours: 1.5, confirmedByEngineer: false }],
    }, BOSS);
    expect(est.status).toBe(201);
    const on = await matrix({ code: 'LINES_UNCONFIRMED', status: 409, claimId: ids.claimId, send: (h) => call('POST', `/claims/${ids.claimId}/estimate/${est.body.id}/approve`, {}, h) });
    expect((on.body as { approvedBy: string }).approvedBy).toBe('boss');
  });

  it('TOO_FEW_COMPARABLES — approving a PAV with fewer than three retained comparables', async () => {
    const ids = seedFileOne();
    const pav = t.ctx.repos.requirePav(t.ctx.db, ids.pavId);
    // keep one comparable on a fresh assessment
    const { id: _id, createdAt: _created, approvedBy: _by, approvedAt: _at, ...rest } = pav;
    const created = t.ctx.repos.createPav(t.ctx.db, { ...rest, comparables: pav.comparables.slice(0, 1) });
    const on = await matrix({ code: 'TOO_FEW_COMPARABLES', status: 409, claimId: ids.claimId, send: (h) => call('POST', `/claims/${ids.claimId}/pav/${created.id}/approve`, {}, h) });
    expect(on.status).toBe(200);
  });

  it('CHECKLIST_INCOMPLETE — issuing a report with an incomplete checklist; force alone no longer bypasses', async () => {
    const ids = seedFileOne();
    const report = await call<{ id: string }>('POST', `/claims/${ids.claimId}/engineer-report`, { engineerPartyId: ids.engineerId, roadworthy: true, roadworthyReason: 'Cosmetic damage only', damageDescription: 'NSF wing and bumper scuffed', preAccidentCondition: 'Good' }, BOSS);
    expect(report.status).toBe(201);
    const forced = await call<ErrorBody>('POST', `/claims/${ids.claimId}/engineer-report/${report.body.id}/issue`, { force: true }, BOSS);
    expect(forced.status).toBe(409);
    expect(forced.body.error.code).toBe('CHECKLIST_INCOMPLETE');
    await matrix({ code: 'CHECKLIST_INCOMPLETE', status: 409, claimId: ids.claimId, send: (h) => call('POST', `/claims/${ids.claimId}/engineer-report/${report.body.id}/issue`, {}, h) });
    const issued = t.ctx.repos.listEvents(t.ctx.db, ids.claimId).filter((e) => e.type === 'report_issued' && (e.data as { reportId?: string } | undefined)?.reportId === report.body.id);
    expect(issued).toHaveLength(1);
    expect(issued[0]!.data).toMatchObject({ forced: true, overrideReason: 'Verify test' });
  }, 60_000);
});

describe('bypass matrix: documents', () => {
  it('DOCUMENT_BLOCKED — each open block flag is cleared with the manager reason, then approved', async () => {
    const ids = seedFileOne();
    const wrong = await call<GeneratedDocument>('POST', `/claims/${ids.claimId}/documents`, {
      templateId: 'letter.chaser_7',
      data: { insurerPosition: { statedAt: '2026-09-26', summary: 'You stated that £1,287 was received in full and final settlement.', response: ['The remittance received was £1,112.00; the balance remains outstanding.'] } },
    }, BOSS);
    expect(wrong.body.status).toBe('blocked');
    const on = await matrix({ code: 'DOCUMENT_BLOCKED', status: 409, claimId: ids.claimId, send: (h) => call('POST', `/documents/${wrong.body.id}/approve`, {}, h) });
    const doc = on.body as GeneratedDocument;
    expect(doc.status).toBe('approved');
    const cleared = (doc.consistency?.flags ?? []).filter((f) => f.severity === 'block');
    expect(cleared.length).toBeGreaterThan(0);
    for (const f of cleared) expect(f.clearedAt).toBeTruthy();
    expect(cleared.some((f) => f.clearedReason === 'Manager override: Verify test')).toBe(true);
    expect(t.ctx.repos.listAudit(t.ctx.db, { entity: 'documents', entityId: wrong.body.id, action: 'document.flag.clear' }).length).toBeGreaterThan(0);
  }, 120_000);

  it('EXTRA_OVERRIDES_LEDGER — a typed ledger figure wins in manager mode', async () => {
    const ids = seedFileOne();
    const on = await matrix({ code: 'EXTRA_OVERRIDES_LEDGER', status: 400, claimId: ids.claimId, send: (h) => call('POST', `/claims/${ids.claimId}/documents`, { templateId: 'letter.chaser_7', data: { totals: { receivedPence: 128700 } } }, h) });
    const doc = on.body as GeneratedDocument;
    expect((doc.dataSnapshot as { totals: { receivedPence: number } }).totals.receivedPence).toBe(128700);
    expect((overrideRows('EXTRA_OVERRIDES_LEDGER')[0]!.before as { details: { fields: string[] } }).details.fields).toEqual(['totals.receivedPence']);
  });

  const BANK = { accountName: 'Courtesy Cars Group UK Ltd', sortCode: '12-34-56', accountNumber: '12345678', bankName: 'Example Bank plc' };

  it('HIRE_OPEN — an interim hire invoice to today', async () => {
    expect((await call('PATCH', '/settings', { bank: BANK }, BOSS)).status).toBe(200);
    const claim = await newClaim();
    const unit = await call<{ id: string }>('POST', '/fleet', { vehicle: { registration: 'FL44 EET', make: 'VOLKSWAGEN', model: 'POLO' }, declaredUses: ['credit_hire'], gtaGroup: 'S1', dailyRatePence: 4232 }, BOSS);
    expect(unit.status).toBe(201);
    t.ctx.repos.createHire(t.ctx.db, { claimId: claim.id, fleetUnitId: unit.body.id, startAt: '2026-10-01T09:00:00.000Z', dailyRatePence: 4232, vatRate: 0, gtaGroup: 'S1', excessPence: 0 });
    const on = await matrix({ code: 'HIRE_OPEN', status: 409, claimId: claim.id, send: (h) => call('POST', `/claims/${claim.id}/documents`, { templateId: 'invoice.hire' }, h) });
    const doc = on.body as GeneratedDocument;
    expect(doc.templateId).toBe('invoice.hire');
    // costed to today (4 days at £42.32)
    expect((doc.dataSnapshot as { hire: { days: number; endAt: string } }).hire).toMatchObject({ days: 4, endAt: NOW });
  });

  it('HIRE_OPEN — an interim hire invoice when more has already been received than the hire costs to date', async () => {
    expect((await call('PATCH', '/settings', { bank: BANK }, BOSS)).status).toBe(200);
    const claim = await newClaim();
    const unit = await call<{ id: string }>('POST', '/fleet', { vehicle: { registration: 'FL44 EET', make: 'VOLKSWAGEN', model: 'POLO' }, declaredUses: ['credit_hire'], gtaGroup: 'S1', dailyRatePence: 4232 }, BOSS);
    expect(unit.status).toBe(201);
    t.ctx.repos.createHire(t.ctx.db, { claimId: claim.id, fleetUnitId: unit.body.id, startAt: '2026-10-01T09:00:00.000Z', dailyRatePence: 4232, vatRate: 0, gtaGroup: 'S1', excessPence: 0 });
    // £200.00 received on account; the 4 days to date cost £169.28
    expect((await call('POST', `/claims/${claim.id}/ledger`, { head: 'hire', kind: 'paid', amountPence: 20000, date: '2026-10-04', description: 'Interim payment' }, BOSS)).status).toBe(201);
    const on = await matrix({ code: 'HIRE_OPEN', status: 409, claimId: claim.id, send: (h) => call('POST', `/claims/${claim.id}/documents`, { templateId: 'invoice.hire' }, h) });
    const snap = (on.body as GeneratedDocument).dataSnapshot as { totals: { grossPence: number }; receivedPence: number; balancePence: number };
    expect(snap).toMatchObject({ totals: { grossPence: 16928 }, receivedPence: 20000, balancePence: 0 });
  });

  it('STORAGE_OPEN — an interim storage invoice to today', async () => {
    const ids = seedFileOne();
    expect((await call('PATCH', '/settings', { bank: BANK }, BOSS)).status).toBe(200);
    t.ctx.repos.createStorage(t.ctx.db, { claimId: ids.claimId, location: 'CCGUK yard', startAt: '2026-10-01T09:00:00.000Z', dailyRatePence: 4500, vatRate: 0 });
    const on = await matrix({ code: 'STORAGE_OPEN', status: 409, claimId: ids.claimId, send: (h) => call('POST', `/claims/${ids.claimId}/documents`, { templateId: 'invoice.storage' }, h) });
    expect((on.body as GeneratedDocument).templateId).toBe('invoice.storage');
  });

  it('NO_PAYMENT_PACK — a chaser before the pack, with the pack facts typed', async () => {
    const claim = await newClaim();
    const unit = await call<{ id: string }>('POST', '/fleet', { vehicle: { registration: 'FL44 EET', make: 'VOLKSWAGEN', model: 'POLO' }, declaredUses: ['credit_hire'], gtaGroup: 'S1', dailyRatePence: 4232 }, BOSS);
    expect(unit.status).toBe(201);
    t.ctx.repos.createHire(t.ctx.db, { claimId: claim.id, fleetUnitId: unit.body.id, startAt: '2026-09-01T09:00:00.000Z', endAt: '2026-09-11T09:00:00.000Z', endTrigger: 'repair_complete_24h', dailyRatePence: 4232, vatRate: 0, gtaGroup: 'S1', excessPence: 0 });
    const data = { pack: { sentAt: '2026-10-01', sentBy: 'email', contents: ['Covering letter'] } };
    const on = await matrix({ code: 'NO_PAYMENT_PACK', status: 409, claimId: claim.id, send: (h) => call('POST', `/claims/${claim.id}/documents`, { templateId: 'letter.chaser_7', data }, h) });
    expect((on.body as GeneratedDocument).templateId).toBe('letter.chaser_7');
  });

  it('TEMPLATE_WARNINGS_UNACKNOWLEDGED — generating from a template whose wording has not been reviewed', async () => {
    const ids = seedFileOne();
    const id = 'agreement.ccguk_03_credit_hire';
    const on = await matrix({ code: 'TEMPLATE_WARNINGS_UNACKNOWLEDGED', status: 409, claimId: ids.claimId, send: (h) => call('POST', `/claims/${ids.claimId}/docx-documents`, { templateId: id, subject: { hireAgreementId: ids.hireId } }, h) });
    expect((on.body as GeneratedDocument).format).toBe('docx');
  }, 60_000);

  it('VALUES_REQUIRED — generated with the required slots left blank (kept as warnings)', async () => {
    const ids = seedFileOne();
    const letter = 'letter.ccguk_letterhead_formal';
    expect((await call('POST', `/docx-templates/${letter}/acknowledge`, {}, BOSS)).status).toBe(200);
    const on = await matrix({ code: 'VALUES_REQUIRED', status: 400, claimId: ids.claimId, send: (h) => call('POST', `/claims/${ids.claimId}/docx-documents`, { templateId: letter }, h) });
    const doc = on.body as GeneratedDocument;
    expect(doc.format).toBe('docx');
    const warned = (doc.consistency?.flags ?? []).filter((f) => (f.code as string) === 'VALUES_REQUIRED');
    expect(warned.length).toBeGreaterThan(0);
    for (const f of warned) expect(f.severity).toBe('warn');
  }, 60_000);

  it('GUARD_BLOCKED — PRINTED_RATES_DIFFER on the 02 submission variant', async () => {
    const ids = seedFileOne();
    const id = 'agreement.ccguk_02_recovery_storage_engineering';
    expect((await call('POST', `/docx-templates/${id}/acknowledge`, {}, BOSS)).status).toBe(200);
    const probe = await call<ErrorBody>('POST', `/claims/${ids.claimId}/docx-documents`, { templateId: id, variant: 'submission' }, BOSS);
    expect(probe.body.error.code).toBe('GUARD_BLOCKED');
    expect((probe.body.error.details?.issues as Array<{ code: string }>).map((i) => i.code)).toContain('PRINTED_RATES_DIFFER');
    const on = await matrix({ code: 'GUARD_BLOCKED', status: 409, claimId: ids.claimId, send: (h) => call('POST', `/claims/${ids.claimId}/docx-documents`, { templateId: id, variant: 'submission' }, h) });
    expect((on.body as GeneratedDocument).format).toBe('docx');
  }, 60_000);
});

describe('bypass matrix: settings', () => {
  it('LEGACY_DETAIL — old company details in Settings', async () => {
    const bank = { accountName: 'Carflex Ltd', sortCode: '12-34-56', accountNumber: '12345678', bankName: 'Bank' };
    const on = await matrix({ code: 'LEGACY_DETAIL', status: 400, handlerStatus: 403, send: (h) => call('PATCH', '/settings', { bank }, h) });
    expect((on.body as { bank: { accountName: string } }).bank.accountName).toBe('Carflex Ltd');
    expect(overrideRows('LEGACY_DETAIL')[0]).toMatchObject({ entity: 'settings', entityId: 'default' });
  });

  it('COMPANY_NAME_NOT_REGISTERED — a company name that is not the registered name', async () => {
    const on = await matrix({ code: 'COMPANY_NAME_NOT_REGISTERED', status: 400, handlerStatus: 403, send: (h) => call('PATCH', '/settings', { companyName: 'Courtesy Cars Ltd' }, h) });
    expect((on.body as { companyName: string }).companyName).toBe('Courtesy Cars Ltd');
  });
});

describe('WEB_VALIDATION via X-Manager-Relaxed', () => {
  it('records the relaxed rule keys once, keyed to the claim the request created', async () => {
    const relaxed = { 'x-manager-relaxed': encodeURIComponent('fnol.email,fnol.postcode, fnol.email ,') };
    // off: nothing recorded, nothing refused
    expect((await call('POST', '/claims', FNOL, { ...BOSS, ...relaxed })).status).toBe(201);
    expect((await call('POST', '/claims', FNOL, { ...CLERK, ...OVR, ...relaxed })).status).toBe(201);
    expect(overrideRows()).toHaveLength(0);
    await managerMode(true);
    const res = await call<Claim>('POST', '/claims', FNOL, { ...BOSS, ...OVR, ...relaxed });
    expect(res.status).toBe(201);
    expect(appliedHeader(res)).toEqual([{ code: 'WEB_VALIDATION', label: OVERRIDE_RULES.WEB_VALIDATION!.label, reason: 'Verify test' }]);
    const rows = overrideRows('WEB_VALIDATION');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity: 'claims', entityId: res.body.id, userId: 'boss' });
    expect((rows[0]!.before as { details: { rules: string[] } }).details.rules).toEqual(['fnol.email', 'fnol.postcode']);
    const trail = await call<{ entries: AuditEntry[] }>('GET', `/claims/${res.body.id}/audit`, undefined, BOSS);
    expect(trail.body.entries.map((e) => e.action)).toContain('override.WEB_VALIDATION');
    // a route that never calls the gate still records it (preHandler) — against the route
    const veh = await call('POST', '/vehicles', { registration: 'KX22 ABC' }, { ...BOSS, ...OVR, 'x-manager-relaxed': 'vehicle.make' });
    expect(veh.status).toBe(201);
    expect(overrideRows('WEB_VALIDATION')[0]).toMatchObject({ entity: 'request', entityId: '/api/vehicles' });
    // a failed request writes nothing
    expect((await call('POST', '/vehicles', { registration: 'X' }, { ...BOSS, ...OVR, 'x-manager-relaxed': 'vehicle.make' })).status).toBe(400);
    expect(overrideRows('WEB_VALIDATION')).toHaveLength(2);
    // max 20 keys of max 80 characters
    const many = Array.from({ length: 30 }, (_, i) => `k${i}${'x'.repeat(100)}`).join(',');
    await call('POST', '/vehicles', { registration: 'KX23 ABC' }, { ...BOSS, ...OVR, 'x-manager-relaxed': many });
    const rules = (overrideRows('WEB_VALIDATION')[0]!.before as { details: { rules: string[] } }).details.rules;
    expect(rules).toHaveLength(20);
    for (const r of rules) expect(r.length).toBeLessThanOrEqual(80);
  });

  it('decodes the reason (trimmed, max 500), falls back to the raw value on a bad encoding and to the default when blank', async () => {
    const claim = await newClaim();
    t.ctx.repos.addClaimFlag(t.ctx.db, claim.id, { code: 'FLEET_UNIT_AS_CLIENT_VEHICLE', severity: 'block', message: 'Test hard stop', raisedBy: 'system' });
    await managerMode(true);
    const blank = await call('POST', `/claims/${claim.id}/status`, { status: 'accepted' }, { ...BOSS, 'x-manager-override': '%20%20' });
    expect(blank.status).toBe(200);
    expect(appliedHeader(blank)[0]?.reason).toBe('Manager override');
    const bad = await call('POST', `/claims/${claim.id}/status`, { status: 'hire_active' }, { ...BOSS, 'x-manager-override': 'Broken%E0%A4%A' });
    expect(bad.status).toBe(200);
    expect(appliedHeader(bad)[0]?.reason).toBe('Broken%E0%A4%A');
    const long = await call('POST', `/claims/${claim.id}/status`, { status: 'payment_pack' }, { ...BOSS, 'x-manager-override': encodeURIComponent(`  ${'r'.repeat(600)}  `) });
    expect(appliedHeader(long)[0]?.reason).toBe('r'.repeat(500));
  });
});

// ---------------------------------------------------------------------------
// Class C — stays refused with manager mode on
// ---------------------------------------------------------------------------

describe('class C refusals stay refused in manager mode', () => {
  async function refusedOn(res: Res<ErrorBody>, status: number, code: string): Promise<void> {
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(res.body.error.override).toBeUndefined();
    expect(res.headers['x-manager-overrides']).toBeUndefined();
  }

  it('WRONG_CLAIM, IMMUTABLE, DOCUMENT_STATE, S172_REFUSAL, TRANSITION_REFUSED to liability_transferred', async () => {
    const ids = seedFileOne();
    const other = await newClaim();
    await managerMode(true);
    const H = { ...BOSS, ...OVR };

    const est = await call<{ id: string }>('POST', `/claims/${ids.claimId}/estimate`, { labourRatePence: 4800, paintRatePence: 4800, lines: [{ kind: 'labour', operation: 'Replace', panel: 'Bumper', description: 'Bumper', quantity: 1, hours: 1, confirmedByEngineer: true }] }, H);
    expect(est.status).toBe(201);
    await refusedOn(await call<ErrorBody>('POST', `/claims/${other.id}/estimate/${est.body.id}/approve`, {}, H), 409, 'WRONG_CLAIM');

    await refusedOn(await call<ErrorBody>('PATCH', `/claims/${ids.claimId}/ledger/${ids.paidLedgerId}`, { amountPence: 1 }, H), 409, 'IMMUTABLE');

    const draft = await call<GeneratedDocument>('POST', `/claims/${ids.claimId}/documents`, { templateId: 'letter.chaser_7' }, H);
    expect(draft.status).toBe(201);
    await refusedOn(await call<ErrorBody>('POST', `/documents/${draft.body.id}/send`, { via: 'email' }, H), 409, 'DOCUMENT_STATE');

    const pen = await call<{ id: string }>('POST', '/fleet/penalties', { fleetUnitId: ids.fleetUnitId, kind: 'nip_s172', issuer: 'Example Police', noticeNumber: 'NIP/EX/1', contraventionAt: '2026-09-30T08:00:00.000Z', receivedAt: '2026-10-03T00:00:00.000Z', amountPence: 10000, responseDeadline: '2026-10-31' }, H);
    expect(pen.status).toBe(201);
    const s172 = await call<ErrorBody>('POST', `/fleet/penalties/${pen.body.id}/documents`, { templateId: 'notice.s172_response', data: { cannotIdentify: true, driverName: 'Somebody Else' } }, H);
    expect(s172.status).toBe(400);
    expect(s172.body.error.details?.code).toBe('S172_REFUSAL');
    expect(s172.body.error.override).toBeUndefined();
    await refusedOn(await call<ErrorBody>('POST', `/fleet/penalties/${pen.body.id}/transition`, { stage: 'liability_transferred' }, H), 409, 'TRANSITION_REFUSED');
    await refusedOn(await call<ErrorBody>('POST', `/fleet/penalties/${pen.body.id}/transition`, { stage: 'hirer_identified' }, H), 409, 'TRANSITION_REFUSED');

    expect(overrideRows()).toHaveLength(0);
  });

  it('BANK_DETAILS_PLACEHOLDER and TEMPLATE_CHANGED', async () => {
    const ids = seedFileOne();
    await managerMode(true);
    const H = { ...BOSS, ...OVR };
    expect((await call('PATCH', '/settings', { bank: { accountName: 'Courtesy Cars Group UK Ltd', sortCode: '00-00-00', accountNumber: '00000000', bankName: 'Bank' } }, H)).status).toBe(200);
    const form = 'form.ccguk_05_payment_direction';
    expect((await call('POST', `/docx-templates/${form}/acknowledge`, {}, H)).status).toBe(200);
    const placeholder = await call<ErrorBody>('POST', `/claims/${ids.claimId}/docx-documents`, { templateId: form }, H);
    expect(placeholder.status).toBe(409);
    expect(placeholder.body.error.code).toBe('GUARD_BLOCKED');
    expect((placeholder.body.error.details?.issues as Array<{ code: string }>).map((i) => i.code)).toContain('BANK_DETAILS_PLACEHOLDER');
    expect(placeholder.body.error.override).toBeUndefined();

    // a template whose bytes no longer match the recorded sha256
    const ch = 'agreement.ccguk_03_credit_hire';
    expect((await call('POST', `/docx-templates/${ch}/acknowledge`, {}, H)).status).toBe(200);
    t.ctx.handle.sqlite.prepare("update document_templates set sha256 = ? where id = ?").run('0'.repeat(64), ch);
    await refusedOn(await call<ErrorBody>('POST', `/claims/${ids.claimId}/docx-documents`, { templateId: ch, subject: { hireAgreementId: ids.hireId } }, H), 409, 'TEMPLATE_CHANGED');
    expect(overrideRows()).toHaveLength(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Session mode
// ---------------------------------------------------------------------------

describe('manager mode with real sign-ins (session auth)', () => {
  let s: TestApp;
  const PASSWORD = 'Correct-horse-battery-9';

  beforeEach(async () => {
    s = await createTestApp(NOW, { config: { authMode: 'session' } });
    const hash = await hashPassword(PASSWORD);
    s.ctx.repos.createUser(s.ctx.db, { id: 'boss', name: 'Boss Admin', email: 'boss2@ccguk.test', role: 'admin', username: 'boss', passwordHash: hash });
    s.ctx.repos.createUser(s.ctx.db, { id: 'clerk', name: 'Clerk Handler', email: 'clerk2@ccguk.test', role: 'handler', username: 'clerk', passwordHash: hash });
  });
  afterEach(async () => {
    await s.close();
  });

  async function req<T = unknown>(method: InjectOptions['method'], url: string, payload: unknown, headers: Record<string, string>): Promise<Res<T>> {
    const res = await s.app.inject({ method, url: `/api${url}`, ...(payload !== undefined ? { payload: payload as InjectOptions['payload'] } : {}), headers });
    let body: unknown = res.body;
    try {
      body = res.body ? JSON.parse(res.body) : undefined;
    } catch {
      /* not JSON */
    }
    return { status: res.statusCode, body: body as T, headers: res.headers };
  }
  async function signIn(username: string): Promise<Record<string, string>> {
    const res = await s.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers['set-cookie']).split(';')[0]!;
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    return { cookie };
  }
  const sessionRow = () => s.ctx.repos.listUserSessions(s.ctx.db, 'boss')[0];

  it('on/off on the session row, a gated override, idle expiry, and sign-out', async () => {
    const boss = await signIn('boss');
    expect((await req<ModeView>('GET', '/auth/manager-mode', undefined, boss)).body).toMatchObject({ allowed: true, on: false });
    const on = await req<ModeView>('POST', '/auth/manager-mode', { on: true }, boss);
    expect(on.body).toMatchObject({ on: true, until: '2026-10-05T10:02:00.000Z' });
    expect(sessionRow()?.managerModeUntil).toBe('2026-10-05T10:02:00.000Z');
    expect((await req<{ managerMode: ModeView }>('GET', '/auth/me', undefined, boss)).body.managerMode.on).toBe(true);

    const created = await req<Claim>('POST', '/claims', FNOL, boss);
    expect(created.status).toBe(201);
    s.ctx.repos.addClaimFlag(s.ctx.db, created.body.id, { code: 'FLEET_UNIT_AS_CLIENT_VEHICLE', severity: 'block', message: 'Test hard stop', raisedBy: 'system' });
    const refused = await req<ErrorBody>('POST', `/claims/${created.body.id}/status`, { status: 'accepted' }, boss);
    expect(refused.status).toBe(409);
    expect(refused.body.error.override).toMatchObject({ code: 'HARD_STOP', allowed: true, managerMode: 'on' });
    const ok = await req<Claim>('POST', `/claims/${created.body.id}/status`, { status: 'accepted' }, { ...boss, ...OVR });
    expect(ok.status).toBe(200);
    const row = s.ctx.repos.listAudit(s.ctx.db, { action: 'override.HARD_STOP' })[0];
    expect(row).toMatchObject({ userId: 'boss', entity: 'claims', entityId: created.body.id, after: { reason: 'Verify test' } });

    // idle expiry: cleared on read, audited once
    s.setNow('2026-10-05T10:02:01.000Z');
    expect((await req<ModeView>('GET', '/auth/manager-mode', undefined, boss)).body.on).toBe(false);
    expect(sessionRow()?.managerModeUntil).toBeUndefined();
    expect(s.ctx.repos.listAudit(s.ctx.db, { action: 'manager_mode.off' }).map((r) => (r.after as { why: string }).why)).toEqual(['expired']);

    // on again, then sign out
    await req('POST', '/auth/manager-mode', { on: true }, boss);
    expect(s.ctx.repos.listAudit(s.ctx.db, { action: 'manager_mode.on' })).toHaveLength(2);
    expect((await req('POST', '/auth/logout', undefined, boss)).status).toBe(204);
    expect(s.ctx.repos.listAudit(s.ctx.db, { action: 'manager_mode.off' }).map((r) => (r.after as { why: string }).why)).toEqual(['sign_out', 'expired']);
    const again = await signIn('boss');
    expect((await req<ModeView>('GET', '/auth/manager-mode', undefined, again)).body.on).toBe(false);
  });

  it('a handler gets 403 and its overrides are never allowed; the state route needs a session', async () => {
    const clerk = await signIn('clerk');
    const on = await req<ErrorBody>('POST', '/auth/manager-mode', { on: true }, clerk);
    expect(on.status).toBe(403);
    expect(on.body.error.code).toBe('FORBIDDEN');
    expect((await req<ModeView>('GET', '/auth/manager-mode', undefined, clerk)).body).toMatchObject({ allowed: false, on: false });
    expect((await req<ErrorBody>('PATCH', '/settings', { icoRegistration: 'ZA1' }, clerk)).status).toBe(403);
    const created = await req<Claim>('POST', '/claims', FNOL, clerk);
    s.ctx.repos.addClaimFlag(s.ctx.db, created.body.id, { code: 'FLEET_UNIT_AS_CLIENT_VEHICLE', severity: 'block', message: 'Test hard stop', raisedBy: 'system' });
    const refused = await req<ErrorBody>('POST', `/claims/${created.body.id}/status`, { status: 'accepted' }, { ...clerk, ...OVR });
    expect(refused.status).toBe(409);
    expect(refused.body.error.override).toMatchObject({ allowed: false });
    expect(s.ctx.repos.listAudit(s.ctx.db, { action: 'override.HARD_STOP' })).toHaveLength(0);
    // 401 without a session, even with the header
    expect((await req<ErrorBody>('GET', '/auth/manager-mode', undefined, {})).status).toBe(401);
    expect((await req<ErrorBody>('POST', '/auth/manager-mode', { on: true }, OVR)).status).toBe(401);
    expect((await req<ErrorBody>('POST', `/claims/${created.body.id}/status`, { status: 'accepted' }, OVR)).status).toBe(401);
  });
});
