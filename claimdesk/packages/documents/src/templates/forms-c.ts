// owned by ap-paperwork
/**
 * Forms C — the Autopilot forms (docs/SUPREME-AUTOPILOT.md §D.6):
 *
 *   form.hire_period_validation   Hire Period Validation Form (the id `validatePaymentPack` already expects): the hire
 *                                 period, the dated milestones that explain its length, and the hirer's confirmation.
 *                                 The GTA appears only as an industry benchmark (CCGUK is not a subscriber).
 *   form.hire_cover_confirmation  "Hire vehicle insurance confirmation — this is not a certificate of motor insurance":
 *                                 insurer, policy number, permitted drivers, use and period, given to the hirer with the
 *                                 hire-start pack. The insurer's own certificate is attached as evidence when held.
 *
 * Pure functions of their data (from the hire / reservation record, the claim's event log and the fleet policy
 * record). No clock, no randomness; every date through format.ts. This file is imported for its side effects by
 * src/templates/index.ts.
 */
import type { ISODate, ISODateTime } from '@ccguk/domain';
import { brand } from '../brand.js';
import { type BaseDocumentData, GTA_BENCHMARK_SENTENCE, type RecipientBlock, sampleBaseData } from '../common.js';
import { escapeHtml, formatDateLong, formatDateTime, formatPeriod, formatRegistration, joinAnd, nl2p } from '../format.js';
import { baseLayout, callout, chronologyTable, type ChronologyEvent, keyValueTable } from '../layout.js';
import { type AnyTemplate, registerTemplate, type Template } from '../registry.js';

type DateLike = ISODate | ISODateTime;

const BASE_REQUIRED = ['settings.registeredOffice', 'date', 'claim.ourReference', 'claim.claimantName', 'claim.vehicleRegistration', 'claim.accidentDate'] as const;

const FORMS_C_CSS = `
.sig-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6mm;margin-top:6mm;break-inside:avoid;page-break-inside:avoid;}
.sig-field .field-line{height:9mm;border-bottom:1px solid var(--ink);}
.sig-field .field-line.field-value{height:auto;min-height:9mm;display:flex;align-items:flex-end;padding-bottom:1mm;}
.sig-field .field-label{font-size:8.5pt;color:var(--silver);margin-top:1mm;}
.not-certificate{border:2px solid var(--navy);padding:3mm 4mm;margin:4mm 0;font-weight:700;color:var(--navy);text-align:center;}
.integrity{font-size:8.5pt;color:var(--silver);border-top:1px solid var(--rule);padding-top:2mm;margin-top:8mm;}
`;

function signatureFields(fields: ReadonlyArray<{ label: string; value?: string }>): string {
  return `<div class="sig-grid">${fields
    .map((f) => `<div class="sig-field">${f.value ? `<div class="field-line field-value">${escapeHtml(f.value)}</div>` : '<div class="field-line"></div>'}<div class="field-label">${escapeHtml(f.label)}</div></div>`)
    .join('')}</div>`;
}

function p(text: string): string {
  return `<p>${escapeHtml(text)}</p>`;
}

function h2(text: string): string {
  return `<h2>${escapeHtml(text)}</h2>`;
}

// ---------------------------------------------------------------------------
// form.hire_period_validation
// ---------------------------------------------------------------------------

export interface HirePeriodValidationData extends BaseDocumentData {
  hirePeriod: {
    agreementNumber: string;
    startAt: DateLike;
    endAt: DateLike;
    /** Chargeable days, computed by the API's hire engine (never here). */
    days: number;
    vehicle: { makeModel: string; registration: string };
    /** Hire group of the replacement vehicle (industry benchmark grouping). */
    vehicleGroup: string;
  };
  /** Dated milestones from the event log that explain the length of the hire. */
  milestones: ChronologyEvent[];
  /** Why the hire lasted as long as it did, in plain words (from the handler / autopilot facts). */
  durationReason?: string;
  hirer: { name: string };
  signedAt?: ISODateTime;
}

