// owned by casework
/**
 * casework tools (docs/SUPREME-DESIGN.md §B.4). Registered by agent/tools/index.ts (foundation).
 *
 *   read      claim_brief · quantum_settlement · brain_search · memory_recall
 *   draft     task_schedule · memory_note (proposed; the owner approves)
 *   money     payment_received_propose · ledger_propose          → always Needs-you `money` (the owner writes the row)
 *   settlement offer_recommend                                   → always Needs-you `offer_decision` (never a decision)
 *   legal     legal_escalate                                     → always Needs-you `legal_review`
 *
 * Money / settlement / legal tools are never executed by an agent: `decide()` always asks (§D.2 rule 5) and `onAsk`
 * prepares the owner's card; their `run` refuses if it is ever reached.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { BRAIN_ENTRY_KINDS, TASK_KINDS, formatGBP, type ActionDescriptor, type Decision } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import type { NeedsYouInput, RunContext, ToolDef } from '../contracts.js';
import { DEFAULT_MAX_OUTPUT_CHARS } from '../contracts.js';
import { agentUserId } from '../principal.js';
import { toolInputSchema } from '../../ai/strictSchema.js';
import { buildCaseBrief } from '../../casework/caseBrief.js';
import { settlementFigures } from '../../casework/quantum.js';
import { offerClaimId, offerDecisionItem } from '../../casework/offers.js';
import { isPlaybookCode } from '../../casework/handoffs.js';
import { brainSearch } from '../../brain/search.js';
import { memoryRecall, proposeMemory } from '../../brain/memory.js';
import { maskDeep } from '../../casework/mask.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
type AnyTool = ToolDef<any, any>;

const HEADS = ['hire', 'recovery', 'storage', 'engineer_fee', 'pav', 'repair', 'salvage', 'excess', 'loss_of_use', 'diminution', 'personal_effects', 'loss_of_earnings', 'travel', 'misc'] as const;
const LEGAL_MATTERS = ['letter_before_claim', 'part36', 'litigation', 'complaint', 'fraud_allegation', 'solicitor', 'court', 'injury', 'dsar'] as const;

const id = () => z.string().min(1).max(128);
const basis = z.strictObject({ kind: z.enum(['fact', 'kb', 'pack', 'rule', 'event', 'evidence', 'memory', 'message']), id: z.string().min(1).max(300), label: z.string().max(300).nullable() });
const draftRef = z.strictObject({ kind: z.enum(['outbox', 'document', 'docx', 'proposal', 'task', 'memory']), id: id() });
const isoDate = () => z.string().min(10).max(40).describe('ISO 8601 date or date-time');

function tool<S extends z.ZodType>(def: Omit<AnyTool, 'input' | 'strictSchema' | 'maxOutputChars'> & { input: S; maxOutputChars?: number }): AnyTool {
  return { ...def, strictSchema: toolInputSchema(def.input), maxOutputChars: def.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS } as AnyTool;
}

const read = (kind: string) => (i: { claimId?: string | null }, rc: RunContext): ActionDescriptor => ({ class: 'read', kind: `read.${kind}`, ...((i.claimId ?? rc.claimScope) ? { claimId: (i.claimId ?? rc.claimScope)! } : {}), confidence: 1 });

const neverRun = (name: string) => async (): Promise<never> => {
  throw Object.assign(new Error(`${name} is never executed by an agent: the owner decides`), { code: 'OWNER_ONLY' });
};

const dedupe = (rc: RunContext, name: string, input: unknown): string => `${name}:${rc.claimScope ?? 'none'}:${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16)}`;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const claimBrief = tool({
  name: 'claim_brief',
  title: 'Case Brief',
  description: 'The Case Brief of the claim: facts (the only source of figures, dates and references — cite them as {{fact:<id>}}), parties (personal data masked), clocks, gates, the playbook next actions, money by head, offers, hire, correspondence, recipients, open tasks and approved memory.',
  class: 'read',
  input: z.strictObject({ claimId: id() }),
  run: async (i: { claimId: string }, _rc: RunContext, ctx: AppContext) => buildCaseBrief(ctx, i.claimId, { mask: true }),
  describe: read('claim_brief'),
  maxOutputChars: 60_000,
});

const quantumSettlement = tool({
  name: 'quantum_settlement',
  title: 'Settlement arithmetic',
  description: 'Code-computed settlement figures for an offer or a head: the ledger position, accept-now vs fight-on (settlementArithmetic), expected value, the walk-away number, the GTA benchmark (a benchmark only — CCGUK is not a GTA subscriber) and the PAV. Probabilities are stated assumptions. Compute only: nothing is stored or decided.',
  class: 'read',
  input: z.strictObject({ claimId: id(), offerPence: z.int().min(0).nullable(), head: z.enum(HEADS).nullable(), offerId: id().nullable() }),
  run: async (i: { claimId: string; offerPence: number | null; head: string | null; offerId: string | null }, _rc: RunContext, ctx: AppContext) => settlementFigures(ctx, { claimId: i.claimId, offerPence: i.offerPence, head: i.head, offerId: i.offerId }),
  describe: read('quantum_settlement'),
});

const brainSearchTool = tool({
  name: 'brain_search',
  title: 'Search the brain packs',
  description: 'Search the owner’s active brain packs (company rules, playbook strategy, letter style, red lines, snippets). Results are ordered by pack precedence then relevance and carry `ref` (pack:<id>@<version>#<entry>) — cite that as a basis id. Strategy meant only for Fixmyfile never appears for CCGUK claims unless the owner allowed it.',
  class: 'read',
  input: z.strictObject({ q: z.string().min(2).max(500), packs: z.array(z.string().max(64)).max(10).nullable(), kinds: z.array(z.enum(BRAIN_ENTRY_KINDS as unknown as [string, ...string[]])).max(11).nullable(), limit: z.int().min(1).max(20).nullable() }),
  run: async (i: { q: string; packs: string[] | null; kinds: string[] | null; limit: number | null }, _rc: RunContext, ctx: AppContext) => ({ hits: brainSearch(ctx, { q: i.q, packs: i.packs, kinds: i.kinds, limit: i.limit ?? 8, business: 'ccguk' }) }),
  describe: read('brain_search'),
});

const memoryRecallTool = tool({
  name: 'memory_recall',
  title: 'Recall approved memory',
  description: 'Approved memory items (owner corrections, outcomes, insurer behaviour, research notes) for this claim, its insurer and global. Proposed items never appear.',
  class: 'read',
  input: z.strictObject({ q: z.string().max(500), scope: z.string().max(200).nullable() }),
  run: async (i: { q: string; scope: string | null }, rc: RunContext, ctx: AppContext) => {
    if (i.scope && rc.claimScope && i.scope.startsWith('claim:') && i.scope !== `claim:${rc.claimScope}`) throw Object.assign(new Error('This run is limited to its own claim'), { code: 'CLAIM_SCOPE' });
    return { items: memoryRecall(ctx, { q: i.q, scope: i.scope, ...(rc.claimScope ? { claimId: rc.claimScope } : {}) }) };
  },
  describe: read('memory_recall'),
});

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

const taskSchedule = tool({
  name: 'task_schedule',
  title: 'Schedule a follow-up task',
  description: 'Schedule a follow-up on the claim (chaser, deadline check, payment check, call…). When it falls due the case manager reviews the claim again. actionCode must be a playbook code or null.',
  class: 'draft',
  input: z.strictObject({ claimId: id(), kind: z.enum(TASK_KINDS as unknown as [string, ...string[]]), dueAt: isoDate(), note: z.string().min(3).max(2000), actionCode: z.string().max(64).nullable() }),
  run: async (i: { claimId: string; kind: string; dueAt: string; note: string; actionCode: string | null }, rc: RunContext, ctx: AppContext) => {
    const t = Date.parse(i.dueAt);
    if (!Number.isFinite(t)) throw Object.assign(new Error(`dueAt ${i.dueAt} is not a date`), { code: 'VALIDATION' });
    if (i.actionCode && i.actionCode !== 'CUSTOM' && !isPlaybookCode(i.actionCode)) throw Object.assign(new Error(`actionCode ${i.actionCode} is not a playbook code`), { code: 'VALIDATION' });
    ctx.repos.requireClaim(ctx.db, i.claimId);
    const task = ctx.repos.createTask(ctx.db, { claimId: i.claimId, kind: i.kind, title: i.note.slice(0, 120), note: i.note, ...(i.actionCode ? { actionCode: i.actionCode } : {}), dueAt: new Date(t).toISOString(), createdBy: agentUserId(rc.agent), sourceRunId: rc.runId, now: ctx.now() });
    return { taskId: task.id, dueAt: task.dueAt };
  },
  describe: (i: { claimId: string; kind: string }) => ({ class: 'draft', kind: `task.${i.kind}`, claimId: i.claimId, confidence: 1 }),
});

const memoryNote = tool({
  name: 'memory_note',
  title: 'Propose a memory note',
  description: 'Propose something worth remembering (insurer behaviour, an owner preference, a lesson). It is stored as PROPOSED; only items the owner approves are ever used. Scope: claim:<this claim id>, insurer:<party id> or global.',
  class: 'draft',
  input: z.strictObject({ scope: z.string().min(6).max(200), text: z.string().min(3).max(4000), basis: z.array(basis).max(20) }),
  run: async (i: { scope: string; text: string; basis: Array<{ kind: string; id: string; label: string | null }> }, rc: RunContext, ctx: AppContext) => {
    if (rc.claimScope && i.scope.startsWith('claim:') && i.scope !== `claim:${rc.claimScope}`) throw Object.assign(new Error('This run is limited to its own claim'), { code: 'CLAIM_SCOPE' });
    const item = proposeMemory(ctx, { kind: 'note', scope: i.scope, text: i.text, basis: i.basis as never, data: { runId: rc.runId }, createdBy: agentUserId(rc.agent) });
    return { memoryId: item.id, status: item.status };
  },
  describe: (_i: unknown, rc: RunContext) => ({ class: 'draft', kind: 'memory.note', ...(rc.claimScope ? { claimId: rc.claimScope } : {}), confidence: 1 }),
});

// ---------------------------------------------------------------------------
// Money / settlement / legal — always the owner
// ---------------------------------------------------------------------------

interface PaymentInput {
  claimId: string;
  head: string;
  amountPence: number;
  receivedAt: string;
  sourceEvidenceId: string;
  reference: string | null;
}

const paymentReceivedPropose = tool({
  name: 'payment_received_propose',
  title: 'Propose a payment received',
  description: 'A payment (remittance, BACS, cheque) seems to have arrived: prepare it for the owner, who confirms it and writes the ledger row. Agents never write paid rows.',
  class: 'money',
  input: z.strictObject({ claimId: id(), head: z.enum(HEADS), amountPence: z.int().min(1), receivedAt: isoDate(), sourceEvidenceId: id(), reference: z.string().max(200).nullable() }),
  run: neverRun('payment_received_propose'),
  describe: (i: PaymentInput) => ({ class: 'money', kind: `money.payment_received.${i.head}`, claimId: i.claimId, confidence: 1 }),
  onAsk: (i: PaymentInput, rc: RunContext, ctx: AppContext, d: Decision): NeedsYouInput => {
    const ev = ctx.repos.getEvidence(ctx.db, i.sourceEvidenceId);
    if (!ev || ev.claimId !== i.claimId) throw Object.assign(new Error(`Evidence ${i.sourceEvidenceId} is not on this claim`), { code: 'WRONG_CLAIM' });
    return {
      kind: 'money',
      claimId: i.claimId,
      title: `Payment received? ${formatGBP(i.amountPence)} (${i.head})`,
      summary: `The ${rc.agent.replace(/_/g, ' ')} agent read a payment of ${formatGBP(i.amountPence)} on ${i.head} received ${i.receivedAt.slice(0, 10)}${i.reference ? ` (reference ${i.reference})` : ''}. Check the remittance and record it in the ledger yourself — agents never write payments.`,
      recommendation: { action: 'Record the payment in the ledger', why: `Read from evidence ${ev.filename}.`, confidence: 0.8, basis: [{ kind: 'evidence', id: ev.id, label: ev.filename }] },
      options: [
        { id: 'record', label: 'Open the ledger to record it', tone: 'primary' },
        { id: 'not_a_payment', label: 'Not a payment', tone: 'neutral', requiresReason: true },
      ],
      payload: { proposal: 'payment_received', claimId: i.claimId, entry: { kind: 'paid', head: i.head, amountPence: i.amountPence, date: i.receivedAt.slice(0, 10), reference: i.reference, sourceEvidenceId: i.sourceEvidenceId }, link: `/claims/${i.claimId}/ledger`, decision: { ruleIds: d.ruleIds, reasons: d.reasons }, runId: rc.runId },
      priority: 'high',
      createdBy: agentUserId(rc.agent),
      dedupeKey: dedupe(rc, 'payment_received_propose', i),
      correlationId: rc.correlationId,
    };
  },
});

interface LedgerInput {
  claimId: string;
  kind: 'claimed' | 'invoiced';
  head: string;
  amountPence: number;
  basis: Array<{ kind: string; id: string; label: string | null }>;
}

const ledgerPropose = tool({
  name: 'ledger_propose',
  title: 'Propose a ledger figure',
  description: 'Propose a claimed or invoiced figure for a head of loss, with its basis. The owner checks it and writes the ledger row; agents never write money.',
  class: 'money',
  input: z.strictObject({ claimId: id(), kind: z.enum(['claimed', 'invoiced']), head: z.enum(HEADS), amountPence: z.int().min(1), basis: z.array(basis).min(1).max(20) }),
  run: neverRun('ledger_propose'),
  describe: (i: LedgerInput) => ({ class: 'money', kind: `money.ledger.${i.kind}.${i.head}`, claimId: i.claimId, confidence: 1 }),
  onAsk: (i: LedgerInput, rc: RunContext, _ctx: AppContext, d: Decision): NeedsYouInput => ({
    kind: 'money',
    claimId: i.claimId,
    title: `Ledger: ${i.kind} ${formatGBP(i.amountPence)} on ${i.head}?`,
    summary: `The ${rc.agent.replace(/_/g, ' ')} agent proposes a ${i.kind} figure of ${formatGBP(i.amountPence)} for ${i.head}. Check the basis and record it in the ledger yourself if it is right.`,
    recommendation: { action: `Record ${i.kind} ${formatGBP(i.amountPence)} (${i.head})`, why: 'Proposed with the basis shown.', confidence: 0.7, basis: i.basis as never },
    options: [
      { id: 'record', label: 'Open the ledger to record it', tone: 'primary' },
      { id: 'reject', label: 'Not right', tone: 'neutral', requiresReason: true },
    ],
    payload: { proposal: 'ledger', claimId: i.claimId, entry: { kind: i.kind, head: i.head, amountPence: i.amountPence }, basis: i.basis, link: `/claims/${i.claimId}/ledger`, decision: { ruleIds: d.ruleIds, reasons: d.reasons }, runId: rc.runId },
    priority: 'normal',
    createdBy: agentUserId(rc.agent),
    dedupeKey: dedupe(rc, 'ledger_propose', i),
    correlationId: rc.correlationId,
  }),
});

interface OfferRecommendInput {
  offerId: string;
  recommendation: 'accept' | 'counter' | 'reject' | 'hold';
  counterPence: number | null;
  reasoning: string;
  basis: Array<{ kind: string; id: string; label: string | null }>;
  confidence: number;
}

const offerRecommend = tool({
  name: 'offer_recommend',
  title: 'Recommend what to do with an offer',
  description: 'Give the owner your recommendation on an offer (accept / counter / reject / hold) with reasons, basis and confidence. It becomes the offer decision card with the code-computed figures. You never accept, counter or reject — the owner decides on the offer screen.',
  class: 'settlement',
  input: z.strictObject({ offerId: id(), recommendation: z.enum(['accept', 'counter', 'reject', 'hold']), counterPence: z.int().min(0).nullable(), reasoning: z.string().min(3).max(4000), basis: z.array(basis).max(20), confidence: z.number().min(0).max(1) }),
  run: neverRun('offer_recommend'),
  describe: (i: OfferRecommendInput, rc: RunContext, ctx: AppContext) => {
    const claimId = offerClaimId(ctx, i.offerId) ?? rc.claimScope;
    if (rc.claimScope && claimId !== rc.claimScope) throw Object.assign(new Error('This run is limited to its own claim'), { code: 'CLAIM_SCOPE' });
    return { class: 'settlement', kind: `settlement.offer_recommend.${i.recommendation}`, ...(claimId ? { claimId } : {}), confidence: i.confidence };
  },
  onAsk: (i: OfferRecommendInput, rc: RunContext, ctx: AppContext): NeedsYouInput => offerDecisionItem(ctx, i as never, { createdBy: agentUserId(rc.agent), correlationId: rc.correlationId, runId: rc.runId }),
});

interface LegalInput {
  claimId: string;
  matter: (typeof LEGAL_MATTERS)[number];
  summary: string;
  recommendation: string;
  draftRefs: Array<{ kind: string; id: string }>;
}

const legalEscalate = tool({
  name: 'legal_escalate',
  title: 'Escalate a legal matter to the owner',
  description: 'Letters before claim, Part 36, litigation, complaints, fraud allegations, solicitors, court, injury and DSARs always go to the owner: summarise the matter, recommend, and point at any prepared drafts.',
  class: 'legal',
  input: z.strictObject({ claimId: id(), matter: z.enum(LEGAL_MATTERS), summary: z.string().min(3).max(4000), recommendation: z.string().min(3).max(2000), draftRefs: z.array(draftRef).max(10) }),
  run: neverRun('legal_escalate'),
  describe: (i: LegalInput) => ({ class: 'legal', kind: `legal.${i.matter}`, claimId: i.claimId, confidence: 1 }),
  onAsk: (i: LegalInput, rc: RunContext, ctx: AppContext): NeedsYouInput => ({
    kind: 'legal_review',
    claimId: i.claimId,
    title: `Legal: ${i.matter.replace(/_/g, ' ')} on ${ctx.repos.getClaim(ctx.db, i.claimId)?.reference ?? 'the claim'}`,
    summary: i.summary.slice(0, 2000),
    recommendation: { action: i.recommendation.slice(0, 500), why: i.summary.slice(0, 1000), confidence: 0.6, basis: [] },
    options: [
      { id: 'seen', label: 'Seen — I will handle it', tone: 'primary' },
      { id: 'dismiss', label: 'Not a legal matter', tone: 'neutral', requiresReason: true },
    ],
    payload: { matter: i.matter, draftRefs: i.draftRefs, input: maskDeep(i), runId: rc.runId },
    priority: i.matter === 'court' || i.matter === 'litigation' || i.matter === 'part36' ? 'urgent' : 'high',
    createdBy: agentUserId(rc.agent),
    dedupeKey: `legal_review:${i.claimId}:${i.matter}:${rc.correlationId}`,
    correlationId: rc.correlationId,
  }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool has its own input/output types
export const caseworkTools: ToolDef<any, any>[] = [claimBrief, quantumSettlement, brainSearchTool, memoryRecallTool, taskSchedule, memoryNote, paymentReceivedPropose, ledgerPropose, offerRecommend, legalEscalate];
