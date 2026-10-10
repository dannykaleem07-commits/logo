// owned by ap-booking — shared seed for the booking API tests (docs/SUPREME-AUTOPILOT.md §J.2, §J.5)
import { expect } from 'vitest';
import type { Claim, FleetUnit, Vehicle } from '@ccguk/domain';
import { blankHireNeeds } from '@ccguk/domain';
import { FNOL, type TestApp } from './helpers.js';
import { mintRunToken, revokeRunToken } from '../agent/principal.js';

export interface Fleet {
  A: FleetUnit; // S1 automatic hatch — like for like
  B: FleetUnit; // S1 manual
  C: FleetUnit; // M2 SUV — higher group
}

/** Monday 09:00 London. */
export const MONDAY = '2026-10-12T08:00:00.000Z';
export const START = '2026-10-12T11:00:00.000Z';
export const END = '2026-10-26T11:00:00.000Z';

export function fleetCar(t: TestApp, registration: string, gtaGroup: string, extra: Partial<Vehicle> = {}, unitExtra: Partial<FleetUnit> = {}): FleetUnit {
  const v = t.ctx.repos.upsertVehicle(t.ctx.db, { registration, make: 'Ford', model: 'Focus', bodyType: 'Hatchback', fuelType: 'petrol', transmission: 'automatic', motExpiryDate: '2027-08-01', taxDueDate: '2027-08-01', ownership: 'fleet', spec: { seats: 5, features: [], extras: [] }, ...extra } as never);
  const policy = t.ctx.repos.createPolicy(t.ctx.db, { insurerName: 'Fleet Insurer Ltd', policyNumber: `FL-${registration}`, coveredUses: ['credit_hire'], startDate: '2026-01-01', endDate: '2027-12-31' });
  return t.ctx.repos.createFleetUnit(t.ctx.db, { vehicleId: v.id, declaredUses: ['credit_hire'], policyId: policy.id, dailyRatePence: 4000, gtaGroup, ...unitExtra });
}

export function seedFleet(t: TestApp): Fleet {
  return {
    A: fleetCar(t, 'AA26 AAA', 'S1'),
    B: fleetCar(t, 'BB26 BBB', 'S1', { transmission: 'manual' }),
    C: fleetCar(t, 'CC26 CCC', 'M2', { bodyType: 'SUV', model: 'Kuga' }, { dailyRatePence: 7000 }),
  };
}

let regSeq = 0;
/** A new claim (client car group S1, automatic) with clean flags and hire needs. */
export async function seedClaim(t: TestApp, extra: { automaticOnly?: boolean } = {}): Promise<Claim> {
  regSeq += 1;
  const registration = `KX2${regSeq % 10} A${String.fromCharCode(65 + (regSeq % 26))}C`;
  const created = await t.api<{ claim: Claim }>('POST', '/claims', { ...FNOL, vehicle: { ...FNOL.vehicle, registration }, claimant: { ...FNOL.claimant, name: `Client ${regSeq}`, email: `client${regSeq}@example.com` } });
  expect(created.status).toBe(201);
  const claim = created.body.claim;
  t.ctx.repos.updateVehicle(t.ctx.db, claim.clientVehicleId, { gtaGroup: 'S1', transmission: 'automatic', bodyType: 'Hatchback', fuelType: 'petrol' });
  // clear any intake hard stops so the booking guards under test are the only ones
  for (const f of t.ctx.repos.requireClaim(t.ctx.db, claim.id).flags.filter((x) => x.severity === 'block' && !x.clearedAt)) t.ctx.repos.clearClaimFlag(t.ctx.db, claim.id, f.code, { userId: 'system' }, 'test');
  t.ctx.repos.putHireNeeds(t.ctx.db, claim.id, { ...blankHireNeeds(), automaticOnly: extra.automaticOnly ?? false, clientWantsHire: true }, 'test');
  return t.ctx.repos.requireClaim(t.ctx.db, claim.id);
}

export type ApiErr = { error: { code: string; message: string; details?: Record<string, unknown>; override?: { code: string } } };

/** Call the API as a claim-scoped agent principal (a run token from loopback). */
export async function asAgent<T>(t: TestApp, claimId: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const tok = mintRunToken({ name: 'autopilot', runId: `run-${Math.random().toString(36).slice(2)}`, jobId: 'job-test', claimScope: claimId }, 60_000);
  try {
    const res = await t.app.inject({ method, url: `/api${url}`, payload: payload as never, headers: { authorization: `Bearer ${tok}` } });
    return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : undefined) as T };
  } finally {
    revokeRunToken(tok);
  }
}

export const holdBody = (unit: FleetUnit, extra: Record<string, unknown> = {}) => ({ fleetUnitId: unit.id, use: 'credit_hire', startAt: START, expectedEndAt: END, ...extra });

export async function managerOn(t: TestApp): Promise<Record<string, string>> {
  const on = await t.api<{ on: boolean }>('POST', '/auth/manager-mode', { on: true });
  expect(on.body.on).toBe(true);
  return { 'x-manager-override': encodeURIComponent('Booking test override') };
}
