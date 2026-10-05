/**
 * Invoices — the four accounts that make up a payment pack (GTA 6.1–6.3 as industry practice):
 *
 *   invoice.hire            Credit hire charges under a numbered hire agreement
 *   invoice.storage         Storage of the damaged vehicle, with the collect-or-pay chronology
 *   invoice.recovery        Recovery: call-out + loaded miles + administration
 *   invoice.engineer_fee    Engineer's fee note: instruction, inspection and report dates and the work done
 *
 * Every invoice carries the full company details block alongside the logo (BLUEPRINT §9), the invoice number
 * and tax point in the reference block, a payee block built from `settings.bank` (the account name is the exact
 * registered name so Confirmation of Payee returns a full match — BLUEPRINT §7 item 7), the VAT position
 * (rate from the data; "VAT not applicable" when the company has no VAT number) and a net / VAT / gross summary.
 *
 * Every figure is supplied by the API from the ledger. The template prints it through format.ts and never adds,
 * multiplies or retypes an amount. Templates never read the clock: the invoice date and tax point come from data.
 *
 * Before anything is printed the figures are reconciled (`assertInvoiceArithmetic`): the charge lines must add to the
 * net total, net + VAT must equal the gross, each quantity × rate must equal the line amount the ledger holds, and
 * "VAT not applicable" can never sit beside a VAT charge. A mismatch throws InvoiceConsistencyError — an invoice that
 * contradicts itself (BLUEPRINT §3.7, live File 1: £1,287 stated against £1,112 received) is never generated.
 * Day counts are likewise never computed here: the period prints as two dates and the days charged come from the ledger.
 */
import type { ISODate, ISODateTime, Pence } from '@ccguk/domain';
import { brand } from '../brand.js';
import { type BaseDocumentData, type FigureRow, sampleBaseData } from '../common.js';
import {
  escapeHtml,
  formatDateLong,
  formatDateTime,
  formatGBP,
  formatMiles,
  formatNumber,
  formatPercent,
  formatRate,
  formatRegistration,
  numberedList,
  plural,
  toISODate
} from '../format.js';
import { baseLayout, callout, figuresTable, keyValueTable, type ScheduleLine, scheduleTable, subjectBlock } from '../layout.js';
import { type AnyTemplate, registerTemplate, type Template } from '../registry.js';

type DateLike = ISODate | ISODateTime;

// ---------------------------------------------------------------------------
// Shared data and pieces
// ---------------------------------------------------------------------------

/** Ledger totals for the invoice. `vatPence` is 0 when the company is not VAT registered. */
export interface InvoiceTotals {
  netPence: Pence;
  vatPence: Pence;
  grossPence: Pence;
}

/** Fields every invoice carries. The recipient is the party the account is sent to (normally the at-fault insurer). */
export interface InvoiceBaseData extends BaseDocumentData {
  invoiceNumber: string;
  /** Tax point (time of supply), from the ledger entry. */
  taxPointDate: DateLike;
  /** Payment due date, from the ledger / terms. Omit for "payable on receipt". */
  dueDate?: DateLike;
  /** VAT rate applied by the ledger, e.g. 0.2. Printed as "VAT at 20%" when the company is VAT registered. */
  vatRate: number;
  totals: InvoiceTotals;
  /** Reference the payer should quote. Defaults to the invoice number. */
  paymentReference?: string;
  /** Cleared funds already received against this invoice, from the ledger (re-issued or part-paid accounts). */
  receivedPence?: Pence;
  /** Balance outstanding after receipts, from the ledger. Printed only when `receivedPence` is set. */
  balancePence?: Pence;
}

const INVOICE_REQUIRED = [
  'settings.registeredOffice',
  'settings.bank.accountName',
  'settings.bank.sortCode',
  'settings.bank.accountNumber',
  'settings.bank.bankName',
  'date',
  'claim.ourReference',
  'claim.claimantName',
  'claim.vehicleRegistration',
  'claim.accidentDate',
  'recipient.name',
  'recipient.addressLines',
  'invoiceNumber',
  'taxPointDate',
  'vatRate',
  'totals.netPence',
  'totals.vatPence',
  'totals.grossPence'
] as const;

const INVOICE_CSS = `
.doc-invoice .masthead{margin-bottom:4mm;}
.doc-invoice .doc-title{margin-bottom:3mm;}
.doc-invoice .letter-block{margin-bottom:4mm;}
.doc-invoice table.subject{margin-bottom:3mm;}
.doc-invoice table.data{margin:2mm 0 3mm;}
.doc-invoice table.kv th,.doc-invoice table.kv td{padding:1mm 2.5mm;}
.doc-invoice table.data td,.doc-invoice table.data th{padding:1.2mm 2.5mm;}
.doc-invoice h2{margin:4mm 0 1.5mm;}
.doc-invoice .callout{margin:3mm 0;padding:2.5mm 4mm;}
.doc-invoice p{margin-bottom:2mm;}
.basis{font-size:9.5pt;}
.payee .kv{margin:1mm 0 2mm;}
.payee p{margin:0;}
`;

/** True when the company holds a VAT number: VAT is then charged at `vatRate`; otherwise the invoice says so. */
export function isVatRegistered(d: Pick<InvoiceBaseData, 'settings'>): boolean {
  return Boolean(d.settings.vatNumber && d.settings.vatNumber.trim() !== '');
}

