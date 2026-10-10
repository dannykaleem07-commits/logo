// owned by ap-booking
/**
 * Availability search and ranking (docs/SUPREME-AUTOPILOT.md §B.5). Pure: the API assembles one `UnitSnapshot` per
 * fleet car and the query; this decides which cars can go out for the whole period and ranks them.
 *
 * Hard filters exclude a car and list EVERY reason (so the owner sees why it is not offered): disposed / off road;
 * whole-period compliance (`canAllocateForPeriod`); occupied by another claim; not ready; hard needs; driver
 * ineligible against the car's policy criteria; the car is a vehicle on this claim.
 *
 * Scores (each 0..1) are weighted (weights normalised to 100) and summed to 0..100. Ties: earlier `readyBy`, then
 * lower mileage, then registration. Distance is "if known": no geocoding is bundled.
 */
import type { ClashCode, ClashFinding, ClashOverrideClass, ClashSeverity } from '../clash/types.js';
import { assessDriver } from '../eligibility/driver.js';
import type { DriverCriteria, EligibilityOutcome } from '../eligibility/types.js';
import { ELIGIBILITY_OUTCOME_RANK } from '../eligibility/types.js';
import { hirePricingGuide } from '../gta/pricing.js';
import { isoToMs, londonDate, msToUtcIso } from '../calendar/index.js';
import { formatRegistration } from '../vehicle/registration.js';
import type { FleetUse, GtaRate, Id, ISODateTime, Vehicle } from '../types.js';
import { candidateGreen, DEFAULT_MIN_LIKE_FOR_LIKE } from './green.js';
import { bodyFamily, likeForLike } from './likeForLike.js';
import { canAllocateForPeriod } from './periodCompliance.js';
import { readyByTime, unitReadiness } from './readiness.js';
import { isBlockingStatus, occupiedPeriod, periodsOverlapMs } from './reservation.js';
import {
  RANK_FACTORS,
  type AvailabilityCandidate,
  type AvailabilityQuery,
  type AvailabilityResult,
  type ExcludedUnit,
  type HireNeeds,
  type RankFactor,
  type RankingWeights,
  type UnitSnapshot,
} from './types.js';

export interface AvailabilityEnv {
  rates: GtaRate[];
  weights: RankingWeights;
  turnaroundMinutes: number;
  clearWinnerGap: number;
  criteria: (policyId: Id | undefined) => DriverCriteria;
  now: ISODateTime;
  /** settings.green.minLikeForLike (default 0.8). */
  minLikeForLike?: number;
  /** Vehicles on this claim (client / third party): never offered (clash UNIT_IS_CLAIM_VEHICLE). */
  claimVehicleIds?: readonly Id[];
  /** Driver assessment (default `assessDriver`, eligibility/driver.ts); injectable for callers that already assessed. */
  assessDriver?: typeof assessDriver;
}

const TWO_HOURS = 2 * 60 * 60_000;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const USE_WORDS: Record<FleetUse, string> = { credit_hire: 'credit hire', self_drive: 'self-drive', pco: 'PCO / private hire' };

/** Weights normalised to sum 100 (all zero → the defaults' proportions are not assumed: equal weights). */
export function normaliseWeights(w: RankingWeights): RankingWeights {
  const vals = RANK_FACTORS.map((f) => Math.max(0, Number(w[f]) || 0));
  const sum = vals.reduce((a, b) => a + b, 0);
  const out = {} as RankingWeights;
  RANK_FACTORS.forEach((f, i) => {
    out[f] = sum > 0 ? (vals[i]! / sum) * 100 : 100 / RANK_FACTORS.length;
  });
  return out;
}

const titleCase = (s: string): string => (s && s === s.toUpperCase() && s.length > 3 ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s);

/** "Ford Focus 1.0 auto, 5 seats, petrol (C2)". */
export function unitLabel(vehicle: Pick<Vehicle, 'make' | 'model' | 'variant' | 'transmission' | 'fuelType' | 'spec'>, group: string): string {
  const name = [titleCase(vehicle.make), titleCase(vehicle.model), vehicle.variant].filter(Boolean).join(' ');
  const gear = vehicle.transmission === 'automatic' ? ' auto' : vehicle.transmission === 'manual' ? ' manual' : '';
  const parts = [`${name}${gear}`];
  if (vehicle.spec?.seats) parts.push(`${vehicle.spec.seats} seats`);
  if (vehicle.fuelType) parts.push(vehicle.fuelType.replace('_', '-'));
  return `${parts.join(', ')} (${group})`;
}

