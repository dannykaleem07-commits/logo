/**
 * GTA payment-pack rules (benchmark only — CCGUK is not a subscriber).
 *
 *  - 6.1–6.3: contents of a clean payment pack.
 *  - 6.7: insurer settles within one calendar month of a clean pack.
 *  - 6.8.6: late-payment additions of 10% (days 31–60) and 20% (day 61 on), hires from 16 March 2026.
 */
import type { ClaimBundle, GeneratedDocument, ISODate, ISODateTime, Pence } from '../types.js';
import { addCalendarDays, calendarDaysBetween, compareIso, londonDate, startOfDay } from '../calendar/index.js';

export const GTA_LATE_PAYMENT_BASIS = 'GTA 6.8.6 — benchmark only, CCGUK is not a subscriber';
export const GTA_LATE_PAYMENT_HIRES_FROM: ISODate = '2026-03-16';
export const GTA_PAYMENT_PACK_BASIS = 'GTA 6.1–6.3 (benchmark only, CCGUK is not a subscriber)';

export type LatePaymentTier = 'none' | '10pc_day31' | '20pc_day61';

export interface LatePaymentUplift {
  pct: 0 | 10 | 20;
  upliftPence: Pence;
  basis: string;
  benchmarkOnly: true;
  tier: LatePaymentTier;
  /** Whole London calendar days from the clean pack to `now` (pack day = 0). */
  daysSincePack: number;
  /** False when the hire pre-dates 16 March 2026 (additions not available even as a benchmark). */
  applicable: boolean;
  reason?: string;
  /** 00:00 London on day 31 — the first instant at which the 10% tier applies. */
  day31At: ISODateTime;
  /** 00:00 London on day 61 — the first instant at which the 20% tier applies. */
  day61At: ISODateTime;
}

/** 00:00 London on the day `days` calendar days after the pack date. Exported for the clocks engine so both agree. */
export function latePaymentTierStart(cleanPackSentAt: ISODateTime, days: number): ISODateTime {
  return startOfDay(addCalendarDays(cleanPackSentAt, days));
}

/**
 * Late-payment addition on an unpaid amount: 0% to day 30, 10% from day 31, 20% from day 61.
 * Day numbering: the day the clean pack was sent is day 0 (London calendar dates), so the 10% tier
 * starts at 00:00 London on day 31 and `day31At`/`day61At` are those midnights — `pct` and the two
 * instants can never disagree about which tier `now` is in.
 */
export function latePaymentUplift(amountPence: Pence, cleanPackSentAt: ISODateTime, now: ISODateTime, hireStartedAt: ISODateTime): LatePaymentUplift {
  const days = calendarDaysBetween(cleanPackSentAt, now);
  const day31At = latePaymentTierStart(cleanPackSentAt, 31);
  const day61At = latePaymentTierStart(cleanPackSentAt, 61);
  const base = { basis: GTA_LATE_PAYMENT_BASIS, benchmarkOnly: true as const, daysSincePack: days, day31At, day61At };

  if (londonDate(hireStartedAt) < GTA_LATE_PAYMENT_HIRES_FROM) {
    return {
      ...base,
      pct: 0,
      upliftPence: 0,
      tier: 'none',
      applicable: false,
      reason: `hire commenced ${londonDate(hireStartedAt)}, before ${GTA_LATE_PAYMENT_HIRES_FROM}: GTA 6.8.6 additions apply to hires from 16 March 2026 only`,
    };
  }
  let pct: 0 | 10 | 20 = 0;
  let tier: LatePaymentTier = 'none';
  if (days >= 61) {
    pct = 20;
    tier = '20pc_day61';
  } else if (days >= 31) {
    pct = 10;
    tier = '10pc_day31';
  }
  return { ...base, pct, upliftPence: Math.round((amountPence * pct) / 100), tier, applicable: true };
}

export type PaymentPackItem =
  | 'covering_letter'
  | 'mitigation_questionnaire'
  | 'advice_form'
  | 'hire_period_validation_form'
  | 'engineer_report'
  | 'storage_account'
  | 'recovery_account'
  | 'hire_invoice';

export const PAYMENT_PACK_ITEMS: readonly PaymentPackItem[] = [
  'covering_letter',
  'mitigation_questionnaire',
  'advice_form',
  'hire_period_validation_form',
  'engineer_report',
  'storage_account',
  'recovery_account',
  'hire_invoice',
];

