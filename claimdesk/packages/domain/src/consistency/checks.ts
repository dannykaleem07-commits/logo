/**
 * Position-consistency engine (BLUEPRINT §3.7, §3.8, §3.10; live-file lessons a, b, i).
 * checkDraft(text, ctx) parses an outgoing draft and compares every amount, date, deadline and assertion with the
 * ledger, the intervention register, storage/hire records, prior outgoing letters and the perimeter rules.
 * Pure: `now` is taken from the context; nothing is read from the environment.
 */
import { formatGBP, parseGBP } from '../money.js';
import type {
  ClaimBundle,
  Clock,
  ClockKind,
  ConsistencyCode,
  ConsistencyFlag,
  ConsistencyReport,
  GeneratedDocument,
  HeadOfLoss,
  ISODate,
  ISODateTime,
  LedgerEntry,
  Pence
} from '../types.js';
import { signatureDateChecks } from '../esign/dates.js';
import { extractAmounts, extractCitations, extractDates, extractDeadlines, type ExtractedAmount, type ExtractedDate } from './extract.js';
import { bannedPhraseCheck, excerptAround, legacyCheck, REGISTERED_NAME } from './legacy.js';
import { calendarDaysBetween, chargeableDays, datePart, dayNumber, formatLongDate, normaliseSpace, toPlainText } from './text.js';

export type RecipientRole = 'at_fault_insurer' | 'client' | 'own_insurer' | 'court' | 'other';

export interface DraftContext {
  bundle: ClaimBundle;
  priorOutgoing: GeneratedDocument[];
  draftCreatedAt: ISODateTime;
  templateId: string;
  recipientRole?: RecipientRole;
  kbCitations?: Array<{ citation: string; verified: boolean }>;
  registeredName?: string;
  /** Time of the check (defaults to draftCreatedAt). */
  now?: ISODateTime;
  /** Working-day arithmetic from the calendar module; a Mon–Fri fallback without bank holidays is used when absent. */
  addWorkingDays?: (date: ISODate, n: number) => ISODate;
}

/** Templates addressed to the at-fault insurer when no recipientRole is given. */
export const AT_FAULT_INSURER_TEMPLATES: readonly string[] = [
  'letter.ncaf', 'letter.handling_ref_request', 'letter.intervention_reply', 'letter.collect_or_pay', 'letter.delay_notice_gta_4_10',
  'letter.chaser_7', 'letter.chaser_14', 'letter.chaser_21', 'letter.complaint_disp', 'letter.dsar', 'letter.letter_before_claim',
  'letter.part36_offer', 'letter.vendor_verification_pack', 'letter.pav_challenge', 'letter.particularisation_demand',
  'pack.gta_payment', 'invoice.hire', 'invoice.storage', 'invoice.recovery', 'invoice.engineer_fee', 'schedule.loss'
];

/** Which running clock governs the deadline a template may state. */
export const TEMPLATE_CLOCKS: Readonly<Record<string, readonly ClockKind[]>> = {
  'pack.gta_payment': ['gta_6_7_settlement_1_month', 'icobs_8_2_6_three_months'],
  // A chaser sent on day N states the next rung's deadline (respond within 7 days → day N+7); its own send-date clock
  // is already due and must not be the comparator. The GTA 6.7 month (benchmark) still bounds any payment demand.
  'letter.chaser_7': ['chaser_day_14', 'chaser_day_21', 'complaint_day_28', 'gta_6_7_settlement_1_month'],
  'letter.chaser_14': ['chaser_day_21', 'complaint_day_28', 'gta_6_7_settlement_1_month'],
  'letter.chaser_21': ['complaint_day_28', 'gta_6_7_settlement_1_month'],
  'letter.complaint_disp': ['disp_final_response_8_weeks'],
  'letter.ncaf': ['gta_4_2_handling_ref_5wd', 'gta_3_6_first_notification_5wd'],
  'letter.handling_ref_request': ['gta_4_2_handling_ref_5wd'],
  'letter.dsar': ['dsar_1_month'],
  'letter.part36_offer': ['part36_relevant_period_21_days'],
  'letter.intervention_reply': ['intervention_reply_1wd'],
  'letter.collect_or_pay': ['storage_report_plus_48h'],
  'letter.delay_notice_gta_4_10': ['gta_4_10_authorisation_check_3wd', 'gta_4_11_monitoring_5wd'],
  'letter.cctv_preservation': ['cctv_preservation'],
  'notice.s172_response': ['s172_28_days'],
  'notice.pcn_liability_transfer': ['pcn_representations_28_days']
};

export const ROLE_CLOCKS: Readonly<Record<RecipientRole, readonly ClockKind[]>> = {
  at_fault_insurer: [
    'gta_4_2_handling_ref_5wd', 'gta_3_6_first_notification_5wd', 'gta_6_7_settlement_1_month', 'gta_6_8_late_payment_10pc_day31',
    'gta_6_8_late_payment_20pc_day61', 'icobs_8_2_6_three_months', 'chaser_day_7', 'chaser_day_14', 'chaser_day_21', 'complaint_day_28',
    'disp_final_response_8_weeks', 'part36_relevant_period_21_days', 'dsar_1_month'
  ],
  own_insurer: ['disp_final_response_8_weeks', 'fos_referral_6_months', 'icobs_8_2_6_three_months', 'dsar_1_month'],
  client: ['storage_report_plus_48h', 'custom'],
  court: ['default_judgment_14_days', 'part36_relevant_period_21_days'],
  other: ['cctv_preservation', 'dsar_1_month', 'nip_14_days', 's172_28_days', 'pcn_discount_14_days', 'pcn_representations_28_days', 'pcn_appeal_28_days', 'custom']
};

const PAID_KINDS = new Set<LedgerEntry['kind']>(['paid', 'interim_paid']);
const CLAIMED_KINDS = new Set<LedgerEntry['kind']>(['claimed', 'invoiced']);
const SENT_STATUSES = new Set<GeneratedDocument['status']>(['sent', 'approved', 'signed']);

