// owned by knowledge-research
/**
 * knowledge-research routes (docs/SUPREME-KNOWLEDGE-BUILDER.md §10.3). All `/api`, session auth; every write route is
 * human-only (`assertHuman`) and audited. DTOs: @ccguk/domain knowledge/api.ts (KnowledgeGapView, SourceView,
 * SnapshotView).
 *
 *   GET   /knowledge/gaps?status=&kind=                  list gaps
 *   GET   /knowledge/gaps/:id                            gap + research timeline (changes, snapshots, runs, answers)
 *   POST  /knowledge/gaps {kind, question, scope, area?}  owner raises a gap (scrubbed like any other)
 *   POST  /knowledge/gaps/:id/research-now               research now (priority 3)
 *   POST  /knowledge/gaps/:id/dismiss {reason}           dismiss
 *   GET   /knowledge/sources                             list sources (built-in, insurer, owner)
 *   POST  /knowledge/sources {domain, policy ≤ code_fetch, licence, note}
 *   PATCH /knowledge/sources/:domain {enabled}
 *   POST  /knowledge/sources/:domain/fetch-now {url}     queue knowledge.fetch
 *   POST  /knowledge/sources/selftest                    queue the self-test
 *   GET   /knowledge/snapshots?url=&domain=&gapId=       list snapshots
 *   GET   /knowledge/snapshots/:id                       one snapshot (text only if extract is allowed)
 *   GET   /knowledge/snapshots/:id/diff?against=         line diff between two snapshots of the same URL
 *
 * Hooks are registered here at boot and once more when the app is ready (after every slice registered its own).
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { KNOWLEDGE_AREAS, effectiveBadges, isWithheld, sourceHost, type GapKind, type KnowledgeArea, type KnowledgeGapView, type KnowledgeScope, type SnapshotView, type SourceView } from '@ccguk/domain';
import type { KnowledgeGapRecord, KnowledgeSourceRecord, SourceSnapshotRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { params } from './helpers.js';
import { assertHuman } from '../services/humanOnly.js';
import { enqueueJob, londonDay } from '../agent/core.js';
import { getKnowledgeSettings } from '../knowledge/settings.js';
import { registerResearchHooks } from '../knowledge/research/hooks.js';
import { dismissGap, reportGap, researchNow } from '../knowledge/research/gaps.js';
import { addOwnerSource, ensureResearchSources, toggleSource } from '../knowledge/research/sources.js';
import { readSnapshotText } from '../knowledge/research/fetcher.js';

const GAP_KINDS = ['insurer_process', 'legal_point', 'quantum_point', 'missing_contact', 'unfamiliar_document', 'procedure', 'engineering', 'kb_verification', 'other'] as const;
const GAP_STATUSES = ['open', 'researching', 'answered_pending', 'answered', 'needs_owner', 'no_answer', 'out_of_scope', 'dismissed'] as const;

const scopeSchema = z.union([
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('insurer'), slug: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,127}$/) }).strict(),
  z.object({ kind: z.literal('claim_type'), tag: z.string().min(1).max(64) }).strict(),
]);

const gapsQuery = z.object({
  status: z.enum([...GAP_STATUSES, 'open_any', 'all']).optional(),
  kind: z.enum(GAP_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});
const gapBody = z.object({ kind: z.enum(GAP_KINDS), question: z.string().min(8).max(1000), scope: scopeSchema.optional(), area: z.enum(KNOWLEDGE_AREAS as unknown as [string, ...string[]]).optional(), blocking: z.boolean().optional() }).strict();
const reasonBody = z.object({ reason: z.string().min(1).max(1000) }).strict();
const sourceBody = z.object({ domain: z.string().min(3).max(253), policy: z.enum(['api', 'code_fetch', 'agent_fetch', 'link_only', 'deny']), licence: z.string().min(1).max(300), note: z.string().max(1000).optional(), extractAllowed: z.boolean().optional() }).strict();
const togglePatch = z.object({ enabled: z.boolean(), reason: z.string().max(500).optional() }).strict();
const fetchNowBody = z.object({ url: z.string().url().max(2000), reason: z.string().max(500).optional() }).strict();
const selftestBody = z.object({ domains: z.array(z.string().max(100)).max(50).optional() }).strict();
const snapshotsQuery = z.object({ url: z.string().max(2000).optional(), domain: z.string().max(253).optional(), gapId: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(500).optional() });

const defaultArea = (kind: GapKind): KnowledgeArea =>
  kind === 'legal_point' || kind === 'kb_verification' ? 'legal' : kind === 'quantum_point' ? 'quantum' : kind === 'missing_contact' ? 'contact' : kind === 'engineering' ? 'engineering' : 'procedural';

/** The API view of a gap (internal claim links included: the owner's own screen). */
export const gapView = (g: KnowledgeGapRecord): KnowledgeGapView => {
  const { spend: _s, updatedAt: _u, ...v } = g;
  return v;
};

