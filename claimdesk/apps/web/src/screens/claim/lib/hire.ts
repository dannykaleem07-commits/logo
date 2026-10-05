/**
 * Hire / storage / recovery presentation helpers (pure). Charges use the domain's pure calculators
 * (calculateHire, storageCharge, recoveryCharge) so the card figures match the invoice templates; the ledger
 * remains the figure that is claimed. GTA end triggers and rates are an industry benchmark only: CCGUK is not a GTA
 * subscriber (the clause that says so is cited in tooltips, never in the visible text).
 *
 * 0.3 (docs/V03-MANAGER-MODE-HIRE-PRICING.md §C): hires can be entered late (a past start, and an end when it is already
 * over), and corrected afterwards with a reason. A future end is only ever a warning; an end before the start is an
 * error that manager mode relaxes to a warning (the server records the override and flags the claim).
 */
import {
  calculateHire,
  formatGBP,
  recoveryCharge,
  storageCharge,
  type GtaRate,
  type HireAgreement,
  type HireCalculation,
  type FleetUnit,
  type FleetUse,
  type HireEndTrigger,
  type ISODateTime,
  type Pence,
  type RecoveryCharge,
  type RecoveryRecord,
  type StorageCharge,
  type StorageRecord
} from '@ccguk/domain';
import type { FormResult } from './chronology';
import type { CorrectHireBody, CorrectHireResponse, CreateHireBody } from '../../../api/hireApi';
import { managerWarning, relaxedKeys, relaxErrors } from '../../../lib/managerMode';

export const GTA_BENCHMARK_NOTE = 'industry benchmark (CCGUK is not a GTA subscriber)';

export interface TriggerOption<V extends string> {
  value: V;
  label: string;
  basis: string;
}

export const HIRE_TRIGGERS: TriggerOption<HireEndTrigger>[] = [
  { value: 'repair_complete_24h', label: 'Repair completed — off-hire within 24 hours', basis: `GTA 4.8, ${GTA_BENCHMARK_NOTE}` },
  { value: 'tl_payment_5wd', label: 'Total-loss payment received — off-hire within 5 working days', basis: `GTA 4.14 table (CHO dealing, unroadworthy), ${GTA_BENCHMARK_NOTE}` },
  { value: 'insurer_termination_1wd', label: 'Insurer termination notice — off-hire within 1 working day', basis: `GTA 4.9, ${GTA_BENCHMARK_NOTE}` },
  { value: 'cash_in_lieu', label: 'Cash in lieu received — hire stops on receipt', basis: `GTA 4.7, ${GTA_BENCHMARK_NOTE}` },
  { value: 'client_returned', label: 'Client returned the vehicle', basis: 'Hire ends when the client no longer needs the vehicle (mitigation)' },
  { value: 'replacement_purchased', label: 'Client bought a replacement vehicle', basis: 'Need ends with the replacement; hire past this date is not recoverable' },
  { value: 'manual', label: 'Other (give the reason)', basis: 'Record the reason so the period is explainable' }
];

export type StorageEndTrigger = NonNullable<StorageRecord['endTrigger']>;

export const STORAGE_TRIGGERS: TriggerOption<StorageEndTrigger>[] = [
  { value: 'report_issued', label: "Engineer's report issued", basis: 'Insurers commonly cap storage at report + 48 hours; send collect-or-pay on report day' },
  { value: 'total_loss_confirmed', label: 'Total loss confirmed', basis: 'Storage after confirmation is only recoverable while the insurer has not collected' },
  { value: 'payment_received', label: 'Payment received', basis: 'Storage ends when the insurer has paid and may collect' },
  { value: 'collected', label: 'Vehicle collected', basis: 'Physical end of storage' },
  { value: 'salvage_released', label: 'Released to salvage', basis: 'Physical end of storage' },
  { value: 'manual', label: 'Other (give the reason)', basis: 'Record the reason so the period is explainable' }
];

export function triggerLabel<V extends string>(options: TriggerOption<V>[], value: V | string | undefined): string {
  if (!value) return '—';
  return options.find((o) => o.value === value)?.label ?? value.replace(/_/g, ' ');
}

