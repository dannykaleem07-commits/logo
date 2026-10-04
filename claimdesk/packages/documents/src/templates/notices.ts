/**
 * Notices — fleet compliance correspondence (BLUEPRINT §3.12).
 *
 *   notice.pcn_liability_transfer   Representations to the enforcement authority (council PCN) or the creditor (private
 *                                   parking charge) transferring liability to the hirer: Road Traffic (Owner Liability)
 *                                   Regulations 2000 Schedule 2 particulars and the hirer's signed statement of liability;
 *                                   Protection of Freedoms Act 2012 Schedule 4 paragraphs 13–14 for private parking.
 *   notice.s172_response            Response to a Road Traffic Act 1988 s.172 requirement: identifies the hirer from the
 *                                   hire records, or gives the s.172(4) reasonable-diligence account of the records searched.
 *                                   It refuses to print a driver's name when the records do not support one.
 *
 * These notices concern a fleet unit, which may or may not be on a claim file, so their data carries its own
 * `ourReference` (the penalty reference) and an optional `claim` rather than extending BaseDocumentData.
 *
 * Perimeter (perimeter.md): nominating a driver the records do not support is perverting the course of justice.
 * The template throws rather than render such a nomination. Everything printed comes from the hire records.
 */
import type { ISODate, ISODateTime, Pence } from '@ccguk/domain';
import { brand } from '../brand.js';
import { type ClaimHeader, type CompanySettings, type RecipientBlock, type Signatory, sampleSettings, sampleSignatory } from '../common.js';
import { escapeHtml, formatDateLong, formatDateTime, formatDateWithDay, formatGBP, formatRegistration, joinAnd, nl2p, numberedList, toISODate } from '../format.js';
import { baseLayout, callout, keyValueTable, reLine } from '../layout.js';
import { type AnyTemplate, registerTemplate, type Template } from '../registry.js';
import { type DrivingLicence, statementOfLiabilityText } from './agreements-forms.js';

type DateLike = ISODate | ISODateTime;

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** Base for fleet notices: the penalty reference is our reference; a claim header is attached when the hire was a claim hire. */
export interface NoticeBaseData {
  settings: CompanySettings;
  date: DateLike;
  /** Our reference for the penalty (fleet penalty id or claim reference). */
  ourReference: string;
  recipient: RecipientBlock;
  signatory?: Signatory;
  claim?: ClaimHeader;
}

const BASE_REQUIRED = ['settings.registeredOffice', 'settings.signatoryName', 'settings.signatoryRole', 'date', 'ourReference', 'recipient.name', 'recipient.addressLines'] as const;

function signatoryOf(d: NoticeBaseData): Signatory {
  return d.signatory ?? { name: d.settings.signatoryName, role: d.settings.signatoryRole };
}

export interface NoticeHirer {
  name: string;
  addressLines: string[];
  dateOfBirth: ISODate;
  licence: DrivingLicence;
  email?: string;
  phone?: string;
}

export interface NoticeVehicle {
  registration: string;
  make: string;
  model: string;
}

export interface NoticeHireRecord {
  agreementNumber: string;
  startAt: ISODateTime;
  /** Actual end, when the hire has ended. */
  endAt?: ISODateTime;
  /** Expected end as stated in the agreement, when open-ended: "until repair or settlement". */
  expectedEnd: string;
  /** Authorised extensions of the hire (Owner Liability Regs Sch 2). */
  extensions?: Array<{ from: DateLike; to: DateLike }>;
  /** When the hirer signed the agreement and the statement of liability. */
  signedAt: ISODateTime;
}