export const paymentPackItemLabels: Record<PaymentPackItem, string> = {
  covering_letter: 'Covering letter',
  mitigation_questionnaire: 'Mitigation Questionnaire / Statement of Truth (GTA Appendix C)',
  advice_form: 'New Claim Advice Form',
  hire_period_validation_form: 'Hire Period Validation Form',
  engineer_report: "Engineer's report",
  storage_account: 'Storage account (invoice)',
  recovery_account: 'Recovery account (invoice)',
  hire_invoice: 'Hire account (invoice)',
};

/** Template-id prefixes that satisfy each item (`documents[].templateId`). */
export const paymentPackTemplatePrefixes: Record<PaymentPackItem, readonly string[]> = {
  covering_letter: ['pack.gta_payment', 'letter.payment_pack', 'letter.covering'],
  mitigation_questionnaire: ['form.mitigation_questionnaire', 'form.mitigation'],
  advice_form: ['letter.ncaf', 'form.ncaf', 'form.advice'],
  hire_period_validation_form: ['form.hire_period_validation', 'form.hire_period'],
  engineer_report: ['report.engineer'],
  storage_account: ['invoice.storage'],
  recovery_account: ['invoice.recovery'],
  hire_invoice: ['invoice.hire'],
};

export interface PaymentPackItemDetail {
  item: PaymentPackItem;
  label: string;
  required: boolean;
  status: 'present' | 'draft_only' | 'missing' | 'not_applicable';
  satisfiedBy: string[];
  note?: string;
}

export interface PaymentPackValidation {
  /** True when every required item is present as an approved/sent/signed document (or hard evidence). */
  complete: boolean;
  missing: PaymentPackItem[];
  present: PaymentPackItem[];
  /** Required items that exist only as draft/blocked documents. Also listed in `missing`. */
  draftOnly: PaymentPackItem[];
  notApplicable: PaymentPackItem[];
  details: PaymentPackItemDetail[];
  basis: string;
}

const FINAL_STATUSES: ReadonlySet<GeneratedDocument['status']> = new Set(['approved', 'sent', 'signed']);
const DRAFT_STATUSES: ReadonlySet<GeneratedDocument['status']> = new Set(['draft', 'blocked']);

function docsFor(bundle: ClaimBundle, item: PaymentPackItem): { final: GeneratedDocument[]; draft: GeneratedDocument[] } {
  const prefixes = paymentPackTemplatePrefixes[item];
  const matching = bundle.documents.filter((d) => prefixes.some((p) => d.templateId === p || d.templateId.startsWith(p)));
  return { final: matching.filter((d) => FINAL_STATUSES.has(d.status)), draft: matching.filter((d) => DRAFT_STATUSES.has(d.status)) };
}

/**
 * Check a claim bundle for the contents of a clean GTA payment pack. Documents count when their
 * `templateId` matches the item's prefixes; hard evidence (an uploaded engineer's report, a sent
 * NCAF event) also counts. Storage, recovery and hire accounts are required only where the
 * bundle holds such records.
 */
