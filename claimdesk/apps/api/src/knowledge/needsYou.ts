// owned by knowledge-core
/**
 * Needs-you `knowledge_review` cards (docs/SUPREME-KNOWLEDGE-BUILDER.md §9.3). Grouping keeps the inbox calm: one card
 * per insurer's contacts, per curator cluster, per gap and per conflict (the dedupe key comes from the group; a queued
 * item joins the open card of its group through `knowledge_items.needs_you_id`). At most `needsYouPerDay` (5) NEW
 * knowledge cards a day reach Needs-you; the rest wait in Knowledge ▸ Approve and are counted in the digest.
 * Priority: low by default, normal for blocking gaps, high for red-line / perimeter conflicts and severe alarms.
 */
import type { KnowledgeConflict, KnowledgeDecision, KnowledgeItem, KnowledgeReviewPayload, NeedsYouOption, NeedsYouPriority } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { NeedsYouItem } from '../agent/contracts.js';
import { createNeedsYou, londonDayWindow } from '../agent/core.js';
import { getKnowledgeSettings } from './settings.js';

/** The options each card variant offers (§9.3). */
export function knowledgeReviewOptions(payload: KnowledgeReviewPayload, opts: { allQuotesMatched?: boolean } = {}): NeedsYouOption[] {
  switch (payload.variant) {
    case 'items':
      return [
        { id: 'approve', label: 'Approve', tone: 'primary' },
        ...(opts.allQuotesMatched ? [{ id: 'approve_source_verified', label: 'Approve as source-verified', tone: 'primary' as const }] : []),
        { id: 'edit_approve', label: 'Edit then approve', tone: 'neutral', requiresEdit: true },
        { id: 'reject', label: 'Reject', tone: 'danger', requiresReason: true },
      ];
    case 'conflict':
      return [
        { id: 'keep_left', label: 'Keep the new one', tone: 'primary' },
        { id: 'keep_right', label: 'Keep the existing one', tone: 'neutral' },
        { id: 'keep_both', label: 'Keep both (different scope)', tone: 'neutral' },
        { id: 'retire_both', label: 'Retire both', tone: 'danger' },
      ];
    case 'alarm':
      return [
        ...(payload.suggestedRollbackTo !== null ? [{ id: 'rollback', label: `Roll back to v${payload.suggestedRollbackTo}`, tone: 'danger' as const }] : []),
        { id: 'acknowledge', label: 'Acknowledge', tone: 'neutral' },
      ];
    case 'gap':
      return [
        { id: 'answer', label: 'I know the answer', tone: 'primary', requiresEdit: true },
        { id: 'dismiss', label: 'Dismiss', tone: 'neutral', requiresReason: true },
      ];
  }
}