/** UK outward code ("SW1A 1AA" → "SW1A") and area ("SW"). */
export function postcodeParts(pc: string | null | undefined): { district: string; area: string } | null {
  const p = (pc ?? '').toUpperCase().replace(/\s+/g, '');
  if (p.length < 2) return null;
  const district = p.length > 4 ? p.slice(0, p.length - 3) : p;
  const area = (district.match(/^[A-Z]+/) ?? [''])[0];
  return area ? { district, area } : null;
}

function features(v: Vehicle): string[] {
  return [...(v.spec?.features ?? []), ...(v.spec?.extras ?? [])].map((f) => f.toLowerCase());
}

function finding(code: ClashCode, severity: ClashSeverity, message: string, snap: UnitSnapshot, claimId: Id | null, extra: Partial<ClashFinding['related']> = {}, data?: Record<string, unknown>): ClashFinding {
  const overrideClass: ClashOverrideClass = severity === 'block' ? 'A' : 'B';
  const related = { claimIds: [], reservationIds: [], hireIds: [], fleetUnitIds: [snap.unit.id], partyIds: [], ...extra };
  return {
    code,
    severity,
    overrideClass,
    message,
    ...(claimId ? { claimId } : {}),
    fleetUnitId: snap.unit.id,
    related,
    dedupeKey: [code, claimId ?? '-', snap.unit.id, ...[...related.reservationIds].sort()].join(':'),
    ...(data ? { data } : {}),
  };
}

const worst = (a: EligibilityOutcome, b: EligibilityOutcome): EligibilityOutcome => (ELIGIBILITY_OUTCOME_RANK[b] > ELIGIBILITY_OUTCOME_RANK[a] ? b : a);

interface Evaluated {
  candidate?: AvailabilityCandidate;
  excluded?: ExcludedUnit;
  mileage: number;
}

