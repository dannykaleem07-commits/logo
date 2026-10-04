/**
 * Fleet compliance / penalty workflow (BLUEPRINT §3.12) — typed adapters over `@ccguk/domain/fleet`.
 *
 * The routes keep the API's shapes (`complianceAlerts({ units, vehicles, policies, penalties, now })`, a stage-based
 * `penaltyTransition`, notice data blobs for the templates); the domain is the single rule source underneath:
 * `complianceAlerts(records, now, opts)`, `penaltyTransition(notice, action, ctx)`, `liabilityTransferParticulars(...)`,
 * `s172ResponseData(notice, hire, hirer, { driver, recordsChecked })`. The file keeps its historical name so the
 * route imports are stable.
 */
import {
  allowedPenaltyActions,
  complianceAlerts as domainComplianceAlerts,
  hireCovers,
  liabilityTransferParticulars as domainLiabilityTransferParticulars,
  penaltyTransition as domainPenaltyTransition,
  s172ResponseData as domainS172ResponseData,
  type ComplianceAlert,
  type FleetUnit,
  type FleetUnitRecord,
  type HireAgreement,
  type InsurancePolicy,
  type ISODateTime,
  type LiabilityTransfer,
  type Party,
  type PenaltyAction,
  type PenaltyNotice,
  type PenaltyTransitionResult,
  type S172ResponseData,
  type Vehicle,
} from '@ccguk/domain';

// ---------------------------------------------------------------------------
// Compliance alerts
// ---------------------------------------------------------------------------

export interface ComplianceInput {
  units: FleetUnit[];
  vehicles: Vehicle[];
  policies: InsurancePolicy[];
  penalties?: PenaltyNotice[];
  now: ISODateTime;
  warnDays?: number;
}

/** Join units to their vehicle and policy and run the domain engine. A unit whose vehicle row is missing is reported, not skipped silently. */
export function complianceAlerts(input: ComplianceInput): ComplianceAlert[] {
  const vehicles = new Map(input.vehicles.map((v) => [v.id, v]));
  const policies = new Map(input.policies.map((p) => [p.id, p]));
  const records: FleetUnitRecord[] = [];
  const orphans: ComplianceAlert[] = [];
  for (const unit of input.units) {
    const vehicle = vehicles.get(unit.vehicleId);
    if (!vehicle) {
      if (unit.status !== 'disposed') orphans.push({ fleetUnitId: unit.id, code: 'MOT_DUE', severity: 'warn', message: `Fleet unit ${unit.id}: vehicle record ${unit.vehicleId} is missing — no MOT, tax or PHV checks are possible until it is restored.` });
      continue;
    }
    const policy = unit.policyId ? policies.get(unit.policyId) : undefined;
    records.push(policy ? { unit, vehicle, policy } : { unit, vehicle });
  }
  const opts: Parameters<typeof domainComplianceAlerts>[2] = {};
  if (input.penalties) opts.penalties = input.penalties;
  if (input.warnDays !== undefined) opts.warnDays = input.warnDays;
  return [...domainComplianceAlerts(records, input.now, opts), ...orphans];
}

// ---------------------------------------------------------------------------
// Penalty workflow (stage-based API over the domain's action-based transitions)
// ---------------------------------------------------------------------------

/** Target stage → the domain action that reaches it. */
export const STAGE_ACTION: Record<Exclude<PenaltyNotice['stage'], 'received'>, PenaltyAction> = {
  hirer_identified: 'identify_hirer',
  liability_transferred: 'transfer_liability',
  representations: 'represent',
  appeal: 'appeal',
  paid: 'pay',
  cancelled: 'cancel',
  escalated: 'escalate',
};

export interface TransitionContext {
  penalty: PenaltyNotice;
  hire?: HireAgreement;
  now: ISODateTime;
  /** For nip_s172: the hire records (agreement, additional drivers, key log) establish who was driving. */
  driverConfirmedByRecords?: boolean;
  /** For 'appeal': a notice of rejection of representations has been received. */
  rejectionReceived?: boolean;
}

export interface TransitionResult {
  ok: boolean;
  reasons: string[];
  /** Stages reachable from the current one (for the UI). */
  allowed: PenaltyNotice['stage'][];
  warnings: string[];
  basis: string[];
  domain?: PenaltyTransitionResult;
}

function domainContext(c: TransitionContext): Parameters<typeof domainPenaltyTransition>[2] {
  const ctx: NonNullable<Parameters<typeof domainPenaltyTransition>[2]> = { now: c.now };
  if (c.hire) ctx.hireAgreementId = c.hire.id;
  if (c.driverConfirmedByRecords !== undefined) ctx.driverConfirmedByRecords = c.driverConfirmedByRecords;
  if (c.rejectionReceived !== undefined) ctx.rejectionReceived = c.rejectionReceived;
  return ctx;
}

/** Stages the notice can move to now (the hire covering the contravention counts, as the domain requires). */
export function allowedStages(c: TransitionContext): PenaltyNotice['stage'][] {
  const ctx = domainContext(c);
  const stages = allowedPenaltyActions(c.penalty, ctx).map((a) => domainPenaltyTransition(c.penalty, a, ctx).next);
  return [...new Set(stages)].filter((s) => s !== c.penalty.stage);
}

