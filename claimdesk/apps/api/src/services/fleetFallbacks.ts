/**
 * Fleet compliance / penalty workflow (BLUEPRINT §3.12) — API-side implementations used until `@ccguk/domain/fleet`
 * exports `complianceAlerts`, `canAllocate`, `penaltyTransition`, `liabilityTransferParticulars`. Each resolves the
 * domain export by name first.
 */
import * as domain from '@ccguk/domain';
import { addCalendarDays, type ComplianceAlert, type FleetUnit, type HireAgreement, type InsurancePolicy, type ISODate, type ISODateTime, type Party, type PenaltyNotice, type Vehicle } from '@ccguk/domain';

const registry = domain as unknown as Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function optional<T extends (...args: any[]) => unknown>(name: string): T | undefined {
  const fn = registry[name];
  return typeof fn === 'function' ? (fn as T) : undefined;
}

const day = (iso: ISODateTime | ISODate): ISODate => iso.slice(0, 10);

export interface ComplianceInput {
  units: FleetUnit[];
  vehicles: Vehicle[];
  policies: InsurancePolicy[];
  penalties?: PenaltyNotice[];
  now: ISODateTime;
}

export function complianceAlertsFallback(input: ComplianceInput): ComplianceAlert[] {
  const today = day(input.now);
  const soon = day(addCalendarDays(today, 30));
  const alerts: ComplianceAlert[] = [];
  const vehicles = new Map(input.vehicles.map((v) => [v.id, v]));
  const policies = new Map(input.policies.map((p) => [p.id, p]));
  for (const u of input.units) {
    if (u.status === 'disposed') continue;
    const v = vehicles.get(u.vehicleId);
    const reg = v?.registration ?? u.vehicleId;
    if (v?.motExpiryDate) {
      if (v.motExpiryDate < today) alerts.push({ fleetUnitId: u.id, code: 'MOT_EXPIRED', severity: 'block', message: `${reg}: MOT expired ${v.motExpiryDate}`, dueDate: v.motExpiryDate });
      else if (v.motExpiryDate <= soon) alerts.push({ fleetUnitId: u.id, code: 'MOT_DUE', severity: 'warn', message: `${reg}: MOT due ${v.motExpiryDate}`, dueDate: v.motExpiryDate });
    }
    if (v?.taxDueDate) {
      if (v.taxDueDate < today) alerts.push({ fleetUnitId: u.id, code: 'TAX_EXPIRED', severity: 'block', message: `${reg}: vehicle tax expired ${v.taxDueDate}`, dueDate: v.taxDueDate });
      else if (v.taxDueDate <= soon) alerts.push({ fleetUnitId: u.id, code: 'TAX_DUE', severity: 'warn', message: `${reg}: vehicle tax due ${v.taxDueDate}`, dueDate: v.taxDueDate });
    }
    const p = u.policyId ? policies.get(u.policyId) : undefined;
    if (!p) alerts.push({ fleetUnitId: u.id, code: 'INSURANCE_EXPIRED', severity: 'block', message: `${reg}: no insurance policy linked` });
    else {
      if (p.endDate < today) alerts.push({ fleetUnitId: u.id, code: 'INSURANCE_EXPIRED', severity: 'block', message: `${reg}: policy ${p.policyNumber} (${p.insurerName}) expired ${p.endDate}`, dueDate: p.endDate });
      else if (p.endDate <= soon) alerts.push({ fleetUnitId: u.id, code: 'INSURANCE_DUE', severity: 'warn', message: `${reg}: policy ${p.policyNumber} renews ${p.endDate}`, dueDate: p.endDate });
      const uncovered = u.declaredUses.filter((use) => !p.coveredUses.includes(use));
      if (uncovered.length) alerts.push({ fleetUnitId: u.id, code: 'USE_NOT_COVERED', severity: 'block', message: `${reg}: declared use ${uncovered.join(', ')} not covered by policy ${p.policyNumber} (covers ${p.coveredUses.join(', ')}) — lesson l` });
    }
    if (u.serviceDueDate) {
      if (u.serviceDueDate <= soon) alerts.push({ fleetUnitId: u.id, code: 'SERVICE_DUE', severity: u.serviceDueDate < today ? 'warn' : 'info', message: `${reg}: service due ${u.serviceDueDate}`, dueDate: u.serviceDueDate });
    }
    if (!u.keeperAddressCurrent) alerts.push({ fleetUnitId: u.id, code: 'KEEPER_ADDRESS_STALE', severity: 'warn', message: `${reg}: keeper address on the V5C is stale — PCNs/NIPs will go to the wrong address (lesson l)` });
    if (u.declaredUses.includes('pco') && u.phvLicensed !== true) alerts.push({ fleetUnitId: u.id, code: 'PHV_NOT_ELIGIBLE', severity: 'block', message: `${reg}: declared for PCO use but not PHV licensed` });
    for (const pen of (input.penalties ?? []).filter((x) => x.fleetUnitId === u.id && !['paid', 'cancelled', 'liability_transferred'].includes(x.stage))) {
      const dueSoon = day(addCalendarDays(today, 7));
      if (pen.responseDeadline <= dueSoon) alerts.push({ fleetUnitId: u.id, code: 'PENALTY_DEADLINE', severity: pen.responseDeadline < today ? 'block' : 'warn', message: `${reg}: ${pen.kind} ${pen.noticeNumber} (${pen.issuer}) response due ${pen.responseDeadline}${pen.discountDeadline ? `; discount until ${pen.discountDeadline}` : ''}`, dueDate: pen.responseDeadline });
    }
  }
  return alerts;
}

