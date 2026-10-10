// owned by knowledge-core
/**
 * One knowledge write = one append-only `knowledge_changes` row + one `audit_log` row with the actor, the rule ids, the
 * run and the job (docs/SUPREME-KNOWLEDGE-BUILDER.md §10.5, §12.4, KR-12). Every knowledge module records through here.
 */
import type { Actor, Db } from '@ccguk/db';
import type { KnowledgeItem } from '@ccguk/domain';
import type { AppContext } from '../context.js';

export interface ChangeInput {
  action: string;
  item?: Pick<KnowledgeItem, 'id' | 'itemKey' | 'gapId'> | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ruleIds?: string[];
  runId?: string | null;
  jobId?: string | null;
  needsYouId?: string | null;
  packVersion?: number | null;
}

/** One knowledge_changes row + one audit_log row (KR-12). */
export function recordKnowledgeChange(ctx: AppContext, tx: Db, actor: Actor, at: string, c: ChangeInput): void {
  ctx.repos.appendKnowledgeChange(tx, {
    at,
    actor: actor.userId,
    action: c.action,
    itemId: c.item?.id ?? null,
    itemKey: c.item?.itemKey ?? null,
    gapId: c.item?.gapId ?? null,
    packVersion: c.packVersion ?? null,
    before: c.before ?? null,
    after: c.after ?? null,
    reason: c.reason ?? null,
    ruleIds: c.ruleIds ?? [],
    runId: c.runId ?? actor.runId ?? null,
    jobId: c.jobId ?? null,
    needsYouId: c.needsYouId ?? null,
  });
  ctx.repos.appendAudit(tx, {
    actor,
    action: c.action,
    entity: c.item ? 'knowledge_items' : c.packVersion !== undefined && c.packVersion !== null ? 'knowledge_pack_versions' : 'knowledge',
    entityId: c.item?.id ?? (c.packVersion !== undefined && c.packVersion !== null ? String(c.packVersion) : 'knowledge'),
    ...(c.before !== undefined ? { before: c.before } : {}),
    after: { ...(typeof c.after === 'object' && c.after !== null ? (c.after as Record<string, unknown>) : c.after !== undefined ? { value: c.after } : {}), ...(c.reason ? { reason: c.reason } : {}), ...(c.ruleIds?.length ? { ruleIds: c.ruleIds } : {}), ...(c.item ? { itemKey: c.item.itemKey } : {}) },
    at,
  });
}