/** Running: no end yet, or an end that is still in the future (the expected return, set with Edit dates). */
export function hireRunning(h: Pick<HireAgreement, 'endAt'>, nowIso: ISODateTime = new Date().toISOString()): boolean {
  return !h.endAt || Date.parse(h.endAt) > Date.parse(nowIso);
}

/** The instant a hire is charged to: its end once that has arrived, otherwise now (as the API does). */
export function hireCostedTo(h: Pick<HireAgreement, 'endAt'>, asOf: ISODateTime): ISODateTime {
  return h.endAt && Date.parse(h.endAt) <= Date.parse(asOf) ? h.endAt : asOf;
}

/**
 * Indicative hire totals for the card; a running hire is costed to `asOf`. `rates` is the merged GTA benchmark table
 * (knowledge base ⊕ Settings → GTA benchmark rates, from `useGtaRates()`); without it the domain's built-in table is
 * used. An empty list means no benchmark line. Undefined when the domain refuses the input.
 */
export function hireTotals(h: HireAgreement, asOf: ISODateTime, rates?: GtaRate[]): HireCalculation | undefined {
  try {
    return calculateHire(h, hireCostedTo(h, asOf), rates ? { rates } : {});
  } catch {
    return undefined;
  }
}

export function storageTotals(s: StorageRecord, asOf: ISODateTime): StorageCharge | undefined {
  try {
    return storageCharge(s, s.endAt ?? asOf);
  } catch {
    return undefined;
  }
}

export function recoveryTotals(r: RecoveryRecord): RecoveryCharge {
  return recoveryCharge(r);
}

export interface EnforceabilityItem {
  key: 'cancellationInfo' | 'schedule3' | 'expressRequest' | 'signed' | 'cca60f';
  label: string;
  basis: string;
  at?: ISODateTime;
  ok: boolean;
}

/** The W v Veolia / Dimond v Lovell checklist: four dates and the art 60F flag. */
export function enforceabilityChecklist(h: HireAgreement): EnforceabilityItem[] {
  const e = h.enforceability;
  return [
    { key: 'cancellationInfo', label: 'Cancellation information given', basis: 'Consumer Contracts Regulations 2013 Sch 2 — off-premises service contract', at: e.cancellationInfoProvidedAt, ok: Boolean(e.cancellationInfoProvidedAt) },
    { key: 'schedule3', label: 'Cancellation form given', basis: 'CCR 2013 Sch 3 — model cancellation form', at: e.schedule3FormProvidedAt, ok: Boolean(e.schedule3FormProvidedAt) },
    { key: 'expressRequest', label: 'Express request to start in the cancellation period', basis: 'CCR 2013 reg 36 — without it the consumer may owe nothing for the service (W v Veolia)', at: e.expressRequestToStartAt, ok: Boolean(e.expressRequestToStartAt) },
    { key: 'signed', label: 'Agreement signed', basis: 'Signature date must not pre-date creation; duplicate dates on one file are flagged', at: h.signedAt, ok: Boolean(h.signedAt) },
    { key: 'cca60f', label: 'CCA 1974 / RAO art 60F exempt', basis: '≤ 12 payments within 12 months, no interest or charges — otherwise Dimond v Lovell: no recoverable loss', ok: e.cca60fCompliant }
  ];
}

export function enforceabilityScore(h: HireAgreement): { ok: number; total: number } {
  const items = enforceabilityChecklist(h);
  return { ok: items.filter((i) => i.ok).length, total: items.length };
}

export interface EndHireForm {
  endTrigger: HireEndTrigger | '';
  endAt: ISODateTime | '';
  collectedAt: ISODateTime | '';
  odometerIn: string;
  reason: string;
}

export type EndHireBody = { endAt: ISODateTime; endTrigger: HireEndTrigger; odometerIn?: number; collectedAt?: ISODateTime; reason?: string };

/** A form check with amber warnings and the manager-mode relaxations (rule keys for the X-Manager-Relaxed header). */
export type CheckedForm<T> = { ok: true; body: T; warnings?: Record<string, string>; relaxed?: string[] } | { ok: false; errors: Record<string, string>; warnings?: Record<string, string> };

export interface CheckOptions {
  /** Manager mode is on: an end before the start becomes a warning (the server overrides it, audited). */
  managerOn?: boolean;
  /** Accident date-time, for the "starts before the accident" warning. */
  accidentAt?: ISODateTime;
}

