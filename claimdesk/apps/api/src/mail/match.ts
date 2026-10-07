// owned by mail
/**
 * Matching an email to a claim (docs/SUPREME-DESIGN.md §F.4) — deterministic; the model never decides this.
 *
 * | Signal                                                                 | Score |
 * | Our reference CCG-YYYY-NNNNN in subject, body or attachment name       | +100  |
 * | In-Reply-To / References hits an outbox.smtp_message_id or a matched message | +90 |
 * | Insurer reference = claims.at_fault_insurer_ref (normalised)           | +80 (+10 when the sender domain is that insurer's) |
 * | UK VRM equals a client / third-party registration on the claim          | +50  |
 * | Claimant full name and accident date                                    | +40  |
 * | Sender address equals a party email on the claim                        | +30  |
 * | Surname alone                                                           | +10 (never decisive) |
 *
 * Auto-link at ≥ 90 and ≥ 30 ahead of the runner-up; 50–89 (or a tie at the top) → Needs-you `which_claim` with the
 * top three; < 50 → unmatched.
 */
import type { Claim, InsurerDirectoryEntry } from '@ccguk/domain';
import { normaliseRegistration, type MailMatchSignal } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { londonDay } from '../agent/core.js';
import { directoryDomains } from './parse.js';

export const MATCH_SCORES = {
  ourRef: 100,
  thread: 90,
  insurerRef: 80,
  insurerDomain: 10,
  vrm: 50,
  nameAndDate: 40,
  senderParty: 30,
  surname: 10,
} as const;

export const AUTO_LINK_MIN = 90;
export const AUTO_LINK_LEAD = 30;
export const ASK_MIN = 50;

export const OUR_REF_RE = /CCG-\d{4}-\d{5}/gi;

/** Insurer reference normaliser (§F.4): upper case, whitespace, slashes and hyphens removed. */
export function normaliseInsurerRef(ref: string): string {
  return ref.toUpperCase().replace(/[\s/-]/g, '');
}

/**
 * UK registration candidates in free text, normalised (no spaces): current (AB12 CDE), prefix (A123 BCD), suffix
 * (ABC 123D) and dateless (1234 AB / AB 1234 / A 1 / 1 A) formats. Equality with a registration on the claim is what
 * scores, so the permissive dateless patterns cannot match on their own.
 */
export function extractVrms(text: string): string[] {
  const t = ` ${text.toUpperCase()} `;
  const patterns = [
    /(?<![A-Z0-9])[A-Z]{2}\d{2}\s?[A-Z]{3}(?![A-Z0-9])/g, // current 2001-
    /(?<![A-Z0-9])[A-HJ-PR-Y]\d{1,3}\s?[A-Z]{3}(?![A-Z0-9])/g, // prefix 1983-2001
    /(?<![A-Z0-9])[A-Z]{3}\s?\d{1,3}[A-HJ-NPR-TV-Y](?![A-Z0-9])/g, // suffix 1963-1983
    /(?<![A-Z0-9])\d{1,4}\s?[A-Z]{1,3}(?![A-Z0-9])/g, // dateless, number first
    /(?<![A-Z0-9])[A-Z]{1,3}\s?\d{1,4}(?![A-Z0-9])/g, // dateless, letters first
  ];
  const out = new Set<string>();
  for (const re of patterns) for (const m of t.matchAll(re)) out.add(normaliseRegistration(m[0]));
  return [...out].filter((v) => v.length >= 2);
}

export interface MatchInput {
  subject?: string;
  text: string;
  attachmentNames: string[];
  fromAddr?: string;
  inReplyTo?: string;
  references: string[];
}

export interface MatchCandidate {
  claimId: string;
  reference: string;
  score: number;
  signals: MailMatchSignal[];
}

export interface MatchResult {
  decision: 'auto' | 'which_claim' | 'unmatched';
  claimId?: string;
  score: number;
  candidates: MatchCandidate[];
  /** "matched because …" — the winning claim's signals in plain words. */
  because: string[];
}

