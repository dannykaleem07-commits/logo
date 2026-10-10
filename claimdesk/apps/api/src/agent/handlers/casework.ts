// owned by casework
/**
 * casework job handlers and Needs-you resolvers (docs/SUPREME-DESIGN.md §C.2, §C.7). Registered by
 * agent/handlers/index.ts (foundation).
 *
 *   case.review            AI   case manager → tasks, questions, validated hand-offs
 *   offer.analyse          AI   figures by code + recommendation → Needs-you offer_decision (never a decision)
 *   draft.compose          AI   drafter → document_draft / docx_document_draft / email_draft → review.check
 *   review.check           det tiers a+b, AI tier c → reviews row → outbox.after_review | document.after_review
 *   document.after_review  det  §D.5 automated approval when allow-listed + zero flags + pass, else Needs-you
 *   research.ask           AI   researcher → memory note
 *   case.sweep / task.due  det  → case.review
 *   index.fts / brain.import det  librarian
 * Resolvers: approve_document, money, legal_review, offer_decision.
 */
import { z } from 'zod';
import type { Actor } from '@ccguk/db';
import type { JobHandler, NeedsYouResolver, JobRecord } from '../contracts.js';
import { approveDocument } from '../../services/documents.js';
import { runCaseReview, runCaseSweep, runDraftCompose, runOfferAnalyse, runResearch, runTaskDue, type CaseReviewPayload, type DraftComposePayload, type ResearchPayload } from '../../casework/agents.js';
import { documentAfterReview, runReviewCheck, type ReviewCheckPayload } from '../../casework/review.js';
import { indexSource, sweepIndex } from '../../brain/fts.js';
import { importPack } from '../../brain/packs.js';
import { getStagedImport, markImportConsumed, markImportFailed, stagedImportPath } from '../../services/imports.js';
import { readFileSync } from 'node:fs';

const MIN = 60_000;

const caseReview: JobHandler<CaseReviewPayload> = {
  type: 'case.review',
  agent: 'case_manager',
  lane: 'ai',
  usesAi: true,
  mutatesClaim: true,
  payload: z.object({ claimId: z.string().min(1), reason: z.enum(['inbound', 'task_due', 'sweep', 'owner', 'offer']), messageId: z.string().nullish(), taskId: z.string().nullish() }).passthrough() as never,
  defaultPriority: 1,
  maxAttempts: 3,
  timeoutMs: 12 * MIN,
  run: ({ ctx, job, payload }) => runCaseReview(ctx, job as JobRecord, payload),
};

const offerAnalyse: JobHandler<{ offerId: string; claimId?: string }> = {
  type: 'offer.analyse',
  agent: 'case_manager',
  lane: 'ai',
  usesAi: true,
  mutatesClaim: false,
  payload: z.object({ offerId: z.string().min(1), claimId: z.string().optional() }).passthrough(),
  defaultPriority: 0,
  maxAttempts: 3,
  timeoutMs: 12 * MIN,
  run: ({ ctx, job, payload }) => runOfferAnalyse(ctx, job as JobRecord, payload),
};

const draftCompose: JobHandler<DraftComposePayload> = {
  type: 'draft.compose',
  agent: 'drafter',
  lane: 'ai',
  usesAi: true,
  mutatesClaim: true,
  payload: z
    .object({
      claimId: z.string().min(1),
      templateId: z.string().nullable().default(null),
      emailKind: z.string().nullable().default(null),
      purpose: z.string().min(1).max(8000),
      recipientPartyId: z.string().nullable().default(null),
      replyToMessageId: z.string().nullable().default(null),
      actionCode: z.string().nullable().default(null),
      dueAt: z.string().nullable().default(null),
      missingInfo: z.boolean().optional(),
      repairOf: z.string().optional(),
      issues: z.array(z.object({ code: z.string().optional(), message: z.string().optional(), fix: z.string().nullable().optional() }).passthrough()).max(50).optional(),
      loop: z.number().int().min(0).max(10).optional(),
    })
    .passthrough() as never,
  defaultPriority: 2,
  maxAttempts: 3,
  timeoutMs: 12 * MIN,
  run: ({ ctx, job, payload }) => runDraftCompose(ctx, job as JobRecord, payload),
};