const HEAD_PATTERNS: Array<[HeadOfLoss, RegExp]> = [
  ['loss_of_use', /\bloss of use\b/i],
  ['engineer_fee', /\bengineer(?:['’]s|s)?\s+fee\b|\bfee note\b|\bengineer\b/i],
  ['hire', /\bhire\b/i],
  ['storage', /\bstorage\b/i],
  ['recovery', /\brecovery\b/i],
  ['pav', /\bpre-accident value\b|\bPAV\b|\bvaluation\b|\btotal loss\b/i],
  ['repair', /\brepair(?:s|ed)?\b/i],
  ['excess', /\bexcess\b/i],
  ['salvage', /\bsalvage\b/i],
  ['diminution', /\bdiminution\b/i],
  ['interest', /\binterest\b/i]
];

const HEAD_SNAPSHOT_KEYS: Record<HeadOfLoss, string[]> = {
  hire: ['hire'], recovery: ['recovery'], storage: ['storage'], engineer_fee: ['engineer', 'fee'], pav: ['pav', 'valuation', 'preaccident'],
  repair: ['repair'], salvage: ['salvage'], excess: ['excess'], loss_of_use: ['lossofuse', 'loss_of_use'], diminution: ['diminution'],
  personal_effects: ['personaleffects', 'personal_effects'], loss_of_earnings: ['lossofearnings', 'loss_of_earnings'], travel: ['travel'],
  misc: ['misc'], interest: ['interest'], court_fee: ['courtfee', 'court_fee'], fixed_costs: ['fixedcosts', 'fixed_costs']
};

const HEAD_LABEL: Record<HeadOfLoss, string> = {
  hire: 'hire', recovery: 'recovery', storage: 'storage', engineer_fee: 'engineer fee', pav: 'PAV', repair: 'repair', salvage: 'salvage',
  excess: 'excess', loss_of_use: 'loss of use', diminution: 'diminution', personal_effects: 'personal effects', loss_of_earnings: 'loss of earnings',
  travel: 'travel', misc: 'miscellaneous', interest: 'interest', court_fee: 'court fee', fixed_costs: 'fixed costs'
};

// ---------------------------------------------------------------------------

function flag(code: ConsistencyCode, severity: ConsistencyFlag['severity'], message: string, extra: Partial<ConsistencyFlag> = {}): ConsistencyFlag {
  return { code, severity, message, ...extra };
}

function gross(e: LedgerEntry): Pence {
  return e.amountPence + (e.vatPence ?? 0);
}

function sum(entries: LedgerEntry[], f: (e: LedgerEntry) => Pence): Pence {
  return entries.reduce((s, e) => s + f(e), 0);
}

interface LedgerSets {
  paidEntries: LedgerEntry[];
  claimedEntries: LedgerEntry[];
  paidSet: Set<Pence>;
  claimedSet: Set<Pence>;
  paidTotalNet: Pence;
  paidTotalGross: Pence;
  claimedTotalNet: Pence;
  claimedTotalGross: Pence;
}

/** Salvage is a credit (retained by the claimant): it is netted off every total, as in the schedule of loss (money.md §3). */
function signOf(e: LedgerEntry): 1 | -1 {
  return e.head === 'salvage' ? -1 : 1;
}

function ledgerSets(ledger: LedgerEntry[]): LedgerSets {
  const paidEntries = ledger.filter((e) => PAID_KINDS.has(e.kind));
  const claimedEntries = ledger.filter((e) => CLAIMED_KINDS.has(e.kind));
  const paidSet = new Set<Pence>();
  const claimedSet = new Set<Pence>();
  const vat = (e: LedgerEntry): Pence => e.vatPence ?? 0;
  const signedNet = (e: LedgerEntry): Pence => signOf(e) * e.amountPence;
  const signedGross = (e: LedgerEntry): Pence => signOf(e) * gross(e);
  const signedVat = (e: LedgerEntry): Pence => signOf(e) * vat(e);
  const addAll = (entries: LedgerEntry[], set: Set<Pence>) => {
    for (const e of entries) {
      set.add(e.amountPence);
      set.add(gross(e));
      if (e.vatPence) set.add(e.vatPence); // an invoice's "VAT £23.00" line is a ledger figure too
    }
    // Totals across heads net the salvage credit off; a letter states "less salvage of £900" as a positive figure,
    // so per-head sums stay absolute.
    set.add(sum(entries, signedNet));
    set.add(sum(entries, signedGross));
    set.add(sum(entries, signedVat));
    const heads = new Set(entries.map((e) => e.head));
    for (const h of heads) {
      const hs = entries.filter((e) => e.head === h);
      set.add(sum(hs, (e) => e.amountPence));
      set.add(sum(hs, gross));
      set.add(sum(hs, vat));
    }
  };
  addAll(paidEntries, paidSet);
  addAll(claimedEntries, claimedSet);
  const paidTotalNet = sum(paidEntries, signedNet);
  const paidTotalGross = sum(paidEntries, signedGross);
  const claimedTotalNet = sum(claimedEntries, signedNet);
  const claimedTotalGross = sum(claimedEntries, signedGross);
  // outstanding balances
  claimedSet.add(claimedTotalNet - paidTotalNet);
  claimedSet.add(claimedTotalGross - paidTotalGross);
  claimedSet.add(claimedTotalGross - paidTotalNet);
  return { paidEntries, claimedEntries, paidSet, claimedSet, paidTotalNet, paidTotalGross, claimedTotalNet, claimedTotalGross };
}

function describeEntries(entries: LedgerEntry[]): string {
  return entries.map((e) => `${HEAD_LABEL[e.head]} ${formatGBP(e.amountPence)}${e.vatPence ? ` + VAT ${formatGBP(e.vatPence)}` : ''} on ${formatLongDate(e.date)}${e.reference ? ` ref ${e.reference}` : ''}`).join('; ');
}

function headNear(text: string, index: number, length: number): HeadOfLoss | undefined {
  const before = text.slice(Math.max(0, index - 80), index);
  const after = text.slice(index + length, index + length + 40);
  let best: { head: HeadOfLoss; distance: number } | undefined;
  for (const [head, re] of HEAD_PATTERNS) {
    const g = new RegExp(re.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = g.exec(before)) !== null) {
      const distance = before.length - (m.index + m[0].length);
      if (!best || distance < best.distance) best = { head, distance };
    }
    g.lastIndex = 0;
    while ((m = g.exec(after)) !== null) {
      const distance = m.index + 1;
      if (!best || distance < best.distance) best = { head, distance };
    }
  }
  return best?.head;
}

function inferRole(ctx: DraftContext): RecipientRole | undefined {
  if (ctx.recipientRole) return ctx.recipientRole;
  if (AT_FAULT_INSURER_TEMPLATES.includes(ctx.templateId)) return 'at_fault_insurer';
  return undefined;
}

function running(clocks: Clock[], kinds: readonly ClockKind[]): Clock[] {
  return clocks.filter((c) => c.status === 'running' && kinds.includes(c.kind));
}

// ---------------------------------------------------------------------------
// Individual checks (each returns flags)
// ---------------------------------------------------------------------------

export function amountChecks(text: string, amounts: ExtractedAmount[], ctx: DraftContext): ConsistencyFlag[] {
  const flags: ConsistencyFlag[] = [];
  const sets = ledgerSets(ctx.bundle.ledger);
  for (const a of amounts) {
    if (a.perUnit) continue;
    if (a.context === 'paid') {
      if (sets.paidSet.has(a.pence)) continue;
      const ledgerValue = sets.paidEntries.length === 0 ? 'no payment recorded' : formatGBP(sets.paidTotalNet);
      flags.push(
        flag('AMOUNT_PAID_MISMATCH', 'block', sets.paidEntries.length === 0
          ? `Draft states ${formatGBP(a.pence)} as paid or received, but the ledger records no payment on this claim. Remove the figure or record the remittance first.`
          : `Draft states ${formatGBP(a.pence)} as paid or received; the ledger records ${formatGBP(sets.paidTotalNet)} received${sets.paidTotalGross !== sets.paidTotalNet ? ` (${formatGBP(sets.paidTotalGross)} gross)` : ''} (${describeEntries(sets.paidEntries)}). Correct the draft from the ledger.`,
          { draftValue: formatGBP(a.pence), ledgerValue, excerpt: a.excerpt })
      );
    } else if (a.context === 'claimed' || a.context === 'invoice') {
      if (sets.claimedEntries.length === 0) continue;
      // Only a status word (claimed/outstanding/balance/total/due) or an invoice keyword makes a figure comparable with
      // a ledger head: "call-out £90" inside an itemised recovery account is a component, not a claimed total.
      if (a.strength === 'weak') continue;
      if (sets.claimedSet.has(a.pence)) continue;
      const head = headNear(text, a.index, 0);
      const headEntries = head ? sets.claimedEntries.filter((e) => e.head === head) : [];
      const headNet = sum(headEntries, (e) => e.amountPence);
      const headGross = sum(headEntries, gross);
      flags.push(
        flag('AMOUNT_CLAIMED_MISMATCH', 'warn',
          `Draft states ${formatGBP(a.pence)} as ${a.context === 'invoice' ? 'invoiced' : 'claimed/outstanding'}${head ? ` for ${HEAD_LABEL[head]}` : ''}; the ledger has ${head && headEntries.length ? `${HEAD_LABEL[head]} ${formatGBP(headNet)} net / ${formatGBP(headGross)} gross and ` : ''}total claimed ${formatGBP(sets.claimedTotalNet)} net / ${formatGBP(sets.claimedTotalGross)} gross, outstanding ${formatGBP(sets.claimedTotalGross - sets.paidTotalGross)}. No ledger figure matches.`,
          { draftValue: formatGBP(a.pence), ledgerValue: head && headEntries.length ? formatGBP(headGross) : formatGBP(sets.claimedTotalGross), excerpt: a.excerpt })
      );
    }
  }
  return flags;
}

const PRESENT_DEMAND_RE = /\b(?:we\s+(?:now\s+)?require|you\s+must|please|must\s+(?:be\s+)?(?:received|made|paid|reach)|no\s+later\s+than|not\s+later\s+than|is\s+required)\b/i;
const PAST_TENSE_RE = /\b(?:was|were|had|previously|earlier|already|did\s+not|failed)\b/i;

function sentenceAt(text: string, index: number): string {
  const start = Math.max(text.lastIndexOf('\n', index), text.slice(0, index).search(/[.!?]\s+(?=[^.!?]*$)/)) + 1;
  const rest = text.slice(index);
  const endRel = rest.search(/[.!?](?:\s|$)|\n/);
  return text.slice(start, endRel >= 0 ? index + endRel + 1 : text.length);
}

export function deadlineChecks(text: string, ctx: DraftContext): ConsistencyFlag[] {
  const flags: ConsistencyFlag[] = [];
  const draftDate = datePart(ctx.draftCreatedAt);
  const all = extractDeadlines(text, { baseDate: draftDate, addWorkingDays: ctx.addWorkingDays });
  // A present-tense demand with a date already in the past is a wrong date in the letter (a statement about an old
  // deadline, "payment was due by …", is not).
  for (const d of all.filter((x) => x.kind === 'absolute' && x.iso < draftDate)) {
    const sentence = sentenceAt(text, d.index);
    if (PRESENT_DEMAND_RE.test(sentence) && !PAST_TENSE_RE.test(sentence)) {
      const daysAgo = dayNumber(draftDate) - dayNumber(d.iso);
      flags.push(
        flag('DEADLINE_MISMATCH', 'warn',
          `Draft demands a response by ${formatLongDate(d.iso)}, which is ${daysAgo} day${daysAgo === 1 ? '' : 's'} before this letter's date (${formatLongDate(draftDate)}). The deadline has already passed; recompute it from the governing clock.`,
          { draftValue: d.iso, ledgerValue: draftDate, excerpt: d.excerpt })
      );
    }
  }
  const deadlines = all.filter((d) => d.iso >= draftDate);
  if (deadlines.length === 0) return flags;
  const mapped = TEMPLATE_CLOCKS[ctx.templateId];
  const role = inferRole(ctx);
  const kinds = mapped ?? (role ? ROLE_CLOCKS[role] : undefined);
  if (!kinds) return flags;
  const relevant = running(ctx.bundle.clocks, kinds);
  if (relevant.length === 0) return flags;

  for (const d of deadlines) {
    const dd = dayNumber(d.iso);
    const earliest = relevant.reduce((a, c) => (dayNumber(c.dueAt) < dayNumber(a.dueAt) ? c : a));
    const nearest = relevant.reduce((a, c) => (Math.abs(dayNumber(c.dueAt) - dd) < Math.abs(dayNumber(a.dueAt) - dd) ? c : a));
    const nearestDiff = dd - dayNumber(nearest.dueAt);
    if (dd < dayNumber(earliest.dueAt)) {
      const daysEarly = dayNumber(earliest.dueAt) - dd;
      flags.push(
        flag('DEADLINE_TOO_EARLY', mapped ? 'block' : 'warn',
          `Draft sets a deadline of ${formatLongDate(d.iso)} but the governing clock "${earliest.label}" (${earliest.basis}) does not expire until ${formatLongDate(earliest.dueAt)} — ${daysEarly} day${daysEarly === 1 ? '' : 's'} earlier than the computed deadline. A demand before the clock runs is unenforceable and reads as inconsistency.`,
          { draftValue: d.iso, ledgerValue: datePart(earliest.dueAt), excerpt: d.excerpt })
      );
    } else if (Math.abs(nearestDiff) > 1) {
      flags.push(
        flag('DEADLINE_MISMATCH', 'warn',
          `Draft deadline ${formatLongDate(d.iso)} differs from the computed clock "${nearest.label}" (${nearest.basis}, due ${formatLongDate(nearest.dueAt)}) by ${Math.abs(nearestDiff)} days. Use the computed date.`,
          { draftValue: d.iso, ledgerValue: datePart(nearest.dueAt), excerpt: d.excerpt })
      );
    }
  }
  return flags;
}

/** The denial must concern a vehicle (intervention) offer — "you have not made an offer on the PAV" is a legitimate sentence. */
const VEHICLE_NOUN = '(?:vehicle|car|hire|replacement|courtesy\\s+car|intervention)';
const OFFER_DENIAL_PATTERNS: RegExp[] = [
  /\bno\s+(?:alternative|replacement|hire|courtesy|suitable)\s+(?:vehicle|car)\s+(?:was|has been|had been|were)?\s*offered\b/i,
  /\bno\s+offer\s+of\s+(?:a|an|any)?\s*(?:replacement|alternative|hire|courtesy|suitable)\s+(?:vehicle|car)\b/i,
  new RegExp(`\\b(?:did\\s+not|didn['’]t|never|has\\s+not|had\\s+not|have\\s+not|failed\\s+to)\\s+(?:make|made|extend(?:ed)?|put\\s+forward)?\\s*(?:an?\\s+|any\\s+)?offer(?:ed)?\\s+(?:of\\s+)?(?:a|an|any|the|our|your)?\\s*(?:replacement|alternative|hire|courtesy|suitable)?\\s*${VEHICLE_NOUN}\\b`, 'i'),
  new RegExp(`\\bno\\s+(?:intervention\\s+|vehicle\\s+|hire\\s+)offer\\s+(?:was|has been|had been)\\s+(?:made|received|put)\\b`, 'i'),
  new RegExp(`\\bno\\s+offer\\s+(?:was|has been|had been)\\s+(?:made|received|put)\\b(?=[^.\\n]{0,60}\\b${VEHICLE_NOUN}\\b)`, 'i'),
  new RegExp(`\\b(?:did\\s+not|didn['’]t|never|has\\s+not|had\\s+not)\\s+offer(?:ed)?\\s+(?:the\\s+|our\\s+|your\\s+|any\\s+)?(?:client|claimant|customer|insured|hirer)\\b(?=[^.\\n]{0,40}\\b${VEHICLE_NOUN}\\b)`, 'i'),
  /\bwas\s+not\s+offered\s+(?:a|an|any)\s+(?:replacement|alternative|hire|courtesy)?\s*(?:vehicle|car)\b/i
];

export function offerChecks(text: string, ctx: DraftContext): ConsistencyFlag[] {
  const flags: ConsistencyFlag[] = [];
  if (ctx.bundle.offers.length === 0) return flags;
  const matches: Array<{ index: number; length: number; text: string }> = [];
  for (const re of OFFER_DENIAL_PATTERNS) {
    const g = new RegExp(re.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = g.exec(text)) !== null) matches.push({ index: m.index, length: m[0].length, text: m[0] });
  }
  matches.sort((a, b) => a.index - b.index || b.length - a.length);
  let coveredTo = -1;
  const offers = ctx.bundle.offers
    .map((o) => `${o.offerorName} on ${formatLongDate(o.receivedAt)} by ${o.channel}${o.dailyRatePence ? ` at ${formatGBP(o.dailyRatePence)}/day${o.rateIncludesVat ? ' inc VAT' : ''}` : ''}${o.vehicleClassOffered ? ` (${o.vehicleClassOffered})` : ''}, client ${o.clientDecision}`)
    .join('; ');
  for (const m of matches) {
    if (m.index < coveredTo) continue;
    coveredTo = m.index + m.length;
    flags.push(
      flag('OFFER_DENIED_BUT_LOGGED', 'block',
        `Draft says "${normaliseSpace(m.text)}" but the intervention register holds ${ctx.bundle.offers.length} offer${ctx.bundle.offers.length === 1 ? '' : 's'}: ${offers}. State the offer and the reasons it was declined (Copley v Lawn); never deny a logged offer.`,
        { draftValue: normaliseSpace(m.text), ledgerValue: `${ctx.bundle.offers.length} offer(s) logged`, excerpt: excerptAround(text, m.index, m.length) })
    );
  }
  return flags;
}

const START_KW = /\b(from|commenc(?:ed|ing)|start(?:ed|ing)?|began|since|beginning)\b/gi;
const END_KW = /\b(until|to|ended|ceased|ending|end(?:ed)?\s+on|concluded|terminated|released|collected|up\s+to|till|through)\b/gi;
const GAP_OK = /^\s*(?:on\s+|the\s+|of\s+|at\s+)?$/i;

interface PeriodClaim {
  role: 'start' | 'end';
  date: ExtractedDate;
}

/** Dates following start/end keywords inside the window after a subject word (storage/hire). */
function periodClaims(text: string, subjectRe: RegExp, windowChars = 160): PeriodClaim[] {
  const out: PeriodClaim[] = [];
  const seen = new Set<number>();
  const g = new RegExp(subjectRe.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    const winStart = m.index + m[0].length;
    const window = text.slice(winStart, winStart + windowChars);
    const sentenceEnd = window.search(/\.\s+[A-Z]|\n\n/);
    const win = sentenceEnd >= 0 ? window.slice(0, sentenceEnd + 1) : window;
    for (const d of extractDates(win)) {
      const absIndex = winStart + d.index;
      if (seen.has(absIndex)) continue;
      const before = win.slice(0, d.index);
      let best: { role: 'start' | 'end'; end: number } | undefined;
      for (const [role, re] of [['start', START_KW], ['end', END_KW]] as const) {
        const r = new RegExp(re.source, 'gi');
        let k: RegExpExecArray | null;
        while ((k = r.exec(before)) !== null) {
          const end = k.index + k[0].length;
          if (!best || end > best.end) best = { role, end };
        }
      }
      if (!best) continue;
      const gap = before.slice(best.end);
      if (!GAP_OK.test(gap)) continue;
      seen.add(absIndex);
      out.push({ role: best.role, date: { ...d, index: absIndex, excerpt: excerptAround(text, absIndex, d.raw.length) } });
    }
  }
  return out;
}

function dayCountClaims(text: string, subject: 'storage' | 'hire'): Array<{ days: number; index: number; excerpt: string }> {
  const out: Array<{ days: number; index: number; excerpt: string }> = [];
  const res = subject === 'storage'
    ? [/(\d{1,3})\s+(?:calendar\s+)?days?['’]?\s+(?:of\s+)?storage\b/gi, /\bstorage\s+(?:period\s+|charges?\s+)?(?:of|for|totalling|was|is|lasted|covering)\s+(\d{1,3})\s+(?:calendar\s+)?days?\b/gi, /\bstorage\b[^.\n]{0,80}?\((\d{1,3})\s+days?\)/gi]
    : [/(\d{1,3})\s+(?:calendar\s+)?days?['’]?\s+(?:of\s+)?(?:credit\s+)?hire\b/gi, /\bhired?\s+(?:period\s+|charges?\s+)?(?:of|for|totalling|was|is|lasted|covering)\s+(\d{1,3})\s+(?:calendar\s+)?days?\b/gi, /\bhired?\b[^.\n]{0,80}?\((\d{1,3})\s+days?\)/gi];
  const seen = new Set<number>();
  for (const re of res) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (seen.has(m.index)) continue;
      seen.add(m.index);
      out.push({ days: Number(m[1]), index: m.index, excerpt: excerptAround(text, m.index, m[0].length) });
    }
  }
  return out;
}

/**
 * Day counts a draft may legitimately state for a period.
 *  - storage: 24-hour periods started (gta ratecard 'periods_24h'), the London calendar-date difference, or every
 *    London calendar date touched inclusive of both ends (gta ratecard 'calendar_days').
 *  - hire: 24-hour periods started on the London wall clock (gta hireDays) or the calendar-date difference. There is
 *    no inclusive convention for hire, so "+1" is an inflated head and is rejected.
 */
function acceptableDayCounts(startAt: ISODateTime, endAt: ISODateTime, subject: 'storage' | 'hire'): Set<number> {
  const diff = calendarDaysBetween(startAt, endAt);
  const periods = chargeableDays(startAt, endAt);
  return subject === 'storage' ? new Set([periods, diff, diff + 1]) : new Set([periods, diff]);
}

export function storageChecks(text: string, ctx: DraftContext): ConsistencyFlag[] {
  const flags: ConsistencyFlag[] = [];
  const records = ctx.bundle.storage;
  const claims = periodClaims(text, /\bstorage\b/);
  const counts = dayCountClaims(text, 'storage');
  if (claims.length === 0 && counts.length === 0) return flags;
  if (records.length === 0) {
    for (const c of claims) flags.push(flag('STORAGE_END_MISMATCH', 'block', `Draft states storage ${c.role === 'end' ? 'ended' : 'started'} on ${formatLongDate(c.date.iso)} but no storage record exists on this claim.`, { draftValue: c.date.iso, ledgerValue: 'no storage record', excerpt: c.date.excerpt }));
    for (const c of counts) flags.push(flag('STORAGE_END_MISMATCH', 'block', `Draft states ${c.days} days of storage but no storage record exists on this claim.`, { draftValue: String(c.days), ledgerValue: 'no storage record', excerpt: c.excerpt }));
    return flags;
  }
  const starts = new Set(records.map((r) => datePart(r.startAt)));
  const ends = new Set(records.filter((r) => r.endAt).map((r) => datePart(r.endAt!)));
  for (const c of claims) {
    if (c.role === 'end') {
      if (ends.has(c.date.iso)) continue;
      const open = records.some((r) => !r.endAt);
      flags.push(
        flag('STORAGE_END_MISMATCH', 'block',
          open && ends.size === 0
            ? `Draft states storage ended on ${formatLongDate(c.date.iso)} but the storage record is still running (started ${records.map((r) => formatLongDate(r.startAt)).join(', ')}). End the storage record with its trigger first.`
            : `Draft states storage ended on ${formatLongDate(c.date.iso)} but the storage record${records.length === 1 ? '' : 's'} end${records.length === 1 ? 's' : ''} on ${[...ends].map(formatLongDate).join(', ') || '—'}. Dates must come from the record.`,
          { draftValue: c.date.iso, ledgerValue: [...ends].join(', ') || 'running', excerpt: c.date.excerpt })
      );
    } else if (!starts.has(c.date.iso)) {
      flags.push(flag('STORAGE_END_MISMATCH', 'block', `Draft states storage started on ${formatLongDate(c.date.iso)} but the storage record${records.length === 1 ? '' : 's'} start${records.length === 1 ? 's' : ''} on ${[...starts].map(formatLongDate).join(', ')}.`, { draftValue: c.date.iso, ledgerValue: [...starts].join(', '), excerpt: c.date.excerpt }));
    }
  }
  for (const c of counts) {
    const ok = records.some((r) => r.endAt && acceptableDayCounts(r.startAt, r.endAt, 'storage').has(c.days));
    if (ok) continue;
    const computed = records.filter((r) => r.endAt).map((r) => `${chargeableDays(r.startAt, r.endAt!)} chargeable days (${formatLongDate(r.startAt)} to ${formatLongDate(r.endAt!)})`).join('; ') || 'storage still running';
    flags.push(flag('STORAGE_END_MISMATCH', 'block', `Draft states ${c.days} days of storage; the storage record gives ${computed}.`, { draftValue: String(c.days), ledgerValue: computed, excerpt: c.excerpt }));
  }
  return flags;
}

export function hireChecks(text: string, ctx: DraftContext): ConsistencyFlag[] {
  const flags: ConsistencyFlag[] = [];
  const hires = ctx.bundle.hire;
  const claims = periodClaims(text, /\bhired?\b|\bon hire\b/);
  const counts = dayCountClaims(text, 'hire');
  if (claims.length === 0 && counts.length === 0) return flags;
  if (hires.length === 0) {
    for (const c of claims) flags.push(flag('HIRE_PERIOD_MISMATCH', 'block', `Draft states hire ${c.role === 'end' ? 'ended' : 'started'} on ${formatLongDate(c.date.iso)} but no hire agreement exists on this claim.`, { draftValue: c.date.iso, ledgerValue: 'no hire agreement', excerpt: c.date.excerpt }));
    for (const c of counts) flags.push(flag('HIRE_PERIOD_MISMATCH', 'block', `Draft states ${c.days} days of hire but no hire agreement exists on this claim.`, { draftValue: String(c.days), ledgerValue: 'no hire agreement', excerpt: c.excerpt }));
    return flags;
  }
  const starts = new Set(hires.map((h) => datePart(h.deliveredAt ?? h.startAt)).concat(hires.map((h) => datePart(h.startAt))));
  const ends = new Set(hires.flatMap((h) => [h.endAt, h.collectedAt].filter((x): x is string => !!x).map(datePart)));
  for (const c of claims) {
    if (c.role === 'end') {
      if (ends.has(c.date.iso)) continue;
      flags.push(
        flag('HIRE_PERIOD_MISMATCH', 'block',
          ends.size === 0
            ? `Draft states hire ended on ${formatLongDate(c.date.iso)} but the hire agreement is still running (started ${[...starts].map(formatLongDate).join(', ')}). Record the off-hire first.`
            : `Draft states hire ended on ${formatLongDate(c.date.iso)} but the hire agreement${hires.length === 1 ? '' : 's'} end${hires.length === 1 ? 's' : ''} on ${[...ends].map(formatLongDate).join(', ')}.`,
          { draftValue: c.date.iso, ledgerValue: [...ends].join(', ') || 'running', excerpt: c.date.excerpt })
      );
    } else if (!starts.has(c.date.iso)) {
      flags.push(flag('HIRE_PERIOD_MISMATCH', 'block', `Draft states hire started on ${formatLongDate(c.date.iso)} but the hire agreement${hires.length === 1 ? '' : 's'} start${hires.length === 1 ? 's' : ''} on ${[...starts].map(formatLongDate).join(', ')}.`, { draftValue: c.date.iso, ledgerValue: [...starts].join(', '), excerpt: c.date.excerpt }));
    }
  }
  for (const c of counts) {
    const ok = hires.some((h) => h.endAt && acceptableDayCounts(h.startAt, h.endAt, 'hire').has(c.days));
    if (ok) continue;
    const computed = hires.filter((h) => h.endAt).map((h) => `${chargeableDays(h.startAt, h.endAt!)} chargeable days (${formatLongDate(h.startAt)} to ${formatLongDate(h.endAt!)})`).join('; ') || 'hire still running';
    flags.push(flag('HIRE_PERIOD_MISMATCH', 'block', `Draft states ${c.days} days of hire; the hire agreement gives ${computed}.`, { draftValue: String(c.days), ledgerValue: computed, excerpt: c.excerpt }));
  }
  return flags;
}

const PAYEE_TEMPLATES = (templateId: string) => templateId.startsWith('invoice.') || templateId === 'letter.vendor_verification_pack' || templateId.startsWith('pack.');
const PAYEE_RE = /\b(payee|account name|payable to|pay to|cheques?\s+payable\s+to|beneficiary(?:\s+name)?)\s*[:\-–—]?\s*([^\n,;<]{3,80}?)\s*(?=\n|,|;|\.\s|\.$|$|\bsort\s+code\b|\baccount\s+(?:no|number)\b|\biban\b)/gi;

function normaliseName(s: string): string {
  return s.toLowerCase().replace(/[.,;:]/g, '').replace(/\s+/g, ' ').trim();
}

export function payeeChecks(text: string, ctx: DraftContext): ConsistencyFlag[] {
  const flags: ConsistencyFlag[] = [];
  if (!PAYEE_TEMPLATES(ctx.templateId)) return flags;
  const registered = ctx.registeredName ?? REGISTERED_NAME;
  const want = normaliseName(registered);
  let m: RegExpExecArray | null;
  PAYEE_RE.lastIndex = 0;
  while ((m = PAYEE_RE.exec(text)) !== null) {
    const name = (m[2] ?? '').trim();
    if (!name) continue;
    if (normaliseName(name) === want) continue;
    flags.push(
      flag('PAYEE_MISMATCH', 'block',
        `Payee "${name}" does not match the registered name "${registered}". Confirmation of Payee requires the exact registered name or the payment will be rejected (live File 1: "bank details could not be validated").`,
        { draftValue: name, ledgerValue: registered, excerpt: excerptAround(text, m.index, m[0].length) })
    );
  }
  return flags;
}

const SIGNATURE_KW_STRICT = /\b(signed\s+on|signed\s+at|date\s+of\s+signature|signature\s+date|executed\s+on|date\s+signed|signed\s*:|dated\s*:)/gi;
const SIGNATURE_KW_LOOSE = /\b(dated|signed)\b/gi;
const SIGNATURE_GAP_OK = /^\s*[:\-–—]?\s*(?:on\s+|the\s+|this\s+|at\s+)?$/i;

export function creationDateChecks(text: string, ctx: DraftContext): ConsistencyFlag[] {
  const flags: ConsistencyFlag[] = [];
  const t = ctx.templateId;
  const applies = t.startsWith('agreement.') || t.startsWith('form.') || t.startsWith('certificate.');
  if (!applies) return flags;
  const draftDay = dayNumber(ctx.draftCreatedAt);
  const dates = extractDates(text);
  for (const d of dates) {
    const before = text.slice(Math.max(0, d.index - 40), d.index);
    let kwEnd = -1;
    for (const re of t.startsWith('agreement.') ? [SIGNATURE_KW_STRICT, SIGNATURE_KW_LOOSE] : [SIGNATURE_KW_STRICT]) {
      const g = new RegExp(re.source, 'gi');
      let k: RegExpExecArray | null;
      while ((k = g.exec(before)) !== null) kwEnd = Math.max(kwEnd, k.index + k[0].length);
    }
    if (kwEnd < 0) continue;
    if (!SIGNATURE_GAP_OK.test(before.slice(kwEnd))) continue;
    if (dayNumber(d.iso) < draftDay) {
      flags.push(
        flag('DATE_BEFORE_CREATION', 'block',
          `Signature/dated field reads ${formatLongDate(d.iso)}, which is before this document was created (${formatLongDate(ctx.draftCreatedAt)}). A document cannot be dated before it exists; re-executed documents carry the actual signing date and a re-execution line.`,
          { draftValue: d.iso, ledgerValue: datePart(ctx.draftCreatedAt), excerpt: d.excerpt })
      );
    }
  }
  return flags;
}

function snapshotAmountsForHead(snapshot: Record<string, unknown>, head: HeadOfLoss): Set<Pence> {
  const keys = HEAD_SNAPSHOT_KEYS[head];
  const out = new Set<Pence>();
  const walk = (value: unknown, path: string[]) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, [...path, String(i)]));
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, [...path, k]);
      return;
    }
    const pathKey = path.join('.').toLowerCase().replace(/[^a-z0-9._]/g, '');
    const onHead = keys.some((k) => pathKey.includes(k)) || path.some((p) => p.toLowerCase() === head);
    if (!onHead) return;
    const last = (path[path.length - 1] ?? '').toLowerCase();
    if (typeof value === 'number' && Number.isInteger(value) && !last.endsWith('pounds') && !last.includes('days') && !last.includes('rate') && !last.includes('miles')) out.add(value);
    if (typeof value === 'string') {
      const p = parseGBP(value);
      if (p !== null && /£|\.\d{2}$|,/.test(value)) out.add(p);
    }
  };
  walk(snapshot, []);
  return out;
}