const pad = (n: number): string => String(n).padStart(2, '0');
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** The ways an accident date (London calendar day) is written in correspondence. */
export function dateForms(isoDay: string): string[] {
  const [y, m, d] = isoDay.split('-').map(Number) as [number, number, number];
  const mon = MONTHS[m - 1]!;
  return [
    `${pad(d)}/${pad(m)}/${y}`,
    `${d}/${m}/${y}`,
    `${pad(d)}/${pad(m)}/${String(y).slice(2)}`,
    `${pad(d)}.${pad(m)}.${y}`,
    `${pad(d)}-${pad(m)}-${y}`,
    isoDay,
    `${d} ${mon} ${y}`,
    `${d} ${mon.slice(0, 3)} ${y}`,
    `${d}${['st', 'nd', 'rd'][((d + 90) % 100 - 10) % 10 - 1] ?? 'th'} ${mon} ${y}`,
  ];
}

const collapse = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ');
const msgIdNorm = (s: string): string => s.trim().replace(/^<+/, '').replace(/>+$/, '').toLowerCase();

interface ClaimFacts {
  claim: Claim;
  partyEmails: Set<string>;
  claimantName?: string;
  surname?: string;
  registrations: string[];
  insurerDomains: string[];
  accidentDay?: string;
}

function insurerFor(directory: readonly InsurerDirectoryEntry[], name: string | undefined): InsurerDirectoryEntry | undefined {
  if (!name) return undefined;
  const n = name.trim().toLowerCase();
  return directory.find((e) => e.name.trim().toLowerCase() === n || e.brands.some((b) => b.trim().toLowerCase() === n));
}

function factsFor(ctx: AppContext, claim: Claim, directory: readonly InsurerDirectoryEntry[]): ClaimFacts {
  const partyIds = [claim.claimantId, claim.driverId, ...claim.thirdPartyIds, claim.atFaultInsurerId, claim.clientInsurerId].filter((x): x is string => Boolean(x));
  const parties = ctx.repos.getParties(ctx.db, partyIds);
  const claimant = parties.find((p) => p.id === claim.claimantId);
  const insurerParty = parties.find((p) => p.id === claim.atFaultInsurerId);
  const vehicles = [claim.clientVehicleId, claim.thirdPartyVehicleId].filter((x): x is string => Boolean(x)).map((id) => ctx.repos.getVehicle(ctx.db, id));
  const dir = insurerFor(directory, insurerParty?.name);
  const domains = new Set<string>(dir ? directoryDomains(dir) : []);
  const insurerEmailDomain = insurerParty?.email?.split('@')[1]?.toLowerCase();
  if (insurerEmailDomain) domains.add(insurerEmailDomain);
  const name = claimant?.kind === 'individual' ? claimant.name.trim() : undefined;
  const surname = name && name.split(/\s+/).length > 1 ? name.split(/\s+/).pop() : undefined;
  return {
    claim,
    partyEmails: new Set(parties.map((p) => p.email?.trim().toLowerCase()).filter((e): e is string => Boolean(e))),
    ...(name ? { claimantName: name } : {}),
    ...(surname && surname.length >= 3 ? { surname } : {}),
    registrations: vehicles.map((v) => (v?.registration ? normaliseRegistration(v.registration) : '')).filter(Boolean),
    insurerDomains: [...domains],
    ...(claim.accident?.occurredAt ? { accidentDay: londonDay(claim.accident.occurredAt) } : {}),
  };
}

/** Claims a thread header points at: our sent emails (outbox.smtp_message_id) and messages already filed on a claim. */
function threadClaims(ctx: AppContext, input: MatchInput): Map<string, string> {
  const out = new Map<string, string>();
  const ids = [...new Set([input.inReplyTo, ...input.references].filter((x): x is string => Boolean(x)).map(msgIdNorm))];
  for (const id of ids) {
    const o = ctx.repos.findOutboxBySmtpMessageId(ctx.db, id);
    if (o?.claimId) out.set(o.claimId, `replies to our email ${o.subject ? `"${o.subject}"` : id}`);
    for (const m of ctx.repos.findMailMessagesByMessageId(ctx.db, id)) {
      if (m.claimId && (m.status === 'matched' || m.status === 'processed')) out.set(m.claimId, `same thread as a message filed on this claim`);
    }
  }
  return out;
}

