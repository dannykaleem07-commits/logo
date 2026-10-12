// owned by claimai-server
/**
 * What kind of letter, and the chronology event it implies (docs/CLAIM-AI-INPUT.md §3.7). Template titles (from
 * `@ccguk/documents`, passed in by the API) score 5 when found in the first 20 lines or the subject; phrases score 3.
 * Offers, remittances, final responses and our own letter before claim / Part 36 are `owner_only`: never applied
 * automatically (the smart-intake rule kept).
 */
import type { DocType, EmailKind } from '../agents/types.js';
import type { EventType } from '../types.js';

export type CorrespondenceKind =
  | 'ncaf' | 'handling_ref_request' | 'hire_start_notice' | 'chaser' | 'cctv_request' | 'payment_pack' | 'collect_or_pay' | 'intervention_reply'
  | 'complaint' | 'engineer_instruction' | 'doc_request' | 'client_update' | 'letter_before_claim' | 'part36' | 's172_response' | 'other_out'
  | 'insurer_letter' | 'acknowledgement' | 'offer' | 'remittance' | 'final_response' | 'client_message' | 'other_in';

export const CORRESPONDENCE_KINDS: readonly CorrespondenceKind[] = [
  'ncaf', 'handling_ref_request', 'hire_start_notice', 'chaser', 'cctv_request', 'payment_pack', 'collect_or_pay', 'intervention_reply', 'complaint',
  'engineer_instruction', 'doc_request', 'client_update', 'letter_before_claim', 'part36', 's172_response', 'other_out', 'insurer_letter', 'acknowledgement',
  'offer', 'remittance', 'final_response', 'client_message', 'other_in',
];
export const OUT_KINDS: readonly CorrespondenceKind[] = CORRESPONDENCE_KINDS.slice(0, 16);
export const IN_KINDS: readonly CorrespondenceKind[] = CORRESPONDENCE_KINDS.slice(16);
export const isCorrespondenceKind = (v: unknown): v is CorrespondenceKind => typeof v === 'string' && (CORRESPONDENCE_KINDS as readonly string[]).includes(v);

export const CORRESPONDENCE_KIND_LABEL: Readonly<Record<CorrespondenceKind, string>> = {
  ncaf: 'New Claim Advice Form',
  handling_ref_request: 'Request for the handling reference',
  hire_start_notice: 'Hire start notice',
  chaser: 'Chaser',
  cctv_request: 'CCTV preservation request',
  payment_pack: 'Payment pack',
  collect_or_pay: 'Collect-or-pay notice',
  intervention_reply: 'Reply to the replacement car offer',
  complaint: 'Complaint',
  engineer_instruction: 'Engineer instruction',
  doc_request: 'Request for documents',
  client_update: 'Update to the client',
  letter_before_claim: 'Letter before claim',
  part36: 'Part 36 offer',
  s172_response: 'Section 172 response',
  other_out: 'Letter',
  insurer_letter: 'Letter from the insurer',
  acknowledgement: 'Acknowledgement',
  offer: 'Offer',
  remittance: 'Remittance',
  final_response: 'Final response',
  client_message: 'Message from the client',
  other_in: 'Letter received',
};

export interface KindResult {
  kind: CorrespondenceKind;
  label: string;
  eventType: EventType;
  templateId: string | null;
  emailKind: EmailKind | null;
  cls: 'record' | 'clock' | 'owner_only';
  confidence: number;
  why: string;
  /** A second chronology event the letter implies (the first insurer letter with its reference → handling_ref_received). */
  alsoEvent?: EventType | null;
}

export interface RecogniseInput {
  direction: 'out' | 'in';
  docType: DocType | null;
  text: string;
  subject: string | null;
  isEmail: boolean;
  templateTitles: Array<{ templateId: string; title: string }>;
  hasPaymentPack: boolean;
  insurerRefNew: boolean;
}

interface Row {
  kind: CorrespondenceKind;
  phrases: RegExp[];
  eventType: EventType | 'letter_or_email';
  templateId: string | null;
  emailKind: EmailKind | null;
  cls: KindResult['cls'];
  /** Only when the letter goes to the client. */
  toClient?: boolean;
}