const FUTURE_SLACK_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

export const END_BEFORE_START = 'The end cannot be before the start';
export const FUTURE_END_WARNING = 'This end is in the future: the hire will show as running until then.';
export const BEFORE_ACCIDENT_WARNING = 'This start is before the accident date.';
export const OLD_START_WARNING = 'This start is more than a year ago.';

function addMessage(map: Record<string, string>, key: string, message: string): void {
  map[key] = map[key] ? `${map[key]} ${message}` : message;
}

/** Amber warnings for hire dates (never blocking): a future end, a start before the accident, a start over a year ago. */
export function hireDateWarnings(startAt: ISODateTime | '', endAt: ISODateTime | '' | null | undefined, nowIso: ISODateTime, accidentAt?: ISODateTime): Record<string, string> {
  const out: Record<string, string> = {};
  const now = Date.parse(nowIso);
  const start = startAt ? Date.parse(startAt) : NaN;
  const end = endAt ? Date.parse(endAt) : NaN;
  if (!Number.isNaN(end) && end > now + FUTURE_SLACK_MS) addMessage(out, 'endAt', FUTURE_END_WARNING);
  if (!Number.isNaN(start)) {
    const accident = accidentAt ? Date.parse(accidentAt) : NaN;
    if (!Number.isNaN(accident) && start < accident) addMessage(out, 'startAt', BEFORE_ACCIDENT_WARNING);
    if (start < now - 365 * DAY_MS) addMessage(out, 'startAt', OLD_START_WARNING);
  }
  return out;
}

/**
 * Hard errors plus soft (relaxable) errors → the result. In manager mode the soft errors become warnings prefixed
 * "Allowed in manager mode: " and their keys are returned as relaxed rule keys `${form}.${key}`.
 */
function settle<T>(form: string, hard: Record<string, string>, soft: Record<string, string>, warnings: Record<string, string>, managerOn: boolean, body: () => T): CheckedForm<T> {
  const relaxed = relaxErrors(soft, managerOn);
  const allWarnings = { ...warnings };
  for (const [k, v] of Object.entries(relaxed.warnings)) addMessage(allWarnings, k, managerWarning(v) ?? v);
  const errors = { ...relaxed.errors, ...hard };
  const w = Object.keys(allWarnings).length ? { warnings: allWarnings } : {};
  if (Object.keys(errors).length) return { ok: false, errors, ...w };
  const keys = relaxedKeys(form, relaxed.warnings);
  return { ok: true, body: body(), ...w, ...(keys.length ? { relaxed: keys } : {}) };
}

function odometer(text: string): { value?: number; error?: string } {
  if (text.trim() === '') return {};
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 ? { value: n } : { error: 'Whole miles' };
}

/** End hire: a trigger and a date are required; a future end is a warning; end before start is an error (relaxed in manager mode). */
export function endHireBodyFrom(form: EndHireForm, hire: Pick<HireAgreement, 'startAt'>, nowIso: ISODateTime, opts: CheckOptions = {}): CheckedForm<EndHireBody> {
  const hard: Record<string, string> = {};
  const soft: Record<string, string> = {};
  if (!form.endTrigger) hard.endTrigger = 'Choose what ended the hire — the trigger is the period defence';
  if (!form.endAt) hard.endAt = 'Enter when the hire ended';
  else if (Date.parse(form.endAt) < Date.parse(hire.startAt)) soft.endAt = END_BEFORE_START;
  if (form.endTrigger === 'manual' && form.reason.trim().length < 3) hard.reason = 'Give the reason';
  const odo = odometer(form.odometerIn);
  if (odo.error) hard.odometerIn = odo.error;
  const warnings = form.endAt ? hireDateWarnings('', form.endAt, nowIso) : {};
  return settle('endHire', hard, soft, warnings, Boolean(opts.managerOn), () => ({
    endTrigger: form.endTrigger as HireEndTrigger,
    endAt: form.endAt as ISODateTime,
    collectedAt: form.collectedAt || undefined,
    odometerIn: odo.value,
    reason: form.reason.trim() || undefined
  }));
}

