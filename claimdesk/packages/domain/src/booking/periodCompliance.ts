// owned by ap-booking
/**
 * Whole-period compliance (docs/SUPREME-AUTOPILOT.md §B.4). Pure.
 *
 * `canAllocate` (fleet/allocate.ts) answers "can the car go out at the start?"; this adds the period: the linked
 * policy (or its renewal chain) must be in force and cover the use on every day of `[startAt, expectedEndAt)`, MOT/tax
 * lapsing inside the period are warnings (the booking service creates the readiness task), service due in the
 * period warns, and `pco` use needs a PHV-licensed car whose licence runs for the whole period.
 */
import type { FleetUnit, FleetUse, ISODate, ISODateTime, InsurancePolicy, Vehicle } from '../types.js';
import { canAllocate } from '../fleet/allocate.js';
import { addCalendarDays, calendarDaysBetween, isoToMs, londonDate, msToUtcIso } from '../calendar/index.js';
import type { PeriodAllocationCheck, PeriodLapseKind } from './types.js';

export interface ComplianceFinding {
  /** A §C.2 clash code (POLICY_NOT_IN_FORCE, POLICY_ENDS_IN_PERIOD, MOT_LAPSES_IN_PERIOD, PHV_LICENCE, …). */
  code: string;
  message: string;
}

/** PeriodAllocationCheck plus the coded findings behind `reasons` (blocks) and `warnings` (warns). */
export interface PeriodAllocationDetail extends PeriodAllocationCheck {
  blocks: ComplianceFinding[];
  warns: ComplianceFinding[];
}

const USE_WORDS: Record<FleetUse, string> = { credit_hire: 'credit hire', self_drive: 'self-drive', pco: 'PCO / private hire' };
const MARGIN_CAP = 365;

/** The last London calendar day the period touches (an end at midnight belongs to the day before). */
export function lastDayOfPeriod(startAt: ISODateTime, expectedEndAt: ISODateTime): ISODate {
  const s = isoToMs(startAt);
  const e = isoToMs(expectedEndAt);
  return londonDate(msToUtcIso(e > s ? e - 1 : s));
}

/** Classify a `canAllocate` reason into its §C.2 code. */
function codeOfAllocationReason(reason: string, unit: Pick<FleetUnit, 'status'>): string {
  if (reason.startsWith('Unit is ')) return unit.status === 'disposed' ? 'UNIT_DISPOSED' : 'UNIT_OFF_ROAD';
  if (reason.startsWith('Use "')) return 'USE_NOT_DECLARED';
  if (reason.startsWith('No insurance policy') || reason.startsWith('Policy ')) return 'POLICY_NOT_IN_FORCE';
  if (reason.startsWith('MOT')) return 'MOT_INVALID_AT_START';
  if (reason.startsWith('Tax status') || reason.startsWith('Vehicle tax')) return 'TAX_INVALID_AT_START';
  return 'ALLOCATION_REFUSED';
}

/**
 * The policy chain from `first`: each next policy is the one this policy names as `renewsPolicyId`, or a policy that
 * names this one (either direction is accepted, loops are cut).
 */
export function policyChain(first: InsurancePolicy, policies: readonly InsurancePolicy[]): InsurancePolicy[] {
  const out = [first];
  const seen = new Set([first.id]);
  let cur = first;
  for (;;) {
    const next = (cur.renewsPolicyId ? policies.find((p) => p.id === cur.renewsPolicyId) : undefined) ?? policies.find((p) => p.renewsPolicyId === cur.id && !seen.has(p.id));
    if (!next || seen.has(next.id)) break;
    out.push(next);
    seen.add(next.id);
    cur = next;
  }
  return out;
}

/**
 * The last day the chain covers `use` continuously from `fromDay` (inclusive), or null when the first policy does not
 * cover `fromDay` for `use`. Each renewal must start no later than the day after the previous cover ends.
 */
export function coveredUntil(chain: readonly InsurancePolicy[], use: FleetUse, fromDay: ISODate): { until: ISODate; via: InsurancePolicy[] } | null {
  const first = chain[0];
  if (!first || first.startDate > fromDay || first.endDate < fromDay || !first.coveredUses.includes(use)) return null;
  let until = first.endDate;
  const via = [first];
  for (const p of chain.slice(1)) {
    if (!p.coveredUses.includes(use)) break;
    if (p.startDate > addCalendarDays(until, 1)) break;
    if (p.endDate > until) until = p.endDate;
    via.push(p);
  }
  return { until, via };
}