/** Generic table with a header row; every cell is escaped. */
function dataTable(headings: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>, caption?: string): string {
  if (rows.length === 0) return '';
  const head = `<thead><tr>${headings.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('\n');
  return `<table class="data">${caption ? `<caption>${escapeHtml(caption)}</caption>` : ''}${head}<tbody>\n${body}\n</tbody></table>`;
}

function hirePeriodText(h: NoticeHireRecord): string {
  const end = h.endAt ? formatDateTime(h.endAt) : `open-ended, ${h.expectedEnd}`;
  return `${formatDateTime(h.startAt)} to ${end}`;
}

/**
 * Whether the hire record covers an instant: on or after the start, and (when the hire has ended) on or before the
 * end or within an authorised extension (compared by London calendar day). A notice must never assert that a hirer
 * had the vehicle at a time the records do not support.
 */
export function hireCoversInstant(h: NoticeHireRecord, at: ISODateTime): boolean {
  const t = Date.parse(at);
  const start = Date.parse(h.startAt);
  if (Number.isNaN(t) || Number.isNaN(start) || t < start) return false;
  if (!h.endAt) return true;
  if (t <= Date.parse(h.endAt)) return true;
  const day = toISODate(at);
  return (h.extensions ?? []).some((e) => toISODate(e.from) <= day && day <= toISODate(e.to));
}

/** Thrown when the hire records do not cover the time of the contravention (perimeter.md: do not guess). */
export class LiabilityTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiabilityTransferError';
  }
}

/** Owner Liability Regs 2000 Schedule 2 particulars as a table, from the hire record. */
function schedule2Table(hirer: NoticeHirer, vehicle: NoticeVehicle, hire: NoticeHireRecord): string {
  const rows = [
    { label: 'Hirer’s full name', value: hirer.name },
    { label: 'Date of birth', value: formatDateLong(hirer.dateOfBirth) },
    { label: 'Permanent address', value: hirer.addressLines.filter((l) => l.trim() !== '').join(', ') },
    { label: 'Driving licence number', value: hirer.licence.number },
    { label: 'Licence country of issue', value: hirer.licence.countryOfIssue },
    { label: 'Licence expiry date', value: hirer.licence.expiresOn ? formatDateLong(hirer.licence.expiresOn) : 'Not recorded' },
    { label: 'Vehicle registration mark', value: formatRegistration(vehicle.registration) },
    { label: 'Make and model', value: `${vehicle.make} ${vehicle.model}` },
    { label: 'Hire agreement number', value: hire.agreementNumber },
    { label: 'Hire began', value: formatDateTime(hire.startAt) },
    { label: hire.endAt ? 'Hire ended' : 'Expected end of hire', value: hire.endAt ? formatDateTime(hire.endAt) : hire.expectedEnd },
    {
      label: 'Authorised extensions',
      value: hire.extensions && hire.extensions.length > 0 ? hire.extensions.map((e) => `${formatDateLong(e.from)} to ${formatDateLong(e.to)}`).join('; ') : 'None'
    },
    { label: 'Agreement and statement of liability signed', value: formatDateTime(hire.signedAt) }
  ];
  return keyValueTable(rows, 'Particulars of the hiring agreement (Road Traffic (Owner Liability) Regulations 2000, Schedule 2)');
}

function notice(d: NoticeBaseData, title: string, bodyHtml: string, meta?: Array<{ label: string; value: string }>): string {
  return baseLayout({
    title,
    kind: 'notice',
    reference: d.ourReference,
    theirReference: d.claim?.theirReference,
    date: d.date,
    recipient: d.recipient,
    settings: d.settings,
    signatory: signatoryOf(d),
    closing: 'Yours faithfully',
    showTitle: false,
    meta,
    bodyHtml
  });
}

// ---------------------------------------------------------------------------
// notice.pcn_liability_transfer
// ---------------------------------------------------------------------------

export type LiabilityTransferKind = 'council' | 'private';

export interface PcnLiabilityTransferData extends NoticeBaseData {
  kind: LiabilityTransferKind;
  notice: {
    number: string;
    /** "Penalty Charge Notice", "Notice to Owner", "Parking Charge Notice", "Notice to Keeper" */
    noticeType: string;
    issuer: string;
    contraventionAt: ISODateTime;
    location?: string;
    contravention?: string;
    amountPence?: Pence;
    noticeDate?: ISODate;
    receivedAt: DateLike;
  };
  vehicle: NoticeVehicle;
  hirer: NoticeHirer;
  hire: NoticeHireRecord;
  /** The statement of liability as it appears in the signed agreement; defaults to the current agreement wording. */
  statementOfLiabilityOverride?: string;
  /** Date by which we ask for written confirmation — from the clocks engine. */
  confirmationRequestedBy: ISODate;
  /** Documents enclosed with this notice. */
  enclosures: string[];
}

export const pcnLiabilityTransferTemplate: Template<PcnLiabilityTransferData> = {
  id: 'notice.pcn_liability_transfer',
  version: '1.1.0',
  kind: 'notice',
  title: 'Transfer of liability to the hirer',
  recipientRole: 'other',
  description:
    'Representations transferring a penalty charge or parking charge to the hirer: Owner Liability Regulations 2000 Schedule 2 particulars, the hirer’s signed statement of liability and the hire agreement; POFA 2012 Schedule 4 paragraphs 13–14 variant for private parking.',
  requiredData: [
    ...BASE_REQUIRED,
    'kind',
    'notice.number',
    'notice.noticeType',
    'notice.issuer',
    'notice.contraventionAt',
    'notice.receivedAt',
    'vehicle.registration',
    'vehicle.make',
    'vehicle.model',
    'hirer.name',
    'hirer.addressLines',
    'hirer.dateOfBirth',
    'hirer.licence.number',
    'hirer.licence.countryOfIssue',
    'hirer.licence.expiresOn',
    'hire.agreementNumber',
    'hire.startAt',
    'hire.expectedEnd',
    'hire.signedAt',
    'confirmationRequestedBy',
    'enclosures'
  ],
  titleFor: (d) => `Transfer of liability — ${d.notice.noticeType} ${d.notice.number}`,
  sample: () => ({
    settings: sampleSettings(),
    date: '2026-09-10',
    ourReference: 'FLT-PCN-2026-0007',
    recipient: { name: 'Example Borough Council', attention: 'Parking Services — Representations', addressLines: ['PO Box 200', 'Example Town', 'EX3 3CC'], email: 'parking.representations@example-council.test' },
    signatory: sampleSignatory(),
    kind: 'council',
    notice: {
      number: 'EX12345678',
      noticeType: 'Notice to Owner',
      issuer: 'Example Borough Council',
      contraventionAt: '2026-08-21T11:42:00+01:00',
      location: 'Market Street, Example Town',
      contravention: 'Code 01: parked in a restricted street during prescribed hours',
      amountPence: 7000,
      noticeDate: '2026-09-03',
      receivedAt: '2026-09-05'
    },
    vehicle: { registration: 'LK26CCG', make: 'Volkswagen', model: 'Golf 1.5 TSI Life' },
    hirer: {
      name: 'Ms Jane Example',
      addressLines: ['1 Example Street', 'Example Town', 'EX2 2BB'],
      dateOfBirth: '1988-05-14',
      licence: { number: 'EXAMP805148JE9AB', countryOfIssue: 'United Kingdom', expiresOn: '2031-05-13' }
    },
    hire: {
      agreementNumber: 'CHA-2026-00012',
      startAt: '2026-08-10T09:30:00+01:00',
      endAt: '2026-09-02T16:40:00+01:00',
      expectedEnd: 'until the hirer’s own vehicle was repaired or a total-loss settlement was paid',
      signedAt: '2026-08-10T09:41:00+01:00'
    },
    confirmationRequestedBy: '2026-10-08',
    enclosures: ['Copy of hire agreement CHA-2026-00012 containing the Schedule 2 particulars', 'Copy of the hirer’s signed statement of liability', 'Copy of the Notice to Owner EX12345678']
  }),
  render: (d) => {
    if (!hireCoversInstant(d.hire, d.notice.contraventionAt)) {
      throw new LiabilityTransferError(
        `notice.pcn_liability_transfer: the alleged contravention at ${d.notice.contraventionAt} falls outside hire ${d.hire.agreementNumber} (${d.hire.startAt} to ${d.hire.endAt ?? 'continuing'}). Liability cannot be transferred to a hirer the records do not put in the vehicle at that time.`
      );
    }
    const company = brand.company;
    const isPrivate = d.kind === 'private';
    const statement = d.statementOfLiabilityOverride ?? statementOfLiabilityText(d.hirer.name, d.hirer.addressLines);
    const vehicle = `${d.vehicle.make} ${d.vehicle.model}, registration ${formatRegistration(d.vehicle.registration)}`;

    const noticeRows = [
      { label: 'Notice', value: `${d.notice.noticeType} ${d.notice.number}` },
      { label: 'Issued by', value: d.notice.issuer },
      { label: 'Vehicle', value: vehicle },
      { label: 'Alleged contravention', value: formatDateTime(d.notice.contraventionAt) }
    ];
    if (d.notice.location) noticeRows.push({ label: 'Location', value: d.notice.location });
    if (d.notice.contravention) noticeRows.push({ label: 'Contravention', value: d.notice.contravention });
    if (d.notice.amountPence !== undefined) noticeRows.push({ label: 'Amount stated', value: formatGBP(d.notice.amountPence) });
    if (d.notice.noticeDate) noticeRows.push({ label: 'Notice dated', value: formatDateLong(d.notice.noticeDate) });
    noticeRows.push({ label: 'Received by us', value: formatDateLong(d.notice.receivedAt) });

    const intro = isPrivate
      ? `<p>We are the registered keeper of the vehicle. At the time of the alleged contravention the vehicle was on hire to ${escapeHtml(
          d.hirer.name
        )} under a hire agreement. We give you this statement, and the documents listed below, under paragraph 13 of Schedule 4 to the Protection of Freedoms Act 2012. We are therefore not liable for the parking charge as keeper. Any claim lies against the hirer, by a notice to hirer under paragraph 14, served within the period that paragraph allows.</p>`
      : `<p>We are the registered keeper of the vehicle and the recipient of the ${escapeHtml(d.notice.noticeType)}. We make representations on the ground that the vehicle was hired to ${escapeHtml(
          d.hirer.name
        )} under a vehicle hiring agreement at the time of the alleged contravention, and that the hirer signed a statement of liability acknowledging liability for any penalty charge notice served during the hire. The agreement contains the particulars prescribed by Schedule 2 to the Road Traffic (Owner Liability) Regulations 2000, so it is a hiring agreement for the purposes of section 66 of the Road Traffic Offenders Act 1988. On that ground, under the Civil Enforcement of Road Traffic Contraventions (Representations and Appeals) (England) Regulations 2022, the hirer, not the hire firm, is to be treated as the owner, and the penalty charge is payable by the hirer.</p>`;

    const facts = `
<h2>The facts</h2>
${numberedList([
  `On ${formatDateTime(d.hire.startAt)} the vehicle was hired to ${d.hirer.name} under agreement ${d.hire.agreementNumber}. The hirer signed the agreement and the statement of liability on ${formatDateTime(d.hire.signedAt)}.`,
  `The hire period was ${hirePeriodText(d.hire)}.`,
  `The alleged contravention occurred at ${formatDateTime(d.notice.contraventionAt)}${d.notice.location ? ` at ${d.notice.location}` : ''}, within the hire period. The vehicle was in the hirer’s possession and control at that time.`,
  `We received the ${d.notice.noticeType} on ${formatDateLong(d.notice.receivedAt)}. These representations are made within the period allowed.`
])}`;

    const statementBlock = callout(
      `<p>${escapeHtml(statement)}</p><p class="small">Signed by ${escapeHtml(d.hirer.name)} on ${escapeHtml(formatDateTime(d.hire.signedAt))}. A copy of the signed statement is enclosed.${
        isPrivate ? ' It acknowledges responsibility for parking charges and gives an address for service, as paragraph 13 of Schedule 4 requires.' : ''
      }</p>`,
      'The hirer’s statement of liability'
    );

    const requests = isPrivate
      ? [
          `Record that ${company.registeredName} is not liable for the parking charge as keeper, and close the notice to keeper against us.`,
          `Direct any notice to hirer to ${d.hirer.name} at the address for service above, within the period paragraph 14 of Schedule 4 allows.`,
          `Confirm in writing to ${company.claimsEmail}, quoting our reference ${d.ourReference}, by ${formatDateWithDay(d.confirmationRequestedBy)}.`
        ]
      : [
          `Accept these representations and cancel the ${d.notice.noticeType} ${d.notice.number} as against ${company.registeredName}.`,
          `Serve any further notice on the hirer, ${d.hirer.name}, at the permanent address given in the particulars above.`,
          `Confirm your decision in writing to ${company.claimsEmail}, quoting our reference ${d.ourReference}, by ${formatDateWithDay(d.confirmationRequestedBy)}.`
        ];

    const consequence = isPrivate
      ? `<p>If you pursue ${escapeHtml(company.registeredName)} for this charge after receiving these documents, we will rely on paragraph 13 of Schedule 4 in any proceedings and will seek our costs.</p>`
      : `<p>If you reject these representations, please give your reasons in full in the notice of rejection. We will appeal to the adjudicator within 28 days of any notice of rejection, relying on the hiring agreement and the statement of liability enclosed.</p>`;

    const body = `
${reLine(`${d.notice.noticeType} ${d.notice.number} — ${vehicle}`)}
<p>Dear Sirs,</p>
${keyValueTable(noticeRows)}
${intro}
${facts}
${schedule2Table(d.hirer, d.vehicle, d.hire)}
${statementBlock}
<h2>What we ask</h2>
${numberedList(requests)}
${callout(consequence, 'If the transfer is not accepted')}
<p>The hirer’s personal data is provided solely for the purpose of transferring liability under the legislation cited and must not be used for any other purpose.</p>
<h2>Enclosures</h2>
${numberedList(d.enclosures)}`;

    return notice(d, 'Transfer of liability to the hirer', body, [{ label: 'Notice', value: d.notice.number }]);
  }
};
registerTemplate(pcnLiabilityTransferTemplate);

// ---------------------------------------------------------------------------
// notice.s172_response
// ---------------------------------------------------------------------------

/** Thrown when the data would nominate a driver the records do not support (perimeter.md: never). */
export class DriverNominationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverNominationError';
  }
}

export interface S172Driver {
  name: string;
  addressLines: string[];
  dateOfBirth?: ISODate;
  licence?: DrivingLicence;
  /** How the records identify this person. */
  role: 'hirer' | 'additional_driver' | 'employee';
}

export interface RecordSearched {
  /** Hire agreements, allocation diary, key log, tracker, fuel card, agency timesheet… */
  record: string;
  searchedOn: ISODate;
  searchedBy?: string;
  /** What the record showed, honestly, including its limits. */
  result: string;
}

export interface S172ResponseData extends NoticeBaseData {
  notice: {
    reference: string;
    /** Date on the s.172 notice / NIP. */
    dated: ISODate;
    receivedAt: DateLike;
    offenceAt: ISODateTime;
    location?: string;
    allegedOffence?: string;
  };
  vehicle: NoticeVehicle;
  /** 28 days from service of the notice — from the clocks engine. */
  responseDueBy: ISODate;
  /** True when the records do not identify the driver: the s.172(4) account is given and no name is printed. */
  cannotIdentify: boolean;
  /** The person the hire records identify. Must be absent when cannotIdentify is true. */
  driver?: S172Driver;
  /** The hire record that supports the identification. Required whenever a driver is given. */
  hire?: NoticeHireRecord & { additionalDrivers?: string[] };
  /** Records searched (always listed when cannotIdentify; optional otherwise). */
  recordsSearched?: RecordSearched[];
  /** The honest account of why the records do not identify the driver, and what has been changed since. */
  diligenceNote?: string;
  enclosures?: string[];
}

export const s172ResponseTemplate: Template<S172ResponseData> = {
  id: 'notice.s172_response',
  version: '1.0.0',
  kind: 'notice',
  title: 'Response to section 172 requirement',
  recipientRole: 'other',
  description:
    'Keeper’s response to a Road Traffic Act 1988 s.172 requirement: identifies the hirer from the hire records with the supporting agreement, or gives the s.172(4) reasonable-diligence account listing the records searched. Refuses to print a name the records do not support.',
  requiredData: [
    ...BASE_REQUIRED,
    'notice.reference',
    'notice.dated',
    'notice.receivedAt',
    'notice.offenceAt',
    'vehicle.registration',
    'vehicle.make',
    'vehicle.model',
    'responseDueBy',
    'cannotIdentify'
  ],
  titleFor: (d) => `Section 172 response — ${d.notice.reference}`,
  sample: () => ({
    settings: sampleSettings(),
    date: '2026-09-12',
    ourReference: 'FLT-NIP-2026-0003',
    recipient: { name: 'Example Police', attention: 'Central Ticket Office', addressLines: ['PO Box 300', 'Example Town', 'EX4 4DD'] },
    signatory: sampleSignatory(),
    notice: {
      reference: 'NIP/EX/2026/778812',
      dated: '2026-09-01',
      receivedAt: '2026-09-03',
      offenceAt: '2026-08-25T08:14:00+01:00',
      location: 'A123 Example Bypass, eastbound, near junction 4',
      allegedOffence: 'Exceeding the 50 mph speed limit (camera record)'
    },
    vehicle: { registration: 'LK26CCG', make: 'Volkswagen', model: 'Golf 1.5 TSI Life' },
    responseDueBy: '2026-10-01',
    cannotIdentify: false,
    driver: {
      name: 'Ms Jane Example',
      addressLines: ['1 Example Street', 'Example Town', 'EX2 2BB'],
      dateOfBirth: '1988-05-14',
      licence: { number: 'EXAMP805148JE9AB', countryOfIssue: 'United Kingdom', expiresOn: '2031-05-13' },
      role: 'hirer'
    },
    hire: {
      agreementNumber: 'CHA-2026-00012',
      startAt: '2026-08-10T09:30:00+01:00',
      endAt: '2026-09-02T16:40:00+01:00',
      expectedEnd: 'until the hirer’s own vehicle was repaired or a total-loss settlement was paid',
      signedAt: '2026-08-10T09:41:00+01:00',
      additionalDrivers: ['Mr Tom Example']
    },
    recordsSearched: [{ record: 'Hire agreements and allocation diary for LK26 CCG', searchedOn: '2026-09-04', searchedBy: 'D. Kaleem', result: 'One hire covering 25 August 2026: agreement CHA-2026-00012, hirer Ms Jane Example, one named additional driver.' }],
    enclosures: ['Copy of hire agreement CHA-2026-00012', 'Extract from the fleet allocation diary for 25 August 2026']
  }),
  render: (d) => {
    if (d.cannotIdentify && d.driver) {
      throw new DriverNominationError(
        `notice.s172_response: cannotIdentify is true but a driver (${d.driver.name}) was supplied. A response may not nominate a person the records do not identify.`
      );
    }
    if (!d.cannotIdentify && !d.driver) {
      throw new DriverNominationError('notice.s172_response: cannotIdentify is false but no driver was supplied. Either identify the person from the records or give the s.172(4) account.');
    }
    if (d.driver && !d.hire) {
      throw new DriverNominationError(`notice.s172_response: a driver (${d.driver.name}) was supplied without the hire record that identifies them. Nominations must be supported by the records.`);
    }
    if (d.driver && d.driver.name.trim() === '') {
      throw new DriverNominationError('notice.s172_response: a driver was supplied without a name. Either identify the person from the records or give the s.172(4) account.');
    }
    if (d.cannotIdentify && (!d.recordsSearched || d.recordsSearched.length === 0)) {
      throw new DriverNominationError('notice.s172_response: cannotIdentify is true but no records searched were supplied. The s.172(4) account must list the records searched.');
    }
    if (d.driver && d.hire && !hireCoversInstant(d.hire, d.notice.offenceAt)) {
      throw new DriverNominationError(
        `notice.s172_response: the alleged offence at ${d.notice.offenceAt} falls outside hire ${d.hire.agreementNumber} (${d.hire.startAt} to ${d.hire.endAt ?? 'continuing'}). The hire records do not put ${d.driver.name} in the vehicle at that time, so no one is nominated; give the s.172(4) account instead.`
      );
    }

    const company = brand.company;
    const vehicle = `${d.vehicle.make} ${d.vehicle.model}, registration ${formatRegistration(d.vehicle.registration)}`;
    const noticeRows = [
      { label: 'Your reference', value: d.notice.reference },
      { label: 'Notice dated', value: formatDateLong(d.notice.dated) },
      { label: 'Received by us', value: formatDateLong(d.notice.receivedAt) },
      { label: 'Vehicle', value: vehicle },
      { label: 'Alleged offence', value: `${formatDateTime(d.notice.offenceAt)}${d.notice.location ? `, ${d.notice.location}` : ''}` }
    ];
    if (d.notice.allegedOffence) noticeRows.push({ label: 'Nature of the alleged offence', value: d.notice.allegedOffence });
    noticeRows.push({ label: 'Registered keeper', value: `${company.registeredName}, company number ${company.companyNumber}` });

    const recordsTable = d.recordsSearched
      ? dataTable(
          ['Record', 'Searched on', 'Searched by', 'Result'],
          d.recordsSearched.map((r) => [r.record, formatDateLong(r.searchedOn), r.searchedBy ?? '', r.result]),
          'Records searched'
        )
      : '';

    let substance: string;
    if (d.cannotIdentify) {
      substance = `
<h2>Our response</h2>
<p>We are unable to identify the driver of the vehicle at the time of the alleged offence. We did not know who was driving, and we could not with reasonable diligence have ascertained who the driver was (section 172(4) of the Road Traffic Act 1988). We set out below what we did to find out.</p>
${recordsTable}
${d.diligenceNote ? nl2p(d.diligenceNote) : ''}
<p>We have not named any person, because our records do not identify the driver and we will not nominate someone the records do not support. If there is any further record you would like us to search, tell us which and we will search it and report the result.</p>`;
    } else {
      const driver = d.driver!;
      const hire = d.hire!;
      const roleText =
        driver.role === 'hirer' ? 'the hirer' : driver.role === 'additional_driver' ? 'a named additional driver under the hire agreement' : 'an employee to whom the vehicle was allocated';
      const driverRows = [
        { label: 'Full name', value: driver.name },
        { label: 'Address', value: driver.addressLines.filter((l) => l.trim() !== '').join(', ') }
      ];
      if (driver.dateOfBirth) driverRows.push({ label: 'Date of birth', value: formatDateLong(driver.dateOfBirth) });
      if (driver.licence) {
        driverRows.push({
          label: 'Driving licence',
          value: `${driver.licence.number} (${driver.licence.countryOfIssue}; ${driver.licence.expiresOn ? `expires ${formatDateLong(driver.licence.expiresOn)}` : 'expiry date not recorded'})`
        });
      }
      driverRows.push({ label: 'Basis of identification', value: `${roleText[0]!.toUpperCase()}${roleText.slice(1)} under agreement ${hire.agreementNumber}` });
      const others = hire.additionalDrivers && hire.additionalDrivers.length > 0 ? joinAnd(hire.additionalDrivers) : '';
      substance = `
<h2>Our response</h2>
<p>At the time of the alleged offence the vehicle was on hire under agreement ${escapeHtml(hire.agreementNumber)}, signed on ${escapeHtml(formatDateTime(hire.signedAt))}. The hire period was ${escapeHtml(
        hirePeriodText(hire)
      )}. Our records identify the following person as ${escapeHtml(roleText)}, in possession and control of the vehicle at that time:</p>
${keyValueTable(driverRows, 'Person identified by the hire records')}
${others ? `<p>The hire agreement also permits ${escapeHtml(others)} to drive the vehicle. We have no record of which permitted driver was at the wheel at ${escapeHtml(formatDateTime(d.notice.offenceAt))}.</p>` : ''}
<p>We did not have possession of the vehicle at the time and have no direct knowledge of who was driving. The information above is the information in our power to give under section 172(2). A copy of the hire agreement is enclosed. We ask you to direct any further requirement under section 172 to the person identified.</p>
${recordsTable}`;
    }

    const body = `
${reLine(`Notice of intended prosecution and section 172 requirement ${d.notice.reference} — ${vehicle}`)}
<p>Dear Sirs,</p>
${keyValueTable(noticeRows)}
<p>We are the registered keeper of the vehicle. This is our response to the requirement under section 172 of the Road Traffic Act 1988 in your notice dated ${escapeHtml(formatDateLong(d.notice.dated))}, which we received on ${escapeHtml(
      formatDateLong(d.notice.receivedAt)
    )}. It is sent within the 28 days allowed, which end on ${escapeHtml(formatDateWithDay(d.responseDueBy))}.</p>
${substance}
<h2>What we ask</h2>
${numberedList([
  `Acknowledge receipt of this response to ${company.claimsEmail}, quoting our reference ${d.ourReference}.`,
  d.cannotIdentify
    ? 'If you consider that any further record could identify the driver, tell us which record, and we will search it and report the result.'
    : 'If you require any further document from our records, tell us which, and we will provide it.'
])}
${d.enclosures && d.enclosures.length > 0 ? `<h2>Enclosures</h2>${numberedList(d.enclosures)}` : ''}
<p class="small muted">Personal data in this response is provided to the police for the purpose of section 172 of the Road Traffic Act 1988 and for no other purpose.</p>`;

    return notice(d, 'Response to section 172 requirement', body, [{ label: 'Notice', value: d.notice.reference }]);
  }
};
registerTemplate(s172ResponseTemplate);

/** Every template in this file, in registration order. */
export const noticeTemplates: ReadonlyArray<AnyTemplate> = [pcnLiabilityTransferTemplate, s172ResponseTemplate];
