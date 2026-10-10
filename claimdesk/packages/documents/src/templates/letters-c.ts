// owned by ap-paperwork
/**
 * Letters C — the Autopilot letters (docs/SUPREME-AUTOPILOT.md §D.2, §D.5, §D.6, §D.7, §E.4):
 *
 *   letter.hire_offer                    printable twin of the hire offer email (client)
 *   letter.booking_confirmation          booking confirmed + delivery or collection slot (client)
 *   letter.hire_start_notice             notice of the hire start to the at-fault insurer (no daily rate)
 *   letter.signature_request             cover letter for documents sent for wet / scanned signature (client)
 *   letter.signature_chase               reminder that signed documents have not come back (client)
 *   letter.recovery_storage_instruction  instruction to the recovery / storage supplier
 *   letter.decline                       we are not able to take the claim on (client; sent only by the owner)
 *   letter.closure                       file closed (client)
 *
 * Pure functions of their data (assembled by the API from the reservation, offer, pack and claim records): no clock,
 * no randomness, every date through format.ts. Perimeter: "we are instructed to correspond on behalf of"; the client
 * is "you" or named, never "our client"; the GTA is never mentioned as an entitlement; nothing here states a daily
 * rate or calls the hire "free" (rates belong in the agreement and the invoices); the client is never told to ignore
 * or decline an insurer's offer (script guard). Outgoing identity: the Claims Team, Courtesy Cars Group UK Ltd.
 *
 * This file is imported for its side effects by src/templates/index.ts.
 */
import type { ISODate, ISODateTime } from '@ccguk/domain';
import { brand } from '../brand.js';
import { type BaseDocumentData, type FigureRow, type Signatory, sampleBaseData } from '../common.js';
import { escapeHtml, formatDateLong, formatDateTime, formatDateWithDay, formatRegistration, formatTime, joinAnd, nl2p, numberedList, plural } from '../format.js';
import { baseLayout, callout, figuresTable, keyValueTable, reLine, standardOpener, subjectBlock } from '../layout.js';
import { type AnyTemplate, registerTemplate, type Template } from '../registry.js';

type DateLike = ISODate | ISODateTime;

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** Every Autopilot letter needs these (the document date, the company office and the claim header). */
const BASE_REQUIRED = ['settings.registeredOffice', 'date', 'claim.ourReference', 'claim.claimantName', 'claim.vehicleRegistration', 'claim.accidentDate', 'recipient.name'] as const;

/** The outgoing identity for letters the Autopilot prepares (owner's rule). */
export const CLAIMS_TEAM_SIGNATORY: Signatory = { name: 'Claims Team', role: 'Claims handling' };

/**
 * The neutral intervention sentence (§D.2 item 5). Script-guard compliant: the client is free to consider an
 * insurer's offer; we only ask to be told so it can be recorded.
 */
export const NEUTRAL_INTERVENTION_SENTENCE =
  'If the other driver’s insurer offers you a car directly, please tell us straight away so we can record it and help you decide — you are free to consider their offer.';

function p(text: string): string {
  return `<p>${escapeHtml(text)}</p>`;
}

function h2(text: string): string {
  return `<h2>${escapeHtml(text)}</h2>`;
}

function signatoryOf(d: BaseDocumentData): Signatory {
  return d.signatory ?? CLAIMS_TEAM_SIGNATORY;
}

function clientRe(d: BaseDocumentData, what: string): string {
  return reLine(`${what} — ${formatRegistration(d.claim.vehicleRegistration)}, accident on ${formatDateLong(d.claim.accidentDate)}`);
}

/** "Wednesday 12 August 2026, between 09:00 and 12:00". */
function slotText(windowStart: DateLike, windowEnd: DateLike): string {
  return `${formatDateWithDay(windowStart)}, between ${formatTime(windowStart)} and ${formatTime(windowEnd)}`;
}

function contactLine(): string {
  return p(`If anything in this letter is unclear, call us on ${brand.company.officePhone} or email ${brand.company.claimsEmail}, quoting your reference.`);
}

