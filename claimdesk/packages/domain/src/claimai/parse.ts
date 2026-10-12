// owned by claimai-server
/**
 * The deterministic phrase parser (docs/CLAIM-AI-INPUT.md §3.3): the owner's update → clauses → actions, with no AI.
 * It covers common phrasings only; a clause it does not fully understand goes to the AI (or waits for it). Tiers come
 * from `tiers.ts` (never from the pattern); every action quotes the clause it came from.
 *
 * Clauses: split on sentence ends, `;` and new lines, and on `, ` / ` and ` / ` then ` when both sides contain a verb
 * ("car repaired, hire ended yesterday" is two clauses). Date sharing: a clause without its own date inherits the single
 * date stated elsewhere in the same sentence (not for calls or notes, which default to today), and says so.
 * A clause counts as understood only when the matched pattern (plus its date) leaves nothing that matters behind
 * ("TP insurer admitted liability on the phone today, ref AB123": the reference is left → the AI reads it).
 */
import { SENSITIVE_FIELD_TARGETS } from '../agents/types.js';
import { parseGBP } from '../money.js';
import type { ISODateTime } from '../types.js';
import { COPY, actionTitle } from './copy.js';
import { addWeekdays, eventAtFor, findAllDatePhrases, fmtDayShort, nineAm, startOfLondonDay, londonWallIso, londonToday, type FoundDate } from './dates.js';
import { holdFor } from './instructions.js';
import { DEFAULT_TIER_CONTEXT, tierFor, type TierContext } from './tiers.js';
import {
  ACCUSATION_WORDS,
  SIDE_EFFECT_EVENT_TYPES,
  type ActionParams,
  type ActionSource,
  type ActionFrom,
  type ActionType,
  type ContactRole,
  type EditableField,
  type InstructionView,
  type PlannedAction,
  type Question,
  type QuestionAnswer,
} from './types.js';

export interface ParseContext {
  now: ISODateTime;
  openHires: Array<{ id: string; agreementNumber: string; startAt: string }>;
  insurerName: string | null;
  clientFirstName: string | null;
  evidence: Array<{ id: string; kind: string; filename: string; createdAt: string }>;
  templates: Array<{ id: string; title: string }>;
  /** Answers to earlier questions, by question id. */
  answers?: Record<string, QuestionAnswer>;
  /** Standing instructions in force now (a chase is refused while the contact is held). */
  instructions?: InstructionView[];
  /** Values on file now, by field target (overwrite detection and the "current" column). */
  fieldValues?: Partial<Record<string, string | null>>;
  liability?: string | null;
}

export interface ParseResult {
  clauses: Array<{ text: string; matched: boolean; actions: string[] }>;
  actions: PlannedAction[];
  questions: Question[];
  /** matched / clauses (1 when there is no clause). */
  coverage: number;
  privateNote: boolean;
}

// ---------------------------------------------------------------------------
// Shared action builder (parse, catch-up and the API's validation use it)
// ---------------------------------------------------------------------------

const EDITABLE: Partial<Record<ActionType, EditableField[]>> = {
  event: ['at'],
  note: ['text'],
  field_update: ['value'],
  hire_end: ['at'],
  hire_correct: ['at'],
  task: ['dueAt', 'text'],
  instruction: ['text', 'until', 'appliesTo'],
  record_correspondence: ['at'],
};

export interface BuildActionInput {
  key: string;
  type: ActionType;
  params: ActionParams;
  quote: string | null;
  source: ActionSource;
  from: ActionFrom;
  confidence: number;
  detail?: string | null;
  tier?: Partial<TierContext>;
  title?: string;
  link?: string | null;
}

/** Undo availability of a type (§6.1 "Undo"). */
export function undoFor(type: ActionType, params: ActionParams): { undoable: boolean; undoWhy: string | null } {
  switch (type) {
    case 'event':
      return params.eventType && SIDE_EFFECT_EVENT_TYPES.has(params.eventType) ? { undoable: false, undoWhy: COPY.sideEffectUndo } : { undoable: true, undoWhy: null };
    case 'note':
    case 'field_update':
    case 'liability_position':
    case 'hire_end':
    case 'hire_correct':
    case 'task':
    case 'instruction':
    case 'pause_agents':
    case 'resume_agents':
    case 'run_job':
    case 'money':
    case 'offer_decision':
    case 'legal':
    case 'close_or_decline':
    case 'record_correspondence':
    case 'status_change':
      return { undoable: true, undoWhy: null };
    case 'file_evidence':
      return { undoable: false, undoWhy: COPY.evidenceWriteOnce };
    case 'offer_received':
      return { undoable: false, undoWhy: 'Recorded offers are corrected on the Offers screen' };
    default:
      return { undoable: false, undoWhy: null };
  }
}

export function buildAction(i: BuildActionInput): PlannedAction {
  const t = tierFor(i.type, i.params, { ...DEFAULT_TIER_CONTEXT, from: i.from, confidence: i.confidence, ...i.tier });
  const type: ActionType = t.tier === 'private' && i.type !== 'private_note' ? 'private_note' : i.type;
  const params: ActionParams = type !== i.type ? { text: i.quote ?? '' } : i.params;
  const { undoable, undoWhy } = undoFor(type, params);
  return {
    key: i.key,
    type,
    tier: t.tier,
    ticked: t.ticked,
    tickable: t.tickable,
    title: type !== i.type ? actionTitle('private_note', params) : (i.title ?? actionTitle(type, params)),
    detail: i.detail ?? null,
    why: t.why,
    quote: i.quote,
    source: i.source,
    from: i.from,
    confidence: Math.max(0, Math.min(1, i.confidence)),
    params,
    editable: t.tier === 'refused' || t.tier === 'private' ? [] : (EDITABLE[type] ?? []),
    undoable: t.tier === 'refused' || t.tier === 'private' || t.tier === 'open_screen' ? false : undoable,
    undoWhy,
    link: i.link ?? null,
  };
}

// ---------------------------------------------------------------------------
// Clauses
// ---------------------------------------------------------------------------

