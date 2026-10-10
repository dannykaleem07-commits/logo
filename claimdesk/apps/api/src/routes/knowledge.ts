// owned by knowledge-core
/**
 * Knowledge Builder core routes (docs/SUPREME-KNOWLEDGE-BUILDER.md §10.3). All under `/api`, session auth. Every write
 * is human-only: the store asserts a person (`assertHuman`) and no agent tool declares these routes, so the perimeter
 * refuses run tokens (SD §B.2 rule 1). DTOs: @ccguk/domain knowledge/api.ts.
 *
 *   GET  /knowledge/items?status=&kind=&area=&scope=&verification=&q=&limit=&offset=
 *   GET  /knowledge/items/:id                      item, versions, checks, changes, usage, conflicts
 *   GET  /knowledge/queue                          the approval queue (grouped)
 *   POST /knowledge/items/:id/approve              {note?, verification?, sourceUrl?, snapshotId?}
 *   POST /knowledge/items/:id/edit-approve         {title, body, data, scope, note?}
 *   POST /knowledge/items/:id/reject               {reason}
 *   POST /knowledge/items/:id/retire               {reason}            (also the digest's Undo)
 *   POST /knowledge/items/:id/check                {result, method, sourceUrl?, snapshotId?, quote?, note?}
 *   POST /knowledge/items                          {kind, area, title, body, data, scope, gapId?}  owner adds knowledge
 *   POST /knowledge/kb/:entryId/check              KB overlay check
 *   GET  /knowledge/versions · GET /knowledge/versions/:v/diff?against= · POST /knowledge/versions/:v/activate {reason}
 *   POST /knowledge/versions/:v/export
 *   GET  /knowledge/conflicts?status= · POST /knowledge/conflicts/:id/resolve {keep, note?}
 *   GET  /knowledge/changes?since=&until=&actor=&action=&limit=
 *   GET  /knowledge/digest?day= · GET /knowledge/digest/week?end=
 *   GET  /knowledge/status · GET /knowledge/settings · PATCH /knowledge/settings
 *   POST /knowledge/learning/pause · POST /knowledge/learning/resume
 *   PUT  /knowledge/insurer-links/:partyId {insurerSlug}
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  KNOWLEDGE_AREAS,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_STATUSES,
  KNOWLEDGE_USE_LIMITS,
  KNOWLEDGE_VERIFICATIONS,
  BUSINESSES,
  effectiveBadges,
  parseScopeKey,
  type KnowledgeData,
  type KnowledgeItem,
  type KnowledgeItemDetail,
  type KnowledgeItemView,
  type KnowledgePackVersion,
  type KnowledgeQueueGroup,
  type KnowledgeQueueResponse,
  type KnowledgeScope,
  type KnowledgeSettingsPatch,
  type KnowledgeStatusResponse,
  type KnowledgeUsageRow,
} from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { params } from './helpers.js';
import { londonDay } from '../agent/core.js';
import { addOwnerKnowledge, approveKnowledge, editApproveKnowledge, recordCheck, rejectKnowledge, resolveConflict, retireKnowledge } from '../knowledge/store.js';
import { activateVersion, diffVersions, exportVersion } from '../knowledge/publish.js';
import { compileKnowledgeDigest, compileKnowledgeWeek } from '../knowledge/digest.js';
import { getKnowledgeSettings, patchKnowledgeSettings, setLearningEnabled } from '../knowledge/settings.js';
import { setOwnerInsurerLink } from '../knowledge/insurerLinks.js';
import { knowledgeHooks } from '../knowledge/hooks.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const view = (i: KnowledgeItem): KnowledgeItemView => ({ ...i, badges: effectiveBadges(i) });

const scopeSchema = z.union([
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('insurer'), slug: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,127}$/) }).strict(),
  z.object({ kind: z.literal('claim_type'), tag: z.string().min(1).max(64) }).strict(),
]);

const itemsQuery = z.object({
  status: z.enum([...KNOWLEDGE_STATUSES, 'all'] as [string, ...string[]]).optional(),
  kind: z.enum(KNOWLEDGE_KINDS as unknown as [string, ...string[]]).optional(),
  area: z.enum(KNOWLEDGE_AREAS as unknown as [string, ...string[]]).optional(),
  scope: z.string().max(200).optional(),
  verification: z.enum(KNOWLEDGE_VERIFICATIONS as unknown as [string, ...string[]]).optional(),
  q: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});

const approveBody = z
  .object({
    note: z.string().max(2000).optional(),
    verification: z.enum(['owner_confirmed', 'source_verified']).optional(),
    sourceUrl: z.string().url().max(2000).optional(),
    snapshotId: z.string().min(1).max(64).optional(),
  })
  .strict();
const editApproveBody = z
  .object({ title: z.string().min(1).max(200), body: z.string().max(6000), data: z.record(z.unknown()), scope: scopeSchema, note: z.string().max(2000).optional() })
  .strict();
const reasonBody = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();
const checkBody = z
  .object({
    result: z.enum(['unverified', 'owner_confirmed', 'source_verified', 'failed']),
    method: z.enum(['owner_review', 'source_compare', 'owner_answer']),
    sourceUrl: z.string().url().max(2000).optional(),
    snapshotId: z.string().min(1).max(64).optional(),
    quote: z.string().max(2000).optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();
const ownerItemBody = z
  .object({
    kind: z.enum(KNOWLEDGE_KINDS as unknown as [string, ...string[]]),
    area: z.enum(KNOWLEDGE_AREAS as unknown as [string, ...string[]]),
    title: z.string().min(1).max(200),
    body: z.string().max(6000),
    data: z.record(z.unknown()),
    scope: scopeSchema,
    gapId: z.string().min(1).max(64).optional(),
    tags: z.array(z.string().min(1).max(64)).max(20).optional(),
    business: z.array(z.enum(BUSINESSES as unknown as [string, ...string[]])).min(1).max(2).optional(),
    useLimit: z.enum(KNOWLEDGE_USE_LIMITS as unknown as [string, ...string[]]).optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();
const retireBody = z.object({ reason: z.string().max(2000).optional() }).strict().optional();
const activateBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const resolveBody = z.object({ keep: z.enum(['left', 'right', 'both', 'retire_both', 'dismiss']), note: z.string().max(2000).optional() }).strict();
const changesQuery = z.object({
  since: z.string().max(40).optional(),
  until: z.string().max(40).optional(),
  actor: z.string().max(200).optional(),
  action: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});
const linkBody = z.object({ insurerSlug: z.string().min(1).max(128) }).strict();
const learningBody = z.object({ reason: z.string().max(500).optional() }).strict().optional();

const versionParam = (raw: string): number => {
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1) throw badRequest('version must be a positive whole number');
  return v;
};

function hasTable(ctx: AppContext, t: string): boolean {
  return Boolean(ctx.handle.sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t));
}

function usageOf(ctx: AppContext, itemId: string): KnowledgeUsageRow[] {
  if (!hasTable(ctx, 'knowledge_usage')) return [];
  const rows = ctx.handle.sqlite.prepare(`SELECT * FROM knowledge_usage WHERE ref = ? ORDER BY at DESC LIMIT 100`).all(`ki:${itemId}`) as Array<Record<string, unknown>>;
  const json = (s: unknown): string[] => {
    try {
      return Array.isArray(JSON.parse(String(s))) ? (JSON.parse(String(s)) as string[]) : [];
    } catch {
      return [];
    }
  };
  return rows.map((r) => ({
    id: String(r.id),
    runId: String(r.run_id),
    claimId: (r.claim_id as string | null) ?? null,
    ref: String(r.ref),
    badges: json(r.badges) as KnowledgeUsageRow['badges'],
    rank: Number(r.rank),
    injected: Boolean(r.injected),
    cited: Boolean(r.cited),
    targetKind: (r.target_kind as string | null) ?? null,
    targetId: (r.target_id as string | null) ?? null,
    at: String(r.at),
  }));
}

/** Queue groups for the Approve tab (§11): insurer contacts, rules, legal points, KB checks, style, procedures. */
function queueGroups(items: KnowledgeItem[]): KnowledgeQueueGroup[] {
  const groups = new Map<string, KnowledgeQueueGroup>();
  const add = (key: string, title: string, kind: KnowledgeQueueGroup['kind'], id: string): void => {
    const g = groups.get(key) ?? { key, title, kind, itemIds: [] };
    g.itemIds.push(id);
    groups.set(key, g);
  };
  for (const i of items) {
    const d = i.data as { kbCheck?: unknown } | null;
    if (i.kind === 'contact') add(`contacts:${i.scope.kind === 'insurer' ? i.scope.slug : 'other'}`, `Contacts — ${i.scope.kind === 'insurer' ? i.scope.slug : 'other'}`, 'contacts', i.id);
    else if (i.kind === 'rule' || i.kind === 'strategy') add('rules', 'Rules and strategies', 'rules', i.id);
    else if (i.kind === 'fact' && d && d.kbCheck) add('kb_checks', 'KB source checks', 'kb_checks', i.id);
    else if (i.area === 'legal' || i.area === 'quantum' || i.kind === 'precedent') add('legal', 'Legal and quantum points', 'legal', i.id);
    else if (i.area === 'style' || i.kind === 'template_snippet') add('style', 'Wording and style', 'style', i.id);
    else if (i.area === 'procedural') add('procedures', 'Procedures', 'procedures', i.id);
    else add('other', 'Other', 'other', i.id);
  }
  return [...groups.values()];
}