const reviewCheck: JobHandler<ReviewCheckPayload> = {
  type: 'review.check',
  agent: 'reviewer',
  lane: 'ai',
  usesAi: true,
  mutatesClaim: false,
  payload: z.object({ targetKind: z.enum(['outbox', 'document', 'docx']), targetId: z.string().min(1), claimId: z.string().optional(), loop: z.number().int().min(0).max(10).optional() }).passthrough() as never,
  defaultPriority: 1,
  maxAttempts: 3,
  timeoutMs: 10 * MIN,
  run: ({ ctx, job, payload }) => runReviewCheck(ctx, job as JobRecord, payload),
};

const documentAfter: JobHandler<{ documentId: string; reviewId: string }> = {
  type: 'document.after_review',
  agent: 'reviewer',
  lane: 'io',
  usesAi: false,
  mutatesClaim: false,
  payload: z.object({ documentId: z.string().min(1), reviewId: z.string().min(1) }).passthrough(),
  defaultPriority: 1,
  maxAttempts: 3,
  timeoutMs: 5 * MIN,
  run: ({ ctx, job, payload }) => documentAfterReview(ctx, job as JobRecord, payload),
};

const researchAsk: JobHandler<ResearchPayload> = {
  type: 'research.ask',
  agent: 'researcher',
  lane: 'ai',
  usesAi: true,
  mutatesClaim: true,
  payload: z.object({ claimId: z.string().nullish(), question: z.string().min(3).max(4000), scope: z.enum(['claim', 'global']).optional(), askedBy: z.string().optional() }).passthrough() as never,
  defaultPriority: 4,
  maxAttempts: 3,
  timeoutMs: 8 * MIN,
  run: ({ ctx, job, payload }) => runResearch(ctx, job as JobRecord, payload),
};

const caseSweep: JobHandler<{ slot?: string }> = {
  type: 'case.sweep',
  agent: 'case_manager',
  lane: 'io',
  usesAi: false,
  mutatesClaim: false,
  payload: z.object({ slot: z.string().optional() }).passthrough(),
  defaultPriority: 5,
  maxAttempts: 3,
  timeoutMs: 10 * MIN,
  run: async ({ ctx, job, payload }) => runCaseSweep(ctx, job as JobRecord, payload),
};

const taskDue: JobHandler<{ taskId: string }> = {
  type: 'task.due',
  agent: 'case_manager',
  lane: 'io',
  usesAi: false,
  mutatesClaim: false,
  payload: z.object({ taskId: z.string().min(1) }).passthrough(),
  defaultPriority: 3,
  maxAttempts: 3,
  timeoutMs: 2 * MIN,
  run: async ({ ctx, job, payload }) => runTaskDue(ctx, job as JobRecord, payload),
};

/** Inlined (not imported) so module-evaluation order never matters for the payload schema. */
const INDEX_KINDS = ['email', 'document', 'evidence_text', 'transcript', 'note', 'sweep'] as const;
type IndexPayload = { sourceKind: (typeof INDEX_KINDS)[number]; sourceId?: string };
const indexFts: JobHandler<IndexPayload> = {
  type: 'index.fts',
  agent: 'researcher',
  lane: 'cpu',
  usesAi: false,
  mutatesClaim: false,
  payload: z.object({ sourceKind: z.enum(INDEX_KINDS), sourceId: z.string().optional() }).passthrough() as never,
  defaultPriority: 7,
  maxAttempts: 3,
  timeoutMs: 10 * MIN,
  async run({ ctx, job, payload }) {
    if (payload.sourceKind === 'sweep') return { kind: 'done', result: await sweepIndex(ctx, { parentJobId: job.id, correlationId: job.correlationId }) };
    if (!payload.sourceId) return { kind: 'fail', reason: 'index.fts needs a sourceId' };
    return { kind: 'done', result: await indexSource(ctx, payload.sourceKind, payload.sourceId) };
  },
};

