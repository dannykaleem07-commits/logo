// owned by knowledge-core
/**
 * Shared knowledge job plumbing (docs/SUPREME-KNOWLEDGE-BUILDER.md §10.1, §12.3):
 *  - `knowledgeHandler()` builds a handler whose lane / agent / priority / AI use come from JOB_TYPE_INFO, so every
 *    knowledge job matches the vocabulary (the contracts test compares them);
 *  - `learningOff()` — with `learningEnabled = false` every knowledge job except an owner-triggered publish or
 *    activation finishes with `result: 'learning_off'` (§12.3);
 */
import { JOB_TYPE_INFO, type JobType } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { JobContext, JobHandler, JobOutcome, PayloadSchema } from '../agent/contracts.js';
import { getKnowledgeSettings } from './settings.js';

export const KNOWLEDGE_JOB_MAX_ATTEMPTS = 3;
export const KNOWLEDGE_JOB_TIMEOUT_MS = 10 * 60_000;

export function knowledgeHandler<P, R>(type: JobType, payload: PayloadSchema<P>, run: (jc: JobContext<P>) => Promise<JobOutcome<R>>, opts: { timeoutMs?: number; maxAttempts?: number } = {}): JobHandler<P, R> {
  const info = JOB_TYPE_INFO[type];
  return {
    type,
    agent: info.agent,
    lane: info.lane,
    usesAi: info.usesAi !== false && info.usesAi !== 'optional',
    mutatesClaim: info.mutatesClaim,
    payload,
    defaultPriority: info.defaultPriority,
    maxAttempts: opts.maxAttempts ?? KNOWLEDGE_JOB_MAX_ATTEMPTS,
    timeoutMs: opts.timeoutMs ?? KNOWLEDGE_JOB_TIMEOUT_MS,
    run,
  };
}

/** The kill switch (KR-13): true when learning is paused. */
export function learningOff(ctx: AppContext): boolean {
  return !getKnowledgeSettings(ctx).learningEnabled;
}
