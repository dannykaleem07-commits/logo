/**
 * Agreements and forms — what the hirer signs at sign-up, and the statements the claimant signs for the claim.
 *
 *   agreement.credit_hire            Credit hire agreement (BLUEPRINT §5.2): open-ended term, RAO art 60F credit terms,
 *                                    CCR 2013 information and cancellation rights, Owner Liability Regs statement of liability
 *   form.cancellation_sch3           CCR 2013 Schedule 3 Part B model cancellation form, pre-filled with our details
 *   form.express_request_to_start    CCR 2013 reg 36 express request to begin the hire during the cancellation period
 *   form.mitigation_questionnaire    GTA Appendix C style Mitigation Questionnaire / Statement of Truth (industry benchmark)
 *   form.statement_of_means          Statement of Means (07) — impecuniosity evidence (Diriye v Bojaj)
 *   form.statement_of_need           Statement of Need — occupation, journeys, dependants, household vehicles, mobility
 *   statement.witness                CPR 32 / PD 32 witness statement skeleton for the witness to check and sign
 *
 * Every template is a pure function of its data object. The API assembles the data from the hire agreement record,
 * the intervention register, the claimant's own answers captured in the app, the e-signature record and settings.
 * No template reads the clock or retypes a figure: every amount and date comes from `data` through format.ts.
 *
 * Perimeter (perimeter.md): the hirer is the claimant and the litigant in person; CCGUK assists and is instructed to
 * correspond on their behalf; nothing here implies regulated status. The GTA is an industry benchmark for a
 * non-subscriber. The forms never suggest an answer: they record the client's own account and are signed by the
 * client under a statement of truth (CPR 22 / PD 32 wording; CPR 32.14 contempt warning).
 */
import type { ISODate, ISODateTime, Pence } from '@ccguk/domain';
import { addCalendarDays, addCalendarMonths } from '@ccguk/domain';
import { brand } from '../brand.js';
import { type BaseDocumentData, type RecipientBlock, type Signatory, sampleBaseData, sampleClaim } from '../common.js';
import {
  dateParts,
  escapeHtml,
  formatDateLong,
  formatDateTime,
  formatGBP,
  formatMiles,
  formatNumber,
  formatPercent,
  formatRate,
  formatRegistration,
  joinAnd,
  nl2p,
  numberedList,
  plural,
  sumPence,
  toISODate
} from '../format.js';
import { baseLayout, callout, keyValueTable, reExecutionLine, statementOfTruth } from '../layout.js';
import { type AnyTemplate, registerTemplate, type Template } from '../registry.js';

type DateLike = ISODate | ISODateTime;

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const BASE_REQUIRED = [
  'settings.registeredOffice',
  'date',
  'claim.ourReference',
  'claim.claimantName',
  'claim.vehicleRegistration',
  'claim.accidentDate'
] as const;

/** Printed wherever a GTA group or paragraph is mentioned, so the benchmark status is never left to inference. */
export const GTA_BENCHMARK_NOTE = 'We are not a GTA subscriber and refer to the GTA as an industry benchmark only.';

/** Thrown when a signature date precedes the document's creation timestamp (BLUEPRINT §3.8, live-file lesson b). */
export class SignatureDateError extends Error {
  readonly field: string;
  constructor(field: string, signedAt: string, createdAt: string) {
    super(`${field} (${signedAt}) is earlier than the document creation timestamp (${createdAt}). A document cannot be signed before it exists.`);
    this.name = 'SignatureDateError';
    this.field = field;
  }
}

/**
 * The creation-timestamp floor: a signature can never be dated before the document was generated. Date-times are
 * compared exactly; where either side is a plain date the comparison is by calendar day (Europe/London).
 */
export function assertNotBeforeCreation(field: string, signedAt: DateLike, createdAt: DateLike): void {
  const s = dateParts(signedAt);
  const c = dateParts(createdAt);
  const before = s.hasTime && c.hasTime ? Date.parse(signedAt) < Date.parse(createdAt) : toISODate(signedAt) < toISODate(createdAt);
  if (before) throw new SignatureDateError(field, signedAt, createdAt);
}

/**
 * Last day on which a payment may fall due under RAO art 60F(2)(c): the payments must be required within a period
 * of twelve months or less beginning with the date of the agreement, so the final day is twelve months on, less one.
 */
export function art60fFinalPaymentLimit(agreementDate: DateLike): ISODate {
  return toISODate(addCalendarDays(addCalendarMonths(toISODate(agreementDate), 12), -1));
}

export interface DrivingLicence {
  number: string;
  /** "United Kingdom" — Owner Liability Regs Sch 2 asks for the country of issue. */
  countryOfIssue: string;
  /** Sch 2 also asks for the expiry date. Optional in the type because the party record may not hold it yet; the agreement says so when it is missing, and the notices require it. */
  expiresOn?: ISODate;
}

/** The hirer / claimant as a party to an agreement or the person completing a form. */
export interface HirerDetails {
  name: string;
  addressLines: string[];
  dateOfBirth?: ISODate;
  email?: string;
  phone?: string;
  occupation?: string;
  licence?: DrivingLicence;
}

export interface AdditionalDriverDetails {
  name: string;
  dateOfBirth?: ISODate;
  licence?: DrivingLicence;
  /** GTA 5.4 non-standard risk (under 25, over 70, under 12 months' experience, convictions) — evidenced on file. */
  nonStandardRisk?: boolean;
}

function hirerRecipient(h: HirerDetails): RecipientBlock {
  const r: RecipientBlock = { name: h.name, addressLines: h.addressLines };
  if (h.email) r.email = h.email;
  return r;
}

function yesNo(v: boolean | undefined, whenUndefined = 'Not stated'): string {
  if (v === undefined) return whenUndefined;
  return v ? 'Yes' : 'No';
}

function licenceText(l: DrivingLicence | undefined): string {
  if (!l) return 'Not supplied';
  return `${l.number} (${l.countryOfIssue}; ${l.expiresOn ? `expires ${formatDateLong(l.expiresOn)}` : 'expiry date not recorded'})`;
}