export function knowledgeStatus(ctx: AppContext): KnowledgeStatusResponse {
  const s = getKnowledgeSettings(ctx);
  const c = (sql: string): number => Number((ctx.handle.sqlite.prepare(sql).get() as { c: number } | undefined)?.c ?? 0);
  return {
    learningEnabled: s.learningEnabled,
    useLearnedKnowledge: s.useLearnedKnowledge,
    webResearchEnabled: s.webResearchEnabled,
    activeVersion: ctx.repos.getKnowledgePackState(ctx.db).activeVersion,
    items: {
      proposed: c(`SELECT count(*) AS c FROM knowledge_items WHERE status = 'proposed' AND json_extract(autonomy, '$.outcome') <> 'hold'`),
      active: c(`SELECT count(*) AS c FROM knowledge_items WHERE status = 'active'`),
      held: c(`SELECT count(*) AS c FROM knowledge_items WHERE status = 'proposed' AND json_extract(autonomy, '$.outcome') = 'hold'`),
    },
    conflictsOpen: c(`SELECT count(*) AS c FROM knowledge_conflicts WHERE status = 'open'`),
    gapsOpen: hasTable(ctx, 'knowledge_gaps') ? c(`SELECT count(*) AS c FROM knowledge_gaps WHERE status IN ('open','researching','answered_pending','needs_owner')`) : null,
    alarmsOpen: hasTable(ctx, 'knowledge_alarms') ? c(`SELECT count(*) AS c FROM knowledge_alarms WHERE status = 'open'`) : null,
    needsYouOpen: c(`SELECT count(*) AS c FROM needs_you WHERE kind = 'knowledge_review' AND status IN ('open','snoozed')`),
  };
}

