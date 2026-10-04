/**
 * Letters B — letter.complaint_disp, letter.dsar, letter.cctv_preservation, letter.pav_challenge,
 * letter.particularisation_demand, letter.letter_before_claim, letter.part36_offer, letter.client_update,
 * letter.supplier_instruction_engineer.
 *
 * Every template here is a pure function of its data object (assembled by the API from the ledger, events, clocks
 * and settings) → HTML via baseLayout(). No clock, no retyped figures, every date and amount through format.ts.
 *
 * Perimeter (perimeter.md): "we are instructed to correspond on behalf of"; the claimant is the litigant in person
 * and signs the letter of claim and the Part 36 offer; no FOS mention to an at-fault insurer (DISP 2.7) — the FOS
 * route appears only when `againstOwnInsurer` is true; GTA is never cited as an entitlement. The claimant is "the
 * claimant" or is named — never "our client", which the consistency engine flags as REGULATED_STATUS_IMPLIED.
 * Letters to a council, the police or an engineer never carry the insurer's reference as "Your reference".
 *
 * This file is imported for its side effects by src/templates/index.ts.
 */
import type { ISODate, ISODateTime, Pence, Track } from '@ccguk/domain';
import { brand } from '../brand.js';
import { type BaseDocumentData, type ClaimHeader, type FigureRow, sampleBaseData, sampleRecipient } from '../common.js';
import {
  escapeHtml,
  formatDateLong,
  formatDateTime,
  formatDateWithDay,
  formatGBP,
  formatMiles,
  formatNumber,
  formatPercent,
  formatRegistration,
  joinAnd,
  nl2p,
  numberedList,
  plural
} from '../format.js';
import {
  baseLayout,
  callout,
  chronologyTable,
  type ChronologyEvent,
  figuresTable,
  keyValueTable,
  reLine,
  type ScheduleLine,
  scheduleTable,
  signatureBlock,
  standardOpener,
  subjectBlock
} from '../layout.js';
import { registerTemplate, type Template } from '../registry.js';

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const BASE_REQUIRED = [
  'settings.registeredOffice',
  'settings.signatoryName',
  'settings.signatoryRole',
  'date',
  'claim.ourReference',
  'claim.claimantName',
  'claim.vehicleRegistration',
  'claim.accidentDate',
  'recipient.name',
  'recipient.addressLines'
] as const;

/** Subject-block label: "Claimant", never "Our client" (perimeter.md; consistency engine REGULATED_STATUS_IMPLIED). */
const CLAIMANT_LABEL = { claimantLabel: 'Claimant' } as const;

function p(text: string): string {
  return `<p>${escapeHtml(text)}</p>`;
}

function h2(text: string): string {
  return `<h2>${escapeHtml(text)}</h2>`;
}

/** Deadline box: a dated requirement and the specific consequence on the day after it (voice.md). */
function deadlineCallout(deadline: ISODate | ISODateTime, requirement: string, consequence: string, title = 'Deadline'): string {
  return callout(`<p>${escapeHtml(requirement)} ${escapeHtml(formatDateWithDay(deadline))}.</p><p>${escapeHtml(consequence)}</p>`, title);
}

function enclosuresBlock(items: ReadonlyArray<string>, heading = 'Enclosures'): string {
  if (items.length === 0) return '';
  return `<h3>${escapeHtml(heading)}</h3>${numberedList(items)}`;
}

/** Signature for a letter the CLAIMANT signs as litigant in person. CCGUK never signs these. */
function claimantSignature(name: string, closing = 'Yours faithfully'): string {
  return signatureBlock({ name, role: 'Claimant' }, undefined, { closing, onBehalfOf: '' });
}

/** "From" block for letters sent in the claimant's own name. */
function senderBlock(name: string, addressLines: ReadonlyArray<string>, email?: string): string {
  const lines = [name, ...addressLines.filter((l) => l && l.trim() !== '')];
  if (email) lines.push(email);
  return `<p class="small muted">From: ${lines.map(escapeHtml).join(', ')}</p>`;
}

function defaultSignatory(d: BaseDocumentData): { name: string; role: string } {
  return d.signatory ?? { name: d.settings.signatoryName, role: d.settings.signatoryRole };
}

/**
 * The claim header without the insurer's reference, for a recipient who is not the insurer (council, police,
 * engineer): their own reference, if they have given one, is the only "Your reference" they should see.
 */
function forNonInsurer(claim: ClaimHeader, recipientReference?: string): ClaimHeader {
  const { theirReference: _insurerRef, ...rest } = claim;
  return recipientReference && recipientReference.trim() !== '' ? { ...rest, theirReference: recipientReference } : rest;
}

/** Perimeter-safe opener for a letter to the client's OWN insurer (policyholder, not third party). */
function ownInsurerOpener(d: BaseDocumentData): string {
  const c = d.claim;
  const policy = c.policyNumber ? ` under policy number ${escapeHtml(c.policyNumber)}` : '';
  return `<p>We are instructed to correspond on behalf of ${escapeHtml(c.claimantName)}, your policyholder${policy}, in connection with the road traffic accident on ${escapeHtml(
    formatDateLong(c.accidentDate)
  )} involving the vehicle ${escapeHtml(c.vehicleDescription ? `${c.vehicleDescription}, ` : '')}registration ${escapeHtml(formatRegistration(c.vehicleRegistration))}.</p>`;
}

const SAMPLE_CHRONOLOGY: ChronologyEvent[] = [
  { date: '2026-08-09', description: 'Accident. Vehicle unroadworthy; recovered to storage.', attributableTo: 'none' },
  { date: '2026-08-10', description: 'Hire commenced. New Claim Advice Form sent to you by email.', attributableTo: 'CCGUK' },
  { date: '2026-08-14', description: 'Your engineer inspected the vehicle.', attributableTo: 'insurer' },
  { date: '2026-08-28', description: 'Repair authorised by you, 10 working days after inspection.', attributableTo: 'insurer' },
  { date: '2026-09-02', description: 'Repair completed; hire ended the same day.', attributableTo: 'repairer' },
  { date: '2026-09-03', description: 'Payment pack sent: covering letter, mitigation questionnaire, advice form, hire period validation form, engineer’s report, storage and recovery accounts.', attributableTo: 'CCGUK' },
  { date: '2026-09-10', description: 'Chaser (day 7). No reply.', attributableTo: 'CCGUK' },
  { date: '2026-09-17', description: 'Chaser (day 14). No reply.', attributableTo: 'CCGUK' },
  { date: '2026-09-24', description: 'Chaser (day 21) to your team leader. Acknowledged by email; no substantive reply.', attributableTo: 'insurer' }
];

// ---------------------------------------------------------------------------
// letter.complaint_disp — formal complaint under DISP 1 (ICOBS 8.1 / 8.2.6R)
// ---------------------------------------------------------------------------

export interface ComplaintDispData extends BaseDocumentData {
  /**
   * true when the client is complaining about THEIR OWN insurer (eligible complainant: the FOS paragraph is
   * added). false for the at-fault insurer: a third-party claimant is not an eligible complainant (DISP 2.7) and
   * the Financial Ombudsman is not mentioned.
   */
  againstOwnInsurer: boolean;
  /** Dated chronology from the event log — the complaint stands or falls on it. */
  chronology: ChronologyEvent[];
  /** What went wrong, in plain words (paragraphs separated by blank lines). */
  complaintSummary: string;
  /** Date the claim was notified to the insurer (NCAF / FNOL) — starts the ICOBS 8.2.6R three months. */
  notificationDate: ISODate;
  /** Three months from notification, computed by the clocks engine. */
  icobsDeadline: ISODate;
  /** Whether the ICOBS 8.2.6R period had expired at the document date (computed by the API, never here). */
  icobsDeadlinePassed: boolean;
  /** Days since notification at the document date (computed by the API). */
  daysSinceNotification: number;
  /** Outstanding by head, from the ledger. */
  heads: FigureRow[];
  outstandingPence: Pence;
  /** Date by which the written acknowledgement and complaint reference are required. */
  acknowledgementDeadline: ISODate;
  /** Eight weeks from receipt of the complaint (DISP 1.6.2R), computed by the clocks engine. */
  finalResponseDeadline: ISODate;
}

