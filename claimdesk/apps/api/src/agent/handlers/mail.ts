// owned by mail
/**
 * mail job handlers and Needs-you resolvers (docs/SUPREME-DESIGN.md §C.2, §C.5, §C.7, §F). Registered by
 * agent/handlers/index.ts (foundation).
 *
 *   mail.sync            det  IMAP sync of INBOX + `.eml` files staged in inbox\mail\
 *   mail.ingest          det  one UID again (a message whose inline ingest failed)
 *   mail.ingest_file     det  one staged `.eml`
 *   mail.triage          AI   Sonnet, no tools → classification → code (mail/triage.ts)
 *   mail.reply           AI   Opus, mail(reply) tools → email_draft → review
 *   outbox.after_review  det  decide() → held / ask / repair / escalate
 *   outbox.release       det  re-checks → SMTP → sent records
 * Resolvers: approve_send, missing_info, which_claim, spoof_warning.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { MailTriageResult, DrafterResult } from '@ccguk/domain';
import type { Actor, MailClassificationRecord } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import type { AiRunOutcome } from '../../ai/types.js';
import type { AgentSpec, JobHandler, JobOutcome, JobRecord, NeedsYouResolver } from '../contracts.js';
import { createNeedsYou, enqueueJob } from '../core.js';
import { runAgent } from '../runAgent.js';
import { getStagedImport, markImportConsumed, markImportFailed, stagedImportPath } from '../../services/imports.js';
import { MAIL_ACTOR, MAIL_AGENT, appendClaimEvent, fileMessageEvidence, mailAccount } from '../../mail/common.js';
import { ingestRaw, LOCAL_FILES_ACCOUNT } from '../../mail/ingest.js';
import { ingestOneUid, recordConnectionFailure, recordConnectionOk, syncMailbox, queueStagedFiles } from '../../mail/sync.js';
import { mailboxFor } from '../../mail/transport.js';
import { MAIL_TRIAGE_SPEC, applyTriage, crossCheck, storedHtml, triageInput } from '../../mail/triage.js';
import { afterReview, approveOutbox, parseOwnerEdits, rejectOutbox, releaseOutbox } from '../../mail/outbox.js';
import { linkMessageToClaim } from '../../mail/link.js';
import { MAIL_REPLY_TOOLS } from '../tools/mail.js';
import { wrapUntrusted } from '../../ai/prompts.js';

export { MAIL_TRIAGE_SPEC };

export const MAIL_REPLY_SPEC: AgentSpec = {
  name: 'mail',
  jobType: 'mail.reply',
  title: 'Mail reply',
  promptFiles: ['mail-reply.md'],
  tools: [...MAIL_REPLY_TOOLS],
  allowRead: false,
  resultSchemaId: 'drafter',
  defaults: { model: 'claude-opus-5-5', effort: 'medium', maxTurns: 12, timeoutMs: 8 * 60_000 },
};

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** A non-ok AI outcome as a job outcome (null for ok). */
export function aiFailureOutcome(ctx: AppContext, o: AiRunOutcome): JobOutcome | null {
  switch (o.kind) {
    case 'ok':
      return null;
    case 'usage_limited':
      return { kind: 'wait_usage', until: o.resetsAt ?? new Date(Date.parse(ctx.now()) + 15 * 60_000).toISOString() };
    case 'auth_failed':
      return { kind: 'fail', reason: `AI sign-in failed: ${o.message}` };
    case 'refused':
      return { kind: 'fail', reason: `The model refused: ${o.explanation ?? o.category ?? 'no reason given'}` };
    case 'invalid_output':
      return { kind: 'retry', afterMs: 60_000, reason: `invalid output: ${o.errors.slice(0, 3).join('; ')}` };
    case 'timeout':
      return { kind: 'retry', afterMs: 60_000, reason: 'the model run timed out' };
    case 'error':
      return o.retryable ? { kind: 'retry', afterMs: 60_000, reason: o.message } : { kind: 'fail', reason: o.message };
  }
}

