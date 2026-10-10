// owned by knowledge-core
/**
 * Late-bound knowledge hooks (docs/SUPREME-KNOWLEDGE-BUILDER.md §8.1, §10.4): `ctx.services.knowledge`, registered at
 * boot by the slices that own each behaviour. The gateway (prompts.ts), runAgent, the store and the Needs-you resolver
 * read them; an absent hook means the feature is off. Every call site guards against a throwing hook so a broken
 * learner can never stop claim work.
 *
 *   knowledgeContext   knowledge-use      the "# Knowledge" block inserted after the Case Brief (never the cached prefix)
 *   onRunAssembled     knowledge-use      writes knowledge_usage rows for the refs given to a run
 *   webPolicyFor       knowledge-research the WebFetch policy for knowledge.research_web (runAgent refuses it otherwise)
 *   onItemStatus       research / use     an item changed status (research closes gaps; use refreshes caches)
 *   onReviewResolved   research / use     the owner answered a knowledge_review gap or alarm card
 *   conflictsFor       knowledge-learners conflict detection on every proposal (§6.7) — additive to the §10.4 list
 */
import type { Actor } from '@ccguk/db';
import type { ConflictFinding, KnowledgeHit, KnowledgeItem, KnowledgeProposal, KnowledgeReviewPayload, KnowledgeStatus } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { AgentInput, AgentSpec, JobRecord } from '../agent/contracts.js';
import type { WebResearchPolicy } from '../ai/types.js';
import { getKnowledgeSettings } from './settings.js';

export interface KnowledgeContextResult {
  text: string;
  refs: KnowledgeHit[];
}

export interface KnowledgeHooks {
  knowledgeContext?: (ctx: AppContext, spec: AgentSpec, input: AgentInput) => KnowledgeContextResult | undefined;
  onRunAssembled?: (ctx: AppContext, runId: string, refs: KnowledgeHit[]) => void;
  webPolicyFor?: (ctx: AppContext, spec: AgentSpec, job: JobRecord) => WebResearchPolicy | undefined;
  onItemStatus?: (ctx: AppContext, item: KnowledgeItem, from: KnowledgeStatus) => void;
  onReviewResolved?: (ctx: AppContext, payload: KnowledgeReviewPayload, choice: string, actor: Actor, extra: { edits?: unknown; note?: string; needsYouId: string }) => Promise<void>;
  conflictsFor?: (ctx: AppContext, proposal: KnowledgeProposal) => ConflictFinding[];
}

interface KnowledgeServices {
  knowledge?: KnowledgeHooks;
}

/** The registered hooks (an empty object when none are). */
export function knowledgeHooks(ctx: AppContext): KnowledgeHooks {
  const s = ctx.services as unknown as KnowledgeServices;
  if (!s.knowledge) s.knowledge = {};
  return s.knowledge;
}

/**
 * Register (merge) hooks. A slice registers only its own keys; passing `undefined` for a key removes it (tests).
 * Returns a function that restores the previous values of the keys it set.
 */
export function registerKnowledgeHooks(ctx: AppContext, hooks: Partial<KnowledgeHooks>): () => void {
  const target = knowledgeHooks(ctx) as Record<string, unknown>;
  const previous: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(hooks)) {
    previous[k] = target[k];
    if (v === undefined) delete target[k];
    else target[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete target[k];
      else target[k] = v;
    }
  };
}

/** Call a hook, logging (never throwing) on failure. */
export function safeHook<T>(ctx: AppContext, name: keyof KnowledgeHooks, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    ctx.logger.warn(`knowledge hook ${String(name)} failed`, { error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

export class WebResearchRefusedError extends Error {
  readonly code = 'WEB_RESEARCH_REFUSED';
}

/**
 * The web policy for a run (§7.8, KR-8), or undefined. runAgent calls this: a policy is refused (a non-retryable
 * WEB_RESEARCH_REFUSED) unless the job is `knowledge.research_web`, learning is on and the owner switched web research
 * on. No other job ever gets web tools.
 */
export function webPolicyForRun(ctx: AppContext, spec: AgentSpec, job: JobRecord): WebResearchPolicy | undefined {
  const hook = knowledgeHooks(ctx).webPolicyFor;
  if (!hook) return undefined;
  const policy = hook(ctx, spec, job);
  if (!policy) return undefined;
  const s = getKnowledgeSettings(ctx);
  if (spec.jobType !== 'knowledge.research_web' || job.type !== 'knowledge.research_web') throw new WebResearchRefusedError(`Web research is only for knowledge.research_web, not ${spec.jobType}`);
  if (!s.learningEnabled || !s.webResearchEnabled) throw new WebResearchRefusedError('Web research is switched off (Knowledge ▸ Safety)');
  return policy;
}

/** Tell knowledge-use which refs a run was given (writes knowledge_usage); never throws. */
export function notifyRunAssembled(ctx: AppContext, runId: string, refs: KnowledgeHit[]): void {
  const hook = knowledgeHooks(ctx).onRunAssembled;
  if (hook && refs.length) safeHook(ctx, 'onRunAssembled', () => hook(ctx, runId, refs));
}

/** The knowledge block for a prompt (after the Case Brief), or undefined; a failing provider is logged, never fatal. */
export function knowledgeBlockFor(ctx: AppContext, spec: AgentSpec, input: AgentInput): KnowledgeContextResult | undefined {
  const hook = knowledgeHooks(ctx).knowledgeContext;
  if (!hook) return undefined;
  const r = safeHook(ctx, 'knowledgeContext', () => hook(ctx, spec, input));
  return r && typeof r.text === 'string' && r.text.trim() ? { text: r.text.trim(), refs: Array.isArray(r.refs) ? r.refs : [] } : undefined;
}
