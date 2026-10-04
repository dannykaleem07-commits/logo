/**
 * Template data builders — correspondence group: letter.cctv_preservation, letter.client_update,
 * letter.supplier_instruction_engineer, letter.vendor_verification_pack.
 *
 * ARCHITECTURE convention 4 ("one source of truth"): every amount and date these letters print comes from the claim
 * (accident record, ledger, chronology, hire/storage/recovery records, clocks, evidence gates, playbook) or from the
 * settings table. A handler supplies only the free text the template declares and the system cannot know:
 *
 *   letter.cctv_preservation           the operator (recipient party or `recipient` extra) and `operatorType` unless
 *                                      the party's roles say council/police/TfL; optional cameraDescription,
 *                                      retentionNote, operatorReference, feePence
 *   letter.client_update               `whatThisMeans` (the handler's explanation); `salutationName` defaults to the
 *                                      claimant's name and yields to the handler's form of address
 *   letter.supplier_instruction_engineer `damageReported`; `vehicle.location` when the vehicle is not in open storage;
 *                                      the recipient when no engineer party is on the file; `forCourt` (default false,
 *                                      true once proceedings are issued) and `questions`
 *   letter.vendor_verification_pack    `director.idDocument` (and `director.name` unless one admin user — the role
 *                                      the system labels "Director" — identifies the director); `request.summary`
 *                                      may be reworded by the handler
 *
 * Anything missing is reported by the registry (400 TEMPLATE_DATA_MISSING with the missing keys); anything the
 * claim must hold first (a signed authority, the insurer's vendor request) is a 409 that says what to record.
 */
