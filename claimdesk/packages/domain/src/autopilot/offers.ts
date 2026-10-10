// owned by ap-autopilot
/**
 * Hire offers (docs/SUPREME-AUTOPILOT.md §D.2–§D.4), pure parts: the terms hash that binds an offer to its held
 * reservation, the offer email built by code (placeholders only for dates and car details), the reviewer's tier-a
 * offer checks, and the code-first reading of the client's reply.
 */
import { extractDates } from '../consistency/extract.js';
import { sha256Hex } from '../evidence/hash.js';
import { assertScriptGuard } from '../intake/script.js';
import { stableJson } from './plan.js';
import type { HireOfferTerms } from './types.js';

/** sha256 of the canonical terms (everything the client is told). */
export function hireOfferTermsSha256(terms: HireOfferTerms): string {
  return sha256Hex(stableJson(terms));
}

/**
 * The neutral intervention sentence (§D.2 point 5) — word for word, script-guard compliant. It is the same sentence the
 * printable twin `letter.hire_offer` carries.
 */
export const INTERVENTION_SENTENCE =
  "If the other driver's insurer offers you a car directly, please tell us straight away so we can record it and help you decide — you are free to consider their offer.";

/** Fixed, code-built sentences of the offer and booking emails (the commitment check knows them). */
export const OFFER_FIXED_SENTENCES: readonly string[] = [INTERVENTION_SENTENCE];

export const SIGN_OFF_TEXT = 'Claims Team, Courtesy Cars Group UK Ltd';

export interface HireOfferEmailInput {
  /** "Mrs Example" / the client's name as on file. */
  salutationName: string;
  delivery: boolean;
  /** The judge's introduction ({{fact:…}} placeholders only), or null for the default. */
  intro?: string | null;
}

/**
 * The offer email (§D.2): subject and body built by code from the bound terms. Car details and dates appear only as
 * `{{fact:…}}` placeholders, resolved from the Case Brief at drafting, so the reviewer can source every one. The words
 * the generic "touches" scan reads as money, liability or settlement are avoided ("accept", "free", "fault", prices);
 * a daily rate never appears (rates belong in the agreement).
 */
export function buildHireOfferEmail(input: HireOfferEmailInput): { subject: string; bodyText: string } {
  const intro = input.intro?.trim() || 'Thank you for letting us know about the accident on {{fact:claim.accident.date}}. We have found a replacement car for you.';
  const delivery = input.delivery
    ? 'Delivery: we can bring the car to you on {{fact:booking.delivery.window}}, at {{fact:booking.delivery.addressShort}}.'
    : 'Delivery: we will call you to arrange a time to bring the car to you.';
  const body = [
    `Dear ${input.salutationName},`,
    '',
    intro,
    '',
    'The car: {{fact:booking.unit.makeModel}}, registration {{fact:booking.unit.registration}}, {{fact:booking.unit.transmission}}, {{fact:booking.unit.seats}} seats. {{fact:offer.likeForLike}}',
    '',
    delivery,
    '',
    "How it works: the car is provided on a credit hire agreement, and the hire charges are claimed from the other driver's insurer. You sign the hire agreement and a condition report when the car is handed over. Before that we send you the pre-contract information and a cancellation form; you have 14 days to cancel, and we ask you to confirm that you want the hire to start straight away.",
    '',
    INTERVENTION_SENTENCE,
    '',
    'If you would like this car, simply reply YES to this email or call us. The car is held for you until {{fact:offer.expiresAt}}.',
    '',
    'Kind regards,',
    SIGN_OFF_TEXT,
  ].join('\n');
  return { subject: 'Your replacement car — {{fact:booking.unit.makeModel}}', bodyText: body };
}

