// owned by intake-server
/**
 * The request to the client for the documents still missing (docs/SMART-INTAKE.md §6.10, improvement 4). Prepared by
 * `agent:intake`, never sent by it: with the client's email and a mailbox set up it becomes an outbox `doc_request`
 * draft, which the review and the outbox policy always put in front of the owner (Needs-you `missing_info`);
 * otherwise a Needs-you `question` holds the prepared text for the owner to send however they like.
 */
import { requestEmailText, type ChecklistItem } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import { createNeedsYou } from '../../agent/core.js';
import { HttpError } from '../../errors.js';
import { mailAccount } from '../../mail/common.js';
import { createEmailDraft } from '../../mail/outbox.js';
import { BUNDLE_AGENT } from './hooks.js';

export interface RequestResult {
  outboxId: string | null;
  needsYouId: string | null;
  reason: string | null;
}

export function prepareMissingDocsRequest(ctx: AppContext, input: { claimId: string; bundleId: string; items: ChecklistItem[] }): RequestResult {
  const claim = ctx.repos.requireClaim(ctx.db, input.claimId);
  const wanted = input.items.filter((i) => (i.status === 'missing' || i.status === 'partial') && i.id !== 'signed_hire_docs');
  if (!wanted.length) return { outboxId: null, needsYouId: null, reason: 'Nothing is missing' };
  const client = ctx.repos.getParty(ctx.db, claim.claimantId);
  const firstName = client?.name.split(/\s+/)[0] ?? null;
  const { subject, body } = requestEmailText(input.items, firstName, claim.reference);
  const now = ctx.now();
  let result: RequestResult = { outboxId: null, needsYouId: null, reason: null };
  const email = client?.email?.trim();
  if (email && mailAccount(ctx)) {
    try {
      const d = createEmailDraft(ctx, { claimId: claim.id, kind: 'doc_request', to: [email], cc: [], subject, bodyText: body, attach: [], inReplyToMessageId: null }, BUNDLE_AGENT, { loop: 0 });
      result = { outboxId: d.outbox.id, needsYouId: null, reason: null };
    } catch (err) {
      result.reason = err instanceof HttpError ? err.message : String(err);
    }
  } else {
    result.reason = !email ? 'No email address for the client' : 'No mailbox is set up (Settings > Email)';
  }
  if (!result.outboxId) {
    const item = createNeedsYou(ctx, {
      kind: 'question',
      claimId: claim.id,
      title: `Ask ${client?.name ?? 'the client'} for the missing documents`,
      summary: `${result.reason ?? ''} — here is the prepared request (${wanted.length} item${wanted.length === 1 ? '' : 's'}):\n\nSubject: ${subject}\n\n${body}`.replace(/^ — /, '').slice(0, 4000),
      options: [
        { id: 'done', label: 'I have asked them', tone: 'primary' },
        { id: 'not_needed', label: 'Not needed', tone: 'neutral' },
      ],
      payload: { bundleId: input.bundleId, claimId: claim.id, text: body, subject },
      priority: 'normal',
      createdBy: BUNDLE_AGENT,
      dedupeKey: `intake:request_docs:${claim.id}`,
    });
    result.needsYouId = item.id;
  }
  ctx.repos.appendAudit(ctx.db, { actor: { userId: BUNDLE_AGENT }, action: 'intake.bundle.request_docs', entity: 'intake_bundles', entityId: input.bundleId, after: { claimId: claim.id, items: wanted.map((i) => i.id), outboxId: result.outboxId, needsYouId: result.needsYouId }, at: now });
  return result;
}