export const hirePeriodValidationTemplate: Template<HirePeriodValidationData> = {
  id: 'form.hire_period_validation',
  version: '1.0.0',
  kind: 'form',
  title: 'Hire Period Validation Form',
  recipientRole: 'at_fault_insurer',
  description: 'The hire period with the dated milestones that explain its length, confirmed by the hirer; part of the payment pack. GTA referred to as an industry benchmark only.',
  requiredData: [
    ...BASE_REQUIRED,
    'hirePeriod.agreementNumber',
    'hirePeriod.startAt',
    'hirePeriod.endAt',
    'hirePeriod.days',
    'hirePeriod.vehicle.makeModel',
    'hirePeriod.vehicle.registration',
    'hirePeriod.vehicleGroup',
    'milestones',
    'hirer.name'
  ],
  sample: () => ({
    ...sampleBaseData(),
    hirePeriod: {
      agreementNumber: 'CHA-2026-00012',
      startAt: '2026-08-10',
      endAt: '2026-09-02',
      days: 24,
      vehicle: { makeModel: 'Volkswagen Golf 1.5 TSI Life', registration: 'LK26CCG' },
      vehicleGroup: 'C (manual)'
    },
    milestones: [
      { date: '2026-08-09', description: 'Accident. Vehicle unroadworthy; recovered to storage.', attributableTo: 'none' },
      { date: '2026-08-10', description: 'Hire started. New Claim Advice Form sent to you.', attributableTo: 'CCGUK' },
      { date: '2026-08-14', description: 'Your engineer inspected the vehicle.', attributableTo: 'insurer' },
      { date: '2026-08-28', description: 'Repair authorised.', attributableTo: 'insurer' },
      { date: '2026-09-02', description: 'Repair completed; hire vehicle collected the same day.', attributableTo: 'repairer' }
    ],
    durationReason: 'The hire ran from the day after the accident until the day the repaired vehicle was returned.',
    hirer: { name: 'Ms Jane Example' }
  }),
  render: (d) => {
    const h = d.hirePeriod;
    const body = `
${keyValueTable([
  { label: 'Hirer', value: d.hirer.name },
  { label: 'Agreement number', value: h.agreementNumber },
  { label: 'Replacement vehicle', value: `${h.vehicle.makeModel}, registration ${formatRegistration(h.vehicle.registration)}` },
  { label: 'Vehicle group', value: h.vehicleGroup },
  { label: 'Hire period', value: formatPeriod(h.startAt, h.endAt, h.days) }
])}
${h2('Milestones')}
${chronologyTable(d.milestones)}
${d.durationReason ? `${h2('Length of the hire')}${nl2p(d.durationReason)}` : ''}
${p(`This form follows the layout of the industry form for validating a hire period. ${GTA_BENCHMARK_SENTENCE}`)}
${h2('Hirer’s confirmation')}
${p(`I confirm that I had the replacement vehicle above for the period shown, that I needed it for that period while my own vehicle was off the road, and that the dates above are correct to the best of my knowledge.`)}
${signatureFields([
  { label: 'Signed', value: d.signedAt ? `Signed electronically ${formatDateTime(d.signedAt)}` : '' },
  { label: 'Full name', value: d.hirer.name },
  { label: 'Date', value: d.signedAt ? formatDateLong(d.signedAt) : '' }
])}
<div class="integrity">Template form.hire_period_validation version 1.0.0. Prepared by ${escapeHtml(brand.company.registeredName)}.</div>`;
    return baseLayout({
      title: 'Hire Period Validation Form',
      subtitle: `Agreement ${h.agreementNumber}`,
      kind: 'form',
      reference: d.claim.ourReference,
      theirReference: d.claim.theirReference,
      date: d.date,
      recipient: d.recipient,
      settings: d.settings,
      meta: [{ label: 'Agreement', value: h.agreementNumber }],
      closing: '',
      extraCss: FORMS_C_CSS,
      bodyHtml: body
    });
  }
};
registerTemplate(hirePeriodValidationTemplate);

// ---------------------------------------------------------------------------
// form.hire_cover_confirmation
// ---------------------------------------------------------------------------

export interface HireCoverConfirmationData extends BaseDocumentData {
  hirer: { name: string; addressLines: string[]; email?: string };
  cover: {
    insurerName: string;
    policyNumber: string;
    /** Names of the drivers permitted under the policy for this hire. */
    permittedDrivers: string[];
    /** Class of use in plain words, e.g. "Social, domestic and pleasure, and commuting". */
    use: string;
    periodStart: DateLike;
    /** Absent for an open-ended hire: cover then runs for the hire, within the policy period below. */
    periodEnd?: DateLike;
    /** When the fleet policy itself ends. */
    policyEndsOn?: DateLike;
    vehicle: { makeModel: string; registration: string };
    /** The insurer's certificate of motor insurance is attached as evidence. */
    certificateAttached: boolean;
  };
}