export function canAllocateForPeriod(
  unit: FleetUnit,
  use: FleetUse,
  policies: readonly InsurancePolicy[],
  period: { startAt: ISODateTime; expectedEndAt: ISODateTime },
  vehicle: Vehicle | undefined,
  ctx: { now: ISODateTime; phvLicenceExpiry?: ISODate },
): PeriodAllocationDetail {
  const linked = unit.policyId ? policies.find((p) => p.id === unit.policyId) : undefined;
  const startDay = londonDate(period.startAt);
  // The linked policy, or the renewal in its chain that is in force on the first day (a renewed policy keeps the car insured).
  const policy = linked ? (policyChain(linked, policies).find((p) => p.startDate <= startDay && p.endDate >= startDay && p.coveredUses.includes(use)) ?? linked) : undefined;
  // Exactly as POST /claims/:id/hire: an on-hire car is treated as available — the period overlap decides that case.
  const base = canAllocate({ ...unit, status: unit.status === 'on_hire' ? 'available' : unit.status }, use, policy, period.startAt, vehicle);
  const blocks: ComplianceFinding[] = base.reasons.map((r) => ({ code: codeOfAllocationReason(r, unit), message: r }));
  const warns: ComplianceFinding[] = base.warnings.map((w) => ({ code: w.startsWith('V5C') ? 'KEEPER_ADDRESS_STALE' : w.startsWith('Service') ? 'SERVICE_DUE_IN_PERIOD' : 'WARNING', message: w }));
  const lapses: PeriodAllocationCheck['lapses'] = [];
  const lastDay = lastDayOfPeriod(period.startAt, period.expectedEndAt);
  const nextDates: ISODate[] = [];
  const reg = vehicle?.registration ?? 'The car';

  // Whole-period cover (policy chain).
  if (policy) {
    const chain = policyChain(policy, policies);
    const cover = coveredUntil(chain, use, startDay);
    if (cover) {
      nextDates.push(addCalendarDays(cover.until, 1));
      if (cover.until < lastDay) {
        const lapse = addCalendarDays(cover.until, 1);
        lapses.push({ kind: 'policy', date: lapse, ...(cover.via.length > 1 ? { renewal: cover.via.slice(1).map((p) => p.policyNumber).join(', ') } : {}) });
        blocks.push({
          code: 'POLICY_ENDS_IN_PERIOD',
          message: `Insurance for ${USE_WORDS[use]} ends on ${cover.until} (policy ${cover.via[cover.via.length - 1]!.policyNumber}), before the expected end ${lastDay}, and no renewal policy is recorded — the car would be uninsured after ${cover.until}.`,
        });
      }
    }
  }

  // MOT / tax lapsing inside the period (valid at the start — canAllocate refused already otherwise).
  const lapseCheck = (kind: PeriodLapseKind, code: string, label: string, expiry: ISODate | undefined): void => {
    if (!expiry || expiry < startDay) return;
    nextDates.push(addCalendarDays(expiry, 1));
    if (expiry < lastDay) {
      lapses.push({ kind, date: addCalendarDays(expiry, 1) });
      warns.push({ code, message: `${label} runs out on ${expiry}, during the hire (expected to end ${lastDay}) — renew it before then.` });
    }
  };
  lapseCheck('mot', 'MOT_LAPSES_IN_PERIOD', `${reg}: MOT`, vehicle?.motExpiryDate);
  lapseCheck('tax', 'TAX_LAPSES_IN_PERIOD', `${reg}: vehicle tax`, vehicle?.taxDueDate);

  // Service due in the period (date, or within 1,000 miles when mileage is known).
  if (unit.serviceDueDate && unit.serviceDueDate >= startDay) {
    nextDates.push(unit.serviceDueDate);
    if (unit.serviceDueDate <= lastDay) {
      lapses.push({ kind: 'service', date: unit.serviceDueDate });
      warns.push({ code: 'SERVICE_DUE_IN_PERIOD', message: `${reg}: service due ${unit.serviceDueDate}, during the hire.` });
    }
  }
  if (unit.serviceDueMiles !== undefined && unit.currentMileage !== undefined && unit.serviceDueMiles - unit.currentMileage <= 1000) {
    warns.push({ code: 'SERVICE_DUE_IN_PERIOD', message: `${reg}: service due at ${unit.serviceDueMiles.toLocaleString('en-GB')} miles (now ${unit.currentMileage.toLocaleString('en-GB')}).` });
  }

  // PCO / private hire: a PHV-licensed car with a licence in force for the whole period.
  if (use === 'pco') {
    const expiry = ctx.phvLicenceExpiry ?? unit.phvLicenceExpiry;
    if (!unit.phvLicensed) blocks.push({ code: 'PHV_LICENCE', message: `${reg} is not licensed as a private hire vehicle — it cannot go out for PCO work.` });
    else if (!expiry) warns.push({ code: 'PHV_LICENCE', message: `${reg}: the PHV licence expiry is not recorded — check the licence runs to ${lastDay}.` });
    else {
      if (expiry < startDay) blocks.push({ code: 'PHV_LICENCE', message: `${reg}: the PHV licence expired ${expiry}.` });
      else {
        nextDates.push(addCalendarDays(expiry, 1));
        if (expiry < lastDay) {
          lapses.push({ kind: 'phv_licence', date: addCalendarDays(expiry, 1) });
          blocks.push({ code: 'PHV_LICENCE', message: `${reg}: the PHV licence runs out on ${expiry}, during the hire (expected to end ${lastDay}).` });
        }
      }
    }
  }

  const margins = nextDates.map((d) => calendarDaysBetween(lastDay, d));
  const marginDays = margins.length ? Math.min(MARGIN_CAP, ...margins) : MARGIN_CAP;
  const reasons = blocks.map((b) => b.message);
  return { ok: blocks.length === 0, reasons, warnings: warns.map((w) => w.message), lapses, marginDays, blocks, warns };
}
