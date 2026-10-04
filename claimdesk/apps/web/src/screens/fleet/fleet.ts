/**
 * Fleet screen model (pure; unit-tested). BLUEPRINT §3.12 (lesson l):
 *  - MOT, tax, insurance and service dates are coloured by how close they are (red expired, amber ≤ 30 days);
 *  - the keeper address on the V5C must be current (RENTX's CCJs came from tickets sent to a stale address);
 *  - class-of-use allocation is checked server-side (POST /fleet/:id/allocate-check) — the web only shows reasons;
 *  - PCN/NIP notices move through stages; the next stages offered here are plausible ones, the domain's
 *    `penaltyTransition` (via the API) is the authority and may refuse.
 *
 * TODO wire when @ccguk/domain fleet lands: read the allowed transitions from `penaltyTransition` instead of
 * `NEXT_STAGES` below (the API already enforces them).
 */
import type { Address, ComplianceAlert, FleetUnit, FleetUse, InsurancePolicy, ISODate, PenaltyNotice, Pence, Vehicle } from '@ccguk/domain';
import type { FleetUnitRow, FleetUnitWriteBody } from '../../api/client';
import type { VehiclePatchBody } from '../../api/vehiclesApi';
import type { Tone } from '../../lib/status';
import { daysBetween } from '../../lib/dates';
import { emptyPickerValue, patchHasChanges, pickerFromVehicle, toVehicleInput, validatePicker, vehiclePatchFrom, type PickerErrors, type VehiclePickerValue } from '../vehicles/vehiclePicker';
import { emptyGtaPanel, gtaPanelFromUnit, gtaSuggestionInput, validateGtaPanel, type GtaPanelState } from './gtaPanel';

// ---------------------------------------------------------------------------
// Rows as the screen reads them (the API may denormalise more than the contract promises)
// ---------------------------------------------------------------------------

export interface FleetUnitView extends FleetUnitRow {
  policy?: InsurancePolicy;
  /** Insurance expiry when the API does not embed the policy. */
  insuranceExpiryDate?: ISODate;
}

export interface PenaltyView extends PenaltyNotice {
  /** Denormalised by the API when the hire agreement is known. */
  claimId?: string;
  claimReference?: string;
  hirerName?: string;
  registration?: string;
}

export function unitRegistration(u: FleetUnitView): string {
  return u.registration ?? u.vehicle?.registration ?? '';
}

export function unitDescription(u: FleetUnitView): string {
  const v = u.vehicle;
  if (!v) return '';
  return [v.make, v.model, v.variant].filter(Boolean).join(' ');
}

export function insuranceExpiry(u: FleetUnitView): ISODate | undefined {
  return u.policy?.endDate ?? u.insuranceExpiryDate;
}

// ---------------------------------------------------------------------------
// Date colouring
// ---------------------------------------------------------------------------

export type DueTone = 'expired' | 'soon' | 'ok' | 'unknown';

export const DUE_SOON_DAYS = 30;

/** Expired → red, within 30 days → amber, later → green, missing → grey. */
export function dueTone(date: ISODate | undefined | null, today: ISODate): DueTone {
  if (!date) return 'unknown';
  const days = daysBetween(today, date);
  if (Number.isNaN(days)) return 'unknown';
  if (days < 0) return 'expired';
  if (days <= DUE_SOON_DAYS) return 'soon';
  return 'ok';
}

export function dueToneToBadge(t: DueTone): Tone {
  switch (t) {
    case 'expired':
      return 'red';
    case 'soon':
      return 'amber';
    case 'ok':
      return 'green';
    default:
      return 'grey';
  }
}