export const complaintDispTemplate: Template<ComplaintDispData> = {
  id: 'letter.complaint_disp',
  version: '1.1.0',
  kind: 'letter',
  title: 'Formal complaint (DISP 1)',
  recipientRole: 'at_fault_insurer',
  description:
    'Formal complaint to the insurer’s complaints team citing ICOBS 8.1 and 8.2.6R with a chronology, outstanding figures and the eight-week DISP 1.6 final-response window. Set againstOwnInsurer for a complaint about the client’s own insurer (adds the FOS referral paragraph).',
  requiredData: [
    ...BASE_REQUIRED,
    'againstOwnInsurer',
    'chronology',
    'complaintSummary',
    'notificationDate',
    'icobsDeadline',
    'icobsDeadlinePassed',
    'daysSinceNotification',
    'heads',
    'outstandingPence',
    'acknowledgementDeadline',
    'finalResponseDeadline'
  ],
  sample: () => ({
    ...sampleBaseData({ recipient: sampleRecipient({ attention: 'Complaints Team' }) }),
    againstOwnInsurer: false,
    chronology: SAMPLE_CHRONOLOGY,
    complaintSummary:
      'The payment pack was complete when sent. No line in it has been disputed. No reasoned offer, no reasoned rejection and no request for further information has been received in the 31 days since it was sent, despite three chasers.\n\nYour acknowledgement of 24 September 2026 gave no date for a substantive reply and named no handler.',
    notificationDate: '2026-08-10',
    icobsDeadline: '2026-11-10',
    icobsDeadlinePassed: false,
    daysSinceNotification: 55,
    heads: [
      { label: 'Hire charges, 24 days at £49.80 per day', valuePence: 119520, note: 'Invoice CCG-INV-0042' },
      { label: 'Storage, 15 days at £45.00 per day', valuePence: 67500, note: 'Invoice CCG-INV-0043' },
      { label: 'Recovery: call-out, 31 loaded miles, administration', valuePence: 20800, note: 'Invoice CCG-INV-0044' }
    ],
    outstandingPence: 207820,
    acknowledgementDeadline: '2026-10-09',
    finalResponseDeadline: '2026-11-29'
  }),
  render: (d) => {
    const own = d.againstOwnInsurer;
    const icobsPara = d.icobsDeadlinePassed
      ? `ICOBS 8.2.6R requires a reasoned offer of settlement, or a reasoned reply, within three months of the claim being presented. The claim was presented to you on ${formatDateLong(d.notificationDate)}. That period expired on ${formatDateLong(d.icobsDeadline)}. Neither has been received. ${plural(d.daysSinceNotification, 'day')} have now passed since the claim was presented.`
      : `ICOBS 8.2.6R requires a reasoned offer of settlement, or a reasoned reply, within three months of the claim being presented. The claim was presented to you on ${formatDateLong(d.notificationDate)}; that period expires on ${formatDateLong(d.icobsDeadline)}. ${plural(d.daysSinceNotification, 'day')} have passed since the claim was presented and no reasoned reply has been received to any head of it.`;
    const requirements = [
      `Acknowledge this complaint in writing and give us your complaint reference by ${formatDateWithDay(d.acknowledgementDeadline)}.`,
      'Provide a reasoned offer or a reasoned reply on each head of the claim set out above. If any line is disputed, identify the line, the basis of the dispute and the document you rely on.',
      'Pay every head that is not disputed now, on account, without prejudice to the balance.',
      'Name the handler and the team now responsible for the claim, with a direct telephone number and email address.',
      `Send your final response by ${formatDateWithDay(d.finalResponseDeadline)}.`
    ];
    const consequence = own
      ? `If a final response has not been received by that date, or the final response does not resolve the complaint, ${d.claim.claimantName}, as your policyholder, may refer the complaint to the Financial Ombudsman Service, and will do so within six months of your final response. The complaint will be referred without further notice.`
      : `If a final response has not been received by that date, or the final response does not resolve the complaint, the matter will proceed to a letter of claim under the Practice Direction on Pre-Action Conduct and Protocols, without further notice. Interest will be claimed under section 69 of the County Courts Act 1984.`;
    const body = `
${subjectBlock(d.claim, CLAIMANT_LABEL)}
<p>Dear Sirs,</p>
${reLine('Formal complaint')}
${own ? ownInsurerOpener(d) : standardOpener(d.claim)}
${p('This letter is a formal complaint. Please log it as a complaint under DISP 1 of the FCA Handbook and send us the complaint reference.')}
${h2('Chronology')}
${chronologyTable(d.chronology)}
${h2('The complaint')}
${p('ICOBS 8.1.1R requires you to handle claims promptly and fairly and not to reject a claim unreasonably.')}
${p(icobsPara)}
${nl2p(d.complaintSummary)}
${h2('Outstanding')}
${figuresTable([...d.heads, { label: 'Total outstanding', valuePence: d.outstandingPence, emphasis: true }])}
${h2('What we require')}
${numberedList(requirements)}
${deadlineCallout(
  d.finalResponseDeadline,
  'DISP 1.6.2R provides for a final response within eight weeks of receipt of a complaint. We require your final response by',
  consequence,
  'Final response'
)}
${p('Please send all correspondence on this complaint to the email address in the heading of this letter, quoting our reference.')}`;
    return baseLayout({
      title: 'Formal complaint (DISP 1)',
      kind: 'letter',
      reference: d.claim.ourReference,
      theirReference: d.claim.theirReference,
      date: d.date,
      recipient: d.recipient,
      settings: d.settings,
      signatory: defaultSignatory(d),
      bodyHtml: body
    });
  }
};
registerTemplate(complaintDispTemplate);

// ---------------------------------------------------------------------------
// letter.dsar — subject access request, UK GDPR Article 15, on the claimant's behalf
// ---------------------------------------------------------------------------

export interface DsarData extends BaseDocumentData {
  /** The data subject (the claimant) as the controller holds them. */
  dataSubject: { name: string; dateOfBirth?: ISODate; addressLines: string[]; email?: string; phone?: string };
  /** Date of the claimant's signed authority for CCGUK to make the request and receive the response (enclosed). */
  authorityDate: ISODate;
  /** Dates on which the controller says it made offers (intervention offers) — call recordings are demanded for each. */
  allegedOfferDates: ISODate[];
  /** Every reference the controller may hold the data under. */
  references: string[];
  /** One month from receipt (UK GDPR art 12(3)), computed by the clocks engine. */
  responseDeadline: ISODate;
  /** The day after the deadline: the ICO complaint date. */
  icoComplaintDate: ISODate;
  /** Where the response is to be sent. */
  deliverTo: string;
}

export const dsarTemplate: Template<DsarData> = {
  id: 'letter.dsar',
  version: '1.2.0',
  kind: 'letter',
  title: 'Subject access request',
  recipientRole: 'at_fault_insurer',
  description:
    'UK GDPR Article 15 request on the claimant’s behalf with signed authority: call recordings of alleged offers on named dates, notes, decision rationales, fraud-agency sharing; one-month deadline and the ICO route on day 31.',
  requiredData: [
    ...BASE_REQUIRED,
    'dataSubject.name',
    'dataSubject.addressLines',
    'authorityDate',
    'allegedOfferDates',
    'references',
    'responseDeadline',
    'icoComplaintDate',
    'deliverTo'
  ],
  sample: () => ({
    ...sampleBaseData({ recipient: sampleRecipient({ attention: 'Data Protection Officer', email: 'dpo@example-insurer.test' }) }),
    dataSubject: { name: 'Ms Jane Example', dateOfBirth: '1988-03-14', addressLines: ['1 Example Street', 'Example Town', 'EX2 2BB'], email: 'jane@example.test' },
    authorityDate: '2026-10-02',
    allegedOfferDates: ['2026-08-11', '2026-08-13'],
    references: ['EXI/TP/4471920'],
    responseDeadline: '2026-11-04',
    icoComplaintDate: '2026-11-05',
    deliverTo: brand.company.claimsEmail
  }),
  render: (d) => {
    const s = d.dataSubject;
    const identity: Array<{ label: string; value: string }> = [{ label: 'Full name', value: s.name }];
    if (s.dateOfBirth) identity.push({ label: 'Date of birth', value: formatDateLong(s.dateOfBirth) });
    identity.push({ label: 'Address', value: s.addressLines.filter((l) => l.trim() !== '').join(', ') });
    if (s.email) identity.push({ label: 'Email', value: s.email });
    if (s.phone) identity.push({ label: 'Telephone', value: s.phone });
    identity.push({ label: 'Vehicle', value: formatRegistration(d.claim.vehicleRegistration) });
    identity.push({ label: 'Date of accident', value: formatDateLong(d.claim.accidentDate) });
    if (d.references.length > 0) identity.push({ label: 'Your references', value: d.references.join(', ') });
    const offerDates = d.allegedOfferDates.map(formatDateLong);
    const offerItem =
      offerDates.length > 0
        ? `Recordings of every telephone call with, or about, ${s.name} on ${joinAnd(offerDates)}, including any call in which you say an offer of a replacement vehicle or a payment was made, together with the call log for each call: date, time, duration, the number dialled or received, and the name of your member of staff.`
        : `Recordings of every telephone call with, or about, ${s.name}, together with the call log for each call: date, time, duration, the number dialled or received, and the name of your member of staff.`;
    const scope = [
      `All personal data you hold about ${s.name}, in every system, including claims, counter-fraud, complaints and telephony systems.`,
      offerItem,
      `All file notes, system notes, diary entries, emails and internal messages that refer to ${s.name} or to this claim.`,
      'The rationale for every decision taken on the claim, including any decision to reduce, withhold or decline a payment, with the name and role of the decision maker.',
      'Any referral of the data subject’s data to a fraud prevention agency or database (including CIFAS and the Insurance Fraud Bureau): the date, the category of referral, the data shared and the basis for it.',
      'The recipients, or categories of recipient, to whom the data subject’s personal data has been disclosed (Article 15(1)(c)).',
      'The source of any personal data not obtained from the data subject (Article 15(1)(g)), and the period for which the data will be retained (Article 15(1)(d)).',
      'Where any automated decision-making or profiling was applied, meaningful information about the logic involved and its significance (Article 15(1)(h)).'
    ];
    const body = `
${subjectBlock(d.claim, CLAIMANT_LABEL)}
<p>Dear Sirs,</p>
${reLine('Subject access request — UK GDPR Article 15')}
${standardOpener(d.claim)}
${p(`This is a subject access request under Article 15 of the UK GDPR made on behalf of ${s.name}, the data subject. The data subject’s signed authority dated ${formatDateLong(d.authorityDate)}, authorising us to make this request and to receive the response, is enclosed.`)}
${h2('The data subject')}
${keyValueTable(identity)}
${h2('What is requested')}
${numberedList(scope)}
${p('Please supply the copy in a commonly used electronic form (Article 15(3)): recordings as audio files and documents as they are held. A transcript or summary of a recording is not a copy of it; if you intend to supply one in place of the recording, say so and give the reason.')}
${h2('Exemptions')}
${p('If you withhold any item, provide a schedule listing each item withheld and the exemption relied on for that item. Legal professional privilege and the crime and taxation exemption in Schedule 2 to the Data Protection Act 2018 are narrow and must be justified item by item; a blanket refusal will be treated as a refusal to comply. Third-party personal data may be redacted; the substance of decisions about the data subject may not.')}
${h2('Timing and fee')}
${p(`Article 12(3) requires a response without undue delay and in any event within one month of receipt. No fee is payable (Article 12(5)). If you consider the request complex and intend to extend the period, Article 12(3) requires you to tell us within one month of receipt, with the reasons.`)}
${deadlineCallout(
  d.responseDeadline,
  'We require a complete response, sent to ' + d.deliverTo + ', by',
  `If a complete response has not been received by that date, a complaint will be submitted to the Information Commissioner’s Office on ${formatDateLong(d.icoComplaintDate)} without further notice. Please treat this letter as notice of that complaint under your own data protection complaints procedure.`
)}
${enclosuresBlock([`Signed authority of ${s.name} dated ${formatDateLong(d.authorityDate)}`])}`;
    return baseLayout({
      title: 'Subject access request',
      kind: 'letter',
      reference: d.claim.ourReference,
      theirReference: d.claim.theirReference,
      date: d.date,
      recipient: d.recipient,
      settings: d.settings,
      signatory: defaultSignatory(d),
      bodyHtml: body
    });
  }
};
registerTemplate(dsarTemplate);