/**
 * Thrown when the figures supplied for an invoice contradict each other. An invoice must never print a line table
 * whose lines do not add to its net total, a gross that is not net + VAT, or "VAT not applicable" beside a VAT
 * charge — those are ledger or assembly bugs, not drafting points for the approver to clear.
 */
export class InvoiceConsistencyError extends Error {
  readonly templateId: string;
  readonly problems: string[];
  constructor(templateId: string, problems: string[]) {
    super(`Template ${templateId}: invoice figures do not reconcile — ${problems.join('; ')}`);
    this.name = 'InvoiceConsistencyError';
    this.templateId = templateId;
    this.problems = problems;
  }
}

/**
 * A quantity × rate the ledger says equals `amountPence`. `capped` lines (GTA 5.4 additional-driver benchmark cap) may be
 * below the product but never above it.
 */
export interface InvoiceProduct {
  label: string;
  quantity: number;
  ratePence: Pence;
  amountPence: Pence;
  capped?: boolean;
}

/** Every reconciliation an invoice's figures must satisfy before it is printed (integer pence, no rounding). */
export function invoiceArithmeticProblems(d: InvoiceBaseData, lineNetPence: ReadonlyArray<Pence>, products: ReadonlyArray<InvoiceProduct> = []): string[] {
  const problems: string[] = [];
  const t = d.totals;
  for (const key of ['netPence', 'vatPence', 'grossPence'] as const) {
    if (!Number.isInteger(t[key])) problems.push(`totals.${key} is not integer pence (${String(t[key])})`);
  }
  for (const p of products) {
    const expected = Math.round(p.quantity * p.ratePence);
    if (p.capped ? p.amountPence > expected : p.amountPence !== expected) {
      problems.push(
        `${p.label}: ${formatNumber(p.quantity)} × ${formatGBP(p.ratePence)} is ${formatGBP(expected)} but the ledger amount is ${formatGBP(p.amountPence)}${
          p.capped ? ' (a capped line may be below the product, never above it)' : ''
        }`
      );
    }
  }
  const linesTotal = lineNetPence.reduce((a, b) => a + b, 0);
  if (linesTotal !== t.netPence) {
    problems.push(`the charge lines total ${formatGBP(linesTotal)} but totals.netPence is ${formatGBP(t.netPence)}`);
  }
  if (t.netPence + t.vatPence !== t.grossPence) {
    problems.push(`totals.grossPence ${formatGBP(t.grossPence)} is not net ${formatGBP(t.netPence)} + VAT ${formatGBP(t.vatPence)}`);
  }
  if (!isVatRegistered(d) && t.vatPence !== 0) {
    problems.push(`totals.vatPence is ${formatGBP(t.vatPence)} but settings.vatNumber is empty (the invoice would say "VAT not applicable")`);
  }
  // The balance never goes below £0.00: receipts above this invoice's total (an interim invoice, or a hire corrected
  // shorter after payment) are printed as their own line, never netted into a negative balance.
  if (d.receivedPence !== undefined && d.balancePence !== undefined && Math.max(0, t.grossPence - d.receivedPence) !== d.balancePence) {
    problems.push(`balancePence ${formatGBP(d.balancePence)} is not gross ${formatGBP(t.grossPence)} − received ${formatGBP(d.receivedPence)} (never below £0.00)`);
  }
  return problems;
}

export function assertInvoiceArithmetic(
  templateId: string,
  d: InvoiceBaseData,
  lineNetPence: ReadonlyArray<Pence>,
  products: ReadonlyArray<InvoiceProduct> = []
): void {
  const problems = invoiceArithmeticProblems(d, lineNetPence, products);
  if (problems.length > 0) throw new InvoiceConsistencyError(templateId, problems);
}

/** Net / VAT (or "VAT not applicable") / total due, from the ledger totals. */
export function invoiceTotalsTable(d: InvoiceBaseData): string {
  const rows: FigureRow[] = [{ label: 'Net total', valuePence: d.totals.netPence }];
  if (isVatRegistered(d)) {
    rows.push({ label: `VAT at ${formatPercent(d.vatRate)}`, valuePence: d.totals.vatPence, note: `VAT number ${d.settings.vatNumber ?? ''}` });
  } else {
    rows.push({
      label: 'VAT not applicable',
      valuePence: d.totals.vatPence,
      note: `${brand.company.registeredName} is not registered for VAT. No VAT is charged on this invoice.`
    });
  }
  rows.push({ label: 'Total due', valuePence: d.totals.grossPence, emphasis: true });
  if (d.receivedPence !== undefined) {
    rows.push({ label: 'Received to date', valuePence: -d.receivedPence });
    rows.push({ label: 'Balance outstanding', valuePence: d.balancePence ?? Math.max(0, d.totals.grossPence - d.receivedPence), emphasis: true });
    if (d.receivedPence > d.totals.grossPence) rows.push({ label: 'Received in excess of this invoice', valuePence: d.receivedPence - d.totals.grossPence });
  }
  return `<div class="avoid-break">${figuresTable(rows, { caption: 'Summary' })}</div>`;
}

