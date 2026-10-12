// owned by claimai-server
/**
 * Every server-side sentence of the AI input feature (docs/CLAIM-AI-INPUT.md §3.9): preview titles, status labels,
 * log and summary lines. Plain English, no accusation words (`BANNED_INTAKE_WORDS`) and no offer advice — copy.test.ts
 * sweeps every template.
 */
import { formatGBP as formatPence } from '../money.js';
import { fmtDay, fmtDayWeek, fmtWhen } from './dates.js';
import { AGENT_SCOPE_LABEL, CONTACT_LABEL, effectLabel, scopeLabel } from './instructions.js';
import type { ActionParams, ActionType, ContactRole } from './types.js';

export const EVENT_LABEL: Readonly<Record<string, string>> = {
  call: 'Call',
  note: 'Note',
  letter_in: 'Letter received',
  letter_out: 'Letter sent',
  email_in: 'Email received',
  email_out: 'Email sent',
  handling_ref_received: 'Handling reference received',
  engineer_instructed: 'Engineer instructed',
  inspection: 'Inspection',
  estimate_received: 'Estimate received',
  repair_authorised: 'Repair authorised',
  parts_ordered: 'Parts ordered',
  parts_arrived: 'Parts arrived',
  repair_started: 'Repair started',
  repair_delay: 'Repair delayed',
  repair_completed: 'Repair completed',
  vehicle_returned: 'Car returned to the client',
  vehicle_collected: 'Vehicle collected',
  recovery: 'Recovery',
  storage_started: 'Storage started',
  storage_ended: 'Storage ended',
  total_loss_confirmed: 'Total loss confirmed',
  ncaf_sent: 'New Claim Advice Form sent',
  chaser_sent: 'Chaser sent',
  cctv_request_sent: 'CCTV request sent',
  hire_start_notice_sent: 'Hire start notice sent',
  pcn_received: 'PCN received',
  nip_received: 'NIP received',
  s172_response_sent: 'Section 172 response sent',
  salvage_released: 'Salvage released',
  payment_pack_sent: 'Payment pack sent',
  collect_or_pay_notice_sent: 'Collect-or-pay notice sent',
  intervention_reply_sent: 'Reply to the intervention offer sent',
  complaint_sent: 'Complaint sent',
  letter_before_claim_sent: 'Letter before claim sent',
  part36_sent: 'Part 36 offer sent',
  hire_ended: 'Hire ended',
};

export const eventLabel = (t: string): string => EVENT_LABEL[t] ?? t.replace(/_/g, ' ');

export const TASK_KIND_LABEL: Readonly<Record<string, string>> = {
  follow_up: 'Follow up', chaser: 'Chase', deadline: 'Deadline', review: 'Review', call: 'Call', payment_check: 'Check payment', document: 'Document', other: 'Reminder',
};

export const FIELD_LABEL: Readonly<Record<string, string>> = {
  'claim.atFaultInsurerRef': 'Their reference',
  'claim.atFaultInsurerName': 'Their insurer',
  'claim.accident.policeReference': 'Police reference',
  'claim.thirdPartyPolicyNumber': 'Their policy number',
  'claim.clientInsurerName': 'Client’s insurer',
  'claim.clientPolicyNumber': 'Client’s policy number',
  'claim.accident.location': 'Accident location',
  'claim.accident.postcode': 'Accident postcode',
  'claim.accident.occurredAt': 'Accident date',
  'party:claimant.phone': 'Client’s phone',
  'party:claimant.email': 'Client’s email',
  'party:claimant.address': 'Client’s address',
  'party:client.phone': 'Client’s phone',
  'party:client.email': 'Client’s email',
  'party:client.address': 'Client’s address',
};
const ROLE_WORD: Readonly<Record<string, string>> = { client: 'Client’s', claimant: 'Client’s', driver: 'Driver’s', third_party: 'Their' };
const VEHICLE_WORD: Readonly<Record<string, string>> = { vin: 'VIN', registration: 'registration', make: 'car make', model: 'car model', firstRegistered: 'first registration', colour: 'car colour' };
const PARTY_WORD: Readonly<Record<string, string>> = { name: 'name', address: 'address', phone: 'phone', email: 'email', dateOfBirth: 'date of birth', drivingLicenceNumber: 'licence number' };
/** "Client’s car make", "Their registration", "Police reference" … */
export function fieldLabel(t: string): string {
  if (FIELD_LABEL[t]) return FIELD_LABEL[t]!;
  const m = /^(vehicle|party):([a-z_]+)\.(\w+)$/.exec(t);
  if (m) {
    const word = (m[1] === 'vehicle' ? VEHICLE_WORD : PARTY_WORD)[m[3]!] ?? m[3]!.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    return `${ROLE_WORD[m[2]!] ?? m[2]!.replace(/_/g, ' ')} ${word}`;
  }
  return t.replace(/^claim\./, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._]/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

export const LIABILITY_LABEL: Readonly<Record<string, string>> = { admitted: 'admitted', denied: 'denied', disputed: 'disputed', split: 'split', unknown: 'unknown' };

export const JOB_KIND_LABEL: Readonly<Record<string, string>> = {
  draft_letter: 'Prepare a letter', send_document: 'Send a document', chase: 'Chase', request_documents: 'Ask for documents', review_now: 'Review the claim now', replan: 'Re-plan the claim',
};

const contact = (c: ContactRole | null | undefined): string => (c ? CONTACT_LABEL[c] : 'the right person');

/** A stored ISO date / date-time reads as a London date for the owner ("2026-09-27T20:10:00.000Z" → "Sun 27 Sep 2026 21:10"). */
export function shownValue(v: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(v)) return fmtWhen(v, 'datetime');
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return fmtWhen(`${v}T12:00:00.000Z`, 'date');
  return v;
}

