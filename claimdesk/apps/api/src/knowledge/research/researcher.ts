// owned by knowledge-research
/**
 * The Researcher run (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.4) and optional web research (§7.8). Code wraps the model:
 *
 *   1 load the gap; kill switch (learningEnabled), researchEnabled, the day's budget (researchRunsPerDay 6) and
 *     perimeter triage (injury → out_of_scope; regulated advice → the owner);
 *   2 local pass (code): an active item already linked to this gap's question closes it as answered with no AI run;
 *     otherwise the top local hits (learned items + KB) go to the model;
 *   3 model run (agent `researcher`, prompt knowledge-researcher.md, no claim scope, no Case Brief, CLI `--tools ""`):
 *     the scrubbed question, the local hits and the allowed sources with their purposes; ≤ 4 searches, ≤ 6 fetches;
 *   4 result → code: answered (an auto-applied low-risk item) / answered_pending (queued for the owner) / needs_owner
 *     (a prepare-and-confirm card) / no_answer → retry with backoff 1 d → 3 d → 7 d up to gapMaxAttempts, then the
 *     owner card for a blocking gap; needs_web → `knowledge.research_web` only when the owner switched it on.
 *
 * `knowledge.research_web` (off by default): the same researcher with WebFetch restricted to the allow-list
 * (`webPolicyForGap`, registered as the `webPolicyFor` hook; runAgent refuses it unless the job is research_web and the
 * owner's switches are on). Its tool subset has no brain_search / memory_recall, and its findings must still cite a
 * snapshot ClaimDesk fetched itself.
 */
import { DENIED_HOSTS, SOURCE_POLICIES, effectivePolicyKind, isWithheld, type KnowledgeResearchResult } from '@ccguk/domain';
import type { Actor, KnowledgeGapRecord } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import type { AgentSpec, JobOutcome, JobRecord } from '../../agent/contracts.js';
import type { WebResearchPolicy } from '../../ai/types.js';
import { runAgent } from '../../agent/runAgent.js';
import { londonDayStart } from '../../agent/core.js';
import { getTool } from '../../agent/tools/index.js';
import { aiFailure, isAiOff } from '../../casework/ai.js';
import { getKnowledgeSettings } from '../settings.js';
import { enqueueResearch, isOpenGap, nextAttemptAfter, raiseGapCard, setGapStatus } from './gaps.js';
import { extraPolicies } from './sources.js';

const RESEARCHER: Actor = { userId: 'agent:researcher' };

/** Researcher tools (§7.4) — tools another slice has not registered yet are left out. */
const RESEARCH_TOOLS = ['knowledge_search', 'kb_search', 'kb_entry', 'brain_search', 'memory_recall', 'insurer_profile', 'source_search', 'source_fetch', 'source_get', 'knowledge_propose', 'knowledge_gap_update'];
/** Web research tools (§7.8): no brain_search / memory_recall (private content could leak into URLs). */
const WEB_TOOLS = ['knowledge_search', 'source_fetch', 'source_get', 'knowledge_propose', 'knowledge_gap_update'];

const registered = (names: readonly string[]): string[] => names.filter((n) => Boolean(getTool(n)));

export function researchSpec(): AgentSpec {
  return {
    name: 'researcher',
    jobType: 'knowledge.research',
    title: 'Knowledge researcher',
    promptFiles: ['knowledge-researcher.md'],
    tools: registered(RESEARCH_TOOLS),
    allowRead: false,
    resultSchemaId: 'knowledge_research',
    defaults: { model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 12, timeoutMs: 8 * 60_000 },
  };
}

export function webResearchSpec(): AgentSpec {
  return {
    name: 'researcher',
    jobType: 'knowledge.research_web',
    title: 'Knowledge researcher (web)',
    promptFiles: ['knowledge-researcher.md', 'knowledge-researcher-web.md'],
    tools: registered(WEB_TOOLS),
    allowRead: false,
    resultSchemaId: 'knowledge_research',
    defaults: { model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 12, timeoutMs: 10 * 60_000 },
  };
}

export interface ResearchPayload {
  gapId: string;
  attempt?: number;
  owner?: boolean;
}