export function penaltyTransition(to: PenaltyNotice['stage'], c: TransitionContext): TransitionResult {
  const allowed = allowedStages(c);
  if (to === 'received') return { ok: false, reasons: ['A notice cannot go back to "received"'], allowed, warnings: [], basis: [] };
  const action = STAGE_ACTION[to];
  const ctx = domainContext(c);
  const r = domainPenaltyTransition(c.penalty, action, ctx);
  const reasons: string[] = [];
  if (!r.allowed) reasons.push(r.reason ?? `Action "${action}" is not available from stage "${c.penalty.stage}"`);
  if (r.allowed && (to === 'hirer_identified' || to === 'liability_transferred')) {
    // Belt and braces on the live-file lesson (l): never nominate a hirer who did not have the vehicle.
    if (!c.hire) reasons.push('A hire agreement covering the contravention time is required to identify the hirer');
    else if (!hireCovers(c.hire, c.penalty.contraventionAt)) reasons.push(`Hire ${c.hire.agreementNumber} (${c.hire.startAt} → ${c.hire.collectedAt ?? c.hire.endAt ?? 'open'}) does not cover the contravention at ${c.penalty.contraventionAt}`);
  }
  return { ok: reasons.length === 0, reasons, allowed, warnings: [...r.warnings], basis: [...r.basis], domain: r };
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

/** Statement-of-liability particulars (Sch 2). Without a hirer on a covering agreement the transfer is reported as incomplete. */
export function liabilityTransferParticulars(n: NoticeParties): LiabilityTransfer | { complete: false; missing: string[]; contraventionWithinHire: false; basis: string[]; notes: string[] } {
  if (n.hire && n.hirer) return domainLiabilityTransferParticulars(n.penalty, n.hire, n.hirer, n.unit, n.vehicle);
  return {
    complete: false,
    missing: [n.hire ? 'the hirer party on the agreement' : 'a hire agreement covering the date and time of the contravention'],
    contraventionWithinHire: false,
    basis: ['Road Traffic (Owner Liability) Regulations 2000, Schedule 2'],
    notes: ['Liability cannot be transferred without the hirer and a covering agreement (live-file lesson l: do not guess).'],
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
  /** Additional drivers on the agreement, when the route has resolved them. */
  additionalDrivers?: Party[];
}

export class S172RefusalError extends Error {
  readonly code = 'S172_REFUSAL';
  constructor(message: string) {
    super(message);
    this.name = 'S172RefusalError';
  }
}

const sameName = (a: string | undefined, b: string | undefined): boolean => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/**
 * s.172 response data. Refuses (throws S172RefusalError) when the response would be dishonest: pleading s.172(4) while
 * naming a driver, naming a driver no covering hire record supports, or pleading (4) when the records identify the driver.
 */
export function s172ResponseData(i: S172Input): S172ResponseData & { cannotIdentify: boolean; diligence: string[]; keeper: { name: string; addressLines: string[] }; vehicle: { registration: string; make: string; model: string } } {
  if (i.cannotIdentify && i.driverName) throw new S172RefusalError('s.172: you cannot both rely on s.172(4) (driver not identifiable) and name a driver');
  const covered = i.hire ? hireCovers(i.hire, i.penalty.contraventionAt) : false;
  if (i.driverName && !covered) throw new S172RefusalError('s.172: the named driver must be the hirer (or an additional driver) on an agreement covering the time of the alleged offence — never nominate a driver who was not driving');

  let driver: Party | undefined;
  if (i.driverName) {
    driver = sameName(i.hirer?.name, i.driverName) ? i.hirer : i.additionalDrivers?.find((p) => sameName(p.name, i.driverName));
    if (!driver) {
      // A name typed by the handler that matches nobody on the agreement: let the domain say so, then refuse.
      driver = { id: `named:${i.driverName.trim().toLowerCase()}`, kind: 'individual', name: i.driverName.trim(), roles: ['driver'], createdAt: i.penalty.receivedAt };
    }
  }
  const data = domainS172ResponseData(i.penalty, i.hire, i.hirer, { ...(driver ? { driver } : {}), recordsChecked: i.diligence });
  if (i.driverName && data.route !== 'driver_identified') {
    throw new S172RefusalError(`s.172: ${data.missing.join('; ') || 'the hire records do not identify the named driver'}`);
  }
  if (i.cannotIdentify && data.route === 'driver_identified') {
    throw new S172RefusalError(`s.172(4) is not available: the hire records identify ${data.driver?.name ?? 'the hirer'} as the driver in charge at ${i.penalty.contraventionAt}. Name the driver from the records, or record why the agreement does not establish who was driving.`);
  }
  return {
    ...data,
    cannotIdentify: i.cannotIdentify,
    diligence: i.diligence,
    keeper: { name: i.keeperName, addressLines: i.keeperAddressLines },
    vehicle: { registration: i.vehicle.registration, make: i.vehicle.make, model: i.vehicle.model },
  };
}
