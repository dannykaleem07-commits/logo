/**
 * Fleet compliance alerts (BLUEPRINT §3.12, lesson l): MOT, tax, insurance and service expiry; keeper
 * address kept current (RENTX's CCJs arose from tickets sent to an old V5C address); class of use per
 * unit and per policy (Collingwood will not cover credit hire and self-drive together); London PHV
 * zero-emission-capable eligibility (TfL rule encoded as data with a verification note); penalty deadlines.
 */
import type { ComplianceAlert, FleetUnit, InsurancePolicy, ISODate, ISODateTime, PenaltyNotice, Vehicle, Verification } from '../types.js';
import { addCalendarDays, londonDate } from '../calendar/index.js';

export interface FleetUnitRecord {
  unit: FleetUnit;
  vehicle: Vehicle;
  policy?: InsurancePolicy;
}

export interface ComplianceOptions {
  /** Days ahead to warn of a due date (default 30). */
  warnDays?: number;
  /** Open penalty notices, for PENALTY_DEADLINE alerts. */
  penalties?: PenaltyNotice[];
  /** Zero-emission range by vehicle id (not in DVLA data; from the manufacturer spec). */
  zeroEmissionRangeMilesByVehicleId?: Record<string, number>;
}

export const DEFAULT_WARN_DAYS = 30;

/** TfL zero-emission-capable requirement for vehicles licensed as a London PHV for the first time (BLUEPRINT §5.2). */
export const TFL_ZEC_RULE = {
  basis: 'Private Hire Vehicles (London) Act 1998 ss.2, 6, 7, 12; TfL PHV licensing requirements — zero emission capable (ZEC) for vehicles licensed for the first time',
  options: [{ maxCo2Gkm: 75, minZeroEmissionRangeMiles: 20 }],
  /** The blueprint's '≤50 g/km with 10 miles' limb was not found on TfL PHV pages; 50 g/km belongs to the taxi definition. Not applied. */
  taxiOnlyNote: '≤50 g/km limb belongs to the taxi (Hackney carriage) definition, not PHV — not applied (RESEARCH-CORRECTIONS #12).',
  euroStandard: 'Euro 6',
  verification: {
    status: 'unverified',
    sourceUrl: 'https://tfl.gov.uk/info-for/taxis-and-private-hire/licensing/vehicle-requirements',
    sourceNote: 'Search snippets of TfL pages (4 Oct 2026): PHVs first licensed from 1 January 2023 must emit no more than 75 g/km CO2 with a minimum 20-mile zero-emission range, and meet Euro 6. Confirm on tfl.gov.uk; zero-emission range is not in DVLA VES data and must come from the manufacturer specification.',
  } as Verification,
} as const;

export interface PhvEligibility {
  eligible: boolean | 'unknown';
  reasons: string[];
  verification: Verification;
}

function euroSix(euroStatus: string | undefined): boolean | 'unknown' {
  if (!euroStatus) return 'unknown';
  if (/\b6\b/.test(euroStatus)) return true;
  if (/\b[1-5]\b/.test(euroStatus)) return false;
  return 'unknown';
}

