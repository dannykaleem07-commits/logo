// owned by knowledge-learners
/**
 * knowledge-learners routes (docs/SUPREME-KNOWLEDGE-BUILDER.md §10.3). All `/api`, session auth; the one write route
 * (POST /knowledge/learn/run) is human-only through `assertHuman`. DTOs are in @ccguk/domain knowledge/api.ts.
 *
 *   GET  /knowledge/insurers                      insurer profile list (InsurerProfileListRow[])
 *   GET  /knowledge/insurers/:slug                one insurer (InsurerProfileView)
 *   GET  /knowledge/insurer-links?unlinked=1      parties not yet linked (and the links)
 *   GET  /knowledge/corrections?since=&clusterKey= corrections (CorrectionView[]; never the raw text)
 *   GET  /knowledge/corrections/clusters          correction clusters (CorrectionClusterView[])
 *   POST /knowledge/learn/run {learner}           enqueue a learner now
 *
 * Boot: registers `KnowledgeHooks.conflictsFor` (conflict detection on every proposal, §6.7).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildInsurerProfile, effectiveBadges, type ContactData, type CorrectionClusterView, type CorrectionView, type InsurerProfileData, type InsurerProfileListRow, type InsurerProfileView, type KnowledgeItem, type KnowledgeItemView, type ProcedureData } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { params } from './helpers.js';
import { assertHuman } from '../services/humanOnly.js';
import { enqueueJob } from '../agent/core.js';
import { registerKnowledgeHooks } from '../knowledge/hooks.js';
import { getKnowledgeSettings } from '../knowledge/settings.js';
import { conflictsFor } from '../knowledge/learners/conflicts.js';
import { storedOutcomes } from '../knowledge/learners/outcomes.js';
import { newSinceCuration } from '../knowledge/learners/corrections.js';
import { all, directoryEntry, directoryValues } from '../knowledge/learners/common.js';
import { learnRunKey } from '../agent/handlers/knowledgeLearning.js';

const view = (i: KnowledgeItem): KnowledgeItemView => ({ ...i, badges: effectiveBadges(i) });

const LEARNERS = ['observe', 'consolidate', 'learn_stats', 'curate'] as const;
const learnRunBody = z.object({ learner: z.enum(LEARNERS) }).strict();
const correctionsQuery = z.object({ since: z.string().max(40).optional(), clusterKey: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(1000).optional() });
const linksQuery = z.object({ unlinked: z.string().optional() });

function unlinkedParties(ctx: AppContext, slug?: string): { partyId: string; name: string; claims: number }[] {
  const rows = all<{ party_id: string; name: string; claims: number }>(
    ctx,
    `SELECT c.at_fault_insurer_id AS party_id, p.name AS name, count(*) AS claims FROM claims c JOIN parties p ON p.id = c.at_fault_insurer_id
       LEFT JOIN insurer_links l ON l.party_id = c.at_fault_insurer_id WHERE c.at_fault_insurer_id IS NOT NULL AND l.party_id IS NULL
      GROUP BY c.at_fault_insurer_id, p.name ORDER BY claims DESC, p.name`,
  ).map((r) => ({ partyId: r.party_id, name: r.name, claims: Number(r.claims) }));
  if (!slug) return rows;
  const entry = directoryEntry(ctx, slug);
  if (!entry) return [];
  const words = [entry.name, ...entry.brands].map((s) => s.toLowerCase().split(/\s+/)[0]!).filter((w) => w.length >= 3);
  return rows.filter((r) => words.some((w) => r.name.toLowerCase().includes(w)));
}

function activeProfile(ctx: AppContext, slug: string, window: '12m' | 'all'): KnowledgeItem | undefined {
  return ctx.repos.activeKnowledgeByKey(ctx.db, `profile:${slug}:${window}`);
}

function headlinePaidPct(p: InsurerProfileData | null): number | null {
  if (!p) return null;
  const hire = p.heads.hire?.paidOfClaimedPct;
  if (hire) return hire.median;
  const first = Object.values(p.heads).find((h) => h?.paidOfClaimedPct);
  return first?.paidOfClaimedPct?.median ?? null;
}

export function insurerList(ctx: AppContext): InsurerProfileListRow[] {
  const outcomes = storedOutcomes(ctx);
  const slugs = new Set<string>(outcomes.map((r) => r.insurerSlug).filter((s): s is string => Boolean(s)));
  for (const i of ctx.repos.listKnowledgeItems(ctx.db, { status: 'active', kind: 'insurer_profile', limit: 1000 }).items) if (i.scope.kind === 'insurer') slugs.add(i.scope.slug);
  return [...slugs].sort().map((slug) => {
    const prof = (activeProfile(ctx, slug, '12m') ?? activeProfile(ctx, slug, 'all'))?.data as InsurerProfileData | undefined;
    const claims = new Set(outcomes.filter((r) => r.insurerSlug === slug).map((r) => r.claimId)).size;
    return {
      insurerSlug: slug,
      name: directoryEntry(ctx, slug)?.name ?? null,
      claims,
      medianWorkingDaysToPay: prof?.daysToPay.medianWorkingDays ?? null,
      paidOfClaimedPct: headlinePaidPct(prof ?? null),
      topObjection: prof?.objections[0]?.intent ?? null,
      computedAt: prof?.computedAt ?? null,
    };
  });
}

export function insurerView(ctx: AppContext, slug: string): InsurerProfileView {
  const entry = directoryEntry(ctx, slug);
  const outcomes = storedOutcomes(ctx, { insurerSlug: slug });
  const p12 = activeProfile(ctx, slug, '12m');
  const pAll = activeProfile(ctx, slug, 'all');
  if (!entry && !outcomes.length && !p12 && !pAll) throw notFound('insurer', slug);
  const minN = getKnowledgeSettings(ctx).thresholds.statsMinN;
  const scoped = ctx.repos.listKnowledgeItems(ctx.db, { status: 'active', scopeKind: 'insurer', scopeValue: slug, limit: 500 }).items;
  const contacts: InsurerProfileView['contacts'] = scoped.filter((i) => i.kind === 'contact').map((i) => ({ item: view(i), directory: null, badges: effectiveBadges(i) }));
  if (entry) {
    const d = directoryValues(entry);
    const dir: Partial<ContactData> = { insurerSlug: slug, phone: d.phones[0] ?? null, email: d.emails[0] ?? null, ivr: entry.thirdPartyIvrPath ?? null, hours: entry.openingHours ?? null, team: 'Directory' };
    contacts.unshift({ item: null, directory: dir, badges: [] });
  }
  const live = buildInsurerProfile(slug, outcomes, { window: 'all', minN, computedAt: ctx.now() });
  const steps = ctx.repos.listKnowledgeItems(ctx.db, { status: 'active', kind: 'fact', area: 'statistics', scopeKind: 'insurer', scopeValue: slug, limit: 500 }).items;
  return {
    insurerSlug: slug,
    name: entry?.name ?? null,
    profile12m: (p12?.data as InsurerProfileData | undefined) ?? null,
    profileAll: (pAll?.data as InsurerProfileData | undefined) ?? null,
    contacts,
    procedures: scoped.filter((i) => i.kind === 'procedure').map((i) => ({ item: view(i), data: i.data as ProcedureData })),
    docsRequested: ((pAll?.data as InsurerProfileData | undefined) ?? live).docsRequested,
    stepEffectiveness: steps.map(view),
    unlinkedParties: unlinkedParties(ctx, slug),
    tooFewClaims: live.n.claims < minN,
    heads: Object.keys(live.heads) as InsurerProfileView['heads'],
  };
}

export function registerKnowledgeLearningRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Conflict detection on every proposal (§6.7) — knowledge-learners owns this hook.
  registerKnowledgeHooks(ctx, { conflictsFor });

  app.get('/knowledge/insurers', async () => ({ insurers: insurerList(ctx) }));

  app.get('/knowledge/insurers/:slug', async (request) => {
    const { slug } = params<{ slug: string }>(request);
    return insurerView(ctx, slug);
  });

  app.get('/knowledge/insurer-links', async (request) => {
    const q = linksQuery.parse(request.query ?? {});
    const parties = unlinkedParties(ctx);
    if (q.unlinked === '1' || q.unlinked === 'true') return { parties };
    return { parties, links: ctx.repos.listInsurerLinks(ctx.db) };
  });

  app.get('/knowledge/corrections', async (request) => {
    const q = correctionsQuery.parse(request.query ?? {});
    const rows = ctx.repos.listCorrections(ctx.db, { ...(q.since ? { since: q.since } : {}), ...(q.clusterKey ? { clusterKey: q.clusterKey } : {}), limit: q.limit ?? 200, newestFirst: true });
    const corrections: CorrectionView[] = rows.map((c) => ({ id: c.id, source: c.source, claimId: c.claimId, agent: c.agent, templateId: c.templateId, emailKind: c.emailKind, insurerSlug: c.insurerSlug, categories: c.categories, clusterKey: c.clusterKey, stats: c.stats, capturedAt: c.capturedAt }));
    return { corrections };
  });

  app.get('/knowledge/corrections/clusters', async () => {
    const clusters: CorrectionClusterView[] = ctx.repos.listCorrectionClusters(ctx.db).map((c) => ({ clusterKey: c.clusterKey, corrections: c.corrections, sinceLastCuration: newSinceCuration(ctx, c.clusterKey).length, lastCapturedAt: c.lastCapturedAt, categories: c.categories }));
    return { clusters };
  });

  app.post('/knowledge/learn/run', async (request, reply) => {
    assertHuman(request.actor, 'run a learner');
    const body = learnRunBody.parse(request.body ?? {});
    const now = ctx.now();
    const type = `knowledge.${body.learner}` as const;
    const payload = body.learner === 'observe' ? { source: 'all' } : body.learner === 'curate' ? { weekly: true } : { reason: 'owner' };
    const job = enqueueJob(ctx, { type, payload, idempotencyKey: learnRunKey(body.learner, now), createdBy: request.actor.userId, priority: 3 });
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'knowledge.learn.run', entity: 'agent_jobs', entityId: job.id, after: { learner: body.learner }, at: now });
    reply.code(202);
    return { jobId: job.id, learner: body.learner, status: job.status };
  });
}