/** The plain-English preview sentence of an action (§6.1 "Preview"). */
export function actionTitle(type: ActionType, p: ActionParams): string {
  switch (type) {
    case 'event':
      return `Add to chronology: ${eventLabel(p.eventType ?? 'note')}${p.at ? ` — ${fmtWhen(p.at, p.precision ?? 'date')}` : ''}`;
    case 'note':
      return `Note: ${p.summary ?? p.text ?? ''}`.trim();
    case 'field_update':
      return p.target ? `${fieldLabel(p.target)}: ${p.current ? `${shownValue(p.current)} → ` : ''}${shownValue(p.value ?? '')}` : 'Update a detail on the claim';
    case 'liability_position':
      return `Liability: ${p.current ?? 'unknown'} → ${LIABILITY_LABEL[p.value ?? ''] ?? p.value ?? ''}`;
    case 'hire_end':
      return `End hire ${p.agreementNumber ?? ''}${p.endAt ? ` on ${fmtWhen(p.endAt, p.precision ?? 'date')}` : ''}${p.endTrigger === 'repair_complete_24h' ? ' (repair completed)' : ''}`.replace(/\s+/g, ' ');
    case 'hire_correct':
      return `Hire ${p.agreementNumber ?? ''}: ${p.startAt ? `start → ${fmtDay(p.startAt)}` : ''}${p.endAt ? `end → ${fmtDay(p.endAt)}` : ''}`.replace(/\s+/g, ' ');
    case 'hire_start':
      return 'Start the hire on the Hire tab (car and mileage needed)';
    case 'task':
      return `Reminder ${p.dueAt ? `${fmtWhen(p.dueAt, 'datetime')}` : ''}: ${p.note ?? TASK_KIND_LABEL[p.taskKind ?? 'other'] ?? 'reminder'}`.replace(/\s+:/, ':');
    case 'instruction':
      return `Standing instruction (${scopeLabel(p.appliesTo ?? ['all'])}): ${p.text ?? ''}${p.until && !/\buntil\b/i.test(p.text ?? '') ? ` until ${fmtDayWeek(p.until)}` : ''}`;
    case 'pause_agents':
      return `Pause agents and the Autopilot on this claim${p.until ? ` (until ${fmtDayWeek(p.until)})` : ''}`;
    case 'resume_agents':
      return 'Resume agents on this claim';
    case 'run_job':
      switch (p.jobKind) {
        case 'review_now':
          return 'Ask the case manager to review this claim now';
        case 'replan':
          return 'Ask the Autopilot to re-plan this claim now';
        case 'send_document':
          return `Prepare an email to ${contact(p.recipient)}${p.filename ? ` attaching '${p.filename}'` : ''} — it follows the sending rules`;
        case 'chase':
          return `Prepare a chaser to ${contact(p.recipient)} — it follows the sending rules`;
        case 'request_documents':
          return `Prepare a request to ${contact(p.recipient)}${p.purpose ? ` for ${p.purpose}` : ''} — you approve it before it is sent`;
        default:
          return `Prepare ${p.purpose ?? 'a letter'}${p.recipient ? ` to ${contact(p.recipient)}` : ''} — it follows the sending rules`;
      }
    case 'money':
      return `Payment of ${typeof p.amountPence === 'number' ? formatPence(p.amountPence) : 'an amount'}${p.head ? ` on ${p.head}` : ''} — goes to Needs-you; you record it in the ledger`;
    case 'offer_received':
      return `Record an offer of ${typeof p.amountPence === 'number' ? formatPence(p.amountPence) : 'an amount'}${p.offeror ? ` from ${p.offeror}` : ''} (${p.register === 'intervention' ? 'replacement car register' : 'settlement register'}) — the decision stays with you`;
    case 'offer_decision':
      return 'You asked about the offer — decide it on the Offers screen';
    case 'legal':
      return `Legal: ${p.matter ?? p.summary ?? 'a legal step'} — goes to Needs-you`;
    case 'status_change':
      return `Status: ${p.current ?? '?'} → ${p.status ?? '?'}`;
    case 'close_or_decline':
      return 'Closing, settling or declining is done by you from the status menu (a reason is needed)';
    case 'private_note':
      return 'Kept as your private note — agents never act on it and never decline a claim';
    case 'unsupported':
      return `ClaimDesk cannot do this: ${p.reason ?? 'not something an update can do'}`;
    case 'file_evidence':
      return `File '${p.filename ?? 'document'}'${p.evidenceKind ? ` as ${p.evidenceKind.replace(/_/g, ' ')}` : ''}`;
    case 'record_correspondence':
      return `Record: ${p.summary ?? ''}`.trim();
  }
}