export function priorLetterChecks(text: string, amounts: ExtractedAmount[], ctx: DraftContext): ConsistencyFlag[] {
  const flags: ConsistencyFlag[] = [];
  const priors = ctx.priorOutgoing
    .filter((d) => SENT_STATUSES.has(d.status) && (d.claimId === undefined || d.claimId === ctx.bundle.claim.id))
    .sort((a, b) => Date.parse(b.sentAt ?? b.approvedAt ?? b.createdAt) - Date.parse(a.sentAt ?? a.approvedAt ?? a.createdAt));
  if (priors.length === 0) return flags;
  const seenHeads = new Set<HeadOfLoss>();
  for (const a of amounts) {
    if (a.perUnit || a.context === 'offered' || a.context === 'paid') continue;
    const head = headNear(text, a.index, 0);
    if (!head) continue;
    for (const prior of priors) {
      const set = snapshotAmountsForHead(prior.dataSnapshot ?? {}, head);
      const priorText = toPlainText(prior.html ?? '');
      for (const pa of extractAmounts(priorText)) {
        if (pa.perUnit) continue;
        if (headNear(priorText, pa.index, 0) === head) set.add(pa.pence);
      }
      if (set.size === 0) continue; // this prior letter said nothing about the head; try an older one
      if (!set.has(a.pence) && !seenHeads.has(head)) {
        seenHeads.add(head);
        const when = prior.sentAt ?? prior.approvedAt ?? prior.createdAt;
        flags.push(
          flag('CONTRADICTS_PRIOR_LETTER', 'warn',
            `Draft puts ${HEAD_LABEL[head]} at ${formatGBP(a.pence)}; the last document sent for this head ("${prior.title}", ${prior.templateId}, ${formatLongDate(when)}) put it at ${[...set].map((p) => formatGBP(p)).join(' / ')}. If the figure has legitimately changed, say so in the letter and clear this flag with the reason.`,
            { draftValue: formatGBP(a.pence), ledgerValue: [...set].map((p) => formatGBP(p)).join(' / '), excerpt: a.excerpt })
        );
      }
      break;
    }
  }
  return flags;
}