/** Boot-time registration: make sure the hooks object exists (the owning slices add their hooks). */
export function registerKnowledgeServices(ctx: AppContext): void {
  knowledgeHooks(ctx);
}

export function registerKnowledgeRoutes(app: FastifyInstance, ctx: AppContext): void {
  registerKnowledgeServices(ctx);

  app.get('/knowledge/items', async (request) => {
    const q = itemsQuery.parse(request.query);
    const scope: KnowledgeScope | undefined = q.scope ? parseScopeKey(q.scope) : undefined;
    const r = ctx.repos.listKnowledgeItems(ctx.db, {
      ...(q.status && q.status !== 'all' ? { status: q.status as KnowledgeItem['status'] } : {}),
      ...(q.kind ? { kind: q.kind as KnowledgeItem['kind'] } : {}),
      ...(q.area ? { area: q.area as KnowledgeItem['area'] } : {}),
      ...(scope ? { scopeKind: scope.kind, ...(scope.kind === 'insurer' ? { scopeValue: scope.slug } : scope.kind === 'claim_type' ? { scopeValue: scope.tag } : {}) } : {}),
      ...(q.verification ? { verification: q.verification as KnowledgeItem['verification'] } : {}),
      ...(q.q ? { q: q.q } : {}),
      limit: q.limit ?? 100,
      offset: q.offset ?? 0,
    });
    return { items: r.items.map(view), total: r.total };
  });

  app.get('/knowledge/items/:id', async (request): Promise<KnowledgeItemDetail> => {
    const { id } = params<{ id: string }>(request);
    const item = ctx.repos.getKnowledgeItem(ctx.db, id);
    if (!item) throw notFound('knowledge item', id);
    const versions = ctx.repos.listKnowledgeItemVersions(ctx.db, item.itemKey);
    const state = ctx.repos.getKnowledgePackState(ctx.db);
    const members = state.activeVersion !== null ? new Set(ctx.repos.listKnowledgePackMembers(ctx.db, state.activeVersion)) : new Set<string>();
    return {
      item: view(item),
      versions: versions.map(view),
      checks: ctx.repos.listKnowledgeChecks(ctx.db, versions.map((v) => `item:${v.id}`)),
      changes: ctx.repos.listKnowledgeChanges(ctx.db, { itemKey: item.itemKey, limit: 200 }),
      usage: usageOf(ctx, item.id),
      conflicts: ctx.repos.listKnowledgeConflicts(ctx.db, { status: 'all', ref: `ki:${item.id}` }),
      inActiveVersion: members.has(item.id),
    };
  });

  app.get('/knowledge/queue', async (): Promise<KnowledgeQueueResponse> => {
    const proposed = ctx.repos.listKnowledgeItems(ctx.db, { status: 'proposed', limit: 1000 }).items;
    const queued = proposed.filter((i) => i.autonomy.outcome !== 'hold');
    const held = proposed.filter((i) => i.autonomy.outcome === 'hold');
    return { items: queued.map(view), held: held.map(view), groups: queueGroups(queued), conflicts: ctx.repos.listKnowledgeConflicts(ctx.db, { status: 'open' }) };
  });

  app.post('/knowledge/items/:id/approve', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = approveBody.parse(request.body ?? {});
    const r = approveKnowledge(ctx, id, body, request.actor);
    return { item: view(r.item), check: r.check, publishJobId: r.publishJobId };
  });

  app.post('/knowledge/items/:id/edit-approve', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = editApproveBody.parse(request.body);
    const r = editApproveKnowledge(ctx, id, { title: body.title, body: body.body, data: body.data as unknown as KnowledgeData, scope: body.scope as KnowledgeScope, note: body.note ?? null }, request.actor);
    return { item: view(r.item), ...(r.check ? { check: r.check } : {}), publishJobId: r.publishJobId, waitingForReplay: r.waitingForReplay };
  });

  app.post('/knowledge/items/:id/reject', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = reasonBody.parse(request.body);
    return { item: view(rejectKnowledge(ctx, id, body.reason, request.actor)) };
  });

  app.post('/knowledge/items/:id/retire', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = retireBody.parse(request.body ?? undefined);
    const r = retireKnowledge(ctx, id, body?.reason?.trim() || 'Undo from the daily log', request.actor);
    return { item: view(r.item), publishJobId: r.publishJobId };
  });

  app.post('/knowledge/items/:id/check', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = checkBody.parse(request.body);
    const r = recordCheck(ctx, `item:${id}`, body, request.actor);
    return { item: r.item ? view(r.item) : null, check: r.check };
  });

  app.post('/knowledge/items', async (request, reply) => {
    const body = ownerItemBody.parse(request.body);
    const r = addOwnerKnowledge(
      ctx,
      {
        kind: body.kind as KnowledgeItem['kind'],
        area: body.area as KnowledgeItem['area'],
        title: body.title,
        body: body.body,
        data: body.data as unknown as KnowledgeData,
        scope: body.scope as KnowledgeScope,
        ...(body.tags ? { tags: body.tags } : {}),
        ...(body.business ? { business: body.business as KnowledgeItem['business'] } : {}),
        ...(body.useLimit ? { useLimit: body.useLimit as KnowledgeItem['useLimit'] } : {}),
        gapId: body.gapId ?? null,
        note: body.note ?? null,
      },
      request.actor,
    );
    reply.code(201);
    return { item: view(r.item), check: r.check, publishJobId: r.publishJobId };
  });

  app.post('/knowledge/kb/:entryId/check', async (request) => {
    const { entryId } = params<{ entryId: string }>(request);
    const body = checkBody.parse(request.body);
    return { check: recordCheck(ctx, `kb:${entryId}`, body, request.actor).check };
  });

  app.get('/knowledge/versions', async () => {
    const state = ctx.repos.getKnowledgePackState(ctx.db);
    const versions: KnowledgePackVersion[] = ctx.repos.listKnowledgePackVersions(ctx.db).map((v) => ({ ...v, diff: v.diff as KnowledgePackVersion['diff'], active: v.version === state.activeVersion }));
    return { activeVersion: state.activeVersion, versions };
  });

  app.get('/knowledge/versions/:v/diff', async (request) => {
    const { v } = params<{ v: string }>(request);
    const q = z.object({ against: z.coerce.number().int().min(1).optional() }).parse(request.query);
    return diffVersions(ctx, versionParam(v), q.against);
  });

  app.post('/knowledge/versions/:v/activate', async (request) => {
    const { v } = params<{ v: string }>(request);
    const body = activateBody.parse(request.body);
    const r = activateVersion(ctx, versionParam(v), body.reason, request.actor);
    return { version: { ...r.version, active: true }, retired: r.retired, reactivated: r.reactivated, skipped: r.skipped };
  });

  app.post('/knowledge/versions/:v/export', async (request) => {
    const { v } = params<{ v: string }>(request);
    return exportVersion(ctx, versionParam(v), request.actor);
  });

  app.get('/knowledge/conflicts', async (request) => {
    const q = z.object({ status: z.enum(['open', 'resolved', 'dismissed', 'all']).optional() }).parse(request.query);
    return { conflicts: ctx.repos.listKnowledgeConflicts(ctx.db, { status: q.status ?? 'open' }) };
  });

  app.post('/knowledge/conflicts/:id/resolve', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = resolveBody.parse(request.body);
    return { conflict: resolveConflict(ctx, id, body.keep, body.note ?? null, request.actor) };
  });

  app.get('/knowledge/changes', async (request) => {
    const q = changesQuery.parse(request.query);
    return {
      changes: ctx.repos.listKnowledgeChanges(ctx.db, {
        ...(q.since ? { since: q.since } : {}),
        ...(q.until ? { until: q.until } : {}),
        ...(q.actor ? { actor: q.actor } : {}),
        ...(q.action ? (q.action.endsWith('.') || q.action.endsWith('*') ? { actionPrefix: q.action.replace(/\*$/, '') } : { action: q.action }) : {}),
        limit: q.limit ?? 500,
      }),
    };
  });

  app.get('/knowledge/digest', async (request) => {
    const q = z.object({ day: z.string().regex(DAY).optional() }).parse(request.query);
    return compileKnowledgeDigest(ctx, q.day ?? londonDay(ctx.now()));
  });

  app.get('/knowledge/digest/week', async (request) => {
    const q = z.object({ end: z.string().regex(DAY).optional() }).parse(request.query);
    return compileKnowledgeWeek(ctx, q.end ?? londonDay(ctx.now()));
  });

  app.get('/knowledge/status', async () => knowledgeStatus(ctx));

  app.get('/knowledge/settings', async () => getKnowledgeSettings(ctx));

  app.patch('/knowledge/settings', async (request) => patchKnowledgeSettings(ctx, (request.body ?? {}) as KnowledgeSettingsPatch, request.actor));

  app.post('/knowledge/learning/pause', async (request) => {
    const body = learningBody.parse(request.body ?? undefined);
    return setLearningEnabled(ctx, false, request.actor, body?.reason ?? null);
  });

  app.post('/knowledge/learning/resume', async (request) => {
    const body = learningBody.parse(request.body ?? undefined);
    return setLearningEnabled(ctx, true, request.actor, body?.reason ?? null);
  });

  app.put('/knowledge/insurer-links/:partyId', async (request) => {
    const { partyId } = params<{ partyId: string }>(request);
    const body = linkBody.parse(request.body);
    return { link: setOwnerInsurerLink(ctx, partyId, body.insurerSlug, request.actor) };
  });
}
