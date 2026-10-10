// owned by knowledge-learners
/**
 * Knowledge learners (docs/SUPREME-KNOWLEDGE-BUILDER.md §6, §10.1). No knowledge job mutates a claim; lane, agent,
 * priority and AI use come from JOB_TYPE_INFO through `knowledgeHandler()`. With `learningEnabled = false` every
 * learner finishes with `result: 'learning_off'` and writes nothing (KR-13).
 *
 *   knowledge.observe      cpu · 30 min · sources mail | offers | corrections | engineering | owner_text (or all);
 *                          follow-up: knowledge.consolidate when a contact observation was added
 *   knowledge.consolidate  cpu · after observe; 02:00 — contacts from agreeing verified observations; nightly conflict sweep
 *   knowledge.learn_stats  cpu · 01:30; owner "recompute" — insurer links, claim outcomes, profiles, step statistics,
 *                          engineering figures
 *   knowledge.curate       ai  · cluster ≥ 3 new corrections; Sun 04:00 — the curator (curate.ts)
 */
import { z } from 'zod';
import { isoWeekOf } from '@ccguk/domain';
import type { JobHandler, NeedsYouResolver, JobRecord } from '../contracts.js';
import { knowledgeHandler, learningOff } from '../../knowledge/jobs.js';
import { londonDay } from '../core.js';
import { observeMailContacts, consolidateContacts, markFailedContacts } from '../../knowledge/learners/contacts.js';
import { observeOffers } from '../../knowledge/learners/offers.js';
import { captureCorrections } from '../../knowledge/learners/corrections.js';
import { learnEngineering } from '../../knowledge/learners/engineering.js';
import { observeOwnerText } from '../../knowledge/learners/ownerText.js';
import { learnStatistics } from '../../knowledge/learners/outcomes.js';
import { linkInsurerParties } from '../../knowledge/learners/links.js';
import { sweepConflicts } from '../../knowledge/learners/conflicts.js';
import { runCurate, type CuratePayload } from '../../knowledge/learners/curate.js';

export const OBSERVE_SOURCES = ['mail', 'offers', 'corrections', 'engineering', 'owner_text'] as const;
export type ObserveSource = (typeof OBSERVE_SOURCES)[number];

const observePayload = z.object({ source: z.enum([...OBSERVE_SOURCES, 'all']).optional() }).passthrough();
type ObservePayload = z.infer<typeof observePayload>;

const slot30 = (iso: string): string => {
  const d = new Date(Date.parse(iso));
  d.setUTCMinutes(d.getUTCMinutes() < 30 ? 0 : 30, 0, 0);
  return d.toISOString().slice(0, 16);
};

export const knowledgeObserveHandler = knowledgeHandler<ObservePayload, Record<string, unknown>>('knowledge.observe', observePayload, async ({ ctx, job, payload }) => {
  if (learningOff(ctx)) return { kind: 'done', result: { result: 'learning_off' } };
  const sources: ObserveSource[] = !payload.source || payload.source === 'all' ? [...OBSERVE_SOURCES] : [payload.source];
  const result: Record<string, unknown> = { result: 'observed', sources };
  let newContacts = 0;
  for (const s of sources) {
    try {
      switch (s) {
        case 'mail': {
          const r = observeMailContacts(ctx);
          newContacts += r.observations;
          result.mail = r;
          break;
        }
        case 'offers':
          result.offers = observeOffers(ctx);
          break;
        case 'corrections':
          result.corrections = captureCorrections(ctx);
          break;
        case 'engineering':
          result.engineering = learnEngineering(ctx, { jobId: job.id });
          break;
        case 'owner_text':
          result.ownerText = observeOwnerText(ctx);
          break;
      }
    } catch (err) {
      // One failing source never stops the others (and never stops claim work).
      ctx.logger.warn('knowledge.observe source failed', { source: s, error: err instanceof Error ? err.message : String(err) });
      result[`${s}Error`] = err instanceof Error ? err.message : String(err);
    }
  }
  const followUps = newContacts ? [{ type: 'knowledge.consolidate' as const, payload: { reason: 'observe' }, idempotencyKey: `knowledge.consolidate:${slot30(ctx.now())}`, createdBy: job.createdBy, parentJobId: job.id }] : [];
  return { kind: 'done', result, ...(followUps.length ? { followUps } : {}) };
});

const consolidatePayload = z.object({ reason: z.string().max(200).optional() }).passthrough();

export const knowledgeConsolidateHandler = knowledgeHandler<z.infer<typeof consolidatePayload>, Record<string, unknown>>('knowledge.consolidate', consolidatePayload, async ({ ctx, payload }) => {
  if (learningOff(ctx)) return { kind: 'done', result: { result: 'learning_off' } };
  const contacts = consolidateContacts(ctx);
  const failedContacts = markFailedContacts(ctx);
  // The nightly run (not the follow-up of an observe) also sweeps every active learned item for conflicts.
  const sweep = payload.reason === 'observe' ? null : sweepConflicts(ctx);
  return { kind: 'done', result: { result: 'consolidated', contacts, failedContacts, ...(sweep ? { conflicts: sweep } : {}) } };
});

const learnStatsPayload = z.object({ reason: z.string().max(200).optional() }).passthrough();

export const knowledgeLearnStatsHandler = knowledgeHandler<z.infer<typeof learnStatsPayload>, Record<string, unknown>>(
  'knowledge.learn_stats',
  learnStatsPayload,
  async ({ ctx, job }) => {
    if (learningOff(ctx)) return { kind: 'done', result: { result: 'learning_off' } };
    const links = linkInsurerParties(ctx);
    const stats = learnStatistics(ctx, { jobId: job.id });
    const engineering = learnEngineering(ctx, { jobId: job.id });
    return { kind: 'done', result: { result: 'learned', links: { linked: links.linked.length, asked: links.asked.length, appliedOwnerAnswers: links.appliedOwnerAnswers, unlinked: links.unlinked }, stats, engineering } };
  },
  { timeoutMs: 15 * 60_000 },
);

const curatePayload = z.object({ clusterKey: z.string().min(3).max(300).optional(), weekly: z.boolean().optional(), force: z.boolean().optional() }).passthrough();

export const knowledgeCurateHandler = knowledgeHandler<CuratePayload, unknown>('knowledge.curate', curatePayload as never, async ({ ctx, job, payload }) => runCurate(ctx, job as JobRecord, payload) as never, { timeoutMs: 9 * 60_000, maxAttempts: 2 });

/** The idempotency key of an owner-triggered learner run (POST /knowledge/learn/run). */
export function learnRunKey(learner: 'observe' | 'consolidate' | 'learn_stats' | 'curate', now: string): string {
  switch (learner) {
    case 'observe':
      return `knowledge.observe:all:owner:${now}`;
    case 'consolidate':
      return `knowledge.consolidate:owner:${now}`;
    case 'learn_stats':
      return `knowledge.learn_stats:owner:${now}`;
    case 'curate':
      return `knowledge.curate:owner:${isoWeekOf(londonDay(now))}:${now}`;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const knowledgeLearningJobHandlers: JobHandler<any, any>[] = [knowledgeObserveHandler, knowledgeConsolidateHandler, knowledgeLearnStatsHandler, knowledgeCurateHandler];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const knowledgeLearningNeedsYouResolvers: NeedsYouResolver<any>[] = [];
