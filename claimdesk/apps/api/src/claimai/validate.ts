// owned by claimai-server
/**
 * Validation of the AI's reading of an owner update (docs/CLAIM-AI-INPUT.md §5.4). Code decides: every AI action is
 * checked (type, quote, source, dates, targets, hires, documents, templates, amounts, contacts) and gets its tier from
 * `tiers.ts`; what fails is listed under "Not done" with the reason. The model can never promote an action.
 */
import {
  ACCUSATION_WORDS,
  AI_ACTION_TYPES,
  CLAIM_AI_FORBIDDEN_STATUSES,
  COPY,
  FIELD_TARGETS,
  OWNER_EVENT_TYPES,
  SENSITIVE_FIELD_TARGETS,
  TASK_KINDS,
  TRANSCRIPT_TYPES,
  buildAction,
  eventAtFor,
  findQuote,
  holdFor,
  isAgentScope,
  isContactRole,
  isJobKind,
  nineAm,
  resolveDocument,
  startOfLondonDay,
  type ActionParams,
  type ActionType,
  type AgentScope,
  type ClaimInputInterpretation,
  type ContactRole,
  type InstructionEffect,
  type ParseContext,
  type PlannedAction,
  type Question,
} from '@ccguk/domain';
import { hasTemplate } from '@ccguk/documents';
import type { AppContext } from '../context.js';
import { loadClaimSnapshot, sameValue, targetDef } from '../intake/targets.js';

export interface ValidatedInterpretation {
  understood: string | null;
  actions: PlannedAction[];
  questions: Question[];
  notDone: Array<{ text: string; why: string }>;
  warnings: string[];
}

/** AI event types that are really another action type. */
const RETYPE: Readonly<Record<string, ActionType>> = {
  intervention_offer: 'offer_received',
  settlement_offer_received: 'offer_received',
  pav_offer_received: 'offer_received',
  part36_received: 'offer_received',
  payment_received: 'money',
  tl_payment_received: 'money',
  reduction_received: 'money',
  hire_ended: 'hire_end',
  hire_started: 'hire_start',
  letter_before_claim_sent: 'legal',
  part36_sent: 'legal',
  proceedings_issued: 'legal',
  complaint_sent: 'legal',
  settled: 'close_or_decline',
};

const LIABILITY = new Set(['admitted', 'denied', 'disputed', 'split', 'unknown']);
const pick = <T extends string>(v: unknown, ok: (x: unknown) => x is T): T | null => (ok(v) ? v : null);

function isoOf(v: string | null): { at: string; precision: 'date' | 'datetime' } | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(`${s}T12:00:00Z`);
    if (Number.isNaN(t)) return null;
    // London midnight of that day (precision date)
    return { at: startOfLondonDay(new Date(t).toISOString()), precision: 'date' };
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : { at: new Date(t).toISOString(), precision: 'datetime' };
}