const isAiOff = (o: AiRunOutcome): boolean => o.kind === 'error' && (o.code === 'AI_OFF' || o.code === 'REAL_AI_FORBIDDEN' || o.code === 'FAKE_AI_NOT_ALLOWED');

// ---------------------------------------------------------------------------
// mail.sync / mail.ingest / mail.ingest_file
// ---------------------------------------------------------------------------

const syncHandler: JobHandler<{ accountId?: string }> = {
  type: 'mail.sync',
  agent: 'mail',
  lane: 'io',
  usesAi: false,
  mutatesClaim: false,
  payload: z.object({ accountId: z.string().optional() }).passthrough(),
  defaultPriority: 2,
  maxAttempts: 1,
  timeoutMs: 15 * 60_000,
  async run({ ctx, job, payload }) {
    const account = payload.accountId ? ctx.repos.getMailAccount(ctx.db, payload.accountId) : mailAccount(ctx);
    if (!account || !account.enabled) {
      // No mailbox yet: still pick up dropped .eml files.
      return { kind: 'done', result: { skipped: 'no enabled mailbox', filesQueued: queueStagedFiles(ctx, { parentJobId: job.id, correlationId: job.correlationId }) } };
    }
    let mailbox;
    try {
      mailbox = await mailboxFor(ctx, account);
      await mailbox.connect();
    } catch (err) {
      const n = recordConnectionFailure(ctx, account, err instanceof Error ? err.message : String(err));
      return { kind: 'done', result: { offline: true, failures: n, error: String(err), filesQueued: queueStagedFiles(ctx, { parentJobId: job.id, correlationId: job.correlationId }) } };
    }
    recordConnectionOk(ctx, account.id);
    try {
      const r = await syncMailbox(ctx, account, mailbox, { parentJobId: job.id, correlationId: job.correlationId });
      return { kind: 'done', result: r };
    } finally {
      if (ctx.config.mailTransport !== 'fake') await mailbox.close().catch(() => undefined);
    }
  },
};