const FOS_RE = /\bfinancial\s+ombudsman(?:\s+service)?\b|\bFOS\b/gi;

export function forumChecks(text: string, ctx: DraftContext): ConsistencyFlag[] {
  const flags: ConsistencyFlag[] = [];
  if (inferRole(ctx) !== 'at_fault_insurer') return flags;
  FOS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FOS_RE.exec(text)) !== null) {
    flags.push(
      flag('FORUM_NOT_OPEN', 'block',
        `"${m[0]}" is not a forum open to this claimant against the at-fault insurer: a third-party claimant is not an eligible complainant (DISP 2.7). Threatening it devalues the letter. Use the DISP 1 complaint, ICOBS 8.1/8.2 and the pre-action route instead.`,
        { draftValue: m[0], excerpt: excerptAround(text, m.index, m[0].length) })
    );
  }
  return flags;
}

const GTA_LAW_PATTERNS: RegExp[] = [
  /\bentitled\s+(?:to\s+[^.]{0,40}?\s+)?under\s+the\s+GTA\b/gi,
  /\bthe\s+GTA\s+(?:requires|obliges|entitles|mandates|provides\s+that\s+you\s+must)\b/gi,
  /\bpursuant\s+to\s+(?:the\s+)?GTA\b/gi,
  /\bin\s+accordance\s+with\s+(?:the\s+)?GTA(?:\s+(?:paragraph|para\.?|clause|section))?\b/gi,
  /\b(?:obliged|bound|required)\s+(?:by|under)\s+the\s+GTA\b/gi,
  /\bbreach\s+of\s+(?:the\s+)?GTA\b/gi,
  /\byour\s+obligations?\s+under\s+the\s+GTA\b/gi,
  /\bunder\s+(?:the\s+)?GTA(?:\s+(?:paragraph|para\.?|clause|section))?\s*[\d.]*(?:\([a-z]\))?\s*,?\s*(?:you\s+(?:are|must|have|will|shall)|payment\s+is|is\s+payable|are\s+payable|we\s+are\s+entitled)\b/gi,
  // "GTA 6.7 requires", "GTA paragraph 6.8.6 entitles", "GTA entitles"
  /\bGTA(?:\s+(?:paragraph|para\.?|clause|section))?\s*[\d.]*(?:\([a-z]\))?\s+(?:requires|obliges|entitles|mandates|compels)\b/gi,
  /\bGTA\s+(?:paragraph|para\.?|clause|section)\s*[\d.]+(?:\([a-z]\))?\s+(?:provides|states|says)\s+that\s+you\s+(?:must|are|shall)\b/gi
];
const GTA_BENCHMARK_RE = /benchmark|industry\s+practice|industry\s+standard/i;