/** New knowledge_review cards created today (London day). */
export function knowledgeCardsToday(ctx: AppContext): number {
  const { dayStart, dayEnd } = londonDayWindow(ctx.now());
  const row = ctx.handle.sqlite.prepare(`SELECT count(*) AS c FROM needs_you WHERE kind = 'knowledge_review' AND created_at >= ? AND created_at < ?`).get(dayStart, dayEnd) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

export interface RaiseKnowledgeReviewInput {
  payload: KnowledgeReviewPayload;
  title: string;
  summary: string;
  priority: NeedsYouPriority;
  dedupeKey: string;
  createdBy: string;
  claimId?: string;
  allQuotesMatched?: boolean;
  /** severe alarms and red-line / perimeter conflicts are never held back by the daily cap */
  bypassCap?: boolean;
}

/**
 * Create (or return the open card with the same dedupe key). Returns undefined when today's cap is reached — the item
 * still waits in Knowledge ▸ Approve. Cards are created by the system or an agent principal, never as the owner.
 */
export function raiseKnowledgeReview(ctx: AppContext, input: RaiseKnowledgeReviewInput): NeedsYouItem | undefined {
  const existing = ctx.repos.findOpenNeedsYouByDedupeKey(ctx.db, input.dedupeKey);
  if (existing) return existing;
  const cap = getKnowledgeSettings(ctx).needsYouPerDay;
  if (!input.bypassCap && knowledgeCardsToday(ctx) >= cap) return undefined;
  const createdBy = input.createdBy.startsWith('agent:') || input.createdBy === 'system' ? input.createdBy : 'agent:supervisor';
  return createNeedsYou(ctx, {
    kind: 'knowledge_review',
    ...(input.claimId ? { claimId: input.claimId } : {}),
    title: input.title.slice(0, 200),
    summary: input.summary.slice(0, 2000),
    options: knowledgeReviewOptions(input.payload, { allQuotesMatched: input.allQuotesMatched }),
    payload: input.payload,
    priority: input.priority,
    createdBy,
    dedupeKey: input.dedupeKey,
  });
}

/** Card group for a queued item: insurer contacts, curator cluster, or the item itself. */
export function cardGroupFor(item: KnowledgeItem): { key: string; title: string } {
  if (item.kind === 'contact' && item.scope.kind === 'insurer') return { key: `knowledge_review:contacts:${item.scope.slug}`, title: `New contact details for ${item.scope.slug}` };
  const cluster = item.provenance.find((p) => p.kind === 'correction');
  if (item.origin === 'curated' && cluster && item.itemKey.startsWith('rule:')) return { key: `knowledge_review:rule:${item.itemKey}`, title: `Proposed rule: ${item.title}` };
  if (item.origin === 'curated') return { key: `knowledge_review:curated:${item.tags.find((t) => t.startsWith('cluster:')) ?? item.itemKey}`, title: `Your edits suggest: ${item.title}` };
  return { key: `knowledge_review:item:${item.itemKey}`, title: `${labelOf(item)}: ${item.title}` };
}

const labelOf = (i: KnowledgeItem): string =>
  i.kind === 'rule' ? 'Proposed rule' : i.kind === 'precedent' ? 'Legal point to check' : i.area === 'legal' ? 'Legal point to check' : i.area === 'quantum' ? 'Quantum point to check' : i.kind === 'strategy' ? 'Proposed strategy' : 'Knowledge to check';

const allQuotesMatched = (i: KnowledgeItem): boolean => {
  const snaps = i.provenance.filter((p) => p.kind === 'snapshot');
  return snaps.length > 0 && snaps.every((p) => p.kind === 'snapshot' && p.quoteMatch === 'exact');
};

/** Raise (or join) the card for a queued item; links the item to it. */
export function raiseItemsCard(ctx: AppContext, item: KnowledgeItem, decision: KnowledgeDecision, opts: { createdBy: string; group?: { key: string; title: string } }): NeedsYouItem | undefined {
  const group = opts.group ?? cardGroupFor(item);
  const existing = ctx.repos.findOpenNeedsYouByDedupeKey(ctx.db, group.key);
  const card =
    existing ??
    raiseKnowledgeReview(ctx, {
      payload: { variant: 'items', groupTitle: group.title, itemIds: [item.id], replayRunId: null },
      title: group.title,
      summary: `${decision.reasons.join('; ') || 'Waits for you'}. ${item.body.slice(0, 600)}`,
      priority: decision.priority,
      dedupeKey: group.key,
      createdBy: opts.createdBy,
      allQuotesMatched: allQuotesMatched(item),
    });
  if (card) ctx.repos.updateKnowledgeItemState(ctx.db, item.id, { needsYouId: card.id, updatedAt: ctx.now() });
  return card;
}

/** A conflict card (§8.4): high priority for red-line and perimeter conflicts (never held back by the cap). */
export function raiseConflictCard(ctx: AppContext, c: KnowledgeConflict, createdBy: string): NeedsYouItem | undefined {
  const high = c.kind === 'red_line' || c.kind === 'perimeter';
  const card = raiseKnowledgeReview(ctx, {
    payload: { variant: 'conflict', conflictId: c.id },
    title: `Knowledge conflict (${c.kind.replace(/_/g, ' ')})`,
    summary: c.detail,
    priority: high ? 'high' : 'normal',
    dedupeKey: `knowledge_review:conflict:${c.id}`,
    createdBy,
    bypassCap: high,
  });
  if (card && c.needsYouId !== card.id) ctx.repos.updateKnowledgeConflict(ctx.db, c.id, { needsYouId: card.id });
  return card;
}