const VERB_RE =
  /\b(called|calls|rang|phoned|spoke|talked|repaired|fixed|done|complete|completed|finished|ended|stopped|started|began|begun|delayed|ordered|arrived|came|returned|got|collected|recovered|towed|inspected|instructed|received|admitted|accepted|denied|disputed|chase|chasing|contact|contacting|email|emailing|send|sent|ask|asked|pause|resume|unpause|review|remind|ring|call|draft|write|prepare|offered|offering|paid|decline|declined|close|settle|drop|written|lying|lied|look|replan|re-plan|follow|request|keep|said|says|wants|went|gone|need|needs|issue|issued|issuing|sue|suing|complain|complained|is|was|has|have|had)\b/i;

const hasVerb = (s: string): boolean => VERB_RE.test(s);

export interface Clause {
  text: string;
  sentence: number;
  /** Offset of the clause in the original text. */
  index: number;
}

/** Split the owner's text into clauses (exported for tests). */
export function splitClauses(text: string): Clause[] {
  const out: Clause[] = [];
  // Sentence ends: . ! ? followed by space or end; ; and new lines always.
  const sentences: Array<{ text: string; index: number }> = [];
  let start = 0;
  const boundary = /([.!?]+)(?=\s|$)|[;\n]/g;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(text))) {
    const end = m.index + m[0].length;
    // do not split "£3,450.00" or "No. 5" style dots inside tokens (handled by the lookahead) — keep simple
    sentences.push({ text: text.slice(start, end), index: start });
    start = end;
  }
  if (start < text.length) sentences.push({ text: text.slice(start), index: start });
  sentences.forEach((s, si) => {
    const parts: Array<{ text: string; index: number; sep: string }> = [];
    const sepRe = /,\s+|\s+and\s+|\s+then\s+|,?\s+but\s+/gi;
    let last = 0;
    let sm: RegExpExecArray | null;
    while ((sm = sepRe.exec(s.text))) {
      parts.push({ text: s.text.slice(last, sm.index), index: s.index + last, sep: sm[0] });
      last = sm.index + sm[0].length;
    }
    parts.push({ text: s.text.slice(last), index: s.index + last, sep: '' });
    let cur: { text: string; index: number } | null = null;
    let pendingSep = '';
    for (const p of parts) {
      if (!cur) {
        cur = { text: p.text, index: p.index };
      } else if (hasVerb(cur.text) && hasVerb(p.text)) {
        out.push({ text: cur.text, sentence: si, index: cur.index });
        cur = { text: p.text, index: p.index };
      } else {
        cur = { text: cur.text + pendingSep + p.text, index: cur.index };
      }
      pendingSep = p.sep;
    }
    if (cur) out.push({ text: cur.text, sentence: si, index: cur.index });
  });
  return out
    .map((c) => {
      const lead = c.text.length - c.text.trimStart().length;
      return { ...c, text: c.text.trim().replace(/[.!?;,]+$/, '').trim(), index: c.index + lead };
    })
    .filter((c) => c.text.length > 0);
}

// ---------------------------------------------------------------------------
// Who
// ---------------------------------------------------------------------------

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function whoPattern(ctx: ParseContext): string {
  const names = [ctx.clientFirstName, ctx.insurerName].filter((x): x is string => Boolean(x && x.trim().length > 1)).map((x) => esc(x.trim()));
  return `(?:the client|client|them|her|him|the tp insurers?|tp insurers?|the third[- ]party insurers?|third[- ]party insurers?|the other side|their insurers?|the insurers?|insurers?|the engineers?|engineers?|the garage|garage|the repairers?|repairers?|the bodyshop|bodyshop|the solicitors?|solicitors?|anyone|anybody${names.length ? `|${names.join('|')}` : ''})`;
}

function roleOf(who: string, ctx: ParseContext): ContactRole {
  const w = who.toLowerCase().trim();
  if (ctx.insurerName && w === ctx.insurerName.toLowerCase().trim()) return 'at_fault_insurer';
  if (ctx.clientFirstName && w === ctx.clientFirstName.toLowerCase().trim()) return 'client';
  if (/insurer|other side/.test(w)) return 'at_fault_insurer';
  if (/engineer/.test(w)) return 'engineer';
  if (/garage|repairer|bodyshop/.test(w)) return 'repairer';
  if (/solicitor/.test(w)) return 'solicitor';
  if (/anyone|anybody/.test(w)) return 'anyone';
  return 'client';
}

const INSURER_CONTEXT = (ctx: ParseContext): RegExp =>
  new RegExp(`\\b(?:insurers?|tp|third[- ]party|their|handling|other side${ctx.insurerName ? `|${esc(ctx.insurerName)}` : ''})\\b`, 'i');

// ---------------------------------------------------------------------------
// Leftovers
// ---------------------------------------------------------------------------

const STOP = new Set(
  'the a an to on in at of and for with has have had is was were been be it its they them he she her his their we us our me i my just now also please so that this as by from about said says then already still until till today yesterday tomorrow ok okay mr mrs ms client clients back up there here all yes no not today morning afternoon evening tonight week next last day days phone called call too again well'.split(
    ' ',
  ),
);