export const hireCoverConfirmationTemplate: Template<HireCoverConfirmationData> = {
  id: 'form.hire_cover_confirmation',
  version: '1.0.0',
  kind: 'form',
  title: 'Hire vehicle insurance confirmation',
  recipientRole: 'client',
  description: 'Confirms the insurance on the hire vehicle (insurer, policy number, permitted drivers, use, period). Not a certificate of motor insurance; the insurer’s certificate is attached when held.',
  requiredData: [
    ...BASE_REQUIRED,
    'hirer.name',
    'cover.insurerName',
    'cover.policyNumber',
    'cover.permittedDrivers',
    'cover.use',
    'cover.periodStart',
    'cover.vehicle.makeModel',
    'cover.vehicle.registration',
    'cover.certificateAttached'
  ],
  sample: () => ({
    ...sampleBaseData({ recipient: undefined }),
    hirer: { name: 'Ms Jane Example', addressLines: ['1 Example Street', 'Example Town', 'EX2 2BB'], email: 'jane@example.test' },
    cover: {
      insurerName: 'Example Fleet Insurance plc',
      policyNumber: 'FLEET-000000',
      permittedDrivers: ['Ms Jane Example'],
      use: 'Social, domestic and pleasure, and commuting',
      periodStart: '2026-10-06T09:00:00+01:00',
      policyEndsOn: '2027-03-31',
      vehicle: { makeModel: 'Volkswagen Golf 1.5 TSI Life', registration: 'LK26CCG' },
      certificateAttached: true
    }
  }),
  render: (d) => {
    const c = d.cover;
    const period = c.periodEnd ? formatPeriod(c.periodStart, c.periodEnd) : `From ${formatDateTime(c.periodStart)}, while you have the vehicle`;
    const recipient: RecipientBlock = { name: d.hirer.name, addressLines: d.hirer.addressLines, ...(d.hirer.email ? { email: d.hirer.email } : {}) };
    const body = `
<div class="not-certificate">This is not a certificate of motor insurance.</div>
${p(`${brand.company.registeredName} confirms that the hire vehicle below is insured for your use during the hire on the terms shown.`)}
${keyValueTable([
  { label: 'Hire vehicle', value: `${c.vehicle.makeModel}, registration ${formatRegistration(c.vehicle.registration)}` },
  { label: 'Insurer', value: c.insurerName },
  { label: 'Policy number', value: c.policyNumber },
  { label: 'Permitted drivers', value: c.permittedDrivers.length > 0 ? joinAnd(c.permittedDrivers) : 'None recorded — do not drive until we confirm the drivers' },
  { label: 'Use', value: c.use },
  { label: 'Period', value: period },
  ...(c.policyEndsOn ? [{ label: 'Fleet policy renewal date', value: formatDateLong(c.policyEndsOn) }] : [])
])}
${h2('Important')}
${p(`Only the ${c.permittedDrivers.length === 1 ? 'person' : 'people'} named above may drive the vehicle. Nobody else may drive it, even for a short journey. Use the vehicle only for the use shown. Tell us at once if anything changes, including a new endorsement or a medical condition that affects your driving.`)}
${callout(
  c.certificateAttached
    ? '<p>The insurer’s certificate of motor insurance for the vehicle is attached. Keep it with you while you have the vehicle.</p>'
    : `<p>The insurer’s certificate of motor insurance is held by us. Ask us for a copy at any time on ${escapeHtml(brand.company.officePhone)}.</p>`,
  'Certificate of motor insurance'
)}
<div class="integrity">Template form.hire_cover_confirmation version 1.0.0.</div>`;
    return baseLayout({
      title: 'Hire vehicle insurance confirmation',
      subtitle: 'This is not a certificate of motor insurance',
      kind: 'form',
      reference: d.claim.ourReference,
      date: d.date,
      recipient,
      settings: d.settings,
      closing: '',
      extraCss: FORMS_C_CSS,
      bodyHtml: body
    });
  }
};
registerTemplate(hireCoverConfirmationTemplate);

/** Every Forms C template, for tests and the coverage list. */
export const formsCTemplates: ReadonlyArray<AnyTemplate> = [hirePeriodValidationTemplate, hireCoverConfirmationTemplate];