function evaluate(q: AvailabilityQuery, snap: UnitSnapshot, env: AvailabilityEnv, weights: RankingWeights, use: FleetUse): Evaluated {
  const { unit, vehicle } = snap;
  const registration = formatRegistration(vehicle.registration);
  const reasons: Array<{ code: string; message: string }> = [];
  const warnings: ClashFinding[] = [];
  const startMs = isoToMs(q.startAt);
  const period = { startAt: q.startAt, expectedEndAt: q.expectedEndAt };
  const needs: HireNeeds = q.needs;

  // 7. A vehicle on this claim.
  if (env.claimVehicleIds?.includes(vehicle.id)) reasons.push({ code: 'UNIT_IS_CLAIM_VEHICLE', message: 'this car is a vehicle on this claim' });

  // 1. Disposed / off road (an off-road car counts when a readiness estimate puts it back before the start).
  let unitForCheck = unit;
  if (unit.status === 'disposed') reasons.push({ code: 'UNIT_DISPOSED', message: 'the car has been disposed of' });
  else if (unit.status === 'off_road') {
    const back = snap.readiness.some((t) => t.status === 'open' && t.readyByAt && isoToMs(t.readyByAt) <= startMs);
    if (back) unitForCheck = { ...unit, status: 'available' };
    else reasons.push({ code: 'UNIT_OFF_ROAD', message: 'the car is marked off the road' });
  }

  // 2. Whole-period compliance.
  const compliance = canAllocateForPeriod(unitForCheck, use, snap.policies, period, vehicle, { now: env.now });
  for (const b of compliance.blocks) {
    if (b.code === 'UNIT_OFF_ROAD' || b.code === 'UNIT_DISPOSED') continue; // already reported in plain words
    reasons.push({ code: b.code, message: b.message });
  }
  for (const w of compliance.warns) {
    const code = (['MOT_LAPSES_IN_PERIOD', 'TAX_LAPSES_IN_PERIOD', 'SERVICE_DUE_IN_PERIOD', 'KEEPER_ADDRESS_STALE', 'PHV_LICENCE'] as const).find((c) => c === w.code);
    if (code) warnings.push(finding(code, 'warn', w.message, snap, q.claimId));
  }

  // 3. Occupied by another claim; turnaround after a return.
  const mine = q.excludeReservationIds;
  const occupiedBy = snap.reservations.filter((r) => !mine.includes(r.id) && isBlockingStatus(r.status) && (q.claimId === null || r.claimId !== q.claimId));
  const wanted = { startMs, endMs: isoToMs(q.expectedEndAt) };
  const clashes = occupiedBy.filter((r) => periodsOverlapMs(wanted, occupiedPeriod(r, env.now)));
  if (clashes.length) {
    reasons.push({ code: 'UNIT_DOUBLE_BOOKED', message: `already ${clashes.some((r) => r.status === 'on_hire') ? 'on hire' : 'held or booked'} for another claim for part of this period` });
  }
  const turnaround = (unit.turnaroundMinutes ?? env.turnaroundMinutes) * 60_000;
  const before = occupiedBy
    .map((r) => occupiedPeriod(r, env.now))
    .filter((p) => p.endMs !== null && p.endMs <= startMs && startMs - p.endMs < turnaround);
  if (before.length && !clashes.length) {
    warnings.push(finding('TURNAROUND_SHORT', 'warn', `${registration} comes back less than ${Math.round(turnaround / 60_000)} minutes before this start — little time to valet and inspect.`, snap, q.claimId));
  }

  // 4. Readiness at the start (blocking tasks / damage) and when the car is ready.
  const atStart = unitReadiness(snap.readiness, snap.damage, q.startAt);
  if (atStart.state === 'not_ready') reasons.push({ code: 'UNIT_NOT_READY', message: 'not ready for the start (blocking repair, MOT, tax or licence work with no ready date)' });
  const blockingLate = snap.readiness.filter((t) => t.status === 'open' && t.blocksHire && t.readyByAt && isoToMs(t.readyByAt) > startMs);
  if (blockingLate.length) reasons.push({ code: 'UNIT_NOT_READY', message: `not ready until ${londonDate(blockingLate.map((t) => t.readyByAt!).sort().reverse()[0]!)} (${blockingLate.map((t) => t.kind.replace('_', ' ')).join(', ')})` });
  const nowReadiness = unitReadiness(snap.readiness, snap.damage, env.now);
  const readyBy = readyByTime(nowReadiness, env.now) ?? readyByTime(atStart, q.startAt) ?? q.startAt;

  // 5. Hard needs.
  const licence78 = q.drivers.some((d) => d.profile?.restrictionCodes?.includes('78'));
  if (needs.automaticOnly || licence78) {
    if (vehicle.transmission !== 'automatic') {
      const why = licence78 ? "the driver's licence is automatic-only (code 78)" : 'the client can only drive an automatic';
      reasons.push({ code: 'NEED_AUTOMATIC', message: `${vehicle.transmission === 'manual' ? 'manual gearbox' : 'gearbox not recorded'}; ${why}` });
    }
  }
  const seats = vehicle.spec?.seats;
  if (needs.seatsMin !== null && needs.seatsMin !== undefined && ((seats !== undefined && seats < needs.seatsMin) || (seats === undefined && needs.seatsMin > 5))) {
    reasons.push({ code: 'NEED_SEATS', message: seats !== undefined ? `${seats} seats; the client needs ${needs.seatsMin}` : `seats not recorded; the client needs ${needs.seatsMin}` });
  }
  const f = features(vehicle);
  if (needs.wheelchairAccessible && !f.includes('wheelchair_access')) reasons.push({ code: 'NEED_WHEELCHAIR', message: 'not wheelchair accessible' });
  if (needs.handControls && !f.some((x) => x.startsWith('hand_controls'))) reasons.push({ code: 'NEED_HAND_CONTROLS', message: 'no hand controls' });
  if (needs.towbar && !f.some((x) => x.startsWith('tow_bar') || x === 'aftermarket_towbar')) reasons.push({ code: 'NEED_TOWBAR', message: 'no tow bar' });
  if (needs.evOk === false && vehicle.fuelType === 'electric') reasons.push({ code: 'NEED_NOT_EV', message: 'electric; the client cannot use an electric car' });

  // 6. Drivers against THIS car's policy criteria.
  const criteria = env.criteria(unit.policyId);
  let driverOutcome: EligibilityOutcome = q.drivers.length ? 'eligible' : 'unknown';
  for (const d of q.drivers) {
    const e = (env.assessDriver ?? assessDriver)(d.profile, d.party, criteria, londonDate(q.startAt));
    driverOutcome = worst(driverOutcome, e.outcome);
    const name = d.party.name ?? 'The driver';
    if (e.outcome === 'ineligible') reasons.push({ code: 'DRIVER_INELIGIBLE', message: `${name} is not eligible under this car's insurance (${e.reasons.filter((r) => r.outcome === 'ineligible').map((r) => r.message).join('; ') || 'criteria not met'})` });
    else if (e.outcome === 'refer') warnings.push(finding('DRIVER_REFERRAL', 'warn', `${name} needs the insurer's acceptance before booking (${e.reasons.filter((r) => r.outcome === 'refer').map((r) => r.message).join('; ') || 'referral'}).`, snap, q.claimId, { partyIds: [d.partyId] }));
  }

  if (reasons.length) return { excluded: { fleetUnitId: unit.id, registration, reasons }, mileage: unit.currentMileage ?? Number.MAX_SAFE_INTEGER };

  // Scores.
  const date = londonDate(q.startAt);
  const lfl = likeForLike(q.clientVehicle, q.clientGroup, vehicle, unit.gtaGroup, env.rates, date);
  if (lfl.group.relation === 'higher') {
    warnings.push(finding('GROUP_ABOVE_LFL', 'warn', `${registration} (${lfl.group.car}) is in a higher hire group than the client's car (${lfl.group.client}) — only the like-for-like rate is recoverable; record a substitution reason.`, snap, q.claimId));
  }
  const pricing = hirePricingGuide({ date, fleetDailyRatePence: unit.dailyRatePence, hireGroup: unit.gtaGroup, clientGroup: q.clientGroup, clientGroupSource: q.clientGroupSource, rates: env.rates });

  // needsFit — share of soft preferences met.
  const prefs: Array<{ met: boolean; label: string }> = [];
  if (needs.automaticPreferred && !needs.automaticOnly) prefs.push({ met: vehicle.transmission === 'automatic', label: 'automatic preferred' });
  if (needs.isofixCount > 0) prefs.push({ met: f.some((x) => x.includes('isofix')), label: 'ISOFIX' });
  if (needs.largeBoot) {
    const fam = bodyFamily(vehicle);
    prefs.push({ met: fam === 'estate' || fam === 'suv' || fam === 'mpv' || fam === 'van', label: 'large boot' });
  }
  if (vehicle.fuelType === 'electric') prefs.push({ met: needs.evOk === true, label: 'happy with electric' });
  const needsScore = prefs.length ? prefs.filter((p) => p.met).length / prefs.length : 1;
  const needsNote = prefs.length ? `${prefs.filter((p) => p.met).length} of ${prefs.length} preferences met` : 'No preferences recorded';

  // readiness
  const readyByMs = isoToMs(readyBy);
  const nowMs = isoToMs(env.now);
  let readinessScore: number;
  let readinessNote: string;
  if (nowReadiness.state === 'ready' || readyByMs <= nowMs) {
    readinessScore = 1;
    readinessNote = 'Ready now';
  } else if (readyByMs <= startMs) {
    readinessScore = 0.7;
    readinessNote = `Ready by the start (${nowReadiness.state === 'ready_by' ? 'tasks open' : 'estimate'})`;
  } else if (readyByMs <= startMs + TWO_HOURS) {
    readinessScore = 0.4;
    readinessNote = 'Ready within 2 hours of the start';
  } else {
    readinessScore = 0;
    readinessNote = `Ready only at ${msToUtcIso(readyByMs)}`;
    warnings.push(finding('DELIVERY_BEFORE_READY', 'warn', `${registration} is not ready until after the start — move the delivery.`, snap, q.claimId));
  }

  // compliance
  const lapseInside = compliance.lapses.length > 0;
  const margin = compliance.marginDays;
  const complianceScore = lapseInside ? 0 : margin >= 30 ? 1 : margin >= 7 ? 0.6 : 0.2;
  const complianceNote = lapseInside ? `${compliance.lapses.map((l) => l.kind.replace('_', ' ')).join(', ')} lapses during the hire` : margin >= 365 ? 'Cover and compliance well beyond the hire' : `Cover +${margin} days after the expected end`;

  // cost vs the client's like-for-like guide
  const guide = pricing.clientCar.dailyRatePence;
  let costScore = 0.5;
  let costNote = 'No like-for-like guide rate';
  if (guide !== null) {
    const rate = unit.dailyRatePence;
    costScore = rate <= guide ? 1 : rate <= guide * 1.1 ? 0.6 : 0.2;
    const diff = rate - guide;
    costNote = diff <= 0 ? 'At or below the like-for-like guide' : `£${(diff / 100).toFixed(2)}/day above the like-for-like guide`;
  }

  // location
  let locationScore = 0.5;
  let locationNote = 'Distance not known';
  const loc = snap.location;
  const dest = postcodeParts(needs.deliveryPostcode ?? needs.deliveryAddress?.postcode ?? null);
  const from = postcodeParts(loc?.postcode ?? null);
  if (dest && from) {
    if (dest.district === from.district) {
      locationScore = 1;
      locationNote = `Same postcode district (${from.district})`;
    } else if (dest.area === from.area) {
      locationScore = 0.6;
      locationNote = `Same postcode area (${from.area})`;
    } else {
      locationScore = 0.3;
      locationNote = `Different area (${from.district} → ${dest.district})`;
    }
  }

  // Open penalty notices with a deadline in the period (info).
  const endDay = londonDate(q.expectedEndAt);
  for (const p of snap.penalties) {
    if (['paid', 'cancelled'].includes(p.stage)) continue;
    if (p.responseDeadline >= date && p.responseDeadline <= endDay) warnings.push(finding('OPEN_PENALTY_ON_UNIT', 'info', `${registration}: ${p.noticeNumber} has a response deadline ${p.responseDeadline}, during the hire.`, snap, q.claimId));
  }

  const factorScores: Record<RankFactor, { score: number; note: string }> = {
    likeForLike: { score: lfl.score, note: lfl.sentence },
    needsFit: { score: needsScore, note: needsNote },
    readiness: { score: readinessScore, note: readinessNote },
    compliance: { score: complianceScore, note: complianceNote },
    cost: { score: costScore, note: costNote },
    location: { score: locationScore, note: locationNote },
  };
  const factors = {} as AvailabilityCandidate['factors'];
  let total = 0;
  for (const k of RANK_FACTORS) {
    factors[k] = { score: Math.round(factorScores[k].score * 100) / 100, weight: round1(weights[k]), note: factorScores[k].note };
    total += factorScores[k].score * weights[k];
  }
  return {
    candidate: {
      fleetUnitId: unit.id,
      registration,
      label: unitLabel(vehicle, unit.gtaGroup),
      score: round1(total),
      factors,
      likeForLike: lfl,
      pricing,
      readyBy,
      marginDays: margin,
      lapses: compliance.lapses,
      warnings,
      driverOutcome,
    },
    mileage: unit.currentMileage ?? Number.MAX_SAFE_INTEGER,
  };
}