export function validatePaymentPack(bundle: ClaimBundle): PaymentPackValidation {
  const details: PaymentPackItemDetail[] = [];
  const docById = new Map(bundle.documents.map((d) => [d.id, d]));

  for (const item of PAYMENT_PACK_ITEMS) {
    const label = paymentPackItemLabels[item];
    let required = true;
    let note: string | undefined;
    if (item === 'storage_account' && bundle.storage.length === 0) {
      required = false;
      note = 'no storage record on the file';
    }
    if (item === 'recovery_account' && bundle.recovery.length === 0) {
      required = false;
      note = 'no recovery record on the file';
    }
    if (item === 'hire_invoice' && bundle.hire.length === 0) {
      required = false;
      note = 'no hire agreement on the file';
    }

    const { final, draft } = docsFor(bundle, item);
    const satisfiedBy: string[] = final.map((d) => `document:${d.id}`);

    // Hard-evidence fallbacks.
    if (item === 'engineer_report') {
      for (const ev of bundle.evidence) if (ev.kind === 'engineer_report') satisfiedBy.push(`evidence:${ev.id}`);
      if (bundle.report?.issuedAt && bundle.report.documentId && docById.get(bundle.report.documentId)) {
        const d = docById.get(bundle.report.documentId)!;
        if (FINAL_STATUSES.has(d.status) && !satisfiedBy.includes(`document:${d.id}`)) satisfiedBy.push(`document:${d.id}`);
      }
    }
    if (item === 'advice_form') {
      for (const e of bundle.events) if (e.type === 'ncaf_sent') satisfiedBy.push(`event:${e.id}`);
    }
    if (item === 'mitigation_questionnaire') {
      for (const h of bundle.hire) {
        const d = h.mitigationQuestionnaireDocumentId ? docById.get(h.mitigationQuestionnaireDocumentId) : undefined;
        if (d && FINAL_STATUSES.has(d.status) && !satisfiedBy.includes(`document:${d.id}`)) satisfiedBy.push(`document:${d.id}`);
      }
      for (const ev of bundle.evidence) if (/mitigation questionnaire/i.test(`${ev.description ?? ''} ${ev.filename}`)) satisfiedBy.push(`evidence:${ev.id}`);
    }
    if (item === 'hire_period_validation_form') {
      for (const ev of bundle.evidence) if (/hire period validation/i.test(`${ev.description ?? ''} ${ev.filename}`)) satisfiedBy.push(`evidence:${ev.id}`);
    }

    let status: PaymentPackItemDetail['status'];
    if (!required) status = 'not_applicable';
    else if (satisfiedBy.length > 0) status = 'present';
    else if (draft.length > 0) status = 'draft_only';
    else status = 'missing';
    if (status === 'draft_only') satisfiedBy.push(...draft.map((d) => `draft:${d.id}`));

    const detail: PaymentPackItemDetail = { item, label, required, status, satisfiedBy };
    if (note) detail.note = note;
    details.push(detail);
  }

  const present = details.filter((d) => d.status === 'present').map((d) => d.item);
  const draftOnly = details.filter((d) => d.status === 'draft_only').map((d) => d.item);
  const missing = details.filter((d) => d.status === 'missing' || d.status === 'draft_only').map((d) => d.item);
  const notApplicable = details.filter((d) => d.status === 'not_applicable').map((d) => d.item);
  return { complete: missing.length === 0, missing, present, draftOnly, notApplicable, details, basis: GTA_PAYMENT_PACK_BASIS };
}

/**
 * True when ledger `paid`/`interim_paid` entries dated on or before `asOf` cover the invoiced
 * (or, failing invoices, claimed) total net of write-offs. Used by clocks to decide whether a
 * payment pack has been settled. Salvage is a credit (retained by the claimant) and is netted off,
 * as in the schedule of loss — otherwise a total-loss file could never read as paid in full.
 */
export function ledgerPaidInFull(bundle: Pick<ClaimBundle, 'ledger'>, asOf: ISODateTime): boolean {
  const asOfDate = londonDate(asOf);
  const sum = (kinds: readonly string[], dated = false): Pence =>
    bundle.ledger
      .filter((l) => kinds.includes(l.kind) && (!dated || l.date <= asOfDate))
      .reduce((acc, l) => acc + (l.head === 'salvage' ? -1 : 1) * (l.amountPence + (l.vatPence ?? 0)), 0);
  const invoiced = sum(['invoiced']);
  const claimed = invoiced > 0 ? invoiced : sum(['claimed']);
  const writtenOff = sum(['written_off']);
  const due = claimed - writtenOff;
  if (due <= 0) return false;
  const paid = sum(['paid', 'interim_paid'], true);
  return paid >= due;
}

/** Convenience: has a payment_received event (≤ now) that is flagged in full or that the ledger shows as full. */
export function paidInFullAt(bundle: Pick<ClaimBundle, 'ledger' | 'events'>, now: ISODateTime): ISODateTime | undefined {
  const payments = bundle.events
    .filter((e) => e.type === 'payment_received' && compareIso(e.at, now) <= 0)
    .sort((a, b) => compareIso(a.at, b.at));
  for (const p of payments) {
    const d = p.data ?? {};
    if (d['inFull'] === true || d['coversPack'] === true) return p.at;
    if (ledgerPaidInFull(bundle, p.at)) return p.at;
  }
  return undefined;
}