const OUT_ROWS: Row[] = [
  { kind: 'ncaf', phrases: [/new claim advice form/i, /\bNCAF\b/, /notify you of a claim/i, /notification of (?:a|our) claim/i], eventType: 'ncaf_sent', templateId: 'letter.ncaf', emailKind: null, cls: 'clock' },
  {
    kind: 'handling_ref_request',
    phrases: [/handling office/i, /(?:your|the) claim reference[\s\S]{0,200}please (?:provide|confirm|let us have)|please (?:provide|confirm|let us have)[\s\S]{0,200}(?:your|the) claim reference/i],
    eventType: 'letter_or_email',
    templateId: 'letter.handling_ref_request',
    emailKind: 'handling_ref_request',
    cls: 'record',
  },
  { kind: 'hire_start_notice', phrases: [/hire (?:has )?(?:commenced|started)/i, /replacement vehicle (?:was|has been) (?:provided|supplied)/i], eventType: 'hire_start_notice_sent', templateId: 'letter.hire_start_notice', emailKind: 'insurer_notice', cls: 'clock' },
  { kind: 'chaser', phrases: [/\bchaser\b/i, /still (?:awaiting|not received)/i, /further to our (?:letter|email) (?:of|dated)/i, /second request/i, /final reminder/i], eventType: 'chaser_sent', templateId: 'letter.chaser_7', emailKind: 'chaser', cls: 'clock' },
  { kind: 'cctv_request', phrases: [/\bCCTV\b/, /preserve (?:the )?footage/i], eventType: 'cctv_request_sent', templateId: 'letter.cctv_preservation', emailKind: 'cctv_request', cls: 'clock' },
  { kind: 'payment_pack', phrases: [/payment pack/i, /invoices? (?:is |are )?enclosed/i, /schedule of loss/i], eventType: 'payment_pack_sent', templateId: 'pack.gta_payment', emailKind: null, cls: 'clock' },
  { kind: 'collect_or_pay', phrases: [/collect the vehicle or/i, /storage (?:charges )?(?:will )?continue/i], eventType: 'collect_or_pay_notice_sent', templateId: 'letter.collect_or_pay', emailKind: null, cls: 'clock' },
  { kind: 'intervention_reply', phrases: [/your offer of a replacement vehicle/i], eventType: 'intervention_reply_sent', templateId: 'letter.intervention_reply', emailKind: null, cls: 'clock' },
  { kind: 'complaint', phrases: [/formal complaint/i, /\bDISP 1\b/, /\bICOBS 8\b/], eventType: 'complaint_sent', templateId: 'letter.complaint_disp', emailKind: 'complaint', cls: 'clock' },
  { kind: 'engineer_instruction', phrases: [/instruct(?:ed)? you to (?:inspect|assess)/i, /inspection of the vehicle/i], eventType: 'engineer_instructed', templateId: 'letter.supplier_instruction_engineer', emailKind: 'supplier_instruction', cls: 'clock' },
  { kind: 'doc_request', phrases: [/please (?:send|provide)/i, /we (?:still )?need/i], eventType: 'letter_or_email', templateId: null, emailKind: 'doc_request', cls: 'record', toClient: true },
  { kind: 'client_update', phrases: [/update on your claim/i], eventType: 'letter_or_email', templateId: 'letter.client_update', emailKind: 'client_update', cls: 'record', toClient: true },
  { kind: 'letter_before_claim', phrases: [/letter before claim/i, /pre-action protocol/i], eventType: 'letter_before_claim_sent', templateId: 'letter.letter_before_claim', emailKind: 'legal', cls: 'owner_only' },
  { kind: 'part36', phrases: [/\bpart 36\b/i], eventType: 'part36_sent', templateId: 'letter.part36_offer', emailKind: null, cls: 'owner_only' },
  { kind: 's172_response', phrases: [/section 172/i, /\bs\.?\s?172\b/i], eventType: 's172_response_sent', templateId: 'notice.s172_response', emailKind: null, cls: 'clock' },
];

const firstLines = (s: string, n: number): string => s.split(/\r?\n/).slice(0, n).join('\n');
const normTitle = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function letterOrEmail(dir: 'out' | 'in', isEmail: boolean): EventType {
  return dir === 'out' ? (isEmail ? 'email_out' : 'letter_out') : isEmail ? 'email_in' : 'letter_in';
}

function make(row: Row, i: RecogniseInput, confidence: number, why: string): KindResult {
  let eventType: EventType = row.eventType === 'letter_or_email' ? letterOrEmail('out', i.isEmail) : row.eventType;
  let cls = row.cls;
  // A chaser is the GTA chaser (`chaser_sent`, a clock) only once the payment pack went; before that it is a record.
  if (row.kind === 'chaser' && !i.hasPaymentPack) {
    eventType = letterOrEmail('out', i.isEmail);
    cls = 'record';
  }
  return { kind: row.kind, label: CORRESPONDENCE_KIND_LABEL[row.kind], eventType, templateId: row.templateId, emailKind: row.emailKind, cls, confidence, why };
}