function digits(v: string | null): number | null {
  if (!v) return null;
  const s = v.replace(/[£,\s]/g, '');
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

export interface ValidateInput {
  result: ClaimInputInterpretation;
  ownerText: string;
  extraText: string | null;
  ctx: ParseContext;
  claimId: string;
  /** The first key number to use (after the rules actions). */
  startKey: number;
}

export function validateInterpretation(app: AppContext, v: ValidateInput): ValidatedInterpretation {
  const { result, ctx } = v;
  const actions: PlannedAction[] = [];
  const questions: Question[] = [];
  const notDone: ValidatedInterpretation['notDone'] = [];
  const warnings: string[] = [];
  const now = ctx.now;
  let n = v.startKey;
  const snapshot = loadClaimSnapshot(app, v.claimId);
  if (result.injectionSuspected) warnings.push(COPY.injection);

  result.actions.forEach((a, idx) => {
    let type = a.type as ActionType;
    const quote = (a.quote ?? '').trim();
    const source = a.from === 'transcript' ? (v.extraText ?? '') : v.ownerText;
    const reject = (why: string) => notDone.push({ text: a.summary || quote || type, why });
    if (!(AI_ACTION_TYPES as readonly string[]).includes(type)) return reject('Not something an update can do');
    if (a.from === 'transcript' && result.injectionSuspected) return reject('The call note contains text aimed at an AI — used as facts only');
    if (a.from === 'transcript' && !TRANSCRIPT_TYPES.has(type)) return reject(COPY.fromTranscript);
    // retype offers / payments / hire / legal event types to their action type
    if (type === 'event' && a.eventType && RETYPE[a.eventType]) type = RETYPE[a.eventType]!;
    const quoteVerified = quote ? findQuote(source, quote) !== 'not_found' : false;
    let confidence = Math.max(0, Math.min(1, Number.isFinite(a.confidence) ? a.confidence : 0));
    if (!quoteVerified) confidence = Math.min(confidence, 0.5);
    const tier: Record<string, unknown> = { quoteVerified, from: a.from === 'transcript' ? 'transcript' : 'owner_text', openHires: ctx.openHires.length };
    let params: ActionParams = {};
    let detail: string | null = quoteVerified ? null : `${COPY.quoteNotFound}`;
    const when = isoOf(a.at);
    const contacts = a.contacts.filter(isContactRole) as ContactRole[];
    const agents = a.agents.filter(isAgentScope) as AgentScope[];
    const text = (a.summary || quote).slice(0, 1000);

    // accusations: a private note, never an instruction / event / prompt text
    if (ACCUSATION_WORDS.test(`${text} ${quote} ${a.value ?? ''}`) && type !== 'money' && type !== 'offer_received') type = 'private_note';

    switch (type) {
      case 'event':
      case 'note': {
        const eventType = type === 'note' ? 'note' : a.eventType;
        if (!eventType || !(OWNER_EVENT_TYPES as readonly string[]).includes(eventType)) return reject(`The chronology type ${a.eventType ?? '(none)'} is not one an update may write`);
        const at = when ?? { at: startOfLondonDay(now), precision: 'date' as const };
        if (Date.parse(at.at) > Date.parse(now) + 3_600_000) {
          questions.push({ id: `ai${idx + 1}-future`, text: COPY.futureDate, options: [], allowText: false, allowDate: true, about: null });
          return;
        }
        params = { eventType, at: eventAtFor(at.at, at.precision, now), precision: at.precision, summary: text, ...(type === 'note' ? { text } : {}) };
        break;
      }
      case 'field_update': {
        if (!a.target || !(FIELD_TARGETS as readonly string[]).includes(a.target)) return reject(`${a.target ?? 'That detail'} is not a field an update may change`);
        const def = targetDef(a.target);
        if (!def || !a.value) return reject('No value given');
        const res = def.validate(a.value.trim(), { now });
        const value = res.value ?? a.value.trim();
        const insp = def.inspect(snapshot, value);
        if (insp.unavailable) return reject(insp.unavailable);
        if (insp.current && sameValue(insp.current, value)) return; // already on the claim
        params = { target: a.target, value, current: insp.current ?? null };
        Object.assign(tier, { overwrites: Boolean(insp.current) || insp.createsRecord, sensitive: SENSITIVE_FIELD_TARGETS.has(a.target as never), validatorOk: res.ok });
        if (!res.ok) detail = res.errors.join('; ');
        break;
      }
      case 'liability_position': {
        const value = (a.value ?? '').toLowerCase();
        if (!LIABILITY.has(value)) return reject(`Unknown liability position ${a.value ?? ''}`);
        params = { value, current: ctx.liability ?? 'unknown' };
        break;
      }
      case 'hire_end':
      case 'hire_correct': {
        const hire = !a.target || a.target === 'current' ? (ctx.openHires.length === 1 ? ctx.openHires[0] : undefined) : ctx.openHires.find((h) => h.id === a.target || h.agreementNumber === a.target);
        if (!hire) {
          if (!ctx.openHires.length) return reject(COPY.noRunningHire);
          questions.push({ id: `ai${idx + 1}-hire`, text: COPY.whichHire, options: ctx.openHires.map((h) => ({ id: h.id, label: h.agreementNumber })), allowText: false, allowDate: false, about: null });
          return;
        }
        const at = when ?? { at: startOfLondonDay(now), precision: 'date' as const };
        if (Date.parse(at.at) > Date.parse(now) + 3_600_000) {
          questions.push({ id: `ai${idx + 1}-future`, text: COPY.futureDate, options: [], allowText: false, allowDate: true, about: null });
          return;
        }
        const instant = eventAtFor(at.at, at.precision, now);
        params = type === 'hire_end'
          ? { hireId: hire.id, agreementNumber: hire.agreementNumber, startAt: hire.startAt, endAt: instant, precision: at.precision, endTrigger: /repair/i.test(`${text} ${v.ownerText}`) ? 'repair_complete_24h' : 'client_returned' }
          : a.value === 'start'
            ? { hireId: hire.id, agreementNumber: hire.agreementNumber, startAt: instant, precision: at.precision, current: hire.startAt }
            : { hireId: hire.id, agreementNumber: hire.agreementNumber, endAt: instant, precision: at.precision };
        break;
      }
      case 'hire_start':
        params = {};
        break;
      case 'task': {
        const due = when ? (when.precision === 'date' ? nineAm(when.at) : when.at) : nineAm(new Date(Date.parse(now) + 86_400_000).toISOString());
        const taskKind = a.target && (TASK_KINDS as readonly string[]).includes(a.target) ? a.target : 'other';
        params = { taskKind, dueAt: due, note: text };
        break;
      }
      case 'instruction': {
        const kind = a.value === 'ask_before_sending' || a.value === 'pause_agents' || a.value === 'none' || a.value === 'hold_contact' ? a.value : contacts.length ? 'hold_contact' : 'none';
        const effect: InstructionEffect = kind === 'hold_contact' || kind === 'ask_before_sending' ? { kind, contacts: contacts.length ? contacts : ['anyone'] } : kind === 'pause_agents' ? { kind } : { kind: 'none' };
        const until = a.until ? isoOf(a.until) : null;
        params = { text, appliesTo: agents.length ? agents : ['all'], effect, until: until ? startOfLondonDay(until.at) : null };
        break;
      }
      case 'pause_agents': {
        const until = a.until ? isoOf(a.until) : null;
        params = { reason: text, until: until ? startOfLondonDay(until.at) : null };
        break;
      }
      case 'resume_agents':
        params = {};
        break;
      case 'run_job': {
        const jobKind = pick(a.jobKind, isJobKind);
        if (!jobKind) return reject('No job kind given');
        const recipient = contacts[0] ?? (a.target && isContactRole(a.target) ? a.target : null);
        params = { jobKind, recipient, purpose: text };
        if (jobKind === 'chase') params.emailKind = 'chaser';
        if (jobKind === 'request_documents') params.emailKind = 'doc_request';
        if (jobKind === 'send_document') {
          const doc = resolveDocument(a.documentHint ?? text, ctx.evidence);
          if (!doc.evidence) {
            questions.push({ id: `ai${idx + 1}-doc`, text: COPY.whichDocument(doc.label), options: [...ctx.evidence].sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1)).slice(0, 6).map((e) => ({ id: e.id, label: e.filename })), allowText: false, allowDate: false, about: null });
            return;
          }
          params = { ...params, evidenceIds: [doc.evidence.id], filename: doc.evidence.filename, documentHint: a.documentHint ?? null };
          if (doc.count > 1) detail = `newest of ${doc.count}`;
        }
        if (jobKind === 'draft_letter') {
          if (a.value && !hasTemplate(a.value)) return reject(`There is no template ${a.value}`);
          params.templateId = a.value ?? null;
        }
        const hold = recipient && ctx.instructions ? holdFor(ctx.instructions, recipient) : undefined;
        tier.holdBlocks = hold?.text ?? null;
        break;
      }
      case 'money':
      case 'offer_received': {
        const amount = digits(a.value);
        if (amount === null) return reject('The amount must be digits (pence)');
        params = type === 'money' ? { amountPence: amount, ...(a.target ? { head: a.target } : {}), summary: text } : { amountPence: amount, register: a.target === 'intervention' ? 'intervention' : 'settlement', offeror: ctx.insurerName ?? 'the insurer' };
        break;
      }
      case 'offer_decision':
        params = { value: a.value ?? undefined };
        break;
      case 'legal':
        params = { matter: (a.value ?? text).slice(0, 200), summary: text };
        break;
      case 'status_change': {
        const status = a.target ?? a.value ?? '';
        if (CLAIM_AI_FORBIDDEN_STATUSES.has(status)) {
          type = 'close_or_decline';
          params = { status };
        } else params = { status, current: snapshot.claim.status };
        break;
      }
      case 'close_or_decline':
        params = { status: a.target ?? a.value ?? 'closed' };
        break;
      case 'private_note':
        params = { text: quote || text };
        break;
      default:
        return reject('Not something an update can do');
    }
    n += 1;
    actions.push(buildAction({ key: `a${n}`, type, params, quote: quote || null, source: 'ai', from: a.from === 'transcript' ? 'transcript' : 'owner_text', confidence, detail, tier: tier as never }));
  });

  for (const q of result.questions.slice(0, 5)) {
    const id = `ai-${questions.length + 1}`;
    questions.push({ id, text: q.text.slice(0, 300), options: q.options.slice(0, 4).map((o, i) => ({ id: `o${i + 1}`, label: o.slice(0, 120) })), allowText: true, allowDate: /when|date|until/i.test(q.text), about: null });
  }
  for (const t of result.notUnderstood.slice(0, 10)) notDone.push({ text: t.slice(0, 300), why: 'Not understood' });
  const understood = result.understood && !ACCUSATION_WORDS.test(result.understood) ? result.understood.slice(0, 300) : null;
  return { understood, actions, questions, notDone, warnings };
}

/** One line per thing: a rules action and an AI action of the same type and the same quote / date are one (rules kept). */
export function mergeActions(rules: PlannedAction[], ai: PlannedAction[]): PlannedAction[] {
  const out = [...rules];
  for (const a of ai) {
    const dup = out.some((r) => {
      if (r.type !== a.type) return false;
      if (r.quote && a.quote && (r.quote.includes(a.quote) || a.quote.includes(r.quote))) {
        if (r.type === 'event') return r.params.eventType === a.params.eventType;
        if (r.type === 'field_update') return r.params.target === a.params.target;
        return true;
      }
      const ra = r.params.at ?? r.params.endAt ?? r.params.dueAt;
      const aa = a.params.at ?? a.params.endAt ?? a.params.dueAt;
      if (r.type === 'event' && r.params.eventType === a.params.eventType && ra && aa) return ra.slice(0, 10) === aa.slice(0, 10);
      if (r.type === 'field_update') return r.params.target === a.params.target && r.params.value === a.params.value;
      if (r.type === 'liability_position') return r.params.value === a.params.value;
      if (r.type === 'hire_end') return r.params.hireId === a.params.hireId;
      return false;
    });
    if (!dup) out.push(a);
  }
  return out;
}
