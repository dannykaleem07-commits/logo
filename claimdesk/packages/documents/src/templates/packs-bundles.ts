/**
 * Packs and bundles.
 *
 *   pack.gta_payment         Covering letter for the payment pack (GTA 6.1–6.3 contents as an industry benchmark) with a
 *                            ticked index of what is enclosed, the heads of claim from the ledger, payment details, and the
 *                            Hire Period Validation Form on its own pages. The API merges the component PDFs after this one.
 *   bundle.litigation_index  Cover sheet and index for the claimant's hearing bundle (PD 32 / PD 27 style), naming the
 *                            claimant as litigant in person, with page references from the data.
 *
 * `schedule.loss` lives in templates/reports.ts.
 *
 * Both templates are pure functions of their data object. The API assembles the heads of claim and totals from the
 * ledger, the hire period and milestones from the event log, the monitoring diary from the GTA module, the
 * settlement date from the clocks engine, and the bundle pagination from the merged PDF. Nothing here reads the
 * clock or retypes a figure.
 *
 * Voice (voice.md): facts dated, requirements numbered, a deadline and the consequence. Perimeter (perimeter.md):
 * "we are instructed to correspond on behalf of"; GTA timescales are an industry benchmark for a non-subscriber; no
 * forum is named that is not open to a third-party claimant.
 */
import type { HireEndTrigger, ISODate, ISODateTime, Pence } from '@ccguk/domain';
import { brand } from '../brand.js';
import { type BaseDocumentData, GTA_BENCHMARK_SENTENCE, type Signatory, sampleBaseData, sampleRecipient } from '../common.js';
import {
  chargeableDays,
  escapeHtml,
  formatDateLong,
  formatDateTime,
  formatDateWithDay,
  formatGBP,
  formatNumber,
  formatPeriod,
  formatRate,
  formatRegistration,
  joinAnd,
  nl2p,
  numberedList,
  plural,
  sumPence
} from '../format.js';
import { baseLayout, callout, keyValueTable, pageBreak, scheduleTable, type ScheduleLine, signatureBlock, standardOpener, subjectBlock } from '../layout.js';
import { type AnyTemplate, registerTemplate, type Template } from '../registry.js';

type DateLike = ISODate | ISODateTime;

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * Thrown when a pack's figures or dates do not reconcile with each other. A document that could print two different
 * numbers for the same fact (live-file lesson a) is refused rather than rendered.
 */
export class PackDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackDataError';
  }
}

/** Components this template renders itself, so they are always enclosed whatever `present[]` says. */
export const SELF_RENDERED_COMPONENTS: ReadonlyArray<PackComponentId> = ['covering_letter', 'hire_period_validation'];

const BASE_REQUIRED = [
  'settings.registeredOffice',
  'settings.signatoryName',
  'settings.signatoryRole',
  'date',
  'claim.ourReference',
  'claim.claimantName',
  'claim.vehicleRegistration',
  'claim.accidentDate'
] as const;

function signatoryOf(d: BaseDocumentData): Signatory {
  return d.signatory ?? { name: d.settings.signatoryName, role: d.settings.signatoryRole };
}

function yesNo(v: boolean | undefined, whenUndefined = 'Not stated'): string {
  if (v === undefined) return whenUndefined;
  return v ? 'Yes' : 'No';
}