const brainImport: JobHandler<{ importId: string }> = {
  type: 'brain.import',
  agent: 'researcher',
  lane: 'cpu',
  usesAi: false,
  mutatesClaim: false,
  payload: z.object({ importId: z.string().min(1) }).passthrough(),
  defaultPriority: 4,
  maxAttempts: 2,
  timeoutMs: 10 * MIN,
  async run({ ctx, payload }) {
    const imp = getStagedImport(ctx, payload.importId);
    if (!imp) return { kind: 'fail', reason: `import ${payload.importId} not found` };
    if (imp.purpose !== 'brain-packs') return { kind: 'fail', reason: `import ${imp.id} is not a brain pack (${imp.purpose})` };
    if (imp.status === 'consumed') return { kind: 'done', result: { skipped: 'already imported', result: imp.result ?? null } };
    try {
      const r = importPack(ctx, { kind: 'bytes', filename: imp.filename, bytes: new Uint8Array(readFileSync(stagedImportPath(ctx, imp.id))), source: `import:${imp.id}` }, { userId: 'system' });
      markImportConsumed(ctx, imp.id, 'brain', { packId: r.pack.id, version: r.version.version, duplicate: r.duplicate });
      return { kind: 'done', result: { packId: r.pack.id, version: r.version.version, entries: r.preview.entries, duplicate: r.duplicate, active: r.pack.activeVersion ?? null } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markImportFailed(ctx, imp.id, message);
      return { kind: 'fail', reason: message };
    }
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each handler has its own payload/result types
export const caseworkJobHandlers: JobHandler<any, any>[] = [caseReview, offerAnalyse, draftCompose, reviewCheck, documentAfter, researchAsk, caseSweep, taskDue, indexFts, brainImport];

// ---------------------------------------------------------------------------
// Resolvers — run as the signed-in owner
// ---------------------------------------------------------------------------

function auditDecision(ctx: Parameters<NeedsYouResolver['resolve']>[0], actor: Actor, action: string, entityId: string, after: unknown): void {
  ctx.repos.appendAudit(ctx.db, { actor, action, entity: 'needs_you', entityId, after, at: ctx.now() });
}

/** approve_document: approve as the owner (the human path, every guard applies) or void the draft with a reason. */
const approveDocumentResolver: NeedsYouResolver<{ documentId?: string; reviewId?: string }> = {
  kind: 'approve_document',
  async resolve(ctx, item, choice, actor) {
    const documentId = item.payload?.documentId;
    if (!documentId) return;
    const doc = ctx.repos.getDocument(ctx.db, documentId);
    if (!doc || (doc.status !== 'draft' && doc.status !== 'blocked')) return;
    if (choice.optionId === 'approve' || choice.optionId === 'edit') {
      await approveDocument(ctx, documentId, actor, choice.note ?? 'Approved from Needs-you');
      return;
    }
    if (choice.optionId === 'reject') {
      ctx.repos.voidDocument(ctx.db, documentId, actor, choice.note?.trim() || 'Rejected by the owner');
      auditDecision(ctx, actor, 'document.reject', item.id, { documentId, note: choice.note ?? null });
    }
  },
};

/**
 * money: the owner writes the ledger row through the normal ledger route (the card opens the ledger form with the
 * proposed entry); this resolver only records the owner's answer. Agents never write money.
 */
const moneyResolver: NeedsYouResolver<{ proposal?: string; entry?: unknown; link?: string }> = {
  kind: 'money',
  async resolve(ctx, item, choice, actor) {
    auditDecision(ctx, actor, 'money.reviewed', item.id, { optionId: choice.optionId, proposal: item.payload?.proposal ?? null, entry: item.payload?.entry ?? null, note: choice.note ?? null });
  },
};

/** legal_review: the owner handles legal matters; the answer is recorded. */
const legalResolver: NeedsYouResolver<{ matter?: string }> = {
  kind: 'legal_review',
  async resolve(ctx, item, choice, actor) {
    auditDecision(ctx, actor, 'legal.reviewed', item.id, { optionId: choice.optionId, matter: item.payload?.matter ?? null, note: choice.note ?? null });
  },
};

/**
 * offer_decision: the decision is recorded by the owner on the offer screen (PATCH /claims/:id/offers/:oid as the
 * owner); resolving the card never writes a decision.
 */
const offerDecisionResolver: NeedsYouResolver<{ offerId?: string }> = {
  kind: 'offer_decision',
  async resolve(ctx, item, choice, actor) {
    auditDecision(ctx, actor, 'offer.card_resolved', item.id, { optionId: choice.optionId, offerId: item.payload?.offerId ?? null, note: choice.note ?? null });
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each resolver has its own payload type
export const caseworkNeedsYouResolvers: NeedsYouResolver<any>[] = [approveDocumentResolver, moneyResolver, legalResolver, offerDecisionResolver];