// ---------------------------------------------------------------------------
// letter.cctv_preservation — preserve and provide footage (council / TfL / premises / police)
// ---------------------------------------------------------------------------

export type CctvOperatorType = 'council' | 'tfl' | 'premises' | 'police' | 'other';

export interface CctvPreservationData extends BaseDocumentData {
  operatorType: CctvOperatorType;
  /** Where the accident happened, as precisely as known ("junction of A Road and B Street, EX1 2AB"). */
  location: string;
  /** The camera(s) believed to cover the location, if known. */
  cameraDescription?: string;
  /** When the accident happened. */
  incidentAt: ISODateTime;
  /** The window of footage requested (computed by the API around incidentAt). */
  windowStart: ISODateTime;
  windowEnd: ISODateTime;
  policeReference?: string;
  /** The operator's published fee, if any (from the directory). Omit when none is known. */
  feePence?: Pence;
  /** Date of the claimant's signed authority (enclosed). */
  authorityDate: ISODate;
  /** Date by which written confirmation of preservation is required. */
  responseDeadline: ISODate;
  /** The operator's published retention period, if known ("31 days"). */
  retentionNote?: string;
  /** The operator's own reference for the request, if one has been given. The insurer's reference is never shown here. */
  operatorReference?: string;
}

/** Public authorities cannot rely on Article 6(1)(f) for processing in the performance of their tasks (UK GDPR art 6(1), last sentence). */
const PUBLIC_OPERATORS: ReadonlyArray<CctvOperatorType> = ['council', 'tfl', 'police'];

export const cctvPreservationTemplate: Template<CctvPreservationData> = {
  id: 'letter.cctv_preservation',
  version: '1.1.0',
  kind: 'letter',
  title: 'CCTV preservation request',
  recipientRole: 'other',
  description:
    'To a council, TfL, premises or the police: preserve and provide footage of the location for a date and time window; short retention; data-protection basis; fee if any.',
  requiredData: [...BASE_REQUIRED, 'operatorType', 'location', 'incidentAt', 'windowStart', 'windowEnd', 'authorityDate', 'responseDeadline'],
  sample: () => ({
    ...sampleBaseData({
      date: '2026-08-10',
      recipient: {
        name: 'Example Borough Council',
        attention: 'CCTV Control Room — Footage Requests',
        addressLines: ['Civic Centre', 'Example Town', 'EX1 1ZZ'],
        email: 'cctv@example-council.test'
      }
    }),
    operatorType: 'council',
    location: 'Junction of High Street and Station Road, Example Town, EX1 2AB',
    cameraDescription: 'Council camera on the lamp column outside 12 High Street, facing the junction',
    incidentAt: '2026-08-09T14:20:00+01:00',
    windowStart: '2026-08-09T14:05:00+01:00',
    windowEnd: '2026-08-09T14:35:00+01:00',
    authorityDate: '2026-08-10',
    responseDeadline: '2026-08-17',
    retentionNote: '31 days'
  }),
  render: (d) => {
    const c = forNonInsurer(d.claim, d.operatorReference);
    const who = c.claimantName;
    const vehicles = [`${formatRegistration(c.vehicleRegistration)}${c.vehicleDescription ? ` (${c.vehicleDescription})` : ''}`];
    if (c.thirdPartyRegistration) vehicles.push(formatRegistration(c.thirdPartyRegistration));
    const particulars: Array<{ label: string; value: string }> = [
      { label: 'Location', value: d.location },
      ...(d.cameraDescription ? [{ label: 'Camera', value: d.cameraDescription }] : []),
      { label: 'Date and time of accident', value: formatDateTime(d.incidentAt) },
      { label: 'Footage window', value: `${formatDateTime(d.windowStart)} to ${formatDateTime(d.windowEnd)}` },
      { label: 'Vehicles involved', value: vehicles.join(' and ') },
      ...(d.policeReference ? [{ label: 'Police reference', value: d.policeReference }] : [])
    ];
    const policeNote =
      d.operatorType === 'police'
        ? 'If the footage forms part of a collision investigation, please confirm the investigation reference and the process and fee for release of the collision report and any footage once the investigation allows.'
        : `If you are unable to release the footage to us directly, please preserve it and confirm that it will be released to ${who}, or to the court, on request or on an order under CPR 31.17.`;
    const feeItem = d.feePence !== undefined && d.feePence > 0 ? `We understand your fee for this service is ${formatGBP(d.feePence)}. Please send your invoice and we will pay it on receipt.` : 'If a fee is payable, state the amount and we will pay it on receipt of your invoice.';
    const requirements = [
      'Preserve now all recorded footage from every camera covering the location for the window above, before it is overwritten.',
      `Confirm in writing by ${formatDateWithDay(d.responseDeadline)} that the footage has been preserved, with your reference.`,
      'Provide a copy of the footage in its original file format with its metadata. A re-encoded clip, a screen recording or still images do not satisfy the request.',
      feeItem
    ];
    const schedule2 =
      'paragraph 5 of Schedule 2 to the Data Protection Act 2018, which exempts a disclosure that is necessary for the purpose of, or in connection with, legal proceedings (including prospective proceedings) or for establishing, exercising or defending legal rights from the UK GDPR provisions that would otherwise prevent it';
    const basis = PUBLIC_OPERATORS.includes(d.operatorType)
      ? `The footage is evidence of a road traffic accident in which ${who} suffered loss and is needed to establish liability for it. Disclosure to ${who}, through us, falls within ${schedule2}. ${who}’s signed authority dated ${formatDateLong(d.authorityDate)} is enclosed.`
      : `The footage is evidence of a road traffic accident in which ${who} suffered loss and is needed to establish liability for it. Disclosure to ${who}, through us, is lawful under Article 6(1)(f) of the UK GDPR (legitimate interests) and falls within ${schedule2}. ${who}’s signed authority dated ${formatDateLong(d.authorityDate)} is enclosed.`;
    const retention = d.retentionNote
      ? `We understand your retention period is ${d.retentionNote}. This request is made within that period; please act on it on the day it is received.`
      : 'We understand footage of this kind is retained for a short period and then overwritten. This request is made so that it is preserved; please act on it on the day it is received.';
    const body = `
${subjectBlock(c, { ...CLAIMANT_LABEL, showThirdParty: false })}
<p>Dear Sirs,</p>
${reLine('Request to preserve and provide CCTV footage')}
${standardOpener(c)}
${p(`The accident happened at ${d.location} at ${formatDateTime(d.incidentAt)}. We believe the location is covered by your cameras.`)}
${keyValueTable(particulars)}
${h2('What we require')}
${numberedList(requirements)}
${h2('Basis of the request')}
${p(basis)}
${p(policeNote)}
${p(retention)}
${deadlineCallout(
  d.responseDeadline,
  'We require written confirmation that the footage has been preserved by',
  'If we have not heard from you by that date we will telephone your control room to confirm preservation. This request and its date are recorded on the claim file and will be produced in support of any later application for disclosure of the footage.'
)}
${enclosuresBlock([`Signed authority of ${who} dated ${formatDateLong(d.authorityDate)}`])}`;
    return baseLayout({
      title: 'CCTV preservation request',
      kind: 'letter',
      reference: c.ourReference,
      theirReference: c.theirReference, // the operator's own reference, if any — never the insurer's
      date: d.date,
      recipient: d.recipient,
      settings: d.settings,
      signatory: defaultSignatory(d),
      bodyHtml: body
    });
  }
};
registerTemplate(cctvPreservationTemplate);

// ---------------------------------------------------------------------------
// letter.pav_challenge — disputing a total-loss valuation
// ---------------------------------------------------------------------------

export interface PavInputChallenge {
  /** "Trim", "Mileage", "Options", "Service history", "Condition" */
  item: string;
  theirValue: string;
  correctValue: string;
  /** Document the correct value rests on. */
  evidence: string;
}

export interface PavComparableRow {
  source: string;
  year: number;
  mileage: number;
  pricePence: Pence;
  /** Price adjusted to the subject's mileage by the per-mile factor. */
  normalisedPricePence: Pence;
  distanceMiles?: number;
  seller: 'dealer' | 'private' | 'unknown';
  capturedAt: ISODateTime;
}

export interface PavChallengeData extends BaseDocumentData {
  /** true when the valuation under challenge is the client's OWN insurer's (adds the FOS valuation approach). */
  againstOwnInsurer: boolean;
  offer: { amountPence: Pence; date: ISODate; basis?: string; reference?: string };
  inputsChallenged: PavInputChallenge[];
  /** Summary of the PavAssessment (domain/pav) — the API copies these from the approved assessment. */
  assessment: {
    subject: {
      make: string;
      model: string;
      trim?: string;
      year: number;
      odometerAtLoss: number;
      odometerBasis: 'reading' | 'projected_from_mot';
      serviceHistory?: 'full' | 'partial' | 'none' | 'unknown';
      conditionGrade: 'excellent' | 'good' | 'average' | 'poor';
    };
    comparablesCount: number;
    excludedCount: number;
    /** "Cat S/N", "ex-fleet", "price on application", "1.5×IQR outlier" */
    exclusions: string[];
    radiusMiles: number;
    perMilePence: number;
    perMileSource: 'regression' | 'fallback_band';
    medianPence: Pence;
    iqrLowPence: Pence;
    iqrHighPence: Pence;
    pavPence: Pence;
    /** Engineer-approved reasoning paragraph. */
    reasoning?: string;
  };
  comparables: PavComparableRow[];
  /** pavPence − offer.amountPence, from the ledger (never computed here). */
  differencePence: Pence;
  responseDeadline: ISODate;
  enclosures: string[];
}

const SERVICE_HISTORY_LABEL: Record<NonNullable<PavChallengeData['assessment']['subject']['serviceHistory']>, string> = {
  full: 'full',
  partial: 'partial',
  none: 'none',
  unknown: 'unknown'
};

const SELLER_LABEL: Record<PavComparableRow['seller'], string> = {
  dealer: 'Dealer',
  private: 'Private seller',
  unknown: 'Seller not stated'
};