function clientLayout(d: BaseDocumentData, title: string, body: string, opts: { enclosures?: string[] } = {}): string {
  return baseLayout({
    title,
    kind: 'letter',
    reference: d.claim.ourReference,
    date: d.date,
    recipient: d.recipient,
    settings: d.settings,
    signatory: signatoryOf(d),
    closing: 'Yours sincerely',
    bodyHtml: body,
    ...(opts.enclosures && opts.enclosures.length > 0 ? { enclosures: opts.enclosures } : {})
  });
}

const CLIENT_RECIPIENT = { name: 'Ms Jane Example', addressLines: ['1 Example Street', 'Example Town', 'EX2 2BB'], email: 'jane@example.test' };

// ---------------------------------------------------------------------------
// letter.hire_offer — the printable / HTML twin of the hire offer email (§D.2)
// ---------------------------------------------------------------------------

export interface HireOfferLetterData extends BaseDocumentData {
  salutationName: string;
  offer: {
    makeModel: string;
    registration: string;
    transmission: string;
    seats?: number | null;
    fuel?: string | null;
    /** Code-built like-for-like sentence (never typed by a model). */
    likeForLike: string;
    startAt: DateLike;
    delivery?: { windowStart: DateLike; windowEnd: DateLike; addressShort: string } | null;
    /** When the hold expires; the client must accept by then. */
    expiresAt: DateLike;
    /** Other cars shown (not held). */
    alternatives?: string[];
  };
  /** Optional introduction paragraph (the judge may replace it; placeholders already resolved). */
  intro?: string;
}

export const hireOfferLetterTemplate: Template<HireOfferLetterData> = {
  id: 'letter.hire_offer',
  version: '1.0.0',
  kind: 'letter',
  title: 'Your replacement car',
  recipientRole: 'client',
  description: 'Offer of a replacement car to the client: the car, the like-for-like explanation, delivery, how credit hire works, the neutral intervention sentence and how to accept. No daily rate.',
  requiredData: [
    ...BASE_REQUIRED,
    'salutationName',
    'offer.makeModel',
    'offer.registration',
    'offer.transmission',
    'offer.likeForLike',
    'offer.startAt',
    'offer.expiresAt'
  ],
  sample: () => ({
    ...sampleBaseData({ recipient: CLIENT_RECIPIENT }),
    salutationName: 'Ms Example',
    offer: {
      makeModel: 'Volkswagen Golf 1.5 TSI Life',
      registration: 'LK26CCG',
      transmission: 'Automatic',
      seats: 5,
      fuel: 'Petrol',
      likeForLike: 'It is in the same hire group as your own car and is an automatic, as you need.',
      startAt: '2026-10-06T09:00:00+01:00',
      delivery: { windowStart: '2026-10-06T09:00:00+01:00', windowEnd: '2026-10-06T12:00:00+01:00', addressShort: '1 Example Street, EX2 2BB' },
      expiresAt: '2026-10-05T17:00:00+01:00',
      alternatives: ['Skoda Octavia 1.5 TSI SE (automatic)']
    }
  }),
  render: (d) => {
    const o = d.offer;
    const spec = [o.transmission, o.seats ? plural(o.seats, 'seat') : '', o.fuel ?? ''].filter((x) => x && x.trim() !== '');
    const delivery = o.delivery
      ? p(`We will deliver it to ${o.delivery.addressShort} on ${slotText(o.delivery.windowStart, o.delivery.windowEnd)}.`)
      : p(`The hire can start from ${formatDateWithDay(o.startAt)}. We will call you to arrange delivery.`);
    const alternatives = o.alternatives && o.alternatives.length > 0 ? p(`If this car does not suit you, we can also offer: ${joinAnd(o.alternatives)}. These are not held for you.`) : '';
    const body = `
<p>Dear ${escapeHtml(d.salutationName)},</p>
${clientRe(d, 'Your replacement car')}
${d.intro ? nl2p(d.intro) : p(`We are sorry to hear about the accident on ${formatDateLong(d.claim.accidentDate)}. We have found a replacement car for you while your own car is off the road.`)}
${h2('The car')}
${keyValueTable([
  { label: 'Car', value: o.makeModel },
  { label: 'Registration', value: formatRegistration(o.registration) },
  { label: 'Specification', value: spec.join(', ') }
])}
${p(o.likeForLike)}
${alternatives}
${h2('Delivery')}
${delivery}
${h2('How it works')}
${numberedList([
  'The car is provided under a credit hire agreement. The hire charges are claimed from the at-fault driver’s insurer as part of your claim.',
  'You sign the hire agreement and a condition report when the car is handed over.',
  'Before that, you will receive the pre-contract information and a cancellation form. You have a 14-day right to cancel, and you will be asked to request that the hire starts straight away.'
])}
${p(NEUTRAL_INTERVENTION_SENTENCE)}
${callout(`<p>To accept, reply YES to this email or call us on ${escapeHtml(brand.company.officePhone)}. This car is held for you until ${escapeHtml(formatDateTime(o.expiresAt))}.</p>`, 'To accept')}
${contactLine()}`;
    return clientLayout(d, 'Your replacement car', body);
  }
};
registerTemplate(hireOfferLetterTemplate);