export const sourceView = (r: KnowledgeSourceRecord): SourceView & { purpose?: string } => ({
  domain: r.domain,
  policy: r.policy,
  access: r.access,
  licence: r.licence,
  extractAllowed: r.extractAllowed,
  maxQuoteWords: r.maxQuoteWords,
  tags: r.tags,
  perMinute: r.perMinute,
  perDay: r.perDay,
  enabled: r.enabled,
  origin: r.origin,
  selftest: r.selftest,
  lastFetchAt: r.lastFetchAt,
  lastStatus: r.lastStatus,
  fetchesToday: r.fetchesToday,
});

function snapshotView(ctx: AppContext, s: SourceSnapshotRecord, withText: boolean): SnapshotView & { withheld?: boolean } {
  const base: SnapshotView & { withheld?: boolean } = {
    id: s.id,
    url: s.url,
    finalUrl: s.finalUrl,
    domain: s.domain,
    fetchedAt: s.fetchedAt,
    httpStatus: s.httpStatus,
    contentType: s.contentType,
    bytes: s.bytes,
    sha256: s.sha256,
    title: s.title,
    licence: s.licence,
    extractAllowed: s.extractAllowed,
    previousId: s.previousId,
    changed: s.changed,
    injectionFlags: s.injectionFlags,
    reason: s.reason,
    gapId: s.gapId,
    ...(isWithheld(s.injectionFlags) ? { withheld: true } : {}),
  };
  if (!withText) return base;
  const text = readSnapshotText(ctx, s);
  if (text === null) return { ...base, pruned: true };
  // The owner may read a withheld page (it is only withheld from models); a no-extract source shows an excerpt.
  return { ...base, text: s.extractAllowed ? text : `${text.split(/\s+/).filter(Boolean).slice(0, 25).join(' ')} …` };
}

/** A small line diff (LCS) between two snapshot texts. */
export function lineDiff(a: string, b: string, maxLines = 4000): { op: 'eq' | 'ins' | 'del'; text: string }[] {
  const x = a.split('\n').slice(0, maxLines);
  const y = b.split('\n').slice(0, maxLines);
  const n = x.length;
  const m = y.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: { op: 'eq' | 'ins' | 'del'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: 'eq', text: x[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ op: 'del', text: x[i++]! });
    else out.push({ op: 'ins', text: y[j++]! });
  }
  while (i < n) out.push({ op: 'del', text: x[i++]! });
  while (j < m) out.push({ op: 'ins', text: y[j++]! });
  return out;
}