export const pavChallengeTemplate: Template<PavChallengeData> = {
  id: 'letter.pav_challenge',
  version: '1.2.0',
  kind: 'letter',
  title: 'Pre-accident value challenge',
  recipientRole: 'at_fault_insurer',
  description:
    'Disputes a total-loss valuation: the inputs challenged, our comparables (n, radius, per-mile factor, exclusions, median, IQR), the retail replacement-cost measure (Darbishire v Warran), revised offer required by a date. FOS valuation approach cited only when againstOwnInsurer.',
  requiredData: [
    ...BASE_REQUIRED,
    'againstOwnInsurer',
    'offer.amountPence',
    'offer.date',
    'inputsChallenged',
    'assessment.subject.make',
    'assessment.subject.model',
    'assessment.subject.year',
    'assessment.subject.odometerAtLoss',
    'assessment.subject.odometerBasis',
    'assessment.subject.conditionGrade',
    'assessment.comparablesCount',
    'assessment.excludedCount',
    'assessment.exclusions',
    'assessment.radiusMiles',
    'assessment.perMilePence',
    'assessment.perMileSource',
    'assessment.medianPence',
    'assessment.iqrLowPence',
    'assessment.iqrHighPence',
    'assessment.pavPence',
    'comparables',
    'differencePence',
    'responseDeadline',
    'enclosures'
  ],
  sample: () => ({
    ...sampleBaseData({ recipient: sampleRecipient({ attention: 'Total Loss Team' }) }),
    againstOwnInsurer: false,
    offer: { amountPence: 625000, date: '2026-09-15', basis: 'trade guide figure, condition "average"', reference: 'EXI/TL/88213' },
    inputsChallenged: [
      { item: 'Trim', theirValue: 'Golf 1.5 TSI Match', correctValue: 'Golf 1.5 TSI Life', evidence: 'V5C and DVLA vehicle enquiry' },
      { item: 'Mileage', theirValue: '52,000 miles (assumed)', correctValue: '38,420 miles, projected from the MOT history to the date of loss', evidence: 'DVSA MOT history, test of 2 March 2026 at 36,912 miles' },
      { item: 'Service history', theirValue: 'Unknown', correctValue: 'Full main-dealer history, six stamps', evidence: 'Service book and invoices enclosed' },
      { item: 'Options', theirValue: 'None', correctValue: 'Winter pack and rear parking sensors', evidence: 'Original sales invoice enclosed' }
    ],
    assessment: {
      subject: { make: 'Volkswagen', model: 'Golf 1.5 TSI', trim: 'Life', year: 2020, odometerAtLoss: 38420, odometerBasis: 'projected_from_mot', serviceHistory: 'full', conditionGrade: 'good' },
      comparablesCount: 9,
      excludedCount: 2,
      exclusions: ['one Category S vehicle', 'one price-on-application advert'],
      radiusMiles: 50,
      perMilePence: 7,
      perMileSource: 'regression',
      medianPence: 745000,
      iqrLowPence: 738710,
      iqrHighPence: 751110,
      pavPence: 745000,
      reasoning:
        'Eleven advertised vehicles of the same model, year ±1 and fuel were captured from dealers within 50 miles on 20 September 2026. Two were excluded (one Category S, one price on application). The nine remaining prices were adjusted to 38,420 miles at £0.07 per mile, the factor given by regression across the set. The median adjusted price is £7,450.00 with an interquartile range of £7,387.10 to £7,511.10.'
    },
    // Nine survivors; adjusted = advertised + (mileage − 38,420) × £0.07. Median £7,450.00; Q1 £7,387.10; Q3 £7,511.10 (domain/pav quartiles).
    comparables: [
      { source: 'Dealer advert A', year: 2020, mileage: 41200, pricePence: 739000, normalisedPricePence: 758460, distanceMiles: 12, seller: 'dealer', capturedAt: '2026-09-20T10:05:00+01:00' },
      { source: 'Dealer advert B', year: 2020, mileage: 35600, pricePence: 769500, normalisedPricePence: 749760, distanceMiles: 18, seller: 'dealer', capturedAt: '2026-09-20T10:12:00+01:00' },
      { source: 'Dealer advert C', year: 2021, mileage: 29800, pricePence: 799000, normalisedPricePence: 738660, distanceMiles: 27, seller: 'dealer', capturedAt: '2026-09-20T10:20:00+01:00' },
      { source: 'Dealer advert D', year: 2019, mileage: 44100, pricePence: 699000, normalisedPricePence: 738760, distanceMiles: 31, seller: 'dealer', capturedAt: '2026-09-20T10:31:00+01:00' },
      { source: 'Dealer advert E', year: 2020, mileage: 37420, pricePence: 752000, normalisedPricePence: 745000, distanceMiles: 44, seller: 'dealer', capturedAt: '2026-09-20T10:40:00+01:00' },
      { source: 'Dealer advert F', year: 2020, mileage: 46900, pricePence: 679500, normalisedPricePence: 738860, distanceMiles: 9, seller: 'dealer', capturedAt: '2026-09-20T10:48:00+01:00' },
      { source: 'Dealer advert G', year: 2021, mileage: 33200, pricePence: 789000, normalisedPricePence: 752460, distanceMiles: 22, seller: 'dealer', capturedAt: '2026-09-20T10:55:00+01:00' },
      { source: 'Dealer advert H', year: 2019, mileage: 39800, pricePence: 719500, normalisedPricePence: 729160, distanceMiles: 38, seller: 'dealer', capturedAt: '2026-09-20T11:02:00+01:00' },
      { source: 'Dealer advert I', year: 2020, mileage: 36500, pricePence: 759500, normalisedPricePence: 746060, distanceMiles: 47, seller: 'dealer', capturedAt: '2026-09-20T11:10:00+01:00' }
    ],
    differencePence: 120000,
    responseDeadline: '2026-10-18',
    enclosures: ['Comparables schedule with dated screenshots (11 adverts)', 'DVSA MOT history', 'Service book and service invoices', 'Original sales invoice showing factory options']
  }),
  render: (d) => {
    const a = d.assessment;
    const s = a.subject;
    const who = d.claim.claimantName;
    const basis = d.offer.basis ? ` on the basis of ${d.offer.basis}` : '';
    const ref = d.offer.reference ? ` (your reference ${d.offer.reference})` : '';
    const inputsTable =
      d.inputsChallenged.length === 0
        ? ''
        : `<table class="data"><thead><tr><th>Input</th><th>Your valuation</th><th>Correct position</th><th>Evidence</th></tr></thead><tbody>
${d.inputsChallenged.map((r) => `<tr><td>${escapeHtml(r.item)}</td><td>${escapeHtml(r.theirValue)}</td><td>${escapeHtml(r.correctValue)}</td><td>${escapeHtml(r.evidence)}</td></tr>`).join('\n')}
</tbody></table>`;
    const subjectLine = `${s.year} ${s.make} ${s.model}${s.trim ? ` ${s.trim}` : ''}, ${formatMiles(s.odometerAtLoss)} ${s.odometerBasis === 'projected_from_mot' ? '(projected from the MOT history to the date of loss)' : '(odometer reading)'}, condition ${s.conditionGrade}${s.serviceHistory ? `, service history ${SERVICE_HISTORY_LABEL[s.serviceHistory]}` : ''}`;
    const method: Array<{ label: string; value: string }> = [
      { label: 'Subject vehicle', value: subjectLine },
      { label: 'Comparables used', value: `${formatNumber(a.comparablesCount)} (${formatNumber(a.excludedCount)} excluded: ${a.exclusions.length > 0 ? joinAnd(a.exclusions) : 'none'})` },
      { label: 'Search radius', value: formatMiles(a.radiusMiles) },
      { label: 'Mileage adjustment', value: `${formatGBP(a.perMilePence)} per mile (${a.perMileSource === 'regression' ? 'regression across the comparables' : 'fallback band'})` },
      { label: 'Median adjusted price', value: formatGBP(a.medianPence) },
      { label: 'Interquartile range', value: `${formatGBP(a.iqrLowPence)} to ${formatGBP(a.iqrHighPence)}` },
      { label: 'Pre-accident value asserted', value: formatGBP(a.pavPence) }
    ];
    const compTable =
      d.comparables.length === 0
        ? ''
        : `<table class="data"><caption>Comparables (dated captures enclosed)</caption><thead><tr><th>Source</th><th class="num">Year</th><th class="num">Mileage</th><th class="num">Advertised</th><th class="num">Adjusted</th><th>Captured</th></tr></thead><tbody>
${d.comparables
  .map((r) => {
    const note = [SELLER_LABEL[r.seller] ?? r.seller, r.distanceMiles !== undefined ? `${formatMiles(r.distanceMiles)} away` : ''].filter((x) => x !== '').join(', ');
    return `<tr><td>${escapeHtml(r.source)}<span class="note">${escapeHtml(note)}</span></td><td class="num">${escapeHtml(String(r.year))}</td><td class="num">${escapeHtml(formatNumber(r.mileage))}</td><td class="num">${formatGBP(r.pricePence)}</td><td class="num">${formatGBP(r.normalisedPricePence)}</td><td class="nowrap">${escapeHtml(formatDateTime(r.capturedAt))}</td></tr>`;
  })
  .join('\n')}
</tbody></table>`;
    const fosPara = d.againstOwnInsurer
      ? p(`The Financial Ombudsman Service’s approach to motor valuations is that trade guides are a starting point, not a ceiling, and that an insurer should not simply adopt the lowest guide figure where other evidence shows a higher market value. If this matter is not resolved, ${who}, as your policyholder, may complain and, if the complaint is not resolved, refer it to the Financial Ombudsman Service.`)
      : '';
    const requirements = [
      `A revised offer of ${formatGBP(a.pavPence)} for the pre-accident value of the vehicle, by ${formatDateWithDay(d.responseDeadline)}.`,
      'If you maintain your figure: the full basis of your valuation — each guide used, the date of the valuation, and the mileage, trim, options and condition adjustments applied.',
      'Identification of any comparable in the enclosed schedule that you say is not like for like, and why.',
      `Payment now of the ${formatGBP(d.offer.amountPence)} you have already offered, on account and without prejudice to the balance of ${formatGBP(d.differencePence)}.`
    ];
    const body = `
${subjectBlock(d.claim, CLAIMANT_LABEL)}
<p>Dear Sirs,</p>
${reLine(`Total loss valuation — ${formatRegistration(d.claim.vehicleRegistration)}`)}
${d.againstOwnInsurer ? ownInsurerOpener(d) : standardOpener(d.claim)}
${p(`Your offer of ${formatGBP(d.offer.amountPence)} dated ${formatDateLong(d.offer.date)}${ref}${basis} is declined. ${who}’s position is ${formatGBP(a.pavPence)}, for the reasons set out below.`)}
${h2('The inputs')}
${p('Your valuation rests on inputs that are wrong. Each is corrected below with the document that corrects it.')}
${inputsTable}
${h2('The measure')}
${p('Where a vehicle is uneconomic to repair, the measure of loss is the market cost of an equivalent replacement (Darbishire v Warran [1963] 1 WLR 1067). That is the retail price at which the claimant can buy a like vehicle of the same age, mileage and specification, not a trade or guide figure. Advertised retail prices are the right comparator because they are what replacement costs.')}
${h2('Our assessment')}
${keyValueTable(method)}
${a.reasoning ? nl2p(a.reasoning) : ''}
${compTable}
${fosPara}
${h2('Position')}
${figuresTable([
  { label: 'Your offer', valuePence: d.offer.amountPence, note: formatDateLong(d.offer.date) },
  { label: 'Pre-accident value asserted', valuePence: a.pavPence },
  { label: 'Difference', valuePence: d.differencePence, emphasis: true }
])}
${h2('What we require')}
${numberedList(requirements)}
${deadlineCallout(
  d.responseDeadline,
  'We require your revised offer, or your full valuation basis, by',
  'In the absence of either by that date, the pre-accident value will be pursued at the figure set out above together with the other heads of claim, and the delay in settling the undisputed amount will be relied on as a failure to handle the claim promptly and fairly under ICOBS 8.1.'
)}
${enclosuresBlock(d.enclosures)}`;
    return baseLayout({
      title: 'Pre-accident value challenge',
      kind: 'letter',
      reference: d.claim.ourReference,
      theirReference: d.claim.theirReference,
      date: d.date,
      recipient: d.recipient,
      settings: d.settings,
      signatory: defaultSignatory(d),
      bodyHtml: body
    });
  }
};
registerTemplate(pavChallengeTemplate);