export function gtaChecks(text: string, ctx: DraftContext): ConsistencyFlag[] {
  if (ctx.bundle.claim.gtaSubscriber !== false) return [];
  const matches: Array<{ index: number; length: number; text: string }> = [];
  for (const re of GTA_LAW_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const around = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
      if (GTA_BENCHMARK_RE.test(around)) continue;
      matches.push({ index: m.index, length: m[0].length, text: m[0] });
    }
  }
  // several patterns may hit one phrase ("the GTA requires" / "GTA requires"): keep the longest match at each position
  matches.sort((a, b) => a.index - b.index || b.length - a.length);
  const flags: ConsistencyFlag[] = [];
  let coveredTo = -1;
  for (const m of matches) {
    if (m.index < coveredTo) continue;
    coveredTo = m.index + m.length;
    flags.push(
      flag('GTA_CITED_AS_LAW', 'block',
        `"${normaliseSpace(m.text)}" asserts the GTA as a legal entitlement. CCGUK is not a GTA subscriber: under GTA 2.7(j) the agreement has no standing in law for claims outside it and is not to be cited as such in legal proceedings (paragraph wording to be verified against the 16 March 2026 text; kb gta.json carries the Verification record). Cite GTA rates and timescales only as an industry benchmark.`,
        { draftValue: normaliseSpace(m.text), excerpt: excerptAround(text, m.index, m.length) })
    );
  }
  return flags;
}