// ---------------------------------------------------------------------------
// letter.booking_confirmation — booking confirmed, delivery or collection slot (§D.5, off-hire pack)
// ---------------------------------------------------------------------------

export interface BookingConfirmationData extends BaseDocumentData {
  salutationName: string;
  booking: {
    makeModel: string;
    registration: string;
    agreementNumber?: string;
    startAt: DateLike;
    movement?: { kind: 'delivery' | 'collection'; windowStart: DateLike; windowEnd: DateLike; addressShort: string } | null;
  };
}

export const bookingConfirmationTemplate: Template<BookingConfirmationData> = {
  id: 'letter.booking_confirmation',
  version: '1.0.0',
  kind: 'letter',
  title: 'Booking confirmation',
  recipientRole: 'client',
  description: 'Confirms the replacement car booking and the delivery or collection slot, and what to have ready. No daily rate.',
  requiredData: [...BASE_REQUIRED, 'salutationName', 'booking.makeModel', 'booking.registration', 'booking.startAt'],
  sample: () => ({
    ...sampleBaseData({ recipient: CLIENT_RECIPIENT }),
    salutationName: 'Ms Example',
    booking: {
      makeModel: 'Volkswagen Golf 1.5 TSI Life',
      registration: 'LK26CCG',
      agreementNumber: 'CHA-2026-00012',
      startAt: '2026-10-06T09:00:00+01:00',
      movement: { kind: 'delivery', windowStart: '2026-10-06T09:00:00+01:00', windowEnd: '2026-10-06T12:00:00+01:00', addressShort: '1 Example Street, EX2 2BB' }
    }
  }),
  render: (d) => {
    const b = d.booking;
    const m = b.movement ?? null;
    const isCollection = m?.kind === 'collection';
    const rows = [
      { label: 'Car', value: b.makeModel },
      { label: 'Registration', value: formatRegistration(b.registration) }
    ];
    if (b.agreementNumber) rows.push({ label: 'Agreement number', value: b.agreementNumber });
    if (m) rows.push({ label: isCollection ? 'Collection' : 'Delivery', value: `${slotText(m.windowStart, m.windowEnd)} at ${m.addressShort}` });
    else rows.push({ label: 'Hire from', value: formatDateWithDay(b.startAt) });
    const ready = isCollection
      ? ['Have the car, its keys and any accessories ready at the address above.', 'Remove your belongings from the car.', 'Someone must be there to sign the return condition report with our driver.']
      : ['Your driving licence (photocard), so we can check it at the handover.', 'Proof of your address dated within the last three months.', 'Time to read and sign the hire agreement and the condition report with our driver.'];
    const body = `
<p>Dear ${escapeHtml(d.salutationName)},</p>
${clientRe(d, isCollection ? 'Collection of your replacement car' : 'Your replacement car is booked')}
${p(isCollection ? 'We have arranged to collect the replacement car. The details are below.' : 'Thank you for accepting the replacement car. Your booking is confirmed and the details are below.')}
${keyValueTable(rows)}
${h2('Please have ready')}
${numberedList(ready)}
${p('If the time does not suit you, call us as soon as possible and we will find another slot.')}
${isCollection ? '' : p(NEUTRAL_INTERVENTION_SENTENCE)}
${contactLine()}`;
    return clientLayout(d, 'Booking confirmation', body);
  }
};
registerTemplate(bookingConfirmationTemplate);