/**
 * The charges table, kept on one page: an invoice's line table is short and must never split its header from its rows.
 * Reconciles the lines to the ledger totals first (InvoiceConsistencyError): the net total printed under the lines is
 * the ledger's figure, so the two must agree.
 */
function chargesTable(templateId: string, d: InvoiceBaseData, lines: ScheduleLine[], products: ReadonlyArray<InvoiceProduct> = [], caption = 'Charges'): string {
  assertInvoiceArithmetic(
    templateId,
    d,
    lines.map((l) => l.netPence),
    products
  );
  return `<div class="avoid-break">${scheduleTable(lines, { caption, showVat: false, totals: { netPence: d.totals.netPence }, totalLabel: 'Net total' })}</div>`;
}

/** Payee block from settings.bank. The account name is the exact registered name (Confirmation of Payee). */
export function payeeBlock(d: InvoiceBaseData): string {
  const b = d.settings.bank;
  const terms = d.dueDate ? `Payment is due by ${escapeHtml(formatDateLong(d.dueDate))}.` : 'Payment is due on receipt.';
  const table = keyValueTable([
    { label: 'Account name', value: b.accountName },
    { label: 'Sort code', value: b.sortCode },
    { label: 'Account number', value: b.accountNumber },
    { label: 'Bank', value: b.bankName },
    { label: 'Payment reference', value: d.paymentReference ?? d.invoiceNumber }
  ]);
  return `<div class="payee">${callout(
    `${table}<p>${terms} Pay by bank transfer to the account above. The account is held in the exact registered name “${escapeHtml(
      b.accountName
    )}”; enter that name in full for Confirmation of Payee. These are our only payment details and we never change them by email. Queries: ${escapeHtml(
      brand.company.claimsEmail
    )}, quoting the invoice number.</p>`,
    'Payment details'
  )}</div>`;
}

interface InvoiceFrameOptions {
  title: string;
  subtitle?: string;
  meta?: Array<{ label: string; value: string }>;
  bodyHtml: string;
}

/** Common frame: company block alongside the logo, invoice number and tax point in the reference block. */
function invoiceLayout(d: InvoiceBaseData, opts: InvoiceFrameOptions): string {
  const meta: Array<{ label: string; value: string }> = [
    { label: 'Invoice number', value: d.invoiceNumber },
    { label: 'Tax point', value: formatDateLong(d.taxPointDate) }
  ];
  if (d.dueDate) meta.push({ label: 'Payment due', value: formatDateLong(d.dueDate) });
  meta.push(...(opts.meta ?? []));
  return baseLayout({
    title: opts.title,
    subtitle: opts.subtitle,
    kind: 'invoice',
    reference: d.claim.ourReference,
    theirReference: d.claim.theirReference,
    date: d.date,
    recipient: d.recipient,
    settings: d.settings,
    showCompanyBlock: true,
    meta,
    bodyHtml: opts.bodyHtml,
    extraCss: INVOICE_CSS
  });
}

/** The claim facts table that opens every account: who the claimant is and which accident the charge arises from. */
function claimTable(d: InvoiceBaseData): string {
  return subjectBlock(d.claim, { claimantLabel: 'Claimant' });
}

