/**
 * Letters A — correspondence with the at-fault insurer, group A.
 *
 *   letter.ncaf                      New Claim Advice Form: covering letter + the form as tables
 *   letter.handling_ref_request      Chase for the handling office and claim reference
 *   letter.intervention_reply        Reply, within one working day, to an offer of a replacement vehicle
 *   letter.collect_or_pay            Vehicle in storage after the engineer's report: collect, authorise disposal, or pay
 *   letter.delay_notice_gta_4_10     Repair delay notice (GTA 4.10–4.11 cited as industry practice)
 *   letter.chaser_7 / _14 / _21      Payment escalation ladder: enquiry → requirement → formal notice
 *   letter.vendor_verification_pack  Covering letter for the vendor set-up / Confirmation of Payee documents
 *
 * Every template is a pure function of its data object, which the API assembles from the ledger, events, the
 * intervention register, the clocks engine and settings. No template reads the clock or retypes a figure: every
 * amount and date is printed from `data` through format.ts.
 *
 * Voice (voice.md): who we are → the facts, dated → their position stated fairly, then why it fails → numbered
 * requirements → a deadline and the consequence. Perimeter (perimeter.md): "we are instructed to correspond on
 * behalf of"; the claimant is the litigant in person; the GTA is an industry benchmark for a non-subscriber, never an
 * entitlement; no forum is named that is not open to a third-party claimant against the at-fault insurer.
 */
import type { ISODate, ISODateTime, Pence } from '@ccguk/domain';
import { brand } from '../brand.js';
import { type BaseDocumentData, type FigureRow, GTA_BENCHMARK_SENTENCE, type Signatory, sampleBaseData, sampleClaim, sampleRecipient } from '../common.js';
import {
  bulletList,
  escapeHtml,
  formatDateLong,
  formatDateTime,
  formatDateWithDay,
  formatGBP,
  formatRate,
  formatRegistration,
  formatTime,
  joinAnd,
  nl2p,
  numberedList,
  plural
} from '../format.js';
import {
  attributionLabel,
  baseLayout,
  callout,
  chronologyTable,
  type ChronologyEvent,
  figuresTable,
  keyValueTable,
  standardOpener,
  subjectBlock
} from '../layout.js';
import { type AnyTemplate, registerTemplate, type Template } from '../registry.js';

type DateLike = ISODate | ISODateTime;

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const SALUTATION = '<p>Dear Sirs,</p>';

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

function signatoryOf(d: BaseDocumentData): Signatory {
  return d.signatory ?? { name: d.settings.signatoryName, role: d.settings.signatoryRole };
}

/** "Claimant" rather than "Our client": the claimant is the litigant in person (perimeter.md). */
function subject(d: BaseDocumentData): string {
  return subjectBlock(d.claim, { claimantLabel: 'Claimant' });
}

function letter(d: BaseDocumentData, title: string, bodyHtml: string): string {
  return baseLayout({
    title,
    kind: 'letter',
    reference: d.claim.ourReference,
    theirReference: d.claim.theirReference,
    date: d.date,
    recipient: d.recipient,
    settings: d.settings,
    signatory: signatoryOf(d),
    bodyHtml
  });
}

/** `17:00 on Wednesday 19 August 2026` — for date-time deadlines. */
function timeAndDay(iso: DateLike): string {
  return `${formatTime(iso)} on ${formatDateWithDay(iso)}`;
}

/** `5pm on Monday 19 October 2026` — for day deadlines. */
function fivePm(iso: DateLike): string {
  return `5pm on ${formatDateWithDay(iso)}`;
}

function rateWithVat(pence: Pence, includesVat: boolean | undefined): string {
  const base = formatRate(pence, 'day');
  if (includesVat === undefined) return base;
  return `${base} ${includesVat ? 'including' : 'excluding'} VAT`;
}

function yesNo(v: boolean | undefined, whenUndefined = 'Not stated'): string {
  if (v === undefined) return whenUndefined;
  return v ? 'Yes' : 'No';
}

