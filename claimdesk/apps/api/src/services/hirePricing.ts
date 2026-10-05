/**
 * Hire pricing guide on the server (docs/V03-MANAGER-MODE-HIRE-PRICING.md §B.3): the fleet car's daily rate next to
 * the GTA guide for the car we give and the GTA guide for the client's accident-damaged car (like for like). GTA rates
 * are a benchmark only — CCGUK is not a GTA subscriber — and their verification status is reported as stored.
 *
 * `hirePricingFor` serves GET /claims/:id/hire/pricing-guide and the snapshot written by POST /claims/:id/hire;
 * `hirePricingSnapshot` turns a hire row back into the read-only figures shown on each hire card. Hires recorded
 * before 0.3 have no snapshot: their figures are computed at read time from the client car's current group
 * (`snapshot: false`).
 */
import {
  gtaGroupsOn,
  hirePricingGuide,
  londonDate,
  type ClientGroupSource,
  type FleetUnit,
  type GtaRate,
  type GtaSuggestion,
  type HireAgreement,
  type HirePricingGuide,
  type Id,
  type ISODate,
  type ISODateTime,
  type Pence,
  type Vehicle,
} from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { gtaSuggestionFor } from './catalogue.js';
import { gtaRatesFor } from './kb.js';

export interface HirePricingGuideResponse extends HirePricingGuide {
  fleetUnit: { id: Id; registration?: string; make?: string; model?: string; status: FleetUnit['status']; gtaGroup: string; dailyRatePence: Pence };
  clientVehicle: { id: Id; registration: string; make?: string; model?: string; gtaGroup?: string };
  /** The full suggestion behind clientCar (confidence, basis, reason) — shown under the group. */
  clientSuggestion: GtaSuggestion;
  /** Groups with a rate in force on `date`, for the "change group" select. */
  groupsOnDate: string[];
}

/** Read-only pricing figures for a hire card (§B.3). */
export interface HirePricingSnapshot {
  /** false for pre-0.3 hires: figures computed now from the client car's current group. */
  snapshot: boolean;
  agreedDailyRatePence: Pence;
  fleetDailyRatePence: Pence | null;
  hireGroup: string;
  hireGtaDailyRatePence: Pence | null;
  clientGtaGroup: string | null;
  clientGtaDailyRatePence: Pence | null;
  differencePerDayPence: Pence | null;
  higherGroup: boolean;
  notices: string[];
  note: string;
}

/** The five snapshot columns written on a hire (create, and a correction that re-prices it). */
export interface HirePricingColumns {
  clientGtaGroup: string | null;
  clientGtaDailyRatePence: Pence | null;
  hireGtaDailyRatePence: Pence | null;
  fleetDailyRatePence: Pence;
  pricingNote: string | null;
}

export const PRICING_NOTE_MAX = 1000;

function vehicleSuggestion(ctx: AppContext, v: Vehicle, date: ISODate): GtaSuggestion {
  const spec = v.spec;
  return gtaSuggestionFor(ctx, {
    make: spec?.catalogue?.makeSlug ?? v.make,
    model: spec?.catalogue?.modelSlug ?? v.model,
    generationId: spec?.catalogue?.generationId,
    trimId: spec?.catalogue?.trimId,
    segment: spec?.segment,
    bodyType: v.bodyType,
    engineCapacityCc: v.engineCapacityCc,
    fuelType: v.fuelType,
    variant: v.variant,
    recordedGroup: v.gtaGroup,
    ...(v.yearOfManufacture !== undefined ? { yearOfManufacture: v.yearOfManufacture } : {}),
    date,
  });
}

/**
 * The pricing guide for putting `unit` on hire on claim `claimId` from `startAt`. Client group: `clientGroupOverride`
 * (source manual), else the vehicle's group suggestion — `recorded` when the group is recorded on the car, `suggested`
 * when one came back, else `none`.
 */
export function hirePricingFor(ctx: AppContext, claimId: Id, unit: FleetUnit, startAt: ISODateTime, clientGroupOverride?: string): HirePricingGuideResponse {
  const claim = ctx.repos.requireClaim(ctx.db, claimId);
  const client = ctx.repos.requireVehicle(ctx.db, claim.clientVehicleId);
  const unitVehicle = ctx.repos.getVehicle(ctx.db, unit.vehicleId);
  const date = londonDate(startAt);
  const rates = gtaRatesFor(ctx);
  const clientSuggestion = vehicleSuggestion(ctx, client, date);
  const override = clientGroupOverride?.trim().toUpperCase() || undefined;
  const clientGroup = override ?? clientSuggestion.group;
  const clientGroupSource: ClientGroupSource = override ? 'manual' : clientSuggestion.basis === 'recorded' ? 'recorded' : clientSuggestion.group ? 'suggested' : 'none';
  const guide = hirePricingGuide({ date, fleetDailyRatePence: unit.dailyRatePence, hireGroup: unit.gtaGroup, clientGroup, clientGroupSource, rates });
  return {
    ...guide,
    fleetUnit: {
      id: unit.id,
      ...(unitVehicle?.registration ? { registration: unitVehicle.registration } : {}),
      ...(unitVehicle?.make ? { make: unitVehicle.make } : {}),
      ...(unitVehicle?.model ? { model: unitVehicle.model } : {}),
      status: unit.status,
      gtaGroup: unit.gtaGroup,
      dailyRatePence: unit.dailyRatePence,
    },
    clientVehicle: {
      id: client.id,
      registration: client.registration,
      ...(client.make ? { make: client.make } : {}),
      ...(client.model ? { model: client.model } : {}),
      ...(client.gtaGroup ? { gtaGroup: client.gtaGroup } : {}),
    },
    clientSuggestion,
    groupsOnDate: gtaGroupsOn(date, rates),
  };
}