import {
  addCalendarDays,
  addWorkingDays,
  formatGBP,
  londonDate,
  type ClaimBundle,
  type GateResult,
  type HeadOfLoss,
  type ISODate,
  type ISODateTime,
  type LedgerEntry,
  type Party,
  type PlaybookAction,
  type Pence,
} from '@ccguk/domain';
import { brand, formatDateLong } from '@ccguk/documents';
import { badRequest, conflict } from '../../errors.js';
import { actionsFor, gatesFor } from '../claimView.js';
import { kbEntries } from '../kb.js';
import {
  headSummaries,
  hireBlock,
  latestEvent,
  latestHire,
  ncafBlock,
  packBlock,
  recipientBlock,
  recoveryBlock,
  reportBlock,
  storageBlock,
  vehicleDescription,
  type BuildInput,
  type Builder,
  type CompanySettingsData,
  type RecipientBlockData,
} from '../documentData.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A non-empty trimmed string, else undefined. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The handler's extra at a dotted path (read-only: used only to let a declared free-text field yield to the handler). */
function extraAt(b: BuildInput, path: string): unknown {
  let cur: unknown = b.extra;
  for (const k of path.split('.')) {
    if (!isRecord(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * Handler-owned free text: when supplied it must be a string. A number or object would reach the template's text
 * helpers (nl2p) and fail as a 500, or print "[object Object]". Absent or blank is left to the registry, which names
 * the field (TEMPLATE_DATA_MISSING).
 */
function assertText(b: BuildInput, ...paths: string[]): void {
  for (const p of paths) {
    const v = extraAt(b, p);
    if (v !== undefined && v !== null && typeof v !== 'string') throw badRequest(`data.${p} must be text (a string)`, { code: 'INVALID_FIELD', field: p });
  }
}

/** A handler-supplied list of text items (e.g. the engineer's specific questions). */
function assertTextList(b: BuildInput, path: string): void {
  const v = extraAt(b, path);
  if (v === undefined || v === null) return;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.trim() !== '')) {
    throw badRequest(`data.${path} must be a list of text items (an array of non-empty strings)`, { code: 'INVALID_FIELD', field: path });
  }
}

/** A recipient typed by the handler (no party on file): a name and address lines, as text. */
function assertRecipientExtra(b: BuildInput): void {
  const r = extraAt(b, 'recipient');
  if (r === undefined || r === null) return;
  if (!isRecord(r)) throw badRequest('data.recipient must be an object with name and addressLines', { code: 'INVALID_FIELD', field: 'recipient' });
  assertText(b, 'recipient.name', 'recipient.attention', 'recipient.email');
  const lines = r.addressLines;
  if (lines !== undefined && lines !== null && (!Array.isArray(lines) || !lines.every((x) => typeof x === 'string'))) {
    throw badRequest('data.recipient.addressLines must be a list of address lines (an array of strings)', { code: 'INVALID_FIELD', field: 'recipient.addressLines' });
  }
}

/** Today on the England & Wales calendar (the engine reads dates in London time too). */
function todayOf(b: BuildInput): ISODate {
  return londonDate(b.now);
}

function workingDaysFrom(date: ISODate, n: number): ISODate {
  return londonDate(addWorkingDays(date, n));
}

function calendarDaysFrom(date: ISODate, n: number): ISODate {
  return londonDate(addCalendarDays(date, n));
}

/**
 * A deadline we may state: `base`, but never earlier than a running clock of the given kinds. London dates on both
 * sides, as the consistency engine compares them (DEADLINE_TOO_EARLY blocks a mapped template).
 */
function notBeforeClock(bundle: ClaimBundle, base: ISODate, kinds: string[]): ISODate {
  const due = bundle.clocks
    .filter((c) => c.status === 'running' && kinds.includes(c.kind))
    .map((c) => londonDate(c.dueAt))
    .sort()[0];
  return due && due > base ? due : base;
}

const insurerName = (bundle: ClaimBundle): string => bundle.atFaultInsurer?.name ?? 'the other driver’s insurer';

const sumPence = (xs: number[]): Pence => xs.reduce((a, x) => a + x, 0);

// ---------------------------------------------------------------------------
// letter.cctv_preservation
// ---------------------------------------------------------------------------

/** Minutes of footage requested either side of the accident time. */
const CCTV_WINDOW_MINUTES = 15;
/** Working days the operator has to confirm preservation in writing (footage is overwritten quickly). */
const CCTV_CONFIRM_WORKING_DAYS = 3;

const CCTV_OPERATOR_TYPES = ['council', 'tfl', 'premises', 'police', 'other'] as const;
type CctvOperatorType = (typeof CCTV_OPERATOR_TYPES)[number];

function operatorTypeOf(p: Party | undefined): CctvOperatorType | undefined {
  if (!p) return undefined;
  if (p.roles.includes('police')) return 'police';
  if (/\btransport for london\b|\btfl\b/i.test(`${p.name} ${p.tradingName ?? ''}`)) return 'tfl';
  if (p.roles.includes('council')) return 'council';
  return undefined; // premises vs other is the handler's call
}

/**
 * The claimant's signed authority (perimeter.md: no authority, no letter): an uploaded authority document, else the
 * signed credit hire agreement, whose terms instruct CCGUK to correspond on the claimant's behalf.
 */
/**
 * Deliberately narrow: a "local authority" letter, an insurer's "authority to repair" or a bodyshop's "repair
 * authorisation" is not the claimant's authority, and a false match would let the letter assert one that is not on file.
 */
const CLAIMANT_AUTHORITY_RE =
  /\b(?:signed\s+authori(?:ty|[sz]ation)|letter\s+of\s+authority|form\s+of\s+authority|(?:client|claimant|customer)(?:['’]s)?\s+authori(?:ty|[sz]ation)|authori(?:ty|[sz]ation)\s+(?:to|for)\s+(?:act|correspond|request|obtain|receive|release|disclose)|mandate)\b/i;

function signedAuthorityDate(bundle: ClaimBundle): ISODate | undefined {
  const doc = bundle.evidence
    .filter((e) => ['document', 'pdf', 'other'].includes(e.kind) && CLAIMANT_AUTHORITY_RE.test(`${e.description ?? ''} ${e.filename}`))
    .sort((a, b) => (b.capturedAt ?? b.uploadedAt).localeCompare(a.capturedAt ?? a.uploadedAt))[0];
  if (doc) return londonDate(doc.capturedAt ?? doc.uploadedAt);
  const signed = bundle.hire.filter((h) => h.signedAt).sort((a, b) => a.signedAt!.localeCompare(b.signedAt!))[0];
  return signed?.signedAt ? londonDate(signed.signedAt) : undefined;
}

const cctvPreservation: Builder = (b, base) => {
  const { bundle, ctx } = b;
  const acc = bundle.claim.accident;
  assertRecipientExtra(b);
  assertText(b, 'cameraDescription', 'retentionNote', 'operatorReference');
  const requestedType = extraAt(b, 'operatorType');
  if (requestedType !== undefined && !(CCTV_OPERATOR_TYPES as readonly unknown[]).includes(requestedType)) {
    throw badRequest(`data.operatorType must be one of ${CCTV_OPERATOR_TYPES.join(', ')}`, { code: 'INVALID_FIELD', field: 'operatorType' });
  }
  const fee = extraAt(b, 'feePence');
  if (fee !== undefined && (typeof fee !== 'number' || !Number.isInteger(fee) || fee < 0)) {
    throw badRequest('data.feePence must be a whole number of pence (the operator’s published fee)', { code: 'INVALID_FIELD', field: 'feePence' });
  }
  const authorityDate = signedAuthorityDate(bundle);
  if (!authorityDate) {
    throw conflict(
      'NO_SIGNED_AUTHORITY',
      'No signed authority from the claimant is on file. Upload it as evidence (kind "document", described as e.g. "Signed authority" or "Letter of authority") or record the signed hire agreement before any third party is asked for footage.',
    );
  }
  const party = b.recipientPartyId ? ctx.repos.getParty(ctx.db, b.recipientPartyId) : undefined;
  const incidentMs = Date.parse(acc.occurredAt);
  const window = (deltaMinutes: number): ISODateTime => new Date(incidentMs + deltaMinutes * 60_000).toISOString();
  const location = acc.postcode && !acc.location.toUpperCase().includes(acc.postcode.toUpperCase()) ? `${acc.location}, ${acc.postcode}` : acc.location;
  return {
    ...base,
    operatorType: operatorTypeOf(party),
    location,
    incidentAt: acc.occurredAt,
    windowStart: window(-CCTV_WINDOW_MINUTES),
    windowEnd: window(CCTV_WINDOW_MINUTES),
    policeReference: str(acc.policeReference),
    authorityDate,
    responseDeadline: notBeforeClock(bundle, workingDaysFrom(todayOf(b), CCTV_CONFIRM_WORKING_DAYS), ['cctv_preservation']),
  };
};

// ---------------------------------------------------------------------------
// letter.client_update
// ---------------------------------------------------------------------------

/** Working days the client is given to return documents and evidence. */
const CLIENT_RETURN_WORKING_DAYS = 5;
/** The longest we leave the client without an update (voice.md: update before the client has to ask). */
const CLIENT_UPDATE_MAX_DAYS = 14;

interface ClientNeed {
  action: string;
  byDate: ISODate;
}

/**
 * "What I need from you", from the evidence gates: only items the client can supply. Items CCGUK collects itself
 * (odometer readings, GTA group, chronology events, cancellation information) stay off the client's list.
 */
function clientNeeds(bundle: ClaimBundle, gates: GateResult[], today: ISODate): ClientNeed[] {
  const byReturn = workingDaysFrom(today, CLIENT_RETURN_WORKING_DAYS);
  const missing = (gate: GateResult['gate']): string[] => gates.find((g) => g.gate === gate && g.status !== 'green')?.missing ?? [];
  const has = (gate: GateResult['gate'], re: RegExp): boolean => missing(gate).some((m) => re.test(m));
  const out: ClientNeed[] = [];

  // Offer decisions first: an offer must be answered within one working day (mitigation).
  if (has('mitigation', /decision and reasons/i)) {
    for (const o of bundle.offers.filter((x) => x.clientDecision === 'pending').sort((x, y) => Date.parse(x.receivedAt) - Date.parse(y.receivedAt))) {
      out.push({
        action: `Tell me whether you accept or decline the offer of a vehicle made by ${o.offerorName} on ${formatDateLong(o.receivedAt)}, and your reasons, so that a written reply can be sent.`,
        byDate: workingDaysFrom(today, 1),
      });
    }
  }
  if (has('enforceability', /e-signed/i)) out.push({ action: 'Sign the hire agreement using the one-time code we send to you.', byDate: workingDaysFrom(today, 1) });
  if (has('enforceability', /express written request/i)) out.push({ action: 'Sign your written request for the hire to start within the 14-day cancellation period.', byDate: workingDaysFrom(today, 1) });
  if (has('mitigation', /mitigation questionnaire/i)) {
    out.push({ action: 'Sign and return the mitigation questionnaire. It records any offer of a vehicle made to you and what you decided.', byDate: byReturn });
  }
  if (missing('need').length) {
    out.push({
      action: 'Complete, sign and return the statement of need: your work, the journeys you need a vehicle for, anyone who relies on you for transport, and whether any other vehicle in your household was available to you.',
      byDate: byReturn,
    });
  }
  if (has('impecuniosity', /statement of means/i)) {
    out.push({ action: 'Complete, sign and return the statement of means: your income, your regular outgoings, any savings and any credit available to you.', byDate: byReturn });
  }
  if (has('impecuniosity', /bank statements/i)) out.push({ action: 'Send your last three months’ bank statements for every account you hold.', byDate: byReturn });
  if (has('impecuniosity', /income evidence/i)) {
    out.push({ action: 'Send one document showing your income: a recent payslip, an SA302 or tax return, your accounts or a benefit award letter.', byDate: byReturn });
  }
  if (has('liability', /own account/i)) out.push({ action: 'Call me to give your own account of how the accident happened.', byDate: byReturn });
  if (has('liability', /independent source/i)) {
    out.push({ action: 'If you have dashcam footage, the name and contact details of an independent witness, or a police reference for the accident, send them to me.', byDate: byReturn });
  }
  if (!out.length) {
    out.push({ action: 'Check the details in this letter and tell me if anything is wrong or has changed, including your address, telephone number or email.', byDate: byReturn });
  }
  return out;
}

/** "Where we are": dated facts from the hire record, the chronology and the ledger. */
function whereWeAre(b: BuildInput): string {
  const { bundle, now } = b;
  const ins = insurerName(bundle);
  const lines: string[] = [];
  const settled = latestEvent(bundle, 'settled');
  const h = latestHire(bundle);
  const nowMs = Date.parse(now);
  if (h) {
    if (h.endAt && Date.parse(h.endAt) <= nowMs) lines.push(`Your hire ended on ${formatDateLong(h.endAt)}.`);
    else if (Date.parse(h.startAt) <= nowMs) lines.push(`Your replacement vehicle has been on hire since ${formatDateLong(h.deliveredAt ?? h.startAt)}.`);
  }
  const pack = packBlock(bundle);
  if (pack) lines.push(`The claim was sent to ${ins} on ${formatDateLong(pack.sentAtIso)}.`);
  else {
    const ncaf = ncafBlock(bundle);
    if (ncaf) lines.push(`${ins} was notified of the claim on ${formatDateLong(ncaf.sentAtIso)}.`);
  }
  const heads = headSummaries(bundle);
  const received = sumPence(heads.map((x) => x.receivedPence));
  const outstanding = sumPence(heads.map((x) => x.outstandingPence));
  const lastPaid = [...bundle.ledger].filter((e) => e.kind === 'paid' || e.kind === 'interim_paid').sort((x, y) => y.date.localeCompare(x.date))[0];
  if (settled) lines.push(`The claim was settled on ${formatDateLong(settled.at)}.`);
  else if (received > 0 && lastPaid) {
    lines.push(`${ins} has paid ${formatGBP(received)} so far, most recently on ${formatDateLong(lastPaid.date)}.`);
    if (outstanding > 0) lines.push(`${formatGBP(outstanding)} remains outstanding.`);
  } else if (pack) lines.push('No payment has been made yet.');
  if (!lines.length) lines.push(`Your claim was opened on ${formatDateLong(bundle.claim.openedAt)}.`);
  return lines.join(' ');
}

/** Client-facing wording for the playbook's next step (never the handler's "why", never a promised outcome, no FOS). */
function nextStepText(a: PlaybookAction, bundle: ClaimBundle, today: ISODate): string | undefined {
  const ins = insurerName(bundle);
  const due = a.dueAt ? londonDate(a.dueAt) : undefined;
  const future = due && due > today ? due : undefined;
  switch (a.code) {
    case 'SEND_NCAF':
      return `We are notifying ${ins} of your claim and of the services you are receiving.`;
    case 'REQUEST_HANDLING_REF':
      return `We are asking ${ins} for its claim reference and the name of its handling office.`;
    case 'REQUEST_CCTV':
      return 'We are asking for any CCTV footage of the accident location to be preserved before it is overwritten.';
    case 'REPLY_TO_INTERVENTION_OFFER':
      return 'We are replying in writing to the offer of a vehicle, giving your decision and your reasons.';
    case 'SEND_COLLECT_OR_PAY':
      return `We are asking ${ins} to collect your vehicle from storage or to pay the storage charges.`;
    case 'SEND_DELAY_NOTICE':
      return `We are writing to ${ins} about the delay to your repair.`;
    case 'END_HIRE_NOW':
      return 'The event that ends your hire has happened, so I will contact you to arrange the return of the hire vehicle.';
    case 'SEND_PAYMENT_PACK':
      return a.blockedBy?.length
        ? `When the documents listed above are in, the full claim goes to ${ins} with the supporting evidence.`
        : `The full claim, with the supporting evidence, is being sent to ${ins}.`;
    case 'SPLIT_HEADS_INTERIM':
      return `${ins} disputes the hire charges only, so we are asking it to pay the parts of the claim it does not dispute now.`;
    case 'CHASER_7':
    case 'CHASER_14':
    case 'CHASER_21':
      return future ? `We are chasing ${ins} for the balance. The next letter goes to it on ${formatDateLong(future)}.` : `We are chasing ${ins} for the balance.`;
    case 'COMPLAINT_28':
      return future
        ? `If the balance is not paid, a formal complaint goes to ${ins} on ${formatDateLong(future)}. It then has eight weeks to give its final response.`
        : `The balance is still unpaid, so a formal complaint is going to ${ins}. It then has eight weeks to give its final response.`;
    case 'VENDOR_VERIFICATION_PACK':
      return `${ins} needs to verify our company and bank details before it pays, so we are sending it the verification documents.`;
    case 'SEND_DSAR':
      return `We are asking ${ins} for its call recordings and notes about the offer of a vehicle it says was made, to establish what was said.`;
    case 'LETTER_BEFORE_CLAIM':
      return 'If the balance is still not paid, we will prepare a letter of claim for you to sign and send, and explain the court process and its costs before you decide whether to go ahead.';
    case 'PART36_OFFER':
      return 'We will prepare a formal settlement offer under Part 36 of the court rules for you, or your solicitor, to sign and send.';
    case 'DEFAULT_JUDGMENT':
      return 'No defence was filed in time, so we will prepare the request for judgment for you, or your solicitor, to file with the court.';
    default:
      return undefined; // internal steps (evidence collection is in "What I need from you"; supplier, witness and injury flags are not for this letter)
  }
}

const clientUpdate: Builder = (b, base) => {
  const { bundle, ctx } = b;
  const today = todayOf(b);
  assertText(b, 'whatThisMeans', 'salutationName', 'whatHappensNext.text');
  const gates = gatesFor(bundle);
  const actions = actionsFor(ctx, bundle, gates);
  const complaintDue = actions.some((a) => a.code === 'COMPLAINT_28');
  const steps = actions
    .filter((a) => !(complaintDue && /^CHASER_/.test(a.code))) // the complaint supersedes the chaser ladder in the client's eyes
    .map((a) => ({ a, text: nextStepText(a, bundle, today) }))
    .filter((x): x is { a: PlaybookAction; text: string } => Boolean(x.text));
  const shown = steps.slice(0, 3);
  const latestUpdate = calendarDaysFrom(today, CLIENT_UPDATE_MAX_DAYS);
  const earliestUpdate = workingDaysFrom(today, CLIENT_RETURN_WORKING_DAYS);
  const nextDue = shown.map((s) => (s.a.dueAt ? londonDate(s.a.dueAt) : undefined)).filter((d): d is ISODate => Boolean(d && d > today)).sort()[0];
  const writeAgainBy = nextDue ? (nextDue < earliestUpdate ? earliestUpdate : nextDue > latestUpdate ? latestUpdate : nextDue) : latestUpdate;

  const heads = headSummaries(bundle);
  const claimed = sumPence(heads.map((x) => x.claimedPence));
  const received = sumPence(heads.map((x) => x.receivedPence));
  const outstanding = sumPence(heads.map((x) => x.outstandingPence));
  const settings = base.settings as CompanySettingsData;

  return {
    ...base,
    // The form of address is the handler's choice; the claimant's full name is the default.
    salutationName: str(extraAt(b, 'salutationName')) ? undefined : bundle.claimant.name,
    whereWeAre: whereWeAre(b),
    needFromYou: clientNeeds(bundle, gates, today),
    whatHappensNext: { text: shown.length ? shown.map((s) => s.text).join('\n\n') : undefined, date: writeAgainBy },
    // Each label ends with its own status word, right against its figure: the consistency engine reads the nearest
    // keyword, so "Claimed … £X | Received to date …" would make the claimed total read as a payment (a block nobody
    // can clear on this letter, whose explanation is the handler's). No "received" row when nothing has been paid.
    figures:
      claimed > 0
        ? [
            { label: 'Amount claimed', valuePence: claimed },
            ...(received > 0 ? [{ label: 'Amount received', valuePence: received }] : []),
            { label: 'Amount outstanding', valuePence: outstanding, emphasis: true },
          ]
        : undefined,
    handler: { name: settings.signatoryName, role: settings.signatoryRole, phone: brand.company.caseHandlerPhone, email: brand.company.claimsEmail },
  };
};

// ---------------------------------------------------------------------------
// letter.supplier_instruction_engineer
// ---------------------------------------------------------------------------

const INSPECTION_WORKING_DAYS = 2;
const REPORT_AFTER_INSPECTION_WORKING_DAYS = 3;

/** The engineer on the file: the report's engineer, else the party named on the engineer_instructed event. */
function engineerParty(b: BuildInput): Party | undefined {
  const { bundle, ctx } = b;
  const ids = [bundle.report?.engineerPartyId, ...bundle.events.filter((e) => e.type === 'engineer_instructed').map((e) => str(e.data?.engineerPartyId) ?? str(e.data?.partyId))];
  for (const id of ids) {
    if (!id) continue;
    const p = ctx.repos.getParty(ctx.db, id);
    if (p) return p;
  }
  return undefined;
}

/** PD 27A para 7.3(2) expert fee cap — only when the knowledge base entry is verified; otherwise the rule is cited without a figure. */
function smallClaimsExpertFeeCap(b: BuildInput): Pence | undefined {
  const entry = kbEntries(b.ctx).find((e) => e.id === 'pd-27a-7-3');
  if (!entry || entry.verification?.status !== 'verified') return undefined;
  const m = /£\s?([\d,]+)(?:\.(\d{2}))?\s+for\s+each\s+expert/i.exec(`${entry.text ?? ''} ${entry.principle}`);
  return m ? Number(m[1]!.replace(/,/g, '')) * 100 + Number(m[2] ?? 0) : undefined;
}

const engineerInstruction: Builder = (b, base) => {
  const { bundle, ctx } = b;
  const v = bundle.vehicle;
  const today = todayOf(b);
  assertText(b, 'damageReported', 'vehicle.location', 'vehicle.locationContact', 'vehicle.keysWith');
  assertTextList(b, 'questions');
  assertRecipientExtra(b);
  const inspectionBy = workingDaysFrom(today, INSPECTION_WORKING_DAYS);
  const reportBy = workingDaysFrom(inspectionBy, REPORT_AFTER_INSPECTION_WORKING_DAYS);
  const acc = bundle.claim.accident;

  // Recipient: an explicit recipient party (already in base), a recipient typed by the handler, else the file's engineer.
  const handlerRecipient = isRecord(extraAt(b, 'recipient'));
  const engineer = base.recipient || handlerRecipient ? undefined : engineerParty(b);
  const recipient: RecipientBlockData | undefined = (base.recipient as RecipientBlockData | undefined) ?? (engineer ? recipientBlock(engineer) : undefined);

  // Location: only while the vehicle is in open storage; once storage has ended only the handler knows where it is.
  const storage = storageBlock(bundle, b.now);
  const location = storage?.open ? storage.location : undefined;
  const latestOdo = [...v.odometer].sort((x, y) => y.date.localeCompare(x.date))[0];
  const description = [vehicleDescription(v) ?? 'Vehicle', v.yearOfManufacture ? String(v.yearOfManufacture) : undefined, v.fuelType, v.transmission].filter(Boolean).join(', ');

  const photos = bundle.evidence.filter((e) => e.kind === 'photo').length;
  const enclosures: string[] = [];
  if (photos) enclosures.push(`Photographs of the vehicle (${photos})`);
  if (v.lookups?.some((l) => l.kind === 'vehicle')) enclosures.push('DVLA vehicle enquiry');
  if (v.motHistory?.length) enclosures.push('MOT history');
  if (bundle.recovery.length) enclosures.push('Recovery record');
  if (bundle.estimate || bundle.evidence.some((e) => e.kind === 'estimate')) enclosures.push('Repair estimate');

  const proceedings = bundle.events.some((e) => e.type === 'proceedings_issued');
  return {
    ...base,
    recipient,
    vehicle: {
      registration: v.registration,
      description,
      vin: str(v.vin),
      odometerMiles: latestOdo?.miles,
      motExpiry: v.motExpiryDate,
      location,
    },
    accidentCircumstances: `The accident happened at ${acc.location} on ${formatDateLong(acc.occurredAt)}. The claimant’s account, recorded at first notification: “${acc.circumstances.trim()}”`,
    inspectionBy,
    reportBy,
    // Default false (true once proceedings are issued); whether the report is for court is the handler's call.
    forCourt: typeof extraAt(b, 'forCourt') === 'boolean' ? undefined : proceedings,
    feePence: ctx.settings().rateCard.engineerFeePence,
    smallClaimsExpertFeeCapPence: smallClaimsExpertFeeCap(b),
    enclosures,
  };
};

// ---------------------------------------------------------------------------
// letter.vendor_verification_pack
// ---------------------------------------------------------------------------

/** Reasons the playbook reads as the insurer's vendor / bank-validation request (domain playbook VENDOR_VERIFICATION_PACK). */
const VENDOR_REASONS = new Set(['bank_validation', 'bank_details_not_validated', 'vendor_verification']);
const VENDOR_EVENT_TYPES = new Set(['reduction_received', 'note', 'email_in', 'letter_in', 'call']);
/** Heads CCGUK itself invoices; any other head appears only when an invoice was raised on it. */
const SERVICE_HEADS: readonly HeadOfLoss[] = ['recovery', 'storage', 'engineer_fee', 'hire'];
const VENDOR_REPLY_WORKING_DAYS = 5;

const CHANNEL_PHRASE: Record<string, string> = { email_in: ' by email', letter_in: ' by letter', call: ' by telephone' };

function vendorRequest(bundle: ClaimBundle) {
  const ev = [...bundle.events]
    .filter((e) => VENDOR_EVENT_TYPES.has(e.type) && VENDOR_REASONS.has(str(e.data?.reason) ?? ''))
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!ev) return undefined;
  const how = CHANNEL_PHRASE[ev.type] ?? '';
  const summary =
    str(ev.data?.reason) === 'vendor_verification'
      ? `you asked us${how} for vendor set-up documents before payment can be made`
      : `you told us${how} that our bank details could not be validated`;
  return { at: ev.at, summary, theirVendorRef: str(ev.data?.reference) ?? str(ev.data?.theirReference) ?? str(ev.data?.vendorRef) };
}

/** The invoice number the insurer holds for a head: the ledger's invoice reference, else an issued invoice document's. */
function invoiceNumberFor(bundle: ClaimBundle, head: HeadOfLoss, ledgerRef: string | undefined): string | undefined {
  if (ledgerRef) return ledgerRef;
  const doc = bundle.documents
    .filter((d) => d.templateId === `invoice.${head}` && (d.status === 'approved' || d.status === 'sent' || d.status === 'signed'))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return str(doc?.dataSnapshot?.invoiceNumber);
}

/** The director: the generating user if an admin (labelled "Director"), else the only admin user. */
function directorName(b: BuildInput): string | undefined {
  if (b.user.role === 'admin') return b.user.name;
  const admins = b.ctx.repos.listUsers(b.ctx.db).filter((u) => u.role === 'admin');
  return admins.length === 1 ? admins[0]!.name : undefined;
}

const vendorVerificationPack: Builder = (b, base) => {
  const { bundle, ctx, now } = b;
  assertText(b, 'director.name', 'director.idDocument', 'request.summary');
  const settings = base.settings as CompanySettingsData;
  const registered = ctx.settings().companyName;
  if (settings.bank.accountName && settings.bank.accountName.replace(/\s+/g, ' ').trim().toLowerCase() !== registered.replace(/\s+/g, ' ').trim().toLowerCase()) {
    throw conflict(
      'BANK_NAME_NOT_REGISTERED_NAME',
      `The bank account name in Settings ("${settings.bank.accountName}") is not the exact registered name "${registered}". Confirmation of Payee would return a mismatch; correct Settings before sending the vendor pack.`,
    );
  }
  const req = vendorRequest(bundle);
  if (!req) {
    throw conflict(
      'NO_VENDOR_REQUEST',
      'No vendor or bank-validation request from the insurer is logged on this claim. Log it as an event (email_in, letter_in, call or note) with data.reason "bank_validation" or "vendor_verification" and the date it was received, then draft the pack.',
    );
  }

  const hire = hireBlock(ctx, bundle, now);
  const storage = storageBlock(bundle, now);
  const recovery = recoveryBlock(bundle);
  const report = reportBlock(ctx, bundle);
  const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  const detailOf = (head: HeadOfLoss): string | undefined =>
    head === 'hire' && hire
      ? `${days(hire.days)} at ${formatGBP(hire.dailyRatePence)} per day`
      : head === 'storage' && storage
        ? `${days(storage.days)} at ${formatGBP(storage.dailyRatePence)} per day`
        : head === 'recovery' && recovery
          ? `${recovery.loadedMiles} loaded miles, ${recovery.fromLocation} to ${recovery.toLocation}`
          : head === 'engineer_fee' && report?.issuedAt
            ? `inspection and report issued ${formatDateLong(report.issuedAt)}`
            : undefined;
  const invoicedHeads = new Set(bundle.ledger.filter((e) => e.kind === 'invoiced').map((e) => e.head));
  const rows = headSummaries(bundle)
    .filter((h) => h.outstandingPence > 0 && (SERVICE_HEADS.includes(h.head) || invoicedHeads.has(h.head)))
    .map((h) => {
      const rowsFor = (kind: LedgerEntry['kind']) => bundle.ledger.filter((e) => e.head === h.head && e.kind === kind).sort((x, y) => y.date.localeCompare(x.date));
      const source = rowsFor('invoiced')[0] ?? rowsFor('claimed')[0];
      const invoiceNumber = invoiceNumberFor(bundle, h.head, h.invoiceReference);
      const detail = detailOf(h.head);
      // "INV-H-000101 — Hire, 23 days at …"; without an invoice number the row is "Storage account — 10 days at …".
      const head = invoiceNumber ? (detail ? `${h.label}, ${detail}` : h.label) : detail ? detail.charAt(0).toUpperCase() + detail.slice(1) : h.label;
      return {
        number: invoiceNumber ?? `${h.label} account`,
        date: source?.date ?? todayOf(b),
        head: h.receivedPence > 0 ? `${head} (balance outstanding)` : head,
        amountPence: h.outstandingPence,
      };
    })
    .sort((x, y) => x.date.localeCompare(y.date) || x.number.localeCompare(y.number));
  if (!rows.length) throw conflict('NOTHING_OUTSTANDING', 'No CCGUK invoice on this claim has a balance outstanding, so there is nothing for the vendor pack to release.');

  const companyNumber = settings.companyNumber ?? brand.company.companyNumber;
  return {
    ...base,
    request: {
      receivedAt: londonDate(req.at),
      summary: str(extraAt(b, 'request.summary')) ? undefined : req.summary,
      theirVendorRef: req.theirVendorRef,
    },
    // The director's name yields to the handler; which identity document is enclosed is always the handler's to state.
    director: { name: str(extraAt(b, 'director.name')) ? undefined : directorName(b) },
    enclosures: [
      { title: 'Bank letter on the bank’s letterhead confirming the account name, sort code and account number' },
      { title: `Certificate of incorporation, company number ${companyNumber}` },
      { title: 'Proof of registered office' },
      { title: 'Director identity document' },
    ],
    invoices: rows,
    outstandingPence: sumPence(rows.map((r) => r.amountPence)),
    responseDeadline: workingDaysFrom(todayOf(b), VENDOR_REPLY_WORKING_DAYS),
  };
};

// ---------------------------------------------------------------------------

/** Template data builders for the correspondence group (keyed by template id). */
export const correspondenceBuilders: Record<string, Builder> = {
  'letter.cctv_preservation': cctvPreservation,
  'letter.client_update': clientUpdate,
  'letter.supplier_instruction_engineer': engineerInstruction,
  'letter.vendor_verification_pack': vendorVerificationPack,
};