// ---------------------------------------------------------------------------
// letter.particularisation_demand — fraud / irregularity / "offer ignored" allegations
// ---------------------------------------------------------------------------

export type AllegationKind = 'fraud' | 'irregularity' | 'offer_ignored' | 'other';

export interface ParticularisationDemandData extends BaseDocumentData {
  allegationLetter: { date: ISODate; reference?: string; author?: string };
  /** The allegation in the insurer's own words, verbatim. */
  allegationQuoted: string;
  allegationKind: AllegationKind;
  /**
   * What the intervention and mitigation register holds, as a sentence written by the API from the register
   * (e.g. "The register holds no offer received from you or on your behalf before 2 September 2026."). Optional;
   * the consistency engine checks it against the register.
   */
  registerPosition?: string;
  responseDeadline: ISODate;
}

const ALLEGATION_DEMANDS: Record<AllegationKind, string[]> = {
  fraud: [
    'The precise allegation. "Fraud" and "concerns" are not allegations. State whether you allege a staged collision, an induced collision, a fabricated or exaggerated hire, a misrepresentation, or something else, and against whom.',
    'Every document and data item you rely on, unredacted, with its provenance: who produced it, when, from which system and version, and who extracted it.',
    'The inference chain: which fact you say leads to which conclusion, step by step.',
    'Whether you treat any policy or agreement as avoided, cancelled or void, from what date and on what statutory basis.',
    'Whether a referral has been made to CIFAS, the Insurance Fraud Bureau or any other fraud prevention agency or database: the date, the category and the data shared.',
    'The name and role of the person who took the decision, and whether the claim is now with a counter-fraud team.'
  ],
  irregularity: [
    'The precise irregularity alleged. "Irregularities" is not an allegation. State what you say is irregular, in which document or event, and why.',
    'Every document and data item you rely on, unredacted, with its provenance: who produced it, when, from which system and version.',
    'The inference chain: which fact you say leads to which conclusion.',
    'Whether a referral has been made to CIFAS, the Insurance Fraud Bureau or any other fraud prevention agency or database: the date, the category and the data shared.',
    'Which heads of the claim you say are affected, and whether you accept the heads that are not.',
    'The name and role of the person who took the decision to withhold payment.'
  ],
  offer_ignored: [
    'The date, time and channel of the offer you say was made, and to whom it was made.',
    'The name of the person who made it and the telephone number or email address used.',
    'The recording or the contemporaneous note of the offer.',
    'The vehicle class offered, the daily rate, and the terms: excess, mileage limit, delivery, insurance and duration.',
    'Whether, and in what words, the cost of the offer to the claimant and its terms were explained (Copley v Lawn [2009] EWCA Civ 580).',
    'The claimant’s response as you record it, and the date and time of it.'
  ],
  other: [
    'The precise allegation, in terms capable of being answered.',
    'Every document and data item you rely on, unredacted, with its provenance.',
    'The inference chain: which fact you say leads to which conclusion.',
    'Which heads of the claim you say are affected, and whether you accept the heads that are not.',
    'The name and role of the person who took the decision.'
  ]
};

export const particularisationDemandTemplate: Template<ParticularisationDemandData> = {
  id: 'letter.particularisation_demand',
  version: '1.1.0',
  kind: 'letter',
  title: 'Particularisation demand',
  recipientRole: 'at_fault_insurer',
  description:
    'Where the insurer alleges fraud, irregularity or an ignored offer: numbered demand for the precise allegation, every document relied on, the inference chain and any CIFAS/IFB referral. Nothing further until particularised.',
  requiredData: [...BASE_REQUIRED, 'allegationLetter.date', 'allegationQuoted', 'allegationKind', 'responseDeadline'],
  sample: () => ({
    ...sampleBaseData(),
    allegationLetter: { date: '2026-09-28', reference: 'EXI/TP/4471920/CF', author: 'Claims Validation Team' },
    allegationQuoted: 'Our enquiries have identified irregularities with this claim and we are not prepared to make any payment while they remain outstanding.',
    allegationKind: 'irregularity',
    registerPosition: 'Our intervention register holds no offer of a replacement vehicle from you, or from anyone on your behalf, at any time during the hire.',
    responseDeadline: '2026-10-18'
  }),
  render: (d) => {
    const al = d.allegationLetter;
    const from = al.author ? ` from your ${al.author}` : '';
    const ref = al.reference ? `, reference ${al.reference}` : '';
    // An unmapped kind (data typed by hand, or a newer API enum) falls back to the generic demand rather than crashing.
    const demands = ALLEGATION_DEMANDS[d.allegationKind] ?? ALLEGATION_DEMANDS.other;
    const body = `
${subjectBlock(d.claim, CLAIMANT_LABEL)}
<p>Dear Sirs,</p>
${reLine(`Your letter of ${formatDateLong(al.date)}`)}
${standardOpener(d.claim)}
${p(`We note the allegation in your letter of ${formatDateLong(al.date)}${from}${ref}. You state:`)}
<blockquote><p>&ldquo;${escapeHtml(d.allegationQuoted)}&rdquo;</p></blockquote>
${p('Before the claimant responds further, we require you to particularise it. Specifically:')}
${numberedList(demands)}
${d.registerPosition ? p(d.registerPosition) : ''}
${p('The claimant will address the allegation once it is properly set out. Until then there is nothing capable of being answered, and nothing further will be provided in response to it.')}
${p('An allegation that has not been particularised is not a reasoned reply for the purposes of ICOBS 8.2.6R, and it does not stop the charges set out in the chronology and invoices already supplied. The heads of claim you do not dispute remain payable now.')}
${deadlineCallout(
  d.responseDeadline,
  'We require the particulars above by',
  'If they have not been received by that date, we will proceed on the basis that no particularised allegation is made, the claim will continue to the next step in our escalation process, and this letter will be produced in answer to any later attempt to rely on the allegation.'
)}`;
    return baseLayout({
      title: 'Particularisation demand',
      kind: 'letter',
      reference: d.claim.ourReference,
      theirReference: d.claim.theirReference,
      date: d.date,
      recipient: d.recipient,
      settings: d.settings,
      signatory: defaultSignatory(d),
      bodyHtml: body
    });
  }
};
registerTemplate(particularisationDemandTemplate);

// ---------------------------------------------------------------------------
// letter.letter_before_claim — Practice Direction on Pre-Action Conduct letter of claim, signed by the CLAIMANT
// ---------------------------------------------------------------------------

const TRACK_LABEL: Record<Track, string> = {
  small_claims: 'small claims track',
  fast: 'fast track',
  intermediate: 'intermediate track',
  multi: 'multi-track'
};

export interface LetterBeforeClaimData extends BaseDocumentData {
  /** The claimant, who signs. The recipient is the proposed defendant (usually c/o their insurer). */
  claimant: { name: string; addressLines: string[]; email?: string; isBusiness: boolean };
  /** The defendant's insurer, when known. */
  insurer?: { name: string; reference?: string };
  accident: { location: string; occurredAt: ISODateTime; circumstances: string; highwayCodeRules?: number[] };
  /** Why the defendant is liable, in plain words (paragraphs separated by blank lines). */
  liabilityBasis: string;
  /** Schedule of loss by head, each line with its source document, from the ledger. */
  schedule: ScheduleLine[];
  scheduleTotalPence: Pence;
  /** Interest under s.69 County Courts Act 1984, computed by domain/quantum. `rate` is a fraction (0.08 = 8%). */
  interest: { rate: number; fromDate: ISODate; toDate: ISODate; accruedPence: Pence; dailyPence: Pence };
  totalWithInterestPence: Pence;
  /** 14 days for an individual; 30 for a business defendant. */
  responseDays: number;
  responseDeadline: ISODate;
  track: { expected: Track; note: string };
  enclosures: string[];
}

