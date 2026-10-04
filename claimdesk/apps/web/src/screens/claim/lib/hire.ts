/**
 * Hire / storage / recovery presentation helpers (pure). Charges use the domain's pure calculators
 * (calculateHire, storageCharge, recoveryCharge) so the card figures match the invoice templates; the ledger
 * remains the figure that is claimed. GTA end triggers are a benchmark for a non-subscriber (GTA 2.7(j)).
 */
import {
  calculateHire,
  recoveryCharge,
  storageCharge,
  type HireAgreement,
  type HireCalculation,
  type HireEndTrigger,
  type ISODateTime,
  type RecoveryCharge,
  type RecoveryRecord,
  type StorageCharge,
  type StorageRecord
} from '@ccguk/domain';
import type { FormResult } from './chronology';

export const GTA_BENCHMARK_NOTE = 'industry benchmark (CCGUK is not a GTA subscriber; GTA 2.7(j))';

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
  { value: 'report_issued', label: "Engineer's report issued", basis: 'Insurers commonly cap storage at report + 48 hours (live File 2); send collect-or-pay on report day' },
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

export function hireRunning(h: Pick<HireAgreement, 'endAt'>): boolean {
  return !h.endAt;
}

/** Indicative hire totals for the card; a running hire is costed to `asOf`. Undefined when the domain refuses the input. */
export function hireTotals(h: HireAgreement, asOf: ISODateTime): HireCalculation | undefined {
  try {
    return calculateHire(h, h.endAt ?? asOf);
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
    { key: 'signed', label: 'Agreement signed', basis: 'Signature date must not pre-date creation; duplicate dates on one file are flagged (lesson b)', at: h.signedAt, ok: Boolean(h.signedAt) },
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

export function endHireBodyFrom(form: EndHireForm, hire: Pick<HireAgreement, 'startAt'>, nowIso: ISODateTime): FormResult<EndHireBody> {
  const errors: Record<string, string> = {};
  if (!form.endTrigger) errors.endTrigger = 'Choose what ended the hire — the trigger is the period defence';
  if (!form.endAt) errors.endAt = 'Enter when the hire ended';
  else if (Date.parse(form.endAt) < Date.parse(hire.startAt)) errors.endAt = 'The end cannot be before the start';
  else if (Date.parse(form.endAt) > Date.parse(nowIso) + 5 * 60_000) errors.endAt = 'The end cannot be in the future';
  if (form.endTrigger === 'manual' && form.reason.trim().length < 3) errors.reason = 'Give the reason';
  const odo = form.odometerIn.trim() === '' ? undefined : Number(form.odometerIn);
  if (odo !== undefined && (!Number.isInteger(odo) || odo < 0)) errors.odometerIn = 'Whole miles';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      endTrigger: form.endTrigger as HireEndTrigger,
      endAt: form.endAt,
      collectedAt: form.collectedAt || undefined,
      odometerIn: odo,
      reason: form.reason.trim() || undefined
    }
  };
}

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
