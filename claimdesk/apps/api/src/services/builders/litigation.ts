/**
 * Template data builders for the complaint and litigation stage (ARCHITECTURE convention 4, "one source of truth"):
 *
 *   letter.complaint_disp           DISP 1 complaint: ICOBS dates from the clocks, outstanding heads from the ledger
 *   letter.dsar                     UK GDPR Art 15 request: data subject, offer/call dates, one-month deadline
 *   letter.letter_before_claim      PD-PAC letter of claim signed by the claimant (litigant in person)
 *   letter.part36_offer             claimant's Part 36 offer signed by the claimant
 *   letter.particularisation_demand demand to particularise an allegation, dated from the logged letter
 *   bundle.litigation_index         hearing bundle index from the documents and evidence on the claim
 *   statement.witness               CPR 32 witness statement skeleton (header from the claim)
 *
 * Every amount and date comes from the bundle (ledger, events, offers, clocks, documents, evidence). Judgements only
 * the handler (or the claimant, or the witness) can make are never invented here: they are left out of the derived
 * object, so the registry's TEMPLATE_DATA_MISSING error names them and the handler supplies them as `data` extras.
 *   complaint_disp            complaintSummary (againstOwnInsurer may be set true only for the client's own insurer)
 *   letter_before_claim       liabilityBasis
 *   part36_offer              offerPence (relevantPeriodDays may be raised above 21)
 *   particularisation_demand  allegationQuoted, allegationKind
 *   statement.witness         paragraphs, witness.occupation (+ witness.capacity for a non-claimant witness)
 * Handler-supplied dates the claim does not hold (dsar authorityDate, witness accountGivenAt) are accepted only when
 * no record exists, and never after today. Handler free text must be text (400 INVALID_FIELD naming the field, never
 * a 500 from the template). A complaint addressed to the client's own insurer is the policyholder's complaint
 * (againstOwnInsurer true; a contradicting false is refused). A witness must be a party on this claim; a quoted
 * allegation must come from a communication the other side sent; a DSAR is made only for an individual.
 *
 * Perimeter (perimeter.md): litigation documents are drafts for the claimant (litigant in person) or an instructed
 * solicitor to sign; the Financial Ombudsman is never named to the at-fault insurer (DISP 2.7), so againstOwnInsurer is
 * false unless the complaint is addressed to the client's own insurer; Part 36 offers are kept out of a hearing bundle
 * (CPR 36.16) unless the handler asks for them (a costs bundle).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  addCalendarDays,
  addCalendarMonths,
  addWeeks,
  calendarDaysBetween,
  formatGBP,
  interest,
  isWorkingDay,
  londonDate,
  nextWorkingDay,
  part36,
  scheduleHeadLabels,
  scheduleOfLoss,
  trackAllocation,
  type ClaimBundle,
  type ClaimEvent,
  type Evidence,
  type EvidenceKind,
  type GeneratedDocument,
  type HeadOfLoss,
  type ISODate,
  type ISODateTime,
  type InterventionOffer,
  type Party,
  type Pence,
  type Track,
} from '@ccguk/domain';
import { brand, formatDateLong, htmlToText } from '@ccguk/documents';
import type { AppContext } from '../../context.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import { absoluteEvidencePath, assertInsideStore } from '../evidence.js';
import {
  addressLines,
  deadline,
  headSummaries,
  hireBlock,
  latestEvent,
  latestHire,
  ncafBlock,
  packBlock,
  recipientBlock,
  recoveryBlock,
  runningClockDue,
  storageBlock,
  type BuildInput,
  type Builder,
  type HeadSummary,
  type RecipientBlockData,
} from '../documentData.js';

type DateLike = ISODate | ISODateTime;

const FINAL_STATUSES = new Set<GeneratedDocument['status']>(['approved', 'sent', 'signed']);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ms = (iso: DateLike): number => Date.parse(iso);
const day = (iso: DateLike): ISODate => londonDate(iso);
const todayOf = (b: BuildInput): ISODate => londonDate(b.now);
const long = (iso: DateLike): string => formatDateLong(iso);

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The handler's extra at a dotted path (read-only). */
function extraAt(b: BuildInput, dotted: string): unknown {
  let cur: unknown = b.extra;
  for (const k of dotted.split('.')) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/**
 * Free text only the handler can write (complaint summary, liability basis, quoted allegation…). When supplied it must
 * be a string: a number or object would reach the template's text helpers and fail as a 500, or print "[object Object]".
 * Absent or blank is left to the registry, which names the field in TEMPLATE_DATA_MISSING.
 */
function assertHandlerText(b: BuildInput, ...paths: string[]): void {
  for (const p of paths) {
    const v = extraAt(b, p);
    if (v !== undefined && v !== null && typeof v !== 'string') {
      throw badRequest(`data.${p} must be text (a string), in the handler’s own words`, { code: 'INVALID_FIELD', field: p });
    }
  }
}

/**
 * The proposed defendant: the third-party driver, else a third party who is not only a witness. A witness is linked to
 * the claim through thirdPartyIds too (File 4), so the first third party is not necessarily the person to sue.
 */
function proposedDefendant(bundle: ClaimBundle): Party | undefined {
  const tps = bundle.thirdParties;
  const notWitness = tps.filter((p) => !p.roles.includes('witness'));
  return tps.find((p) => p.roles.includes('third_party_driver')) ?? notWitness.find((p) => p.roles.includes('third_party')) ?? notWitness[0];
}

/**
 * A date the handler supplies because the claim holds no record of it (signed authority, account taken). It must be an
 * ISO date and may not be after today — a letter cannot rely on something that has not happened.
 */
function checkHandlerDate(b: BuildInput, field: string): void {
  const v = b.extra?.[field];
  if (v === undefined) return;
  let d: ISODate | undefined;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T.+)?$/.test(v) && !Number.isNaN(Date.parse(v))) {
    try {
      d = londonDate(v);
    } catch {
      d = undefined;
    }
  }
  if (!d) throw badRequest(`data.${field} must be an ISO date (YYYY-MM-DD)`, { code: 'INVALID_DATE', field });
  if (d > todayOf(b)) throw badRequest(`data.${field} (${d}) is after today (${todayOf(b)}): a document cannot rely on a date that has not happened`, { code: 'DATE_IN_FUTURE', field });
}