function citationKey(s: string): string {
  return s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
}

const GENERIC_NAME_TOKENS = new Set(['ltd', 'limited', 'plc', 'llp', 'insurance', 'insurer', 'group', 'uk', 'the', 'of', 'and', 'mr', 'mrs', 'ms', 'miss', 'dr']);

/** Significant lower-case tokens of the claim's own parties (claimant, driver, third parties, insurer). */
function ownPartyTokens(ctx: DraftContext): Set<string> {
  const b = ctx.bundle;
  const names = [b.claimant?.name, b.driver?.name, b.atFaultInsurer?.name, ...b.thirdParties.map((p) => p.name)].filter((n): n is string => !!n);
  const out = new Set<string>();
  for (const n of names) for (const t of n.toLowerCase().split(/[^a-z0-9'’]+/)) if (t.length > 2 && !GENERIC_NAME_TOKENS.has(t)) out.add(t);
  return out;
}

/** "Hussain v esure" in a letter heading is the claim, not an authority. */
function isOwnPartyCaseName(caseName: string, own: Set<string>): boolean {
  const sides = caseName.toLowerCase().split(/\s+v\.?\s+/);
  if (sides.length !== 2) return false;
  return sides.some((side) => side.split(/[^a-z0-9'’]+/).some((t) => t.length > 2 && own.has(t)));
}

export function citationChecks(text: string, ctx: DraftContext): ConsistencyFlag[] {
  const flags: ConsistencyFlag[] = [];
  const found = extractCitations(text);
  if (found.length === 0) return flags;
  const kb = (ctx.kbCitations ?? []).map((c) => ({ key: citationKey(c.citation), verified: c.verified }));
  const own = ownPartyTokens(ctx);
  const seen = new Set<string>();
  for (const c of found) {
    const key = citationKey(c.citation);
    if (seen.has(key)) continue;
    seen.add(key);
    if (c.kind === 'case_name' && c.caseName && isOwnPartyCaseName(c.caseName, own)) continue;
    let matched: { key: string; verified: boolean } | undefined;
    if (c.neutral) {
      const nk = citationKey(c.neutral);
      matched = kb.find((k) => k.key.includes(nk));
    }
    if (!matched && c.caseName) {
      // case name: match "X v Y" by the first word of each side
      const parts = citationKey(c.caseName).split(/\s+v\.?\s+/);
      const a = parts[0]?.split(' ')[0] ?? '';
      const b = parts[1]?.split(' ')[0] ?? '';
      if (a && b) matched = kb.find((k) => k.key.includes(a) && k.key.includes(b) && /\sv\.?\s/.test(` ${k.key} `));
    }
    if (matched?.verified) continue;
    flags.push(
      flag('UNVERIFIED_CITATION', 'warn',
        matched
          ? `Citation "${c.citation}" is in the knowledge base but not verified against Find Case Law/BAILII. Verify (record the source URL) before it goes out.`
          : `Citation "${c.citation}" is not in the knowledge base. Verify it on Find Case Law or BAILII and add it with its source before relying on it.`,
        { draftValue: c.citation, excerpt: c.excerpt })
    );
  }
  return flags;
}

const REF_RE = /\b(?:your|insurer|claim|policy)\s+ref(?:erence)?\.?\s*(?:no\.?|number)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\/\-]{4,})/gi;

export function referenceChecks(text: string, ctx: DraftContext): ConsistencyFlag[] {
  const flags: ConsistencyFlag[] = [];
  const expected = ctx.bundle.claim.atFaultInsurerRef;
  if (!expected || inferRole(ctx) !== 'at_fault_insurer') return flags;
  const norm = (s: string) => s.toUpperCase().replace(/[\s\-\/]/g, '');
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(text)) !== null) {
    const ref = m[1] ?? '';
    if (norm(ref) === norm(expected) || norm(ref) === norm(ctx.bundle.claim.reference)) continue;
    flags.push(
      flag('UNKNOWN_REFERENCE', 'warn',
        `Draft quotes the insurer reference "${ref}" but the claim records "${expected}". A wrong reference sends the letter to the wrong file.`,
        { draftValue: ref, ledgerValue: expected, excerpt: excerptAround(text, m.index, m[0].length) })
    );
  }
  return flags;
}

// ---------------------------------------------------------------------------

export function isBlocked(flags: ConsistencyFlag[]): boolean {
  return flags.some((f) => f.severity === 'block' && !f.clearedAt);
}

function dedupe(flags: ConsistencyFlag[]): ConsistencyFlag[] {
  const seen = new Set<string>();
  const out: ConsistencyFlag[] = [];
  for (const f of flags) {
    const key = `${f.code}|${f.severity}|${f.excerpt ?? ''}|${f.draftValue ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  const order: Record<ConsistencyFlag['severity'], number> = { block: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Run every check against a draft (HTML or plain text) and return the report. */
export function checkDraft(text: string, ctx: DraftContext): ConsistencyReport {
  const plain = toPlainText(text);
  const amounts = extractAmounts(plain);
  const flags: ConsistencyFlag[] = [
    ...amountChecks(plain, amounts, ctx),
    ...deadlineChecks(plain, ctx),
    ...offerChecks(plain, ctx),
    ...storageChecks(plain, ctx),
    ...hireChecks(plain, ctx),
    ...payeeChecks(plain, ctx),
    ...creationDateChecks(plain, ctx),
    ...signatureDateChecks(ctx.bundle.documents, ctx.bundle.claim.id).filter((f) => f.code === 'DUPLICATE_SIGNATURE_DATE'),
    ...priorLetterChecks(plain, amounts, ctx),
    ...legacyCheck(plain),
    ...bannedPhraseCheck(plain),
    ...forumChecks(plain, ctx),
    ...gtaChecks(plain, ctx),
    ...citationChecks(plain, ctx),
    ...referenceChecks(plain, ctx)
  ];
  const deduped = dedupe(flags);
  return { checkedAt: ctx.now ?? ctx.draftCreatedAt, flags: deduped, blocked: isBlocked(deduped) };
}

/**
 * Clear a flag (by code, and excerpt when given) with a reason — returns a new report; the input is not mutated.
 * The approver's reason is itself logged on the flag (BLUEPRINT §3.7).
 */
export function clearFlag(report: ConsistencyReport, code: ConsistencyCode, excerpt: string | undefined, by: string, reason: string, at: ISODateTime): ConsistencyReport {
  if (!reason || !reason.trim()) throw new Error('A reason is required to clear a consistency flag');
  const flags = report.flags.map((f) => {
    const matches = f.code === code && (excerpt === undefined || f.excerpt === excerpt) && !f.clearedAt;
    return matches ? { ...f, clearedBy: by, clearedReason: reason.trim(), clearedAt: at } : { ...f };
  });
  return { checkedAt: report.checkedAt, flags, blocked: isBlocked(flags) };
}

export { extractAmounts, extractDates, extractDeadlines, extractCitations };