export function registerKnowledgeResearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  registerResearchHooks(ctx);
  app.addHook('onReady', async () => {
    registerResearchHooks(ctx);
  });

  // ----- gaps -----
  app.get('/knowledge/gaps', async (request) => {
    const q = gapsQuery.parse(request.query);
    const r = ctx.repos.listKnowledgeGaps(ctx.db, { ...(q.status ? { status: q.status } : {}), ...(q.kind ? { kind: q.kind } : {}), limit: q.limit ?? 100, offset: q.offset ?? 0 });
    return { gaps: r.gaps.map(gapView), total: r.total };
  });

  app.get('/knowledge/gaps/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const gap = ctx.repos.getKnowledgeGap(ctx.db, id);
    if (!gap) throw notFound('knowledge gap', id);
    const changes = (ctx.handle.sqlite.prepare(`SELECT id, at, actor, action, reason, run_id AS runId, job_id AS jobId, needs_you_id AS needsYouId, after FROM knowledge_changes WHERE gap_id = ? ORDER BY at, id LIMIT 500`).all(gap.id) as Array<Record<string, unknown>>).map((c) => {
      let after: unknown = c.after;
      try {
        after = typeof c.after === 'string' ? JSON.parse(c.after) : c.after;
      } catch {
        /* keep */
      }
      return { ...c, after };
    });
    const runIds = ((gap.spend as { runIds?: string[] }).runIds ?? []).slice(-20);
    const runs = runIds.length ? (ctx.handle.sqlite.prepare(`SELECT id, job_type AS jobType, outcome, started_at AS startedAt, ended_at AS endedAt, model FROM agent_runs WHERE id IN (${runIds.map(() => '?').join(',')}) ORDER BY started_at`).all(...runIds) as unknown[]) : [];
    const answers = ctx.repos.getKnowledgeItems(ctx.db, gap.answerItemIds).map((i) => ({ ...i, badges: effectiveBadges(i) }));
    const snapshots = ctx.repos.listSourceSnapshots(ctx.db, { gapId: gap.id, limit: 50 }).map((s) => snapshotView(ctx, s, false));
    return { gap: gapView(gap), changes, runs, answers, snapshots, lastSummary: (gap.spend as { lastSummary?: string }).lastSummary ?? null, ownerQuestion: (gap.spend as { ownerQuestion?: string }).ownerQuestion ?? null };
  });

  app.post('/knowledge/gaps', async (request, reply) => {
    assertHuman(request.actor, 'raise a knowledge gap');
    const body = gapBody.parse(request.body ?? {});
    const scope = (body.scope ?? { kind: 'global' }) as KnowledgeScope;
    const r = reportGap(ctx, { kind: body.kind, question: body.question, area: (body.area as KnowledgeArea | undefined) ?? defaultArea(body.kind), scope, origin: 'owner', originRef: null, blocking: body.blocking ?? false, raisedBy: request.actor.userId });
    reply.code(r.status === 'recorded' ? 201 : 200);
    return { gap: gapView(r.gap), status: r.status, removed: r.removed };
  });

  app.post('/knowledge/gaps/:id/research-now', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const r = researchNow(ctx, id, request.actor);
    reply.code(202);
    return { gap: gapView(r.gap), jobId: r.jobId };
  });

  app.post('/knowledge/gaps/:id/dismiss', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = reasonBody.parse(request.body ?? {});
    return { gap: gapView(dismissGap(ctx, id, body.reason, request.actor)) };
  });

  // ----- sources -----
  app.get('/knowledge/sources', async () => {
    ensureResearchSources(ctx);
    const today = londonDay(ctx.now());
    return {
      sources: ctx.repos.listKnowledgeSources(ctx.db).map((r) => ({ ...sourceView(r), fetchesToday: r.fetchDay === today ? r.fetchesToday : 0 })),
      fclTransactionalLicence: getKnowledgeSettings(ctx).fclTransactionalLicence,
      /** presence only (never the value): the optional FCA Handbook API key, set in Settings ▸ AI */
      fcaKeyPresent: ctx.secrets.has('fca_handbook_api_key'),
    };
  });

  app.post('/knowledge/sources', async (request, reply) => {
    const body = sourceBody.parse(request.body ?? {});
    const s = addOwnerSource(ctx, { domain: body.domain, policy: body.policy, licence: body.licence, note: body.note ?? null, ...(body.extractAllowed !== undefined ? { extractAllowed: body.extractAllowed } : {}) }, request.actor);
    reply.code(201);
    return { source: sourceView(s) };
  });

  app.patch('/knowledge/sources/:domain', async (request) => {
    const { domain } = params<{ domain: string }>(request);
    const body = togglePatch.parse(request.body ?? {});
    return { source: sourceView(toggleSource(ctx, domain, body.enabled, request.actor, body.reason ?? null)) };
  });

  app.post('/knowledge/sources/:domain/fetch-now', async (request, reply) => {
    assertHuman(request.actor, 'fetch a source page');
    const { domain } = params<{ domain: string }>(request);
    const body = fetchNowBody.parse(request.body ?? {});
    const host = sourceHost(body.url);
    const d = domain.toLowerCase();
    if (!host || (host !== d && host.replace(/^www\./, '') !== d.replace(/^www\./, '') && !host.endsWith(`.${d.replace(/^\*\./, '')}`))) throw badRequest(`${body.url} is not on ${domain}`);
    const s = getKnowledgeSettings(ctx);
    if (!s.learningEnabled) throw conflict('LEARNING_PAUSED', 'Learning is paused (Knowledge ▸ Safety)');
    if (!s.sourceFetchEnabled) throw conflict('FETCH_OFF', 'Source fetching is switched off (Knowledge ▸ Safety)');
    const sha = createHash('sha256').update(body.url).digest('hex');
    const job = enqueueJob(ctx, { type: 'knowledge.fetch', payload: { url: body.url, reason: body.reason ?? 'fetch now (owner)' }, priority: 3, idempotencyKey: `knowledge.fetch:${sha}:${londonDay(ctx.now())}`, createdBy: request.actor.userId });
    reply.code(202);
    return { jobId: job.id, status: job.status };
  });

  app.post('/knowledge/sources/selftest', async (request, reply) => {
    assertHuman(request.actor, 'run the source self-test');
    const body = selftestBody.parse(request.body ?? {});
    const job = enqueueJob(ctx, { type: 'knowledge.fetch', payload: { selftest: true, reason: 'self-test (owner)', ...(body.domains ? { domains: body.domains } : {}) }, priority: 3, idempotencyKey: `knowledge.fetch:selftest:owner:${ctx.now()}`, createdBy: request.actor.userId });
    reply.code(202);
    return { jobId: job.id, status: job.status };
  });

  // ----- snapshots -----
  app.get('/knowledge/snapshots', async (request) => {
    const q = snapshotsQuery.parse(request.query);
    return { snapshots: ctx.repos.listSourceSnapshots(ctx.db, { ...(q.url ? { url: q.url } : {}), ...(q.domain ? { domain: q.domain } : {}), ...(q.gapId ? { gapId: q.gapId } : {}), limit: q.limit ?? 100 }).map((s) => snapshotView(ctx, s, false)) };
  });

  app.get('/knowledge/snapshots/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const s = ctx.repos.getSourceSnapshot(ctx.db, id);
    if (!s) throw notFound('snapshot', id);
    return { snapshot: snapshotView(ctx, s, true) };
  });

  app.get('/knowledge/snapshots/:id/diff', async (request) => {
    const { id } = params<{ id: string }>(request);
    const { against } = z.object({ against: z.string().max(64).optional() }).parse(request.query);
    const s = ctx.repos.getSourceSnapshot(ctx.db, id);
    if (!s) throw notFound('snapshot', id);
    const otherId = against ?? s.previousId;
    if (!otherId) return { from: null, to: snapshotView(ctx, s, false), diff: [] };
    const o = ctx.repos.getSourceSnapshot(ctx.db, otherId);
    if (!o) throw notFound('snapshot', otherId);
    if (o.url !== s.url) throw badRequest('Both snapshots must be of the same page');
    if (!s.extractAllowed || !o.extractAllowed) return { from: snapshotView(ctx, o, false), to: snapshotView(ctx, s, false), diff: null, note: 'this source allows no extract: compare the pages yourself' };
    const a = readSnapshotText(ctx, o);
    const b = readSnapshotText(ctx, s);
    if (a === null || b === null) return { from: snapshotView(ctx, o, false), to: snapshotView(ctx, s, false), diff: null, note: 'a snapshot file was pruned' };
    return { from: snapshotView(ctx, o, false), to: snapshotView(ctx, s, false), diff: lineDiff(a, b).filter((d, i, arr) => d.op !== 'eq' || arr[i - 1]?.op !== 'eq' || arr[i + 1]?.op !== 'eq') };
  });
}