export function describeDueDate(date: ISODate | undefined | null, today: ISODate): string {
  if (!date) return 'not recorded';
  const days = daysBetween(today, date);
  if (days < 0) return `expired ${-days} day${-days === 1 ? '' : 's'} ago`;
  if (days === 0) return 'due today';
  return `due in ${days} day${days === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const FLEET_USE_LABEL: Record<FleetUse, string> = { credit_hire: 'Credit hire', self_drive: 'Self-drive', pco: 'PCO / PHV' };
export const FLEET_USES: FleetUse[] = ['credit_hire', 'self_drive', 'pco'];

export const UNIT_STATUS_LABEL: Record<FleetUnit['status'], string> = { available: 'Available', on_hire: 'On hire', off_road: 'Off road', disposed: 'Disposed' };
export const UNIT_STATUSES = Object.keys(UNIT_STATUS_LABEL) as FleetUnit['status'][];

export function unitStatusTone(s: FleetUnit['status']): Tone {
  switch (s) {
    case 'available':
      return 'green';
    case 'on_hire':
      return 'blue';
    case 'off_road':
      return 'amber';
    case 'disposed':
      return 'grey';
  }
}

export const PENALTY_KIND_LABEL: Record<PenaltyNotice['kind'], string> = {
  pcn_council: 'PCN (council)',
  pcn_private: 'Parking charge (private)',
  nip_s172: 'NIP / s.172',
  fpn: 'Fixed penalty',
  congestion_ulez: 'Congestion / ULEZ',
  dart_charge: 'Dart Charge'
};
export const PENALTY_KINDS = Object.keys(PENALTY_KIND_LABEL) as PenaltyNotice['kind'][];

export const PENALTY_STAGE_LABEL: Record<PenaltyNotice['stage'], string> = {
  received: 'Received',
  hirer_identified: 'Hirer identified',
  liability_transferred: 'Liability transferred',
  representations: 'Representations',
  appeal: 'Appeal',
  paid: 'Paid',
  cancelled: 'Cancelled',
  escalated: 'Escalated'
};

export function penaltyStageTone(s: PenaltyNotice['stage']): Tone {
  switch (s) {
    case 'received':
      return 'red';
    case 'hirer_identified':
      return 'amber';
    case 'liability_transferred':
    case 'representations':
    case 'appeal':
      return 'blue';
    case 'cancelled':
      return 'green';
    case 'paid':
      return 'grey';
    case 'escalated':
      return 'red';
  }
}

/** Plain-English basis for each penalty kind's deadlines (shown beside the form and the table). */
export function penaltyBasis(kind: PenaltyNotice['kind']): string {
  switch (kind) {
    case 'nip_s172':
      return 'Respond to the s.172 request within 28 days of service (Road Traffic Act 1988 s.172(7)); the NIP itself must have been served within 14 days of the offence (RTOA 1988 s.1). Name the hirer from the signed hire agreement.';
    case 'pcn_council':
      return 'Civil PCN: 50% discount if paid within 14 days of service; representations within 28 days. Transfer liability to the hirer with the Road Traffic (Owner Liability) Regulations 2000 Sch 2 particulars and the signed statement of liability.';
    case 'congestion_ulez':
    case 'dart_charge':
      return 'Road-user charge PCN: discount within 14 days, representations within 28 days of service. Transfer to the hirer with the hire agreement and the Sch 2 particulars.';
    case 'pcn_private':
      return 'Private parking charge (Protection of Freedoms Act 2012 Sch 4): the keeper can pass liability by naming the hirer within 28 days and supplying the hire documents. Appeal to POPLA / IAS after rejection.';
    case 'fpn':
      return 'Fixed penalty: pay or request a hearing within 28 days; where a hirer was driving, identify them under s.172 and send the hire agreement.';
  }
}

// ---------------------------------------------------------------------------
// Stage transitions offered in the UI (the API/domain is the authority)
// ---------------------------------------------------------------------------

export const NEXT_STAGES: Record<PenaltyNotice['stage'], PenaltyNotice['stage'][]> = {
  received: ['hirer_identified', 'representations', 'paid', 'cancelled'],
  hirer_identified: ['liability_transferred', 'representations', 'paid', 'cancelled'],
  liability_transferred: ['cancelled', 'representations', 'escalated'],
  representations: ['appeal', 'cancelled', 'paid', 'escalated'],
  appeal: ['cancelled', 'paid', 'escalated'],
  escalated: ['paid', 'cancelled'],
  paid: [],
  cancelled: []
};

export function nextStages(stage: PenaltyNotice['stage']): PenaltyNotice['stage'][] {
  return NEXT_STAGES[stage] ?? [];
}

export function isTerminalStage(stage: PenaltyNotice['stage']): boolean {
  return nextStages(stage).length === 0;
}

/** `hirer_identified` needs the hire agreement that puts a named driver in the car. */
export function transitionNeedsHire(stage: PenaltyNotice['stage']): boolean {
  return stage === 'hirer_identified';
}

/** Which notice template the "generate" buttons offer for a notice at its current stage. */
export function penaltyDocumentTemplate(notice: Pick<PenaltyNotice, 'kind' | 'stage'>): { templateId: 'notice.pcn_liability_transfer' | 'notice.s172_response'; label: string } | null {
  if (notice.stage === 'paid' || notice.stage === 'cancelled') return null;
  if (notice.kind === 'nip_s172' || notice.kind === 'fpn') return { templateId: 'notice.s172_response', label: 'Generate s.172 response' };
  return { templateId: 'notice.pcn_liability_transfer', label: 'Generate liability transfer notice' };
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export const ALERT_SEVERITY_ORDER: ComplianceAlert['severity'][] = ['block', 'warn', 'info'];
export const ALERT_SEVERITY_LABEL: Record<ComplianceAlert['severity'], string> = { block: 'Blocking', warn: 'Attention', info: 'Information' };

export function groupAlertsBySeverity(alerts: ComplianceAlert[]): Array<{ severity: ComplianceAlert['severity']; alerts: ComplianceAlert[] }> {
  return ALERT_SEVERITY_ORDER.map((severity) => ({
    severity,
    alerts: alerts.filter((a) => a.severity === severity).sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'))
  })).filter((g) => g.alerts.length > 0);
}

export const ALERT_CODE_LABEL: Record<ComplianceAlert['code'], string> = {
  MOT_DUE: 'MOT due',
  MOT_EXPIRED: 'MOT expired',
  TAX_DUE: 'Tax due',
  TAX_EXPIRED: 'Tax expired',
  INSURANCE_DUE: 'Insurance due',
  INSURANCE_EXPIRED: 'Insurance expired',
  SERVICE_DUE: 'Service due',
  KEEPER_ADDRESS_STALE: 'Keeper address stale',
  USE_NOT_COVERED: 'Use not covered',
  PENALTY_DEADLINE: 'Penalty deadline',
  PHV_NOT_ELIGIBLE: 'PHV not eligible'
};

// ---------------------------------------------------------------------------
// Unit form (docs/TEMPLATES-VEHICLES-DESKTOP.md §F.1)
// ---------------------------------------------------------------------------

/**
 * The unit dialog's state: the vehicle (VehiclePicker value: catalogue pick, Total Car Check paste or typed), the GTA
 * panel (group and daily rate pre-filled from the benchmark suggestion until edited) and the unit's own fields.
 */
export interface UnitForm {
  vehicle: VehiclePickerValue;
  gta: GtaPanelState;
  declaredUses: FleetUse[];
  policyId: string;
  keeperLine1: string;
  keeperLine2: string;
  keeperTown: string;
  keeperPostcode: string;
  keeperAddressCurrent: boolean;
  serviceDueDate: ISODate | '';
  status: FleetUnit['status'];
  phvLicensed: boolean;
}

export function emptyUnitForm(): UnitForm {
  return {
    vehicle: emptyPickerValue(),
    gta: emptyGtaPanel(),
    declaredUses: [],
    policyId: '',
    keeperLine1: '',
    keeperLine2: '',
    keeperTown: '',
    keeperPostcode: '',
    keeperAddressCurrent: true,
    serviceDueDate: '',
    status: 'available',
    phvLicensed: false
  };
}

export function unitToForm(u: FleetUnitView, groupsWithRates: readonly string[] = []): UnitForm {
  const k = u.keeperAddressOnV5C;
  return {
    vehicle: u.vehicle ? pickerFromVehicle(u.vehicle) : emptyPickerValue(unitRegistration(u)),
    gta: gtaPanelFromUnit(u, groupsWithRates),
    declaredUses: [...(u.declaredUses ?? [])],
    policyId: u.policyId ?? '',
    keeperLine1: k?.line1 ?? '',
    keeperLine2: k?.line2 ?? '',
    keeperTown: k?.town ?? '',
    keeperPostcode: k?.postcode ?? '',
    keeperAddressCurrent: u.keeperAddressCurrent ?? true,
    serviceDueDate: u.serviceDueDate ?? '',
    status: u.status ?? 'available',
    phvLicensed: Boolean(u.phvLicensed)
  };
}

export type UnitFormErrors = Partial<Record<'registration' | 'gtaGroup' | 'dailyRatePence' | 'declaredUses' | 'policyId' | 'keeperPostcode', string>> & {
  vehicle?: PickerErrors;
};

const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

export function validateUnitForm(f: UnitForm, isNew: boolean): UnitFormErrors {
  const e: UnitFormErrors = {};
  if (isNew && !f.vehicle.registration.trim()) e.registration = 'Registration is required';
  const gta = validateGtaPanel(f.gta);
  if (gta.group) e.gtaGroup = gta.group;
  if (gta.ratePence) e.dailyRatePence = gta.ratePence;
  if (f.declaredUses.length === 0) e.declaredUses = 'Declare at least one class of use';
  if (f.declaredUses.includes('credit_hire') && f.declaredUses.includes('self_drive') && !f.policyId.trim()) {
    e.policyId = 'Credit hire and self-drive together need a policy that covers both — Collingwood will not (§3.12)';
  }
  if (f.keeperPostcode.trim() && !UK_POSTCODE.test(f.keeperPostcode.trim())) e.keeperPostcode = 'Enter a UK postcode';
  if (f.keeperLine1.trim() && !f.keeperPostcode.trim()) e.keeperPostcode = 'Postcode is required with the address';
  const vehicle = validatePicker(f.vehicle);
  if (Object.keys(vehicle).length) e.vehicle = vehicle;
  return e;
}

/** POST /fleet body (§F.1 step 5): vehicle (picker fields + spec + source), group, daily rate and the GTA suggestion. */
export type FleetUnitBody = FleetUnitWriteBody;

/** PATCH /fleet/:id body: the unit's fields and, when the vehicle changed, the vehicle patch with its source. */
export type FleetUnitPatchBody = Omit<FleetUnitWriteBody, 'vehicle' | 'gtaSuggestion'> & { vehicle?: VehiclePatchBody };

function keeperAddress(f: UnitForm): Address | undefined {
  return f.keeperLine1.trim()
    ? { line1: f.keeperLine1.trim(), line2: f.keeperLine2.trim() || undefined, town: f.keeperTown.trim() || undefined, postcode: f.keeperPostcode.trim().toUpperCase() }
    : undefined;
}

/** Form → POST /fleet body. Pence stay pence; dates stay ISO; the vehicle is recorded as unverified by the server. */
export function buildUnitBody(f: UnitForm): FleetUnitBody {
  const group = f.gta.group.trim().toUpperCase();
  const vehicle = toVehicleInput({ ...f.vehicle, registration: f.vehicle.registration.replace(/\s+/g, '').toUpperCase() }, { ownership: 'fleet' });
  const body: FleetUnitBody = {
    vehicle,
    declaredUses: f.declaredUses,
    policyId: f.policyId.trim() || undefined,
    keeperAddressOnV5C: keeperAddress(f),
    keeperAddressCurrent: f.keeperAddressCurrent,
    serviceDueDate: f.serviceDueDate || undefined,
    status: f.status,
    phvLicensed: f.phvLicensed
  };
  if (group) body.gtaGroup = group;
  if (f.gta.ratePence !== null) body.dailyRatePence = f.gta.ratePence;
  const suggestion = gtaSuggestionInput(f.gta);
  if (suggestion) body.gtaSuggestion = suggestion;
  return body;
}

/**
 * Form → PATCH /fleet/:id body. The vehicle changes go too (the API applies them to the vehicle record with their
 * source, §F.2); `initialVehicle` is the picker value the dialog opened with.
 */
export function buildUnitPatch(f: UnitForm, initialVehicle: VehiclePickerValue): FleetUnitPatchBody {
  const group = f.gta.group.trim().toUpperCase();
  const body: FleetUnitPatchBody = {
    declaredUses: f.declaredUses,
    policyId: f.policyId.trim() || undefined,
    keeperAddressOnV5C: keeperAddress(f),
    keeperAddressCurrent: f.keeperAddressCurrent,
    serviceDueDate: f.serviceDueDate || undefined,
    status: f.status,
    phvLicensed: f.phvLicensed
  };
  if (group) body.gtaGroup = group;
  if (f.gta.ratePence !== null) body.dailyRatePence = f.gta.ratePence;
  const vehicle = vehiclePatchFrom(initialVehicle, f.vehicle);
  if (patchHasChanges(vehicle)) body.vehicle = vehicle;
  return body;
}

// ---------------------------------------------------------------------------
// Penalty form
// ---------------------------------------------------------------------------

export interface PenaltyForm {
  fleetUnitId: string;
  kind: PenaltyNotice['kind'] | '';
  issuer: string;
  noticeNumber: string;
  contraventionAt: string;
  receivedAt: string;
  amountPence: Pence | null;
  discountDeadline: ISODate | '';
  responseDeadline: ISODate | '';
  hireAgreementId: string;
  notes: string;
}

export function emptyPenaltyForm(fleetUnitId = ''): PenaltyForm {
  return { fleetUnitId, kind: '', issuer: '', noticeNumber: '', contraventionAt: '', receivedAt: '', amountPence: null, discountDeadline: '', responseDeadline: '', hireAgreementId: '', notes: '' };
}

export type PenaltyFormErrors = Partial<Record<keyof PenaltyForm, string>>;

export function validatePenaltyForm(f: PenaltyForm, now: Date): PenaltyFormErrors {
  const e: PenaltyFormErrors = {};
  if (!f.fleetUnitId) e.fleetUnitId = 'Pick the fleet unit named on the notice';
  if (!f.kind) e.kind = 'Pick the notice type';
  if (!f.issuer.trim()) e.issuer = 'Issuer is required (council, police force, operator)';
  if (!f.noticeNumber.trim()) e.noticeNumber = 'Notice number is required';
  if (!f.contraventionAt) e.contraventionAt = 'When did the contravention happen?';
  else if (Date.parse(f.contraventionAt) > now.getTime()) e.contraventionAt = 'Contravention cannot be in the future';
  if (!f.receivedAt) e.receivedAt = 'When was the notice received? This starts the response clock';
  else if (f.contraventionAt && Date.parse(f.receivedAt) < Date.parse(f.contraventionAt)) e.receivedAt = 'Received before the contravention — check the dates';
  if (f.amountPence === null || f.amountPence < 0) e.amountPence = 'Enter the amount on the notice in pounds';
  if (!f.responseDeadline) e.responseDeadline = 'Enter the response deadline printed on the notice';
  else if (f.receivedAt && f.responseDeadline < f.receivedAt.slice(0, 10)) e.responseDeadline = 'Deadline is before the notice was received';
  if (f.discountDeadline && f.responseDeadline && f.discountDeadline > f.responseDeadline) e.discountDeadline = 'Discount deadline is after the response deadline';
  return e;
}

export type PenaltyBody = Omit<PenaltyNotice, 'id' | 'documentIds' | 'stage'>;

export function buildPenaltyBody(f: PenaltyForm): PenaltyBody {
  return {
    fleetUnitId: f.fleetUnitId,
    kind: f.kind as PenaltyNotice['kind'],
    issuer: f.issuer.trim(),
    noticeNumber: f.noticeNumber.trim(),
    contraventionAt: f.contraventionAt,
    receivedAt: f.receivedAt,
    amountPence: f.amountPence ?? 0,
    discountDeadline: f.discountDeadline || undefined,
    responseDeadline: f.responseDeadline,
    hireAgreementId: f.hireAgreementId.trim() || undefined,
    notes: f.notes.trim() || undefined
  };
}

/** Sort: open notices by nearest response deadline first, then terminal ones. */
export function sortPenalties<T extends Pick<PenaltyNotice, 'stage' | 'responseDeadline'>>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ta = isTerminalStage(a.stage) ? 1 : 0;
    const tb = isTerminalStage(b.stage) ? 1 : 0;
    if (ta !== tb) return ta - tb;
    return a.responseDeadline.localeCompare(b.responseDeadline);
  });
}

export function vehicleFor(units: FleetUnitView[], unitId: string): Vehicle | undefined {
  return units.find((u) => u.id === unitId)?.vehicle;
}