/** Generic table with a header row; every cell is escaped unless `html` is set. Columns in `numeric` are right-aligned. */
function dataTable(
  headings: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  opts: { caption?: string; numeric?: number[]; html?: boolean; emptyText?: string } = {}
): string {
  if (rows.length === 0) return opts.emptyText ? `<p class="muted">${escapeHtml(opts.emptyText)}</p>` : '';
  const numeric = new Set(opts.numeric ?? []);
  const cell = (c: string): string => (opts.html ? c : escapeHtml(c));
  const head = `<thead><tr>${headings.map((h, i) => `<th${numeric.has(i) ? ' class="num"' : ''}>${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
  const body = rows.map((r) => `<tr>${r.map((c, i) => `<td${numeric.has(i) ? ' class="num"' : ''}>${cell(c)}</td>`).join('')}</tr>`).join('\n');
  return `<table class="data">${opts.caption ? `<caption>${escapeHtml(opts.caption)}</caption>` : ''}${head}<tbody>\n${body}\n</tbody></table>`;
}

const PACKS_CSS = `
.tick{color:#1B7F3B;font-weight:700;}
.cross{color:#A12A2A;font-weight:700;}
.na{color:var(--silver);}
.court-heading{text-align:center;margin:2mm 0 6mm;}
.court-heading .court{font-weight:700;letter-spacing:.04em;text-transform:uppercase;}
.court-heading .claim-no{text-align:right;}
.court-heading .parties{margin:3mm 0;}
.court-heading .party{display:flex;justify-content:space-between;}
.court-heading .title{font-weight:700;text-transform:uppercase;border-top:1.5px solid var(--navy);border-bottom:1.5px solid var(--navy);padding:2mm 0;margin-top:3mm;}
.cover-note{margin-top:14mm;}
table.index td.pages{white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums;width:26mm;}
table.index td.date{white-space:nowrap;width:30mm;}
table.index tr.section td{background:var(--tint);font-weight:700;color:var(--navy);}
.form-sign{margin-top:6mm;}
`;

// ---------------------------------------------------------------------------
// pack.gta_payment
// ---------------------------------------------------------------------------

export type PackComponentId =
  | 'covering_letter'
  | 'mitigation_questionnaire'
  | 'advice_form'
  | 'hire_period_validation'
  | 'engineer_report'
  | 'hire_invoice'
  | 'storage_account'
  | 'recovery_account'
  | 'repair_account'
  | 'statement_of_need'
  | 'photographs';

/** The pack contents in the order they are bound, with the GTA paragraph that lists each (industry benchmark). */
export const PACK_COMPONENTS: ReadonlyArray<{ id: PackComponentId; label: string; basis: string }> = [
  { id: 'covering_letter', label: 'Covering letter detailing the payments required and the documents submitted', basis: 'GTA 6.2 (Appendix D)' },
  { id: 'hire_invoice', label: 'Hire account (invoice)', basis: 'GTA 6.1' },
  { id: 'mitigation_questionnaire', label: 'Mitigation Questionnaire and Statement of Truth signed by the hirer', basis: 'GTA 6.2 (Appendix C)' },
  { id: 'advice_form', label: 'New Claim Advice Form as sent to you', basis: 'GTA 6.2 (Appendix A)' },
  { id: 'hire_period_validation', label: 'Hire Period Validation Form', basis: 'GTA 6.2 (Appendix B)' },
  { id: 'engineer_report', label: 'Independent engineer’s inspection report', basis: 'GTA 6.3' },
  { id: 'repair_account', label: 'Repair account approved by the engineer', basis: 'GTA 6.3' },
  { id: 'storage_account', label: 'Storage account', basis: 'GTA 6.3' },
  { id: 'recovery_account', label: 'Recovery account', basis: 'GTA 6.3' },
  { id: 'statement_of_need', label: 'Statement of Need signed by the hirer', basis: 'Supporting' },
  { id: 'photographs', label: 'Photographs of the damage, delivery and collection', basis: 'Supporting' }
];

export type PackHeadKind = 'hire' | 'recovery' | 'storage' | 'engineer_fee' | 'repair' | 'excess' | 'other';

export interface PackHead {
  kind: PackHeadKind;
  label: string;
  /** Second line: period, basis, group — e.g. "10 August 2026 to 2 September 2026 (24 days) at £49.80 per day, GTA group M". */
  detail?: string;
  quantity?: string;
  ratePence?: Pence;
  invoiceNumber: string;
  netPence: Pence;
  vatPence: Pence;
  grossPence: Pence;
}

export interface MonitoringCall {
  at: DateLike;
  /** Repairer, engineer, insurer… */
  spokeTo: string;
  outcome: string;
  nextCheckAt?: DateLike;
}

export interface HireMilestone {
  label: string;
  date: DateLike;
  /** Event id, document or evidence reference. */
  source?: string;
}

export interface GtaPaymentPackData extends BaseDocumentData {
  /** Component ids enclosed with this pack (ticked). Everything else in PACK_COMPONENTS is crossed unless listed as not applicable. */
  present: PackComponentId[];
  /** Components that do not arise on this claim (e.g. no storage) — shown as "Not applicable" rather than crossed. */
  notApplicable?: PackComponentId[];
  heads: PackHead[];
  /** Ledger totals for the pack. */
  totals: { netPence: Pence; vatPence: Pence; grossPence: Pence };
  /** One calendar month from dispatch — computed by the clocks engine (GTA 6.7 as an industry benchmark). */
  settlementDueBy: ISODate;
  hire: {
    vehicleDescription: string;
    registration: string;
    gtaGroup: string;
    startAt: ISODateTime;
    endAt: ISODateTime;
    /** Inclusive days billed, from the ledger. */
    days: number;
    dailyRatePence: Pence;
    endTrigger: HireEndTrigger;
    deliveredTo?: string;
    odometerOut?: number;
    odometerIn?: number;
  };
  validation: {
    claimantVehicleRoadworthy: boolean;
    claimantVehicleLocation?: string;
    route: 'repair' | 'total_loss';
    milestones: HireMilestone[];
    monitoringCalls: MonitoringCall[];
    delayNoticesSentAt?: ISODate[];
    /** Handler's note on the period, if anything needs explaining. */
    periodNote?: string;
  };
}

const END_TRIGGER_LABELS: Record<HireEndTrigger, string> = {
  repair_complete_24h: 'Repair completed; hire ended within 24 hours (GTA 4.8)',
  tl_payment_5wd: 'Total-loss payment received; hire ended within five working days (GTA 4.14)',
  insurer_termination_1wd: 'Termination notice from the insurer; hire ended within one working day (GTA 4.9)',
  cash_in_lieu: 'Cash in lieu of repair accepted; hire ended on receipt (GTA 4.7)',
  client_returned: 'Vehicle returned by the claimant',
  replacement_purchased: 'Claimant purchased a replacement vehicle',
  manual: 'Hire ended by agreement'
};

export function endTriggerLabel(trigger: HireEndTrigger): string {
  return END_TRIGGER_LABELS[trigger] ?? trigger;
}

export const gtaPaymentPackTemplate: Template<GtaPaymentPackData> = {
  id: 'pack.gta_payment',
  version: '1.1.0',
  kind: 'pack',
  title: 'Payment pack',
  recipientRole: 'at_fault_insurer',
  description:
    'Covering letter and ticked index for the payment pack (GTA 6.1–6.3 contents as an industry benchmark), heads of claim and payment details, settlement requested within one calendar month, plus the Hire Period Validation Form.',
  requiredData: [
    ...BASE_REQUIRED,
    'recipient.name',
    'recipient.addressLines',
    'present',
    'heads',
    'totals.netPence',
    'totals.vatPence',
    'totals.grossPence',
    'settlementDueBy',
    'settings.bank.accountName',
    'settings.bank.sortCode',
    'settings.bank.accountNumber',
    'hire.vehicleDescription',
    'hire.registration',
    'hire.gtaGroup',
    'hire.startAt',
    'hire.endAt',
    'hire.days',
    'hire.dailyRatePence',
    'hire.endTrigger',
    'validation.claimantVehicleRoadworthy',
    'validation.route',
    'validation.milestones',
    'validation.monitoringCalls'
  ],
  sample: () => ({
    ...sampleBaseData({ date: '2026-09-04', recipient: sampleRecipient({ attention: 'Credit Hire Payments Team' }) }),
    present: ['covering_letter', 'hire_invoice', 'mitigation_questionnaire', 'advice_form', 'hire_period_validation', 'engineer_report', 'storage_account', 'recovery_account', 'statement_of_need'],
    notApplicable: ['repair_account'],
    heads: [
      {
        kind: 'hire',
        label: 'Hire charges',
        detail: '10 August 2026 to 2 September 2026 (24 days), Volkswagen Golf 1.5 TSI Life, GTA group M (industry benchmark)',
        quantity: '24 days',
        ratePence: 4980,
        invoiceNumber: 'INV-H-0042',
        netPence: 119520,
        vatPence: 23904,
        grossPence: 143424
      },
      { kind: 'recovery', label: 'Recovery', detail: 'Scene to storage yard, 12 loaded miles: call-out, mileage and administration', invoiceNumber: 'INV-R-0042', netPence: 15100, vatPence: 3020, grossPence: 18120 },
      { kind: 'storage', label: 'Storage', detail: '9 August 2026 to 16 August 2026 (8 days) to the engineer’s report plus 48 hours', quantity: '8 days', ratePence: 4500, invoiceNumber: 'INV-S-0042', netPence: 36000, vatPence: 7200, grossPence: 43200 },
      { kind: 'engineer_fee', label: 'Independent engineer’s fee', detail: 'Inspection at the yard on 14 August 2026 and report', invoiceNumber: 'INV-E-0042', netPence: 18000, vatPence: 3600, grossPence: 21600 }
    ],
    totals: { netPence: 188620, vatPence: 37724, grossPence: 226344 },
    settlementDueBy: '2026-10-04',
    hire: {
      vehicleDescription: 'Volkswagen Golf 1.5 TSI Life',
      registration: 'LK26CCG',
      gtaGroup: 'M',
      startAt: '2026-08-10T09:30:00+01:00',
      endAt: '2026-09-02T16:40:00+01:00',
      days: 24,
      dailyRatePence: 4980,
      endTrigger: 'repair_complete_24h',
      deliveredTo: '1 Example Street, Example Town, EX2 2BB',
      odometerOut: 18452,
      odometerIn: 19261
    },
    validation: {
      claimantVehicleRoadworthy: false,
      claimantVehicleLocation: 'Recovered from the scene to our storage yard on 9 August 2026; to the repairer on 16 August 2026',
      route: 'repair',
      milestones: [
        { label: 'Accident', date: '2026-08-09T14:35:00+01:00', source: 'FNOL' },
        { label: 'Vehicle recovered to storage', date: '2026-08-09T16:10:00+01:00', source: 'Recovery record' },
        { label: 'New Claim Advice Form sent to you', date: '2026-08-10', source: 'letter.ncaf' },
        { label: 'Hire started (vehicle delivered)', date: '2026-08-10T09:30:00+01:00', source: 'Delivery record' },
        { label: 'Independent engineer instructed', date: '2026-08-10', source: 'letter.supplier_instruction_engineer' },
        { label: 'Engineer inspected the vehicle', date: '2026-08-14', source: 'Engineer’s report' },
        { label: 'Engineer’s report issued; repair recommended', date: '2026-08-14', source: 'Engineer’s report' },
        { label: 'Vehicle moved to the repairer', date: '2026-08-16', source: 'Storage record' },
        { label: 'Repair authorised by you', date: '2026-08-28', source: 'Your email of 28 August 2026' },
        { label: 'Repair completed and vehicle returned to the claimant', date: '2026-09-02T15:30:00+01:00', source: 'Repairer’s completion note' },
        { label: 'Hire ended (vehicle collected)', date: '2026-09-02T16:40:00+01:00', source: 'Collection record' }
      ],
      monitoringCalls: [
        { at: '2026-08-19T10:05:00+01:00', spokeTo: 'Repairer (Example Bodyshop)', outcome: 'Estimate submitted to you on 14 August; authorisation awaited.', nextCheckAt: '2026-08-24' },
        { at: '2026-08-24T09:40:00+01:00', spokeTo: 'Your engineering team', outcome: 'Estimate under review; no authorisation yet. Delay notice sent the same day.', nextCheckAt: '2026-08-28' },
        { at: '2026-08-28T11:15:00+01:00', spokeTo: 'Repairer (Example Bodyshop)', outcome: 'Authorisation received from you; parts ordered; completion expected 2 September.', nextCheckAt: '2026-09-01' },
        { at: '2026-09-01T14:20:00+01:00', spokeTo: 'Repairer (Example Bodyshop)', outcome: 'Repair on schedule; vehicle ready 2 September. Collection of the hire vehicle booked for the same day.' }
      ],
      delayNoticesSentAt: ['2026-08-24'],
      periodNote: 'Of the 24 days of hire, 14 days (14 to 28 August 2026) fell between the engineer’s report and your authorisation of the repair.'
    }
  }),
  render: (d) => {
    // The figures must reconcile before anything is printed (lesson a: never two numbers for one fact).
    if (d.heads.length === 0) throw new PackDataError('pack.gta_payment: no heads of claim — a payment pack must claim at least one head');
    for (const h of d.heads) {
      if (h.netPence + h.vatPence !== h.grossPence) {
        throw new PackDataError(`pack.gta_payment: head "${h.label}" (${h.invoiceNumber}) net ${formatGBP(h.netPence)} + VAT ${formatGBP(h.vatPence)} does not equal gross ${formatGBP(h.grossPence)}`);
      }
    }
    const sumNet = sumPence(d.heads.map((h) => h.netPence));
    const sumVat = sumPence(d.heads.map((h) => h.vatPence));
    const sumGross = sumPence(d.heads.map((h) => h.grossPence));
    if (sumNet !== d.totals.netPence || sumVat !== d.totals.vatPence || sumGross !== d.totals.grossPence) {
      throw new PackDataError(
        `pack.gta_payment: heads sum to ${formatGBP(sumNet)} / ${formatGBP(sumVat)} / ${formatGBP(sumGross)} but totals say ${formatGBP(d.totals.netPence)} / ${formatGBP(d.totals.vatPence)} / ${formatGBP(d.totals.grossPence)}`
      );
    }
    const expectedDays = chargeableDays(d.hire.startAt, d.hire.endAt);
    if (d.hire.days !== expectedDays) {
      throw new PackDataError(`pack.gta_payment: hire.days (${d.hire.days}) does not match the chargeable day count of the hire period, ${formatPeriod(d.hire.startAt, d.hire.endAt)}`);
    }

    const present = new Set<PackComponentId>([...SELF_RENDERED_COMPONENTS, ...d.present]);
    const notApplicable = new Set((d.notApplicable ?? []).filter((c) => !present.has(c)));
    const contentsRows = PACK_COMPONENTS.map((c) => {
      let status: string;
      if (present.has(c.id)) status = '<span class="tick">✓</span> Enclosed';
      else if (notApplicable.has(c.id)) status = '<span class="na">— Not applicable</span>';
      else status = '<span class="cross">✗</span> Not enclosed';
      return [escapeHtml(c.label), escapeHtml(c.basis), status];
    });
    const anyMissing = PACK_COMPONENTS.some((c) => !present.has(c.id) && !notApplicable.has(c.id));

    const lines: ScheduleLine[] = d.heads.map((h) => {
      const line: ScheduleLine = { description: h.label, netPence: h.netPence, vatPence: h.vatPence, grossPence: h.grossPence, source: h.invoiceNumber };
      if (h.detail) line.detail = h.detail;
      if (h.quantity) line.quantity = h.quantity;
      if (h.ratePence !== undefined) line.ratePence = h.ratePence;
      return line;
    });

    const bank = d.settings.bank;
    const headLabels = joinAnd(d.heads.map((h) => h.label.toLowerCase()));

    const coveringLetter = `
${subjectBlock(d.claim, { claimantLabel: 'Claimant' })}
<p>Dear Sirs,</p>
${standardOpener(d.claim)}
<p>${
      anyMissing
        ? `The hire has ended. We enclose the payment pack for ${escapeHtml(headLabels)}; the items marked below as not enclosed will follow under separate cover, quoting our reference.`
        : `The hire has ended and the documentation is complete. We enclose the payment pack for ${escapeHtml(headLabels)}.`
    } The contents follow GTA paragraphs 6.1 to 6.3, which set the industry standard for a clean payment pack. ${escapeHtml(GTA_BENCHMARK_SENTENCE)}</p>

<h2>Contents of this pack</h2>
${dataTable(['Document', 'Basis', 'Status'], contentsRows, { html: true })}

<h2>Payment required</h2>
${scheduleTable(lines, { caption: 'Heads of claim', totals: d.totals, totalLabel: 'Total payable' })}
<p>Each line is supported by the invoice in the source column and the documents listed above. Hire ran from ${escapeHtml(formatPeriod(d.hire.startAt, d.hire.endAt, d.hire.days))} at ${escapeHtml(
      formatRate(d.hire.dailyRatePence, 'day')
    )}; the Hire Period Validation Form enclosed sets out every milestone and monitoring check with its source.</p>

<h2>What we require</h2>
${numberedList([
  `Payment of ${formatGBP(d.totals.grossPence)} to the account below by ${formatDateWithDay(d.settlementDueBy)}, one calendar month from dispatch of this pack. GTA paragraph 6.7 reflects this as the industry benchmark for settlement of a clean pack.`,
  'If you dispute any head, identify the head, the line and the basis of the dispute, with the document you rely on, and pay the undisputed heads now. A dispute about one head is not a reason to withhold payment of the others.',
  `Confirm receipt of this pack, and your reference for it, within five working days${d.claim.theirReference ? `, quoting your reference ${d.claim.theirReference}` : ''}.`
])}
${callout(
  `<p>Account name: <strong>${escapeHtml(bank.accountName)}</strong> &middot; Sort code ${escapeHtml(bank.sortCode)} &middot; Account number ${escapeHtml(bank.accountNumber)}${
    bank.bankName ? ` &middot; ${escapeHtml(bank.bankName)}` : ''
  }<br>Payment reference: ${escapeHtml(d.claim.ourReference)}. The account name is our exact registered name, so Confirmation of Payee returns a full match. Please pay by bank transfer and send the remittance advice to ${escapeHtml(
    brand.company.claimsEmail
  )}.</p>`,
  'Payment details'
)}
${callout(
  `<p>If payment or a reasoned response is not received by ${escapeHtml(formatDateWithDay(d.settlementDueBy))}, we will write again seven days later and the matter will move through our escalation process without further notice. Interest and costs will be sought on any sum that is left unpaid and later recovered.</p>`,
  'Settlement date'
)}
<p>Please quote our reference ${escapeHtml(d.claim.ourReference)} in all correspondence.</p>
${signatureBlock(signatoryOf(d), undefined, { closing: 'Yours faithfully' })}`;

    // --- Hire Period Validation Form (own pages) ---------------------------------------------------------------
    const vehicleRows = [
      { label: 'Hire vehicle', value: `${d.hire.vehicleDescription}, ${formatRegistration(d.hire.registration)}` },
      { label: 'GTA group (industry benchmark)', value: d.hire.gtaGroup },
      { label: 'Daily rate', value: `${formatRate(d.hire.dailyRatePence, 'day')} excluding VAT` },
      { label: 'Hire started', value: formatDateTime(d.hire.startAt) },
      { label: 'Hire ended', value: formatDateTime(d.hire.endAt) },
      { label: 'Days billed (inclusive)', value: plural(d.hire.days, 'day') },
      { label: 'End trigger', value: endTriggerLabel(d.hire.endTrigger) }
    ];
    if (d.hire.deliveredTo) vehicleRows.splice(3, 0, { label: 'Delivered to', value: d.hire.deliveredTo });
    if (d.hire.odometerOut !== undefined && d.hire.odometerIn !== undefined) {
      vehicleRows.push({ label: 'Odometer out / in', value: `${formatNumber(d.hire.odometerOut)} / ${formatNumber(d.hire.odometerIn)} miles (${plural(d.hire.odometerIn - d.hire.odometerOut, 'mile')} driven)` });
    }

    const claimantVehicleRows = [
      { label: 'Claimant’s vehicle', value: `${formatRegistration(d.claim.vehicleRegistration)}${d.claim.vehicleDescription ? ` — ${d.claim.vehicleDescription}` : ''}` },
      { label: 'Roadworthy after the accident', value: yesNo(d.validation.claimantVehicleRoadworthy) },
      { label: 'Route', value: d.validation.route === 'repair' ? 'Repair' : 'Total loss' }
    ];
    if (d.validation.claimantVehicleLocation) claimantVehicleRows.push({ label: 'Location during the hire', value: d.validation.claimantVehicleLocation });

    const milestoneRows = d.validation.milestones.map((m) => [m.date.includes('T') ? formatDateTime(m.date) : formatDateLong(m.date), m.label, m.source ?? '']);
    const callRows = d.validation.monitoringCalls.map((c) => [formatDateTime(c.at), c.spokeTo, c.outcome, c.nextCheckAt ? formatDateLong(c.nextCheckAt) : '']);
    const delayNotices = d.validation.delayNoticesSentAt ?? [];

    const validationForm = `
${pageBreak()}
<h1>Hire Period Validation Form</h1>
<p class="muted">Claim reference ${escapeHtml(d.claim.ourReference)}${d.claim.theirReference ? ` &middot; your reference ${escapeHtml(d.claim.theirReference)}` : ''}. Every date below is taken from the event log for this claim, with its source. GTA Appendix B is the industry form for validating the hire period; this form follows it. ${escapeHtml(
      GTA_BENCHMARK_SENTENCE
    )}</p>
${keyValueTable(vehicleRows, 'Hire')}
${keyValueTable(claimantVehicleRows, 'Claimant’s vehicle')}
${dataTable(['Date', 'Milestone', 'Source'], milestoneRows, { caption: d.validation.route === 'repair' ? 'Repair milestones' : 'Total-loss milestones' })}
${dataTable(['Date and time', 'Spoke to', 'Outcome', 'Next check'], callRows, {
  caption: 'Monitoring checks (GTA 4.10 and 4.11 cadence as industry practice)',
  emptyText: 'No monitoring checks were needed: the hire ended before the first check fell due.'
})}
<p><strong>Delay notices sent to you:</strong> ${delayNotices.length > 0 ? escapeHtml(joinAnd(delayNotices.map(formatDateLong))) : 'None were required.'}</p>
${d.validation.periodNote ? nl2p(d.validation.periodNote) : ''}
<p>The hire ended on the trigger shown above. Hire charges are claimed for ${escapeHtml(plural(d.hire.days, 'day'))}, from ${escapeHtml(formatDateLong(d.hire.startAt))} to ${escapeHtml(formatDateLong(d.hire.endAt))} inclusive, and for no other period.</p>
<div class="form-sign">${signatureBlock(signatoryOf(d), d.date, { closing: 'Completed by' })}</div>`;

    return baseLayout({
      title: 'Payment pack',
      kind: 'pack',
      reference: d.claim.ourReference,
      theirReference: d.claim.theirReference,
      date: d.date,
      recipient: d.recipient,
      settings: d.settings,
      closing: '',
      showTitle: false,
      extraCss: PACKS_CSS,
      bodyHtml: `${coveringLetter}\n${validationForm}`
    });
  }
};
registerTemplate(gtaPaymentPackTemplate);

// ---------------------------------------------------------------------------
// bundle.litigation_index
// ---------------------------------------------------------------------------

export type BundleSectionKey =
  | 'claim_form_particulars'
  | 'schedule_of_loss'
  | 'witness_statements'
  | 'hire_agreement_forms'
  | 'invoices'
  | 'engineer_report'
  | 'pav_report'
  | 'correspondence'
  | 'part_36'
  | 'other';

export const BUNDLE_SECTION_TITLES: Record<BundleSectionKey, string> = {
  claim_form_particulars: 'Claim form and particulars of claim',
  schedule_of_loss: 'Schedule of loss',
  witness_statements: 'Witness statements',
  hire_agreement_forms: 'Hire agreement and forms',
  invoices: 'Invoices',
  engineer_report: 'Engineer’s report',
  pav_report: 'Pre-accident value report',
  correspondence: 'Correspondence (chronological)',
  part_36: 'Part 36 offers',
  other: 'Other documents'
};

export interface BundleDocument {
  description: string;
  date?: DateLike;
  /** Bundle pagination from the merged PDF. */
  startPage: number;
  endPage?: number;
}

export interface BundleSection {
  key: BundleSectionKey;
  /** Overrides the default title for the key. */
  title?: string;
  documents: BundleDocument[];
}

export interface LitigationBundleIndexData extends BaseDocumentData {
  court: { name: string; claimNumber?: string };
  parties: { claimant: string; defendant: string; secondDefendant?: string };
  hearing?: { at?: DateLike; type?: string; timeEstimate?: string };
  /** True when the claimant acts in person (the default position: perimeter.md). */
  claimantActsInPerson: boolean;
  /** Set when a solicitor is instructed; then the bundle is prepared for that solicitor. */
  solicitorName?: string;
  sections: BundleSection[];
  totalPages: number;
  /** Who the bundle is served on / lodged with. */
  servedOn?: string[];
}

function pagesLabel(doc: BundleDocument): string {
  if (doc.endPage !== undefined && doc.endPage !== doc.startPage) return `${formatNumber(doc.startPage)}–${formatNumber(doc.endPage)}`;
  return formatNumber(doc.startPage);
}

export const litigationBundleIndexTemplate: Template<LitigationBundleIndexData> = {
  id: 'bundle.litigation_index',
  version: '1.0.0',
  kind: 'bundle',
  title: 'Hearing bundle index',
  recipientRole: 'court',
  description: 'Cover sheet and index for the claimant’s hearing bundle (PD 32 / PD 27 style) with page references for every document; names the claimant as litigant in person.',
  requiredData: [...BASE_REQUIRED, 'court.name', 'parties.claimant', 'parties.defendant', 'claimantActsInPerson', 'sections', 'totalPages'],
  sample: () => ({
    ...sampleBaseData({ date: '2026-10-04', recipient: undefined }),
    court: { name: 'County Court at Example', claimNumber: 'K00EX123' },
    parties: { claimant: 'Ms Jane Example', defendant: 'Mr John Sample' },
    hearing: { at: '2026-11-18T10:00:00+00:00', type: 'Small claims hearing', timeEstimate: '2 hours' },
    claimantActsInPerson: true,
    sections: [
      {
        key: 'claim_form_particulars',
        documents: [
          { description: 'Claim form N1', date: '2026-09-28', startPage: 1, endPage: 3 },
          { description: 'Particulars of claim', date: '2026-09-28', startPage: 4, endPage: 7 },
          { description: 'Defence', date: '2026-10-02', startPage: 8, endPage: 10 }
        ]
      },
      { key: 'schedule_of_loss', documents: [{ description: 'Schedule of loss', date: '2026-09-28', startPage: 11, endPage: 12 }] },
      {
        key: 'witness_statements',
        documents: [
          { description: 'Witness statement of Ms Jane Example', date: '2026-10-04', startPage: 13, endPage: 16 },
          { description: 'Witness statement of Mr Sam Witness', date: '2026-10-04', startPage: 17, endPage: 18 }
        ]
      },
      {
        key: 'hire_agreement_forms',
        documents: [
          { description: 'Credit hire agreement CHA-2026-00012', date: '2026-08-10', startPage: 19, endPage: 26 },
          { description: 'Cancellation information and model cancellation form', date: '2026-08-10', startPage: 27, endPage: 28 },
          { description: 'Express request to begin the hire', date: '2026-08-10', startPage: 29 },
          { description: 'Mitigation Questionnaire and Statement of Truth', date: '2026-09-03', startPage: 30, endPage: 32 },
          { description: 'Statement of Need', date: '2026-08-10', startPage: 33, endPage: 35 },
          { description: 'Statement of Means with bank statements', date: '2026-08-11', startPage: 36, endPage: 58 },
          { description: 'Signature completion certificates', date: '2026-08-10', startPage: 59, endPage: 62 }
        ]
      },
      {
        key: 'invoices',
        documents: [
          { description: 'Hire invoice INV-H-0042', date: '2026-09-03', startPage: 63, endPage: 64 },
          { description: 'Recovery invoice INV-R-0042', date: '2026-08-10', startPage: 65 },
          { description: 'Storage invoice INV-S-0042', date: '2026-08-17', startPage: 66 },
          { description: 'Engineer’s fee invoice INV-E-0042', date: '2026-08-15', startPage: 67 }
        ]
      },
      { key: 'engineer_report', documents: [{ description: 'Independent engineer’s report with photographs', date: '2026-08-14', startPage: 68, endPage: 79 }] },
      {
        key: 'correspondence',
        documents: [
          { description: 'New Claim Advice Form to the Defendant’s insurer', date: '2026-08-10', startPage: 80, endPage: 83 },
          { description: 'Reply to the insurer’s offer of a replacement vehicle', date: '2026-08-13', startPage: 84, endPage: 85 },
          { description: 'Payment pack covering letter and Hire Period Validation Form', date: '2026-09-04', startPage: 86, endPage: 89 },
          { description: 'Letter before claim', date: '2026-09-14', startPage: 90, endPage: 93 },
          { description: 'Insurer’s response', date: '2026-09-25', startPage: 94, endPage: 95 }
        ]
      },
      { key: 'part_36', documents: [{ description: 'Claimant’s Part 36 offer', date: '2026-09-28', startPage: 96, endPage: 97 }] }
    ],
    totalPages: 97,
    servedOn: ['The Court', 'The Defendant’s solicitors']
  }),
  render: (d) => {
    // Page references come from the merged PDF: they must run in sequence, not overlap, and stay inside the bundle.
    if (!Number.isInteger(d.totalPages) || d.totalPages < 1) throw new RangeError(`bundle.litigation_index: totalPages must be a positive whole number; received ${d.totalPages}`);
    let lastPage = 0;
    for (const s of d.sections) {
      for (const doc of s.documents) {
        const end = doc.endPage ?? doc.startPage;
        if (!Number.isInteger(doc.startPage) || !Number.isInteger(end) || doc.startPage < 1 || end < doc.startPage || end > d.totalPages || doc.startPage <= lastPage) {
          throw new RangeError(`bundle.litigation_index: "${doc.description}" at pages ${doc.startPage}–${end} is out of sequence or outside the bundle (1–${d.totalPages})`);
        }
        lastPage = end;
      }
    }

    const partyRows = [`<div class="party"><span>${escapeHtml(d.parties.claimant)}</span><span>Claimant</span></div>`, '<div class="center">and</div>', `<div class="party"><span>${escapeHtml(d.parties.defendant)}</span><span>${d.parties.secondDefendant ? 'First Defendant' : 'Defendant'}</span></div>`];
    if (d.parties.secondDefendant) partyRows.push('<div class="center">and</div>', `<div class="party"><span>${escapeHtml(d.parties.secondDefendant)}</span><span>Second Defendant</span></div>`);

    const hearingRows: Array<{ label: string; value: string }> = [];
    if (d.hearing?.type) hearingRows.push({ label: 'Hearing', value: d.hearing.type });
    if (d.hearing?.at) hearingRows.push({ label: 'Date and time', value: formatDateTime(d.hearing.at) });
    if (d.hearing?.timeEstimate) hearingRows.push({ label: 'Time estimate', value: d.hearing.timeEstimate });
    hearingRows.push({ label: 'Pages', value: formatNumber(d.totalPages) });
    hearingRows.push({ label: 'Prepared', value: formatDateLong(d.date) });

    const representation = d.claimantActsInPerson
      ? `The Claimant, ${escapeHtml(d.parties.claimant)}, acts in person (litigant in person).`
      : `The Claimant is represented by ${escapeHtml(d.solicitorName ?? '[instructed solicitor]')}.`;

    const indexRows: string[] = [];
    let sectionNo = 0;
    for (const s of d.sections) {
      sectionNo += 1;
      const title = s.title ?? BUNDLE_SECTION_TITLES[s.key];
      const first = s.documents[0];
      const last = s.documents[s.documents.length - 1];
      const range = first && last ? `${formatNumber(first.startPage)}–${formatNumber(last.endPage ?? last.startPage)}` : '';
      indexRows.push(`<tr class="section"><td>${escapeHtml(String(sectionNo))}</td><td colspan="2">${escapeHtml(title)}</td><td class="pages">${escapeHtml(range)}</td></tr>`);
      s.documents.forEach((doc, i) => {
        indexRows.push(
          `<tr><td>${escapeHtml(`${sectionNo}.${i + 1}`)}</td><td>${escapeHtml(doc.description)}</td><td class="date">${doc.date ? escapeHtml(formatDateLong(doc.date)) : ''}</td><td class="pages">${escapeHtml(pagesLabel(doc))}</td></tr>`
        );
      });
    }

    const cover = `
<div class="court-heading">
  <div class="court">In the ${escapeHtml(d.court.name)}</div>
  ${d.court.claimNumber ? `<div class="claim-no">Claim No. ${escapeHtml(d.court.claimNumber)}</div>` : ''}
  <div class="parties"><div class="center">BETWEEN</div>${partyRows.join('')}</div>
  <div class="title">Claimant’s hearing bundle</div>
</div>
${keyValueTable(hearingRows)}
<div class="cover-note">
<p>${representation}</p>
<p>This bundle is paginated consecutively from page 1 to page ${escapeHtml(formatNumber(d.totalPages))}. The index follows. Page references in the witness statements and the schedule of loss are to this pagination.</p>
${d.servedOn && d.servedOn.length > 0 ? `<p>Copies lodged with or served on: ${escapeHtml(joinAnd(d.servedOn))}.</p>` : ''}
<p class="small muted">Prepared with the assistance of ${escapeHtml(brand.company.registeredName)}, which provides accident management and credit hire services and is not a firm of solicitors. The Claimant is responsible for the conduct of the claim.</p>
</div>`;

    const index = `
${pageBreak()}
<h1>Index</h1>
<table class="data index"><thead><tr><th>No.</th><th>Document</th><th>Date</th><th class="num">Pages</th></tr></thead><tbody>
${indexRows.join('\n')}
</tbody></table>`;

    return baseLayout({
      title: 'Hearing bundle index',
      kind: 'bundle',
      reference: d.claim.ourReference,
      date: d.date,
      settings: d.settings,
      showTitle: false,
      closing: '',
      meta: d.court.claimNumber ? [{ label: 'Claim no.', value: d.court.claimNumber }] : undefined,
      extraCss: PACKS_CSS,
      bodyHtml: `${cover}\n${index}`
    });
  }
};
registerTemplate(litigationBundleIndexTemplate);

/** Every template in this file, in registration order. */
export const packsBundlesTemplates: ReadonlyArray<AnyTemplate> = [gtaPaymentPackTemplate, litigationBundleIndexTemplate];