export const letterBeforeClaimTemplate: Template<LetterBeforeClaimData> = {
  id: 'letter.letter_before_claim',
  version: '1.1.0',
  kind: 'letter',
  title: 'Letter of claim',
  recipientRole: 'at_fault_insurer',
  description:
    'Practice Direction on Pre-Action Conduct letter of claim drafted for the claimant to sign as litigant in person: facts, liability, schedule of loss by head with sources, s.69 interest, 14 or 30 days to respond, ADR, enclosures and track note. CCGUK is named only as the hire, recovery and storage provider.',
  requiredData: [
    ...BASE_REQUIRED,
    'claimant.name',
    'claimant.addressLines',
    'claimant.isBusiness',
    'accident.location',
    'accident.occurredAt',
    'accident.circumstances',
    'liabilityBasis',
    'schedule',
    'scheduleTotalPence',
    'interest.rate',
    'interest.fromDate',
    'interest.toDate',
    'interest.accruedPence',
    'interest.dailyPence',
    'totalWithInterestPence',
    'responseDays',
    'responseDeadline',
    'track.expected',
    'track.note',
    'enclosures'
  ],
  sample: () => ({
    ...sampleBaseData({
      recipient: { name: 'Mr John Sample', addressLines: ['c/o Example Insurance plc', 'Third Party Claims Team', 'PO Box 100', 'Example Town', 'EX1 1AA'] }
    }),
    claimant: { name: 'Ms Jane Example', addressLines: ['1 Example Street', 'Example Town', 'EX2 2BB'], email: 'jane@example.test', isBusiness: false },
    insurer: { name: 'Example Insurance plc', reference: 'EXI/TP/4471920' },
    accident: {
      location: 'junction of High Street and Station Road, Example Town',
      occurredAt: '2026-08-09T14:20:00+01:00',
      circumstances:
        'I was stationary in a queue of traffic at the junction. Your vehicle, registration XY65 ZZZ, struck the rear of my vehicle. You said at the scene that you had not seen the queue stop.',
      highwayCodeRules: [126, 146]
    },
    liabilityBasis:
      'You drove into the rear of a stationary vehicle. You failed to keep a safe distance and to stop within the distance you could see to be clear. The collision was caused by your negligence. There was nothing I could have done to avoid it.',
    schedule: [
      { description: 'Hire of a replacement vehicle', detail: '10 August 2026 to 2 September 2026, 24 days at £49.80 per day', netPence: 119520, source: 'Hire agreement; invoice CCG-INV-0042' },
      { description: 'Recovery of my vehicle from the scene to storage', detail: 'Call-out, 31 loaded miles, administration', netPence: 20800, source: 'Invoice CCG-INV-0044' },
      { description: 'Storage of my vehicle', detail: '9 August 2026 to 23 August 2026, 15 days at £45.00 per day', netPence: 67500, source: 'Invoice CCG-INV-0043' },
      { description: 'Independent engineer’s inspection and report', netPence: 28500, source: 'Fee note CCG-INV-0045; report dated 14 August 2026' },
      { description: 'Policy excess', netPence: 25000, source: 'Insurer’s excess statement' }
    ],
    scheduleTotalPence: 261320,
    interest: { rate: 0.08, fromDate: '2026-09-03', toDate: '2026-10-04', accruedPence: 1833, dailyPence: 57 },
    totalWithInterestPence: 263153,
    responseDays: 14,
    responseDeadline: '2026-10-18',
    track: {
      expected: 'small_claims',
      note: 'On that track the costs recoverable from the losing party are limited by CPR 27.14, and expert evidence is used only with the court\u2019s permission (CPR 27.5).'
    },
    enclosures: [
      'Schedule of loss with source documents',
      'Hire agreement and hire invoice',
      'Recovery and storage invoices',
      'Engineer’s report dated 14 August 2026 and fee note',
      'Photographs of the damage and of the scene',
      'Mitigation questionnaire'
    ]
  }),
  render: (d) => {
    const cl = d.claimant;
    const c = d.claim;
    const parties: Array<{ label: string; value: string }> = [
      { label: 'Claimant', value: cl.name },
      { label: 'Proposed defendant', value: d.recipient?.name ?? '' },
      { label: 'Claimant’s vehicle', value: `${formatRegistration(c.vehicleRegistration)}${c.vehicleDescription ? ` — ${c.vehicleDescription}` : ''}` }
    ];
    if (c.thirdPartyRegistration) parties.push({ label: 'Defendant’s vehicle', value: formatRegistration(c.thirdPartyRegistration) });
    parties.push({ label: 'Date of accident', value: formatDateLong(c.accidentDate) });
    if (d.insurer) parties.push({ label: 'Defendant’s insurer', value: `${d.insurer.name}${d.insurer.reference ? `, reference ${d.insurer.reference}` : ''}` });
    const rules = d.accident.highwayCodeRules ?? [];
    const rulesPara =
      rules.length > 0
        ? p(`${rules.length === 1 ? 'Rule' : 'Rules'} ${joinAnd(rules.map(String))} of the Highway Code applied to your driving. A failure to observe the Highway Code may be relied on as tending to establish liability (Road Traffic Act 1988, section 38(7)).`)
        : '';
    const responseWhy = cl.isBusiness || d.responseDays > 14 ? `${plural(d.responseDays, 'day')} is a reasonable time for a claim of this kind.` : `${plural(d.responseDays, 'day')} is a reasonable time for a straightforward claim of this kind (Practice Direction, paragraph 6(b)).`;
    const requirements = [
      `Confirm in writing whether you accept liability for the accident. If you do not, state your reasons and identify the facts and the parts of this claim you dispute (Practice Direction, paragraph 6(b)).`,
      `If you accept liability, pay ${formatGBP(d.totalWithInterestPence)} (the schedule total of ${formatGBP(d.scheduleTotalPence)} plus interest to ${formatDateLong(d.interest.toDate)}), with further interest at ${formatGBP(d.interest.dailyPence)} per day to the date of payment.`,
      'If you dispute any item in the schedule, identify the line, the amount you say is recoverable, your reasons and the documents you rely on (Practice Direction, paragraph 6(b)). A general denial is not a response.',
      'Send copies of the documents you hold that are relevant to the accident: your account, photographs, dashcam footage, and any estimate or report on your own vehicle (Practice Direction, paragraph 6(c)).',
      'Confirm your insurer’s name and claim reference, and whether your insurer will deal with this claim on your behalf. If so, please pass this letter to them today.'
    ];
    const body = `
${senderBlock(cl.name, cl.addressLines, cl.email)}
<p>Dear Sir or Madam,</p>
${reLine('Letter of claim — Practice Direction on Pre-Action Conduct and Protocols')}
${keyValueTable(parties)}
${p('I am the claimant. This is my letter of claim under the Practice Direction on Pre-Action Conduct and Protocols. Please read it in full and pass it to your insurer today.')}
${p(`${brand.company.registeredName} supplied the replacement vehicle, recovery and storage whose charges form part of my loss and has assisted me in preparing this letter. It is not a firm of solicitors and does not act for me in any proceedings. Please reply to me at the address above. You may copy your reply to ${brand.company.registeredName} at ${brand.company.claimsEmail}, quoting reference ${c.ourReference}.`)}
${h2('The facts')}
${p(`On ${formatDateTime(d.accident.occurredAt)}, at the ${d.accident.location}, there was a collision between my vehicle, registration ${formatRegistration(c.vehicleRegistration)}, and the vehicle you were driving${c.thirdPartyRegistration ? `, registration ${formatRegistration(c.thirdPartyRegistration)}` : ''}.`)}
${nl2p(d.accident.circumstances)}
${h2('Liability')}
${nl2p(d.liabilityBasis)}
${rulesPara}
${p('I hold you liable in negligence for the loss set out below.')}
${h2('My loss')}
${p('Each line of the schedule is supported by the document named against it. Copies are enclosed or available on request.')}
${scheduleTable(d.schedule, { caption: 'Schedule of loss', showVat: false, totals: { netPence: d.scheduleTotalPence }, totalLabel: 'Total loss' })}
${h2('Interest')}
${p(`I claim interest under section 69 of the County Courts Act 1984 at ${formatPercent(d.interest.rate)} a year from ${formatDateLong(d.interest.fromDate)} to ${formatDateLong(d.interest.toDate)}, which is ${formatGBP(d.interest.accruedPence)}, and continuing at ${formatGBP(d.interest.dailyPence)} per day until payment or judgment.`)}
${figuresTable([
  { label: 'Schedule of loss', valuePence: d.scheduleTotalPence },
  { label: `Interest to ${formatDateLong(d.interest.toDate)}`, valuePence: d.interest.accruedPence },
  { label: 'Total claimed', valuePence: d.totalWithInterestPence, emphasis: true }
])}
${h2('What I require')}
${numberedList(requirements)}
${h2('Alternative dispute resolution')}
${p('I am willing to consider alternative dispute resolution, including direct negotiation and mediation, and I will consider any reasonable proposal you make in your response. The court will expect both of us to have considered it (Practice Direction, paragraphs 8 to 11).')}
${h2('Proceedings')}
${p(`The value of the claim is ${formatGBP(d.totalWithInterestPence)}. I expect the claim to be allocated to the ${TRACK_LABEL[d.track.expected]}. ${d.track.note}`)}
${deadlineCallout(
  d.responseDeadline,
  `${responseWhy} I require your full written response by`,
  'If I have not received a full response by that date, I will issue proceedings in the County Court without further notice. I will claim the sum above, continuing interest, the court fee and the costs the court allows. The court may take any failure to respond into account when deciding costs and other sanctions (Practice Direction, paragraphs 13 to 16).'
)}
${enclosuresBlock(d.enclosures)}
${claimantSignature(cl.name)}`;
    return baseLayout({
      title: 'Letter of claim',
      kind: 'letter',
      reference: c.ourReference,
      theirReference: c.theirReference,
      date: d.date,
      recipient: d.recipient,
      settings: d.settings,
      closing: '',
      bodyHtml: body
    });
  }
};
registerTemplate(letterBeforeClaimTemplate);

// ---------------------------------------------------------------------------
// letter.part36_offer — claimant's Part 36 offer, signed by the CLAIMANT
// ---------------------------------------------------------------------------