// ---------------------------------------------------------------------------
// Start hire (§B.1, §C.1, E10)
// ---------------------------------------------------------------------------

export const USE_OPTIONS: Array<{ value: FleetUse; label: string }> = [
  { value: 'credit_hire', label: 'Credit hire' },
  { value: 'self_drive', label: 'Self-drive hire' },
  { value: 'pco', label: 'PCO / private hire' }
];

export interface StartHireForm {
  fleetUnitId: string;
  use: FleetUse;
  startAt: ISODateTime | '';
  /** Optional: a hire that has already ended (entered late). */
  endAt: ISODateTime | '';
  endTrigger: HireEndTrigger | '';
  endReason: string;
  dailyRatePence: Pence | null;
  gtaGroup: string;
  /** The client's car group chosen by hand on the pricing guide ('' = recorded / suggested). */
  clientGtaGroup: string;
  excessPence: Pence | null;
  excessWaiverDailyPence: Pence | null;
  deliveredAt: ISODateTime | '';
  odometerOut: string;
  signedAt: ISODateTime | '';
  cancellationInfoProvidedAt: ISODateTime | '';
  schedule3FormProvidedAt: ISODateTime | '';
  expressRequestToStartAt: ISODateTime | '';
  cca60fCompliant: boolean;
  needStatementEvidenceId: string;
}

export function emptyStartHireForm(nowIso: ISODateTime): StartHireForm {
  return {
    fleetUnitId: '',
    use: 'credit_hire',
    startAt: nowIso,
    endAt: '',
    endTrigger: '',
    endReason: '',
    dailyRatePence: null,
    gtaGroup: '',
    clientGtaGroup: '',
    excessPence: 0,
    excessWaiverDailyPence: null,
    deliveredAt: '',
    odometerOut: '',
    signedAt: '',
    cancellationInfoProvidedAt: '',
    schedule3FormProvidedAt: '',
    expressRequestToStartAt: '',
    cca60fCompliant: false,
    needStatementEvidenceId: ''
  };
}

/** "Paperwork signed now": the three enforceability times and the signed time are stamped with the hire start. */
export function paperworkSignedNow(form: StartHireForm, nowIso: ISODateTime): StartHireForm {
  const at = form.startAt || nowIso;
  return { ...form, signedAt: at, cancellationInfoProvidedAt: at, schedule3FormProvidedAt: at, expressRequestToStartAt: at };
}

/** Picking a car: the agreed rate defaults to its fleet rate, the group to its group. */
export function pickFleetUnit(form: StartHireForm, unit: Pick<FleetUnit, 'id' | 'dailyRatePence' | 'gtaGroup'> | undefined): StartHireForm {
  if (!unit) return { ...form, fleetUnitId: '' };
  return { ...form, fleetUnitId: unit.id, dailyRatePence: unit.dailyRatePence, gtaGroup: unit.gtaGroup, clientGtaGroup: form.clientGtaGroup };
}