export const STATUS_LABEL: Readonly<Record<string, string>> = {
  interpreting: 'Reading your note',
  waiting_ai: 'Waiting for the AI',
  clarify: 'Has a question for you',
  preview: 'Ready to check',
  reading: 'Reading the files',
  applying: 'Working on it',
  applied: 'Done',
  partly_applied: 'Partly done',
  nothing_to_do: 'Nothing to do',
  cancelled: 'Cancelled',
  failed: 'Could not read it',
  undone: 'Undone',
};

export const WAITING_LABEL: Readonly<Record<string, string>> = {
  agents_off: 'Agents are paused — simple updates still work; the rest waits for the AI.',
  kill_switch: 'Agents are stopped (kill switch) — the rest waits until they are back on.',
  usage: 'The AI usage limit was reached — the rest waits until it resets.',
  sign_in: 'The AI needs signing in again — the rest waits until then.',
};

/** Fixed sentences (swept by the banned-words test). */
export const COPY = {
  recordedLate: (filename: string) => `recorded late, source: ${filename}`,
  undoEventNote: (date: string) => `Withdrawn — undo of your update of ${date}`,
  sideEffectUndo: 'This entry changed other records — correct it in Chronology',
  evidenceWriteOnce: 'Filed documents stay on file (evidence is never removed)',
  noRunningHire: 'There is no running hire',
  whichHire: 'Which hire ended?',
  untilWhen: 'Until when?',
  untilISay: 'Until I say',
  whichDocument: (what: string) => `Which document should I send (${what})?`,
  whichTemplate: 'Which letter should I prepare?',
  untilMonday: 'Monday',
  aWeek: 'A week',
  futureDate: 'That date is in the future — when did it happen?',
  farDate: 'I could not place that date — which date did you mean?',
  pendingAi: 'Waiting for the AI to read the rest',
  injection: 'The call note contains text aimed at an AI; it was used as facts only.',
  quoteNotFound: 'the AI’s words are not in your note',
  fromTranscript: 'From the call note — type it yourself if you want it done',
  aiFailed: (why: string) => `The AI could not read the rest: ${why}`,
  askConfirmInWriting: (insurer: string) => `Ask ${insurer} to confirm the admission in writing`,
  solicitorHold: 'The client has a solicitor: no direct contact with the client until you say',
  readyToCheck: (ref: string) => `Your update on ${ref} is ready to check`,
  questionCard: (ref: string) => `A question about your update on ${ref}`,
  offerCard: (ref: string) => `You asked about an offer on ${ref} — decide it on the Offers screen`,
  closeCard: (ref: string) => `You asked to close or decline ${ref} — do it from the status menu with a reason`,
} as const;

export { AGENT_SCOPE_LABEL, CONTACT_LABEL, effectLabel };
