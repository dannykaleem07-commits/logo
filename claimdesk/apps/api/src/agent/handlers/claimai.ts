// owned by claimai-server
/**
 * Claim AI input job handlers (docs/CLAIM-AI-INPUT.md §5.5). No Needs-you resolvers: the cards it raises reuse
 * `question`, `money`, `legal_review` and `confirm_fields`, resolved by their owners.
 */
import { z } from 'zod';
import type { JobHandler, NeedsYouResolver } from '../contracts.js';
import { catchUpApplyJob, instructionDueJob, interpretJob } from '../../claimai/jobs.js';

const MIN = 60_000;

const interpretHandler: JobHandler<{ inputId: string; revision: number }> = {
  type: 'claim.input_interpret',
  agent: 'case_manager',
  lane: 'ai',
  usesAi: true,
  mutatesClaim: false,
  payload: z.object({ inputId: z.string().min(1), revision: z.number().int().min(0) }).passthrough() as never,
  defaultPriority: 1,
  maxAttempts: 3,
  timeoutMs: 3 * MIN,
  run: ({ ctx, job, payload }) => interpretJob(ctx, job, payload),
};

const catchUpApplyHandler: JobHandler<{ inputId: string; bundleRevision: number }> = {
  type: 'claim.catch_up_apply',
  agent: 'intake',
  lane: 'io',
  usesAi: false,
  mutatesClaim: true,
  payload: z.object({ inputId: z.string().min(1), bundleRevision: z.number().int().min(0) }).passthrough() as never,
  defaultPriority: 2,
  maxAttempts: 2,
  timeoutMs: 10 * MIN,
  run: ({ ctx, job, payload }) => catchUpApplyJob(ctx, job, payload),
};

const instructionDueHandler: JobHandler<{ instructionId: string; claimId: string; until: string }> = {
  type: 'claim.instruction_due',
  agent: 'supervisor',
  lane: 'io',
  usesAi: false,
  mutatesClaim: true,
  payload: z.object({ instructionId: z.string().min(1), claimId: z.string().min(1), until: z.string().min(1) }).passthrough() as never,
  defaultPriority: 3,
  maxAttempts: 3,
  timeoutMs: 2 * MIN,
  run: ({ ctx, job, payload }) => instructionDueJob(ctx, job, payload),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const claimAiJobHandlers: JobHandler<any, any>[] = [interpretHandler, catchUpApplyHandler, instructionDueHandler];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const claimAiNeedsYouResolvers: NeedsYouResolver<any>[] = [];
