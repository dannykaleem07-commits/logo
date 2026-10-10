// owned by knowledge-use
/**
 * The knowledge block in every agent's user message and the usage record (docs/SUPREME-KNOWLEDGE-BUILDER.md §8.1).
 *
 *   knowledgeContextFor  the `knowledgeContext` hook: after the Case Brief, never in the cached prefix. Profiles per agent:
 *                          mail.triage            none (no tools, classifies only)
 *                          reviewer               only the refs the draft cites plus the claim insurer's contacts
 *                          knowledge.* (research, curate)  none — the researcher gets its own local-pass hits
 *                          everyone else          ranked retrieval for the task and the Case Brief
 *   recordRunUsage       the `onRunAssembled` hook: one append-only knowledge_usage row per injected ref
 *
 * For a draft the recipient is not known when the prompt is built, so drafting agents (drafter, mail) are treated as
 * writing to the at-fault insurer unless the task names the client: FOS items then never reach them (KR-4) — the safe
 * direction.
 */
import { buildRetrievalQuery, rankKnowledge, renderKnowledgeBlock, type KnowledgeHit, type RecipientRole } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import type { AgentInput, AgentSpec } from '../../agent/contracts.js';
import type { KnowledgeContextResult } from '../hooks.js';
import { getKnowledgeSettings } from '../settings.js';
import { gatherCandidates, itemCandidate, resolveKnowledgeRef, retrievalClaim, retrievalRequest, type RetrievalClaim } from './retrieve.js';

const NO_CONTEXT_JOBS = new Set(['mail.triage', 'knowledge.research', 'knowledge.research_web', 'knowledge.curate']);

/** The claim a run is about: the brief's claimId, else "claimId <id>" in the task. */
export function claimIdOf(input: AgentInput): string | null {
  const b = input.brief as { claimId?: unknown; caseBrief?: { claimId?: unknown } } | undefined;
  if (b && typeof b.claimId === 'string') return b.claimId;
  if (b && typeof b.caseBrief?.claimId === 'string') return b.caseBrief.claimId;
  const m = /\bclaimId[:\s]+([A-Za-z0-9-]{6,})/.exec(input.task);
  return m ? m[1]! : null;
}

function recipientFor(ctx: AppContext, spec: AgentSpec, input: AgentInput, claimId: string): RecipientRole | null {
  const drafting = spec.name === 'drafter' || spec.name === 'mail';
  if (!drafting) return null;
  const claim = ctx.repos.getClaim(ctx.db, claimId);
  const text = `${input.task}\n${input.question ?? ''}`;
  const party = /\(party ([A-Za-z0-9-]+)\)/.exec(text)?.[1];
  if (party && claim && party === claim.claimantId) return 'client';
  return 'at_fault_insurer';
}

/** The reviewer's profile: the refs the draft cites (recorded by tier a) plus the claim insurer's learned contacts. */
function reviewerHits(ctx: AppContext, input: AgentInput, claim: RetrievalClaim | null): KnowledgeHit[] {
  const draftId = input.untrusted?.find((u) => u.id.startsWith('draft:'))?.id.slice(6);
  const refs = draftId ? [...new Set(ctx.repos.listKnowledgeUsage(ctx.db, { targetId: draftId, cited: true, limit: 50 }).map((u) => u.ref))].sort() : [];
  const hits: KnowledgeHit[] = [];
  for (const ref of refs) {
    const h = resolveKnowledgeRef(ctx, ref, claim?.recipientRole ?? null);
    if (h) hits.push(h);
  }
  if (claim?.insurerSlug && getKnowledgeSettings(ctx).useLearnedKnowledge) {
    const contacts = ctx.repos.listKnowledgeItems(ctx.db, { status: 'active', kind: 'contact', scopeKind: 'insurer', scopeValue: claim.insurerSlug, limit: 10 }).items;
    const state = ctx.repos.getKnowledgePackState(ctx.db);
    const members = new Set(state.activeVersion !== null ? ctx.repos.listKnowledgePackMembers(ctx.db, state.activeVersion) : []);
    for (const c of contacts) if (members.has(c.id) && !hits.some((h) => h.ref === `ki:${c.id}`)) hits.push(...rankKnowledge([itemCandidate(c, 0)], retrievalRequest(ctx, { agent: 'reviewer', jobType: 'review.check', query: '', claim })));
  }
  return hits.map((h, i) => ({ ...h, rank: i + 1 }));
}

/** The `knowledgeContext` hook. */
export function knowledgeContextFor(ctx: AppContext, spec: AgentSpec, input: AgentInput): KnowledgeContextResult | undefined {
  if (NO_CONTEXT_JOBS.has(spec.jobType)) return undefined;
  const claimId = claimIdOf(input);
  const claim = claimId ? retrievalClaim(ctx, claimId, recipientFor(ctx, spec, input, claimId), input.brief) : null;
  if (spec.name === 'reviewer') {
    const hits = reviewerHits(ctx, input, claim);
    return hits.length ? { text: renderKnowledgeBlock(hits), refs: hits } : undefined;
  }
  const query = buildRetrievalQuery({ agent: spec.name, jobType: spec.jobType, task: `${input.task}\n${input.question ?? ''}`.slice(0, 4000), brief: input.brief ?? null });
  const request = retrievalRequest(ctx, { agent: spec.name, jobType: spec.jobType, query, claim });
  const hits = rankKnowledge(gatherCandidates(ctx, query, { claim }), request, { useLearned: getKnowledgeSettings(ctx).useLearnedKnowledge });
  if (!hits.length) return undefined;
  return { text: renderKnowledgeBlock(hits), refs: hits };
}

/** The `onRunAssembled` hook: which refs the run was given (append-only rows; never throws into the run). */
export function recordRunUsage(ctx: AppContext, runId: string, refs: KnowledgeHit[]): void {
  if (!refs.length) return;
  const run = ctx.repos.getAgentRun(ctx.db, runId);
  const at = ctx.now();
  ctx.db.transaction((tx) => {
    ctx.repos.insertKnowledgeUsage(
      tx,
      refs.map((h) => ({ runId, claimId: run?.claimId ?? null, ref: h.ref, badges: h.badges, rank: h.rank, injected: true, cited: false, targetKind: null, targetId: null, at })),
    );
  });
}