/** The booking confirmation / delivery email (§D.5, kind booking_update). */
export function buildBookingUpdateEmail(input: { salutationName: string; kind: 'delivery' | 'collection' | 'reminder' }): { subject: string; bodyText: string } {
  if (input.kind === 'collection') {
    return {
      subject: 'Collection of your replacement car',
      bodyText: [
        `Dear ${input.salutationName},`,
        '',
        'Your own car is ready, so the replacement car {{fact:booking.unit.registration}} is due back with us. We have booked the collection for {{fact:booking.collection.window}}.',
        '',
        'Please remove your belongings and have the keys ready. If the time does not suit you, reply to this email and we will rearrange it.',
        '',
        'Kind regards,',
        SIGN_OFF_TEXT,
      ].join('\n'),
    };
  }
  if (input.kind === 'reminder') {
    return {
      subject: 'Your replacement car is still held for you',
      bodyText: [
        `Dear ${input.salutationName},`,
        '',
        'We are still holding the replacement car {{fact:booking.unit.makeModel}} ({{fact:booking.unit.registration}}) for you until {{fact:offer.expiresAt}}.',
        '',
        'If you would like it, simply reply YES to this email or call us.',
        '',
        'Kind regards,',
        SIGN_OFF_TEXT,
      ].join('\n'),
    };
  }
  return {
    subject: 'Your replacement car is booked',
    bodyText: [
      `Dear ${input.salutationName},`,
      '',
      'Thank you for letting us know. Your replacement car {{fact:booking.unit.makeModel}} ({{fact:booking.unit.registration}}) is booked for you, agreement {{fact:booking.agreementNumber}}.',
      '',
      'Delivery: {{fact:booking.delivery.window}}, at {{fact:booking.delivery.addressShort}}.',
      '',
      'Before the delivery we email you the hire agreement, the pre-contract information and the cancellation form to read. Please have your driving licence ready at the handover. If the time does not suit you, reply to this email and we will rearrange it.',
      '',
      'Kind regards,',
      SIGN_OFF_TEXT,
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Reviewer tier-a offer checks (§D.2)
// ---------------------------------------------------------------------------

export interface OfferCheckIssue {
  code: 'HIRE_OFFER_FREE_WORDING' | 'HIRE_OFFER_INTERVENTION_GUARD' | 'HIRE_OFFER_TERMS_MISMATCH' | 'HIRE_OFFER_RATE_STATED';
  severity: 'block' | 'warn';
  message: string;
  excerpt: string;
}

const FREE_RE = /\bfree of charge\b|\bfor free\b|\bfree (?:hire|car|courtesy car|replacement|vehicle|of cost)\b|\bcompletely free\b|\bat no cost\b|\bno cost to you\b|\b(?:won['’]t|will not|does not|doesn['’]t) cost you\b|\bat no (?:cost|charge)\b|\bnothing (?:for you )?to pay\b|\bcosts? you nothing\b/i;
const RATE_RE = /£\s?\d[\d,]*(?:\.\d{2})?\s*(?:per|a|\/)\s*day\b|\bdaily rate\b|\bper day\b/i;
/** UK-style registrations (current, prefix and suffix formats). */
const REG_RE = /\b([A-Z]{2}\d{2}\s?[A-Z]{3}|[A-Z]\d{1,3}\s?[A-Z]{3}|[A-Z]{3}\s?\d{1,3}[A-Z])\b/g;
const norm = (s: string): string => s.toUpperCase().replace(/\s+/g, '');

/** The tier-a checks for an outgoing hire offer (kind `hire_offer`) against its bound terms. */
export function hireOfferChecks(text: string, terms: HireOfferTerms | null, ctx: { allowedDates?: readonly string[]; clientRegistration?: string | null } = {}): OfferCheckIssue[] {
  const out: OfferCheckIssue[] = [];
  const free = FREE_RE.exec(text);
  if (free) out.push({ code: 'HIRE_OFFER_FREE_WORDING', severity: 'block', message: 'A credit hire car is not free: the charges are claimed from the other side and the client signs a credit agreement. Remove the wording.', excerpt: free[0] });
  const guard = assertScriptGuard(text);
  for (const v of guard.violations) out.push({ code: 'HIRE_OFFER_INTERVENTION_GUARD', severity: 'block', message: "Never tell the client to ignore or decline an insurer's offer (intervention script guard).", excerpt: v.excerpt });
  const rate = RATE_RE.exec(text);
  if (rate) out.push({ code: 'HIRE_OFFER_RATE_STATED', severity: 'warn', message: 'Daily rates belong in the hire agreement, not in the offer.', excerpt: rate[0] });
  if (terms) {
    const allowedRegs = new Set([norm(terms.registration), ...(ctx.clientRegistration ? [norm(ctx.clientRegistration)] : [])]);
    for (const m of text.toUpperCase().matchAll(REG_RE)) {
      if (!allowedRegs.has(norm(m[1]!))) out.push({ code: 'HIRE_OFFER_TERMS_MISMATCH', severity: 'block', message: `The registration ${m[1]} is not the car held for this offer (${terms.registration}).`, excerpt: m[1]! });
    }
    if (!text.toUpperCase().replace(/\s+/g, '').includes(norm(terms.registration))) {
      out.push({ code: 'HIRE_OFFER_TERMS_MISMATCH', severity: 'block', message: `The offer must name the car held for the client (${terms.registration}).`, excerpt: terms.registration });
    }
    const allowed = new Set([terms.startAt, terms.expiresAt, terms.delivery?.windowStart, terms.delivery?.windowEnd, ...(ctx.allowedDates ?? [])].filter((x): x is string => Boolean(x)).map((d) => londonDay(d)));
    for (const d of extractDates(text)) {
      if (!allowed.has(d.iso)) out.push({ code: 'HIRE_OFFER_TERMS_MISMATCH', severity: 'block', message: `The date ${d.raw} is not one of the offer's dates (start, delivery, hold expiry).`, excerpt: d.raw });
    }
  }
  return out;
}

const LONDON = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
/** YYYY-MM-DD of an instant in Europe/London (dates pass through). */
export function londonDay(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? LONDON.format(new Date(t)) : iso.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Reading the client's reply (§D.4) — code first
// ---------------------------------------------------------------------------

/** The first line of the reply that is the client's own words (quoted text and "On … wrote:" headers skipped). */
export function firstReplyLine(text: string): string | null {
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('>')) continue;
    if (/^on .{3,200} wrote:?$/i.test(line) || /^-{2,}\s*original message/i.test(line) || /^from:\s/i.test(line)) return null;
    return line;
  }
  return null;
}

const YES_RE = /^\s*(yes please|yes thanks|yes|i accept|accepted|accept|okay|ok|that'?s fine|go ahead|perfect)\b/i;
const NO_RE = /^\s*(no thanks|no|decline|not needed|don'?t need)\b/i;

/** Clear yes / no on the first own line → decision with confidence 0.95; anything else → null (the model reads it). */
export function parseHireReplyCode(text: string): { decision: 'accept' | 'decline'; confidence: number; line: string } | null {
  const line = firstReplyLine(text);
  if (!line) return null;
  if (NO_RE.test(line)) return { decision: 'decline', confidence: 0.95, line };
  if (YES_RE.test(line)) return { decision: 'accept', confidence: 0.95, line };
  return null;
}