export function complianceAlerts(input: ComplianceInput): ComplianceAlert[] {
  const engine = optional<(units: FleetUnit[], vehicles: Vehicle[], policies: InsurancePolicy[], now: ISODateTime) => ComplianceAlert[]>('complianceAlerts');
  if (engine) {
    try {
      const out = engine(input.units, input.vehicles, input.policies, input.now);
      if (Array.isArray(out)) return out;
    } catch {
      /* fall back */
    }
  }
  return complianceAlertsFallback(input);
}

// ---------------------------------------------------------------------------
// Penalty workflow
// ---------------------------------------------------------------------------

export const PENALTY_TRANSITIONS: Record<PenaltyNotice['stage'], PenaltyNotice['stage'][]> = {
  received: ['hirer_identified', 'representations', 'paid', 'cancelled', 'escalated'],
  hirer_identified: ['liability_transferred', 'representations', 'paid', 'cancelled'],
  liability_transferred: ['cancelled', 'escalated', 'representations'],
  representations: ['appeal', 'paid', 'cancelled', 'escalated'],
  appeal: ['paid', 'cancelled', 'escalated'],
  paid: [],
  cancelled: [],
  escalated: ['paid', 'cancelled', 'representations'],
};

export interface TransitionContext {
  penalty: PenaltyNotice;
  hire?: HireAgreement;
  now: ISODateTime;
}

export interface TransitionResult {
  ok: boolean;
  reasons: string[];
  allowed: PenaltyNotice['stage'][];
}

export function penaltyTransitionFallback(to: PenaltyNotice['stage'], c: TransitionContext): TransitionResult {
  const allowed = PENALTY_TRANSITIONS[c.penalty.stage];
  const reasons: string[] = [];
  if (!allowed.includes(to)) reasons.push(`Cannot move from ${c.penalty.stage} to ${to}; allowed: ${allowed.join(', ') || 'none'}`);
  if (to === 'hirer_identified' || to === 'liability_transferred') {
    if (!c.hire) reasons.push('A hire agreement covering the contravention time is required to identify the hirer');
    else {
      const at = c.penalty.contraventionAt;
      if (at < c.hire.startAt || (c.hire.endAt && at > c.hire.endAt)) reasons.push(`Hire ${c.hire.agreementNumber} (${c.hire.startAt} → ${c.hire.endAt ?? 'open'}) does not cover the contravention at ${at} — never nominate a hirer who did not have the vehicle`);
    }
  }
  if (to === 'liability_transferred' && c.penalty.kind === 'nip_s172') reasons.push('A NIP/s.172 request is answered with the s.172 response, not a PCN liability transfer');
  if (to === 'liability_transferred' && day(c.now) > c.penalty.responseDeadline) reasons.push(`Response deadline ${c.penalty.responseDeadline} has passed — check the issuer's late-representation route honestly rather than back-dating`);
  return { ok: reasons.length === 0, reasons, allowed };
}

export function penaltyTransition(to: PenaltyNotice['stage'], c: TransitionContext): TransitionResult {
  const engine = optional<(penalty: PenaltyNotice, to: PenaltyNotice['stage'], ctx: unknown) => TransitionResult | boolean>('penaltyTransition');
  if (engine) {
    try {
      const out = engine(c.penalty, to, c);
      if (typeof out === 'boolean') return { ok: out, reasons: out ? [] : [`Transition ${c.penalty.stage} → ${to} refused by the fleet engine`], allowed: PENALTY_TRANSITIONS[c.penalty.stage] };
      if (out && typeof out === 'object' && 'ok' in out) return out;
    } catch {
      /* fall back */
    }
  }
  return penaltyTransitionFallback(to, c);
}

// ---------------------------------------------------------------------------
// Notice data (Road Traffic (Owner Liability) Regulations 2000 Sch 2; RTA 1988 s.172)
// ---------------------------------------------------------------------------

export interface NoticeParties {
  penalty: PenaltyNotice;
  unit: FleetUnit;
  vehicle: Vehicle;
  hire?: HireAgreement;
  hirer?: Party;
  keeperName: string;
  keeperAddressLines: string[];
}

function partyLines(p: Party | undefined): string[] {
  const a = p?.address;
  if (!a) return ['[address to be confirmed]'];
  return [a.line1, a.line2, a.town, a.county, a.postcode].filter((x): x is string => Boolean(x));
}