/** AI research runs of `jobType` started today (London day). */
export function researchRunsToday(ctx: AppContext, jobType: 'knowledge.research' | 'knowledge.research_web'): number {
  const row = ctx.handle.sqlite.prepare(`SELECT count(*) AS c FROM agent_runs WHERE job_type = ? AND started_at >= ?`).get(jobType, londonDayStart(ctx.now())) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

/** The allowed sources as the model sees them (domain, policy, purpose). */
export function allowedSourceList(ctx: AppContext): string {
  const s = getKnowledgeSettings(ctx);
  const rows = new Map(ctx.repos.listKnowledgeSources(ctx.db).map((r) => [r.domain, r] as const));
  const lines: string[] = [];
  for (const p of [...SOURCE_POLICIES, ...extraPolicies(ctx)]) {
    const kind = effectivePolicyKind(p, s);
    if (kind === 'deny') continue;
    const row = rows.get(p.domain);
    if (row && !row.enabled) continue;
    lines.push(`- ${p.domain} — ${kind === 'link_only' ? 'link only (never fetched)' : `${kind}${p.search ? `, search: ${p.domain}` : ''}`}${p.extractAllowed ? '' : ', no extract'}. ${p.purpose}${p.tags.includes('benchmark_only') ? ' (BENCHMARK ONLY — never law)' : ''}${p.tags.includes('fos') ? ' (Fixmyfile only)' : ''}`);
  }
  return lines.join('\n');
}

const words = (s: string): Set<string> => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));

/** Local hits (code): active learned items by FTS, and KB entries by word overlap. */
export function localHits(ctx: AppContext, gap: KnowledgeGapRecord): { items: { ref: string; title: string; text: string; verification: string }[]; kb: { ref: string; title: string; principle: string; status: string }[] } {
  let items: { ref: string; title: string; text: string; verification: string }[] = [];
  try {
    items = ctx.repos
      .listKnowledgeItems(ctx.db, { status: 'active', q: gap.question.replace(/\[[a-z ]+\]/g, ' '), limit: 5 })
      .items.filter((i) => i.useLimit !== 'code_only')
      .map((i) => ({ ref: `ki:${i.id}`, title: i.title, text: i.body.slice(0, 600), verification: i.verification }));
  } catch {
    items = [];
  }
  const q = words(gap.question);
  const kb = ctx.kb
    .entries()
    .map((e) => {
      const w = words(`${e.title} ${e.principle} ${e.tags.join(' ')} ${e.topics.join(' ')}`);
      let score = 0;
      for (const x of q) if (w.has(x)) score += 1;
      return { e, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ e }) => ({ ref: `kb:${e.id}`, title: `${e.citation} — ${e.title}`, principle: e.principle.slice(0, 400), status: e.verification?.status ?? 'unverified' }));
  return { items, kb };
}

/** An active item already answering this exact gap question (a previous gap with the same key). */
function existingAnswer(ctx: AppContext, gap: KnowledgeGapRecord): string | null {
  const row = ctx.handle.sqlite.prepare(`SELECT i.id AS id FROM knowledge_items i WHERE i.status = 'active' AND EXISTS (SELECT 1 FROM json_each(i.tags) t WHERE t.value = ?) LIMIT 1`).get(`gap:${gap.gapKey}`) as { id: string } | undefined;
  return row?.id ?? null;
}

function questionFor(ctx: AppContext, gap: KnowledgeGapRecord, web: boolean): string {
  const hits = localHits(ctx, gap);
  const looked = ctx.repos.listSourceSnapshots(ctx.db, { gapId: gap.id, limit: 10 }).filter((s) => !isWithheld(s.injectionFlags));
  const seeds = web ? looked.map((s) => `- ${s.url}`).join('\n') : '';
  return [
    `Gap id: ${gap.id}`,
    `Kind: ${gap.kind} · area: ${gap.area} · scope: ${gap.scope.kind === 'insurer' ? `insurer ${gap.scope.slug}` : gap.scope.kind === 'claim_type' ? `claim type ${gap.scope.tag}` : 'global'}`,
    `Question (general; personal data removed): ${gap.question}`,
    '',
    '## What ClaimDesk already knows (local hits, reference data)',
    hits.items.length || hits.kb.length ? [...hits.items.map((h) => `- [${h.ref}] ${h.verification.toUpperCase()} · ${h.title}: ${h.text}`), ...hits.kb.map((h) => `- [${h.ref}] KB ${h.status.toUpperCase()} · ${h.title}: ${h.principle}`)].join('\n') : '(nothing relevant)',
    '',
    '## Allowed sources',
    allowedSourceList(ctx),
    ...(web ? ['', '## Pages ClaimDesk already fetched for this gap (seed URLs)', seeds || '(none yet)'] : []),
    '',
    `Budget: at most 4 searches and 6 fetches. Return the KnowledgeResearchResult JSON with gapId "${gap.id}".`,
  ].join('\n');
}