/** Score every claim and decide (§F.4). Pure reads; the caller records the mail_matches row. */
export function matchMessage(ctx: AppContext, input: MatchInput): MatchResult {
  const directory = ctx.kb.directory();
  const subject = input.subject ?? '';
  const haystack = `${subject}\n${input.text}\n${input.attachmentNames.join('\n')}`;
  const lower = collapse(haystack);
  const refHay = normaliseInsurerRef(haystack);
  const ourRefs = new Set([...haystack.matchAll(OUR_REF_RE)].map((m) => m[0].toUpperCase()));
  const vrms = new Set(extractVrms(haystack));
  const sender = input.fromAddr?.trim().toLowerCase();
  const senderDomain = sender?.split('@')[1];
  const thread = threadClaims(ctx, input);

  const claims = ctx.repos.listClaims(ctx.db, { limit: 100_000 });
  const candidates: MatchCandidate[] = [];
  for (const claim of claims) {
    const signals: MailMatchSignal[] = [];
    if (ourRefs.has(claim.reference.toUpperCase())) signals.push({ code: 'our_ref', score: MATCH_SCORES.ourRef, detail: `our reference ${claim.reference} is quoted` });
    const th = thread.get(claim.id);
    if (th) signals.push({ code: 'thread', score: MATCH_SCORES.thread, detail: th });
    // Cheap pre-filter: the remaining signals need the claim's parties and vehicles.
    const ref = claim.atFaultInsurerRef ? normaliseInsurerRef(claim.atFaultInsurerRef) : '';
    const f = factsFor(ctx, claim, directory);
    if (ref.length >= 4 && refHay.includes(ref)) {
      signals.push({ code: 'insurer_ref', score: MATCH_SCORES.insurerRef, detail: `the insurer's reference ${claim.atFaultInsurerRef} is quoted` });
      if (senderDomain && f.insurerDomains.includes(senderDomain)) signals.push({ code: 'insurer_domain', score: MATCH_SCORES.insurerDomain, detail: `sent from the insurer's domain ${senderDomain}` });
    }
    const reg = f.registrations.find((r) => vrms.has(r));
    if (reg) signals.push({ code: 'vrm', score: MATCH_SCORES.vrm, detail: `registration ${reg} is on the claim` });
    if (f.claimantName && f.accidentDay && lower.includes(collapse(f.claimantName)) && dateForms(f.accidentDay).some((d) => lower.includes(d))) {
      signals.push({ code: 'name_date', score: MATCH_SCORES.nameAndDate, detail: `client ${f.claimantName} and the accident date ${f.accidentDay}` });
    }
    if (sender && f.partyEmails.has(sender)) signals.push({ code: 'sender_party', score: MATCH_SCORES.senderParty, detail: `the sender ${sender} is a party on the claim` });
    if (f.surname && !signals.some((s) => s.code === 'name_date') && new RegExp(`\\b${f.surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(haystack)) {
      signals.push({ code: 'surname', score: MATCH_SCORES.surname, detail: `the client's surname ${f.surname} appears` });
    }
    const score = signals.reduce((s, x) => s + x.score, 0);
    if (score > 0) candidates.push({ claimId: claim.id, reference: claim.reference, score, signals });
  }
  candidates.sort((a, b) => b.score - a.score || a.reference.localeCompare(b.reference));
  return decideMatch(candidates);
}

/** The threshold rule alone (exported for tests). */
export function decideMatch(candidates: MatchCandidate[]): MatchResult {
  const top = candidates[0];
  const second = candidates[1];
  if (!top) return { decision: 'unmatched', score: 0, candidates: [], because: [] };
  const because = top.signals.map((s) => s.detail);
  if (top.score >= AUTO_LINK_MIN && top.score - (second?.score ?? 0) >= AUTO_LINK_LEAD) return { decision: 'auto', claimId: top.claimId, score: top.score, candidates: candidates.slice(0, 3), because };
  if (top.score >= ASK_MIN) return { decision: 'which_claim', score: top.score, candidates: candidates.slice(0, 3), because };
  return { decision: 'unmatched', score: top.score, candidates: candidates.slice(0, 3), because };
}