/** Generic table with a header row; every cell is escaped. Columns listed in `numeric` are right-aligned. */
function dataTable(headings: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>, opts: { caption?: string; numeric?: number[]; emptyText?: string } = {}): string {
  if (rows.length === 0) return opts.emptyText ? `<p class="muted">${escapeHtml(opts.emptyText)}</p>` : '';
  const numeric = new Set(opts.numeric ?? []);
  const head = `<thead><tr>${headings.map((h, i) => `<th${numeric.has(i) ? ' class="num"' : ''}>${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
  const body = rows
    .map((r) => `<tr>${r.map((cell, i) => `<td${numeric.has(i) ? ' class="num"' : ''}>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('\n');
  return `<table class="data">${opts.caption ? `<caption>${escapeHtml(opts.caption)}</caption>` : ''}${head}<tbody>\n${body}\n</tbody></table>`;
}

/** Numbered clauses within a section: "3.1 …". Items are HTML (data inside them is already escaped). */
function clauses(section: number, items: ReadonlyArray<string>): string {
  return items.map((html, i) => `<p class="clause"><span class="cnum">${section}.${i + 1}</span><span class="ctext">${html}</span></p>`).join('\n');
}

/** A question and the client's answer, as recorded. Answers are the client's own words. */
function qa(question: string, answerHtml: string): string {
  return `<div class="qa"><p class="q">${escapeHtml(question)}</p><div class="a">${answerHtml || '<p class="muted">Not answered</p>'}</div></div>`;
}

/** Signature fields for a person signing (hirer, claimant, witness). CCGUK staff use signatureBlock() instead. */
function signatureFields(fields: ReadonlyArray<{ label: string; value?: string }>): string {
  const grid = fields
    .map(
      (f) =>
        `<div class="sig-field">${f.value ? `<div class="field-line field-value">${escapeHtml(f.value)}</div>` : '<div class="field-line"></div>'}<div class="field-label">${escapeHtml(
          f.label
        )}</div></div>`
    )
    .join('');
  return `<div class="sig-grid">${grid}</div>`;
}

const FORMS_CSS = `
.clause{display:flex;gap:3mm;margin:0 0 2.5mm;}
.clause .cnum{flex:0 0 10mm;font-weight:600;color:var(--navy);}
.clause .ctext{flex:1 1 auto;}
.qa{margin:0 0 4mm;break-inside:avoid;page-break-inside:avoid;}
.qa .q{font-weight:600;color:var(--navy);margin:0 0 1mm;}
.qa .a{border-left:2px solid var(--rule);padding:1mm 0 1mm 4mm;}
.qa .a p{margin:0 0 1.5mm;}
.sig-two{display:grid;grid-template-columns:1fr 1fr;gap:6mm 10mm;margin-top:6mm;}
.sig-two h3{margin-top:0;}
.sig-two .sig-grid{grid-template-columns:1fr;gap:4mm;margin-top:3mm;}
.sig-field .field-line.field-value{height:auto;min-height:9mm;display:flex;align-items:flex-end;padding-bottom:1mm;}
.sig-grid{break-inside:avoid;page-break-inside:avoid;}
h2+.sig-grid{margin-top:3mm;}
.sig-close{break-inside:avoid;page-break-inside:avoid;}
.integrity{font-size:8.5pt;color:var(--silver);border-top:1px solid var(--rule);padding-top:2mm;margin-top:8mm;}
.integrity .hash{font-family:'Consolas','Liberation Mono',monospace;word-break:break-all;}
.form-box{border:1px solid var(--navy);padding:3.5mm 4mm;margin:4mm 0;}
.form-box p{margin:0 0 2.5mm;}
.form-box .fill{display:inline-block;min-width:60mm;border-bottom:1px solid var(--ink);padding:0 2mm;font-weight:600;}
.form-box .blank{display:block;height:9mm;border-bottom:1px solid var(--ink);margin-bottom:1mm;}
.court-topright{text-align:right;font-size:9pt;line-height:1.4;margin-bottom:4mm;}
.court-heading{text-align:center;margin:2mm 0 6mm;}
.court-heading .court{font-weight:700;letter-spacing:.04em;text-transform:uppercase;}
.court-heading .claim-no{text-align:right;}
.court-heading .parties{margin:3mm 0;}
.court-heading .party{display:flex;justify-content:space-between;}
.court-heading .title{font-weight:700;text-transform:uppercase;border-top:1.5px solid var(--navy);border-bottom:1.5px solid var(--navy);padding:2mm 0;margin-top:3mm;}
.draft-banner{background:var(--tint);border-left:3px solid var(--gold);padding:2mm 4mm;margin:0 0 5mm;font-size:9pt;}
ol.paras{padding-left:0;list-style:none;counter-reset:para;}
ol.paras>li{counter-increment:para;display:flex;gap:4mm;margin-bottom:3mm;}
ol.paras>li::before{content:counter(para) ".";flex:0 0 8mm;font-weight:600;color:var(--navy);}
`;

// ---------------------------------------------------------------------------
// agreement.credit_hire
// ---------------------------------------------------------------------------

export interface CreditHireCharges {
  /** Daily hire rate excluding VAT. */
  dailyRatePence: Pence;
  /** e.g. 0.2 */
  vatRate: number;
  /** The hirer's excess per incident of damage or loss. */
  excessPence: Pence;
  /** Optional excess waiver, per day (excluding VAT). */
  excessWaiverDailyPence?: Pence;
  /** Whether the hirer has taken the waiver (it changes what is owed). Undefined = offered, choice not yet recorded. */
  excessWaiverSelected?: boolean;
  /** GTA 5.4 non-standard risk driver supplement per day and cap per hire — industry benchmark figures from the rate card. */
  additionalDriverDailyPence?: Pence;
  additionalDriverCapPence?: Pence;
  /** Delivery and collection, if charged. */
  deliveryCollectionPence?: Pence;
}

export interface CreditHireAgreementData extends BaseDocumentData {
  agreementNumber: string;
  /** When the document was generated (the floor for every signature date). */
  createdAt: ISODateTime;
  hirer: HirerDetails;
  vehicle: {
    registration: string;
    makeModel: string;
    /** GTA group of the hire vehicle (industry benchmark). */
    gtaGroup: string;
    fuel?: string;
    transmission?: string;
    odometerOut?: number;
  };
  hire: {
    startAt: ISODateTime;
    deliveryAddressLines?: string[];
  };
  charges: CreditHireCharges;
  credit: {
    /** Never more than 12 (RAO art 60F(2)(b)). */
    maxInstalments: number;
    /** Last day on which payment can fall due: within 12 months beginning with the date of the agreement (art 60F(2)(c)). Computed by the API. */
    finalPaymentDueBy: ISODate;
  };
  additionalDrivers: AdditionalDriverDetails[];
  cancellation: {
    /** When the Schedule 2 information and this agreement were given to the hirer on a durable medium. */
    informationProvidedAt: DateLike;
    /** When the Schedule 3 cancellation form was given. */
    sch3FormProvidedAt?: DateLike;
    /** The last day of the 14-day cancellation period, when known (after signature). */
    periodEndsOn?: ISODate;
  };
  signatures?: {
    hirerSignedAt?: ISODateTime;
    ccgukSignedAt?: ISODateTime;
    ccgukSignatory?: Signatory;
  };
  /** BLUEPRINT §3.8: a re-executed agreement carries the actual signing date and the version it supersedes. */
  reExecutedOn?: ISODate;
  supersedesVersion?: string;
}

/** The hirer's statement of liability (Road Traffic (Owner Liability) Regulations 2000; POFA 2012 Sch 4 para 13(2)(c)). */
export function statementOfLiabilityText(hirerName: string, addressLines: string[]): string {
  const address = addressLines.filter((l) => l.trim() !== '').join(', ');
  return `I, ${hirerName}, acknowledge that I am liable for any fixed penalty notice or penalty charge notice served, and for any parking charge, congestion charge, road-user charge or toll incurred, in respect of the vehicle during the period of hire, including any authorised extension of it. I agree that Courtesy Cars Group UK Ltd may give my name, address, date of birth and driving licence details to the enforcement authority or creditor so that liability is transferred to me. My address for service is ${address}.`;
}

export const creditHireAgreementTemplate: Template<CreditHireAgreementData> = {
  id: 'agreement.credit_hire',
  version: '1.1.0',
  kind: 'agreement',
  title: 'Credit Hire Agreement',
  recipientRole: 'client',
  description:
    'Credit hire agreement: open-ended term until repair or settlement, RAO art 60F credit terms, CCR 2013 information and cancellation rights, statement of liability for penalty charges, recovery clause.',
  requiredData: [
    ...BASE_REQUIRED,
    'agreementNumber',
    'createdAt',
    'hirer.name',
    'hirer.addressLines',
    // Owner Liability Regs Sch 2 particulars (section 8): an individual hirer must have these before signing.
    'hirer.dateOfBirth',
    'hirer.licence.number',
    'hirer.licence.countryOfIssue',
    'vehicle.registration',
    'vehicle.makeModel',
    'vehicle.gtaGroup',
    'hire.startAt',
    'charges.dailyRatePence',
    'charges.vatRate',
    'charges.excessPence',
    'credit.maxInstalments',
    'credit.finalPaymentDueBy',
    'additionalDrivers',
    'cancellation.informationProvidedAt'
  ],
  titleFor: (d) => `Credit Hire Agreement ${d.agreementNumber}`,
  sample: () => ({
    ...sampleBaseData({ date: '2026-08-10', recipient: undefined }),
    agreementNumber: 'CHA-2026-00012',
    createdAt: '2026-08-10T09:05:00+01:00',
    hirer: {
      name: 'Ms Jane Example',
      addressLines: ['1 Example Street', 'Example Town', 'EX2 2BB'],
      dateOfBirth: '1988-05-14',
      email: 'jane.example@example.test',
      phone: '07700 900123',
      occupation: 'Community nurse',
      licence: { number: 'EXAMP805148JE9AB', countryOfIssue: 'United Kingdom', expiresOn: '2031-05-13' }
    },
    vehicle: { registration: 'LK26CCG', makeModel: 'Volkswagen Golf 1.5 TSI Life', gtaGroup: 'M', fuel: 'Petrol', transmission: 'Manual', odometerOut: 18452 },
    hire: { startAt: '2026-08-10T09:30:00+01:00', deliveryAddressLines: ['1 Example Street', 'Example Town', 'EX2 2BB'] },
    charges: {
      dailyRatePence: 4980,
      vatRate: 0.2,
      excessPence: 75000,
      excessWaiverDailyPence: 1200,
      excessWaiverSelected: false,
      additionalDriverDailyPence: 550,
      additionalDriverCapPence: 11000
    },
    credit: { maxInstalments: 12, finalPaymentDueBy: '2027-08-09' },
    additionalDrivers: [
      {
        name: 'Mr Tom Example',
        dateOfBirth: '1986-02-02',
        licence: { number: 'EXAMP802026TE9CD', countryOfIssue: 'United Kingdom', expiresOn: '2029-02-01' },
        nonStandardRisk: false
      }
    ],
    cancellation: { informationProvidedAt: '2026-08-10T09:05:00+01:00', sch3FormProvidedAt: '2026-08-10T09:05:00+01:00' },
    signatures: {
      hirerSignedAt: '2026-08-10T09:41:00+01:00',
      ccgukSignedAt: '2026-08-10T09:42:00+01:00',
      ccgukSignatory: { name: 'D. Kaleem', role: 'Claims Manager' }
    }
  }),
  render: (d) => {
    if (d.signatures?.hirerSignedAt) assertNotBeforeCreation('signatures.hirerSignedAt', d.signatures.hirerSignedAt, d.createdAt);
    if (d.signatures?.ccgukSignedAt) assertNotBeforeCreation('signatures.ccgukSignedAt', d.signatures.ccgukSignedAt, d.createdAt);
    if (d.reExecutedOn) assertNotBeforeCreation('reExecutedOn', d.reExecutedOn, d.createdAt);
    if (!Number.isInteger(d.credit.maxInstalments) || d.credit.maxInstalments > 12 || d.credit.maxInstalments < 1) {
      throw new RangeError(`credit.maxInstalments must be a whole number between 1 and 12 to fit RAO art 60F(2)(b); received ${d.credit.maxInstalments}`);
    }
    // art 60F(2)(c): every payment must fall due within twelve months beginning with the date of the agreement.
    const agreementDate = toISODate(d.date);
    const finalLimit = art60fFinalPaymentLimit(d.date);
    const finalDue = toISODate(d.credit.finalPaymentDueBy);
    if (finalDue > finalLimit || finalDue < agreementDate) {
      throw new RangeError(
        `credit.finalPaymentDueBy (${d.credit.finalPaymentDueBy}) must fall within twelve months beginning with the agreement date ${agreementDate} (last permitted day ${finalLimit}) to fit RAO art 60F(2)(c)`
      );
    }

    const company = brand.company;
    const office = d.settings.registeredOffice.trim() || '[registered office]';
    const ccgukSignatory = d.signatures?.ccgukSignatory ?? d.signatory ?? { name: d.settings.signatoryName, role: d.settings.signatoryRole };
    const rate = formatRate(d.charges.dailyRatePence, 'day');
    const vat = formatPercent(d.charges.vatRate);
    const instalments = formatNumber(d.credit.maxInstalments);
    const waiverSelected = d.charges.excessWaiverSelected;
    const licenceExpiryMissing = !d.hirer.licence?.expiresOn;

    const partyRows = [
      { label: 'Hire company ("we", "us")', value: `${company.registeredName}, company number ${company.companyNumber}, registered office ${office}` },
      { label: 'Contact', value: `${company.claimsEmail} · 24-hour accident line ${company.accidentLine24h}` },
      { label: 'Hirer ("you")', value: d.hirer.name },
      { label: 'Permanent address', value: d.hirer.addressLines.filter((l) => l.trim() !== '').join(', ') }
    ];
    if (d.hirer.dateOfBirth) partyRows.push({ label: 'Date of birth', value: formatDateLong(d.hirer.dateOfBirth) });
    partyRows.push({ label: 'Driving licence', value: licenceText(d.hirer.licence) });
    if (d.hirer.email) partyRows.push({ label: 'Email', value: d.hirer.email });
    if (d.hirer.phone) partyRows.push({ label: 'Telephone', value: d.hirer.phone });

    const vehicleRows = [
      { label: 'Registration', value: formatRegistration(d.vehicle.registration) },
      { label: 'Make and model', value: d.vehicle.makeModel },
      { label: 'GTA group (industry benchmark)', value: d.vehicle.gtaGroup }
    ];
    if (d.vehicle.fuel) vehicleRows.push({ label: 'Fuel', value: d.vehicle.fuel });
    if (d.vehicle.transmission) vehicleRows.push({ label: 'Transmission', value: d.vehicle.transmission });
    if (d.vehicle.odometerOut !== undefined) vehicleRows.push({ label: 'Odometer at delivery', value: formatMiles(d.vehicle.odometerOut) });

    const chargeRows = [
      { label: 'Daily hire rate', value: `${rate} excluding VAT` },
      { label: 'VAT', value: `${vat}, added to every charge in this agreement` },
      { label: 'Your excess', value: `${formatGBP(d.charges.excessPence)} per incident of damage to or loss of the vehicle` }
    ];
    if (d.charges.excessWaiverDailyPence !== undefined) {
      const label = waiverSelected === true ? 'Excess waiver (taken)' : waiverSelected === false ? 'Excess waiver (offered, not taken)' : 'Excess waiver (optional)';
      const effect =
        waiverSelected === true ? 'charged for each day of hire; your excess is nil' : waiverSelected === false ? 'not charged; your excess applies in full' : 'if taken, reduces your excess to nil';
      chargeRows.push({ label, value: `${formatRate(d.charges.excessWaiverDailyPence, 'day')} excluding VAT; ${effect}` });
    }
    if (d.charges.additionalDriverDailyPence !== undefined) {
      const cap = d.charges.additionalDriverCapPence !== undefined ? `, capped at ${formatGBP(d.charges.additionalDriverCapPence)} for the hire` : '';
      chargeRows.push({ label: 'Non-standard risk driver supplement', value: `${formatRate(d.charges.additionalDriverDailyPence, 'day')} excluding VAT${cap} (GTA 5.4, industry benchmark)` });
    }
    if (d.charges.deliveryCollectionPence !== undefined) chargeRows.push({ label: 'Delivery and collection', value: `${formatGBP(d.charges.deliveryCollectionPence)} excluding VAT` });

    const driverRows = d.additionalDrivers.map((a) => [
      a.name,
      a.dateOfBirth ? formatDateLong(a.dateOfBirth) : 'Not supplied',
      licenceText(a.licence),
      yesNo(a.nonStandardRisk, 'No')
    ]);

    const delivery = d.hire.deliveryAddressLines?.filter((l) => l.trim() !== '').join(', ');

    const body = `
<h2>1. The parties and the agreement</h2>
${keyValueTable(partyRows)}
${clauses(1, [
  `This agreement is between ${escapeHtml(company.registeredName)} and ${escapeHtml(d.hirer.name)}. We will hire the vehicle described in section 2 to you on credit, on the terms below.`,
  `You need a replacement vehicle because your own vehicle, registration ${escapeHtml(formatRegistration(d.claim.vehicleRegistration))}, was damaged in a road traffic accident on ${escapeHtml(
    formatDateLong(d.claim.accidentDate)
  )}. We provide the vehicle on credit so that you do not pay for it while your claim against the party at fault is pursued. The hire charges remain your liability (section 5).`,
  `${escapeHtml(company.registeredName)} provides accident management, credit hire, recovery and storage services. We are not a firm of solicitors. You are free to take independent advice about this agreement at any time.`
])}

<h2>2. The vehicle</h2>
${keyValueTable(vehicleRows)}
${clauses(2, [
  `The GTA group is given for reference so that the insurer can see the class of vehicle hired. ${escapeHtml(GTA_BENCHMARK_NOTE)}`,
  `We will record the odometer reading and the condition of the vehicle, with photographs, at delivery and at collection. You will be asked to sign both records.`
])}

<h2>3. Hire period</h2>
${clauses(3, [
  `The hire starts at ${escapeHtml(formatDateTime(d.hire.startAt))}${delivery ? `, when the vehicle is delivered to ${escapeHtml(delivery)}` : ''}.`,
  `The hire is open-ended. It does not provide for a specific date or period of performance. It continues until the earliest of: (a) your own vehicle is repaired and returned to you; (b) you receive payment of a total-loss settlement for your own vehicle, and the short period we agree with you to source a replacement has passed; (c) you return the vehicle to us; or (d) we end the hire under section 10.`,
  `Because the term is open-ended, this agreement is not excluded from the right to cancel by regulation 28(1)(h) of the Consumer Contracts (Information, Cancellation and Additional Charges) Regulations 2013. Your right to cancel is set out in section 11.`,
  `We will monitor the repair or total-loss process and will tell you when the hire is due to end. You must return the vehicle, or make it available for collection, on the day the hire ends.`
])}

<h2>4. Charges</h2>
${keyValueTable(chargeRows)}
${clauses(4, [
  `Hire charges accrue for each day of hire from the start of the hire to the end of the hire, both days included. Each day or part of a day counts as one day.`,
  `VAT is added at the rate shown. The rate of VAT is set by law and may change during the hire.`,
  `No other charge is payable under this agreement unless it is listed above or arises from a breach of your obligations in sections 6 to 8.`
])}

<h2>5. Credit terms</h2>
${clauses(5, [
  `We give you credit for the hire charges. You do not pay anything when the hire starts, and you do not pay as the hire runs.`,
  `The hire charges are payable in not more than ${escapeHtml(instalments)} payments. Every payment falls due within twelve months beginning with the date of this agreement, and in any event no later than ${escapeHtml(
    formatDateLong(d.credit.finalPaymentDueBy)
  )}.`,
  `The credit is provided without interest or other charges. We will never charge you interest, a fee or any other charge for the credit. The amount you owe is the hire charges in section 4 and nothing more.`,
  `This agreement is intended to be an exempt agreement under article 60F(2) of the Financial Services and Markets Act 2000 (Regulated Activities) Order 2001 (not more than twelve payments, within twelve months beginning with the date of the agreement, without interest or other charges). It is therefore not a regulated consumer credit agreement under the Consumer Credit Act 1974.`,
  `Any sum we receive from the party at fault or their insurer for the hire charges is applied to what you owe under this agreement and discharges your liability to that extent. If the full hire charges are recovered, you owe nothing. You remain liable for any part of the hire charges that is not recovered, on the credit terms above.`
])}

<h2>6. Your obligations: use of the vehicle</h2>
${clauses(6, [
  `Only you and the additional drivers named in section 7 may drive the vehicle. Each driver must hold a full, valid licence and must not be disqualified.`,
  `You must use the vehicle lawfully, keep it secure, and keep it in the United Kingdom. You must not sub-hire or lend it, carry passengers or goods for payment, use it for racing, pace-making or off-road driving, or allow it to be driven by anyone under the influence of alcohol or drugs.`,
  `You are responsible for fuel, tolls and charges for use of the roads, and for keeping the vehicle in the condition in which it was delivered, allowing for fair wear and tear.`,
  `You must report any accident, damage, theft or breakdown involving the vehicle to us within 24 hours on the 24-hour accident line, and to the police where the law requires it. You must not admit liability on our behalf.`,
  `You must tell us at once if your address, telephone number, email address or licence details change during the hire.`
])}

<h2>7. Insurance, damage and excess</h2>
${dataTable(['Additional driver', 'Date of birth', 'Driving licence', 'Non-standard risk (GTA 5.4)'], driverRows, {
  caption: 'Additional drivers',
  emptyText: 'No additional drivers. Only the hirer may drive the vehicle.'
})}
${clauses(7, [
  `The vehicle is insured under our fleet policy for the drivers named in this agreement. Cover is for social, domestic and pleasure use and commuting unless we agree otherwise in writing.`,
  `You are responsible for the first ${escapeHtml(formatGBP(d.charges.excessPence))} of the cost of each incident of damage to or loss of the vehicle during the hire (the excess), unless the damage is caused by a third party whose insurer accepts liability. ${
    d.charges.excessWaiverDailyPence === undefined
      ? 'No excess waiver is included in this agreement.'
      : waiverSelected === true
        ? `You have taken the excess waiver at ${escapeHtml(formatRate(d.charges.excessWaiverDailyPence, 'day'))} excluding VAT, charged for each day of hire, so your excess is nil.`
        : waiverSelected === false
          ? `You have not taken the excess waiver offered at ${escapeHtml(formatRate(d.charges.excessWaiverDailyPence, 'day'))} excluding VAT, so the excess above applies in full.`
          : `If you take the excess waiver at ${escapeHtml(formatRate(d.charges.excessWaiverDailyPence, 'day'))} excluding VAT, your excess is reduced to nil.`
  }`,
  `You are responsible for the full cost of damage or loss caused by a breach of section 6, by a driver not named in this agreement, by misfuelling, or by driving the vehicle after a warning light or fault made it unsafe to do so.`,
  `${
    d.charges.additionalDriverDailyPence !== undefined
      ? `Where a named driver is a non-standard risk, a supplement of ${escapeHtml(formatRate(d.charges.additionalDriverDailyPence, 'day'))} excluding VAT applies${
          d.charges.additionalDriverCapPence !== undefined ? `, capped at ${escapeHtml(formatGBP(d.charges.additionalDriverCapPence))} for the hire` : ''
        }. GTA paragraph 5.4 reflects this as industry practice. ${escapeHtml(GTA_BENCHMARK_NOTE)}`
      : 'No non-standard risk driver supplement applies to this agreement.'
  }`
])}

<h2>8. Penalty charges, fines and parking charges: statement of liability</h2>
${clauses(8, [
  `You are liable for every fixed penalty notice, penalty charge notice, parking charge, congestion charge, road-user charge, toll and fine incurred in respect of the vehicle during the hire, including any authorised extension.`,
  `${
    licenceExpiryMissing
      ? 'This agreement sets out the particulars required by Schedule 2 to the Road Traffic (Owner Liability) Regulations 2000 (your full name, date of birth, permanent address and driving licence details, the vehicle, and the start and expected end of the hire), except your driving licence expiry date, which was not recorded when this agreement was generated. You must give it to us before the vehicle is delivered so that the particulars are complete.'
      : 'This agreement contains the particulars required by Schedule 2 to the Road Traffic (Owner Liability) Regulations 2000 (your full name, date of birth, permanent address and driving licence details, the vehicle, and the start and expected end of the hire).'
  } We will give those particulars, a copy of this agreement and your statement of liability to the enforcement authority or creditor so that liability for any notice is transferred to you. For private parking charges we will do so under paragraph 13 of Schedule 4 to the Protection of Freedoms Act 2012.`,
  `If we pay a penalty or charge that is your liability because the enforcement authority or creditor will not transfer it, you must repay us that amount. We will not add any administration fee to it.`
])}
${callout(`<p>${escapeHtml(statementOfLiabilityText(d.hirer.name, d.hirer.addressLines))}</p>${signatureFields([
  { label: 'Signed by the hirer', value: d.signatures?.hirerSignedAt ? `Signed electronically ${formatDateTime(d.signatures.hirerSignedAt)}` : '' },
  { label: 'Full name', value: d.hirer.name },
  { label: 'Date', value: d.signatures?.hirerSignedAt ? formatDateLong(d.signatures.hirerSignedAt) : '' }
])}`, 'Statement of liability')}

<h2>9. Recovering the hire charges from the party at fault</h2>
${clauses(9, [
  `The hire charges are a loss you have suffered because of the accident. You will pursue recovery of them, with your other losses, from the party at fault and their insurer.`,
  `We will assist you. You instruct us to correspond on your behalf with the insurer, the repairer, the engineer and anyone else involved in the claim; to prepare documents for your approval and signature; and to receive payment of the hire charges. We will keep you informed of every material step.`,
  `You must give us truthful and complete information, sign the Mitigation Questionnaire, the Statement of Need and the Statement of Means, provide the supporting documents we ask for (including three months' bank statements for every account, if your means are relied on), and tell us within one day of any offer of a replacement vehicle made to you by anyone. We will reply to any such offer in writing on your behalf.`,
  `You have a duty to keep your losses as low as is reasonable. If you receive an offer of a suitable replacement vehicle on reasonable terms you must consider it and tell us about it. We will help you assess the offer and will reply to it in writing on your behalf.`,
  `If court proceedings are needed, they are issued in your name. You act in person or instruct a solicitor of your choice. We do not conduct litigation and do not represent you in court, though we may help you prepare documents for your own signature and may accompany you at a small claims hearing where the court permits a lay representative.`,
  `Payment of the hire charges by the party at fault or their insurer may be made directly to us. Any such payment is applied under clause 5.5.`,
  `If you settle your claim directly with the insurer, you must include the hire charges in the settlement or tell us before you settle. If you do not, you remain liable for the hire charges under section 5.`
])}

<h2>10. Ending the hire</h2>
${clauses(10, [
  `The hire ends on the earliest event in clause 3.2. We may also end the hire by giving you one working day's notice if you break this agreement, if the vehicle is being used unlawfully or unsafely, or if your claim against the party at fault is discontinued or fails.`,
  `When the hire ends you must return the vehicle with all keys and documents to the address we give you, or make it available for collection. Hire charges stop on the day the vehicle is returned or collected.`,
  `If you keep the vehicle after we have told you the hire has ended, you are liable for the daily rate for each further day, and you may not be able to recover those charges from the party at fault.`
])}

<h2>11. Your right to cancel</h2>
${clauses(11, [
  `You have the right to cancel this contract within 14 days without giving any reason.`,
  `The cancellation period will expire after 14 days from the day of the conclusion of the contract${d.cancellation.periodEndsOn ? `, that is at the end of ${escapeHtml(formatDateLong(d.cancellation.periodEndsOn))}` : ''}.`,
  `To exercise the right to cancel, you must inform us (${escapeHtml(company.registeredName)}, ${escapeHtml(office)}, email ${escapeHtml(company.claimsEmail)}, telephone ${escapeHtml(
    company.accidentLine24h
  )}) of your decision to cancel this contract by a clear statement (for example a letter sent by post or an email). You may use the model cancellation form (Schedule 3 to the 2013 Regulations), which we gave you with this agreement${
    d.cancellation.sch3FormProvidedAt ? ` on ${escapeHtml(formatDateLong(d.cancellation.sch3FormProvidedAt))}` : ''
  }, but it is not obligatory.`,
  `To meet the cancellation deadline, it is sufficient for you to send your communication concerning your exercise of the right to cancel before the cancellation period has expired.`,
  `Effects of cancellation. If you cancel this contract, we will reimburse to you all payments received from you, without undue delay and not later than 14 days after the day on which we are informed about your decision to cancel. We will make the reimbursement using the same means of payment as you used for the initial transaction, unless you have expressly agreed otherwise; in any event, you will not incur any fees as a result of the reimbursement.`,
  `If you asked us to begin the hire during the cancellation period, you must pay us an amount which is in proportion to what has been performed until you have communicated to us your cancellation from this contract, in comparison with the full coverage of the contract. That amount is calculated at the daily rate in section 4 for the days the vehicle was on hire to you, on the credit terms in section 5. If you cancel, you must return the vehicle to us at once.`,
  `You lose the right to cancel once the hire has been fully performed, if performance began with your express request and your acknowledgement that the right is lost once the hire is fully performed.`,
  `We gave you this agreement and the information in it on a durable medium on ${escapeHtml(formatDateTime(d.cancellation.informationProvidedAt))}.`
])}

<h2>12. Complaints, data and general</h2>
${clauses(12, [
  `If you are unhappy with our service, write to ${escapeHtml(company.claimsEmail)} or to the registered office. We will acknowledge your complaint in writing and give you a written response.`,
  `We process your personal data to provide the hire, to pursue your claim on your instructions and to meet our legal obligations, including the transfer of penalty charges in section 8. Our privacy notice explains your rights${
    d.settings.icoRegistration ? `; our ICO registration number is ${escapeHtml(d.settings.icoRegistration)}` : ''
  }.`,
  `This agreement, together with the Mitigation Questionnaire, Statement of Need and Statement of Means you sign, is the whole agreement between us for the hire. Changes must be in writing and signed by both parties. English law applies and the courts of England and Wales have jurisdiction.`,
  `A document generated by our system carries the template version and a SHA-256 hash so that the version you signed can always be verified. If this agreement is re-executed, the re-executed copy states the actual date of signature and the version it supersedes.`
])}

<div class="sig-close">
<h2>13. Signatures</h2>
<p>By signing, you confirm that you have read this agreement, that the particulars in sections 1, 2 and 7 are correct, and that you received the cancellation information and model cancellation form before signing.</p>
<div class="sig-two">
  <div>
    <h3>The hirer</h3>
    ${signatureFields([
      { label: 'Signed', value: d.signatures?.hirerSignedAt ? `Signed electronically ${formatDateTime(d.signatures.hirerSignedAt)}` : '' },
      { label: 'Full name', value: d.hirer.name },
      { label: 'Date', value: d.signatures?.hirerSignedAt ? formatDateLong(d.signatures.hirerSignedAt) : '' }
    ])}
  </div>
  <div>
    <h3>For and on behalf of ${escapeHtml(company.registeredName)}</h3>
    ${signatureFields([
      { label: 'Signed', value: d.signatures?.ccgukSignedAt ? `Signed electronically ${formatDateTime(d.signatures.ccgukSignedAt)}` : '' },
      { label: 'Name and role', value: `${ccgukSignatory.name}, ${ccgukSignatory.role}` },
      { label: 'Date', value: d.signatures?.ccgukSignedAt ? formatDateLong(d.signatures.ccgukSignedAt) : '' }
    ])}
  </div>
</div>
${d.reExecutedOn ? reExecutionLine(d.reExecutedOn, d.supersedesVersion ?? '[previous version]') : ''}
<div class="integrity">
  <div>Agreement ${escapeHtml(d.agreementNumber)} generated from ledger data on ${escapeHtml(formatDateTime(d.createdAt))}. Template agreement.credit_hire version ${escapeHtml(creditHireAgreementTemplate.version)}.</div>
  <div>Document hash (SHA-256): <span class="hash">{{SHA256}}</span></div>
</div>
</div>`;

    return baseLayout({
      title: 'Credit Hire Agreement',
      subtitle: `Agreement number ${d.agreementNumber}`,
      kind: 'agreement',
      reference: d.claim.ourReference,
      theirReference: d.claim.theirReference,
      date: d.date,
      recipient: hirerRecipient(d.hirer),
      settings: d.settings,
      showCompanyBlock: true,
      meta: [{ label: 'Agreement', value: d.agreementNumber }],
      closing: '',
      extraCss: FORMS_CSS,
      bodyHtml: body
    });
  }
};
registerTemplate(creditHireAgreementTemplate);

// ---------------------------------------------------------------------------
// form.cancellation_sch3 — CCR 2013 Schedule 3 Part B model cancellation form
// ---------------------------------------------------------------------------

export interface CancellationFormData extends BaseDocumentData {
  agreementNumber: string;
  /** The date the agreement was made ("ordered on"). */
  agreementDate: DateLike;
  hirer: HirerDetails;
  vehicle: { registration: string; makeModel: string };
}

export const cancellationSch3Template: Template<CancellationFormData> = {
  id: 'form.cancellation_sch3',
  version: '1.0.0',
  kind: 'form',
  title: 'Model cancellation form',
  recipientRole: 'client',
  description: 'Consumer Contracts Regulations 2013 Schedule 3 Part B model cancellation form, pre-filled with our details and the hire it relates to.',
  requiredData: [...BASE_REQUIRED, 'agreementNumber', 'agreementDate', 'hirer.name', 'hirer.addressLines', 'vehicle.registration', 'vehicle.makeModel'],
  sample: () => ({
    ...sampleBaseData({ date: '2026-08-10', recipient: undefined }),
    agreementNumber: 'CHA-2026-00012',
    agreementDate: '2026-08-10',
    hirer: { name: 'Ms Jane Example', addressLines: ['1 Example Street', 'Example Town', 'EX2 2BB'], email: 'jane.example@example.test' },
    vehicle: { registration: 'LK26CCG', makeModel: 'Volkswagen Golf 1.5 TSI Life' }
  }),
  render: (d) => {
    const company = brand.company;
    const office = d.settings.registeredOffice.trim() || '[registered office]';
    const body = `
<p>Complete and return this form only if you wish to cancel the contract. You may also cancel by any other clear statement, for example an email to ${escapeHtml(
      company.claimsEmail
    )} quoting agreement ${escapeHtml(d.agreementNumber)}. You do not have to use this form. (Consumer Contracts (Information, Cancellation and Additional Charges) Regulations 2013, Schedule 3, Part B.)</p>
<div class="form-box">
  <p><strong>To:</strong> ${escapeHtml(company.registeredName)}, ${escapeHtml(office)}. Email: ${escapeHtml(company.claimsEmail)}.</p>
  <p>I hereby give notice that I cancel my contract for the supply of the following service:</p>
  <p><span class="fill">Credit hire of a replacement vehicle, ${escapeHtml(d.vehicle.makeModel)}, registration ${escapeHtml(formatRegistration(d.vehicle.registration))}, under agreement ${escapeHtml(
      d.agreementNumber
    )}</span></p>
  <p>Ordered on: <span class="fill">${escapeHtml(formatDateLong(d.agreementDate))}</span></p>
  <p>Name of consumer: <span class="fill">${escapeHtml(d.hirer.name)}</span></p>
  <p>Address of consumer: <span class="fill">${escapeHtml(d.hirer.addressLines.filter((l) => l.trim() !== '').join(', '))}</span></p>
  <p>Signature of consumer (only if this form is notified on paper):</p>
  <span class="blank"></span>
  <p>Date: <span class="fill">&nbsp;</span></p>
</div>
<p class="small muted">Our reference ${escapeHtml(d.claim.ourReference)}. If you cancel after asking us to start the hire, you pay for the days the vehicle was on hire to you, in proportion to the full contract, as explained in section 11 of the agreement. Please return the vehicle to us at once if you cancel.</p>`;
    return baseLayout({
      title: 'Model cancellation form',
      subtitle: `Agreement ${d.agreementNumber}`,
      kind: 'form',
      reference: d.claim.ourReference,
      date: d.date,
      recipient: hirerRecipient(d.hirer),
      settings: d.settings,
      meta: [{ label: 'Agreement', value: d.agreementNumber }],
      closing: '',
      extraCss: FORMS_CSS,
      bodyHtml: body
    });
  }
};
registerTemplate(cancellationSch3Template);

// ---------------------------------------------------------------------------
// form.express_request_to_start — CCR 2013 reg 36
// ---------------------------------------------------------------------------

export interface ExpressRequestData extends BaseDocumentData {
  agreementNumber: string;
  hirer: HirerDetails;
  vehicle: { registration: string; makeModel: string };
  hire: { startAt: ISODateTime };
  charges: { dailyRatePence: Pence; vatRate: number; excessWaiverDailyPence?: Pence };
  /** When the Schedule 2 information and the Schedule 3 form were given to the consumer. */
  cancellationInfoProvidedAt: DateLike;
  signedAt?: ISODateTime;
  /** Creation timestamp — the floor for signedAt. */
  createdAt: ISODateTime;
}

export const expressRequestToStartTemplate: Template<ExpressRequestData> = {
  id: 'form.express_request_to_start',
  version: '1.0.0',
  kind: 'form',
  title: 'Express request to begin the hire during the cancellation period',
  recipientRole: 'client',
  description: 'Consumer Contracts Regulations 2013 reg 36: the consumer’s express request, on a durable medium, to start the hire within the cancellation period, with the acknowledgement of proportionate payment.',
  requiredData: [
    ...BASE_REQUIRED,
    'agreementNumber',
    'createdAt',
    'hirer.name',
    'hirer.addressLines',
    'vehicle.registration',
    'vehicle.makeModel',
    'hire.startAt',
    'charges.dailyRatePence',
    'charges.vatRate',
    'cancellationInfoProvidedAt'
  ],
  sample: () => ({
    ...sampleBaseData({ date: '2026-08-10', recipient: undefined }),
    agreementNumber: 'CHA-2026-00012',
    createdAt: '2026-08-10T09:05:00+01:00',
    hirer: { name: 'Ms Jane Example', addressLines: ['1 Example Street', 'Example Town', 'EX2 2BB'], email: 'jane.example@example.test' },
    vehicle: { registration: 'LK26CCG', makeModel: 'Volkswagen Golf 1.5 TSI Life' },
    hire: { startAt: '2026-08-10T09:30:00+01:00' },
    charges: { dailyRatePence: 4980, vatRate: 0.2, excessWaiverDailyPence: 1200 },
    cancellationInfoProvidedAt: '2026-08-10T09:05:00+01:00',
    signedAt: '2026-08-10T09:43:00+01:00'
  }),
  render: (d) => {
    if (d.signedAt) assertNotBeforeCreation('signedAt', d.signedAt, d.createdAt);
    const company = brand.company;
    const waiver = d.charges.excessWaiverDailyPence !== undefined ? ` and the excess waiver at ${formatRate(d.charges.excessWaiverDailyPence, 'day')} excluding VAT if I have chosen it` : '';
    const body = `
<p>Consumer Contracts (Information, Cancellation and Additional Charges) Regulations 2013, regulation 36. This request is made on a durable medium and is kept with the agreement.</p>
${keyValueTable([
  { label: 'Agreement', value: d.agreementNumber },
  { label: 'Hirer', value: d.hirer.name },
  { label: 'Vehicle', value: `${d.vehicle.makeModel}, registration ${formatRegistration(d.vehicle.registration)}` },
  { label: 'Hire to start', value: formatDateTime(d.hire.startAt) }
])}
<h2>My request</h2>
${numberedList([
  `I confirm that I received the information about my right to cancel, and the model cancellation form, on ${formatDateTime(d.cancellationInfoProvidedAt)}, before I signed the agreement.`,
  `I expressly request that ${company.registeredName} begins supplying the hire vehicle under agreement ${d.agreementNumber} at ${formatDateTime(d.hire.startAt)}, which is before the end of the 14-day cancellation period.`,
  `I understand that if I cancel the agreement within the cancellation period I must pay for the hire supplied up to the time I tell ${company.registeredName} that I am cancelling. The amount will be in proportion to what has been supplied compared with the full contract, calculated at the daily rate in the agreement, ${formatRate(
    d.charges.dailyRatePence,
    'day'
  )} plus VAT at ${formatPercent(d.charges.vatRate)}${waiver}.`,
  `I understand that the credit terms in section 5 of the agreement apply to that amount: no interest or charges, payable in not more than twelve payments within twelve months beginning with the date of the agreement.`,
  `I acknowledge that once the hire has been fully performed I will lose my right to cancel.`,
  `I understand that if I cancel I must return the vehicle at once.`
])}
<h2>Signature</h2>
${signatureFields([
  { label: 'Signed', value: d.signedAt ? `Signed electronically ${formatDateTime(d.signedAt)}` : '' },
  { label: 'Full name', value: d.hirer.name },
  { label: 'Date', value: d.signedAt ? formatDateLong(d.signedAt) : '' }
])}
<div class="integrity"><div>Form generated on ${escapeHtml(formatDateTime(d.createdAt))}. Template form.express_request_to_start version ${escapeHtml(expressRequestToStartTemplate.version)}.</div></div>`;
    return baseLayout({
      title: 'Express request to begin the hire during the cancellation period',
      subtitle: `Agreement ${d.agreementNumber}`,
      kind: 'form',
      reference: d.claim.ourReference,
      date: d.date,
      recipient: hirerRecipient(d.hirer),
      settings: d.settings,
      meta: [{ label: 'Agreement', value: d.agreementNumber }],
      closing: '',
      extraCss: FORMS_CSS,
      bodyHtml: body
    });
  }
};
registerTemplate(expressRequestToStartTemplate);

// ---------------------------------------------------------------------------
// form.mitigation_questionnaire — GTA Appendix C style (industry benchmark)
// ---------------------------------------------------------------------------

export interface MitigationOffer {
  receivedAt: DateLike;
  /** Whether the offer came before the hire was agreed or during the hire (set by the API from the register and the hire record). */
  stage: 'before_hire' | 'during_hire';
  offerorName: string;
  /** phone, email, letter, sms, whatsapp, portal, via_client */
  channel: string;
  vehicleClassOffered?: string;
  dailyRatePence?: Pence;
  rateIncludesVat?: boolean;
  /** Excess, mileage limit, delivery, insurance, duration — as recorded in the intervention register. */
  termsSummary?: string;
  clientDecision: 'accepted' | 'declined' | 'pending';
  /** The client's own reasons, verbatim. */
  clientReasons?: string;
}

export interface MitigationQuestionnaireData extends BaseDocumentData {
  hirer: HirerDetails;
  hire: { agreementNumber: string; agreedAt: DateLike; startAt: DateLike; vehicleDescription: string; registration: string; gtaGroup: string };
  /** Every offer in the intervention register for this claim. Empty when none was received. */
  offers: MitigationOffer[];
  /** When we explained the duty to mitigate to the client. */
  dutyExplainedAt: DateLike;
  confirmsDutyExplained: boolean;
  /** The client's own words: why a replacement vehicle was needed. */
  needSummary: string;
  otherVehicleAvailable: boolean;
  otherVehicleDetail?: string;
  /** Anything else the client wishes to say, verbatim. */
  furtherInformation?: string;
  signedAt?: ISODateTime;
  createdAt: ISODateTime;
}

const CHANNEL_LABELS: Record<string, string> = {
  phone: 'Telephone call',
  email: 'Email',
  letter: 'Letter',
  sms: 'Text message',
  whatsapp: 'WhatsApp',
  portal: 'Online portal',
  via_client: 'Direct to the client'
};

const DECISION_LABELS: Record<MitigationOffer['clientDecision'], string> = { accepted: 'Accepted', declined: 'Declined', pending: 'Not yet decided' };

export const mitigationQuestionnaireTemplate: Template<MitigationQuestionnaireData> = {
  id: 'form.mitigation_questionnaire',
  version: '1.0.0',
  kind: 'form',
  title: 'Mitigation Questionnaire and Statement of Truth',
  recipientRole: 'client',
  description: 'GTA Appendix C style questionnaire (industry benchmark): offers of a replacement vehicle received, by whom, when, on what terms, and why declined; the duty to mitigate; signed under a statement of truth.',
  requiredData: [
    ...BASE_REQUIRED,
    'createdAt',
    'hirer.name',
    'hirer.addressLines',
    'hire.agreementNumber',
    'hire.agreedAt',
    'hire.startAt',
    'hire.vehicleDescription',
    'hire.registration',
    'hire.gtaGroup',
    'offers',
    'dutyExplainedAt',
    'confirmsDutyExplained',
    'needSummary',
    'otherVehicleAvailable'
  ],
  sample: () => ({
    ...sampleBaseData({ date: '2026-09-03', recipient: undefined }),
    createdAt: '2026-09-03T10:00:00+01:00',
    hirer: { name: 'Ms Jane Example', addressLines: ['1 Example Street', 'Example Town', 'EX2 2BB'], occupation: 'Community nurse' },
    hire: { agreementNumber: 'CHA-2026-00012', agreedAt: '2026-08-10', startAt: '2026-08-10T09:30:00+01:00', vehicleDescription: 'Volkswagen Golf 1.5 TSI Life', registration: 'LK26CCG', gtaGroup: 'M' },
    offers: [
      {
        receivedAt: '2026-08-12T15:20:00+01:00',
        stage: 'during_hire',
        offerorName: 'Example Insurance plc (third-party claims handler)',
        channel: 'phone',
        vehicleClassOffered: 'Small hatchback (group B)',
        dailyRatePence: 2037,
        rateIncludesVat: false,
        termsSummary: 'Excess of £1,000; 100 miles per day; delivery in 3 to 5 working days; insurance included. Duration not stated.',
        clientDecision: 'declined',
        clientReasons:
          'The call came two days after my hire had already started. The car offered was smaller than mine and I carry equipment and patients’ supplies for work. I was told it would take three to five working days to arrive and that I would be liable for a £1,000 excess. I told the caller I would pass the offer to Courtesy Cars, which I did the same afternoon.'
      }
    ],
    dutyExplainedAt: '2026-08-10',
    confirmsDutyExplained: true,
    needSummary:
      'I am a community nurse and drive to patients’ homes across the district every working day. My own car could not be driven after the accident. Without a car I could not do my job, take my son to school or get to the supermarket, which is four miles away with no direct bus.',
    otherVehicleAvailable: false,
    otherVehicleDetail: 'My partner has a van which he uses for work from 6am to 6pm. It was not available to me.',
    signedAt: '2026-09-03T18:12:00+01:00'
  }),
  render: (d) => {
    if (d.signedAt) assertNotBeforeCreation('signedAt', d.signedAt, d.createdAt);
    const before = d.offers.filter((o) => o.stage === 'before_hire');
    const during = d.offers.filter((o) => o.stage === 'during_hire');
    const offerRows = d.offers.map((o) => [
      formatDateTime(o.receivedAt),
      o.stage === 'before_hire' ? 'Before the hire was agreed' : 'During the hire',
      o.offerorName,
      CHANNEL_LABELS[o.channel.toLowerCase()] ?? o.channel,
      o.vehicleClassOffered ?? 'Not stated',
      o.dailyRatePence !== undefined ? `${formatRate(o.dailyRatePence, 'day')}${o.rateIncludesVat === undefined ? '' : o.rateIncludesVat ? ' including VAT' : ' excluding VAT'}` : 'Not stated',
      o.termsSummary ?? 'Not stated',
      DECISION_LABELS[o.clientDecision]
    ]);
    const reasons = d.offers
      .map((o, i) => qa(`Offer ${i + 1} (${formatDateTime(o.receivedAt)}, ${o.offerorName}): why was this offer not acceptable to you, or what did you decide?`, nl2p(o.clientReasons)))
      .join('\n');

    const body = `
<p>This questionnaire records, in your own words, whether anyone offered you a replacement vehicle and what you decided. It is signed under a statement of truth and is sent to the insurer with the payment pack. It follows the form of GTA Appendix C, which is used across the industry. ${escapeHtml(
      GTA_BENCHMARK_NOTE
    )}</p>
${keyValueTable([
  { label: 'Your name', value: d.hirer.name },
  { label: 'Address', value: d.hirer.addressLines.filter((l) => l.trim() !== '').join(', ') },
  { label: 'Your vehicle', value: `${formatRegistration(d.claim.vehicleRegistration)}${d.claim.vehicleDescription ? ` — ${d.claim.vehicleDescription}` : ''}` },
  { label: 'Accident', value: formatDateLong(d.claim.accidentDate) },
  { label: 'Hire agreed with us', value: formatDateLong(d.hire.agreedAt) },
  { label: 'Hire vehicle', value: `${d.hire.vehicleDescription}, ${formatRegistration(d.hire.registration)}, GTA group ${d.hire.gtaGroup} (industry benchmark)` },
  { label: 'Hire started', value: formatDateTime(d.hire.startAt) },
  { label: 'Agreement', value: d.hire.agreementNumber }
], 'Part A — You and the hire')}

<h2>Part B — Offers of a replacement vehicle</h2>
${qa('1. Before you agreed to hire a vehicle from us, did anyone (the other driver’s insurer, your own insurer, a broker, a repairer or anyone else) offer you a replacement vehicle?', `<p>${yesNo(before.length > 0)}</p>`)}
${qa('2. Since the hire started, has anyone offered you a replacement vehicle?', `<p>${yesNo(during.length > 0)}</p>`)}
${dataTable(['Date and time', 'Stage', 'Offered by', 'How', 'Vehicle offered', 'Rate quoted', 'Terms', 'Your decision'], offerRows, {
  caption: '3. Details of every offer received',
  emptyText: 'No offer of a replacement vehicle was received from anyone. This matches our intervention register for this claim.'
})}
${reasons}

<h2>Part C — The duty to mitigate</h2>
${qa(
  `4. On ${formatDateLong(d.dutyExplainedAt)} we explained to you that you must keep your losses as low as is reasonable; that if anyone offers you a replacement vehicle you should tell us the same day so that we can reply in writing; and that you should consider any suitable offer made on reasonable terms. Do you confirm that this was explained to you?`,
  `<p>${yesNo(d.confirmsDutyExplained)}</p>`
)}

<h2>Part D — Your need for a replacement vehicle</h2>
${qa('5. Why did you need a replacement vehicle?', nl2p(d.needSummary))}
${qa('6. Did you have the use of another vehicle while your own was off the road?', `<p>${yesNo(d.otherVehicleAvailable)}</p>${nl2p(d.otherVehicleDetail)}`)}
${d.furtherInformation ? qa('7. Is there anything else you wish to say about the offers or your need for a vehicle?', nl2p(d.furtherInformation)) : ''}

${statementOfTruth({ kind: 'claimant', documentNoun: 'mitigation statement', signatoryName: d.hirer.name, date: d.signedAt })}
<div class="integrity"><div>Questionnaire generated from the intervention register on ${escapeHtml(formatDateTime(d.createdAt))}. Template form.mitigation_questionnaire version ${escapeHtml(mitigationQuestionnaireTemplate.version)}.${
      d.signedAt ? ` Signed electronically ${escapeHtml(formatDateTime(d.signedAt))}.` : ''
    }</div></div>`;
    return baseLayout({
      title: 'Mitigation Questionnaire and Statement of Truth',
      subtitle: `Agreement ${d.hire.agreementNumber}`,
      kind: 'form',
      reference: d.claim.ourReference,
      theirReference: d.claim.theirReference,
      date: d.date,
      recipient: hirerRecipient(d.hirer),
      settings: d.settings,
      closing: '',
      extraCss: FORMS_CSS,
      bodyHtml: body
    });
  }
};
registerTemplate(mitigationQuestionnaireTemplate);

// ---------------------------------------------------------------------------
// form.statement_of_means — Statement of Means (07)
// ---------------------------------------------------------------------------

export interface MeansLine {
  label: string;
  /** Monthly amount in pence. */
  monthlyPence: Pence;
  note?: string;
}

export interface MeansBankAccount {
  bankName: string;
  accountType: string;
  /** Last four digits only — the full number never prints. */
  lastFour: string;
  /** Balance on the date of the accident, as shown on the statement. */
  balanceAtAccidentPence: Pence;
  /** Three months' statements enclosed. */
  statementsEnclosed: boolean;
}

export interface MeansCreditCard {
  provider: string;
  limitPence: Pence;
  balanceAtAccidentPence: Pence;
  statementEnclosed: boolean;
}

export interface MeansCreditFacility {
  lender: string;
  /** Loan, overdraft, hire purchase, buy-now-pay-later… */
  kind: string;
  balancePence: Pence;
  monthlyPaymentPence?: Pence;
  /** Overdraft limit or remaining facility, if any. */
  availablePence?: Pence;
}

export interface StatementOfMeansData extends BaseDocumentData {
  claimant: HirerDetails;
  employmentStatus: string;
  dependants: Array<{ relationship: string; age?: number; note?: string }>;
  income: MeansLine[];
  outgoings: MeansLine[];
  /** Totals held by the API; when omitted they are summed from the lines. */
  totals?: { monthlyIncomePence?: Pence; monthlyOutgoingsPence?: Pence };
  bankAccounts: MeansBankAccount[];
  savings: Array<{ description: string; balancePence: Pence }>;
  creditCards: MeansCreditCard[];
  otherCredit: MeansCreditFacility[];
  vehiclesOwned?: string[];
  /** The two central questions, answered in the client's own words. */
  couldHaveHiredWithoutCredit: boolean;
  couldHaveHiredExplanation: string;
  couldHaveUsedCredit: boolean;
  couldHaveUsedCreditExplanation: string;
  /** Payslips, benefit letters, accounts — what is enclosed. */
  incomeEvidenceEnclosed: string[];
  signedAt?: ISODateTime;
  createdAt: ISODateTime;
}

export const statementOfMeansTemplate: Template<StatementOfMeansData> = {
  id: 'form.statement_of_means',
  version: '1.0.0',
  kind: 'form',
  title: 'Statement of Means (07)',
  recipientRole: 'client',
  description: 'Impecuniosity evidence: income, outgoings, savings, credit cards, other credit, dependants, bank accounts with three months’ statements, and whether the claimant could have hired without credit; statement of truth.',
  requiredData: [
    ...BASE_REQUIRED,
    'createdAt',
    'claimant.name',
    'claimant.addressLines',
    'employmentStatus',
    'dependants',
    'income',
    'outgoings',
    'bankAccounts',
    'savings',
    'creditCards',
    'otherCredit',
    'couldHaveHiredWithoutCredit',
    'couldHaveHiredExplanation',
    'couldHaveUsedCredit',
    'couldHaveUsedCreditExplanation',
    'incomeEvidenceEnclosed'
  ],
  sample: () => ({
    ...sampleBaseData({ date: '2026-08-11', recipient: undefined }),
    createdAt: '2026-08-11T11:30:00+01:00',
    claimant: { name: 'Ms Jane Example', addressLines: ['1 Example Street', 'Example Town', 'EX2 2BB'], dateOfBirth: '1988-05-14', occupation: 'Community nurse' },
    employmentStatus: 'Employed full time, NHS community trust (band 5)',
    dependants: [{ relationship: 'Son', age: 7 }],
    income: [
      { label: 'Net salary', monthlyPence: 214500 },
      { label: 'Child benefit', monthlyPence: 11240 }
    ],
    outgoings: [
      { label: 'Rent', monthlyPence: 95000 },
      { label: 'Council tax', monthlyPence: 14200 },
      { label: 'Gas and electricity', monthlyPence: 16500 },
      { label: 'Food and household', monthlyPence: 42000 },
      { label: 'Childcare (after-school club)', monthlyPence: 18000 },
      { label: 'Car finance on own vehicle', monthlyPence: 21900 },
      { label: 'Car insurance, fuel and phone', monthlyPence: 19500 }
    ],
    totals: { monthlyIncomePence: 225740, monthlyOutgoingsPence: 227100 },
    bankAccounts: [
      { bankName: '[Bank A]', accountType: 'Current account', lastFour: '4412', balanceAtAccidentPence: 8630, statementsEnclosed: true },
      { bankName: '[Bank B]', accountType: 'Savings account', lastFour: '0091', balanceAtAccidentPence: 15000, statementsEnclosed: true }
    ],
    savings: [{ description: 'Savings account [Bank B] ending 0091', balancePence: 15000 }],
    creditCards: [{ provider: '[Card provider]', limitPence: 120000, balanceAtAccidentPence: 113450, statementEnclosed: true }],
    otherCredit: [{ lender: '[Finance company]', kind: 'Hire purchase on own vehicle', balancePence: 486000, monthlyPaymentPence: 21900 }],
    vehiclesOwned: ['Volkswagen Golf 1.5 TSI Life, AB12 CDE (the damaged vehicle, on finance)'],
    couldHaveHiredWithoutCredit: false,
    couldHaveHiredExplanation:
      'I had £86.30 in my current account and £150 in savings on the day of the accident. My rent and bills go out on the 1st. I could not have paid a hire deposit or the daily hire charges and still paid my rent and fed my son.',
    couldHaveUsedCredit: false,
    couldHaveUsedCreditExplanation: 'My credit card had £65.50 left before the limit. I have no overdraft. I asked my bank about a loan in June and was refused.',
    incomeEvidenceEnclosed: ['Payslips for May, June and July 2026', 'Child benefit award letter', 'Bank statements for both accounts, 9 May to 9 August 2026', 'Credit card statements for the same period'],
    signedAt: '2026-08-11T19:05:00+01:00'
  }),
  render: (d) => {
    if (d.signedAt) assertNotBeforeCreation('signedAt', d.signedAt, d.createdAt);
    const incomeTotal = d.totals?.monthlyIncomePence ?? sumPence(d.income.map((l) => l.monthlyPence));
    const outgoingsTotal = d.totals?.monthlyOutgoingsPence ?? sumPence(d.outgoings.map((l) => l.monthlyPence));

    const moneyTable = (lines: MeansLine[], caption: string, totalLabel: string, totalPence: Pence): string => {
      const rows = lines.map((l) => [l.label + (l.note ? ` (${l.note})` : ''), formatGBP(l.monthlyPence)]);
      rows.push([totalLabel, formatGBP(totalPence)]);
      return dataTable(['Item', 'Per month'], rows, { caption, numeric: [1], emptyText: 'None' });
    };

    const personalRows = [
      { label: 'Full name', value: d.claimant.name },
      { label: 'Address', value: d.claimant.addressLines.filter((l) => l.trim() !== '').join(', ') }
    ];
    if (d.claimant.dateOfBirth) personalRows.push({ label: 'Date of birth', value: formatDateLong(d.claimant.dateOfBirth) });
    if (d.claimant.occupation) personalRows.push({ label: 'Occupation', value: d.claimant.occupation });
    personalRows.push({ label: 'Employment status', value: d.employmentStatus });
    personalRows.push({ label: 'Date of accident', value: formatDateLong(d.claim.accidentDate) });

    const body = `
${callout(
  `<p>A court allows the full credit hire rate only if you could not reasonably have afforded to hire a replacement vehicle and pay for it yourself. Your claim must say so and you must prove it with documents: three months’ bank statements for every account, credit card statements, and payslips or benefit letters (Diriye v Bojaj [2020] EWCA Civ 1400). If the documents are not provided, the court may treat you as able to pay the basic hire rate, and the difference may not be recovered. Every figure below is as you have given it to us. The position is as at the date of the accident, ${escapeHtml(
    formatDateLong(d.claim.accidentDate)
  )}.</p>`,
  'Why this statement matters'
)}
${keyValueTable(personalRows, '1. About you')}
${dataTable(['Relationship', 'Age', 'Note'], d.dependants.map((x) => [x.relationship, x.age !== undefined ? formatNumber(x.age) : '', x.note ?? '']), {
  caption: '2. People who depend on you financially',
  emptyText: 'No dependants.'
})}
${moneyTable(d.income, '3. Income (net, per month)', 'Total income', incomeTotal)}
${moneyTable(d.outgoings, '4. Regular outgoings (per month)', 'Total outgoings', outgoingsTotal)}
${dataTable(
  ['Bank', 'Account', 'Ending', 'Balance on the accident date', 'Three months’ statements enclosed'],
  d.bankAccounts.map((a) => [a.bankName, a.accountType, `····${a.lastFour}`, formatGBP(a.balanceAtAccidentPence), yesNo(a.statementsEnclosed)]),
  { caption: '5. Bank and building society accounts (every account, including joint accounts)', numeric: [3], emptyText: 'No bank account.' }
)}
${dataTable(['Savings or investment', 'Balance on the accident date'], d.savings.map((s) => [s.description, formatGBP(s.balancePence)]), {
  caption: '6. Savings and investments',
  numeric: [1],
  emptyText: 'No savings or investments.'
})}
${dataTable(
  ['Provider', 'Credit limit', 'Balance on the accident date', 'Available', 'Statement enclosed'],
  d.creditCards.map((c) => [c.provider, formatGBP(c.limitPence), formatGBP(c.balanceAtAccidentPence), formatGBP(c.limitPence - c.balanceAtAccidentPence), yesNo(c.statementEnclosed)]),
  { caption: '7. Credit cards', numeric: [1, 2, 3], emptyText: 'No credit cards.' }
)}
${dataTable(
  ['Lender', 'Type', 'Balance', 'Monthly payment', 'Facility available'],
  d.otherCredit.map((f) => [f.lender, f.kind, formatGBP(f.balancePence), f.monthlyPaymentPence !== undefined ? formatGBP(f.monthlyPaymentPence) : '', f.availablePence !== undefined ? formatGBP(f.availablePence) : 'None']),
  { caption: '8. Loans, overdrafts and other credit', numeric: [2, 3, 4], emptyText: 'No loans, overdrafts or other credit.' }
)}
${d.vehiclesOwned && d.vehiclesOwned.length > 0 ? `<h3>9. Vehicles owned by you or your household</h3>${numberedList(d.vehiclesOwned)}` : '<h3>9. Vehicles owned by you or your household</h3><p>None other than the damaged vehicle.</p>'}

<h2>10. Could you have paid for a replacement vehicle yourself?</h2>
${qa('At the time of the accident, could you have hired a replacement vehicle and paid the deposit and daily charges yourself, without borrowing and without going without essentials?', `<p>${yesNo(d.couldHaveHiredWithoutCredit)}</p>${nl2p(d.couldHaveHiredExplanation)}`)}
${qa('Could you have paid for a hire vehicle using a credit card, overdraft or loan?', `<p>${yesNo(d.couldHaveUsedCredit)}</p>${nl2p(d.couldHaveUsedCreditExplanation)}`)}

<h2>11. Documents enclosed</h2>
${numberedList(d.incomeEvidenceEnclosed)}
${statementOfTruth({ kind: 'claimant', documentNoun: 'statement of means', signatoryName: d.claimant.name, date: d.signedAt })}
<div class="integrity"><div>Statement generated on ${escapeHtml(formatDateTime(d.createdAt))} from the answers you gave. Template form.statement_of_means version ${escapeHtml(statementOfMeansTemplate.version)}.${
      d.signedAt ? ` Signed electronically ${escapeHtml(formatDateTime(d.signedAt))}.` : ''
    }</div></div>`;
    return baseLayout({
      title: 'Statement of Means (07)',
      subtitle: 'Your financial position at the date of the accident',
      kind: 'form',
      reference: d.claim.ourReference,
      date: d.date,
      recipient: hirerRecipient(d.claimant),
      settings: d.settings,
      closing: '',
      extraCss: FORMS_CSS,
      bodyHtml: body
    });
  }
};
registerTemplate(statementOfMeansTemplate);

// ---------------------------------------------------------------------------
// form.statement_of_need
// ---------------------------------------------------------------------------

export interface NeedJourney {
  /** Day of the week or the date. */
  day: string;
  from: string;
  to: string;
  purpose: string;
  miles: number;
  /** Who travelled: "Me", "Me and my son" */
  passengers?: string;
}

export interface HouseholdVehicle {
  description: string;
  owner: string;
  availableToClaimant: boolean;
  whyNotAvailable?: string;
}

export interface StatementOfNeedData extends BaseDocumentData {
  claimant: HirerDetails;
  employer?: string;
  workPattern?: string;
  workAddress?: string;
  /** The client's own words. */
  whyNeeded: string;
  /** A typical week's actual journeys. */
  journeys: NeedJourney[];
  /** Weekly mileage from the client's own account; when omitted the journeys are summed. */
  weeklyMilesTotal?: number;
  dependants: Array<{ relationship: string; age?: number; needs?: string }>;
  householdVehicles: HouseholdVehicle[];
  publicTransportConsidered: string;
  mobilityNeeds?: string;
  ownVehicleRoadworthy: boolean;
  ownVehicleLocation?: string;
  signedAt?: ISODateTime;
  createdAt: ISODateTime;
}

export const statementOfNeedTemplate: Template<StatementOfNeedData> = {
  id: 'form.statement_of_need',
  version: '1.0.0',
  kind: 'form',
  title: 'Statement of Need',
  recipientRole: 'client',
  description: 'Need for a replacement vehicle: occupation, a week’s actual journeys, dependants, other household vehicles, public transport and mobility needs; statement of truth.',
  requiredData: [
    ...BASE_REQUIRED,
    'createdAt',
    'claimant.name',
    'claimant.addressLines',
    'claimant.occupation',
    'whyNeeded',
    'journeys',
    'dependants',
    'householdVehicles',
    'publicTransportConsidered',
    'ownVehicleRoadworthy'
  ],
  sample: () => ({
    ...sampleBaseData({ date: '2026-08-10', recipient: undefined }),
    createdAt: '2026-08-10T09:50:00+01:00',
    claimant: { name: 'Ms Jane Example', addressLines: ['1 Example Street', 'Example Town', 'EX2 2BB'], occupation: 'Community nurse' },
    employer: 'Example NHS Community Trust',
    workPattern: 'Monday to Friday, 8am to 4.30pm, with one Saturday in four',
    workAddress: 'Example Health Centre, Example Town, then patients’ homes across the district',
    whyNeeded:
      'I visit between eight and twelve patients a day in their homes. The visits are spread across the district, up to fifteen miles apart, and I carry dressings, a sharps bin and equipment. There is no pool car at work. Without a car I cannot do my job.',
    journeys: [
      { day: 'Monday', from: 'Home', to: 'Health centre, then 9 patient visits', purpose: 'Work', miles: 46, passengers: 'Me' },
      { day: 'Tuesday', from: 'Home', to: 'School, health centre, 10 patient visits', purpose: 'School run and work', miles: 52, passengers: 'Me and my son (school run)' },
      { day: 'Wednesday', from: 'Home', to: 'Health centre, 8 patient visits, pharmacy', purpose: 'Work', miles: 41, passengers: 'Me' },
      { day: 'Thursday', from: 'Home', to: 'School, health centre, 11 patient visits', purpose: 'School run and work', miles: 58, passengers: 'Me and my son (school run)' },
      { day: 'Friday', from: 'Home', to: 'Health centre, 9 patient visits', purpose: 'Work', miles: 44, passengers: 'Me' },
      { day: 'Saturday', from: 'Home', to: 'Supermarket, my mother’s house', purpose: 'Shopping and caring visit', miles: 18, passengers: 'Me and my son' },
      { day: 'Sunday', from: 'Home', to: 'Swimming pool', purpose: 'Son’s swimming lesson', miles: 9, passengers: 'Me and my son' }
    ],
    weeklyMilesTotal: 268,
    dependants: [
      { relationship: 'Son', age: 7, needs: 'School is 2.5 miles away; after-school club until 5.30pm.' },
      { relationship: 'Mother', age: 74, needs: 'I take her to hospital appointments and do her shopping each week.' }
    ],
    householdVehicles: [{ description: 'Ford Transit Connect van', owner: 'My partner', availableToClaimant: false, whyNotAvailable: 'He uses it for his plumbing business from 6am to 6pm, Monday to Saturday. It is a two-seat van with no child seat fixing.' }],
    publicTransportConsidered:
      'The bus from my street runs hourly to the town centre only. Patients’ homes are in villages with no bus service. Taxis to each visit would cost far more than the hire and are not reliable for a timed visit schedule.',
    mobilityNeeds: 'None.',
    ownVehicleRoadworthy: false,
    ownVehicleLocation: 'Recovered from the scene to our storage yard on 9 August 2026',
    signedAt: '2026-08-10T09:58:00+01:00'
  }),
  render: (d) => {
    if (d.signedAt) assertNotBeforeCreation('signedAt', d.signedAt, d.createdAt);
    const weeklyMiles = d.weeklyMilesTotal ?? d.journeys.reduce((acc, j) => acc + j.miles, 0);
    const aboutRows = [
      { label: 'Full name', value: d.claimant.name },
      { label: 'Address', value: d.claimant.addressLines.filter((l) => l.trim() !== '').join(', ') },
      { label: 'Occupation', value: d.claimant.occupation ?? '' }
    ];
    if (d.employer) aboutRows.push({ label: 'Employer', value: d.employer });
    if (d.workPattern) aboutRows.push({ label: 'Working pattern', value: d.workPattern });
    if (d.workAddress) aboutRows.push({ label: 'Place of work', value: d.workAddress });
    aboutRows.push({ label: 'Your vehicle', value: `${formatRegistration(d.claim.vehicleRegistration)}${d.claim.vehicleDescription ? ` — ${d.claim.vehicleDescription}` : ''}` });
    aboutRows.push({ label: 'Roadworthy after the accident', value: yesNo(d.ownVehicleRoadworthy) });
    if (d.ownVehicleLocation) aboutRows.push({ label: 'Where it is now', value: d.ownVehicleLocation });

    const journeyRows = d.journeys.map((j) => [j.day, j.from, j.to, j.purpose, formatNumber(j.miles), j.passengers ?? '']);
    journeyRows.push(['Total for the week', '', '', '', formatNumber(weeklyMiles), '']);

    const body = `
<p>This statement sets out, in your own words, why you needed a replacement vehicle after the accident on ${escapeHtml(formatDateLong(d.claim.accidentDate))} and how you use a vehicle in a normal week. It is signed under a statement of truth and may be relied on in court.</p>
${keyValueTable(aboutRows, '1. About you')}
<h2>2. Why you needed a replacement vehicle</h2>
${nl2p(d.whyNeeded)}
${dataTable(['Day', 'From', 'To', 'Purpose', 'Miles', 'Who travelled'], journeyRows, { caption: `3. A typical week’s journeys (${plural(weeklyMiles, 'mile')} in the week)`, numeric: [4] })}
${dataTable(['Relationship', 'Age', 'Their needs'], d.dependants.map((x) => [x.relationship, x.age !== undefined ? formatNumber(x.age) : '', x.needs ?? '']), {
  caption: '4. People who depend on you for transport or care',
  emptyText: 'No dependants.'
})}
${dataTable(
  ['Vehicle', 'Owner', 'Available to you?', 'If not, why not'],
  d.householdVehicles.map((v) => [v.description, v.owner, yesNo(v.availableToClaimant), v.whyNotAvailable ?? '']),
  { caption: '5. Other vehicles in your household', emptyText: 'There is no other vehicle in my household.' }
)}
<h2>6. Public transport and other alternatives</h2>
${nl2p(d.publicTransportConsidered)}
<h2>7. Mobility or medical needs</h2>
${nl2p(d.mobilityNeeds ?? 'None.')}
${statementOfTruth({ kind: 'claimant', documentNoun: 'statement of need', signatoryName: d.claimant.name, date: d.signedAt })}
<div class="integrity"><div>Statement generated on ${escapeHtml(formatDateTime(d.createdAt))} from the answers you gave. Template form.statement_of_need version ${escapeHtml(statementOfNeedTemplate.version)}.${
      d.signedAt ? ` Signed electronically ${escapeHtml(formatDateTime(d.signedAt))}.` : ''
    }</div></div>`;
    return baseLayout({
      title: 'Statement of Need',
      subtitle: 'Why a replacement vehicle was needed',
      kind: 'form',
      reference: d.claim.ourReference,
      date: d.date,
      recipient: hirerRecipient(d.claimant),
      settings: d.settings,
      closing: '',
      extraCss: FORMS_CSS,
      bodyHtml: body
    });
  }
};
registerTemplate(statementOfNeedTemplate);

// ---------------------------------------------------------------------------
// statement.witness — CPR 32 / PD 32
// ---------------------------------------------------------------------------

export interface WitnessStatementData extends BaseDocumentData {
  court: { name: string; claimNumber?: string };
  parties: { claimant: string; defendant: string; secondDefendant?: string };
  witness: {
    name: string;
    addressLines: string[];
    occupation: string;
    /** "the Claimant", "a witness for the Claimant", "an employee of the Claimant" */
    capacity: string;
    /** For the PD 32 para 17.2 top-right block, e.g. "J. Example". Defaults to the full name. */
    shortName?: string;
  };
  /** 1 for the first statement. */
  statementNumber: number;
  /** Exhibit marks referred to, e.g. ["JE1", "JE2"]. */
  exhibits?: string[];
  /** PD 32 para 18.2: which statements are from the witness's own knowledge and which are information or belief, with the source. */
  knowledgeStatement: string;
  /** The witness's account, in the witness's own words, one paragraph per entry. */
  paragraphs: string[];
  /** When the witness gave this account to us. */
  accountGivenAt: DateLike;
  /** Mark the document as a draft for the witness to check and amend. */
  isDraft: boolean;
  signedAt?: DateLike;
  createdAt: ISODateTime;
}

function ordinalWord(n: number): string {
  const words = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'];
  return words[n - 1] ?? `${formatNumber(n)}th`;
}

export const witnessStatementTemplate: Template<WitnessStatementData> = {
  id: 'statement.witness',
  version: '1.0.0',
  kind: 'statement',
  title: 'Witness statement',
  recipientRole: 'court',
  description: 'CPR 32 / PD 32 witness statement skeleton: heading, numbered paragraphs in the witness’s own words, PD 32 para 20.2 statement of truth and CPR 32.14 contempt warning. A draft for the witness to check and sign.',
  requiredData: [
    ...BASE_REQUIRED,
    'createdAt',
    'court.name',
    'parties.claimant',
    'parties.defendant',
    'witness.name',
    'witness.addressLines',
    'witness.occupation',
    'witness.capacity',
    'statementNumber',
    'knowledgeStatement',
    'paragraphs',
    'accountGivenAt',
    'isDraft'
  ],
  titleFor: (d) => `Witness statement of ${d.witness.name}`,
  sample: () => ({
    ...sampleBaseData({ date: '2026-10-04', recipient: undefined }),
    createdAt: '2026-10-04T10:15:00+01:00',
    court: { name: 'County Court at Example', claimNumber: 'K00EX123' },
    parties: { claimant: 'Ms Jane Example', defendant: 'Mr John Sample' },
    witness: { name: 'Ms Jane Example', addressLines: ['1 Example Street', 'Example Town', 'EX2 2BB'], occupation: 'Community nurse', capacity: 'the Claimant', shortName: 'J. Example' },
    statementNumber: 1,
    exhibits: ['JE1', 'JE2'],
    knowledgeStatement:
      'The facts in this statement are within my own knowledge unless I say otherwise. Where I refer to documents, they are the documents in the bundle marked JE1 (the hire agreement and forms) and JE2 (the correspondence with the Defendant’s insurer), which I have read.',
    paragraphs: [
      'On 9 August 2026 at about 2.35pm I was driving my Volkswagen Golf, registration AB12 CDE, along High Street in Example Town. I stopped at the junction with Station Road, waiting to turn left.',
      'A Ford Transit van, registration XY65 ZZZ, turned right out of Station Road and cut across the front of my car, striking the front offside. The driver, who gave his name as John Sample, said at the scene that he had not seen me. We exchanged details.',
      'My car could not be driven. The front wheel was pushed back and the bumper was hanging off. It was recovered to a storage yard that afternoon.',
      'I am a community nurse. I drive to between eight and twelve patients’ homes every working day. I also take my son to school. I had no other vehicle available to me. On 10 August 2026 I signed a credit hire agreement with Courtesy Cars Group UK Ltd for a Volkswagen Golf at £49.80 a day, exhibit JE1.',
      'On 12 August 2026 I received a telephone call from the Defendant’s insurer offering a smaller car that would arrive in three to five working days with a £1,000 excess. I told the caller I would pass the offer on, and I did so the same afternoon. I did not accept the offer for the reasons in my mitigation questionnaire, which is in JE1.',
      'My car was repaired and returned to me on 2 September 2026, and I returned the hire car the same day.',
      'I could not have paid for a hire car myself. My statement of means and bank statements are in JE1.'
    ],
    accountGivenAt: '2026-10-03',
    isDraft: true
  }),
  render: (d) => {
    if (d.signedAt) assertNotBeforeCreation('signedAt', d.signedAt, d.createdAt);
    const shortName = d.witness.shortName ?? d.witness.name;
    const exhibits = d.exhibits && d.exhibits.length > 0 ? joinAnd(d.exhibits) : 'None';
    const address = d.witness.addressLines.filter((l) => l.trim() !== '').join(', ');
    const paras = [d.knowledgeStatement, ...d.paragraphs];
    const partyRows = [`<div class="party"><span>${escapeHtml(d.parties.claimant)}</span><span>Claimant</span></div>`, '<div class="center">and</div>', `<div class="party"><span>${escapeHtml(d.parties.defendant)}</span><span>${d.parties.secondDefendant ? 'First Defendant' : 'Defendant'}</span></div>`];
    if (d.parties.secondDefendant) partyRows.push('<div class="center">and</div>', `<div class="party"><span>${escapeHtml(d.parties.secondDefendant)}</span><span>Second Defendant</span></div>`);

    const body = `
${
  d.isDraft
    ? `<div class="draft-banner"><strong>Draft for the witness to check, amend and sign.</strong> Prepared from the account ${escapeHtml(d.witness.name)} gave on ${escapeHtml(
        formatDateLong(d.accountGivenAt)
      )}. The statement must be in the witness’s own words. Nothing should be signed that the witness does not know to be true.</div>`
    : ''
}
<div class="court-topright">
  On behalf of: ${escapeHtml(d.witness.capacity === 'the Claimant' ? 'the Claimant' : d.witness.capacity)}<br>
  Witness: ${escapeHtml(shortName)}<br>
  Statement: ${escapeHtml(ordinalWord(d.statementNumber))}<br>
  Exhibits: ${escapeHtml(exhibits)}<br>
  Date: ${escapeHtml(formatDateLong(d.signedAt ?? d.date))}
</div>
<div class="court-heading">
  <div class="court">In the ${escapeHtml(d.court.name)}</div>
  ${d.court.claimNumber ? `<div class="claim-no">Claim No. ${escapeHtml(d.court.claimNumber)}</div>` : ''}
  <div class="parties"><div class="center">BETWEEN</div>${partyRows.join('')}</div>
  <div class="title">${escapeHtml(ordinalWord(d.statementNumber))} witness statement of ${escapeHtml(d.witness.name)}</div>
</div>
<p>I, ${escapeHtml(d.witness.name)}, of ${escapeHtml(address)}, ${escapeHtml(d.witness.occupation)}, ${escapeHtml(d.witness.capacity)} in these proceedings, will say as follows:</p>
<ol class="paras">
${paras.map((p) => `  <li><div>${escapeHtml(p)}</div></li>`).join('\n')}
</ol>
${statementOfTruth({ kind: 'witness', signatoryName: d.witness.name, date: d.signedAt })}
<div class="integrity"><div>Draft generated on ${escapeHtml(formatDateTime(d.createdAt))} from the witness’s account of ${escapeHtml(formatDateLong(d.accountGivenAt))}. Template statement.witness version ${escapeHtml(witnessStatementTemplate.version)}. Prepared with the assistance of ${escapeHtml(
      brand.company.registeredName
    )}, which is not a firm of solicitors; the witness signs in person.</div></div>`;
    return baseLayout({
      title: 'Witness statement',
      subtitle: `${ordinalWord(d.statementNumber)} statement of ${d.witness.name}`,
      kind: 'statement',
      reference: d.claim.ourReference,
      date: d.date,
      settings: d.settings,
      closing: '',
      extraCss: FORMS_CSS,
      bodyHtml: body
    });
  }
};
registerTemplate(witnessStatementTemplate);

/** Every template in this file, in registration order. */
export const agreementsFormsTemplates: ReadonlyArray<AnyTemplate> = [
  creditHireAgreementTemplate,
  cancellationSch3Template,
  expressRequestToStartTemplate,
  mitigationQuestionnaireTemplate,
  statementOfMeansTemplate,
  statementOfNeedTemplate,
  witnessStatementTemplate
];