type ResearchJobResult = Record<string, unknown> & { result: string };

/** knowledge.research and knowledge.research_web. */
export async function runResearchJob(ctx: AppContext, job: JobRecord, payload: ResearchPayload, web: boolean): Promise<JobOutcome<ResearchJobResult>> {
  const settings = getKnowledgeSettings(ctx);
  if (!settings.learningEnabled) return { kind: 'done', result: { result: 'learning_off' } };
  const gap = ctx.repos.getKnowledgeGap(ctx.db, payload.gapId);
  if (!gap) return { kind: 'fail', reason: `gap ${payload.gapId} not found` };
  if (!isOpenGap(gap) || gap.status === 'needs_owner' || gap.status === 'answered_pending') return { kind: 'done', result: { result: 'skipped', status: gap.status } };
  if (!settings.researchEnabled) return { kind: 'done', result: { result: 'research_off' } };
  if (web && !settings.webResearchEnabled) return { kind: 'done', result: { result: 'web_off' } };
  const used = researchRunsToday(ctx, web ? 'knowledge.research_web' : 'knowledge.research');
  const cap = web ? settings.budgets.webRunsPerDay : settings.budgets.researchRunsPerDay;
  if (used >= cap && !payload.owner) {
    if (gap.status === 'researching') setGapStatus(ctx, gap.id, 'open', RESEARCHER, { nextAttemptAt: new Date(Date.parse(londonDayStart(ctx.now())) + 86_400_000 + 3_600_000).toISOString() });
    return { kind: 'done', result: { result: 'budget', used, cap } };
  }
  // Perimeter triage again (a gap raised before a rule change).
  const answered = existingAnswer(ctx, gap);
  if (answered) {
    setGapStatus(ctx, gap.id, 'answered', RESEARCHER, { note: `already answered by ki:${answered} (local pass, no AI run)`, answerItemIds: [answered], jobId: job.id });
    return { kind: 'done', result: { result: 'answered_locally', itemId: answered } };
  }

  const attempts = gap.attempts + 1;
  setGapStatus(ctx, gap.id, 'researching', RESEARCHER, { attempts, jobId: job.id });
  const spec = web ? webResearchSpec() : researchSpec();
  const run = await runAgent(ctx, spec, job, {
    task: web ? 'Web research for one knowledge gap (allow-listed pages only).' : 'Research one knowledge gap from ClaimDesk’s knowledge and allow-listed official sources.',
    question: questionFor(ctx, gap, web),
  });
  const runIds = [...(((gap.spend as { runIds?: string[] }).runIds) ?? []), run.runId].slice(-20);
  const failure = aiFailure(ctx, run.outcome);
  if (failure) {
    // Put the gap back in the queue: the job retries (or AI is off and the next scan picks it up again).
    setGapStatus(ctx, gap.id, 'open', RESEARCHER, { attempts: gap.attempts, nextAttemptAt: isAiOff(run.outcome) ? nextAttemptAfter(ctx, 1) : null, spend: { runIds }, runId: run.runId, jobId: job.id });
    return failure as JobOutcome<ResearchJobResult>;
  }
  const r = run.result as KnowledgeResearchResult;
  const fresh = ctx.repos.getKnowledgeGap(ctx.db, gap.id)!;
  const items = ctx.repos.getKnowledgeItems(ctx.db, [...new Set([...fresh.answerItemIds, ...r.proposedItemIds])]).filter((i) => i.gapId === gap.id);
  const active = items.filter((i) => i.status === 'active');
  const pending = items.filter((i) => i.status === 'proposed');
  const spendPatch = { runIds, lastOutcome: r.outcome, lastSummary: r.summary.slice(0, 1000), snapshotIds: r.snapshotIds.slice(0, 20) };
  const common = { spend: spendPatch, runId: run.runId, jobId: job.id };
  const max = settings.budgets.gapMaxAttempts;

  if (fresh.status === 'answered' || active.length) {
    if (fresh.status !== 'answered') setGapStatus(ctx, gap.id, 'answered', RESEARCHER, { ...common, note: r.summary.slice(0, 500), answerItemIds: active.map((i) => i.id) });
    else ctx.repos.updateKnowledgeGap(ctx.db, gap.id, { spend: { ...fresh.spend, ...spendPatch }, updatedAt: ctx.now() });
    return { kind: 'done', result: { result: 'answered', items: items.map((i) => i.id), runId: run.runId } };
  }
  if (pending.length) {
    const g = setGapStatus(ctx, gap.id, 'answered_pending', RESEARCHER, { ...common, note: r.summary.slice(0, 500), answerItemIds: pending.map((i) => i.id) });
    return { kind: 'done', result: { result: 'answered_pending', items: pending.map((i) => i.id), gapStatus: g.status, runId: run.runId } };
  }
  if (r.outcome === 'needs_owner' || fresh.status === 'needs_owner') {
    const g = setGapStatus(ctx, gap.id, 'needs_owner', RESEARCHER, { ...common, note: r.summary.slice(0, 500) });
    const card = raiseGapCard(ctx, g, { createdBy: RESEARCHER.userId, found: r.summary.slice(0, 600), ownerQuestion: r.ownerQuestion ?? ((fresh.spend as { ownerQuestion?: string }).ownerQuestion ?? null) });
    return { kind: 'done', result: { result: 'needs_owner', needsYouId: card, runId: run.runId } };
  }
  if (r.outcome === 'needs_web' && !web && settings.webResearchEnabled && researchRunsToday(ctx, 'knowledge.research_web') < settings.budgets.webRunsPerDay) {
    setGapStatus(ctx, gap.id, 'researching', RESEARCHER, common);
    return {
      kind: 'done',
      result: { result: 'needs_web', runId: run.runId },
      followUps: [{ type: 'knowledge.research_web', payload: { gapId: gap.id, attempt: attempts }, idempotencyKey: `knowledge.research_web:${gap.id}:${attempts}`, parentJobId: job.id, createdBy: RESEARCHER.userId }],
    };
  }
  // no answer: back off, or give up and (for a blocking gap) prepare the owner's card.
  if (attempts < max) {
    setGapStatus(ctx, gap.id, 'open', RESEARCHER, { ...common, note: r.summary.slice(0, 500), nextAttemptAt: nextAttemptAfter(ctx, attempts) });
    return { kind: 'done', result: { result: 'no_answer_retry', attempts, runId: run.runId } };
  }
  if (gap.blocking) {
    const g = setGapStatus(ctx, gap.id, 'needs_owner', RESEARCHER, { ...common, note: `no answer after ${attempts} attempts: ${r.summary}`.slice(0, 500) });
    const card = raiseGapCard(ctx, g, { createdBy: RESEARCHER.userId, found: r.summary.slice(0, 600), ownerQuestion: r.ownerQuestion });
    return { kind: 'done', result: { result: 'needs_owner', needsYouId: card, runId: run.runId } };
  }
  setGapStatus(ctx, gap.id, 'no_answer', RESEARCHER, { ...common, note: r.summary.slice(0, 500) });
  return { kind: 'done', result: { result: 'no_answer', attempts, runId: run.runId } };
}