export function recogniseCorrespondence(i: RecogniseInput): KindResult {
  const text = i.text ?? '';
  const top = `${i.subject ?? ''}\n${firstLines(text, 20)}`;
  if (i.direction === 'out') {
    const toClient = /\bdear\s+(?:mr|mrs|ms|miss|mx)\b/i.test(text) || /\byour (?:car|vehicle|claim)\b/i.test(text);
    let best: { row: Row; score: number; why: string } | null = null;
    for (const row of OUT_ROWS) {
      let score = 0;
      let why = '';
      const t = i.templateTitles.find((x) => x.templateId === row.templateId);
      if (t && normTitle(t.title).length > 3 && normTitle(top).includes(normTitle(t.title))) {
        score += 5;
        why = `the title "${t.title}"`;
      }
      const hit = row.phrases.find((re) => re.test(text) || (i.subject ? re.test(i.subject) : false));
      if (hit) {
        if (row.toClient && !toClient) continue;
        score += 3;
        // the subject says what the letter is; the body may only mention an earlier one ("we sent you our NCAF…")
        if (i.subject && row.phrases.some((re) => re.test(i.subject!))) score += 2;
        why = why || `the words "${(text.match(hit) ?? i.subject?.match(hit) ?? [''])[0]!.slice(0, 60)}"`;
      }
      if (score > (best?.score ?? 0)) best = { row, score, why };
    }
    if (best) return make(best.row, i, best.score >= 5 ? 0.95 : 0.85, `Recognised from ${best.why}`);
    return { kind: 'other_out', label: CORRESPONDENCE_KIND_LABEL.other_out, eventType: letterOrEmail('out', i.isEmail), templateId: null, emailKind: null, cls: 'record', confidence: 0.8, why: 'A letter we sent (kind not recognised)' };
  }

  // Inbound
  if (/\bpart 36\b/i.test(text) || /offer (?:to settle|of £|of a replacement|you a replacement)|we (?:are prepared to|can) offer|pre-accident value of|in full and final settlement/i.test(text)) {
    return { kind: 'offer', label: CORRESPONDENCE_KIND_LABEL.offer, eventType: letterOrEmail('in', i.isEmail), templateId: null, emailKind: null, cls: 'owner_only', confidence: 0.85, why: 'It makes an offer — record it in Offers' };
  }
  if (/\bremittance\b|we have (?:now )?paid|payment (?:has been|was) made|bacs (?:payment|transfer)/i.test(text)) {
    return { kind: 'remittance', label: CORRESPONDENCE_KIND_LABEL.remittance, eventType: letterOrEmail('in', i.isEmail), templateId: null, emailKind: null, cls: 'owner_only', confidence: 0.85, why: 'A payment notice — you record money in the ledger' };
  }
  if (/final response/i.test(text)) {
    return { kind: 'final_response', label: CORRESPONDENCE_KIND_LABEL.final_response, eventType: letterOrEmail('in', i.isEmail), templateId: null, emailKind: null, cls: 'owner_only', confidence: 0.85, why: 'A final response to a complaint' };
  }
  if (i.docType === 'insurer_letter' || /\binsurance\b|\binsurers?\b|claims? (?:handler|department)/i.test(firstLines(text, 10))) {
    if (i.insurerRefNew) {
      return { kind: 'acknowledgement', label: CORRESPONDENCE_KIND_LABEL.acknowledgement, eventType: letterOrEmail('in', i.isEmail), alsoEvent: 'handling_ref_received', templateId: null, emailKind: null, cls: 'clock', confidence: 0.9, why: 'The first letter giving the insurer’s reference' };
    }
    return { kind: 'insurer_letter', label: CORRESPONDENCE_KIND_LABEL.insurer_letter, eventType: letterOrEmail('in', i.isEmail), templateId: null, emailKind: null, cls: 'record', confidence: 0.85, why: 'A letter from the insurer' };
  }
  if (i.isEmail) {
    return { kind: 'client_message', label: CORRESPONDENCE_KIND_LABEL.client_message, eventType: 'email_in', templateId: null, emailKind: null, cls: 'record', confidence: 0.85, why: 'An email to us' };
  }
  return { kind: 'other_in', label: CORRESPONDENCE_KIND_LABEL.other_in, eventType: 'letter_in', templateId: null, emailKind: null, cls: 'record', confidence: 0.8, why: 'A letter we received' };
}

/** An owner-picked kind (override) → its result. */
export function kindResultFor(kind: CorrespondenceKind, direction: 'out' | 'in', isEmail: boolean, hasPaymentPack: boolean): KindResult {
  const row = OUT_ROWS.find((r) => r.kind === kind);
  if (row && direction === 'out') return make(row, { direction, docType: null, text: '', subject: null, isEmail, templateTitles: [], hasPaymentPack, insurerRefNew: false }, 1, 'Set by you');
  const owner = kind === 'offer' || kind === 'remittance' || kind === 'final_response';
  const eventType: EventType = letterOrEmail(direction, isEmail);
  return {
    kind,
    label: CORRESPONDENCE_KIND_LABEL[kind],
    eventType,
    ...(kind === 'acknowledgement' ? { alsoEvent: 'handling_ref_received' as EventType } : {}),
    templateId: null,
    emailKind: null,
    cls: owner ? 'owner_only' : kind === 'acknowledgement' ? 'clock' : 'record',
    confidence: 1,
    why: 'Set by you',
  };
}