/** "Jane Doe" → "J. Doe"; titles are dropped (PD 32 para 17.2 top-right block). */
function shortNameOf(name: string): string | undefined {
  const tokens = name.replace(/\b(Mr|Mrs|Ms|Miss|Mx|Dr)\.?\s+/gi, '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return undefined;
  return `${tokens[0]!.charAt(0).toUpperCase()}. ${tokens[tokens.length - 1]}`;
}

/** Proceedings as logged on the chronology (event `proceedings_issued`, data: court, claimNumber, defendant…). */
function proceedingsOf(bundle: ClaimBundle) {
  const ev = latestEvent(bundle, 'proceedings_issued');
  if (!ev) return undefined;
  const d = ev.data ?? {};
  return { issuedAt: ev.at, court: text(d.court) ?? text(d.courtName), claimNumber: text(d.claimNumber), defendant: text(d.defendant), secondDefendant: text(d.secondDefendant) };
}

/** The proposed defendant (the at-fault driver) care of the insurer — the addressee of the claimant's own letters. */
function defendantRecipient(b: BuildInput, base: Record<string, unknown>): RecipientBlockData | undefined {
  const fallback = base.recipient as RecipientBlockData | undefined;
  if (b.recipientPartyId) return fallback;
  const tp = proposedDefendant(b.bundle);
  const ins = b.bundle.atFaultInsurer;
  if (!tp) return fallback;
  if (!ins) return recipientBlock(tp);
  return { partyId: tp.id, name: tp.name, addressLines: [`c/o ${ins.name}`, 'Third Party Claims Team', ...addressLines(ins)], email: ins.email };
}

function withAttention(recipient: unknown, attention: string): RecipientBlockData | undefined {
  const r = recipient as RecipientBlockData | undefined;
  return r ? { ...r, attention } : undefined;
}

function claimantBlock(c: Party) {
  return { name: c.name, addressLines: addressLines(c), email: c.email };
}

// ---------------------------------------------------------------------------
// Loss position (letter of claim, Part 36): domain/quantum schedule from the ledger + s.69 interest
// ---------------------------------------------------------------------------

interface LossLine {
  description: string;
  detail?: string;
  netPence: Pence;
  source?: string;
}

interface LossPosition {
  schedule: LossLine[];
  scheduleTotalPence: Pence;
  interest: { rate: number; fromDate: ISODate; toDate: ISODate; accruedPence: Pence; dailyPence: Pence };
  totalWithInterestPence: Pence;
  track: { expected: Track; note: string };
}

const CLAIMANT_HEAD_DESCRIPTION: Partial<Record<HeadOfLoss, string>> = {
  hire: 'Hire of a replacement vehicle',
  recovery: 'Recovery of my vehicle',
  storage: 'Storage of my vehicle',
  engineer_fee: 'Independent engineer’s inspection and report',
  pav: 'Pre-accident value of my vehicle (total loss)',
  repair: 'Repair of my vehicle',
  salvage: 'Less: salvage value retained',
  excess: 'Policy excess',
};

const NON_LOSS_HEADS = new Set<HeadOfLoss>(['interest', 'court_fee', 'fixed_costs']);

const TRACK_NOTE: Record<Track, string> = {
  small_claims: 'On that track the costs recoverable from the losing party are limited by CPR 27.14, and expert evidence is used only with the court’s permission (CPR 27.5).',
  fast: 'On that track fixed recoverable costs apply (CPR Part 45).',
  intermediate: 'On that track fixed recoverable costs apply (CPR Part 45).',
  multi: 'The court will give directions for the conduct of the claim.',
};

function lossPosition(b: BuildInput): LossPosition {
  const { bundle, ctx, now } = b;
  const today = todayOf(b);
  const sched = scheduleOfLoss(bundle, now);
  // VAT is part of the claimant's loss unless the claimant is VAT-registered and can reclaim it.
  const vatIncluded = bundle.claimant.vatRegistered !== true;
  const summaries = headSummaries(bundle);
  const hire = hireBlock(ctx, bundle, now);
  const storage = storageBlock(bundle, now);
  const recovery = recoveryBlock(bundle);
  const report = bundle.report;
  const lines: LossLine[] = [];

  for (const l of sched.lines) {
    if (NON_LOSS_HEADS.has(l.head)) continue;
    const vat = vatIncluded ? l.vatPence : 0;
    const amount = (vatIncluded ? l.claimedPence : l.netPence) - (l.writtenOffPence ?? 0);
    if (amount === 0) continue;
    const invoiceRef = summaries.find((s) => s.head === l.head)?.invoiceReference;
    let detail: string | undefined;
    let source: string | undefined = invoiceRef ? `Invoice ${invoiceRef}` : undefined;
    if (l.head === 'hire' && hire) {
      detail = hire.open
        ? `From ${long(hire.startAt)}, still running: ${plural(hire.days, 'day')} at ${formatGBP(hire.dailyRatePence)} per day so far`
        : `From ${long(hire.startAt)} to ${long(hire.endAt)}, ${plural(hire.days, 'day')} at ${formatGBP(hire.dailyRatePence)} per day`;
      source = `Hire agreement ${hire.agreementNumber}${invoiceRef ? `; invoice ${invoiceRef}` : ''}`;
    } else if (l.head === 'storage' && storage) {
      detail = storage.open
        ? `From ${long(storage.startAt)}, still running: ${plural(storage.days, 'day')} at ${formatGBP(storage.dailyRatePence)} per day so far`
        : `From ${long(storage.startAt)} to ${long(storage.endAt)}, ${plural(storage.days, 'day')} at ${formatGBP(storage.dailyRatePence)} per day`;
      source ??= 'Storage account';
    } else if (l.head === 'recovery' && recovery) {
      detail = `${recovery.fromLocation} to ${recovery.toLocation}: call-out, ${recovery.loadedMiles} loaded miles, administration`;
      source ??= 'Recovery account';
    } else if (l.head === 'engineer_fee') {
      source ??= report?.issuedAt ? `Fee note; report dated ${long(report.issuedAt)}` : 'Engineer’s fee note';
    } else if (l.head === 'pav') {
      source = report?.issuedAt ? `Engineer’s report dated ${long(report.issuedAt)}` : bundle.pav ? 'Pre-accident value assessment' : source;
    } else if (l.sourceDocumentId) {
      source ??= bundle.documents.find((d) => d.id === l.sourceDocumentId)?.title;
    }
    if (vat > 0) detail = `${detail ? `${detail}: ` : ''}${formatGBP(l.netPence)} plus VAT ${formatGBP(vat)}`;
    if (l.writtenOffPence) detail = `${detail ? `${detail}; ` : ''}less ${formatGBP(l.writtenOffPence)} written off`;
    source ??= `${scheduleHeadLabels[l.head]} account`;
    lines.push({ description: CLAIMANT_HEAD_DESCRIPTION[l.head] ?? scheduleHeadLabels[l.head], detail, netPence: amount, source });
  }

  // Payments on account, from the ledger (gross), each against its own date and remittance reference.
  const superseded = new Set(bundle.ledger.map((e) => e.supersedesId).filter((x): x is string => Boolean(x)));
  const paid = bundle.ledger
    .filter((e) => (e.kind === 'paid' || e.kind === 'interim_paid') && !superseded.has(e.id) && e.date <= today)
    .sort((x, y) => x.date.localeCompare(y.date));
  for (const p of paid) {
    const payer = p.counterpartyId && p.counterpartyId !== bundle.atFaultInsurer?.id ? b.ctx.repos.getParty(b.ctx.db, p.counterpartyId)?.name : bundle.atFaultInsurer?.name;
    lines.push({
      description: `Less: paid on account by ${payer ?? 'your insurer'}`,
      detail: long(p.date),
      netPence: -(p.amountPence + (p.vatPence ?? 0)),
      source: p.reference ? `Remittance ${p.reference}` : undefined,
    });
  }

  const scheduleTotalPence = lines.reduce((t, l) => t + l.netPence, 0);
  if (scheduleTotalPence <= 0) throw conflict('NOTHING_OUTSTANDING', 'The ledger shows nothing outstanding on this claim: there is no sum to claim or offer to accept');

  // s.69 County Courts Act 1984 interest (domain/quantum), from the date the claim was presented with its documents.
  const pack = packBlock(bundle);
  const ncaf = ncafBlock(bundle);
  const from = pack?.sentAt ?? ncaf?.sentAt ?? day(bundle.claim.openedAt);
  const i = interest({ principalPence: scheduleTotalPence, from, to: today, basis: 'cca_s69' });
  const t = trackAllocation(scheduleTotalPence);
  return {
    schedule: lines,
    scheduleTotalPence,
    interest: { rate: i.annualRatePct / 100, fromDate: day(from), toDate: today, accruedPence: i.interestPence, dailyPence: i.dailyPence },
    totalWithInterestPence: scheduleTotalPence + i.interestPence,
    track: { expected: t.track, note: TRACK_NOTE[t.track] },
  };
}

/** Documents and records on the claim that the letter of claim can enclose — nothing that does not exist. */
function letterOfClaimEnclosures(bundle: ClaimBundle): string[] {
  const out: string[] = [];
  const final = bundle.documents.filter((d) => FINAL_STATUSES.has(d.status));
  const has = (prefix: string) => final.some((d) => d.templateId.startsWith(prefix));
  const h = latestHire(bundle);
  if (h) out.push(`Credit hire agreement ${h.agreementNumber}${h.signedAt ? ` dated ${long(h.signedAt)}` : ''}`);
  for (const d of final) {
    if (d.templateId === 'schedule.loss' || d.templateId.startsWith('invoice.') || d.templateId.startsWith('report.') || d.templateId === 'form.mitigation_questionnaire' || d.templateId === 'form.statement_of_need') out.push(d.title);
  }
  for (const s of headSummaries(bundle)) {
    if (s.invoiceReference && !final.some((d) => d.title.includes(s.invoiceReference!))) out.push(`${s.label} invoice ${s.invoiceReference}`);
  }
  if (bundle.report?.issuedAt && !has('report.engineer')) out.push(`Independent engineer’s report dated ${long(bundle.report.issuedAt)}`);
  if (bundle.pav && !has('report.pav')) out.push('Pre-accident value assessment with comparables');
  const photos = bundle.evidence.filter((e) => e.kind === 'photo').length;
  if (photos) out.push(`Photographs of the damage (${photos})`);
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Complaint helpers
// ---------------------------------------------------------------------------

function complaintHeadLabel(h: HeadSummary, b: BuildInput): string {
  if (h.head === 'hire') {
    const hire = hireBlock(b.ctx, b.bundle, b.now);
    if (hire) return `Hire, ${plural(hire.days, 'day')} at ${formatGBP(hire.dailyRatePence)} per day`;
  }
  if (h.head === 'storage') {
    const s = storageBlock(b.bundle, b.now);
    if (s) return `Storage, ${plural(s.days, 'day')} at ${formatGBP(s.dailyRatePence)} per day`;
  }
  if (h.head === 'recovery') {
    const r = recoveryBlock(b.bundle);
    if (r) return `Recovery: call-out, ${r.loadedMiles} loaded miles, administration`;
  }
  return h.label;
}

/** When the claim was notified to the client's OWN insurer: an outbound event addressed to that party. */
function ownInsurerNotification(bundle: ClaimBundle): ClaimEvent | undefined {
  const id = bundle.claim.clientInsurerId;
  if (!id) return undefined;
  return [...bundle.events]
    .filter((e) => ['letter_out', 'email_out', 'call', 'fnol'].includes(e.type) && (e.data?.recipientPartyId === id || e.data?.partyId === id || e.data?.counterpartyId === id))
    .sort((x, y) => ms(x.at) - ms(y.at))[0];
}

// ---------------------------------------------------------------------------
// DSAR helpers
// ---------------------------------------------------------------------------

/**
 * The claimant's own authority to act / to make the request. Deliberately narrow: an insurer's "authority to repair",
 * a bodyshop's "repair authorisation" or a "local authority" letter is not the data subject's authority, and a false
 * match would let the letter state that a signed authority is enclosed when none exists (perimeter.md: no authority, no
 * letter).
 */
const AUTHORITY_RE =
  /\b(?:signed\s+authori(?:ty|[sz]ation)|letter\s+of\s+authority|form\s+of\s+authority|(?:client|claimant|customer|data\s+subject)(?:['’]s)?\s+authori(?:ty|[sz]ation)|authori(?:ty|[sz]ation)\s+(?:to|for)\s+(?:act|correspond|make|request|obtain|receive|release|disclose|subject\s+access|(?:the\s+)?dsar|data)|mandate)\b/i;
const NON_PAPER_KINDS = new Set<EvidenceKind>(['photo', 'video', 'audio', 'call_recording', 'cctv', 'dashcam']);

/** The claimant's signed authority: an evidence record or a signed document whose description says so (latest wins). */
function signedAuthorityDate(bundle: ClaimBundle, now: ISODateTime): ISODate | undefined {
  const candidates: string[] = [];
  for (const e of bundle.evidence) {
    if (NON_PAPER_KINDS.has(e.kind)) continue;
    if (AUTHORITY_RE.test(`${e.description ?? ''} ${e.filename}`)) candidates.push(e.capturedAt ?? e.uploadedAt);
  }
  for (const d of bundle.documents) {
    if (d.status === 'signed' && d.signature && AUTHORITY_RE.test(`${d.templateId.replace(/[._]/g, ' ')} ${d.title}`)) candidates.push(d.signature.signedAt);
  }
  const latest = candidates.filter((at) => ms(at) <= ms(now)).sort((x, y) => ms(y) - ms(x))[0];
  return latest ? day(latest) : undefined;
}

/** Dates on which the controller may hold recordings: every logged intervention offer and every call with it. */
function offerAndCallDates(bundle: ClaimBundle, now: ISODateTime): ISODate[] {
  const insurer = bundle.atFaultInsurer;
  const dates = new Set<ISODate>();
  for (const o of bundle.offers) if (ms(o.receivedAt) <= ms(now)) dates.add(day(o.receivedAt));
  for (const e of bundle.events) {
    if (ms(e.at) > ms(now)) continue;
    if (e.type === 'intervention_offer') dates.add(day(e.at));
    if (e.type === 'call') {
      const withInsurer =
        e.attributableTo === 'insurer' ||
        (insurer && (e.data?.counterpartyId === insurer.id || e.data?.partyId === insurer.id || e.summary.toLowerCase().includes(insurer.name.toLowerCase())));
      if (withInsurer) dates.add(day(e.at));
    }
  }
  return [...dates].sort();
}

function insurerReferences(bundle: ClaimBundle): string[] {
  const refs: string[] = [];
  if (bundle.claim.atFaultInsurerRef) refs.push(bundle.claim.atFaultInsurerRef);
  for (const e of bundle.events) {
    if (e.type !== 'handling_ref_received') continue;
    const r = text(e.data?.reference) ?? text(e.data?.handlingReference) ?? text(e.data?.ref);
    if (r) refs.push(r);
  }
  return [...new Set(refs)];
}

// ---------------------------------------------------------------------------
// Particularisation helpers
// ---------------------------------------------------------------------------

const ALLEGATION_KINDS = ['fraud', 'irregularity', 'offer_ignored', 'other'] as const;

const CHANNEL_WORDS: Record<InterventionOffer['channel'], string> = {
  phone: 'telephone',
  email: 'email',
  letter: 'letter',
  sms: 'text message',
  whatsapp: 'WhatsApp',
  portal: 'portal message',
  via_client: 'an approach to the claimant directly',
};

/** One sentence from the intervention register — what it holds, never more (checked by the consistency engine). */
function registerPosition(bundle: ClaimBundle): string {
  const offers = [...bundle.offers].sort((x, y) => ms(x.receivedAt) - ms(y.receivedAt));
  if (offers.length === 0) return 'Our intervention register holds no offer of a replacement vehicle from you, or from anyone on your behalf, at any time on this claim.';
  const parts = offers.map((o) => {
    const by = o.offerorName || bundle.atFaultInsurer?.name || 'your insurer';
    const cls = o.vehicleClassOffered ? ` (${o.vehicleClassOffered})` : '';
    const rate = o.dailyRatePence !== undefined ? ` at ${formatGBP(o.dailyRatePence)} per day${o.rateIncludesVat ? ' including VAT' : ''}` : '';
    const decision =
      o.clientDecision === 'declined'
        ? `; the claimant declined it${o.clientDecisionAt ? ` on ${long(o.clientDecisionAt)}` : ''}`
        : o.clientDecision === 'accepted'
          ? `; the claimant accepted it${o.clientDecisionAt ? ` on ${long(o.clientDecisionAt)}` : ''}`
          : '; the claimant’s decision on it is recorded as pending';
    const reply = o.replySentAt ? `, and our written reply was sent on ${long(o.replySentAt)}` : '';
    return `${by} by ${CHANNEL_WORDS[o.channel]} on ${long(o.receivedAt)}${cls}${rate}${decision}${reply}`;
  });
  return `Our intervention register records ${offers.length === 1 ? 'one offer' : `${offers.length} offers`} of a replacement vehicle: ${parts.join('; ')}.`;
}

/** The insurer's letter that made the allegation: selected by `allegationEventId`, else the latest inbound letter or email. */
function allegationEvent(b: BuildInput): ClaimEvent {
  const { bundle } = b;
  const id = text(b.extra?.allegationEventId);
  if (id) {
    const e = bundle.events.find((x) => x.id === id);
    if (!e) throw notFound('event', id);
    // The letter is answered as "your letter of <date>": it must be something the other side sent, already received.
    const ours = e.type === 'note' || e.data?.internal === true || e.attributableTo === 'ccguk' || e.attributableTo === 'client';
    if (ours || ms(e.at) > ms(b.now)) {
      throw badRequest(
        `Event ${id} (${e.type}, ${day(e.at)}) is not a communication received from the insurer${ours ? '' : ' yet'}: choose the logged letter, email or call in which the allegation was made`,
        { code: 'INVALID_FIELD', field: 'allegationEventId' },
      );
    }
    return e;
  }
  const inbound = [...bundle.events].filter((e) => (e.type === 'letter_in' || e.type === 'email_in') && ms(e.at) <= ms(b.now)).sort((x, y) => ms(y.at) - ms(x.at));
  const tagged = inbound.find((e) => e.data?.kind === 'allegation' || e.data?.allegation === true || typeof e.data?.allegationKind === 'string');
  const fromInsurer = inbound.find((e) => e.attributableTo === 'insurer' || e.attributableTo === undefined);
  const chosen = tagged ?? fromInsurer;
  if (!chosen) {
    throw conflict('NO_ALLEGATION_LETTER', 'Log the insurer’s letter or email that makes the allegation (event letter_in or email_in, data.reference / data.author) before drafting the demand — it is quoted by its date. Pass data.allegationEventId to choose a specific one.');
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Bundle helpers
// ---------------------------------------------------------------------------

type SectionKey = 'claim_form_particulars' | 'schedule_of_loss' | 'witness_statements' | 'hire_agreement_forms' | 'invoices' | 'engineer_report' | 'pav_report' | 'correspondence' | 'part_36' | 'other';

const SECTION_ORDER: SectionKey[] = ['claim_form_particulars', 'schedule_of_loss', 'witness_statements', 'hire_agreement_forms', 'invoices', 'engineer_report', 'pav_report', 'correspondence', 'part_36', 'other'];

/** Characters of body text an A4 letter page holds, for documents with no PDF yet (an estimate, re-run once approved). */
const CHARS_PER_PAGE = 3000;

interface BundleItem {
  key: SectionKey;
  description: string;
  at: DateLike;
  pages: number;
}

function sectionForTemplate(templateId: string): SectionKey | undefined {
  if (templateId.startsWith('bundle.')) return undefined;
  if (templateId === 'schedule.loss') return 'schedule_of_loss';
  if (templateId === 'statement.witness') return 'witness_statements';
  if (templateId.startsWith('agreement.') || templateId.startsWith('form.') || templateId.startsWith('certificate.')) return 'hire_agreement_forms';
  if (templateId.startsWith('invoice.')) return 'invoices';
  if (templateId === 'report.engineer') return 'engineer_report';
  if (templateId === 'report.pav') return 'pav_report';
  if (templateId === 'letter.part36_offer') return 'part_36';
  if (templateId.startsWith('letter.') || templateId.startsWith('pack.') || templateId.startsWith('notice.')) return 'correspondence';
  return 'other';
}

/**
 * Documents that only count once the client or witness has signed them: the hire agreement, the express request and
 * the statements of truth. An approved draft (a witness statement still bannered "Draft for the witness to check,
 * amend and sign") is never put before the court; a signed paper copy is indexed from the evidence instead.
 */
function needsSignature(templateId: string): boolean {
  return templateId === 'statement.witness' || templateId.startsWith('agreement.') || ['form.express_request_to_start', 'form.mitigation_questionnaire', 'form.statement_of_means', 'form.statement_of_need'].includes(templateId);
}

const COURT_PAPER_RE = /\b(?:claim\s+form|N1\b|particulars\s+of\s+claim|defen[cs]e|reply\s+to\s+defen[cs]e|directions|order|notice\s+of\s+allocation|questionnaire)\b/i;

function sectionForEvidence(e: Evidence): SectionKey | undefined {
  if (NON_PAPER_KINDS.has(e.kind)) return undefined; // audio/video is served separately; photographs are grouped below
  const label = `${e.description ?? ''} ${e.filename}`;
  switch (e.kind) {
    case 'witness_statement':
      return 'witness_statements';
    case 'engineer_report':
      return 'engineer_report';
    case 'invoice':
      return 'invoices';
    case 'correspondence':
      return /part\s*36/i.test(label) ? 'part_36' : 'correspondence';
    default:
      if (COURT_PAPER_RE.test(label)) return 'claim_form_particulars';
      if (/part\s*36/i.test(label)) return 'part_36';
      return 'other';
  }
}

/** Page count of a PDF from its page tree (/Pages /Count), else its page objects; undefined when unreadable. */
function pdfPageCount(buf: Buffer): number | undefined {
  const s = buf.toString('latin1');
  let max = 0;
  for (const m of s.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)) max = Math.max(max, Number(m[1] ?? m[2]));
  if (max > 0) return max;
  const objects = s.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  return objects > 0 ? objects : undefined;
}

function readPages(file: string): number | undefined {
  try {
    return existsSync(file) ? pdfPageCount(readFileSync(file)) : undefined;
  } catch {
    return undefined;
  }
}

function documentPages(ctx: AppContext, d: GeneratedDocument): number {
  if (d.pdfPath) {
    try {
      const abs = assertInsideStore(ctx.config.documentsDir, path.isAbsolute(d.pdfPath) ? d.pdfPath : path.join(ctx.config.documentsDir, d.pdfPath), 'document pdfPath');
      const n = readPages(abs);
      if (n) return n;
    } catch {
      /* outside the store or unreadable: estimate below */
    }
  }
  return d.html ? Math.max(1, Math.ceil(htmlToText(d.html).length / CHARS_PER_PAGE)) : 1;
}

function evidencePages(ctx: AppContext, e: Evidence): number {
  if (e.mime === 'application/pdf') {
    try {
      return readPages(absoluteEvidencePath(ctx, e.storagePath)) ?? 1;
    } catch {
      return 1;
    }
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Witness helpers
// ---------------------------------------------------------------------------

const DEFAULT_KNOWLEDGE_STATEMENT =
  'The facts in this statement are within my own knowledge unless I say otherwise. Where a fact is not within my own knowledge, I say so and give the source of my information or belief.';

/** When the witness gave the account: a selected event or evidence record, a tagged event, or a matching statement on file. */
function accountGivenAt(b: BuildInput, witness: Party): ISODate | undefined {
  const { bundle, now } = b;
  const eventId = text(b.extra?.accountEventId);
  if (eventId) {
    const e = bundle.events.find((x) => x.id === eventId);
    if (!e) throw notFound('event', eventId);
    return day(e.at);
  }
  const evidenceId = text(b.extra?.accountEvidenceId);
  if (evidenceId) {
    const e = bundle.evidence.find((x) => x.id === evidenceId);
    if (!e) throw notFound('evidence', evidenceId);
    return day(e.capturedAt ?? e.uploadedAt);
  }
  const tagged = [...bundle.events]
    .filter((e) => e.data?.kind === 'witness_account' && (e.data?.partyId === undefined || e.data.partyId === witness.id) && ms(e.at) <= ms(now))
    .sort((x, y) => ms(y.at) - ms(x.at))[0];
  if (tagged) return day(tagged.at);
  const surname = witness.name.trim().split(/\s+/).pop()?.toLowerCase();
  const statement = surname
    ? bundle.evidence
        .filter((e) => e.kind === 'witness_statement' && `${e.description ?? ''} ${e.filename}`.toLowerCase().includes(surname))
        .sort((x, y) => ms(y.capturedAt ?? y.uploadedAt) - ms(x.capturedAt ?? x.uploadedAt))[0]
    : undefined;
  return statement ? day(statement.capturedAt ?? statement.uploadedAt) : undefined;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export const litigationBuilders: Record<string, Builder> = {
  'letter.complaint_disp': (b, base) => {
    const { bundle, now } = b;
    const today = todayOf(b);
    assertHandlerText(b, 'complaintSummary');
    const toOwnInsurer = b.recipientRole === 'own_insurer' || (Boolean(b.recipientPartyId) && b.recipientPartyId === bundle.claim.clientInsurerId);
    const requested = b.extra?.againstOwnInsurer;
    if (requested !== undefined && typeof requested !== 'boolean') throw badRequest('data.againstOwnInsurer must be true or false', { code: 'INVALID_FIELD', field: 'againstOwnInsurer' });
    if (requested === true && !toOwnInsurer) {
      throw badRequest(
        'againstOwnInsurer may be true only for a complaint addressed to the client’s own insurer (recipientPartyId = the claim’s clientInsurerId). A third-party claimant is not an eligible complainant against the at-fault insurer (DISP 2.7), so that letter never names the ombudsman.',
        { code: 'FORUM_NOT_OPEN', field: 'againstOwnInsurer' },
      );
    }
    // Addressed to the client's own insurer, the complaint is the policyholder's: the at-fault framing would tell that
    // insurer the claim was "presented to you" on the date the NCAF went to the other insurer, and quote that insurer's
    // reference as theirs. So the recipient decides the forum; a contradicting flag is refused rather than obeyed.
    if (requested === false && toOwnInsurer) {
      throw badRequest(
        'This complaint is addressed to the client’s own insurer, so it is the policyholder’s complaint (againstOwnInsurer is true). Omit againstOwnInsurer, or address the complaint to the at-fault insurer.',
        { code: 'FORUM_MISMATCH', field: 'againstOwnInsurer' },
      );
    }
    const againstOwnInsurer = toOwnInsurer;

    // ICOBS 8.2.6R: three months from presentation of the claim (the clocks engine starts it at the NCAF).
    let notifiedAt: ISODateTime | undefined;
    let icobsDue: ISODateTime | undefined;
    if (againstOwnInsurer) {
      notifiedAt = ownInsurerNotification(bundle)?.at;
      if (!notifiedAt) throw conflict('NO_NOTIFICATION', 'Log when the claim was notified to the client’s own insurer (an email_out / letter_out / call event with data.recipientPartyId = that insurer) — the ICOBS 8.2.6R three months run from it');
    } else {
      const clock = bundle.clocks.filter((c) => c.kind === 'icobs_8_2_6_three_months').sort((x, y) => ms(x.startsAt) - ms(y.startsAt))[0];
      notifiedAt = clock?.startsAt ?? ncafBlock(bundle)?.sentAtIso;
      icobsDue = clock?.dueAt;
      if (!notifiedAt) throw conflict('NO_NCAF', 'The claim has not been presented to the insurer (no New Claim Advice Form sent or logged): the ICOBS 8.2.6R period has not started');
    }
    const notificationDate = day(notifiedAt);
    const icobsDeadline = day(icobsDue ?? addCalendarMonths(notifiedAt, 3));

    const heads = headSummaries(bundle)
      .filter((h) => h.outstandingPence > 0)
      .map((h) => {
        const note = [h.invoiceReference ? `Invoice ${h.invoiceReference}` : undefined, h.receivedPence > 0 ? `${formatGBP(h.claimedPence)} claimed, of which ${formatGBP(h.receivedPence)} received; balance outstanding` : undefined].filter(Boolean).join('; ');
        return { label: complaintHeadLabel(h, b), valuePence: h.outstandingPence, note: note || undefined };
      });
    const outstandingPence = heads.reduce((t, h) => t + h.valuePence, 0);

    const finalResponseDeadline = runningClockDue(bundle, ['disp_final_response_8_weeks']) ?? day(addWeeks(today, 8));
    // Internal records (file notes, accounts taken from witnesses, anything marked internal) never go to the insurer.
    const internal = new Set(bundle.events.filter((e) => e.type === 'note' || e.data?.internal === true || e.data?.kind === 'witness_account').map((e) => e.id));
    const events = [...bundle.events]
      .filter((e) => !internal.has(e.id) && ms(e.at) <= ms(now))
      .sort((x, y) => ms(x.at) - ms(y.at))
      .map((e) => ({ date: day(e.at), description: e.summary, attributableTo: e.attributableTo }));

    return {
      ...base,
      recipient: withAttention(base.recipient, 'Complaints Team'),
      claim: againstOwnInsurer ? { ...(base.claim as Record<string, unknown>), theirReference: undefined } : base.claim,
      againstOwnInsurer,
      chronology: events,
      notificationDate,
      icobsDeadline,
      icobsDeadlinePassed: today > icobsDeadline,
      daysSinceNotification: calendarDaysBetween(notificationDate, today),
      heads,
      outstandingPence,
      acknowledgementDeadline: deadline(bundle, today, 5, [], true),
      finalResponseDeadline,
    };
  },

  'letter.dsar': (b, base) => {
    const { bundle, now } = b;
    const today = todayOf(b);
    const c = bundle.claimant;
    // The right of access (UK GDPR Art 15) belongs to individuals; a company has no personal data to request.
    if (c.kind !== 'individual') {
      throw conflict(
        'NOT_A_DATA_SUBJECT',
        `${c.name} is a ${c.kind === 'company' ? 'company' : 'public body'}, not an individual: the UK GDPR right of access belongs to individuals only. A request for the driver’s calls must be made for that person, with their own signed authority.`,
      );
    }
    const authorityDate = signedAuthorityDate(bundle, now);
    if (!authorityDate) checkHandlerDate(b, 'authorityDate');
    // UK GDPR Art 12(3) as the ICO reads it: the corresponding date next month, rolled to the next working day.
    const monthLater = day(addCalendarMonths(today, 1));
    const base1m = isWorkingDay(monthLater) ? monthLater : day(nextWorkingDay(monthLater));
    const clock = runningClockDue(bundle, ['dsar_1_month']);
    const responseDeadline = clock && clock > base1m ? clock : base1m;
    return {
      ...base,
      recipient: withAttention(base.recipient, 'Data Protection Officer'),
      dataSubject: { name: c.name, dateOfBirth: c.dateOfBirth, addressLines: addressLines(c), email: c.email, phone: c.phone },
      authorityDate,
      allegedOfferDates: offerAndCallDates(bundle, now),
      references: insurerReferences(bundle),
      responseDeadline,
      icoComplaintDate: day(addCalendarDays(responseDeadline, 1)),
      deliverTo: brand.company.claimsEmail,
    };
  },

  'letter.letter_before_claim': (b, base) => {
    const { bundle } = b;
    const today = todayOf(b);
    const c = bundle.claimant;
    assertHandlerText(b, 'liabilityBasis');
    const isBusiness = c.kind !== 'individual';
    const loss = lossPosition(b);
    const responseDays = isBusiness ? 30 : 14;
    const acc = bundle.claim.accident;
    return {
      ...base,
      recipient: defendantRecipient(b, base),
      signatory: { name: c.name, role: 'Claimant' },
      claimant: { ...claimantBlock(c), isBusiness },
      insurer: bundle.atFaultInsurer ? { name: bundle.atFaultInsurer.name, reference: bundle.claim.atFaultInsurerRef } : undefined,
      accident: { location: acc.location, occurredAt: acc.occurredAt, circumstances: acc.circumstances, highwayCodeRules: acc.highwayCodeRules?.length ? acc.highwayCodeRules : undefined },
      schedule: loss.schedule,
      scheduleTotalPence: loss.scheduleTotalPence,
      interest: loss.interest,
      totalWithInterestPence: loss.totalWithInterestPence,
      responseDays,
      responseDeadline: deadline(bundle, today, responseDays, []),
      track: loss.track,
      enclosures: letterOfClaimEnclosures(bundle),
    };
  },

  'letter.part36_offer': (b, base) => {
    const { bundle, now } = b;
    const c = bundle.claimant;
    const offer = b.extra?.offerPence;
    if (offer !== undefined && (typeof offer !== 'number' || !Number.isInteger(offer) || offer <= 0)) {
      throw badRequest('data.offerPence must be a positive whole number of pence (the sum the claimant will accept, inclusive of interest)', { code: 'INVALID_FIELD', field: 'offerPence' });
    }
    const requestedDays = b.extra?.relevantPeriodDays;
    if (requestedDays !== undefined && (typeof requestedDays !== 'number' || !Number.isInteger(requestedDays) || requestedDays < 21)) {
      throw badRequest('data.relevantPeriodDays must be a whole number of at least 21 (CPR 36.5(1)(c))', { code: 'INVALID_FIELD', field: 'relevantPeriodDays' });
    }
    const loss = lossPosition(b);
    if (typeof offer === 'number' && offer > loss.totalWithInterestPence) {
      throw badRequest(`data.offerPence (${formatGBP(offer)}) is more than the whole claim with interest to date (${formatGBP(loss.totalWithInterestPence)}): a claimant’s offer cannot exceed the claim`, { code: 'OFFER_EXCEEDS_CLAIM', field: 'offerPence' });
    }
    const p36 = part36({ offerPence: typeof offer === 'number' ? offer : 0, madeAt: now, relevantPeriodDays: typeof requestedDays === 'number' ? requestedDays : 21 });
    const pr = proceedingsOf(bundle);
    const lbcDoc = bundle.documents.filter((d) => d.templateId === 'letter.letter_before_claim' && d.sentAt).sort((x, y) => ms(y.sentAt!) - ms(x.sentAt!))[0];
    const lbcAt = lbcDoc?.sentAt ?? latestEvent(bundle, 'letter_before_claim_sent')?.at;
    return {
      ...base,
      recipient: defendantRecipient(b, base),
      signatory: { name: c.name, role: 'Claimant' },
      claimant: claimantBlock(c),
      relevantPeriodDays: p36.relevantPeriodDays,
      relevantPeriodEnd: day(p36.expiresAt),
      proceedings: pr?.claimNumber ? { claimNumber: pr.claimNumber, court: pr.court } : undefined,
      letterOfClaimDate: lbcAt ? day(lbcAt) : undefined,
      claimedPence: loss.totalWithInterestPence,
      expectedTrack: loss.track.expected,
    };
  },

  'letter.particularisation_demand': (b, base) => {
    const { bundle } = b;
    assertHandlerText(b, 'allegationQuoted', 'allegationLetter.reference', 'allegationLetter.author');
    const kind = b.extra?.allegationKind;
    if (kind !== undefined && !(ALLEGATION_KINDS as readonly unknown[]).includes(kind)) {
      throw badRequest(`data.allegationKind must be one of ${ALLEGATION_KINDS.join(', ')}`, { code: 'INVALID_FIELD', field: 'allegationKind' });
    }
    const ev = allegationEvent(b);
    return {
      ...base,
      allegationLetter: { date: day(ev.at), reference: text(ev.data?.reference) ?? text(ev.data?.ref), author: text(ev.data?.author) ?? text(ev.data?.from) },
      registerPosition: registerPosition(bundle),
      responseDeadline: deadline(bundle, todayOf(b), 14, []),
    };
  },

  'bundle.litigation_index': (b, base) => {
    const { bundle, ctx } = b;
    assertHandlerText(b, 'solicitorName');
    const includePart36 = b.extra?.includePart36 === true;
    const items: BundleItem[] = [];
    for (const d of bundle.documents) {
      if (!FINAL_STATUSES.has(d.status)) continue;
      const key = sectionForTemplate(d.templateId);
      if (!key) continue;
      if (key === 'part_36' && !includePart36) continue; // CPR 36.16: never before the trial judge
      if (key === 'correspondence' && !d.sentAt) continue; // correspondence is what was actually sent
      if (needsSignature(d.templateId) && (d.status !== 'signed' || !d.signature)) continue;
      // Correspondence is dated when sent; a signed document when it was signed.
      const at = key === 'correspondence' ? d.sentAt! : (d.signature?.signedAt ?? d.sentAt ?? d.approvedAt ?? d.createdAt);
      items.push({ key, description: d.title, at, pages: documentPages(ctx, d) });
    }
    for (const e of bundle.evidence) {
      const key = sectionForEvidence(e);
      if (!key || (key === 'part_36' && !includePart36)) continue;
      items.push({ key, description: e.description ?? e.filename, at: e.capturedAt ?? e.uploadedAt, pages: evidencePages(ctx, e) });
    }
    const photos = bundle.evidence.filter((e) => e.kind === 'photo').sort((x, y) => ms(x.capturedAt ?? x.uploadedAt) - ms(y.capturedAt ?? y.uploadedAt));
    if (photos.length) items.push({ key: 'other', description: `Photographs (${photos.length})`, at: photos[0]!.capturedAt ?? photos[0]!.uploadedAt, pages: photos.length });

    let page = 1;
    const sections = SECTION_ORDER.flatMap((key) => {
      const documents = items
        .filter((i) => i.key === key)
        .sort((x, y) => ms(x.at) - ms(y.at))
        .map((i) => {
          const startPage = page;
          const endPage = page + Math.max(1, i.pages) - 1;
          page = endPage + 1;
          return endPage > startPage ? { description: i.description, date: day(i.at), startPage, endPage } : { description: i.description, date: day(i.at), startPage };
        });
      return documents.length ? [{ key, documents }] : [];
    });
    if (sections.length === 0) throw conflict('NO_BUNDLE_DOCUMENTS', 'There are no approved, signed or sent documents or paper evidence on this claim to index');
    const pr = proceedingsOf(bundle);
    return {
      ...base,
      court: pr ? { name: pr.court, claimNumber: pr.claimNumber } : undefined,
      parties: { claimant: bundle.claimant.name, defendant: pr?.defendant ?? proposedDefendant(bundle)?.name, secondDefendant: pr?.secondDefendant },
      claimantActsInPerson: !text(b.extra?.solicitorName),
      sections,
      totalPages: page - 1,
    };
  },

  'statement.witness': (b, base) => {
    const { bundle, ctx, now } = b;
    assertHandlerText(b, 'witness.occupation', 'witness.capacity', 'witness.shortName', 'knowledgeStatement');
    const selected = text(b.extra?.witnessPartyId);
    let witness: Party = bundle.claimant;
    if (selected) {
      // Only a person on this claim (claimant, driver, or a third party / witness linked to it): any other party's name
      // and home address would be copied from someone else's file into this one.
      const onClaim = [bundle.claimant, bundle.driver, ...bundle.thirdParties].find((p) => p?.id === selected);
      if (!onClaim) {
        if (!ctx.repos.getParty(ctx.db, selected)) throw notFound('party', selected);
        throw badRequest(`Party ${selected} is not on this claim: link the witness to the claim (as a third party) before drafting their statement`, { code: 'PARTY_NOT_ON_CLAIM', field: 'witnessPartyId' });
      }
      witness = onClaim;
    }
    const isClaimant = witness.id === bundle.claimant.id;
    const paragraphs = b.extra?.paragraphs;
    if (paragraphs !== undefined && (!Array.isArray(paragraphs) || paragraphs.length === 0 || !paragraphs.every((x) => typeof x === 'string' && x.trim() !== ''))) {
      throw badRequest('data.paragraphs must be the witness’s account in their own words: a non-empty array of paragraphs (strings)', { code: 'INVALID_FIELD', field: 'paragraphs' });
    }
    const account = accountGivenAt(b, witness);
    if (!account) checkHandlerDate(b, 'accountGivenAt');
    const pr = proceedingsOf(bundle);
    const previous = bundle.documents.filter(
      (d) => d.templateId === 'statement.witness' && FINAL_STATUSES.has(d.status) && (d.dataSnapshot?.witness as { name?: unknown } | undefined)?.name === witness.name,
    ).length;
    return {
      ...base,
      signatory: { name: witness.name, role: isClaimant ? 'Claimant' : 'Witness' },
      createdAt: now,
      court: pr ? { name: pr.court, claimNumber: pr.claimNumber } : undefined,
      parties: { claimant: bundle.claimant.name, defendant: pr?.defendant ?? proposedDefendant(bundle)?.name, secondDefendant: pr?.secondDefendant },
      witness: {
        name: witness.name,
        addressLines: witness.address ? addressLines(witness) : undefined,
        capacity: isClaimant ? 'the Claimant' : undefined,
        shortName: witness.kind === 'individual' ? shortNameOf(witness.name) : undefined,
      },
      statementNumber: previous + 1,
      knowledgeStatement: text(b.extra?.knowledgeStatement) ? undefined : DEFAULT_KNOWLEDGE_STATEMENT,
      accountGivenAt: account,
      isDraft: true,
    };
  },
};