/** Statement of liability particulars: the hirer, the agreement, the period, the vehicle, the keeper. */
export function liabilityTransferParticulars(n: NoticeParties): Record<string, unknown> {
  const engine = optional<(input: NoticeParties) => Record<string, unknown>>('liabilityTransferParticulars');
  if (engine) {
    try {
      const out = engine(n);
      if (out && typeof out === 'object') return out;
    } catch {
      /* fall back */
    }
  }
  return {
    basis: 'Road Traffic (Owner Liability) Regulations 2000, Schedule 2 (statement of liability by a vehicle-hire firm); Road Traffic Offenders Act 1988 s.66; Traffic Management Act 2004 Sch 9 para 2 for civil PCNs',
    notice: { kind: n.penalty.kind, issuer: n.penalty.issuer, noticeNumber: n.penalty.noticeNumber, contraventionAt: n.penalty.contraventionAt, receivedAt: n.penalty.receivedAt, amountPence: n.penalty.amountPence, responseDeadline: n.penalty.responseDeadline, discountDeadline: n.penalty.discountDeadline },
    vehicle: { registration: n.vehicle.registration, make: n.vehicle.make, model: n.vehicle.model, colour: n.vehicle.colour },
    keeper: { name: n.keeperName, addressLines: n.keeperAddressLines, isHireFirm: true },
    hirer: n.hirer ? { partyId: n.hirer.id, name: n.hirer.name, addressLines: partyLines(n.hirer), dateOfBirth: n.hirer.dateOfBirth, drivingLicenceNumber: n.hirer.drivingLicenceNumber } : undefined,
    agreement: n.hire ? { agreementNumber: n.hire.agreementNumber, startAt: n.hire.startAt, endAt: n.hire.endAt, signedAt: n.hire.signedAt, documentId: n.hire.documentId, coversContravention: n.penalty.contraventionAt >= n.hire.startAt && (!n.hire.endAt || n.penalty.contraventionAt <= n.hire.endAt) } : undefined,
    statement: n.hirer && n.hire ? `At the time of the alleged contravention (${n.penalty.contraventionAt}) the vehicle ${n.vehicle.registration} was let under hire agreement ${n.hire.agreementNumber} to ${n.hirer.name}, who had accepted liability for penalty charges incurred during the hire. A copy of the agreement is enclosed.` : undefined,
  };
}

export interface S172Input extends NoticeParties {
  /** The keeper cannot, with reasonable diligence, identify the driver (RTA 1988 s.172(4)). */
  cannotIdentify: boolean;
  driverName?: string;
  driverAddressLines?: string[];
  driverLicenceNumber?: string;
  /** Records searched: rota, key log, tracker, agency timesheet, fuel card … with their limits. */
  diligence: string[];
}

export function s172ResponseData(i: S172Input): Record<string, unknown> {
  if (i.cannotIdentify && i.driverName) throw new Error('s.172: cannot both rely on s.172(4) (driver not identifiable) and name a driver');
  const covered = i.hire ? i.penalty.contraventionAt >= i.hire.startAt && (!i.hire.endAt || i.penalty.contraventionAt <= i.hire.endAt) : false;
  if (i.driverName && !covered) throw new Error('s.172: the named driver must be the hirer on an agreement covering the time of the alleged offence — never nominate a driver who was not driving');
  return {
    basis: 'Road Traffic Act 1988 s.172(2)(a) (keeper to give information as to the identity of the driver); s.172(4) defence where the keeper did not know and could not with reasonable diligence have ascertained who the driver was; Road Traffic Offenders Act 1988 s.1 (NIP within 14 days)',
    notice: { kind: i.penalty.kind, issuer: i.penalty.issuer, noticeNumber: i.penalty.noticeNumber, contraventionAt: i.penalty.contraventionAt, receivedAt: i.penalty.receivedAt, responseDeadline: i.penalty.responseDeadline },
    vehicle: { registration: i.vehicle.registration, make: i.vehicle.make, model: i.vehicle.model },
    keeper: { name: i.keeperName, addressLines: i.keeperAddressLines },
    cannotIdentify: i.cannotIdentify,
    driver: i.driverName ? { name: i.driverName, addressLines: i.driverAddressLines ?? partyLines(i.hirer), licenceNumber: i.driverLicenceNumber ?? i.hirer?.drivingLicenceNumber, basis: i.hire ? `Hirer under agreement ${i.hire.agreementNumber} covering the time of the alleged offence` : undefined } : undefined,
    agreement: i.hire ? { agreementNumber: i.hire.agreementNumber, startAt: i.hire.startAt, endAt: i.hire.endAt } : undefined,
    diligence: i.diligence,
    nipServedWithin14Days: Math.round((Date.parse(i.penalty.receivedAt) - Date.parse(i.penalty.contraventionAt)) / 86_400_000) <= 14,
  };
}