/** The snapshot columns to store for a pricing guide. */
export function pricingColumns(guide: HirePricingGuide): HirePricingColumns {
  const note = guide.notices.join(' ').slice(0, PRICING_NOTE_MAX);
  return {
    clientGtaGroup: guide.clientCar.group,
    clientGtaDailyRatePence: guide.clientCar.dailyRatePence,
    hireGtaDailyRatePence: guide.hireCar.dailyRatePence,
    fleetDailyRatePence: guide.fleetDailyRatePence,
    pricingNote: note || null,
  };
}

/** True when the hire carries a 0.3 pricing snapshot. */
export function hasPricingSnapshot(h: HireAgreement): boolean {
  return h.fleetDailyRatePence !== undefined || h.clientGtaGroup !== undefined || h.hireGtaDailyRatePence !== undefined || h.clientGtaDailyRatePence !== undefined;
}

/** A rate table made of the snapshot's own figures, so the notices are rebuilt from what was recorded. */
function snapshotRates(date: ISODate, lines: Array<{ group: string | null | undefined; pence: Pence | null | undefined }>): GtaRate[] {
  const out: GtaRate[] = [];
  for (const l of lines) {
    if (!l.group || l.pence === undefined || l.pence === null) continue;
    out.push({ group: l.group, dailyRatePence: l.pence, period: 'snapshot', effectiveFrom: date, effectiveTo: date, verification: { status: 'verified', sourceNote: 'Figure recorded on the hire when it was set up' } });
  }
  return out;
}

/**
 * Pricing figures for a hire card. With a snapshot the recorded figures are shown as they were (notices rebuilt from
 * them); without one (pre-0.3) they are computed now from the client car's current group and today's rate table.
 */
export function hirePricingSnapshot(ctx: AppContext, h: HireAgreement, clientVehicle: Pick<Vehicle, 'gtaGroup'> | undefined, rates: GtaRate[] = gtaRatesFor(ctx)): HirePricingSnapshot {
  const date = londonDate(h.startAt);
  if (hasPricingSnapshot(h)) {
    const fleet = h.fleetDailyRatePence ?? null;
    const guide = hirePricingGuide({
      date,
      fleetDailyRatePence: fleet ?? h.dailyRatePence,
      hireGroup: h.gtaGroup,
      clientGroup: h.clientGtaGroup ?? null,
      clientGroupSource: h.clientGtaGroup ? 'recorded' : 'none',
      rates: snapshotRates(date, [
        { group: h.gtaGroup, pence: h.hireGtaDailyRatePence },
        { group: h.clientGtaGroup, pence: h.clientGtaDailyRatePence },
      ]),
    });
    return {
      snapshot: true,
      agreedDailyRatePence: h.dailyRatePence,
      fleetDailyRatePence: fleet,
      hireGroup: h.gtaGroup,
      hireGtaDailyRatePence: h.hireGtaDailyRatePence ?? null,
      clientGtaGroup: h.clientGtaGroup ?? null,
      clientGtaDailyRatePence: h.clientGtaDailyRatePence ?? null,
      differencePerDayPence: guide.differencePerDayPence,
      higherGroup: guide.higherGroup,
      notices: fleet === null ? guide.notices.filter((n) => !n.startsWith('Your fleet rate')) : guide.notices,
      note: guide.note,
    };
  }
  const clientGroup = clientVehicle?.gtaGroup?.trim().toUpperCase() || null;
  // Computed now: the fleet unit's current rate stands in for the rate at the time (not recorded before 0.3).
  const unitRate = ctx.repos.getFleetUnit(ctx.db, h.fleetUnitId)?.dailyRatePence ?? null;
  const guide = hirePricingGuide({ date, fleetDailyRatePence: h.dailyRatePence, hireGroup: h.gtaGroup, clientGroup, clientGroupSource: clientGroup ? 'recorded' : 'none', rates });
  return {
    snapshot: false,
    agreedDailyRatePence: h.dailyRatePence,
    fleetDailyRatePence: h.fleetDailyRatePence ?? unitRate,
    hireGroup: h.gtaGroup,
    hireGtaDailyRatePence: guide.hireCar.dailyRatePence,
    clientGtaGroup: guide.clientCar.group,
    clientGtaDailyRatePence: guide.clientCar.dailyRatePence,
    differencePerDayPence: guide.differencePerDayPence,
    higherGroup: guide.higherGroup,
    // the fleet rate at the time is not known for a pre-0.3 hire: no "your fleet rate" notices
    notices: guide.notices.filter((n) => !n.startsWith('Your fleet rate')),
    note: guide.note,
  };
}