/** Does anything that matters remain once the matched spans are taken out? */
function leftoverMatters(clause: string, spans: Array<[number, number]>, ctx: ParseContext): boolean {
  let s = clause;
  for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0])) s = s.slice(0, a) + ' ' + s.slice(b);
  const extra = new Set([ctx.clientFirstName?.toLowerCase(), ...(ctx.insurerName?.toLowerCase().split(/\s+/) ?? [])].filter((x): x is string => Boolean(x)));
  const tokens = s
    .toLowerCase()
    .replace(/[^a-z0-9£'\s/-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^'+|'+$/g, ''))
    .filter((t) => t && !STOP.has(t) && !extra.has(t) && !/^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day)?$/.test(t));
  if (tokens.some((t) => /\d/.test(t))) return true;
  return tokens.length >= 3;
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

interface Built {
  actions: Array<Omit<BuildActionInput, 'key' | 'source' | 'from' | 'confidence' | 'quote'> & { quote?: string | null }>;
  questions: Array<Omit<Question, 'id'> & { idSuffix: string }>;
  spans: Array<[number, number]>;
  /** The whole clause is understood whatever is left (private notes, notes). */
  whole?: boolean;
  /** This clause used its date (so a shared date is not reported twice). */
  usedDate?: FoundDate | null;
}

interface PatternEnv {
  ctx: ParseContext;
  clause: Clause;
  /** The clause's own date (past sense) or the sentence's single date. */
  pastDate: { d: FoundDate; shared: boolean } | null;
  futureDate: FoundDate | null;
  answer: (suffix: string) => QuestionAnswer | undefined;
  qid: (suffix: string) => string;
  repairInInput: boolean;
  who: string;
  /** The sentence mentions the insurer (a bare "ref AB123" clause belongs to it). */
  sentenceInsurer: boolean;
}

type Pattern = { id: string; re: (ctx: ParseContext) => RegExp; build: (m: RegExpExecArray, env: PatternEnv) => Built | null };

const span = (m: RegExpExecArray): [number, number] => [m.index, m.index + m[0].length];
const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

function eventAction(env: PatternEnv, eventType: string, m: RegExpExecArray, opts: { defaultToday?: boolean; summary?: string } = {}): Built | null {
  const { ctx, clause } = env;
  const pd = env.pastDate;
  const own = pd && !pd.shared ? pd.d : null;
  const date = eventType === 'call' || eventType === 'note' ? own : pd?.d ?? null;
  const at = date ? date.at : londonWallIso(londonToday(ctx.now));
  const precision = date ? date.precision : 'date';
  if (Date.parse(at) > Date.parse(ctx.now) + 3_600_000) {
    return { actions: [], questions: [{ idSuffix: 'future', text: COPY.futureDate, options: [], allowText: false, allowDate: true, about: null }], spans: [span(m)] };
  }
  const detail = date && pd?.shared && date === pd.d ? `date taken from '${pd.d.text}'` : !date ? 'no date given — today' : null;
  return {
    actions: [{ type: 'event', params: { eventType, at: eventAtFor(at, precision, ctx.now), precision, summary: opts.summary ?? cap(clause.text) }, detail }],
    questions: [],
    spans: [span(m), ...(date && !pd?.shared ? ([[date.index - clause.index, date.index - clause.index + date.length]] as Array<[number, number]>) : [])],
    usedDate: date,
  };
}

function dateSpan(d: FoundDate | null, clause: Clause): Array<[number, number]> {
  if (!d) return [];
  const a = d.index - clause.index;
  return a >= 0 && a < clause.text.length ? [[a, a + d.length]] : [];
}

/** The insurer's reference as typed ("ref AB123", "their reference is TPI/7788 12"). */
const INSURER_REF_RE = /\b(?:their\s+|insurer'?s?\s+|claim\s+|handling\s+)?(?:ref|reference|claim number)(?:\s+is|\s+no\.?|\s*:)?\s+((?=[A-Z0-9/\- ]*\d)[A-Z0-9][A-Z0-9/\-]{1,}(?:\s(?=[A-Z/\-]*\d)[A-Z0-9/\-]+)?)/i;

/** P14's actions: the reference as a field (+ "handling reference received" when none is on file yet). */
function insurerRefActions(raw: string, env: PatternEnv): Built['actions'] {
  const value = raw.toUpperCase();
  const actions: Built['actions'] = [{ type: 'field_update', params: { target: 'claim.atFaultInsurerRef', value } }];
  if (!env.ctx.fieldValues?.['claim.atFaultInsurerRef']) {
    const today = londonWallIso(londonToday(env.ctx.now));
    actions.push({ type: 'event', params: { eventType: 'handling_ref_received', at: eventAtFor(today, 'date', env.ctx.now), precision: 'date', summary: `Handling reference ${value} received` } });
  }
  return actions;
}

function untilFromAnswer(a: QuestionAnswer | undefined, now: ISODateTime): { until: string | null } | undefined {
  if (!a) return undefined;
  if (a.date) return { until: startOfLondonDay(new Date(Date.parse(a.date.length === 10 ? `${a.date}T12:00:00Z` : a.date)).toISOString()) };
  if (a.optionId === 'until_say') return { until: null };
  const today = londonToday(now);
  if (a.optionId === 'monday') {
    const n = ((1 - today.weekday + 7) % 7) || 7;
    return { until: startOfLondonDay(new Date(Date.parse(londonWallIso(today, 12)) + n * 86_400_000).toISOString()) };
  }
  if (a.optionId === 'week') return { until: startOfLondonDay(new Date(Date.parse(londonWallIso(today, 12)) + 7 * 86_400_000).toISOString()) };
  return undefined;
}

const UNTIL_OPTIONS = [
  { id: 'monday', label: COPY.untilMonday },
  { id: 'week', label: COPY.aWeek },
  { id: 'until_say', label: COPY.untilISay },
];

const DOC_KINDS: Array<{ re: RegExp; kinds: string[]; file: RegExp; label: string }> = [
  { re: /engineer'?s? report/i, kinds: ['engineer_report'], file: /engineer/i, label: 'the engineer report' },
  { re: /police report/i, kinds: [], file: /police/i, label: 'the police report' },
  { re: /estimate/i, kinds: ['estimate'], file: /estimate|quote/i, label: 'the estimate' },
  { re: /photo/i, kinds: ['photo'], file: /\.(jpe?g|png|heic|webp)$/i, label: 'the photos' },
  { re: /v5c?/i, kinds: ['v5c'], file: /v5c/i, label: 'the V5C' },
  { re: /licen[cs]e/i, kinds: ['licence'], file: /licen[cs]e/i, label: 'the licence' },
  { re: /invoice/i, kinds: ['invoice'], file: /invoice/i, label: 'the invoice' },
  { re: /latest letter|letter/i, kinds: ['correspondence'], file: /letter/i, label: 'the latest letter' },
];

/** Kind keywords → the newest matching evidence (and how many matched). */
export function resolveDocument(hint: string, evidence: ParseContext['evidence']): { evidence: ParseContext['evidence'][number] | null; count: number; label: string } {
  const d = DOC_KINDS.find((k) => k.re.test(hint));
  if (!d) return { evidence: null, count: 0, label: hint };
  const hits = evidence.filter((e) => d.kinds.includes(e.kind) || d.file.test(e.filename)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return { evidence: hits[0] ?? null, count: hits.length, label: d.label };
}

const MONEY = String.raw`£\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;

function pence(raw: string): number | null {
  return parseGBP(`£${raw.replace(/\s/g, '')}`);
}

function templateMatch(words: string, templates: ParseContext['templates']): ParseContext['templates'][number] | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const w = norm(words);
  if (!w) return null;
  const sig = (s: string) => norm(s).split(' ').filter((t) => t.length > 2 && !['the', 'and', 'for', 'your', 'our', 'letter', 'email', 'from', 'with', 'about', 'request'].includes(t));
  let best: { t: ParseContext['templates'][number]; score: number } | null = null;
  for (const t of templates) {
    const title = norm(t.title);
    if (title && (w.includes(title) || title.includes(w))) return t;
    const a = new Set(sig(t.title));
    const b = sig(words);
    const score = b.filter((x) => a.has(x)).length;
    if (score >= 2 && (!best || score > best.score)) best = { t, score };
  }
  return best?.t ?? null;
}

function patterns(): Pattern[] {
  return [
    // P32 — accusation words: kept as a private note only, never acted on.
    {
      id: 'P32',
      re: () => ACCUSATION_WORDS,
      build: (_m, env) => ({ actions: [{ type: 'private_note', params: { text: env.clause.text } }], questions: [], spans: [], whole: true }),
    },
    // P26 — a plain note
    {
      id: 'P26',
      re: () => /^(?:note[:\s-]+|just (?:a )?note[:\s,-]*|fyi[:\s,-]*)/i,
      build: (m, env) => {
        const rest = env.clause.text.slice(m[0].length).trim();
        if (!rest) return null;
        return { actions: [{ type: 'note', params: { summary: cap(rest), text: cap(rest), eventType: 'note' } }], questions: [], spans: [], whole: true };
      },
    },
    // P27 — the client has a solicitor
    {
      id: 'P27',
      re: () => /\b(?:client|they|she|he)\s+(?:now\s+)?(?:has|have|got|has got|instructed)\s+(?:a\s+|an?\s+)?(?:solicitors?|lawyers?)\b/i,
      build: (m) => ({
        actions: [
          { type: 'legal', params: { matter: 'solicitor', summary: 'The client has a solicitor' }, title: 'Legal: the client has a solicitor — goes to Needs-you' },
          { type: 'instruction', params: { text: COPY.solicitorHold, appliesTo: ['all'], effect: { kind: 'hold_contact', contacts: ['client'] }, until: null } },
          { type: 'note', params: { summary: 'The client now has a solicitor', text: 'The client now has a solicitor', eventType: 'note' } },
        ],
        questions: [],
        spans: [span(m)],
      }),
    },
    // P17 — hold contact
    {
      id: 'P17',
      re: (ctx) => new RegExp(`\\b(?:don'?t|do not|dont|stop|no)\\s+(?:chas(?:e|ing)|contact(?:ing)?|e-?mail(?:ing)?|call(?:ing)?|ring(?:ing)?|phon(?:e|ing)|writ(?:e|ing) to|send(?:ing)?(?: anything)? to)\\s+(${whoPattern(ctx)})`, 'i'),
      build: (m, env) => {
        const role = roleOf(m[1]!, env.ctx);
        const fd = env.futureDate;
        let until: string | null | undefined = fd && /\buntil|till|before\b/i.test(env.clause.text) ? startOfLondonDay(fd.at) : undefined;
        if (until === undefined) until = untilFromAnswer(env.answer('until'), env.ctx.now)?.until;
        if (until === undefined) {
          return { actions: [], questions: [{ idSuffix: 'until', text: COPY.untilWhen, options: UNTIL_OPTIONS, allowText: false, allowDate: true, about: null }], spans: [span(m), ...dateSpan(fd, env.clause)] };
        }
        const text = cap(env.clause.text);
        return {
          actions: [{ type: 'instruction', params: { text, appliesTo: ['all'], effect: { kind: 'hold_contact', contacts: [role] }, until } }],
          questions: [],
          spans: [span(m), ...dateSpan(fd, env.clause)],
        };
      },
    },
    // P18 — ask me before sending
    {
      id: 'P18',
      re: (ctx) => new RegExp(`\\bask\\s+(?:me|first)\\s+before\\s+(?:sending|emailing|writing)(?:\\s+anything)?(?:\\s+(?:to|out to))?\\s+(${whoPattern(ctx)})`, 'i'),
      build: (m, env) => ({
        actions: [{ type: 'instruction', params: { text: cap(env.clause.text), appliesTo: ['all'], effect: { kind: 'ask_before_sending', contacts: [roleOf(m[1]!, env.ctx)] }, until: env.futureDate ? startOfLondonDay(env.futureDate.at) : null } }],
        questions: [],
        spans: [span(m), ...dateSpan(env.futureDate, env.clause)],
      }),
    },
    // P19 — pause / resume
    {
      id: 'P19',
      re: () => /\b(?:pause|hold)\s+(?:(?:this|the)\s+)?(?:claim|agents|autopilot|file)\b|\b(?:resume|unpause|un-pause|carry on with)\s+(?:(?:this|the)\s+)?(?:claim|agents|autopilot|file)\b/i,
      build: (m, env) => {
        if (/^(?:resume|unpause|un-pause|carry)/i.test(m[0])) return { actions: [{ type: 'resume_agents', params: {} }], questions: [], spans: [span(m)] };
        const until = env.futureDate ? startOfLondonDay(env.futureDate.at) : null;
        const reason = cap(env.clause.text);
        const actions: Built['actions'] = [{ type: 'pause_agents', params: { reason, until } }];
        if (until) actions.push({ type: 'instruction', params: { text: reason, appliesTo: ['all'], effect: { kind: 'pause_agents' }, until } });
        return { actions, questions: [], spans: [span(m), ...dateSpan(env.futureDate, env.clause)] };
      },
    },
    // P12 — the other side admitted liability
    {
      id: 'P12',
      re: (ctx) =>
        new RegExp(`\\b(?:tp|third[- ]party|their|the other side'?s?|the insurers?${ctx.insurerName ? `|${esc(ctx.insurerName)}` : ''})(?:\\s+insurers?)?\\s+(?:has\\s+|have\\s+)?(?:admitted|accepted)\\s+liability(?:\\s+(?:on|over)\\s+the\\s+phone|\\s+by\\s+phone|\\s+in\\s+a\\s+call)?`, 'i'),
      build: (m, env) => {
        const ctx = env.ctx;
        const insurer = ctx.insurerName ?? 'the insurer';
        const phone = /phone|call|rang/i.test(env.clause.text);
        const date = env.pastDate && !env.pastDate.shared ? env.pastDate.d : null;
        const at = date ? date.at : londonWallIso(londonToday(ctx.now));
        const precision = date?.precision ?? 'date';
        const evAt = eventAtFor(at, precision, ctx.now);
        const ref = INSURER_REF_RE.exec(env.clause.text);
        return {
          actions: [
            { type: 'liability_position', params: { value: 'admitted', current: ctx.liability ?? 'unknown' }, detail: phone ? 'said on the phone' : null },
            phone
              ? { type: 'event', params: { eventType: 'call', at: evAt, precision, summary: `${insurer} admitted liability on the phone` } }
              : { type: 'note', params: { eventType: 'note', at: evAt, precision, summary: `${insurer} admitted liability`, text: `${insurer} admitted liability` } },
            { type: 'task', params: { taskKind: 'follow_up', dueAt: addWeekdays(ctx.now, 2), note: COPY.askConfirmInWriting(insurer) } },
            // "… admitted liability today, ref AB123": the reference in the same clause is the insurer's (P14).
            ...(ref ? insurerRefActions(ref[1]!, env) : []),
          ],
          questions: [],
          spans: [span(m), ...dateSpan(date, env.clause), ...(ref ? [span(ref)] : [])],
          usedDate: date,
        };
      },
    },
    // P13 — liability denied / disputed / split
    {
      id: 'P13',
      re: () => /\bliability\s+(?:is\s+|was\s+|has\s+been\s+|now\s+)?(denied|disputed|split(?:\s+(\d{1,3})\s*\/\s*(\d{1,3}))?)\b/i,
      build: (m, env) => {
        const pos = m[1]!.toLowerCase().startsWith('split') ? 'split' : m[1]!.toLowerCase();
        return {
          actions: [
            { type: 'liability_position', params: { value: pos, current: env.ctx.liability ?? 'unknown' }, detail: m[2] ? `split ${m[2]}/${m[3]}` : null },
            { type: 'note', params: { eventType: 'note', summary: cap(env.clause.text), text: cap(env.clause.text) } },
          ],
          questions: [],
          spans: [span(m), ...dateSpan(env.pastDate?.d ?? null, env.clause)],
        };
      },
    },
    // P30 — accept / reject / counter an offer
    {
      id: 'P30',
      re: () => /\b(accept|reject|counter)(?:ed)?\s+(?:the\s+|their\s+)?offer\b/i,
      build: (m) => ({ actions: [{ type: 'offer_decision', params: { value: m[1]!.toLowerCase() } }], questions: [], spans: [span(m)], whole: true }),
    },
    // P28 — an offer received
    {
      id: 'P28',
      re: () => new RegExp(`\\b(?:offered|offer of|offering)\\s+(?:us\\s+|the client\\s+)?${MONEY}`, 'i'),
      build: (m, env) => {
        const amount = pence(m[1]!);
        if (amount === null) return null;
        const register = /replacement (?:car|vehicle)|courtesy car/i.test(env.clause.text) ? 'intervention' : 'settlement';
        return {
          actions: [
            { type: 'offer_received', params: { amountPence: amount, register, offeror: env.ctx.insurerName ?? 'the insurer' } },
            { type: 'note', params: { eventType: 'note', summary: cap(env.clause.text), text: cap(env.clause.text) } },
          ],
          questions: [],
          spans: [],
          whole: true,
        };
      },
    },
    // P29 — money paid / received
    {
      id: 'P29',
      re: () => new RegExp(`\\b(?:paid|payment(?:\\s+of)?|received|sent us|cheque for)\\s+(?:us\\s+)?${MONEY}`, 'i'),
      build: (m, env) => {
        const amount = pence(m[1]!);
        if (amount === null) return null;
        const head = /\bhire\b/i.test(env.clause.text) ? 'hire' : /storage/i.test(env.clause.text) ? 'storage' : /recovery/i.test(env.clause.text) ? 'recovery' : /repair/i.test(env.clause.text) ? 'repairs' : undefined;
        return { actions: [{ type: 'money', params: { amountPence: amount, ...(head ? { head } : {}), summary: cap(env.clause.text) } }], questions: [], spans: [], whole: true };
      },
    },
    // P31 — close / decline / legal steps
    {
      id: 'P31',
      re: () => /\b(?:close|decline|settle|drop)\s+(?:this|the|it)\b(?:\s+(?:claim|file))?|\bletter before (?:claim|action)\b|\bissue proceedings\b|\bcourt\b|\bpart 36\b|\bcomplaint to\b/i,
      build: (m) => {
        if (/^(?:close|decline|settle|drop)/i.test(m[0])) return { actions: [{ type: 'close_or_decline', params: { status: /^decline/i.test(m[0]) ? 'declined' : /^settle/i.test(m[0]) ? 'settled' : 'closed' } }], questions: [], spans: [], whole: true };
        return { actions: [{ type: 'legal', params: { matter: m[0].toLowerCase(), summary: cap(m[0]) } }], questions: [], spans: [], whole: true };
      },
    },
    // P15 — police reference (before P14: "police ref" is not the insurer's)
    {
      id: 'P15',
      re: () => /\bpolice\s+(?:ref(?:erence)?|crime number|incident number)(?:\s+is|\s*:)?\s*([A-Z0-9][A-Z0-9/\-]{2,})/i,
      build: (m) => ({ actions: [{ type: 'field_update', params: { target: 'claim.accident.policeReference', value: m[1]!.toUpperCase() } }], questions: [], spans: [span(m)] }),
    },
    // P14 — the insurer's reference
    {
      id: 'P14',
      re: () => INSURER_REF_RE,
      build: (m, env) => {
        if (!INSURER_CONTEXT(env.ctx).test(env.clause.text) && !env.sentenceInsurer) return null;
        return { actions: insurerRefActions(m[1]!, env), questions: [], spans: [span(m)] };
      },
    },
    // P16 — the client's new phone / email / address
    {
      id: 'P16',
      re: () => /\b(?:client'?s?|her|his|their)\s+(?:new\s+)?(phone|mobile|number|email|e-mail|address)\s*(?:is|=|:)\s*(.+)$/i,
      build: (m) => {
        const what = m[1]!.toLowerCase();
        const target = what === 'email' || what === 'e-mail' ? 'party:claimant.email' : what === 'address' ? 'party:claimant.address' : 'party:claimant.phone';
        return { actions: [{ type: 'field_update', params: { target, value: m[2]!.trim() } }], questions: [], spans: [], whole: true };
      },
    },
    // P1 — hire ended
    {
      id: 'P1',
      re: () => /\b(?:(?:the\s+)?hire\s+(?:has\s+|was\s+|is\s+)?(?:ended|finished|stopped|over|came to an end)|off[- ]hire|(?:car|vehicle)\s+(?:was\s+|has been\s+)?(?:handed|given|brought)\s+back(?:\s+to\s+us)?)\b/i,
      build: (m, env) => {
        const { ctx } = env;
        if (!ctx.openHires.length) return { actions: [{ type: 'unsupported', params: { reason: COPY.noRunningHire } }], questions: [], spans: [span(m), ...dateSpan(env.pastDate?.d ?? null, env.clause)] };
        let hire = ctx.openHires.length === 1 ? ctx.openHires[0]! : undefined;
        if (!hire) {
          const a = env.answer('hire');
          hire = a?.optionId ? ctx.openHires.find((h) => h.id === a.optionId) : undefined;
          if (!hire) {
            return {
              actions: [],
              questions: [{ idSuffix: 'hire', text: COPY.whichHire, options: ctx.openHires.map((h) => ({ id: h.id, label: h.agreementNumber })), allowText: false, allowDate: false, about: null }],
              spans: [span(m), ...dateSpan(env.pastDate?.d ?? null, env.clause)],
            };
          }
        }
        const pd = env.pastDate;
        const at = pd ? pd.d.at : londonWallIso(londonToday(ctx.now));
        const precision = pd ? pd.d.precision : 'date';
        if (Date.parse(at) > Date.parse(ctx.now) + 3_600_000) {
          return { actions: [], questions: [{ idSuffix: 'future', text: COPY.futureDate, options: [], allowText: false, allowDate: true, about: null }], spans: [span(m)] };
        }
        const detail = pd?.shared ? `date taken from '${pd.d.text}'` : !pd ? 'no date given — today' : null;
        return {
          actions: [{ type: 'hire_end', params: { hireId: hire.id, agreementNumber: hire.agreementNumber, startAt: hire.startAt, endAt: eventAtFor(at, precision, ctx.now), precision, endTrigger: env.repairInInput ? 'repair_complete_24h' : 'client_returned' }, detail }],
          questions: [],
          spans: [span(m), ...(pd && !pd.shared ? dateSpan(pd.d, env.clause) : [])],
          usedDate: pd?.d ?? null,
        };
      },
    },
    // P10 — total loss (before P2/P7: "written off" is not "repaired")
    { id: 'P10', re: () => /\b(?:written off|write[- ]off|total loss|cat(?:egory)? [sn])\b/i, build: (m, env) => eventAction(env, 'total_loss_confirmed', m) },
    { id: 'P2', re: () => REPAIRED_RE, build: (m, env) => eventAction(env, 'repair_completed', m) },
    { id: 'P3', re: () => /\b(?:repairs?\s+(?:have\s+|has\s+)?(?:started|began|begun)|(?:went|gone|is|has gone)\s+in\s+for\s+repairs?)\b/i, build: (m, env) => eventAction(env, 'repair_started', m) },
    { id: 'P4', re: () => /\b(?:repairs?|garage)\b.{0,20}\b(?:delay|delayed|waiting for parts)\b/i, build: (m, env) => eventAction(env, 'repair_delay', m) },
    {
      id: 'P5',
      re: () => /\bparts\s+(?:have\s+been\s+|were\s+|are\s+|have\s+|has\s+)?(?:(ordered|on order)|(arrived|came in|come in))\b/i,
      build: (m, env) => eventAction(env, m[1] ? 'parts_ordered' : 'parts_arrived', m),
    },
    {
      id: 'P6',
      re: () => /\b(?:(?:client|they|she|he)\s+(?:got|has|have|has got)\s+(?:her|his|their|the)\s+car\s+back|car\s+(?:was\s+|has been\s+)?returned\s+to\s+(?:the\s+)?client)\b/i,
      build: (m, env) => eventAction(env, 'vehicle_returned', m),
    },
    { id: 'P7', re: () => /\b(?:car|vehicle)\s+(?:was\s+|has\s+been\s+)?(?:collected|recovered|towed)\b/i, build: (m, env) => eventAction(env, 'recovery', m) },
    {
      id: 'P8',
      re: () => /\b(?:engineer\s+(?:has\s+)?(?:inspected|looked at|seen)(?:\s+it|\s+the car|\s+the vehicle)?|inspection\s+(?:was\s+)?(?:done|took place|carried out))\b|\b(engineer\s+(?:was\s+|has\s+been\s+)?instructed)\b/i,
      build: (m, env) => eventAction(env, m[1] ? 'engineer_instructed' : 'inspection', m),
    },
    { id: 'P9', re: () => /\bestimate\s+(?:was\s+|has\s+been\s+)?(?:received|came in|arrived|in)\b/i, build: (m, env) => eventAction(env, 'estimate_received', m) },
    // P20 — send a document
    {
      id: 'P20',
      re: (ctx) =>
        new RegExp(`\\bsend\\s+(?:the\\s+|a copy of the\\s+|a copy of\\s+|them the\\s+|him the\\s+|her the\\s+)?(engineer'?s?\\s+report|police report|estimate|photos?|v5c?|licen[cs]e|invoice|(?:the\\s+)?latest letter)\\s+(?:over\\s+)?to\\s+(${whoPattern(ctx)})`, 'i'),
      build: (m, env) => {
        const role = roleOf(m[2]!, env.ctx);
        const r = resolveDocument(m[1]!, env.ctx.evidence);
        let ev = r.evidence;
        const a = env.answer('doc');
        if (a?.optionId) ev = env.ctx.evidence.find((e) => e.id === a.optionId) ?? ev;
        if (!ev) {
          const opts = [...env.ctx.evidence].sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1)).slice(0, 6).map((e) => ({ id: e.id, label: e.filename }));
          return { actions: [], questions: [{ idSuffix: 'doc', text: COPY.whichDocument(r.label), options: opts, allowText: false, allowDate: false, about: null }], spans: [span(m)] };
        }
        const hold = env.ctx.instructions ? holdFor(env.ctx.instructions, role) : undefined;
        return {
          actions: [
            {
              type: 'run_job',
              params: { jobKind: 'send_document', recipient: role, evidenceIds: [ev.id], filename: ev.filename, documentHint: m[1]!, purpose: `send ${r.label}` },
              detail: r.count > 1 && !a?.optionId ? `newest of ${r.count}` : null,
              tier: { holdBlocks: hold?.text ?? null },
            },
          ],
          questions: [],
          spans: [span(m)],
        };
      },
    },
    // P21 — chase
    {
      id: 'P21',
      re: (ctx) => new RegExp(`\\bchase\\s+(?:up\\s+)?(${whoPattern(ctx)})(?:\\s+(?:up|now|today))?\\b`, 'i'),
      build: (m, env) => {
        const role = roleOf(m[1]!, env.ctx);
        const hold = env.ctx.instructions ? holdFor(env.ctx.instructions, role) : undefined;
        return { actions: [{ type: 'run_job', params: { jobKind: 'chase', emailKind: 'chaser', recipient: role, purpose: 'a chaser' }, tier: { holdBlocks: hold ? hold.text : null } }], questions: [], spans: [span(m)] };
      },
    },
    // P22 — ask someone for documents
    {
      id: 'P22',
      re: (ctx) => new RegExp(`\\bask\\s+(${whoPattern(ctx)})\\s+for\\s+(.+)$|\\brequest\\s+(.+?)\\s+from\\s+(${whoPattern(ctx)})`, 'i'),
      build: (m, env) => {
        const who = m[1] ?? m[4]!;
        const things = (m[2] ?? m[3]!).trim();
        const role = roleOf(who, env.ctx);
        const hold = env.ctx.instructions ? holdFor(env.ctx.instructions, role) : undefined;
        return { actions: [{ type: 'run_job', params: { jobKind: 'request_documents', emailKind: 'doc_request', recipient: role, purpose: things }, tier: { holdBlocks: hold ? hold.text : null } }], questions: [], spans: [], whole: true };
      },
    },
    // P23 — draft a letter
    {
      id: 'P23',
      re: (ctx) => new RegExp(`\\b(?:draft|write|prepare)\\s+(?:a\\s+|an\\s+|the\\s+)?(.+?)(?:\\s+to\\s+(${whoPattern(ctx)}))?$`, 'i'),
      build: (m, env) => {
        const words = m[1]!;
        const role = m[2] ? roleOf(m[2], env.ctx) : null;
        let t = templateMatch(words, env.ctx.templates);
        const a = env.answer('template');
        if (a?.optionId) t = env.ctx.templates.find((x) => x.id === a.optionId) ?? t;
        if (!t) {
          if (!/\b(?:letter|email|update|chaser|reply|notice)\b/i.test(words)) return null;
          return { actions: [], questions: [{ idSuffix: 'template', text: COPY.whichTemplate, options: env.ctx.templates.slice(0, 8).map((x) => ({ id: x.id, label: x.title })), allowText: false, allowDate: false, about: null }], spans: [], whole: true };
        }
        const hold = role && env.ctx.instructions ? holdFor(env.ctx.instructions, role) : undefined;
        return { actions: [{ type: 'run_job', params: { jobKind: 'draft_letter', templateId: t.id, recipient: role, purpose: t.title }, tier: { holdBlocks: hold ? hold.text : null } }], questions: [], spans: [], whole: true };
      },
    },
    // P24 — review / re-plan
    {
      id: 'P24',
      re: () => /\b(?:(review|look at)|(re-?plan|update the plan for))\s+(?:this|the)\s+(?:claim|file)\b/i,
      build: (m) => ({ actions: [{ type: 'run_job', params: { jobKind: m[1] ? 'review_now' : 'replan' } }], questions: [], spans: [span(m)] }),
    },
    // P25 — reminders
    {
      id: 'P25',
      re: (ctx) => new RegExp(`\\bremind me\\s+(?:to\\s+)?(.+)|\\b(?:call|ring|phone)\\s+(${whoPattern(ctx)})\\b|\\bfollow(?:\\s+|-)up\\b`, 'i'),
      build: (m, env) => {
        const fd = env.futureDate;
        if (!fd) return null;
        const dueAt = fd.precision === 'datetime' ? fd.at : nineAm(fd.at);
        const kind = m[1] ? 'other' : m[2] ? 'call' : 'follow_up';
        let what = m[1] ? m[1] : env.clause.text;
        const ds = fd.index - env.clause.index;
        if (m[1]) {
          // drop the date words from the reminder text
          what = env.clause.text.slice(m.index + m[0].length - m[1].length);
          const rel = ds - (m.index + m[0].length - m[1].length);
          if (rel >= 0) what = (what.slice(0, rel) + what.slice(rel + fd.length)).replace(/\s+/g, ' ').trim();
        }
        return { actions: [{ type: 'task', params: { taskKind: kind, dueAt, note: cap(what.replace(/\s+(?:on|at|by)$/i, '').trim()) } }], questions: [], spans: [], whole: true };
      },
    },
    // P11 — a call
    {
      id: 'P11',
      re: (ctx) => new RegExp(`\\b(?:(${whoPattern(ctx)})\\s+(?:has\\s+)?(?:called|rang|phoned|rung)|(?:spoke|talked|spoken)\\s+(?:to|with)\\s+(${whoPattern(ctx)})|on the phone)\\b`, 'i'),
      build: (m, env) => eventAction(env, 'call', m),
    },
  ];
}

const REPAIRED_RE = /\b(?:(?:car|vehicle)\s+(?:is\s+|was\s+|has\s+been\s+|got\s+|now\s+)?(?:repaired|fixed)|repairs?\s+(?:are\s+|were\s+|is\s+|was\s+|has\s+been\s+|have\s+been\s+)?(?:now\s+)?(?:done|complete|completed|finished))\b/i;

const PATTERNS = patterns();

export function parseOwnerUpdate(text: string, ctx: ParseContext): ParseResult {
  const clauses = splitClauses(text);
  const actions: PlannedAction[] = [];
  const questions: Question[] = [];
  const outClauses: ParseResult['clauses'] = [];
  const repairInInput = clauses.some((c) => REPAIRED_RE.test(c.text));
  let privateNote = false;
  let n = 0;

  // Dates per sentence (for sharing): past sense.
  const sentenceDates = new Map<number, FoundDate[]>();
  clauses.forEach((c) => {
    const ds = findAllDatePhrases(c.text, ctx.now, 'past').map((d) => ({ ...d, index: d.index + c.index }));
    sentenceDates.set(c.sentence, [...(sentenceDates.get(c.sentence) ?? []), ...ds]);
  });
  const sentenceText = new Map<number, string>();
  clauses.forEach((c) => sentenceText.set(c.sentence, `${sentenceText.get(c.sentence) ?? ''} ${c.text}`));

  clauses.forEach((clause, ci) => {
    const own = findAllDatePhrases(clause.text, ctx.now, 'past')[0];
    const ownFuture = findAllDatePhrases(clause.text, ctx.now, 'future')[0];
    const sDates = sentenceDates.get(clause.sentence) ?? [];
    const distinct = [...new Map(sDates.map((d) => [d.at, d])).values()];
    const pastDate = own ? { d: { ...own, index: own.index + clause.index }, shared: false } : distinct.length === 1 ? { d: distinct[0]!, shared: true } : null;
    const futureDate = ownFuture ? { ...ownFuture, index: ownFuture.index + clause.index } : null;
    const env: PatternEnv = {
      ctx,
      clause,
      pastDate,
      futureDate,
      answer: (s) => ctx.answers?.[`q${ci + 1}-${s}`],
      qid: (s) => `q${ci + 1}-${s}`,
      repairInInput,
      who: whoPattern(ctx),
      sentenceInsurer: INSURER_CONTEXT(ctx).test(sentenceText.get(clause.sentence) ?? ''),
    };
    let built: Built | null = null;
    for (const p of PATTERNS) {
      const re = p.re(ctx);
      const m = new RegExp(re.source, re.flags.replace('g', '')).exec(clause.text);
      if (!m) continue;
      built = p.build(m, env);
      if (built) break;
    }
    if (!built) {
      outClauses.push({ text: clause.text, matched: false, actions: [] });
      return;
    }
    const keys: string[] = [];
    for (const a of built.actions) {
      n += 1;
      const key = `a${n}`;
      const params = a.params;
      let tier: Partial<TierContext> = { ...a.tier, openHires: ctx.openHires.length };
      if (a.type === 'field_update' && params.target) {
        const cur = ctx.fieldValues?.[params.target] ?? null;
        params.current = cur;
        tier = { ...tier, overwrites: Boolean(cur && cur.trim().toUpperCase() !== (params.value ?? '').trim().toUpperCase()), sensitive: SENSITIVE_FIELD_TARGETS.has(params.target as never) };
        if (cur && cur.trim().toUpperCase() === (params.value ?? '').trim().toUpperCase()) {
          n -= 1;
          continue; // already on the claim
        }
      }
      if (a.type === 'private_note') privateNote = true;
      const planned = buildAction({
        key,
        type: a.type,
        params,
        quote: a.quote === undefined ? clause.text : a.quote,
        source: 'rules',
        from: 'owner_text',
        confidence: 0.9,
        detail: a.detail ?? null,
        tier,
        ...(a.title ? { title: a.title } : {}),
      });
      if (planned.type === 'private_note') privateNote = true;
      actions.push(planned);
      keys.push(key);
    }
    for (const q of built.questions) {
      const { idSuffix, ...rest } = q;
      questions.push({ ...rest, id: env.qid(idSuffix), about: rest.about ?? null });
    }
    const matched = built.whole === true || !leftoverMatters(clause.text, built.spans, ctx);
    outClauses.push({ text: clause.text, matched, actions: keys });
  });

  const matched = outClauses.filter((c) => c.matched).length;
  return { clauses: outClauses, actions, questions, coverage: outClauses.length ? matched / outClauses.length : 1, privateNote };
}

/** The date of a clause for display ("11 Oct"). */
export const shortDate = fmtDayShort;