function sampleInvoiceBase(overrides: Partial<InvoiceBaseData> & { invoiceNumber: string; totals: InvoiceTotals }): InvoiceBaseData {
  return {
    ...sampleBaseData({ date: '2026-09-03' }),
    taxPointDate: '2026-09-02',
    dueDate: '2026-10-03',
    vatRate: 0.2,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// invoice.hire
// ---------------------------------------------------------------------------

export interface HireInvoiceData extends InvoiceBaseData {
  agreement: {
    agreementNumber: string;
    /** When the hirer signed the agreement. */
    signedAt?: DateLike;
  };
  vehicle: {
    registration: string;
    make: string;
    model: string;
    variant?: string;
    /** GTA group of the vehicle supplied — printed as an industry benchmark (CCGUK is not a subscriber). */
    gtaGroup: string;
  };
  hire: {
    startAt: DateLike;
    endAt: DateLike;
    /** Days charged, from the ledger: each 24-hour period or part of one. */
    days: number;
    dailyRatePence: Pence;
    /** Days × daily rate, from the ledger. */
    hirePence: Pence;
    /** Why hire ended, e.g. "Repair completed and the claimant's vehicle returned on 2 September 2026." */
    endReason?: string;
    /** Additional or non-standard driver charge, when one applies (GTA 5.4 is the industry benchmark: £5.50/day capped at £110). */
    additionalDriver?: {
      name?: string;
      nonStandardRisk?: boolean;
      days: number;
      dailyRatePence: Pence;
      amountPence: Pence;
      /** True when the ledger applied the benchmark cap. */
      capApplied?: boolean;
    };
    /** Excess reduction / collision damage waiver taken by the hirer. */
    excessWaiver?: {
      excessPence: Pence;
      reducedExcessPence?: Pence;
      days: number;
      dailyRatePence: Pence;
      amountPence: Pence;
    };
    /** Any other agreed charge (delivery, collection, fuel) — description and amount from the ledger. */
    otherLines?: Array<{ description: string; detail?: string; amountPence: Pence }>;
  };
}

export const hireInvoiceTemplate: Template<HireInvoiceData> = {
  id: 'invoice.hire',
  version: '1.0.0',
  kind: 'invoice',
  title: 'Hire invoice',
  recipientRole: 'at_fault_insurer',
  description: 'Credit hire charges under a numbered agreement: vehicle, GTA group (benchmark), period, days, rate, extras, net/VAT/gross and the basis of charge.',
  requiredData: [
    ...INVOICE_REQUIRED,
    'agreement.agreementNumber',
    'vehicle.registration',
    'vehicle.make',
    'vehicle.model',
    'vehicle.gtaGroup',
    'hire.startAt',
    'hire.endAt',
    'hire.days',
    'hire.dailyRatePence',
    'hire.hirePence'
  ],
  titleFor: (d) => `Hire invoice ${d.invoiceNumber}`,
  sample: () => ({
    ...sampleInvoiceBase({ invoiceNumber: 'INV-H-0042', totals: { netPence: 119520, vatPence: 0, grossPence: 119520 } }),
    agreement: { agreementNumber: 'HA-2026-0042', signedAt: '2026-08-10' },
    vehicle: { registration: 'CC26HIR', make: 'Volkswagen', model: 'Golf', variant: '1.5 TSI Life', gtaGroup: 'M' },
    hire: {
      startAt: '2026-08-10T09:30:00+01:00',
      endAt: '2026-09-02T11:00:00+01:00',
      days: 24,
      dailyRatePence: 4980,
      hirePence: 119520,
      endReason: 'Repair of the claimant’s vehicle was completed on 2 September 2026 and the hire vehicle was returned the same day.'
    }
  }),
  render: (d) => {
    const vehicleName = [d.vehicle.make, d.vehicle.model, d.vehicle.variant].filter(Boolean).join(' ');
    const lines: ScheduleLine[] = [
      {
        description: `Hire of ${vehicleName}, registration ${formatRegistration(d.vehicle.registration)}`,
        detail: `${formatDateLong(d.hire.startAt)} to ${formatDateLong(d.hire.endAt)} · GTA group ${d.vehicle.gtaGroup} (industry benchmark)`,
        quantity: plural(d.hire.days, 'day'),
        ratePence: d.hire.dailyRatePence,
        netPence: d.hire.hirePence
      }
    ];
    const products: InvoiceProduct[] = [{ label: 'Hire', quantity: d.hire.days, ratePence: d.hire.dailyRatePence, amountPence: d.hire.hirePence }];
    const ad = d.hire.additionalDriver;
    if (ad) {
      products.push({ label: 'Additional driver', quantity: ad.days, ratePence: ad.dailyRatePence, amountPence: ad.amountPence, capped: ad.capApplied === true });
      const detailParts = [ad.name ? `Driver: ${ad.name}` : '', ad.capApplied ? 'Charged at the capped amount' : ''].filter(Boolean);
      lines.push({
        description: ad.nonStandardRisk ? 'Additional driver (non-standard risk)' : 'Additional driver',
        detail: detailParts.length > 0 ? detailParts.join(' · ') : undefined,
        quantity: plural(ad.days, 'day'),
        ratePence: ad.dailyRatePence,
        netPence: ad.amountPence
      });
    }
    const ew = d.hire.excessWaiver;
    if (ew) {
      products.push({ label: 'Excess reduction', quantity: ew.days, ratePence: ew.dailyRatePence, amountPence: ew.amountPence });
      lines.push({
        description: 'Excess reduction (collision damage waiver)',
        detail:
          ew.reducedExcessPence !== undefined
            ? `Reduces the hirer’s excess from ${formatGBP(ew.excessPence)} to ${formatGBP(ew.reducedExcessPence)}`
            : `Hirer’s excess under the agreement: ${formatGBP(ew.excessPence)}`,
        quantity: plural(ew.days, 'day'),
        ratePence: ew.dailyRatePence,
        netPence: ew.amountPence
      });
    }
    for (const o of d.hire.otherLines ?? []) lines.push({ description: o.description, detail: o.detail, netPence: o.amountPence });

    const particulars = keyValueTable(
      [
        { label: 'Hirer', value: d.claim.claimantName },
        { label: 'Hire agreement', value: `${d.agreement.agreementNumber}${d.agreement.signedAt ? `, signed ${formatDateLong(d.agreement.signedAt)}` : ''}` },
        { label: 'Vehicle supplied', value: `${vehicleName}, ${formatRegistration(d.vehicle.registration)}` },
        { label: 'GTA group', value: `${d.vehicle.gtaGroup} (industry benchmark; CCGUK is not a GTA subscriber)` },
        { label: 'Hire started', value: formatDateTime(d.hire.startAt) },
        { label: 'Hire ended', value: formatDateTime(d.hire.endAt) },
        { label: 'Days charged', value: `${plural(d.hire.days, 'day')} — each 24-hour period, or part of one, from the start of hire counts as one day` },
        { label: 'Daily rate', value: `${formatRate(d.hire.dailyRatePence, 'day')} excluding VAT` }
      ],
      'Hire particulars'
    );

    const body = `
${claimTable(d)}
${particulars}
${chargesTable('invoice.hire', d, lines, products)}
${invoiceTotalsTable(d)}
${callout(
  `<p>The vehicle was supplied to ${escapeHtml(d.claim.claimantName)} on credit terms under hire agreement ${escapeHtml(
    d.agreement.agreementNumber
  )}. The hirer is liable for these charges under that agreement; payment is deferred under its credit terms while the claim against the party at fault is pursued. The charges are claimed from you as the insurer of the party at fault, as part of the hirer’s loss arising from the accident on ${escapeHtml(
    formatDateLong(d.claim.accidentDate)
  )}.</p>${d.hire.endReason ? `<p>${escapeHtml(d.hire.endReason)}</p>` : ''}`,
  'Basis of charge'
)}
${payeeBlock(d)}`;
    return invoiceLayout(d, {
      title: 'Hire invoice',
      subtitle: 'Credit hire charges',
      meta: [{ label: 'Agreement', value: d.agreement.agreementNumber }],
      bodyHtml: body
    });
  }
};

// ---------------------------------------------------------------------------
// invoice.storage
// ---------------------------------------------------------------------------

export interface StorageInvoiceData extends InvoiceBaseData {
  storage: {
    /** The yard, as it should print. */
    location: string;
    addressLines?: string[];
    startAt: DateLike;
    endAt: DateLike;
    /** Days charged, from the ledger (inclusive calendar days). */
    days: number;
    dailyRatePence: Pence;
    /** Days × daily rate, from the ledger. */
    amountPence: Pence;
    /** Why storage ended: "Vehicle collected by your salvage agent", "Released to repairer". */
    endReason?: string;
  };
  /** The engineer's report date, when one was issued while the vehicle was in storage. */
  reportIssuedAt?: DateLike;
  /** When that report was sent to the insurer, from the document record. Only then does the chronology say so. */
  reportSentToInsurerAt?: DateLike;
  /** When the collect-or-pay notice was sent to the insurer (the 48-hour chronology that answers a report+48h cap). */
  collectOrPayNoticeSentAt?: DateLike;
  /** The 48-hour collection deadline given in that notice, from the clocks engine. */
  collectByAt?: DateLike;
}

export const storageInvoiceTemplate: Template<StorageInvoiceData> = {
  id: 'invoice.storage',
  version: '1.0.0',
  kind: 'invoice',
  title: 'Storage invoice',
  recipientRole: 'at_fault_insurer',
  description: 'Storage of the damaged vehicle: location, period, days, daily rate, net/VAT/gross, with the collect-or-pay notice date when one was sent.',
  requiredData: [...INVOICE_REQUIRED, 'storage.location', 'storage.startAt', 'storage.endAt', 'storage.days', 'storage.dailyRatePence', 'storage.amountPence'],
  titleFor: (d) => `Storage invoice ${d.invoiceNumber}`,
  sample: () => ({
    ...sampleInvoiceBase({
      date: '2026-08-17',
      taxPointDate: '2026-08-16',
      dueDate: '2026-09-16',
      invoiceNumber: 'INV-S-0042',
      totals: { netPence: 36000, vatPence: 0, grossPence: 36000 }
    }),
    storage: {
      location: 'Example Yard',
      addressLines: ['Unit 1, Example Industrial Estate', 'Example Town', 'EX2 2BB'],
      startAt: '2026-08-09T16:40:00+01:00',
      endAt: '2026-08-16',
      days: 8,
      dailyRatePence: 4500,
      amountPence: 36000,
      endReason: 'Vehicle collected from the yard by your appointed salvage agent on 16 August 2026.'
    },
    reportIssuedAt: '2026-08-14',
    reportSentToInsurerAt: '2026-08-14',
    collectOrPayNoticeSentAt: '2026-08-14',
    collectByAt: '2026-08-16T17:00:00+01:00'
  }),
  render: (d) => {
    const s = d.storage;
    const lines: ScheduleLine[] = [
      {
        description: `Storage of ${formatRegistration(d.claim.vehicleRegistration)}${d.claim.vehicleDescription ? `, ${d.claim.vehicleDescription}` : ''} at ${s.location}`,
        detail: `${formatDateLong(s.startAt)} to ${formatDateLong(s.endAt)}`,
        quantity: plural(s.days, 'day'),
        ratePence: s.dailyRatePence,
        netPence: s.amountPence
      }
    ];
    const rows: Array<{ label: string; value: string }> = [
      { label: 'Location', value: [s.location, ...(s.addressLines ?? [])].filter((l) => l && l.trim() !== '').join(', ') },
      { label: 'Storage from', value: formatDateTime(s.startAt) },
      { label: 'Storage to', value: formatDateTime(s.endAt) },
      { label: 'Days charged', value: `${plural(s.days, 'day')} — each calendar day, or part of one, counts as one day` },
      { label: 'Daily rate', value: `${formatRate(s.dailyRatePence, 'day')} excluding VAT` }
    ];
    if (d.reportIssuedAt) rows.push({ label: 'Engineer’s report issued', value: formatDateLong(d.reportIssuedAt) });
    if (d.collectOrPayNoticeSentAt) {
      rows.push({
        label: 'Collect-or-pay notice sent to you',
        value: `${formatDateLong(d.collectOrPayNoticeSentAt)}${d.collectByAt ? `; collection or authority to dispose requested by ${formatDateTime(d.collectByAt)}` : ''}`
      });
    }
    if (s.endReason) rows.push({ label: 'Storage ended', value: s.endReason });

    const sameDay = toISODate(s.startAt) === toISODate(d.claim.accidentDate);
    const chronology: string[] = [
      sameDay
        ? `The vehicle was taken into storage at ${s.location} on ${formatDateLong(s.startAt)}, the day of the accident.`
        : `The vehicle was taken into storage at ${s.location} on ${formatDateLong(s.startAt)} following the accident on ${formatDateLong(d.claim.accidentDate)}.`
    ];
    if (d.reportIssuedAt) {
      chronology.push(
        `The engineer’s report was issued on ${formatDateLong(d.reportIssuedAt)}${d.reportSentToInsurerAt ? ` and sent to you on ${formatDateLong(d.reportSentToInsurerAt)}` : ''}.`
      );
    }
    if (d.collectOrPayNoticeSentAt) {
      chronology.push(
        `On ${formatDateLong(d.collectOrPayNoticeSentAt)} we gave you written notice to collect the vehicle or authorise its disposal${
          d.collectByAt ? ` by ${formatDateTime(d.collectByAt)}` : ''
        }. Storage after that notice continued at your election and is attributable to you.`
      );
    }
    chronology.push(`Storage ended on ${formatDateLong(s.endAt)}.`);

    const body = `
${claimTable(d)}
${keyValueTable(rows, 'Storage particulars')}
${chargesTable('invoice.storage', d, lines, [{ label: 'Storage', quantity: s.days, ratePence: s.dailyRatePence, amountPence: s.amountPence }])}
${invoiceTotalsTable(d)}
${callout(
  `<p>Storage was supplied to ${escapeHtml(
    d.claim.claimantName
  )} on credit terms. The charge is claimed from you as the insurer of the party at fault, as part of the claimant’s loss arising from the accident.</p>${numberedList(chronology)}`,
  'Basis of charge and chronology'
)}
${payeeBlock(d)}`;
    return invoiceLayout(d, { title: 'Storage invoice', subtitle: 'Storage of the damaged vehicle', bodyHtml: body });
  }
};

// ---------------------------------------------------------------------------
// invoice.recovery
// ---------------------------------------------------------------------------

export interface RecoveryInvoiceData extends InvoiceBaseData {
  recovery: {
    at: DateLike;
    fromLocation: string;
    toLocation: string;
    calloutPence: Pence;
    loadedMiles: number;
    perLoadedMilePence: Pence;
    /** loadedMiles × perLoadedMilePence, from the ledger. */
    mileagePence: Pence;
    adminPence: Pence;
    /** Why recovery was needed: "Unroadworthy — nearside front wheel displaced; headlamp inoperative." */
    vehicleCondition?: string;
    /** Recovery operator, if not CCGUK's own truck. */
    operator?: string;
  };
}

export const recoveryInvoiceTemplate: Template<RecoveryInvoiceData> = {
  id: 'invoice.recovery',
  version: '1.0.0',
  kind: 'invoice',
  title: 'Recovery invoice',
  recipientRole: 'at_fault_insurer',
  description: 'Recovery of the damaged vehicle: date, from → to, call-out, loaded miles at the per-mile rate, administration, net/VAT/gross.',
  requiredData: [
    ...INVOICE_REQUIRED,
    'recovery.at',
    'recovery.fromLocation',
    'recovery.toLocation',
    'recovery.calloutPence',
    'recovery.loadedMiles',
    'recovery.perLoadedMilePence',
    'recovery.mileagePence',
    'recovery.adminPence'
  ],
  titleFor: (d) => `Recovery invoice ${d.invoiceNumber}`,
  sample: () => ({
    ...sampleInvoiceBase({
      date: '2026-08-10',
      taxPointDate: '2026-08-09',
      dueDate: '2026-09-09',
      invoiceNumber: 'INV-R-0042',
      totals: { netPence: 20800, vatPence: 0, grossPence: 20800 }
    }),
    recovery: {
      at: '2026-08-09T16:10:00+01:00',
      fromLocation: 'Junction of High Street and Station Road, Example Town',
      toLocation: 'Example Yard, Unit 1, Example Industrial Estate, Example Town, EX2 2BB',
      calloutPence: 9000,
      loadedMiles: 31,
      perLoadedMilePence: 300,
      mileagePence: 9300,
      adminPence: 2500,
      vehicleCondition: 'Unroadworthy: nearside front wheel displaced and nearside headlamp inoperative. The vehicle could not be driven.'
    }
  }),
  render: (d) => {
    const r = d.recovery;
    const lines: ScheduleLine[] = [
      { description: 'Recovery call-out', detail: `${formatDateTime(r.at)} — attendance and loading at ${r.fromLocation}`, quantity: '1', ratePence: r.calloutPence, netPence: r.calloutPence },
      {
        description: 'Loaded mileage',
        detail: `${formatRate(r.perLoadedMilePence, 'loaded mile')} from ${r.fromLocation} to ${r.toLocation}`,
        quantity: formatMiles(r.loadedMiles),
        ratePence: r.perLoadedMilePence,
        netPence: r.mileagePence
      },
      { description: 'Administration', detail: 'Booking, recovery paperwork and condition photographs', quantity: '1', ratePence: r.adminPence, netPence: r.adminPence }
    ];
    const rows: Array<{ label: string; value: string }> = [
      { label: 'Vehicle recovered', value: `${formatRegistration(d.claim.vehicleRegistration)}${d.claim.vehicleDescription ? `, ${d.claim.vehicleDescription}` : ''}` },
      { label: 'Date and time', value: formatDateTime(r.at) },
      { label: 'From', value: r.fromLocation },
      { label: 'To', value: r.toLocation },
      { label: 'Loaded miles', value: formatMiles(r.loadedMiles) }
    ];
    if (r.vehicleCondition) rows.push({ label: 'Condition at the scene', value: r.vehicleCondition });
    if (r.operator) rows.push({ label: 'Recovery operator', value: r.operator });

    const body = `
${claimTable(d)}
${keyValueTable(rows, 'Recovery particulars')}
${chargesTable('invoice.recovery', d, lines, [{ label: 'Loaded mileage', quantity: r.loadedMiles, ratePence: r.perLoadedMilePence, amountPence: r.mileagePence }])}
${invoiceTotalsTable(d)}
${callout(
  `<p>The vehicle was recovered on ${escapeHtml(formatDateLong(r.at))} from ${escapeHtml(r.fromLocation)} to ${escapeHtml(r.toLocation)}, following the accident on ${escapeHtml(
    formatDateLong(d.claim.accidentDate)
  )}.${r.vehicleCondition ? ' Its condition on collection is recorded above.' : ''} The charge is made up of the call-out, the loaded mileage at ${escapeHtml(
    formatRate(r.perLoadedMilePence, 'mile')
  )} and an administration charge, as shown. It is claimed from you as the insurer of the party at fault, as part of the claimant’s loss arising from the accident.</p>`,
  'Basis of charge'
)}
${payeeBlock(d)}`;
    return invoiceLayout(d, { title: 'Recovery invoice', subtitle: 'Recovery of the damaged vehicle', bodyHtml: body });
  }
};

// ---------------------------------------------------------------------------
// invoice.engineer_fee
// ---------------------------------------------------------------------------

export interface EngineerFeeInvoiceData extends InvoiceBaseData {
  engineer: {
    name: string;
    /** "IMI Accredited Vehicle Damage Assessor; IAEA member". */
    qualifications: string;
    /** Company the engineer practises through, if not CCGUK. */
    company?: string;
  };
  instruction: {
    instructedAt: DateLike;
    /** Who instructed the engineer: normally "Courtesy Cars Group UK Ltd on behalf of the claimant". */
    instructedBy: string;
    /** What the engineer was asked to do, in one or two sentences. */
    purpose: string;
  };
  inspection: {
    basis: 'physical' | 'desktop';
    at?: DateLike;
    place?: string;
  };
  report: {
    issuedAt: DateLike;
    reference?: string;
    /** One line: "Repairable; unroadworthy; estimate £1,973.50 net; 8 working days." */
    outcome?: string;
  };
  /** The work done, as a list — this answers a "fee not recoverable" refusal line by line. */
  workDone: string[];
  feePence: Pence;
  /** When the report was prepared for use in proceedings (CPR 35 / PD 35 content included). */
  forCourt: boolean;
  /** Small-claims cap on recoverable expert fees (PD 27A para 7.3(2)), supplied from the knowledge base with its verification. */
  court?: {
    smallClaimsExpertFeeCapPence?: Pence;
  };
}

export const engineerFeeInvoiceTemplate: Template<EngineerFeeInvoiceData> = {
  id: 'invoice.engineer_fee',
  version: '1.0.0',
  kind: 'invoice',
  title: 'Engineer’s fee note',
  recipientRole: 'at_fault_insurer',
  description: 'Fee note for the engineer’s inspection and report: instruction, inspection and report dates, the work done, the engineer’s qualifications, and a CPR 35 note when prepared for court.',
  requiredData: [
    ...INVOICE_REQUIRED,
    'engineer.name',
    'engineer.qualifications',
    'instruction.instructedAt',
    'instruction.instructedBy',
    'instruction.purpose',
    'inspection.basis',
    'report.issuedAt',
    'workDone',
    'feePence',
    'forCourt'
  ],
  titleFor: (d) => `Engineer’s fee note ${d.invoiceNumber}`,
  sample: () => ({
    ...sampleInvoiceBase({
      date: '2026-08-14',
      taxPointDate: '2026-08-14',
      dueDate: '2026-09-13',
      invoiceNumber: 'INV-E-0042',
      totals: { netPence: 28500, vatPence: 0, grossPence: 28500 }
    }),
    engineer: { name: 'Mr Sam Example', qualifications: 'IMI Accredited Vehicle Damage Assessor; Member, Institute of Automotive Engineer Assessors' },
    instruction: {
      instructedAt: '2026-08-10',
      instructedBy: 'Courtesy Cars Group UK Ltd on behalf of the claimant',
      purpose:
        'To inspect the claimant’s vehicle, record the accident damage, prepare a repair estimate, state whether the vehicle is roadworthy and whether it is economic to repair, and report.'
    },
    inspection: { basis: 'physical', at: '2026-08-12T10:30:00+01:00', place: 'Example Yard, Example Town' },
    report: { issuedAt: '2026-08-14', reference: 'ER-2026-0042', outcome: 'Repairable. Unroadworthy pending repair. Estimated repair duration eight working days.' },
    workDone: [
      'Instruction received and the claimant’s account, photographs and vehicle records reviewed (10 August 2026).',
      'Vehicle identity, VIN, odometer and MOT history checked against DVLA and DVSA records.',
      'Physical inspection at the storage yard, including 24 photographs with original hashes (12 August 2026).',
      'Damage mapped to the accident circumstances; pre-existing items separated and excluded.',
      'Repair method and itemised estimate prepared (labour, parts, paint, materials, ADAS calibration).',
      'Roadworthiness, repair duration and total-loss comparison assessed.',
      'Report written, checked and issued (14 August 2026).'
    ],
    feePence: 28500,
    forCourt: false
  }),
  render: (d) => {
    const inspectionLine =
      d.inspection.basis === 'physical'
        ? `Physical inspection${d.inspection.at ? ` on ${formatDateTime(d.inspection.at)}` : ''}${d.inspection.place ? ` at ${d.inspection.place}` : ''}`
        : `Desktop assessment from photographs and records${d.inspection.at ? `, ${formatDateTime(d.inspection.at)}` : ''}`;
    const lines: ScheduleLine[] = [
      {
        description: 'Engineer’s inspection and report',
        detail: `Instructed ${formatDateLong(d.instruction.instructedAt)}; ${inspectionLine.charAt(0).toLowerCase()}${inspectionLine.slice(1)}; report issued ${formatDateLong(
          d.report.issuedAt
        )}`,
        quantity: '1',
        ratePence: d.feePence,
        netPence: d.feePence
      }
    ];
    const rows: Array<{ label: string; value: string }> = [
      { label: 'Engineer', value: `${d.engineer.name}${d.engineer.company ? `, ${d.engineer.company}` : ''}` },
      { label: 'Qualifications', value: d.engineer.qualifications },
      { label: 'Instructed by', value: `${d.instruction.instructedBy}, ${formatDateLong(d.instruction.instructedAt)}` },
      { label: 'Instructions', value: d.instruction.purpose },
      { label: 'Inspection', value: inspectionLine },
      { label: 'Report issued', value: `${formatDateLong(d.report.issuedAt)}${d.report.reference ? ` (reference ${d.report.reference})` : ''}` }
    ];
    if (d.report.outcome) rows.push({ label: 'Outcome', value: d.report.outcome });
    rows.push({ label: 'Prepared for court', value: d.forCourt ? 'Yes — CPR Part 35 and PD 35 content included' : 'No' });

    const cap = d.court?.smallClaimsExpertFeeCapPence;
    const courtNote = d.forCourt
      ? `<p>The report was prepared for use in proceedings. It sets out the substance of the engineer’s instructions, the expert’s duty to the court (CPR 35.3), the statement of truth required by PD 35 paragraph 3.3 and the declaration in the Guidance for the Instruction of Experts in Civil Claims. If the claim is allocated to the small claims track, expert evidence may be used only with the court’s permission (CPR 27.5) and the recoverable fee for each expert is limited${
          cap !== undefined ? ` to ${escapeHtml(formatGBP(cap))}` : ''
        } by PD 27A paragraph 7.3(2). This fee is ${escapeHtml(formatGBP(d.feePence))}.</p>`
      : '';

    const body = `
${claimTable(d)}
${keyValueTable(rows, 'The engineer and the instruction')}
${chargesTable('invoice.engineer_fee', d, lines, [{ label: 'Fee', quantity: 1, ratePence: d.feePence, amountPence: d.feePence }], 'Fee')}
${invoiceTotalsTable(d)}
<h2>Work done</h2>
${d.workDone.length > 0 ? numberedList(d.workDone) : '<p>No itemised list of the work done was supplied with this fee note.</p>'}
${callout(
  `<p>The engineer was instructed on ${escapeHtml(formatDateLong(d.instruction.instructedAt))} to establish the extent of the accident damage, the method and cost of repair, and whether the vehicle was roadworthy and economic to repair. Without the report neither the repair nor the claim could be quantified. The fee is a cost incurred because of the accident on ${escapeHtml(
    formatDateLong(d.claim.accidentDate)
  )} and is claimed from you as the insurer of the party at fault. If you say the fee is not recoverable, identify which item of work above you dispute and on what basis.</p>${courtNote}`,
  'Basis of charge'
)}
${payeeBlock(d)}`;
    return invoiceLayout(d, {
      title: 'Engineer’s fee note',
      subtitle: 'Inspection and report',
      meta: d.report.reference ? [{ label: 'Report', value: d.report.reference }] : undefined,
      bodyHtml: body
    });
  }
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerTemplate(hireInvoiceTemplate);
registerTemplate(storageInvoiceTemplate);
registerTemplate(recoveryInvoiceTemplate);
registerTemplate(engineerFeeInvoiceTemplate);

/** Every template in this group, in payment-pack order (for tests and the template picker). */
export const invoiceTemplates: ReadonlyArray<AnyTemplate> = [hireInvoiceTemplate, storageInvoiceTemplate, recoveryInvoiceTemplate, engineerFeeInvoiceTemplate];