// ---------------------------------------------------------------------------
// letter.hire_start_notice — to the at-fault insurer within 1 WD of the start (§D.7). No rate: it does not touch money.
// ---------------------------------------------------------------------------

export interface HireStartNoticeData extends BaseDocumentData {
  hireStart: {
    startAt: DateLike;
    agreementNumber: string;
    /** Hire group of the replacement vehicle (industry benchmark grouping). */
    vehicleGroup: string;
    makeModel?: string;
  };
}

export const hireStartNoticeTemplate: Template<HireStartNoticeData> = {
  id: 'letter.hire_start_notice',
  version: '1.0.0',
  kind: 'letter',
  title: 'Notice of hire start',
  recipientRole: 'at_fault_insurer',
  description: 'Tells the at-fault insurer that a replacement vehicle hire has started: vehicle group, start date, agreement number and an invitation to contact us. States no daily rate.',
  requiredData: [...BASE_REQUIRED, 'hireStart.startAt', 'hireStart.agreementNumber', 'hireStart.vehicleGroup'],
  sample: () => ({
    ...sampleBaseData(),
    hireStart: { startAt: '2026-10-06T10:15:00+01:00', agreementNumber: 'CHA-2026-00012', vehicleGroup: 'C (manual)', makeModel: 'Volkswagen Golf 1.5 TSI Life' }
  }),
  render: (d) => {
    const h = d.hireStart;
    const rows = [
      { label: 'Hire started', value: formatDateTime(h.startAt) },
      { label: 'Agreement number', value: h.agreementNumber },
      { label: 'Vehicle group', value: h.vehicleGroup }
    ];
    if (h.makeModel) rows.push({ label: 'Replacement vehicle', value: h.makeModel });
    const handling = d.claim.theirReference ? `Please quote your reference ${d.claim.theirReference} and ours on any reply.` : 'Please let us have your handling reference for this claim and quote ours on any reply.';
    const body = `
${subjectBlock(d.claim, { claimantLabel: 'Claimant' })}
<p>Dear Sirs,</p>
${reLine('Notice of replacement vehicle hire')}
${standardOpener(d.claim)}
${p('The claimant’s own vehicle is off the road following the accident, and a replacement vehicle has been provided under a credit hire agreement. The details are below.')}
${keyValueTable(rows)}
${p(handling)}
${p('If you wish to discuss the hire, the claimant’s need for a replacement vehicle or the repair of the claimant’s own vehicle, contact us at the address above. The hire charges will be presented with the invoices when the hire ends.')}`;
    return baseLayout({
      title: 'Notice of hire start',
      kind: 'letter',
      reference: d.claim.ourReference,
      theirReference: d.claim.theirReference,
      date: d.date,
      recipient: d.recipient,
      settings: d.settings,
      signatory: signatoryOf(d),
      bodyHtml: body
    });
  }
};
registerTemplate(hireStartNoticeTemplate);

// ---------------------------------------------------------------------------
// letter.signature_request — cover letter for documents sent for wet / scanned signature (§E.4)
// ---------------------------------------------------------------------------

export interface SignatureRequestDocument {
  title: string;
  /** 'sign' = please sign and return; 'give' = for your records. */
  purpose: 'sign' | 'give';
}

export interface SignatureRequestLetterData extends BaseDocumentData {
  salutationName: string;
  documents: SignatureRequestDocument[];
  returnBy: ISODate;
}