/** Generic table with a header row; every cell is escaped. Columns listed in `numeric` are right-aligned. */
function dataTable(headings: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>, opts: { caption?: string; numeric?: number[] } = {}): string {
  if (rows.length === 0) return '';
  const numeric = new Set(opts.numeric ?? []);
  const head = `<thead><tr>${headings.map((h, i) => `<th${numeric.has(i) ? ' class="num"' : ''}>${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
  const body = rows
    .map((r) => `<tr>${r.map((cell, i) => `<td${numeric.has(i) ? ' class="num"' : ''}>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('\n');
  return `<table class="data">${opts.caption ? `<caption>${escapeHtml(opts.caption)}</caption>` : ''}${head}<tbody>\n${body}\n</tbody></table>`;
}

const SENT_BY_LABELS: Record<string, string> = {
  email: 'by email',
  post: 'by post',
  portal: 'through your online portal',
  fax: 'by fax',
  hand: 'by hand'
};

function sentByLabel(channel: string): string {
  return SENT_BY_LABELS[channel.toLowerCase()] ?? `by ${channel}`;
}

/** Attribution codes (ClaimEvent.attributableTo) as they read mid-sentence, addressed to the insurer. */
const ATTRIBUTION_PHRASES: Record<string, string> = {
  insurer: 'you',
  client: 'the claimant',
  ccguk: 'us',
  repairer: 'the repairer',
  engineer: 'the engineer',
  third_party: 'the third party',
  court: 'the court'
};

function attributionPhrase(code: string): string {
  return ATTRIBUTION_PHRASES[code.toLowerCase()] ?? (attributionLabel(code) || code);
}

// ---------------------------------------------------------------------------
// letter.ncaf — New Claim Advice Form
// ---------------------------------------------------------------------------

export type NcafServiceKind = 'hire' | 'recovery' | 'storage' | 'engineer';

const SERVICE_LABELS: Record<NcafServiceKind, string> = {
  hire: 'Replacement vehicle (credit hire)',
  recovery: 'Recovery',
  storage: 'Storage',
  engineer: 'Independent engineer’s inspection and report'
};

export interface NcafService {
  kind: NcafServiceKind;
  /** When the claimant agreed the service with us (GTA 4.1 runs from here as industry practice). */
  agreedAt: DateLike;
  /** When the service started (hire delivery, recovery, storage in), if it has. */
  startAt?: DateLike;
  detail?: string;
}

export interface NcafClaimant {
  name: string;
  addressLines: string[];
  phone?: string;
  email?: string;
  occupation?: string;
}

export interface NcafThirdParty {
  driverName: string;
  vehicleRegistration: string;
  vehicleDescription?: string;
  insurerName: string;
  policyNumber?: string;
}

export interface NcafLetterData extends BaseDocumentData {
  claimant: NcafClaimant;
  vehicle: {
    roadworthy: boolean;
    /** Where the vehicle is now (storage yard, claimant's address, repairer). */
    location?: string;
    damageSummary?: string;
  };
  accident: {
    at: DateLike;
    place: string;
    /** Structured liability narrative from intake, in one paragraph. */
    circumstances: string;
    policeReference?: string;
    /** e.g. "Your insured accepted fault at the scene." */
    liabilitySummary?: string;
  };
  thirdParty: NcafThirdParty;
  services: NcafService[];
  /** GTA group of the hire vehicle — printed as an industry benchmark, never as an entitlement. */
  gtaGroup: string;
  dailyRatePence: Pence;
  rateIncludesVat?: boolean;
  hireVehicleDescription?: string;
  /** Five working days from this form (clock gta_4_2_handling_ref_5wd) — computed by the API. */
  handlingRefDueAt: ISODate;
}

export const ncafTemplate: Template<NcafLetterData> = {
  id: 'letter.ncaf',
  version: '1.0.0',
  kind: 'letter',
  title: 'New Claim Advice Form',
  recipientRole: 'at_fault_insurer',
  description: 'Day-1 notification to the at-fault insurer: claim facts, services agreed, hire group and rate, request for handling office and reference.',
  requiredData: [
    ...BASE_REQUIRED,
    'claimant.name',
    'claimant.addressLines',
    'vehicle.roadworthy',
    'accident.at',
    'accident.place',
    'accident.circumstances',
    'thirdParty.driverName',
    'thirdParty.vehicleRegistration',
    'thirdParty.insurerName',
    'services',
    'gtaGroup',
    'dailyRatePence',
    'handlingRefDueAt'
  ],
  sample: () => ({
    ...sampleBaseData({
      date: '2026-08-10',
      claim: sampleClaim({ theirReference: undefined }),
      recipient: sampleRecipient({ attention: 'New Claims — Third Party Claims Team' })
    }),
    claimant: {
      name: 'Ms Jane Example',
      addressLines: ['1 Example Street', 'Example Town', 'EX2 2BB'],
      phone: '07700 900123',
      email: 'jane.example@example.test',
      occupation: 'Community nurse'
    },
    vehicle: {
      roadworthy: false,
      location: 'Our storage yard, Example Yard, Example Town',
      damageSummary: 'Front offside impact: bumper, wing, headlamp and bonnet. Airbags not deployed. Vehicle not driveable.'
    },
    accident: {
      at: '2026-08-09T14:35:00+01:00',
      place: 'Junction of High Street and Station Road, Example Town',
      circumstances:
        'The claimant was stationary at the junction, waiting to turn left. The third-party vehicle, turning right out of Station Road, cut across her path and struck the front offside of her vehicle. Details were exchanged at the scene.',
      liabilitySummary: 'Your insured accepted fault at the scene.'
    },
    thirdParty: {
      driverName: 'Mr John Sample',
      vehicleRegistration: 'XY65ZZZ',
      vehicleDescription: 'Ford Transit Custom',
      insurerName: 'Example Insurance plc',
      policyNumber: 'EXI-POL-0099881'
    },
    services: [
      { kind: 'recovery', agreedAt: '2026-08-09', startAt: '2026-08-09T16:10:00+01:00', detail: 'From the scene to our storage yard, 12 loaded miles.' },
      { kind: 'storage', agreedAt: '2026-08-09', startAt: '2026-08-09', detail: 'Vehicle unroadworthy; held pending inspection.' },
      { kind: 'engineer', agreedAt: '2026-08-10', detail: 'Independent engineer instructed; inspection at the yard to be arranged.' },
      { kind: 'hire', agreedAt: '2026-08-10', startAt: '2026-08-10T09:30:00+01:00', detail: 'Credit hire agreement signed by the claimant on 10 August 2026.' }
    ],
    gtaGroup: 'M',
    dailyRatePence: 4980,
    rateIncludesVat: false,
    hireVehicleDescription: 'Volkswagen Golf 1.5 TSI Life',
    handlingRefDueAt: '2026-08-17'
  }),
  render: (d) => {
    const hireService = d.services.find((s) => s.kind === 'hire');
    const claimantRows = [
      { label: 'Name', value: d.claimant.name },
      { label: 'Address', value: d.claimant.addressLines.filter((l) => l.trim() !== '').join(', ') }
    ];
    if (d.claimant.phone) claimantRows.push({ label: 'Telephone', value: d.claimant.phone });
    if (d.claimant.email) claimantRows.push({ label: 'Email', value: d.claimant.email });
    if (d.claimant.occupation) claimantRows.push({ label: 'Occupation', value: d.claimant.occupation });

    const vehicleRows = [
      { label: 'Registration', value: formatRegistration(d.claim.vehicleRegistration) },
      { label: 'Make and model', value: d.claim.vehicleDescription ?? 'See engineer’s report' },
      { label: 'Roadworthy after the accident', value: yesNo(d.vehicle.roadworthy) }
    ];
    if (d.vehicle.location) vehicleRows.push({ label: 'Current location', value: d.vehicle.location });
    if (d.vehicle.damageSummary) vehicleRows.push({ label: 'Damage', value: d.vehicle.damageSummary });

    const accidentRows = [
      { label: 'Date and time', value: formatDateTime(d.accident.at) },
      { label: 'Place', value: d.accident.place },
      { label: 'Circumstances', value: d.accident.circumstances }
    ];
    if (d.accident.policeReference) accidentRows.push({ label: 'Police reference', value: d.accident.policeReference });
    if (d.accident.liabilitySummary) accidentRows.push({ label: 'Liability', value: d.accident.liabilitySummary });

    const tpRows = [
      { label: 'Driver', value: d.thirdParty.driverName },
      { label: 'Vehicle registration', value: formatRegistration(d.thirdParty.vehicleRegistration) }
    ];
    if (d.thirdParty.vehicleDescription) tpRows.push({ label: 'Vehicle', value: d.thirdParty.vehicleDescription });
    tpRows.push({ label: 'Insurer', value: d.thirdParty.insurerName });
    if (d.thirdParty.policyNumber) tpRows.push({ label: 'Policy number', value: d.thirdParty.policyNumber });

    const serviceRows = d.services.map((s) => [
      SERVICE_LABELS[s.kind],
      formatDateLong(s.agreedAt),
      s.startAt ? formatDateTime(s.startAt) : 'Not yet started',
      s.detail ?? ''
    ]);

    const hireRows = [
      { label: 'Vehicle on hire', value: d.hireVehicleDescription ?? 'To be confirmed on delivery' },
      { label: 'GTA group (industry benchmark)', value: d.gtaGroup },
      { label: 'Daily rate', value: rateWithVat(d.dailyRatePence, d.rateIncludesVat) }
    ];
    if (hireService?.startAt) hireRows.push({ label: 'Hire started', value: formatDateTime(hireService.startAt) });
    hireRows.push({ label: 'Hire ends', value: 'When the claimant’s vehicle is repaired and returned, or a total-loss settlement is paid, whichever is sooner' });

    const body = `
${subject(d)}
${SALUTATION}
${standardOpener(d.claim)}
<p>We notify you of the claim and of the services the claimant has agreed with us. The New Claim Advice Form is set out below. GTA paragraph 4.1 reflects the industry practice of sending this form within one working day of services being agreed. ${GTA_BENCHMARK_SENTENCE}</p>

<h2>New Claim Advice Form</h2>
${keyValueTable(claimantRows, 'Claimant')}
${keyValueTable(vehicleRows, 'Claimant’s vehicle')}
${keyValueTable(accidentRows, 'Accident')}
${keyValueTable(tpRows, 'Third party (your insured)')}
${dataTable(['Service', 'Agreed', 'Started', 'Details'], serviceRows, { caption: 'Services agreed with the claimant' })}
${keyValueTable(hireRows, 'Replacement vehicle')}

<h2>What we ask</h2>
${numberedList([
  `Confirm the office handling this claim and your claim reference within five working days, that is by ${formatDateWithDay(d.handlingRefDueAt)}. GTA paragraph 4.2 reflects this as industry practice.`,
  'If you consider that you had already offered the claimant a replacement vehicle before receiving this form, say so within the same period, with the date, time, channel and terms of that offer. GTA paragraph 3.6 reflects this as industry practice.',
  'Confirm whether your insured’s liability for the accident is admitted. If it is not, state the basis of the dispute.',
  'If the engineer’s report, hire documents and invoices should go to a different address or mailbox, tell us which.'
])}
${callout(
  `<p>Please reply by ${fivePm(d.handlingRefDueAt)}. Until we have your reference we will correspond with the address above and quote our reference ${escapeHtml(
    d.claim.ourReference
  )}. The date of this form is the date of notification recorded on our file.</p>`,
  'Handling office and reference'
)}
<p>Please quote our reference in all correspondence. Email to ${escapeHtml(brand.company.claimsEmail)} is the quickest route to the handler.</p>`;
    return letter(d, 'New Claim Advice Form', body);
  }
};

// ---------------------------------------------------------------------------
// letter.handling_ref_request — chase for the handling office and reference
// ---------------------------------------------------------------------------

export interface HandlingRefRequestData extends BaseDocumentData {
  ncaf: {
    sentAt: DateLike;
    /** 'email' | 'post' | 'portal' … */
    sentBy: string;
    /** The mailbox or address it went to, so the insurer can find it. */
    sentTo: string;
  };
  /** The five-working-day date given in the form, now passed. */
  handlingRefDueAt: ISODate;
  /** Earlier chases on the same point, if any. */
  previousRequests?: ISODate[];
  hire?: { vehicleDescription?: string; gtaGroup: string; dailyRatePence: Pence; startAt: DateLike };
  storage?: { location: string; dailyRatePence: Pence; startAt: DateLike };
  responseDeadline: ISODate;
}

export const handlingRefRequestTemplate: Template<HandlingRefRequestData> = {
  id: 'letter.handling_ref_request',
  version: '1.0.0',
  kind: 'letter',
  title: 'Request for handling office and claim reference',
  recipientRole: 'at_fault_insurer',
  description: 'Chase when the five-working-day request in the New Claim Advice Form has gone unanswered.',
  requiredData: [...BASE_REQUIRED, 'ncaf.sentAt', 'ncaf.sentBy', 'ncaf.sentTo', 'handlingRefDueAt', 'responseDeadline'],
  sample: () => ({
    ...sampleBaseData({ date: '2026-08-19', claim: sampleClaim({ theirReference: undefined }) }),
    ncaf: { sentAt: '2026-08-10', sentBy: 'email', sentTo: 'thirdpartyclaims@example-insurer.test' },
    handlingRefDueAt: '2026-08-17',
    hire: { vehicleDescription: 'Volkswagen Golf 1.5 TSI Life', gtaGroup: 'M', dailyRatePence: 4980, startAt: '2026-08-10' },
    storage: { location: 'Example Yard, Example Town', dailyRatePence: 4500, startAt: '2026-08-09' },
    responseDeadline: '2026-08-24'
  }),
  render: (d) => {
    const running: string[] = [];
    if (d.hire) {
      running.push(
        `Hire of ${d.hire.vehicleDescription ? `a ${escapeHtml(d.hire.vehicleDescription)}` : 'a replacement vehicle'} (GTA group ${escapeHtml(
          d.hire.gtaGroup
        )}, industry benchmark) at ${escapeHtml(formatRate(d.hire.dailyRatePence, 'day'))} has run since ${escapeHtml(formatDateLong(d.hire.startAt))}.`
      );
    }
    if (d.storage) {
      running.push(
        `The claimant’s vehicle has been in storage at ${escapeHtml(d.storage.location)} since ${escapeHtml(formatDateLong(d.storage.startAt))} at ${escapeHtml(
          formatRate(d.storage.dailyRatePence, 'day')
        )}.`
      );
    }
    const previous = d.previousRequests?.length ? `<p>We asked again on ${escapeHtml(joinAnd(d.previousRequests.map(formatDateLong)))}.</p>` : '';

    const body = `
${subject(d)}
${SALUTATION}
${standardOpener(d.claim)}
<h2>The facts</h2>
<p>On ${escapeHtml(formatDateLong(d.ncaf.sentAt))} we sent you our New Claim Advice Form ${escapeHtml(sentByLabel(d.ncaf.sentBy))} to ${escapeHtml(
      d.ncaf.sentTo
    )}. It asked you to confirm the office handling the claim and your reference within five working days, that is by ${escapeHtml(
      formatDateLong(d.handlingRefDueAt)
    )}. We have had no reply.</p>
${previous}
${running.length ? `<p>${running.join(' ')} Until a handler and reference are allocated, nothing on this claim can be agreed with you, and each day of delay is recorded on our chronology as attributable to you.</p>` : ''}
<h2>What we require</h2>
${numberedList([
  'The office handling this claim, with its postal address and email address.',
  'Your claim reference.',
  'The name and direct contact details of the handler or team dealing with it.',
  `Confirmation that our form of ${formatDateLong(d.ncaf.sentAt)} was received, and if you say it was received on a later date, that date.`
])}
${callout(
  `<p>We require this information by ${escapeHtml(fivePm(d.responseDeadline))}. If we do not receive it, we will continue to correspond with the address above, treat the claim as notified to you on ${escapeHtml(
    formatDateLong(d.ncaf.sentAt)
  )}, and record the period from ${escapeHtml(formatDateLong(d.handlingRefDueAt))} as delay attributable to you.</p>`,
  'Deadline'
)}`;
    return letter(d, 'Request for handling office and claim reference', body);
  }
};

// ---------------------------------------------------------------------------
// letter.intervention_reply — reply to an offer of a replacement vehicle
// ---------------------------------------------------------------------------

export type InterventionChannel = 'phone' | 'email' | 'letter' | 'sms' | 'whatsapp' | 'portal' | 'via_client';

const CHANNEL_LABELS: Record<InterventionChannel, string> = {
  phone: 'by telephone',
  email: 'by email',
  letter: 'by letter',
  sms: 'by text message',
  whatsapp: 'by WhatsApp message',
  portal: 'through your online portal',
  via_client: 'directly to the claimant, who reported it to us'
};

/** The offer as logged in the intervention register (BLUEPRINT §3.6), with names resolved for printing. */
export interface InterventionOfferDetails {
  receivedAt: ISODateTime;
  channel: InterventionChannel;
  /** Who made the offer, as recorded: "Example Insurance plc claims handler (name not given)". */
  offerorName: string;
  /** Who received it: 'claimant' or 'ccguk'. */
  madeTo: 'claimant' | 'ccguk';
  vehicleClassOffered?: string;
  dailyRatePence?: Pence;
  rateIncludesVat?: boolean;
  terms: {
    excessPence?: Pence;
    mileageLimitPerDay?: number;
    deliveryIncluded?: boolean;
    insuranceIncluded?: boolean;
    durationStated?: string;
    otherTerms?: string;
  };
  /** Were the cost of the vehicle to the insurer and the terms explained when the offer was made? (Copley v Lawn) */
  termsExplained: boolean;
  suitable: boolean;
  suitabilityReasons: string[];
  clientDecision: 'accepted' | 'declined';
  /** The claimant's reasons, in their own words (from the Mitigation Questionnaire). */
  clientReasons: string;
  clientDecisionAt: ISODateTime;
}

export interface InterventionReplyData extends BaseDocumentData {
  offer: InterventionOfferDetails;
  /** The current hire, from the hire agreement. */
  hire: { vehicleDescription: string; gtaGroup: string; dailyRatePence: Pence; startAt: DateLike };
  /** Accepted offers: the delivery date and time agreed, if one has been given. Hire ends on delivery. */
  deliveryAt?: DateLike;
  /**
   * True when the clocks engine confirms this letter goes within one working day of the offer
   * (clock intervention_reply_1wd). The letter only claims it when told; otherwise it simply dates the offer.
   */
  sentWithinOneWorkingDay?: boolean;
  responseDeadline: ISODate;
}

export const interventionReplyTemplate: Template<InterventionReplyData> = {
  id: 'letter.intervention_reply',
  version: '1.0.0',
  kind: 'letter',
  title: 'Reply to your offer of a replacement vehicle',
  recipientRole: 'at_fault_insurer',
  description: 'Written reply within one working day: records the offer exactly, states suitability and the claimant’s decision with reasons, asks for the terms in writing.',
  requiredData: [
    ...BASE_REQUIRED,
    'offer.receivedAt',
    'offer.channel',
    'offer.offerorName',
    'offer.madeTo',
    'offer.terms',
    'offer.termsExplained',
    'offer.suitable',
    'offer.suitabilityReasons',
    'offer.clientDecision',
    'offer.clientReasons',
    'offer.clientDecisionAt',
    'hire.vehicleDescription',
    'hire.gtaGroup',
    'hire.dailyRatePence',
    'hire.startAt',
    'responseDeadline'
  ],
  sample: () => ({
    ...sampleBaseData({ date: '2026-08-13' }),
    offer: {
      receivedAt: '2026-08-12T10:40:00+01:00',
      channel: 'phone',
      offerorName: 'A claims handler of Example Insurance plc (name not given)',
      madeTo: 'claimant',
      vehicleClassOffered: 'A “small car”; make and model not stated',
      dailyRatePence: 2037,
      rateIncludesVat: undefined,
      terms: {},
      termsExplained: false,
      suitable: false,
      suitabilityReasons: [
        'The class of vehicle was not identified beyond “small car”, and no delivery date was given.',
        'The claimant has had a replacement vehicle on hire since 10 August 2026. No explanation was given of how a change of vehicle would be arranged or what the claimant would be without in the meantime.',
        'The cost of the vehicle to you, the excess, the mileage limit and the insurance position were not explained.'
      ],
      clientDecision: 'declined',
      clientReasons:
        'I was telephoned at work and asked whether I would accept a car. I was not told what car, when it would come, what excess I would carry or what it would cost anyone. I already had a car from Courtesy Cars and did not want to be without transport while one was swapped for another. I said I would need the details in writing before deciding, and none were sent.',
      clientDecisionAt: '2026-08-12T18:05:00+01:00'
    },
    hire: { vehicleDescription: 'Volkswagen Golf 1.5 TSI Life', gtaGroup: 'M', dailyRatePence: 4980, startAt: '2026-08-10' },
    sentWithinOneWorkingDay: true,
    responseDeadline: '2026-08-20'
  }),
  render: (d) => {
    const o = d.offer;
    const rate = o.dailyRatePence !== undefined ? rateWithVat(o.dailyRatePence, o.rateIncludesVat) : 'Not stated';
    const offerRows = [
      { label: 'Received', value: formatDateTime(o.receivedAt) },
      { label: 'Channel', value: `${CHANNEL_LABELS[o.channel]}${o.madeTo === 'claimant' && o.channel !== 'via_client' ? ', to the claimant directly' : o.madeTo === 'ccguk' ? ', to us' : ''}` },
      { label: 'Made by', value: o.offerorName },
      { label: 'Vehicle offered', value: o.vehicleClassOffered ?? 'Not stated' },
      { label: 'Rate quoted', value: rate },
      { label: 'Excess', value: o.terms.excessPence !== undefined ? formatGBP(o.terms.excessPence) : 'Not stated' },
      { label: 'Mileage limit', value: o.terms.mileageLimitPerDay !== undefined ? `${plural(o.terms.mileageLimitPerDay, 'mile')} per day` : 'Not stated' },
      { label: 'Delivery included', value: yesNo(o.terms.deliveryIncluded) },
      { label: 'Insurance included', value: yesNo(o.terms.insuranceIncluded) },
      { label: 'Duration', value: o.terms.durationStated ?? 'Not stated' }
    ];
    if (o.terms.otherTerms) offerRows.push({ label: 'Other terms', value: o.terms.otherTerms });

    const hireDesc = `${escapeHtml(d.hire.vehicleDescription)} (GTA group ${escapeHtml(d.hire.gtaGroup)}, industry benchmark) at ${escapeHtml(formatRate(d.hire.dailyRatePence, 'day'))}`;

    const explained = o.termsExplained
      ? '<p>The cost of the vehicle to you and the terms of the offer were explained when it was made, as recorded above.</p>'
      : '<p>The cost of the vehicle to you and the terms on which it was offered were not explained when the offer was made. A claimant who declines an offer whose cost and terms have not been explained does not, by that alone, act unreasonably (Copley v Lawn [2009] EWCA Civ 580).</p>';

    const suitability = o.suitable
      ? `<p>The vehicle offered is suitable for the claimant’s needs${o.suitabilityReasons.length ? ', for the following reasons.' : '.'}</p>${bulletList(o.suitabilityReasons)}`
      : `<p>We do not consider the vehicle offered suitable${o.suitabilityReasons.length ? ', for the following reasons.' : '.'}</p>${bulletList(o.suitabilityReasons)}`;

    const accepted = o.clientDecision === 'accepted';
    const decision = accepted
      ? `<p>The claimant accepted the offer on ${escapeHtml(formatDateTime(o.clientDecisionAt))}. Hire of the ${hireDesc} will end on delivery of your vehicle${
          d.deliveryAt ? `, which you have told us will be at ${escapeHtml(formatDateTime(d.deliveryAt))}` : ''
        }. Our hire charges run from ${escapeHtml(formatDateLong(d.hire.startAt))} to the date of delivery and will be invoiced on that basis.</p>`
      : `<p>The claimant declined the offer on ${escapeHtml(formatDateTime(o.clientDecisionAt))}. Hire of the ${hireDesc} continues from ${escapeHtml(
          formatDateLong(d.hire.startAt)
        )} and is claimed against your insured.</p>`;
    const reasons = `<p>The claimant’s reasons, in the claimant’s words:</p>${nl2p(o.clientReasons)}`;

    const requirements = accepted
      ? [
          'Written confirmation of the terms of the offer: the vehicle, the daily cost to you, the excess, any mileage limit, the insurance position and the duration.',
          d.deliveryAt
            ? `Confirmation of delivery at ${formatDateTime(d.deliveryAt)} to the claimant’s address, and the name of the delivering supplier.`
            : 'The delivery date, time and the name of the delivering supplier.',
          'Confirmation that you accept our hire charges to the date of delivery.'
        ]
      : [
          'Written confirmation of the terms of the offer as you record them: the vehicle, the daily cost to you, the excess, any mileage limit, the insurance position and the duration.',
          'If you say the offer was suitable and its cost and terms were explained, the call recording or contemporaneous note on which you rely.',
          'Confirmation of whether the offer remains open and, if so, on what terms, so that it can be put to the claimant in writing.'
        ];

    const body = `
${subject(d)}
${SALUTATION}
${standardOpener(d.claim)}
<p>${
      d.sentWithinOneWorkingDay
        ? `This letter is sent within one working day of your offer of a replacement vehicle, received on ${escapeHtml(formatDateTime(o.receivedAt))}.`
        : `This letter replies to your offer of a replacement vehicle, received on ${escapeHtml(formatDateTime(o.receivedAt))}.`
    } It records the offer as made, states whether it was suitable, and gives the claimant’s decision with reasons.</p>
<h2>The offer as recorded</h2>
${keyValueTable(offerRows)}
<p>If any of this does not accord with your record of the offer, tell us by return and enclose your recording or note.</p>
<h2>Suitability</h2>
${suitability}
${explained}
<h2>The claimant’s decision</h2>
${decision}
${reasons}
<h2>What we require</h2>
${numberedList(requirements)}
${callout(
  `<p>Please reply by ${escapeHtml(fivePm(d.responseDeadline))}. If we do not hear from you by then, we will proceed on the basis that the offer was as recorded above and that its cost and terms were ${
    o.termsExplained ? 'as stated' : 'not explained'
  }. This letter and your reply will form part of the mitigation record sent with our payment pack.</p>`,
  'Deadline'
)}`;
    return letter(d, 'Reply to your offer of a replacement vehicle', body);
  }
};

// ---------------------------------------------------------------------------
// letter.collect_or_pay — vehicle in storage after the engineer's report
// ---------------------------------------------------------------------------

export type EngineerOutcome = 'total_loss' | 'repairable' | 'uneconomic_repair';

const OUTCOME_SENTENCES: Record<EngineerOutcome, string> = {
  total_loss: 'assesses the vehicle as a total loss',
  repairable: 'assesses the vehicle as repairable',
  uneconomic_repair: 'assesses the vehicle as uneconomic to repair'
};

export interface CollectOrPayData extends BaseDocumentData {
  report: {
    issuedAt: ISODate;
    engineerName: string;
    reference?: string;
    outcome: EngineerOutcome;
    pavPence?: Pence;
    /** One line, if the report says something the insurer needs now (salvage category, parts lead time). */
    summary?: string;
  };
  storage: {
    /** The yard, as it should be printed: "Example Yard". */
    location: string;
    addressLines: string[];
    startAt: DateLike;
    dailyRatePence: Pence;
    rateIncludesVat?: boolean;
    /** Days accrued to the date of this notice and the charge to date — from the ledger. */
    daysToDate: number;
    accruedToDatePence: Pence;
  };
  /** Forty-eight hours from this notice, computed by the API (clock, not the template). */
  collectBy: ISODateTime;
  collectionContact: { name: string; phone: string; email?: string; hours: string };
  /** Print a copy line for the claimant (the notice goes to both, BLUEPRINT §3.4). */
  copyToClaimant?: boolean;
}

export const collectOrPayTemplate: Template<CollectOrPayData> = {
  id: 'letter.collect_or_pay',
  version: '1.0.0',
  kind: 'letter',
  title: 'Notice: collect the vehicle or storage continues at your cost',
  recipientRole: 'at_fault_insurer',
  description: 'Sent on the day the engineer’s report issues: collect or authorise disposal within 48 hours, or storage continues and is attributable to the insurer’s delay.',
  requiredData: [
    ...BASE_REQUIRED,
    'report.issuedAt',
    'report.engineerName',
    'report.outcome',
    'storage.location',
    'storage.addressLines',
    'storage.startAt',
    'storage.dailyRatePence',
    'storage.daysToDate',
    'storage.accruedToDatePence',
    'collectBy',
    'collectionContact.name',
    'collectionContact.phone',
    'collectionContact.hours'
  ],
  sample: () => ({
    ...sampleBaseData({ date: '2026-08-17' }),
    report: {
      issuedAt: '2026-08-17',
      engineerName: 'Example Assessors Ltd',
      reference: 'EA/26/3310',
      outcome: 'total_loss',
      pavPence: 865000,
      summary: 'Category S salvage. The report and photographs are sent to you with this notice.'
    },
    storage: {
      location: 'Example Yard',
      addressLines: ['Unit 4, Example Industrial Estate', 'Example Town', 'EX3 3CC'],
      startAt: '2026-08-09',
      dailyRatePence: 4500,
      rateIncludesVat: false,
      daysToDate: 9,
      accruedToDatePence: 40500
    },
    collectBy: '2026-08-19T17:00:00+01:00',
    collectionContact: { name: 'Yard office, Courtesy Cars Group UK Ltd', phone: '020 7052 5403', email: 'claims@courtesycars.net', hours: 'Monday to Friday, 08:30 to 17:00' },
    copyToClaimant: true
  }),
  render: (d) => {
    const r = d.report;
    const s = d.storage;
    const outcome = `${OUTCOME_SENTENCES[r.outcome]}${r.pavPence !== undefined ? `, with a pre-accident value of ${formatGBP(r.pavPence)}` : ''}`;
    const yardAddress = [s.location, ...s.addressLines].filter((l) => l.trim() !== '').join(', ');
    const contact = [d.collectionContact.name, d.collectionContact.phone, d.collectionContact.email ?? '', d.collectionContact.hours].filter((x) => x !== '');

    const body = `
${subject(d)}
${SALUTATION}
${standardOpener(d.claim)}
<h2>The facts</h2>
<p>The claimant’s vehicle, ${escapeHtml(formatRegistration(d.claim.vehicleRegistration))}, is held at ${escapeHtml(yardAddress)}. Storage has run from ${escapeHtml(
      formatDateLong(s.startAt)
    )} at ${escapeHtml(rateWithVat(s.dailyRatePence, s.rateIncludesVat))}. To the date of this notice that is ${escapeHtml(plural(s.daysToDate, 'day'))}, ${escapeHtml(
      formatGBP(s.accruedToDatePence)
    )}.</p>
<p>${escapeHtml(r.engineerName)} issued its report on ${escapeHtml(formatDateLong(r.issuedAt))}${r.reference ? ` (reference ${escapeHtml(r.reference)})` : ''}. The report ${escapeHtml(
      outcome
    )}.${r.summary ? ` ${escapeHtml(r.summary)}` : ''}</p>
<p>With the report issued there is no reason connected with the claimant for the vehicle to stay in storage. What happens to it next is in your hands.</p>
<h2>What we require</h2>
${numberedList([
  `Collect the vehicle from ${yardAddress}, or move it to a repairer or salvage agent of your choice, within 48 hours of this notice, that is by ${timeAndDay(d.collectBy)}; or`,
  'Within the same period, authorise its disposal or repair in writing, naming the agent who will collect it and the date; or',
  `Confirm in writing that storage from ${timeAndDay(d.collectBy)} at ${formatRate(s.dailyRatePence, 'day')} will be met by you.`
])}
<p>Collection is arranged with: ${escapeHtml(contact.join(', '))}. Please give the yard the name of the collecting agent and the registration number. The claimant’s personal effects have been removed.</p>
${callout(
  `<p>If the vehicle has not been collected, and neither disposal nor repair has been authorised in writing, by ${escapeHtml(
    timeAndDay(d.collectBy)
  )}, storage continues at ${escapeHtml(formatRate(s.dailyRatePence, 'day'))} and is claimed from you. From that point the storage period is attributable to your delay, not to the claimant. The dates in this notice are the dates that will appear on our storage account and in the chronology sent with our payment pack.</p>`,
  `Storage after ${timeAndDay(d.collectBy)}`
)}
${d.copyToClaimant ? `<p class="small muted">Copy sent to the claimant, ${escapeHtml(d.claim.claimantName)}.</p>` : ''}`;
    return letter(d, 'Notice: collect the vehicle or storage continues at your cost', body);
  }
};

// ---------------------------------------------------------------------------
// letter.delay_notice_gta_4_10 — repair delay notice
// ---------------------------------------------------------------------------

export type RepairDelayKind = 'authorisation_delay' | 'repair_overrun' | 'parts_delay' | 'other';

export interface DelayNoticeData extends BaseDocumentData {
  repair: {
    repairerName: string;
    estimateIssuedAt: ISODate;
    estimatedWorkingDays: number;
    authorisedAt?: ISODate;
    startedAt?: ISODate;
    /** Completion date the estimate implied, computed by the API from the estimate and working-day calendar. */
    expectedCompletionAt?: ISODate;
  };
  delay: {
    kind: RepairDelayKind;
    /** Delay to the date of this notice, in working days (clocks engine). */
    workingDays: number;
    cause: string;
    /** 'insurer' | 'repairer' | 'engineer' | 'third_party' | 'other' — printed through attributionLabel. */
    attributableTo: string;
  };
  hire: { vehicleDescription: string; gtaGroup: string; dailyRatePence: Pence; startAt: DateLike; daysToDate: number; chargesToDatePence: Pence };
  chronology: ChronologyEvent[];
  /** Next progress check (five working days, GTA 4.11 as industry practice) — computed by the API. */
  nextCheckAt: ISODate;
  responseDeadline: ISODate;
}

export const delayNoticeTemplate: Template<DelayNoticeData> = {
  id: 'letter.delay_notice_gta_4_10',
  version: '1.0.0',
  kind: 'letter',
  title: 'Repair delay notice',
  recipientRole: 'at_fault_insurer',
  description: 'Reports a repair delay of two or more working days (or over 20% of the estimate): cause, attribution, hire continuing, next check date.',
  requiredData: [
    ...BASE_REQUIRED,
    'repair.repairerName',
    'repair.estimateIssuedAt',
    'repair.estimatedWorkingDays',
    'delay.kind',
    'delay.workingDays',
    'delay.cause',
    'delay.attributableTo',
    'hire.vehicleDescription',
    'hire.gtaGroup',
    'hire.dailyRatePence',
    'hire.startAt',
    'hire.daysToDate',
    'hire.chargesToDatePence',
    'chronology',
    'nextCheckAt',
    'responseDeadline'
  ],
  sample: () => ({
    ...sampleBaseData({ date: '2026-08-21' }),
    repair: { repairerName: 'Example Bodyshop Ltd', estimateIssuedAt: '2026-08-14', estimatedWorkingDays: 5 },
    delay: {
      kind: 'authorisation_delay',
      workingDays: 5,
      cause: 'Your authorisation of the repair estimate of 14 August 2026 is outstanding. The repairer cannot order parts or book the vehicle in until it is received.',
      attributableTo: 'insurer'
    },
    hire: { vehicleDescription: 'Volkswagen Golf 1.5 TSI Life', gtaGroup: 'M', dailyRatePence: 4980, startAt: '2026-08-10', daysToDate: 12, chargesToDatePence: 59760 },
    chronology: [
      { date: '2026-08-09', description: 'Accident. Vehicle unroadworthy; recovered to storage.', attributableTo: 'none' },
      { date: '2026-08-10', description: 'Hire commenced. New Claim Advice Form sent to you.', attributableTo: 'ccguk' },
      { date: '2026-08-14', description: 'Your engineer inspected the vehicle. Repair estimate issued by Example Bodyshop Ltd and sent to you.', attributableTo: 'insurer' },
      { date: '2026-08-19', description: 'Authorisation check at three working days: no authorisation received.', attributableTo: 'insurer' },
      { date: '2026-08-21', description: 'This notice. Authorisation still outstanding.', attributableTo: 'insurer' }
    ],
    nextCheckAt: '2026-08-28',
    responseDeadline: '2026-08-25'
  }),
  render: (d) => {
    const r = d.repair;
    const dl = d.delay;
    const attributed = attributionPhrase(dl.attributableTo);

    let situation: string;
    switch (dl.kind) {
      case 'authorisation_delay':
        situation = `Repair authorisation remains outstanding. The delay to the date of this notice is ${plural(dl.workingDays, 'working day')}.`;
        break;
      case 'repair_overrun':
        situation = `${r.startedAt ? `Repair started on ${formatDateLong(r.startedAt)}` : 'Repair started'}${
          r.expectedCompletionAt ? ` and was due to complete by ${formatDateLong(r.expectedCompletionAt)}` : ''
        }. It has overrun by ${plural(dl.workingDays, 'working day')} to the date of this notice.`;
        break;
      case 'parts_delay':
        situation = `Repair is held up for parts. The delay to the date of this notice is ${plural(dl.workingDays, 'working day')}.`;
        break;
      default:
        situation = `The delay to the date of this notice is ${plural(dl.workingDays, 'working day')}.`;
    }
    const authorised = r.authorisedAt ? ` You authorised the repair on ${escapeHtml(formatDateLong(r.authorisedAt))}.` : '';

    const requirements =
      dl.kind === 'authorisation_delay'
        ? [
            `Authorise the repair on the estimate of ${formatDateLong(r.estimateIssuedAt)}, or tell us why you will not, by ${fivePm(d.responseDeadline)}.`,
            'If you need anything further from the repairer or the engineer before you can authorise, say exactly what, so it can be supplied the same day.',
            `If you dispute that the delay is attributable to ${attributed}, say why, with dates.`
          ]
        : [
            `Confirm by ${fivePm(d.responseDeadline)} whether you dispute the cause of the delay set out above and, if so, on what basis.`,
            'Name any step you require from the claimant, the repairer or us to bring the repair to completion.',
            `If you dispute that the delay is attributable to ${attributed}, say why, with dates.`
          ];

    const body = `
${subject(d)}
${SALUTATION}
${standardOpener(d.claim)}
<p>This is a repair delay notice. GTA paragraphs 4.10–4.11 reflect industry practice: a repair delay of two or more working days, or of more than 20% of the estimated repair time, is reported to the insurer, and progress is checked every five working days. ${GTA_BENCHMARK_SENTENCE}</p>
<h2>The chronology</h2>
${chronologyTable(d.chronology)}
<h2>The delay</h2>
<p>${escapeHtml(r.repairerName)} issued its estimate on ${escapeHtml(formatDateLong(r.estimateIssuedAt))}. The estimated repair time was ${escapeHtml(
      plural(r.estimatedWorkingDays, 'working day')
    )}.${authorised} ${escapeHtml(situation)}</p>
<p>The cause: ${escapeHtml(dl.cause)}</p>
<p>We record this period as attributable to ${escapeHtml(attributed)}. It will appear on the hire chronology sent with our payment pack.</p>
<h2>Hire</h2>
<p>Hire of the ${escapeHtml(d.hire.vehicleDescription)} (GTA group ${escapeHtml(d.hire.gtaGroup)}, industry benchmark) at ${escapeHtml(
      formatRate(d.hire.dailyRatePence, 'day')
    )} has run since ${escapeHtml(formatDateLong(d.hire.startAt))}: ${escapeHtml(plural(d.hire.daysToDate, 'day'))} to date, ${escapeHtml(
      formatGBP(d.hire.chargesToDatePence)
    )}. Hire continues until the repair is complete and the vehicle is returned to the claimant. Every day of the delay set out above adds a day of hire.</p>
<h2>What we require</h2>
${numberedList(requirements)}
${callout(
  `<p>Please reply by ${escapeHtml(fivePm(d.responseDeadline))}. We will check progress again on ${escapeHtml(
    formatDateWithDay(d.nextCheckAt)
  )} and will send a further notice if the delay continues. Silence will be recorded as no dispute of the cause or of its attribution.</p>`,
  'Deadline and next check'
)}`;
    return letter(d, 'Repair delay notice', body);
  }
};

// ---------------------------------------------------------------------------
// letter.chaser_7 / chaser_14 / chaser_21 — the payment escalation ladder
// ---------------------------------------------------------------------------

export interface ChaserHead {
  /** Printed label: "Hire, 24 days at £49.80 per day". */
  label: string;
  claimedPence: Pence;
  receivedPence: Pence;
  outstandingPence: Pence;
}

export interface ChaserPayment {
  date: ISODate;
  amountPence: Pence;
  reference?: string;
}

export interface ChaserData extends BaseDocumentData {
  pack: {
    sentAt: ISODate;
    /** 'email' | 'post' | 'portal' */
    sentBy: string;
    sentTo?: string;
    /** Document titles in the pack, from the pack record. */
    contents: string[];
  };
  hire: { startAt: DateLike; endAt: DateLike; days: number; dailyRatePence: Pence; gtaGroup: string };
  heads: ChaserHead[];
  totals: { claimedPence: Pence; receivedPence: Pence; outstandingPence: Pence };
  /** Cleared payments received against the pack, from the ledger. */
  payments: ChaserPayment[];
  /** Calendar days from the pack to the date of this letter — computed by the API. */
  daysSincePack: number;
  /** One calendar month from the pack (GTA 6.7, industry benchmark) — computed by the API. */
  benchmarkDueAt: ISODate;
  /** When the claim was notified to the insurer (the New Claim Advice Form). */
  claimNotifiedAt: ISODate;
  /** Three months from notification (ICOBS 8.2.6R, as we understand it) — computed by the API. */
  icobsReplyDueAt: ISODate;
  /** The insurer's stated position on the balance, if any, and the handler's reply to it. */
  insurerPosition?: { statedAt: ISODate; summary: string; response: string[] };
  /** Earlier letters in this ladder. */
  previousLetters?: ISODate[];
  responseDeadline: ISODate;
  /** Day 21 only: the date the formal complaint will be submitted if the deadline passes. */
  complaintDate?: ISODate;
  /** Day 21 only: the date from which interest will be claimed. */
  interestFromAt?: ISODate;
}

const CHASER_REQUIRED = [
  ...BASE_REQUIRED,
  'pack.sentAt',
  'pack.sentBy',
  'pack.contents',
  'hire.startAt',
  'hire.endAt',
  'hire.days',
  'hire.dailyRatePence',
  'hire.gtaGroup',
  'heads',
  'totals.claimedPence',
  'totals.receivedPence',
  'totals.outstandingPence',
  'payments',
  'daysSincePack',
  'benchmarkDueAt',
  'claimNotifiedAt',
  'icobsReplyDueAt',
  'responseDeadline'
];

type ChaserRung = 7 | 14 | 21;

const CHASER_ATTENTION: Record<ChaserRung, string | undefined> = {
  7: undefined,
  14: 'Team Leader, Third Party Claims',
  21: 'Claims Manager, Third Party Claims'
};

/** File-1-style position: hire £49.80/day 10 Aug–2 Sep 2026, pack 5 Sep, £1,112 received 25 Sep, balance by head. */
export function chaserSample(rung: ChaserRung): ChaserData {
  const base = {
    pack: {
      sentAt: '2026-09-05',
      sentBy: 'email',
      sentTo: 'thirdpartyclaims@example-insurer.test',
      contents: [
        'covering letter',
        'Mitigation Questionnaire',
        'New Claim Advice Form',
        'Hire Period Validation Form',
        'engineer’s report',
        'recovery and storage accounts',
        'hire invoice INV-0044'
      ]
    },
    hire: { startAt: '2026-08-10', endAt: '2026-09-02', days: 24, dailyRatePence: 4980, gtaGroup: 'M' },
    heads: [
      { label: 'Hire, 24 days at £49.80 per day (invoice INV-0044)', claimedPence: 119520, receivedPence: 51100, outstandingPence: 68420 },
      { label: 'Recovery (invoice INV-0041)', claimedPence: 15100, receivedPence: 15100, outstandingPence: 0 },
      { label: 'Storage, 6 days at £45.00 per day (invoice INV-0042)', claimedPence: 27000, receivedPence: 27000, outstandingPence: 0 },
      { label: 'Engineer’s fee (invoice INV-0043)', claimedPence: 18000, receivedPence: 18000, outstandingPence: 0 }
    ],
    totals: { claimedPence: 179620, receivedPence: 111200, outstandingPence: 68420 },
    payments: [{ date: '2026-09-25', amountPence: 111200, reference: 'BACS, your reference EXI/TP/4471920' }],
    benchmarkDueAt: '2026-10-05',
    claimNotifiedAt: '2026-08-10',
    icobsReplyDueAt: '2026-11-10'
  };
  const position = {
    statedAt: '2026-09-25',
    summary: 'Your remittance advice of 25 September 2026 shows hire paid at £21.29 per day, described as “intervention rate”, with no reasons for the reduction.',
    response: [
      'No offer of a replacement vehicle at £21.29 per day, or at any rate, was made to the claimant in writing. The one telephone approach on 12 August 2026 gave no vehicle, no delivery date and no terms; our letter of 13 August 2026 recorded it and asked for the terms in writing. Nothing was sent.',
      'The claimant’s need for a vehicle, the period and the rate are each evidenced in the pack. If you say any part of the hire is irrecoverable, the pack identifies the document on each point; we ask you to identify which document you dispute and why.'
    ]
  };
  switch (rung) {
    case 7:
      return {
        ...sampleBaseData({ date: '2026-10-12' }),
        ...base,
        daysSincePack: 37,
        insurerPosition: position,
        responseDeadline: '2026-10-19'
      };
    case 14:
      return {
        ...sampleBaseData({ date: '2026-10-19', recipient: sampleRecipient({ attention: 'Team Leader, Third Party Claims' }) }),
        ...base,
        daysSincePack: 44,
        insurerPosition: position,
        previousLetters: ['2026-10-12'],
        responseDeadline: '2026-10-26'
      };
    default:
      return {
        ...sampleBaseData({ date: '2026-10-26', recipient: sampleRecipient({ attention: 'Claims Manager, Third Party Claims' }) }),
        ...base,
        daysSincePack: 51,
        insurerPosition: position,
        previousLetters: ['2026-10-12', '2026-10-19'],
        responseDeadline: '2026-10-30',
        complaintDate: '2026-11-02',
        interestFromAt: '2026-10-05'
      };
  }
}

function renderChaser(d: ChaserData, rung: ChaserRung): string {
  const outstanding = formatGBP(d.totals.outstandingPence);
  const previous = d.previousLetters ?? [];
  const unanswered =
    previous.length === 0
      ? ''
      : ` because our letter${previous.length === 1 ? '' : 's'} of ${escapeHtml(joinAnd(previous.map(formatDateLong)))} ${
          previous.length === 1 ? 'has' : 'have'
        } not been answered`;
  // Rungs 2 and 3 go up the chain: if the API has not named the addressee, the attention line says who.
  const attention = CHASER_ATTENTION[rung];
  const recipient = d.recipient && attention && !d.recipient.attention?.trim() ? { ...d.recipient, attention } : d.recipient;

  const intro =
    rung === 7
      ? '<p>We write to ask where payment of our pack stands.</p>'
      : rung === 14
        ? `<p>This letter is addressed to the team leader${unanswered}. It states the position and what we require.</p>`
        : `<p>This is a formal notice. It is addressed to the claims manager${unanswered}. It sets out the position, what we require, the final date, and the step that follows if it passes.</p>`;

  const paymentsPara =
    d.payments.length === 0
      ? '<p>No payment has been received.</p>'
      : `<p>${d.payments
          .map((p) => `We received ${escapeHtml(formatGBP(p.amountPence))} on ${escapeHtml(formatDateLong(p.date))}${p.reference ? ` (${escapeHtml(p.reference)})` : ''}.`)
          .join(' ')} No other payment has been received.</p>`;

  const positionRows: FigureRow[] = [
    { label: `Claimed in the pack of ${formatDateLong(d.pack.sentAt)}`, valuePence: d.totals.claimedPence },
    { label: 'Received', valuePence: -d.totals.receivedPence },
    { label: 'Outstanding', valuePence: d.totals.outstandingPence, emphasis: true }
  ];
  const headRows: FigureRow[] = [
    ...d.heads.map((h) => ({
      label: h.label,
      valuePence: h.outstandingPence,
      note:
        h.outstandingPence === 0 && h.receivedPence >= h.claimedPence
          ? `Claimed ${formatGBP(h.claimedPence)}; paid in full`
          : `Claimed ${formatGBP(h.claimedPence)}; received ${formatGBP(h.receivedPence)}`
    })),
    { label: 'Total outstanding', valuePence: d.totals.outstandingPence, emphasis: true }
  ];

  const theirPosition = d.insurerPosition
    ? `<p>On ${escapeHtml(formatDateLong(d.insurerPosition.statedAt))} you stated: ${escapeHtml(d.insurerPosition.summary)}</p>${d.insurerPosition.response
        .map((p) => `<p>${escapeHtml(p)}</p>`)
        .join('\n')}`
    : `<p>You have not stated a position on the outstanding ${escapeHtml(outstanding)}. We have no reasoned reply on any head.</p>`;

  const icobs = `<p>We understand that ICOBS 8.2.6R requires a motor vehicle liability insurer, within three months of receiving a claim for compensation, to make a reasoned offer where liability is not disputed and the damages are quantified, or otherwise to give a reasoned reply. We understand that duty applies to this claim; if you contend that it does not, please say so and on what basis. The claim was notified to you on ${escapeHtml(
    formatDateLong(d.claimNotifiedAt)
  )}; the three-month period ends on ${escapeHtml(formatDateLong(d.icobsReplyDueAt))}.${
    rung > 7 && d.totals.receivedPence > 0 ? ' A part payment without reasons for the balance is not, as we understand it, a reasoned reply on the balance.' : ''
  }</p>`;

  let requirements: string[];
  let deadline: string;
  let title: string;
  if (rung === 7) {
    title = 'Payment enquiry';
    requirements = [
      `Confirm that the pack of ${formatDateLong(d.pack.sentAt)} was received and is complete. If you say anything is missing, say what.`,
      `Confirm the date on which the outstanding ${outstanding} will be paid.`,
      'If any head is disputed, identify the head, the amount and the basis, with the document you rely on.',
      'Give the name and direct contact details of the handler dealing with payment.'
    ];
    deadline = `<p>Please reply by ${escapeHtml(fivePm(d.responseDeadline))}. If we do not hear from you by then, we will write to your team leader without further notice.</p>`;
  } else if (rung === 14) {
    title = 'Payment requirement';
    requirements = [
      `Payment of ${outstanding} by ${fivePm(d.responseDeadline)} to the account details previously supplied.`,
      'If any line is disputed, a reasoned reply by the same date identifying the line, the amount and the basis, with the document you rely on.',
      'Confirmation that the file has been reviewed at team-leader level, with the reviewer’s name.'
    ];
    deadline = `<p>We require payment, or a reasoned reply on each outstanding head, by ${escapeHtml(
      fivePm(d.responseDeadline)
    )}. In the absence of either, a formal notice will go to your claims manager without further notice, and the further delay will be added to the chronology.</p>`;
  } else {
    title = 'Formal notice: outstanding payment';
    requirements = [
      `Payment of ${outstanding} by ${fivePm(d.responseDeadline)} to the account details previously supplied.`,
      'Failing payment, a reasoned reply on each outstanding head by the same date, with the document you rely on against each.',
      'Confirmation that the claims manager has the file, with their name and direct contact details.'
    ];
    const complaint = d.complaintDate ? formatDateWithDay(d.complaintDate) : 'the next working day';
    const interestFrom = d.interestFromAt ? formatDateLong(d.interestFromAt) : formatDateLong(d.benchmarkDueAt);
    deadline = `<p>We require payment, or a reasoned reply on each outstanding head, by ${escapeHtml(fivePm(d.responseDeadline))}.</p>
<p>In the absence of either, on ${escapeHtml(
      complaint
    )} we will submit a formal complaint to your complaints team under DISP 1, referring to ICOBS 8.1 and 8.2.6R, and ask for your final response within eight weeks (DISP 1.6). Interest on the outstanding sum will be claimed from ${escapeHtml(
      interestFrom
    )} to the date of payment; if the claimant issues proceedings, interest will be sought under section 69 of the County Courts Act 1984. Each step is taken on the date stated, without a further warning.</p>`;
  }

  const body = `
${subject(d)}
${SALUTATION}
${standardOpener(d.claim)}
${intro}
<h2>The facts</h2>
<p>Hire ran from ${escapeHtml(formatDateLong(d.hire.startAt))} to ${escapeHtml(formatDateLong(d.hire.endAt))} (${escapeHtml(plural(d.hire.days, 'day'))}) at ${escapeHtml(formatRate(d.hire.dailyRatePence, 'day'))} (GTA group ${escapeHtml(
    d.hire.gtaGroup
  )}, industry benchmark). Our payment pack was sent to you ${escapeHtml(sentByLabel(d.pack.sentBy))}${d.pack.sentTo ? ` to ${escapeHtml(d.pack.sentTo)}` : ''} on ${escapeHtml(
    formatDateLong(d.pack.sentAt)
  )}. It contained the ${escapeHtml(joinAnd(d.pack.contents))}.</p>
<p>${escapeHtml(plural(d.daysSincePack, 'day'))} ${d.daysSincePack === 1 ? 'has' : 'have'} passed since the pack was sent. Industry practice is that a clean pack is settled within one calendar month (GTA 6.7); that month ended on ${escapeHtml(
    formatDateLong(d.benchmarkDueAt)
  )}. ${GTA_BENCHMARK_SENTENCE}</p>
${paymentsPara}
<div class="avoid-break">${figuresTable(positionRows, { caption: 'Position' })}</div>
<div class="avoid-break">${figuresTable(headRows, { caption: 'Outstanding by head', headings: ['Head', 'Outstanding'] })}</div>
<h2>Your position</h2>
${theirPosition}
${icobs}
<h2>What we require</h2>
${numberedList(requirements)}
${callout(deadline, rung === 21 ? 'Final date and what follows' : 'Deadline')}`;
  return letter({ ...d, recipient }, title, body);
}

export const chaser7Template: Template<ChaserData> = {
  id: 'letter.chaser_7',
  version: '1.0.0',
  kind: 'letter',
  title: 'Payment enquiry (day 7)',
  recipientRole: 'at_fault_insurer',
  description: 'Rung 1 of the ladder: neutral enquiry on the payment pack, position by head, one-month benchmark, date for a reply.',
  requiredData: CHASER_REQUIRED,
  sample: () => chaserSample(7),
  render: (d) => renderChaser(d, 7)
};

export const chaser14Template: Template<ChaserData> = {
  id: 'letter.chaser_14',
  version: '1.0.0',
  kind: 'letter',
  title: 'Payment requirement (day 14)',
  recipientRole: 'at_fault_insurer',
  description: 'Rung 2, to the team leader: states the position, requires payment or a reasoned reply by a date, names the next step.',
  requiredData: [...CHASER_REQUIRED, 'previousLetters'],
  sample: () => chaserSample(14),
  render: (d) => renderChaser(d, 14)
};

export const chaser21Template: Template<ChaserData> = {
  id: 'letter.chaser_21',
  version: '1.0.0',
  kind: 'letter',
  title: 'Formal notice of outstanding payment (day 21)',
  recipientRole: 'at_fault_insurer',
  description: 'Rung 3, to the claims manager: final date; a DISP 1 complaint to the insurer on the stated date and interest follow.',
  requiredData: [...CHASER_REQUIRED, 'previousLetters', 'complaintDate', 'interestFromAt'],
  sample: () => chaserSample(21),
  render: (d) => renderChaser(d, 21)
};

// ---------------------------------------------------------------------------
// letter.vendor_verification_pack — vendor set-up / Confirmation of Payee documents
// ---------------------------------------------------------------------------

export interface VendorEnclosure {
  title: string;
  dated?: ISODate;
  note?: string;
}

export interface VendorInvoice {
  number: string;
  date: ISODate;
  head: string;
  amountPence: Pence;
}

export interface VendorVerificationPackData extends BaseDocumentData {
  /** What the insurer asked for, and when. */
  request: { receivedAt: ISODate; summary: string; theirVendorRef?: string };
  director: { name: string; idDocument: string };
  enclosures: VendorEnclosure[];
  invoices: VendorInvoice[];
  /** From the ledger: the sum awaiting payment once the vendor record is set up. */
  outstandingPence: Pence;
  responseDeadline: ISODate;
}

export const vendorVerificationPackTemplate: Template<VendorVerificationPackData> = {
  id: 'letter.vendor_verification_pack',
  version: '1.0.0',
  kind: 'letter',
  title: 'Vendor verification pack',
  recipientRole: 'at_fault_insurer',
  description: 'Covering letter enclosing the bank letter, certificate of incorporation, proof of registered office and director ID; exact account name for Confirmation of Payee.',
  requiredData: [
    ...BASE_REQUIRED,
    'settings.bank.accountName',
    'settings.bank.sortCode',
    'settings.bank.accountNumber',
    'settings.bank.bankName',
    'request.receivedAt',
    'request.summary',
    'director.name',
    'director.idDocument',
    'enclosures',
    'invoices',
    'outstandingPence',
    'responseDeadline'
  ],
  sample: () => ({
    ...sampleBaseData({ date: '2026-09-18', recipient: sampleRecipient({ attention: 'Payments and Vendor Team', email: 'vendors@example-insurer.test' }) }),
    request: {
      receivedAt: '2026-09-15',
      summary: 'your payments team told us that our bank details “could not be validated” and asked for vendor set-up documents before the invoices in our pack of 5 September 2026 can be paid',
      theirVendorRef: 'VEN-REQ-20915'
    },
    director: { name: 'D. Kaleem', idDocument: 'UK passport, certified copy of the photo page' },
    enclosures: [
      { title: 'Bank letter on the bank’s letterhead confirming the account name, sort code and account number', dated: '2026-09-16' },
      { title: 'Certificate of incorporation, company number 17430389' },
      { title: 'Proof of registered office', dated: '2026-09-01', note: 'HMRC correspondence addressed to the registered office' },
      { title: 'Director identity document', note: 'D. Kaleem — UK passport, certified copy of the photo page' }
    ],
    invoices: [
      { number: 'INV-0041', date: '2026-08-14', head: 'Recovery', amountPence: 15100 },
      { number: 'INV-0042', date: '2026-08-17', head: 'Storage, 6 days at £45.00 per day', amountPence: 27000 },
      { number: 'INV-0043', date: '2026-08-20', head: 'Engineer’s fee', amountPence: 18000 },
      { number: 'INV-0044', date: '2026-09-03', head: 'Hire, 24 days at £49.80 per day', amountPence: 119520 }
    ],
    outstandingPence: 179620,
    responseDeadline: '2026-09-25'
  }),
  render: (d) => {
    const bank = d.settings.bank;
    const payeeRows = [
      { label: 'Registered name', value: brand.company.registeredName },
      { label: 'Company number', value: brand.company.companyNumber },
      { label: 'Registered office', value: d.settings.registeredOffice }
    ];
    if (d.settings.vatNumber) payeeRows.push({ label: 'VAT number', value: d.settings.vatNumber });
    payeeRows.push(
      { label: 'Account name (exact)', value: bank.accountName },
      { label: 'Bank', value: bank.bankName },
      { label: 'Sort code', value: bank.sortCode },
      { label: 'Account number', value: bank.accountNumber }
    );

    const enclosureItems = d.enclosures.map((e) => `${e.title}${e.dated ? `, dated ${formatDateLong(e.dated)}` : ''}${e.note ? ` (${e.note})` : ''}`);

    const invoiceRows: FigureRow[] = [
      ...d.invoices.map((i) => ({ label: `${i.number} — ${i.head}`, valuePence: i.amountPence, note: `Dated ${formatDateLong(i.date)}` })),
      { label: 'Total awaiting payment', valuePence: d.outstandingPence, emphasis: true }
    ];

    const body = `
${subject(d)}
${SALUTATION}
${standardOpener(d.claim)}
<p>On ${escapeHtml(formatDateLong(d.request.receivedAt))} ${escapeHtml(d.request.summary)}${d.request.theirVendorRef ? ` (your reference ${escapeHtml(d.request.theirVendorRef)})` : ''}. This letter encloses the documents needed to set up ${escapeHtml(
      brand.company.registeredName
    )} as a vendor and to validate our bank account.</p>
<h2>Payee details</h2>
${keyValueTable(payeeRows)}
${callout(
  `<p>The account is held in the exact registered name “${escapeHtml(bank.accountName)}”. Please enter that name in full for Confirmation of Payee, with no trading name, abbreviation or punctuation added. A check against any other form of the name will return a mismatch.</p>
<p>These are our only payment details. We will never change them by email. Any message asking you to pay a different account should be checked with us by telephone on ${escapeHtml(
    brand.company.accidentLine24h
  )} before you act on it.</p>`,
  'Confirmation of Payee'
)}
<h2>Enclosed</h2>
${numberedList(enclosureItems)}
<p>The director identity document is that of ${escapeHtml(d.director.name)} (${escapeHtml(d.director.idDocument)}). It is supplied for vendor verification only; please hold it securely and delete it once verification is complete.</p>
<h2>Invoices awaiting payment</h2>
<div class="avoid-break">${figuresTable(invoiceRows, { headings: ['Invoice', 'Amount'] })}</div>
<h2>What we require</h2>
${numberedList([
  `Confirmation that the vendor record for ${brand.company.registeredName} is set up, with your vendor number.`,
  'Confirmation that the bank details above have passed your validation.',
  `The date on which the ${formatGBP(d.outstandingPence)} now outstanding will clear to the account above.`,
  'If any further document is required, say which and why, by the same date.'
])}
${callout(
  `<p>Please reply by ${escapeHtml(fivePm(d.responseDeadline))}. If vendor set-up is not confirmed by then, the time from ${escapeHtml(
    formatDateLong(d.request.receivedAt)
  )} will be recorded on the payment chronology as delay attributable to you, and our chaser cadence on the pack continues unchanged.</p>`,
  'Deadline'
)}`;
    return letter(d, 'Vendor verification pack', body);
  }
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerTemplate(ncafTemplate);
registerTemplate(handlingRefRequestTemplate);
registerTemplate(interventionReplyTemplate);
registerTemplate(collectOrPayTemplate);
registerTemplate(delayNoticeTemplate);
registerTemplate(chaser7Template);
registerTemplate(chaser14Template);
registerTemplate(chaser21Template);
registerTemplate(vendorVerificationPackTemplate);

/** Every template in this group, in ladder order (for tests and the template picker). */
export const lettersATemplates: ReadonlyArray<AnyTemplate> = [
  ncafTemplate,
  handlingRefRequestTemplate,
  interventionReplyTemplate,
  collectOrPayTemplate,
  delayNoticeTemplate,
  chaser7Template,
  chaser14Template,
  chaser21Template,
  vendorVerificationPackTemplate
];
