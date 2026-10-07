// owned by mail
/**
 * Filing a message on a claim after ingest (docs/SUPREME-DESIGN.md §F.4): the owner (which_claim, POST
 * /mail/messages/:id/link) or an agent (mail_link_claim, policy-checked). A new append-only `mail_matches` row records
 * who decided; the message's evidence is copied onto the claim; triage then continues (or starts) for it.
 */
import { randomUUID } from 'node:crypto';
import type { Actor, MailMessageRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { enqueueJob } from '../agent/core.js';
import { conflict } from '../errors.js';
import { MAIL_AGENT, fileMessageEvidence } from './common.js';
import { applyTriage, type TriageApplied } from './triage.js';

export interface LinkResult {
  message: MailMessageRecord;
  triage?: TriageApplied;
  triageJobId?: string;
}

export async function linkMessageToClaim(ctx: AppContext, messageId: string, claimId: string | null, decidedBy: 'agent' | 'owner', actor: Actor, reason: string, opts: { correlationId?: string } = {}): Promise<LinkResult> {
  const msg = ctx.repos.requireMailMessage(ctx.db, messageId);
  if (msg.direction !== 'in') throw conflict('MAIL_DIRECTION', 'Only inbound messages are filed this way');
  if (msg.status === 'quarantined' && decidedBy !== 'owner') throw conflict('MAIL_QUARANTINED', 'A quarantined message is released only by the owner');
  const previous = ctx.repos.latestMailMatch(ctx.db, messageId);
  const candidate = claimId ? ((previous?.signals as { candidates?: Array<{ claimId: string; score: number }> } | undefined)?.candidates ?? []).find((c) => c.claimId === claimId) : undefined;
  if (claimId) ctx.repos.requireClaim(ctx.db, claimId);
  const now = ctx.now();
  const updated = ctx.db.transaction(() => {
    ctx.repos.appendMailMatch(ctx.db, { mailMessageId: messageId, claimId, score: candidate?.score ?? 0, signals: { decision: claimId ? 'linked' : 'none', reason, previousClaimId: msg.claimId ?? null, previousMatchId: previous?.id ?? null }, decidedBy, now });
    const m = ctx.repos.updateMailMessageRouting(ctx.db, messageId, { claimId, status: claimId ? 'matched' : 'unmatched' });
    ctx.repos.appendAudit(ctx.db, { actor, action: 'mail.link', entity: 'mail_messages', entityId: messageId, before: { claimId: msg.claimId ?? null, status: msg.status }, after: { claimId, decidedBy, reason }, at: now });
    return m;
  });
  if (!claimId) {
    enqueueJob(ctx, { type: 'intake.process', payload: { evidenceId: msg.rawEvidenceId, claimId: null, source: 'email', mailMessageId: msg.id }, idempotencyKey: `intake.process:mail:${msg.id}`, createdBy: actor.userId });
    return { message: updated };
  }
  await fileMessageEvidence(ctx, updated, claimId, actor);
  const classification = ctx.repos.latestMailClassification(ctx.db, messageId);
  const correlationId = opts.correlationId ?? randomUUID();
  if (classification) {
    const triage = await applyTriage(ctx, ctx.repos.requireMailMessage(ctx.db, messageId), classification, { correlationId });
    return { message: ctx.repos.requireMailMessage(ctx.db, messageId), triage };
  }
  const job = enqueueJob(ctx, { type: 'mail.triage', payload: { messageId }, claimId, idempotencyKey: `mail.triage:${messageId}:${claimId}`, createdBy: decidedBy === 'owner' ? actor.userId : MAIL_AGENT, correlationId });
  return { message: updated, triageJobId: job.id };
}
