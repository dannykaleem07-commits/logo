/**
 * On-file vehicle search (TEMPLATES-VEHICLES-DESKTOP §E.1): what ClaimDesk already holds for a registration — the exact
 * vehicle first, then partial matches (≥ 4 characters) — with its claims, fleet unit and lookup history (previous
 * manual entries and pastes included). Read-only: a search never writes.
 */
import { normaliseRegistration, type OnFileMatch, type Vehicle } from '@ccguk/domain';
import type { AppContext } from '../context.js';

const FLEET_STATUS_ORDER = ['on_hire', 'available', 'off_road', 'disposed'] as const;

export function onFileMatch(ctx: AppContext, v: Vehicle, match: OnFileMatch['match']): OnFileMatch {
  const claims = ctx.repos
    .listClaimsForRegistration(ctx.db, v.registration)
    .map((c) => ({ id: c.id, reference: c.reference, openedAt: c.openedAt }));
  const units = ctx.repos
    .findFleetUnitsByRegistration(ctx.db, v.registration)
    .filter((u) => u.vehicleId === v.id)
    .sort((a, b) => FLEET_STATUS_ORDER.indexOf(a.status) - FLEET_STATUS_ORDER.indexOf(b.status));
  const unit = units[0];
  const out: OnFileMatch = {
    vehicleId: v.id,
    registration: v.registration,
    match,
    make: v.make,
    model: v.model,
    ownership: v.ownership,
    claims,
    lookups: [...v.lookups]
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .map((l) => ({ provider: l.provider, kind: l.kind, requestedAt: l.requestedAt, verification: l.verification.status })),
  };
  if (v.variant) out.variant = v.variant;
  if (v.colour) out.colour = v.colour;
  if (v.yearOfManufacture !== undefined) out.yearOfManufacture = v.yearOfManufacture;
  if (v.fuelType) out.fuelType = v.fuelType;
  if (v.transmission) out.transmission = v.transmission;
  if (v.engineCapacityCc !== undefined) out.engineCapacityCc = v.engineCapacityCc;
  if (v.bodyType) out.bodyType = v.bodyType;
  if (v.spec) out.spec = v.spec;
  if (unit) out.fleetUnit = { id: unit.id, status: unit.status, gtaGroup: unit.gtaGroup, dailyRatePence: unit.dailyRatePence };
  const updatedAt = ctx.repos.vehicleUpdatedAt(ctx.db, v.id);
  if (updatedAt) out.updatedAt = updatedAt;
  return out;
}

/** Exact registration first, then partial matches (LIKE on the normalised registration, ≥ 4 characters). */
export function onFileMatches(ctx: AppContext, registration: string, limit = 10): OnFileMatch[] {
  const reg = normaliseRegistration(registration ?? '');
  if (!reg) return [];
  const max = Math.max(1, Math.min(50, Math.floor(limit)));
  const out: OnFileMatch[] = [];
  const exact = ctx.repos.findByRegistration(ctx.db, reg);
  if (exact) out.push(onFileMatch(ctx, exact, 'exact'));
  if (out.length < max && reg.length >= 4) {
    for (const v of ctx.repos.findVehiclesByPartialRegistration(ctx.db, reg, max - out.length)) out.push(onFileMatch(ctx, v, 'partial'));
  }
  return out.slice(0, max);
}