export interface Part36OfferData extends BaseDocumentData {
  claimant: { name: string; addressLines: string[]; email?: string };
  /** The settlement sum: the whole claim, inclusive of interest (CPR 36.5(4)). */
  offerPence: Pence;
  /** Not less than 21 days (CPR 36.5(1)(c)); render() refuses a shorter period because the offer would not be a Part 36 offer. */
  relevantPeriodDays: number;
  /** CPR 36.5(1)(e): whether the offer takes into account a counterclaim. Default false (no counterclaim is taken into account). */
  takesAccountOfCounterclaim?: boolean;
  /** End of the relevant period, computed by the clocks engine from the date of service. */
  relevantPeriodEnd: ISODate;
  /** Set when proceedings have been issued. */
  proceedings?: { claimNumber?: string; court?: string };
  /** Set when the offer follows a letter of claim and proceedings are not yet issued. */
  letterOfClaimDate?: ISODate;
  /** The amount claimed (schedule plus interest), so the offer can be read against it. */
  claimedPence?: Pence;
  expectedTrack?: Track;
}

/** CPR 36.5(1)(c): the relevant period must be not less than 21 days. */
export const PART36_MINIMUM_PERIOD_DAYS = 21;

export const part36OfferTemplate: Template<Part36OfferData> = {
  id: 'letter.part36_offer',
  version: '1.1.0',
  kind: 'letter',
  title: 'Claimant’s Part 36 offer',
  recipientRole: 'at_fault_insurer',
  description:
    'Claimant’s Part 36 offer with the CPR 36 essentials: made pursuant to Part 36, relevant period of at least 21 days, whole claim, inclusive of interest, costs consequences; signed by the claimant.',
  requiredData: [...BASE_REQUIRED, 'claimant.name', 'claimant.addressLines', 'offerPence', 'relevantPeriodDays', 'relevantPeriodEnd'],
  sample: () => ({
    ...sampleBaseData({
      recipient: { name: 'Mr John Sample', addressLines: ['c/o Example Insurance plc', 'Third Party Claims Team', 'PO Box 100', 'Example Town', 'EX1 1AA'] }
    }),
    claimant: { name: 'Ms Jane Example', addressLines: ['1 Example Street', 'Example Town', 'EX2 2BB'], email: 'jane@example.test' },
    offerPence: 240000,
    relevantPeriodDays: 21,
    relevantPeriodEnd: '2026-10-25',
    letterOfClaimDate: '2026-10-04',
    claimedPence: 263153,
    expectedTrack: 'small_claims'
  }),
  render: (d) => {
    if (!Number.isInteger(d.relevantPeriodDays) || d.relevantPeriodDays < PART36_MINIMUM_PERIOD_DAYS) {
      throw new RangeError(
        `letter.part36_offer: relevantPeriodDays must be a whole number of at least ${PART36_MINIMUM_PERIOD_DAYS} (CPR 36.5(1)(c)); received ${String(d.relevantPeriodDays)}`
      );
    }
    const cl = d.claimant;
    const c = d.claim;
    let refPara: string;
    if (d.proceedings?.claimNumber) {
      refPara = `I refer to claim number ${d.proceedings.claimNumber}${d.proceedings.court ? ` in the ${d.proceedings.court}` : ''}, arising from the road traffic accident on ${formatDateLong(c.accidentDate)}.`;
    } else if (d.letterOfClaimDate) {
      refPara = `I refer to my letter of claim dated ${formatDateLong(d.letterOfClaimDate)} arising from the road traffic accident on ${formatDateLong(c.accidentDate)}. Proceedings have not yet been issued.`;
    } else {
      refPara = `I refer to my claim arising from the road traffic accident on ${formatDateLong(c.accidentDate)}.`;
    }
    const costsTerm =
      'If you do not accept this offer and the judgment against you is at least as advantageous to me as this offer, I will ask the court for the consequences in CPR 36.17(4): interest on the whole or part of the sum awarded at a rate not exceeding 10% above base rate for some or all of the period from the end of the relevant period; costs on the indemnity basis from that date; interest on those costs at up to 10% above base rate; and an additional amount of 10% of the sum awarded.';
    const terms = [
      'This offer is made pursuant to Part 36 of the Civil Procedure Rules and is intended to have the consequences of Section I of Part 36 (CPR 36.5(1)(b)).',
      'It is a claimant’s offer.',
      'It relates to the whole of my claim (CPR 36.5(1)(d)).',
      d.takesAccountOfCounterclaim
        ? 'It takes into account the counterclaim you have intimated (CPR 36.5(1)(e)).'
        : 'It does not take into account any counterclaim (CPR 36.5(1)(e)).',
      `I will accept ${formatGBP(d.offerPence)} in full and final settlement of the whole of my claim. That sum is inclusive of interest to the end of the relevant period (CPR 36.5(4)).`,
      `The relevant period is ${plural(d.relevantPeriodDays, 'day')} from the date this offer is served on you, ending on ${formatDateWithDay(d.relevantPeriodEnd)} (CPR 36.5(1)(c)). If you accept within the relevant period, the settlement sum is payable within 14 days of acceptance (CPR 36.14(6)) and the costs consequences in CPR 36.13 apply.`,
      costsTerm,
      'To accept, serve written notice of acceptance on me at the address above (CPR 36.11(1)). This offer may be withdrawn or changed only by written notice (CPR 36.9) and remains open for acceptance after the relevant period until it is withdrawn.'
    ];
    const costsParagraph = terms.indexOf(costsTerm) + 1;
    if (d.expectedTrack === 'small_claims') {
      terms.push(
        'If the claim is allocated to the small claims track, Part 36 does not apply to it (CPR 27.2(1)(g)). This letter then stands as a written offer to settle, and I will ask the court to take an unreasonable refusal of it into account under CPR 27.14(2)(g).'
      );
    }
    const position = d.claimedPence !== undefined
      ? figuresTable([
          { label: 'Amount claimed, including interest to date', valuePence: d.claimedPence },
          { label: 'Offered in full and final settlement', valuePence: d.offerPence, emphasis: true }
        ])
      : '';
    const body = `
${senderBlock(cl.name, cl.addressLines, cl.email)}
${reLine('WITHOUT PREJUDICE SAVE AS TO COSTS')}
${reLine('Claimant’s offer to settle under CPR Part 36')}
${subjectBlock(c, { claimantLabel: 'Claimant', showThirdParty: false })}
<p>Dear Sir or Madam,</p>
${p(refPara)}
${h2('Terms of the offer')}
${numberedList(terms)}
${position}
${deadlineCallout(
  d.relevantPeriodEnd,
  'The relevant period ends on',
  `If the offer has not been accepted by then, it remains open until withdrawn, but the costs consequences in paragraph ${costsParagraph} run from that date.`,
  'Relevant period'
)}
${claimantSignature(cl.name)}`;
    return baseLayout({
      title: 'Claimant’s Part 36 offer',
      kind: 'letter',
      reference: c.ourReference,
      theirReference: c.theirReference,
      date: d.date,
      recipient: d.recipient,
      settings: d.settings,
      closing: '',
      bodyHtml: body
    });
  }
};
registerTemplate(part36OfferTemplate);

// ---------------------------------------------------------------------------
// letter.client_update — to the client (voice.md client-communications shape)
// ---------------------------------------------------------------------------

export interface ClientUpdateData extends BaseDocumentData {
  /** How the client is addressed: "Jane" or "Ms Example". */
  salutationName: string;
  /** One or two lines each; paragraphs separated by blank lines. */
  whereWeAre: string;
  whatThisMeans: string;
  /** Numbered, each with a date. */
  needFromYou: Array<{ action: string; byDate: ISODate }>;
  whatHappensNext: { text: string; date: ISODate };
  /** Optional position snapshot from the ledger (claimed, received, outstanding). */
  figures?: FigureRow[];
  handler: { name: string; role: string; phone?: string; email?: string };
}

export const clientUpdateTemplate: Template<ClientUpdateData> = {
  id: 'letter.client_update',
  version: '1.0.0',
  kind: 'letter',
  title: 'Client update',
  recipientRole: 'client',
  description:
    'Update to the client: where we are, what this means, what I need from you (numbered, dated), what happens next. No promised outcomes; the client is never told to ignore an offer.',
  requiredData: [...BASE_REQUIRED, 'salutationName', 'whereWeAre', 'whatThisMeans', 'needFromYou', 'whatHappensNext.text', 'whatHappensNext.date', 'handler.name', 'handler.role'],
  sample: () => ({
    ...sampleBaseData({ recipient: { name: 'Ms Jane Example', addressLines: ['1 Example Street', 'Example Town', 'EX2 2BB'], email: 'jane@example.test' } }),
    salutationName: 'Ms Example',
    whereWeAre:
      'Your repair was completed on 2 September 2026 and the hire ended the same day. The full claim for the hire, recovery and storage charges was sent to the other driver’s insurer on 3 September 2026. They have acknowledged it but have not yet paid or disputed any part of it.',
    whatThisMeans:
      'Under your hire agreement the charges are payable by you, but payment is deferred while they are claimed from the other driver’s insurer as your loss, and you are not being asked to pay anything now. Insurers commonly take four to eight weeks to deal with a claim of this kind; we chased on 10, 17 and 24 September and a formal complaint goes to them today.',
    needFromYou: [
      { action: 'Sign and return the mitigation questionnaire we sent on 28 September 2026, so we can answer any suggestion that you were offered a vehicle by the insurer.', byDate: '2026-10-09' },
      { action: 'Send a copy of your policy excess statement, if your own insurer has charged an excess, so it can be added to the claim.', byDate: '2026-10-16' }
    ],
    whatHappensNext: {
      text: 'The insurer’s final response to the complaint is due within eight weeks. If the claim is not paid by then, we will prepare a letter of claim for you to sign and send, and explain the court process and its costs before you decide whether to proceed.',
      date: '2026-11-29'
    },
    figures: [
      { label: 'Claimed from the insurer', valuePence: 207820 },
      { label: 'Received to date', valuePence: 0 },
      { label: 'Outstanding', valuePence: 207820, emphasis: true }
    ],
    handler: { name: 'D. Kaleem', role: 'Claims Manager', phone: brand.company.accidentLine24h, email: brand.company.claimsEmail }
  }),
  render: (d) => {
    const c = d.claim;
    const contact = [d.handler.phone ? `call me on ${d.handler.phone}` : '', d.handler.email ? `email ${d.handler.email}` : ''].filter((x) => x !== '');
    const body = `
<p>Dear ${escapeHtml(d.salutationName)},</p>
${reLine(`Your claim — ${formatRegistration(c.vehicleRegistration)}, accident on ${formatDateLong(c.accidentDate)}`)}
${h2('Where we are')}
${nl2p(d.whereWeAre)}
${h2('What this means')}
${nl2p(d.whatThisMeans)}
${d.figures && d.figures.length > 0 ? figuresTable(d.figures) : ''}
${h2('What I need from you')}
${numberedList(d.needFromYou.map((n) => `${n.action} Please do this by ${formatDateWithDay(n.byDate)}.`))}
${h2('What happens next')}
${nl2p(d.whatHappensNext.text)}
${p(`I will write to you again by ${formatDateWithDay(d.whatHappensNext.date)}, or sooner if anything changes.`)}
${callout(
  `<p>If the other driver’s insurer, or anyone else, contacts you directly with an offer of a vehicle, a repair or a payment, you do not have to decide on the spot. Tell me the same day what was offered, by whom and when, so it can be logged and answered within one working day.</p>`,
  'If you are contacted directly'
)}
${contact.length > 0 ? p(`If anything in this letter is unclear, ${joinAnd(contact)}.`) : ''}`;
    return baseLayout({
      title: 'Client update',
      kind: 'letter',
      reference: c.ourReference,
      date: d.date,
      recipient: d.recipient,
      settings: d.settings,
      signatory: { name: d.handler.name, role: d.handler.role },
      closing: 'Yours sincerely',
      bodyHtml: body
    });
  }
};
registerTemplate(clientUpdateTemplate);