/** TfL ZEC test for a vehicle. 'unknown' when CO2, zero-emission range or Euro status is not on record. */
export function phvEligibility(vehicle: Vehicle, zeroEmissionRangeMiles?: number): PhvEligibility {
  const reasons: string[] = [];
  const verification = TFL_ZEC_RULE.verification;
  if (vehicle.fuelType === 'electric') {
    return { eligible: euroSix(vehicle.euroStatus) === false ? false : true, reasons: ['Battery electric: zero tailpipe CO2 and unlimited zero-emission range meet the ZEC test.'], verification };
  }
  const co2 = vehicle.co2Gkm;
  if (co2 === undefined) {
    return { eligible: 'unknown', reasons: ['CO2 (g/km) not on record: run the DVLA VES lookup or take it from the V5C.'], verification };
  }
  let co2Ok: boolean | 'unknown';
  if (co2 > 75) {
    co2Ok = false;
    reasons.push(`CO2 ${co2} g/km exceeds the 75 g/km ceiling.`);
  } else {
    const option = TFL_ZEC_RULE.options[0];
    const canHaveRange = vehicle.fuelType === 'plugin_hybrid' || vehicle.fuelType === 'hybrid' || vehicle.fuelType === undefined || vehicle.fuelType === 'other';
    if (zeroEmissionRangeMiles !== undefined) {
      co2Ok = zeroEmissionRangeMiles >= option.minZeroEmissionRangeMiles;
      reasons.push(`CO2 ${co2} g/km with ${zeroEmissionRangeMiles} miles zero-emission range (needs ≥ ${option.minZeroEmissionRangeMiles} miles at ≤ ${option.maxCo2Gkm} g/km): ${co2Ok ? 'meets' : 'fails'} the ZEC test.`);
    } else if (!canHaveRange) {
      co2Ok = false;
      reasons.push(`CO2 ${co2} g/km but a ${vehicle.fuelType} vehicle has no zero-emission range (needs ≥ ${option.minZeroEmissionRangeMiles} miles).`);
    } else {
      co2Ok = 'unknown';
      reasons.push(`CO2 ${co2} g/km: eligible only with ≥ ${option.minZeroEmissionRangeMiles} miles zero-emission range — confirm from the manufacturer specification.`);
    }
  }
  const euro = euroSix(vehicle.euroStatus);
  if (euro === false) reasons.push(`Euro status "${vehicle.euroStatus}" is below Euro 6.`);
  else if (euro === 'unknown') reasons.push('Euro status not on record: Euro 6 is required.');
  let eligible: boolean | 'unknown';
  if (co2Ok === false || euro === false) eligible = false;
  else if (co2Ok === 'unknown' || euro === 'unknown') eligible = 'unknown';
  else eligible = true;
  return { eligible, reasons, verification };
}

function formatDate(d: ISODate): string {
  return d;
}