export function searchAvailability(q: AvailabilityQuery, units: readonly UnitSnapshot[], env: AvailabilityEnv): AvailabilityResult {
  const weights = normaliseWeights(env.weights);
  const use: FleetUse = q.needs.phvWork ? 'pco' : q.use;
  const evaluated = units.map((u) => evaluate(q, u, env, weights, use));
  const ranked = evaluated
    .filter((e): e is Evaluated & { candidate: AvailabilityCandidate } => !!e.candidate)
    .sort((a, b) => b.candidate.score - a.candidate.score || isoToMs(a.candidate.readyBy) - isoToMs(b.candidate.readyBy) || a.mileage - b.mileage || a.candidate.registration.localeCompare(b.candidate.registration))
    .map((e) => e.candidate);
  const excluded = evaluated
    .filter((e): e is Evaluated & { excluded: ExcludedUnit } => !!e.excluded)
    .map((e) => e.excluded)
    .sort((a, b) => a.registration.localeCompare(b.registration));
  const limited = ranked.slice(0, Math.max(1, q.limit || 10));
  const top = limited[0];
  const second = limited[1];
  const clearWinner = !!top && (!second || top.score - second.score >= env.clearWinnerGap);
  const topGreen = top ? candidateGreen(top, { minLikeForLike: env.minLikeForLike ?? DEFAULT_MIN_LIKE_FOR_LIKE }) : { green: false, reasons: ['No car is available.'] };

  const explanation: string[] = [];
  const periodWords = `${londonDate(q.startAt)} to ${londonDate(q.expectedEndAt)}`;
  if (!top) explanation.push(`No car is available for ${USE_WORDS[use]} from ${periodWords}.`);
  else {
    explanation.push(`${top.registration} (${top.label}) is the best match, score ${top.score}: ${top.likeForLike.sentence}`);
    if (second) explanation.push(clearWinner ? `Clear winner: ${round1(top.score - second.score)} points ahead of ${second.registration}.` : `Close call: ${second.registration} is only ${round1(top.score - second.score)} points behind.`);
    else explanation.push('It is the only car available for the whole period.');
    if (!topGreen.green) explanation.push(`Not automatic: ${topGreen.reasons.join(' ')}`);
  }
  if (excluded.length) {
    explanation.push(`${excluded.length} car${excluded.length === 1 ? ' is' : 's are'} not available: ${excluded.map((e) => `${e.registration} — ${e.reasons.map((r) => r.message).join('; ')}`).join(' | ')}.`);
  }
  return { period: { startAt: q.startAt, expectedEndAt: q.expectedEndAt }, use, ranked: limited, excluded, clearWinner, green: !!top && topGreen.green, explanation };
}