/**
 * The WebFetch policy for a `knowledge.research_web` run (the `webPolicyFor` hook, §7.8). Allowed: enabled sources
 * whose effective policy is api / code_fetch / agent_fetch. Denied: deny-listed hosts, link-only hosts and every
 * directory copycat domain. Other job types get no policy (runAgent refuses web tools for them anyway).
 */
export function webPolicyForGap(ctx: AppContext, jobType: string): WebResearchPolicy | undefined {
  if (jobType !== 'knowledge.research_web') return undefined;
  const s = getKnowledgeSettings(ctx);
  const rows = new Map(ctx.repos.listKnowledgeSources(ctx.db).map((r) => [r.domain, r] as const));
  const fetchDomains: string[] = [];
  const deny = new Set<string>(DENIED_HOSTS);
  for (const p of [...SOURCE_POLICIES, ...extraPolicies(ctx)]) {
    const kind = effectivePolicyKind(p, s);
    const row = rows.get(p.domain);
    if (kind === 'deny' || kind === 'link_only') deny.add(p.domain);
    else if (!row || row.enabled) fetchDomains.push(p.domain);
  }
  for (const e of ctx.kb.directory()) for (const d of e.copycatDomains ?? []) if (d.trim()) deny.add(d.trim().toLowerCase());
  return { fetchDomains: [...new Set(fetchDomains)].sort(), denyDomains: [...deny].filter((d) => !fetchDomains.includes(d)).sort(), maxFetches: 6, allowSearch: false };
}

/** Owner "Research now" / scan follow-up helper re-exported for the routes. */
export { enqueueResearch };