const ingestHandler: JobHandler<{ accountId: string; folder: string; uidvalidity: number; uid: number }> = {
  type: 'mail.ingest',
  agent: 'mail',
  lane: 'io',
  usesAi: false,
  mutatesClaim: true,
  payload: z.object({ accountId: z.string(), folder: z.string(), uidvalidity: z.number().int(), uid: z.number().int().positive() }),
  defaultPriority: 2,
  maxAttempts: 5,
  timeoutMs: 10 * 60_000,
  async run({ ctx, job, payload }) {
    const account = ctx.repos.getMailAccount(ctx.db, payload.accountId);
    if (!account) return { kind: 'fail', reason: `mail account ${payload.accountId} no longer exists` };
    const mailbox = await mailboxFor(ctx, account);
    try {
      await mailbox.connect();
    } catch (err) {
      recordConnectionFailure(ctx, account, String(err));
      return { kind: 'retry', afterMs: 5 * 60_000, reason: String(err) };
    }
    try {
      const r = await ingestOneUid(ctx, account, mailbox, payload, { parentJobId: job.id, correlationId: job.correlationId });
      return { kind: 'done', result: r };
    } catch (err) {
      return { kind: 'retry', afterMs: 2 * 60_000, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      if (ctx.config.mailTransport !== 'fake') await mailbox.close().catch(() => undefined);
    }
  },
};

const ingestFileHandler: JobHandler<{ importId: string }> = {
  type: 'mail.ingest_file',
  agent: 'mail',
  lane: 'io',
  usesAi: false,
  mutatesClaim: true,
  payload: z.object({ importId: z.string().min(1) }),
  defaultPriority: 3,
  maxAttempts: 3,
  timeoutMs: 10 * 60_000,
  async run({ ctx, job, payload }) {
    const imp = getStagedImport(ctx, payload.importId);
    if (!imp) return { kind: 'fail', reason: `import ${payload.importId} not found` };
    if (imp.status === 'consumed') return { kind: 'done', result: { skipped: 'already consumed', result: imp.result ?? null } };
    const ext = path.extname(imp.filename).toLowerCase();
    if (ext === '.msg' || imp.mime === 'application/vnd.ms-outlook') {
      markImportFailed(ctx, imp.id, 'Outlook .msg files are not read yet — save the email as .eml (File > Save As) and drop that instead');
      createNeedsYou(ctx, {
        kind: 'question',
        title: `Cannot read ${imp.filename} yet`,
        summary: 'Outlook .msg files are not supported in this version. Save the email as .eml (or forward it to the claims mailbox) and drop the .eml into the mail import folder.',
        options: [{ id: 'ok', label: 'Done', tone: 'primary' }],
        payload: { importId: imp.id },
        priority: 'low',
        createdBy: MAIL_AGENT,
        dedupeKey: `mail.msg:${imp.id}`,
      });
      return { kind: 'done', result: { skipped: 'msg' } };
    }
    let raw: Buffer;
    try {
      raw = readFileSync(stagedImportPath(ctx, imp.id));
    } catch (err) {
      markImportFailed(ctx, imp.id, `file missing: ${String(err)}`);
      return { kind: 'fail', reason: `the imported file is missing: ${String(err)}` };
    }
    const accountId = mailAccount(ctx)?.id ?? LOCAL_FILES_ACCOUNT;
    const r = await ingestRaw(ctx, accountId, raw, { source: 'file', parentJobId: job.id, correlationId: job.correlationId });
    markImportConsumed(ctx, imp.id, 'mail', { mailMessageId: r.message.id, duplicate: r.duplicate });
    return { kind: 'done', result: { mailMessageId: r.message.id, duplicate: r.duplicate, status: r.message.status } };
  },
};

// ---------------------------------------------------------------------------
// mail.triage
// ---------------------------------------------------------------------------

/** Store the classification (append-only) with the deterministic cross-check beside it. */
export function recordClassification(ctx: AppContext, messageId: string, result: MailTriageResult, check: ReturnType<typeof crossCheck>, run: { runId?: string; driver?: string; model?: string; promptVersion?: string }): MailClassificationRecord {
  return ctx.repos.appendMailClassification(ctx.db, {
    mailMessageId: messageId,
    runId: run.runId ?? null,
    driver: run.driver ?? null,
    model: run.model ?? null,
    promptVersion: run.promptVersion ?? null,
    intent: result.intent,
    secondary: result.secondaryIntents,
    confidence: Math.max(0, Math.min(1, result.confidence)),
    extracted: result.extracted,
    summary: result.summary.slice(0, 4000),
    injection: { suspected: result.injectionSuspected || check.injectionFlags.length > 0, notes: result.injectionNotes, flags: check.injectionFlags, model: result.injectionSuspected },
    deterministic: { ...check, urgency: result.urgency, needsReply: result.needsReply },
    now: ctx.now(),
  });
}

const triageHandler: JobHandler<{ messageId: string }> = {
  type: 'mail.triage',
  agent: 'mail',
  lane: 'ai',
  usesAi: true,
  mutatesClaim: true,
  payload: z.object({ messageId: z.string().min(1) }).passthrough(),
  defaultPriority: 1,
  maxAttempts: 3,
  timeoutMs: 4 * 60_000,
  async run({ ctx, job, payload }) {
    const message = ctx.repos.getMailMessage(ctx.db, payload.messageId);
    if (!message) return { kind: 'fail', reason: `message ${payload.messageId} not found` };
    if (message.status === 'quarantined') return { kind: 'done', result: { skipped: 'quarantined' } };
    const existing = ctx.repos.latestMailClassification(ctx.db, message.id);
    if (existing) {
      const applied = await applyTriage(ctx, message, existing, { id: job.id, correlationId: job.correlationId });
      return { kind: 'done', result: { classificationId: existing.id, reused: true, ...applied } };
    }
    const attachments = ctx.repos.listMailAttachments(ctx.db, message.id);
    const reference = message.claimId ? ctx.repos.getClaim(ctx.db, message.claimId)?.reference : undefined;
    const run = await runAgent(ctx, MAIL_TRIAGE_SPEC, job as JobRecord, triageInput(message, attachments, reference));
    if (isAiOff(run.outcome)) {
      // No AI: the email is still filed in the chronology; the owner reads it in the Mailbox tab.
      if (message.claimId) {
        const filed = await fileMessageEvidence(ctx, message, message.claimId);
        const already = ctx.repos.listEvents(ctx.db, message.claimId, { type: 'email_in' }).some((e) => (e.data as { mailMessageId?: string } | undefined)?.mailMessageId === message.id);
        if (!already) {
          appendClaimEvent(ctx, message.claimId, { type: 'email_in', at: message.sentAt ?? message.receivedAt, summary: `Email from ${message.fromName || message.fromAddr || 'unknown'}: ${message.subject ?? '(no subject)'}`, data: { mailMessageId: message.id, triaged: false }, evidenceIds: [filed.rawEvidenceId, ...filed.attachments.map((a) => a.evidenceId)] }, MAIL_ACTOR);
        }
      }
      return { kind: 'done', result: { triaged: false, reason: run.outcome.kind === 'error' ? run.outcome.message : 'AI unavailable' } };
    }
    const failure = aiFailureOutcome(ctx, run.outcome);
    if (failure) return failure;
    const result = run.result as MailTriageResult;
    const check = crossCheck(`${message.subject ?? ''}\n${message.bodyText ?? ''}`, await storedHtml(ctx, message), result);
    const agentRun = ctx.repos.getAgentRun(ctx.db, run.runId);
    const classification = recordClassification(ctx, message.id, result, check, { runId: run.runId, driver: agentRun?.driver, model: agentRun?.model, promptVersion: agentRun?.promptVersion });
    const fresh = ctx.repos.requireMailMessage(ctx.db, message.id);
    const applied = await applyTriage(ctx, fresh, classification, { id: job.id, correlationId: job.correlationId });
    return { kind: 'done', result: { classificationId: classification.id, intent: result.intent, ...applied } };
  },
};

// ---------------------------------------------------------------------------
// mail.reply
// ---------------------------------------------------------------------------

const replyPayload = z
  .object({
    claimId: z.string().min(1),
    messageId: z.string().min(1),
    plan: z.string().max(8000),
    keyPoints: z.array(z.string().max(2000)).max(30).default([]),
    repairOf: z.string().optional(),
    issues: z.array(z.unknown()).max(50).optional(),
    loop: z.number().int().min(0).max(10).optional(),
  })
  .passthrough();
type ReplyPayload = z.infer<typeof replyPayload>;

const replyHandler: JobHandler<ReplyPayload> = {
  type: 'mail.reply',
  agent: 'mail',
  lane: 'ai',
  usesAi: true,
  mutatesClaim: true,
  payload: replyPayload,
  defaultPriority: 2,
  maxAttempts: 3,
  timeoutMs: 10 * 60_000,
  async run({ ctx, job, payload }) {
    const message = ctx.repos.getMailMessage(ctx.db, payload.messageId);
    if (!message || message.claimId !== payload.claimId) return { kind: 'fail', reason: `message ${payload.messageId} is not filed on claim ${payload.claimId}` };
    if (!job.claimId) return { kind: 'fail', reason: 'mail.reply must run scoped to its claim' };
    const claim = ctx.repos.requireClaim(ctx.db, payload.claimId);
    const thread = ctx.repos.listMailThread(ctx.db, message.threadKey).filter((m) => m.claimId === claim.id).slice(-6);
    const issues = (payload.issues ?? []) as Array<{ code?: string; message?: string; fix?: string | null }>;
    const run = await runAgent(ctx, MAIL_REPLY_SPEC, job as JobRecord, {
      task: `Draft the reply to the email ${message.id} on claim ${claim.reference} (claimId ${claim.id}) following the case manager's plan.`,
      untrusted: thread.map((m) => ({ kind: 'email' as const, id: m.id, text: `From: ${m.fromAddr ?? ''}\nTo: ${m.toJson.join(', ')}\nSubject: ${m.subject ?? ''}\n\n${(m.bodyText ?? '').slice(0, 12_000)}` })),
      question: [
        `Plan: ${payload.plan}`,
        payload.keyPoints.length ? `Key points:\n${payload.keyPoints.map((k) => `- ${k}`).join('\n')}` : '',
        issues.length ? `This is repair loop ${payload.loop ?? 1}. The reviewer found:\n${issues.map((i) => `- ${i.code ?? 'ISSUE'}: ${i.message ?? ''}${i.fix ? ` (fix: ${i.fix})` : ''}`).join('\n')}` : '',
        `Use email_draft once with claimId ${claim.id} and inReplyToMessageId ${message.id}. Reply to ${message.replyTo ?? message.fromAddr ?? 'the sender'} unless the plan says otherwise. Then return the DrafterResult JSON.`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    const failure = aiFailureOutcome(ctx, run.outcome);
    if (failure) return isAiOff(run.outcome) ? { kind: 'fail', reason: 'AI is off; the reply was not drafted' } : failure;
    const result = run.result as DrafterResult;
    if (!result.drafts.length) {
      const ny = createNeedsYou(ctx, {
        kind: result.missingInfo.length ? 'missing_info' : 'question',
        claimId: claim.id,
        title: `Reply not drafted on ${claim.reference}`,
        summary: `${result.notes || 'The mail agent could not draft the reply.'}${result.missingInfo.length ? ` Missing: ${result.missingInfo.join('; ')}` : ''}`.slice(0, 2000),
        options: [{ id: 'ok', label: 'Done', tone: 'primary' }],
        payload: { messageId: message.id, missingInfo: result.missingInfo, runId: run.runId },
        priority: 'normal',
        createdBy: MAIL_AGENT,
        dedupeKey: `mail.reply.none:${message.id}:${payload.loop ?? 0}`,
        correlationId: job.correlationId,
      });
      return { kind: 'done', result: { drafts: 0, needsYouId: ny.id } };
    }
    return { kind: 'done', result: { drafts: result.drafts.map((d) => d.id), missingInfo: result.missingInfo, runId: run.runId } };
  },
};

// ---------------------------------------------------------------------------
// outbox.after_review / outbox.release
// ---------------------------------------------------------------------------

const afterReviewHandler: JobHandler<{ outboxId: string; reviewId?: string }> = {
  type: 'outbox.after_review',
  agent: 'mail',
  lane: 'io',
  usesAi: false,
  mutatesClaim: false,
  payload: z.object({ outboxId: z.string().min(1), reviewId: z.string().optional() }).passthrough(),
  defaultPriority: 1,
  maxAttempts: 3,
  timeoutMs: 5 * 60_000,
  async run({ ctx, job, payload }) {
    const r = await afterReview(ctx, payload.outboxId, payload.reviewId, job);
    return { kind: 'done', result: r };
  },
};

const releaseHandler: JobHandler<{ outboxId: string }> = {
  type: 'outbox.release',
  agent: 'mail',
  lane: 'io',
  usesAi: false,
  mutatesClaim: true,
  payload: z.object({ outboxId: z.string().min(1) }).passthrough(),
  defaultPriority: 0,
  maxAttempts: 1,
  timeoutMs: 5 * 60_000,
  async run({ ctx, job, payload }) {
    const r = await releaseOutbox(ctx, payload.outboxId, job);
    // Continuations keep the correlation id but are not hand-offs (no depth growth).
    for (const f of r.followUps) {
      const o = ctx.repos.getOutbox(ctx.db, r.outboxId);
      enqueueJob(ctx, { type: 'outbox.release', payload: { outboxId: r.outboxId }, ...(o?.claimId ? { claimId: o.claimId } : {}), runAfter: f.runAfter, idempotencyKey: f.key, createdBy: MAIL_AGENT, correlationId: job.correlationId });
    }
    return { kind: 'done', result: r };
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each handler has its own payload/result types
export const mailJobHandlers: JobHandler<any, any>[] = [syncHandler, ingestHandler, ingestFileHandler, triageHandler, replyHandler, afterReviewHandler, releaseHandler];

// ---------------------------------------------------------------------------
// Resolvers (run as the signed-in owner)
// ---------------------------------------------------------------------------

/** approve_send / missing_info: approve (optionally edited) → queued now, approved_by owner; reject → cancelled. */
function sendResolver(kind: 'approve_send' | 'missing_info'): NeedsYouResolver<{ outboxId?: string }> {
  return {
    kind,
    async resolve(ctx, item, choice, actor: Actor) {
      const outboxId = item.payload?.outboxId;
      if (!outboxId) return; // a plain missing-info question (no prepared email): resolving records the answer only
      const o = ctx.repos.getOutbox(ctx.db, outboxId);
      if (!o || o.status === 'cancelled' || o.status === 'sent') return;
      if (choice.optionId === 'reject' || choice.optionId === 'cancel') {
        rejectOutbox(ctx, outboxId, actor, choice.note ?? 'rejected by the owner');
        return;
      }
      if (choice.optionId === 'approve' || choice.optionId === 'edit' || choice.optionId === 'send') {
        approveOutbox(ctx, outboxId, actor, parseOwnerEdits(choice.edits), choice.note);
      }
    },
  };
}

const whichClaimResolver: NeedsYouResolver<{ messageId: string }> = {
  kind: 'which_claim',
  async resolve(ctx, item, choice, actor) {
    const messageId = item.payload?.messageId;
    if (!messageId) return;
    const claimId = choice.optionId.startsWith('claim:') ? choice.optionId.slice('claim:'.length) : null;
    await linkMessageToClaim(ctx, messageId, claimId, 'owner', actor, choice.note ?? (claimId ? 'chosen by the owner' : 'none of the suggested claims'), { ...(item.correlationId ? { correlationId: item.correlationId } : {}) });
  },
};

const spoofResolver: NeedsYouResolver<{ messageId: string; reason?: string }> = {
  kind: 'spoof_warning',
  async resolve(ctx, item, choice, actor) {
    const messageId = item.payload?.messageId;
    if (!messageId || choice.optionId !== 'release') return; // keep quarantined / leave it with the owner
    const m = ctx.repos.getMailMessage(ctx.db, messageId);
    if (!m) return;
    ctx.repos.appendAudit(ctx.db, { actor, action: 'mail.release', entity: 'mail_messages', entityId: m.id, after: { reason: choice.note ?? null, wasStatus: m.status }, at: ctx.now() });
    const correlationId = item.correlationId ?? randomUUID();
    if (m.status === 'quarantined') {
      const match = ctx.repos.latestMailMatch(ctx.db, m.id);
      const top = ((match?.signals as { candidates?: Array<{ claimId: string; score: number }> } | undefined)?.candidates ?? [])[0];
      const second = ((match?.signals as { candidates?: Array<{ claimId: string; score: number }> } | undefined)?.candidates ?? [])[1];
      if (top && top.score >= 90 && top.score - (second?.score ?? 0) >= 30) {
        await linkMessageToClaim(ctx, m.id, top.claimId, 'owner', actor, `released from quarantine: ${choice.note ?? ''}`.trim(), { correlationId });
      } else {
        ctx.repos.updateMailMessageRouting(ctx.db, m.id, { status: top && top.score >= 50 ? 'needs_match' : 'unmatched' });
      }
      return;
    }
    // Flagged at triage (instructions / bank details): the owner says it is fine — the case manager takes it from here.
    if (m.claimId) {
      enqueueJob(ctx, { type: 'case.review', payload: { reason: 'inbound', messageId: m.id, claimId: m.claimId, releasedByOwner: true }, claimId: m.claimId, priority: 1, idempotencyKey: `case.review:${m.claimId}:released:${m.id}`, createdBy: actor.userId, correlationId });
    }
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each resolver has its own payload type
export const mailNeedsYouResolvers: NeedsYouResolver<any>[] = [sendResolver('approve_send'), sendResolver('missing_info'), whichClaimResolver, spoofResolver];

/** For tests and the reviewer: the untrusted wrapping used in prompts. */
export { wrapUntrusted };