// ---------------------------------------------------------------------------
// letter.supplier_instruction_engineer — instruction to an independent engineer
// ---------------------------------------------------------------------------

export interface EngineerInstructionData extends BaseDocumentData {
  vehicle: {
    registration: string;
    description: string;
    vin?: string;
    odometerMiles?: number;
    motExpiry?: ISODate;
    /** Where the vehicle can be inspected. */
    location: string;
    locationContact?: string;
    keysWith?: string;
  };
  /** The client's account of the accident, taken cold and attributed to the client. */
  accidentCircumstances: string;
  damageReported: string;
  inspectionBy: ISODate;
  reportBy: ISODate;
  /** Adds the CPR 35 / PD 35 requirements and the small claims caveats. */
  forCourt: boolean;
  /** Agreed fee (e.g. £285), from the supplier record. */
  feePence: Pence;
  /** Specific questions beyond the standard report contents. */
  questions?: string[];
  /**
   * Small claims cap on recoverable expert fees (PD 27A para 7.3(2)), supplied by the API from the knowledge base
   * with its verification — never typed here. Omitted: the rule is cited without a figure.
   */
  smallClaimsExpertFeeCapPence?: Pence;
  enclosures: string[];
}

const REPORT_CONTENTS = [
  'Your instructions and the instructing party.',
  'Your identity, qualifications (IAEA, IMI or equivalent) and relevant experience.',
  'The date, place and conditions of inspection, and whether it was physical or desktop.',
  'Vehicle identification: registration, VIN, odometer reading and MOT status.',
  'Pre-accident condition, including any pre-existing damage, separated explicitly from accident damage.',
  'Description of the accident damage with photographs of each damaged area.',
  'Repair method and a priced estimate: labour hours and rate, paint hours and materials method, parts and their source, and whether ADAS calibration is required.',
  'Whether the vehicle is roadworthy or unroadworthy, and why.',
  'Repair duration in working days, including parts lead time.',
  'Total-loss assessment where relevant: pre-accident value with the comparables used, salvage category under the ABI Code of Practice and salvage value.',
  'ADAS and electric or hybrid vehicle notes, including battery and high-voltage system checks where applicable.',
  'Your opinion whether the damage is consistent with the circumstances described.'
];

export const engineerInstructionTemplate: Template<EngineerInstructionData> = {
  id: 'letter.supplier_instruction_engineer',
  version: '1.1.0',
  kind: 'letter',
  title: 'Engineer instruction',
  recipientRole: 'supplier',
  description:
    'Instruction to an independent engineer: vehicle, location, inspection and report dates, the BLUEPRINT §4.6 report contents, the agreed fee, and CPR 35 compliance when the report is for court.',
  requiredData: [
    ...BASE_REQUIRED,
    'vehicle.registration',
    'vehicle.description',
    'vehicle.location',
    'accidentCircumstances',
    'damageReported',
    'inspectionBy',
    'reportBy',
    'forCourt',
    'feePence',
    'enclosures'
  ],
  sample: () => ({
    ...sampleBaseData({
      recipient: { name: 'Example Assessing Ltd', attention: 'Mr A. Assessor MIMI', addressLines: ['Unit 4', 'Example Industrial Estate', 'Example Town', 'EX3 3CC'], email: 'reports@example-assessing.test' }
    }),
    vehicle: {
      registration: 'AB12CDE',
      description: 'Volkswagen Golf 1.5 TSI Life, 2020, petrol, manual',
      vin: 'WVWZZZAUZLW000000',
      odometerMiles: 38420,
      motExpiry: '2027-03-01',
      location: 'CCGUK storage compound, Example Yard, Example Town, EX4 4DD',
      locationContact: 'Yard office, 24-hour accident line ' + brand.company.accidentLine24h,
      keysWith: 'the yard office'
    },
    accidentCircumstances: 'The client states that she was stationary in a queue of traffic when the third-party vehicle struck the rear of her vehicle.',
    damageReported: 'Rear bumper, tailgate and rear panel deformed; rear parking sensors inoperative; boot floor possibly displaced. The vehicle was recovered from the scene and has not been driven since.',
    inspectionBy: '2026-10-09',
    reportBy: '2026-10-14',
    forCourt: false,
    feePence: 28500,
    questions: ['State whether the rear parking sensors and any rear camera require calibration after repair, and include the operation in the estimate if so.'],
    smallClaimsExpertFeeCapPence: 75000,
    enclosures: ['Client’s photographs of the damage (12)', 'DVLA vehicle enquiry and MOT history', 'Recovery record']
  }),
  render: (d) => {
    const v = d.vehicle;
    const particulars: Array<{ label: string; value: string }> = [
      { label: 'Registration', value: formatRegistration(v.registration) },
      { label: 'Vehicle', value: v.description }
    ];
    if (v.vin) particulars.push({ label: 'VIN', value: v.vin });
    if (v.odometerMiles !== undefined) particulars.push({ label: 'Last recorded odometer', value: formatMiles(v.odometerMiles) });
    if (v.motExpiry) particulars.push({ label: 'MOT expiry', value: formatDateLong(v.motExpiry) });
    particulars.push({ label: 'Location for inspection', value: v.location });
    if (v.locationContact) particulars.push({ label: 'Contact at location', value: v.locationContact });
    if (v.keysWith) particulars.push({ label: 'Keys', value: `With ${v.keysWith}` });
    const extraQuestions = d.questions && d.questions.length > 0 ? `${h2('Specific questions')}${numberedList(d.questions, { start: REPORT_CONTENTS.length + 1 })}` : '';
    const courtSection = d.forCourt
      ? `${h2('Court use')}
${p('The report may be relied on in court proceedings. It must comply with CPR Part 35 and Practice Direction 35: it is addressed to the court; it sets out the substance of all material instructions; it states that you understand your duty to the court and have complied with it (CPR 35.3 and 35.10); it contains the statement of truth in the wording of PD 35 paragraph 3.3; and it includes the declaration in the Guidance for the Instruction of Experts in Civil Claims.')}
${p(
  `If the claim is allocated to the small claims track, expert evidence may be used only with the court’s permission (CPR 27.5) and the fee recoverable from the other party is capped ${
    d.smallClaimsExpertFeeCapPence !== undefined ? `at ${formatGBP(d.smallClaimsExpertFeeCapPence)} per expert ` : ''
  }by PD 27A paragraph 7.3(2). Please keep the report proportionate.`
)}`
      : '';
    const salutation = d.recipient?.attention ? `Dear ${escapeHtml(d.recipient.attention)},` : 'Dear Sirs,';
    const body = `
${subjectBlock(forNonInsurer(d.claim), { ...CLAIMANT_LABEL, showThirdParty: false })}
<p>${salutation}</p>
${reLine('Instruction — independent inspection and report')}
${standardOpener(d.claim)}
${p('We instruct you to inspect the vehicle and provide an independent written report. The vehicle, the dates, the report contents and the fee are set out below.')}
${h2('The vehicle')}
${keyValueTable(particulars)}
${h2('The accident and the damage reported')}
${nl2p(d.accidentCircumstances)}
${nl2p(d.damageReported)}
${h2('Inspection')}
${p(`Please inspect the vehicle physically by ${formatDateWithDay(d.inspectionBy)}. If a physical inspection is not possible, tell us before proceeding; a desktop assessment must be identified as such in the report, with the reason.`)}
${h2('Report contents')}
${p('The report must cover each of the following, in this order.')}
${numberedList(REPORT_CONTENTS)}
${extraQuestions}
${courtSection}
${h2('Independence')}
${p('The report must be your own independent opinion. If any instruction in this letter conflicts with your opinion, say so in the report. Do not omit a finding because it does not assist the claim.')}
${h2('Fee')}
${p(`Your fee for the inspection and report is agreed at ${formatGBP(d.feePence)}. Please invoice ${brand.company.registeredName}, quoting our reference ${d.claim.ourReference}, and show the instruction date and the work done on the invoice.`)}
${deadlineCallout(
  d.reportBy,
  'We require the report, with photographs and estimate, by',
  'If you cannot meet the inspection or report date, tell us within one working day of receiving this letter so the instruction can be reallocated. Hire and storage charges run while the report is awaited, and delay attributable to the inspection is recorded in the claim chronology.',
  'Report due'
)}
${enclosuresBlock(d.enclosures)}`;
    return baseLayout({
      title: 'Engineer instruction',
      kind: 'letter',
      reference: d.claim.ourReference,
      date: d.date,
      recipient: d.recipient,
      settings: d.settings,
      signatory: defaultSignatory(d),
      bodyHtml: body
    });
  }
};
registerTemplate(engineerInstructionTemplate);