export function startHireBodyFrom(form: StartHireForm, unit: Pick<FleetUnit, 'status'> | undefined, nowIso: ISODateTime, opts: CheckOptions = {}): CheckedForm<CreateHireBody> {
  const hard: Record<string, string> = {};
  const soft: Record<string, string> = {};
  const warnings: Record<string, string> = {};
  if (!form.fleetUnitId) hard.fleetUnitId = 'Choose the fleet car';
  else if (unit?.status === 'off_road') soft.fleetUnitId = 'This car is off road';
  else if (unit?.status === 'on_hire') warnings.fleetUnitId = 'On hire now — fine for an earlier period; the dates are checked against its other hires when you save.';
  if (!form.startAt) hard.startAt = 'When did the hire start?';
  if (form.dailyRatePence === null || form.dailyRatePence <= 0) hard.dailyRatePence = 'Agreed daily rate in pounds (ex VAT), more than £0';
  const odo = odometer(form.odometerOut);
  if (odo.error) hard.odometerOut = odo.error;
  if (form.endAt) {
    if (!form.endTrigger) hard.endTrigger = 'Choose what ended the hire';
    if (form.endTrigger === 'manual' && form.endReason.trim().length < 3) hard.endReason = 'Give the reason';
    if (form.startAt && Date.parse(form.endAt) < Date.parse(form.startAt)) soft.endAt = END_BEFORE_START;
  }
  Object.assign(warnings, hireDateWarnings(form.startAt, form.endAt, nowIso, opts.accidentAt));
  const enforceability = {
    cancellationInfoProvidedAt: form.cancellationInfoProvidedAt || undefined,
    schedule3FormProvidedAt: form.schedule3FormProvidedAt || undefined,
    expressRequestToStartAt: form.expressRequestToStartAt || undefined,
    cca60fCompliant: form.cca60fCompliant
  };
  return settle('startHire', hard, soft, warnings, Boolean(opts.managerOn), () => {
    const body: CreateHireBody = {
      fleetUnitId: form.fleetUnitId,
      use: form.use,
      startAt: form.startAt as ISODateTime,
      dailyRatePence: form.dailyRatePence as Pence,
      excessPence: form.excessPence ?? 0,
      enforceability
    };
    if (form.gtaGroup) body.gtaGroup = form.gtaGroup;
    if (form.clientGtaGroup) body.clientGtaGroup = form.clientGtaGroup;
    if (form.excessWaiverDailyPence !== null) body.excessWaiverDailyPence = form.excessWaiverDailyPence;
    if (form.deliveredAt) body.deliveredAt = form.deliveredAt;
    if (odo.value !== undefined) body.odometerOut = odo.value;
    if (form.signedAt) body.signedAt = form.signedAt;
    if (form.needStatementEvidenceId) body.needStatementEvidenceId = form.needStatementEvidenceId;
    if (form.endAt) {
      body.endAt = form.endAt;
      body.endTrigger = (form.endTrigger || 'manual') as HireEndTrigger;
      if (form.endReason.trim()) body.endReason = form.endReason.trim();
    }
    return body;
  });
}

// ---------------------------------------------------------------------------
// Edit dates & rate (§C.1)
// ---------------------------------------------------------------------------

export const GTA_GROUP_RE = /^[A-Z]{1,3}\d{0,2}$/;

export interface EditHireForm {
  startAt: ISODateTime | '';
  /** '' = still running. */
  endAt: ISODateTime | '';
  endTrigger: HireEndTrigger | '';
  dailyRatePence: Pence | null;
  gtaGroup: string;
  clientGtaGroup: string;
  /** What the client's car group box opened with (for an older hire: the group worked out today, not stored). */
  initialClientGtaGroup?: string;
  reason: string;
  /** Update the claimed hire amount on the ledger. */
  updateLedger: boolean;
}

export function editHireFormFrom(h: Pick<HireAgreement, 'startAt' | 'endAt' | 'endTrigger' | 'dailyRatePence' | 'gtaGroup' | 'clientGtaGroup'>, pricingClientGroup?: string | null): EditHireForm {
  return {
    startAt: h.startAt,
    endAt: h.endAt ?? '',
    endTrigger: h.endTrigger ?? '',
    dailyRatePence: h.dailyRatePence,
    gtaGroup: h.gtaGroup,
    clientGtaGroup: h.clientGtaGroup ?? pricingClientGroup ?? '',
    initialClientGtaGroup: h.clientGtaGroup ?? pricingClientGroup ?? '',
    reason: '',
    updateLedger: true
  };
}

const sameInstant = (a: string | undefined | null, b: string | undefined | null): boolean => {
  if (!a || !b) return !a && !b;
  return Date.parse(a) === Date.parse(b);
};