export const signatureRequestLetterTemplate: Template<SignatureRequestLetterData> = {
  id: 'letter.signature_request',
  version: '1.0.0',
  kind: 'letter',
  title: 'Documents for your signature',
  recipientRole: 'client',
  description: 'Cover letter for the documents emailed for signature: which to sign and return, which to keep, how to return them, and by when.',
  requiredData: [...BASE_REQUIRED, 'salutationName', 'documents', 'returnBy'],
  sample: () => ({
    ...sampleBaseData({ recipient: CLIENT_RECIPIENT }),
    salutationName: 'Ms Example',
    documents: [
      { title: 'Customer Agreement & Letter of Authority', purpose: 'sign' },
      { title: 'Accident Report Form', purpose: 'sign' },
      { title: 'Cancellation form', purpose: 'give' }
    ],
    returnBy: '2026-10-09'
  }),
  render: (d) => {
    const toSign = d.documents.filter((x) => x.purpose === 'sign').map((x) => x.title);
    const toKeep = d.documents.filter((x) => x.purpose === 'give').map((x) => x.title);
    const body = `
<p>Dear ${escapeHtml(d.salutationName)},</p>
${clientRe(d, 'Documents for your signature')}
${p('We attach the documents for your claim. Please read each one carefully before you sign it.')}
${toSign.length > 0 ? `${h2('Please sign and return')}${numberedList(toSign)}` : ''}
${toKeep.length > 0 ? `${h2('For your records')}${numberedList(toKeep)}` : ''}
${h2('How to return them')}
${numberedList([
  'Print each document to sign, sign and date it where shown, and use today’s date.',
  `Scan or photograph every page clearly and email them to ${brand.company.claimsEmail}, quoting your reference; or bring or post the signed pages to the address above.`,
  'If you cannot print, call us and we will arrange for you to sign at our office.'
])}
${callout(`<p>Please return the signed documents by ${escapeHtml(formatDateWithDay(d.returnBy))}. We cannot take the next step on your claim until we have them.</p>`, 'Return by')}
${contactLine()}`;
    return clientLayout(d, 'Documents for your signature', body, { enclosures: d.documents.map((x) => x.title) });
  }
};
registerTemplate(signatureRequestLetterTemplate);

// ---------------------------------------------------------------------------
// letter.signature_chase — reminder (§E.4: after 2 and 5 days; auto-send allow-listed as a chaser)
// ---------------------------------------------------------------------------

export interface SignatureChaseData extends BaseDocumentData {
  salutationName: string;
  /** Titles of the documents still to be signed and returned. */
  documents: string[];
  sentOn: DateLike;
  /** 1 for the first reminder, 2 for the second. */
  chaseNumber: number;
  returnBy: ISODate;
}

export const signatureChaseTemplate: Template<SignatureChaseData> = {
  id: 'letter.signature_chase',
  version: '1.0.0',
  kind: 'letter',
  title: 'Reminder: documents to sign',
  recipientRole: 'client',
  description: 'Reminder to the client that signed documents sent on a date have not come back; lists them and gives a new return date.',
  requiredData: [...BASE_REQUIRED, 'salutationName', 'documents', 'sentOn', 'chaseNumber', 'returnBy'],
  sample: () => ({
    ...sampleBaseData({ recipient: CLIENT_RECIPIENT }),
    salutationName: 'Ms Example',
    documents: ['Customer Agreement & Letter of Authority', 'Accident Report Form'],
    sentOn: '2026-10-02',
    chaseNumber: 1,
    returnBy: '2026-10-09'
  }),
  render: (d) => {
    const opener = d.chaseNumber > 1 ? 'We wrote to you again recently' : 'This is a reminder';
    const body = `
<p>Dear ${escapeHtml(d.salutationName)},</p>
${clientRe(d, 'Reminder: documents to sign')}
${p(`${opener} about the documents we sent you on ${formatDateLong(d.sentOn)}. We have not yet received the following signed documents back:`)}
${numberedList(d.documents)}
${p(`Please sign and return them by ${formatDateWithDay(d.returnBy)}: scan or photograph every page and email them to ${brand.company.claimsEmail}, or bring or post them to the address above. If you have already sent them, thank you — please ignore this reminder.`)}
${p('If you have a question about any of the documents, or you cannot print them, call us and we will help.')}
${contactLine()}`;
    return clientLayout(d, 'Reminder: documents to sign', body);
  }
};
registerTemplate(signatureChaseTemplate);

// ---------------------------------------------------------------------------
// letter.recovery_storage_instruction — instruction to the recovery / storage supplier (sign-up stage)
// ---------------------------------------------------------------------------

export interface RecoveryStorageInstructionData extends BaseDocumentData {
  instruction: {
    kind: 'recovery' | 'storage' | 'recovery_and_storage';
    vehicleDescription: string;
    /** Where the vehicle is now. */
    vehicleLocation: string;
    /** Where it should go (recovery) or where it is stored (storage). */
    destination?: string;
    requiredBy?: DateLike;
    keysWith?: string;
    contact?: string;
    notes?: string;
  };
}