export function complianceAlerts(units: FleetUnitRecord[], now: ISODateTime, opts: ComplianceOptions = {}): ComplianceAlert[] {
  const warnDays = opts.warnDays ?? DEFAULT_WARN_DAYS;
  const today = londonDate(now);
  const horizon = addCalendarDays(today, warnDays);
  const alerts: ComplianceAlert[] = [];

  for (const { unit, vehicle, policy } of units) {
    if (unit.status === 'disposed') continue;
    const push = (code: ComplianceAlert['code'], severity: ComplianceAlert['severity'], message: string, dueDate?: ISODate): void => {
      const a: ComplianceAlert = { fleetUnitId: unit.id, code, severity, message };
      if (dueDate) a.dueDate = dueDate;
      alerts.push(a);
    };
    const reg = vehicle.registration;

    // MOT
    if (vehicle.motExpiryDate) {
      if (vehicle.motExpiryDate < today) push('MOT_EXPIRED', 'block', `${reg}: MOT expired ${formatDate(vehicle.motExpiryDate)} — the unit cannot go on hire until it passes.`, vehicle.motExpiryDate);
      else if (vehicle.motExpiryDate <= horizon) push('MOT_DUE', 'warn', `${reg}: MOT due ${formatDate(vehicle.motExpiryDate)} (within ${warnDays} days).`, vehicle.motExpiryDate);
    } else if (vehicle.motStatus && /not valid|no details|expired|no results/i.test(vehicle.motStatus)) {
      push('MOT_EXPIRED', 'block', `${reg}: MOT status "${vehicle.motStatus}" with no expiry date on record — confirm before any hire.`);
    } else if (!vehicle.motStatus) {
      push('MOT_DUE', 'info', `${reg}: no MOT expiry on record — run the DVSA MOT history lookup (vehicles under 3 years are exempt).`);
    }

    // Tax
    if (vehicle.taxStatus && /untaxed|sorn/i.test(vehicle.taxStatus)) {
      push('TAX_EXPIRED', 'block', `${reg}: tax status "${vehicle.taxStatus}" — it cannot be used on the road.`, vehicle.taxDueDate);
    } else if (vehicle.taxDueDate) {
      if (vehicle.taxDueDate < today) push('TAX_EXPIRED', 'block', `${reg}: vehicle tax expired ${formatDate(vehicle.taxDueDate)}.`, vehicle.taxDueDate);
      else if (vehicle.taxDueDate <= horizon) push('TAX_DUE', 'warn', `${reg}: vehicle tax due ${formatDate(vehicle.taxDueDate)} (within ${warnDays} days).`, vehicle.taxDueDate);
    } else if (!vehicle.taxStatus) {
      push('TAX_DUE', 'info', `${reg}: no tax due date on record — run the DVLA VES lookup.`);
    }

    // Insurance
    if (!policy) {
      push('INSURANCE_EXPIRED', 'block', `${reg}: no insurance policy linked to the unit — allocation is blocked until a policy covering ${unit.declaredUses.join(', ') || 'its declared use'} is recorded.`);
    } else {
      if (policy.endDate < today) push('INSURANCE_EXPIRED', 'block', `${reg}: policy ${policy.policyNumber} (${policy.insurerName}) expired ${formatDate(policy.endDate)}.`, policy.endDate);
      else if (policy.startDate > today) push('INSURANCE_EXPIRED', 'block', `${reg}: policy ${policy.policyNumber} (${policy.insurerName}) is not in force until ${formatDate(policy.startDate)}.`, policy.startDate);
      else if (policy.endDate <= horizon) push('INSURANCE_DUE', 'warn', `${reg}: policy ${policy.policyNumber} (${policy.insurerName}) renews ${formatDate(policy.endDate)} (within ${warnDays} days) — fair presentation of the risk is due under the Insurance Act 2015 ss.3–5.`, policy.endDate);

      const notCovered = unit.declaredUses.filter((u) => !policy.coveredUses.includes(u));
      if (notCovered.length > 0) {
        push(
          'USE_NOT_COVERED',
          'block',
          `${reg}: declared use ${notCovered.join(', ')} is not covered by policy ${policy.policyNumber} (${policy.insurerName}: ${policy.coveredUses.join(', ') || 'no uses'}) — Collingwood will not cover credit hire and self-drive together, so each use needs its own policy (BLUEPRINT §3.12).`,
        );
      }
    }

    // Service
    if (unit.serviceDueDate) {
      if (unit.serviceDueDate < today) push('SERVICE_DUE', 'warn', `${reg}: service overdue since ${formatDate(unit.serviceDueDate)}.`, unit.serviceDueDate);
      else if (unit.serviceDueDate <= horizon) push('SERVICE_DUE', 'info', `${reg}: service due ${formatDate(unit.serviceDueDate)} (within ${warnDays} days).`, unit.serviceDueDate);
    }

    // Keeper address
    if (!unit.keeperAddressCurrent) {
      push(
        'KEEPER_ADDRESS_STALE',
        'warn',
        `${reg}: the V5C keeper address${unit.keeperAddressOnV5C ? ` (${unit.keeperAddressOnV5C.line1}, ${unit.keeperAddressOnV5C.postcode})` : ''} is not current — PCNs and NIPs go to the old address and become charge certificates and CCJs unanswered (RENTX, lesson l). Update the V5C with DVLA now.`,
      );
    }

    // PHV eligibility
    if (unit.phvLicensed || unit.declaredUses.includes('pco')) {
      const e = phvEligibility(vehicle, opts.zeroEmissionRangeMilesByVehicleId?.[vehicle.id]);
      if (e.eligible === false) push('PHV_NOT_ELIGIBLE', 'block', `${reg}: cannot be newly licensed as a London PHV — ${e.reasons.join(' ')} (TfL ZEC rule: ≤ 75 g/km CO2 with ≥ 20 miles zero-emission range, and Euro 6; verification: ${e.verification.status}).`);
      else if (e.eligible === 'unknown') push('PHV_NOT_ELIGIBLE', 'warn', `${reg}: London PHV eligibility unconfirmed — ${e.reasons.join(' ')} (verification: ${e.verification.status}).`);
    }

    // Penalty deadlines
    for (const p of (opts.penalties ?? []).filter((x) => x.fleetUnitId === unit.id && x.stage !== 'paid' && x.stage !== 'cancelled')) {
      if (p.responseDeadline < today) push('PENALTY_DEADLINE', 'block', `${reg}: ${p.kind} ${p.noticeNumber} (${p.issuer}) response deadline ${formatDate(p.responseDeadline)} has passed — out-of-time routes only on true facts (TE7/TE9).`, p.responseDeadline);
      else if (p.responseDeadline <= horizon) push('PENALTY_DEADLINE', 'warn', `${reg}: ${p.kind} ${p.noticeNumber} (${p.issuer}) response due ${formatDate(p.responseDeadline)}${p.kind === 'nip_s172' ? ' — s.172 RTA 1988: 28 days' : ''}.`, p.responseDeadline);
      if (p.discountDeadline && p.discountDeadline >= today && p.discountDeadline <= horizon && (p.stage === 'received' || p.stage === 'hirer_identified')) {
        push('PENALTY_DEADLINE', 'info', `${reg}: ${p.noticeNumber} discount period ends ${formatDate(p.discountDeadline)} — decide pay / transfer / represent before it.`, p.discountDeadline);
      }
    }
  }
  return alerts;
}