/** The PATCH body with only what changed; a reason (3+ characters) is required. */
export function correctHireBodyFrom(form: EditHireForm, hire: Pick<HireAgreement, 'startAt' | 'endAt' | 'endTrigger' | 'dailyRatePence' | 'gtaGroup' | 'clientGtaGroup'>, nowIso: ISODateTime, opts: CheckOptions = {}): CheckedForm<CorrectHireBody> {
  const hard: Record<string, string> = {};
  const soft: Record<string, string> = {};
  const group = form.gtaGroup.trim().toUpperCase();
  const clientGroup = form.clientGtaGroup.trim().toUpperCase();
  if (!form.startAt) hard.startAt = 'When did the hire start?';
  if (form.dailyRatePence === null || form.dailyRatePence <= 0) hard.dailyRatePence = 'Daily rate must be more than £0';
  if (!group || !GTA_GROUP_RE.test(group)) hard.gtaGroup = 'A GTA group such as S1, M or CP2';
  if (clientGroup && !GTA_GROUP_RE.test(clientGroup)) hard.clientGtaGroup = 'A GTA group such as S1, M or CP2';
  if (form.endAt && !form.endTrigger) hard.endTrigger = 'Choose what ended the hire';
  if (form.reason.trim().length < 3) hard.reason = 'Give the reason for the change (at least 3 characters)';
  if (form.startAt && form.endAt && Date.parse(form.endAt) < Date.parse(form.startAt)) soft.endAt = END_BEFORE_START;

  const patch: Omit<CorrectHireBody, 'reason' | 'ledger'> = {};
  if (form.startAt && !sameInstant(form.startAt, hire.startAt)) patch.startAt = form.startAt;
  if (!sameInstant(form.endAt || null, hire.endAt ?? null)) patch.endAt = form.endAt || null;
  if (form.endAt && form.endTrigger && form.endTrigger !== hire.endTrigger) patch.endTrigger = form.endTrigger;
  if (form.dailyRatePence !== null && form.dailyRatePence !== hire.dailyRatePence) patch.dailyRatePence = form.dailyRatePence;
  if (group && group !== hire.gtaGroup.toUpperCase()) patch.gtaGroup = group;
  const currentClient = (hire.clientGtaGroup ?? '').toUpperCase();
  // Only a change the user made: a pre-filled group worked out today (older hire, nothing stored) is not sent.
  const opened = (form.initialClientGtaGroup ?? hire.clientGtaGroup ?? '').trim().toUpperCase();
  if (clientGroup !== opened && clientGroup !== currentClient && (clientGroup || hire.clientGtaGroup)) patch.clientGtaGroup = clientGroup || null;
  if (!Object.keys(hard).length && !Object.keys(patch).length) hard.form = 'Nothing has changed yet — change a date, the rate or a group.';

  const warnings = hireDateWarnings(form.startAt, form.endAt, nowIso, opts.accidentAt);
  return settle('editHire', hard, soft, warnings, Boolean(opts.managerOn), () => ({ ...patch, reason: form.reason.trim(), ledger: form.updateLedger ? 'auto' : 'skip' }));
}

export interface CorrectionPreview {
  before?: { days: number; netPence: Pence };
  after?: { days: number; netPence: Pence };
  /** "Now 12 days · £597.60 net → after 10 days · £498.00 net (−£99.60)". */
  text: string;
}

const daysText = (n: number): string => `${n} day${n === 1 ? '' : 's'}`;

/** Live before/after figures for the Edit dialog (a running hire is costed to `nowIso`). */
export function correctionPreview(hire: HireAgreement, form: EditHireForm, nowIso: ISODateTime): CorrectionPreview {
  const b = hireTotals(hire, nowIso, []);
  const before = b ? { days: b.days, netPence: b.netPence } : undefined;
  let after: { days: number; netPence: Pence } | undefined;
  if (form.startAt && form.dailyRatePence !== null && form.dailyRatePence > 0) {
    if (form.endAt && Date.parse(form.endAt) < Date.parse(form.startAt)) {
      after = { days: 0, netPence: 0 }; // charged as 0 days until the dates are corrected
    } else {
      const next: HireAgreement = { ...hire, startAt: form.startAt, dailyRatePence: form.dailyRatePence, gtaGroup: form.gtaGroup || hire.gtaGroup };
      if (form.endAt) next.endAt = form.endAt;
      else delete next.endAt;
      const a = hireTotals(next, nowIso, []);
      if (a) after = { days: a.days, netPence: a.netPence };
    }
  }
  const now = before ? `Now ${daysText(before.days)} · ${formatGBP(before.netPence)} net` : 'Now —';
  let text = `${now} → after —`;
  if (after) {
    const delta = before ? after.netPence - before.netPence : 0;
    const sign = delta > 0 ? `+${formatGBP(delta)}` : delta < 0 ? `−${formatGBP(-delta)}` : '±£0.00';
    text = `${now} → after ${daysText(after.days)} · ${formatGBP(after.netPence)} net (${sign})`;
  }
  return { ...(before ? { before } : {}), ...(after ? { after } : {}), text };
}