const INSTRUCTION_LABEL: Record<RecoveryStorageInstructionData['instruction']['kind'], string> = {
  recovery: 'recovery',
  storage: 'storage',
  recovery_and_storage: 'recovery and storage'
};

export const recoveryStorageInstructionTemplate: Template<RecoveryStorageInstructionData> = {
  id: 'letter.recovery_storage_instruction',
  version: '1.0.0',
  kind: 'letter',
  title: 'Recovery and storage instruction',
  recipientRole: 'supplier',
  description: 'Instruction to the recovery / storage supplier: the vehicle, where it is, where it goes, when, keys and contact, and the records we need back.',
  requiredData: [...BASE_REQUIRED, 'instruction.kind', 'instruction.vehicleDescription', 'instruction.vehicleLocation'],
  sample: () => ({
    ...sampleBaseData({ recipient: { name: 'Example Recovery Ltd', attention: 'Operations', addressLines: ['Unit 2', 'Example Yard', 'Example Town', 'EX4 4DD'], email: 'ops@example-recovery.test' } }),
    instruction: {
      kind: 'recovery_and_storage',
      vehicleDescription: 'Volkswagen Golf 1.5 TSI Life, registration AB12 CDE',
      vehicleLocation: '1 Example Street, Example Town, EX2 2BB (on the driveway)',
      destination: 'Your secure compound at Example Yard',
      requiredBy: '2026-10-05T16:00:00+01:00',
      keysWith: 'the client at the address',
      contact: 'Ms Jane Example, 07000 000000',
      notes: 'The vehicle is not driveable; the front nearside wheel does not turn.'
    }
  }),
  render: (d) => {
    const i = d.instruction;
    const label = INSTRUCTION_LABEL[i.kind];
    const rows = [
      { label: 'Vehicle', value: i.vehicleDescription },
      { label: 'Current location', value: i.vehicleLocation }
    ];
    if (i.destination) rows.push({ label: i.kind === 'storage' ? 'Storage location' : 'Deliver to', value: i.destination });
    if (i.requiredBy) rows.push({ label: 'Required by', value: formatDateTime(i.requiredBy) });
    if (i.keysWith) rows.push({ label: 'Keys', value: `With ${i.keysWith}` });
    if (i.contact) rows.push({ label: 'Contact', value: i.contact });
    const { theirReference: _ref, ...claimNoInsurerRef } = d.claim;
    const body = `
${subjectBlock(claimNoInsurerRef, { claimantLabel: 'Claimant', showThirdParty: false })}
<p>Dear Sirs,</p>
${reLine(`Instruction — vehicle ${label}`)}
${standardOpener(claimNoInsurerRef)}
${p(`We instruct you to provide ${label} for the vehicle below.`)}
${keyValueTable(rows)}
${i.notes ? nl2p(i.notes) : ''}
${h2('What we need from you')}
${numberedList([
  'Confirm by email that you accept this instruction and the time of collection.',
  'Photograph the vehicle on collection and on arrival, including every damaged area and the odometer.',
  'Record the loaded miles, the times of collection and delivery, and where the vehicle is kept.',
  `Invoice ${brand.company.registeredName}, quoting our reference ${d.claim.ourReference}, with the dates and the work done.`
])}
${p('Do not release the vehicle to anyone, including an insurer or its agent, without our written authority.')}`;
    return baseLayout({
      title: 'Recovery and storage instruction',
      kind: 'letter',
      reference: d.claim.ourReference,
      date: d.date,
      recipient: d.recipient,
      settings: d.settings,
      signatory: signatoryOf(d),
      bodyHtml: body
    });
  }
};
registerTemplate(recoveryStorageInstructionTemplate);

// ---------------------------------------------------------------------------
// letter.decline — we cannot take the claim on (owner-only decision; the letter only records it)
// ---------------------------------------------------------------------------

export interface DeclineLetterData extends BaseDocumentData {
  salutationName: string;
  /** Plain-English reasons, one per line, as decided by the owner. */
  reasons: string[];
}

export const declineLetterTemplate: Template<DeclineLetterData> = {
  id: 'letter.decline',
  version: '1.0.0',
  kind: 'letter',
  title: 'We are unable to take on your claim',
  recipientRole: 'client',
  description: 'Tells the client we are not able to take the claim on, with the owner’s reasons, and that they can still claim directly or through their own insurer.',
  requiredData: [...BASE_REQUIRED, 'salutationName', 'reasons'],
  sample: () => ({
    ...sampleBaseData({ recipient: CLIENT_RECIPIENT }),
    salutationName: 'Ms Example',
    reasons: ['The accident happened outside the United Kingdom, and we only handle claims for accidents in the United Kingdom.']
  }),
  render: (d) => {
    const body = `
<p>Dear ${escapeHtml(d.salutationName)},</p>
${clientRe(d, 'Your enquiry')}
${p(`Thank you for contacting ${brand.company.registeredName} about the accident on ${formatDateLong(d.claim.accidentDate)}. We have looked at the details carefully and we are sorry that we are unable to take on your claim.`)}
${h2('Why')}
${numberedList(d.reasons)}
${h2('What you can do')}
${numberedList([
  'You can still make a claim directly to the other driver’s insurer, or through your own motor insurer.',
  'Claims for damage to property must usually be started at court within six years of the accident, and claims for personal injury within three years. Do not leave it late.',
  'Keep the photographs, receipts and any letters you have about the accident.'
])}
${p('We have not taken any step on your behalf and we will not contact anyone about the accident. If you have sent us original documents, we will return them.')}
${contactLine()}`;
    return clientLayout(d, 'We are unable to take on your claim', body);
  }
};
registerTemplate(declineLetterTemplate);

// ---------------------------------------------------------------------------
// letter.closure — the file is closed (closure stage)
// ---------------------------------------------------------------------------

export interface ClosureLetterData extends BaseDocumentData {
  salutationName: string;
  /** What happened, in plain words (paragraphs separated by blank lines). */
  outcome: string;
  closedOn: ISODate;
  /** Optional final position from the ledger. */
  figures?: FigureRow[];
}

export const closureLetterTemplate: Template<ClosureLetterData> = {
  id: 'letter.closure',
  version: '1.0.0',
  kind: 'letter',
  title: 'Your claim is closed',
  recipientRole: 'client',
  description: 'Tells the client the file is closed: the outcome, the final position from the ledger, how long the file is kept and who to contact.',
  requiredData: [...BASE_REQUIRED, 'salutationName', 'outcome', 'closedOn'],
  sample: () => ({
    ...sampleBaseData({ recipient: CLIENT_RECIPIENT }),
    salutationName: 'Ms Example',
    outcome: 'The other driver’s insurer has paid the hire, recovery and storage charges in full, and your own vehicle has been repaired.',
    closedOn: '2026-12-01',
    figures: [
      { label: 'Claimed from the insurer', valuePence: 207820 },
      { label: 'Received', valuePence: 207820 },
      { label: 'Outstanding', valuePence: 0, emphasis: true }
    ]
  }),
  render: (d) => {
    const body = `
<p>Dear ${escapeHtml(d.salutationName)},</p>
${clientRe(d, 'Your claim is closed')}
${nl2p(d.outcome)}
${d.figures && d.figures.length > 0 ? figuresTable(d.figures) : ''}
${p(`We closed your file on ${formatDateLong(d.closedOn)}. You do not need to do anything more, and you will not receive any further bill from us for this claim.`)}
${p('We keep the file and its documents for six years after closure, in line with our retention policy, and then delete them securely. You can ask for a copy of the information we hold about you at any time.')}
${p('If anyone contacts you about the accident, or you receive any letter about it, please send it to us straight away.')}
${p('Thank you for choosing us.')}
${contactLine()}`;
    return clientLayout(d, 'Your claim is closed', body);
  }
};
registerTemplate(closureLetterTemplate);

/** Every Letters C template, for tests and the coverage list. */
export const lettersCTemplates: ReadonlyArray<AnyTemplate> = [
  hireOfferLetterTemplate,
  bookingConfirmationTemplate,
  hireStartNoticeTemplate,
  signatureRequestLetterTemplate,
  signatureChaseTemplate,
  recoveryStorageInstructionTemplate,
  declineLetterTemplate,
  closureLetterTemplate
];