/** "Hire CCG-H-000004 updated — 10 days, £498.00 net. Clocks recalculated." */
export function correctionToast(agreementNumber: string, res: Pick<CorrectHireResponse, 'changed' | 'after'>): string {
  if (!res.changed) return `Hire ${agreementNumber}: nothing changed.`;
  return `Hire ${agreementNumber} updated — ${daysText(res.after.days)}, ${formatGBP(res.after.netPence)} net. Clocks recalculated.`;
}

/** Plain text for one value in a correction's from → to list. */
export { correctionChangesText, correctionValueText } from '../../../lib/auditText';

export interface EndStorageForm {
  endTrigger: StorageEndTrigger | '';
  endAt: ISODateTime | '';
  reason: string;
}

export type EndStorageBody = { endAt: ISODateTime; endTrigger: StorageEndTrigger; reason?: string };

export function endStorageBodyFrom(form: EndStorageForm, storage: Pick<StorageRecord, 'startAt'>, nowIso: ISODateTime): FormResult<EndStorageBody> {
  const errors: Record<string, string> = {};
  if (!form.endTrigger) errors.endTrigger = 'Choose what ended the storage';
  if (!form.endAt) errors.endAt = 'Enter when storage ended';
  else if (Date.parse(form.endAt) < Date.parse(storage.startAt)) errors.endAt = 'The end cannot be before the start';
  else if (Date.parse(form.endAt) > Date.parse(nowIso) + 5 * 60_000) errors.endAt = 'The end cannot be in the future';
  if (form.endTrigger === 'manual' && form.reason.trim().length < 3) errors.reason = 'Give the reason';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, body: { endTrigger: form.endTrigger as StorageEndTrigger, endAt: form.endAt, reason: form.reason.trim() || undefined } };
}

export interface StorageForm {
  location: string;
  startAt: ISODateTime | '';
  dailyRatePence: number | null;
}

export function storageBodyFrom(form: StorageForm): FormResult<Partial<StorageRecord>> {
  const errors: Record<string, string> = {};
  if (form.location.trim().length < 2) errors.location = 'Where is the vehicle stored?';
  if (!form.startAt) errors.startAt = 'When did storage start?';
  if (form.dailyRatePence !== null && form.dailyRatePence <= 0) errors.dailyRatePence = 'Daily rate must be positive (rate card £45/day)';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, body: { location: form.location.trim(), startAt: form.startAt, dailyRatePence: form.dailyRatePence ?? undefined } };
}

export interface RecoveryForm {
  at: ISODateTime | '';
  fromLocation: string;
  toLocation: string;
  loadedMiles: string;
  evidenceIds: string[];
}

export function recoveryBodyFrom(form: RecoveryForm): FormResult<Partial<RecoveryRecord>> {
  const errors: Record<string, string> = {};
  if (!form.at) errors.at = 'When was the vehicle recovered?';
  if (!form.fromLocation.trim()) errors.fromLocation = 'From where?';
  if (!form.toLocation.trim()) errors.toLocation = 'To where?';
  const miles = Number(form.loadedMiles);
  if (form.loadedMiles.trim() === '' || !Number.isFinite(miles) || miles < 0) errors.loadedMiles = 'Loaded miles (0 or more)';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, body: { at: form.at, fromLocation: form.fromLocation.trim(), toLocation: form.toLocation.trim(), loadedMiles: miles, evidenceIds: form.evidenceIds } };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "1 Sep 10:00" (Europe/London); with `time: false` just "1 Sep". */
export function londonShort(iso: string | undefined, time = true): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  ) as Record<string, string>;
  const date = `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1] ?? ''}`;
  return time ? `${date} ${parts.hour}:${parts.minute}` : date;
}

/** "Started 1 Sep 10:00 · recorded 5 Oct by Courtesy Cars" for a hire entered more than 24 hours after it started. */
export function enteredLateText(h: { startAt: string; recordedAt?: string; recordedByName?: string; recordedBy?: string }): string {
  const who = h.recordedByName ?? h.recordedBy;
  return `Started ${londonShort(h.startAt)} · recorded ${londonShort(h.recordedAt, false)}${who ? ` by ${who}` : ''}`;
}
