// owned by claimai-server
/**
 * The claim AI input job types (docs/CLAIM-AI-INPUT.md §5.5); the handlers in agent/handlers/claimai.ts call these.
 *
 *   claim.input_interpret  ai   {inputId, revision}          interpret.ts (stale revision → done)
 *   claim.catch_up_apply   io   {inputId, bundleRevision}    files settled + files done + auto apply → apply as agent:intake
 *   claim.instruction_due  io   {instructionId, claimId, until}  a hold / timed pause ends → agent:supervisor
 */
import type { AppContext } from '../context.js';
import type { JobOutcome, JobRecord } from '../agent/contracts.js';
import { nudgeAutopilot } from '../autopilot/nudge.js';
import { parseEffect } from '@ccguk/domain';
import { applyInput } from './apply.js';
import { planInput } from './catchUp.js';
import { SUPERVISOR } from './instructions.js';
import { INTAKE_AGENT, logInput } from './service.js';

export { interpretJob } from './interpret.js';

export async function catchUpApplyJob(ctx: AppContext, job: JobRecord, payload: { inputId: string; bundleRevision: number }): Promise<JobOutcome> {
  const input = ctx.repos.getAiInput(ctx.db, payload.inputId);
  if (!input || input.kind !== 'catch_up' || !input.bundleId) return { kind: 'fail', reason: `catch-up ${payload.inputId} not found` };
  if (!input.autoApply) return { kind: 'done', result: { skipped: 'Apply automatically is off' } };
  if (!['reading', 'preview', 'partly_applied'].includes(input.status)) return { kind: 'done', result: { skipped: input.status } };
  const bundle = ctx.repos.getIntakeBundle(ctx.db, input.bundleId);
  if (!bundle) return { kind: 'fail', reason: `bundle ${input.bundleId} not found` };
  if (payload.bundleRevision < bundle.revision) return { kind: 'done', result: { stale: true } };
  const interp = planInput(ctx, input);
  ctx.repos.updateAiInput(ctx.db, input.id, { interpretation: interp, ...(input.status === 'reading' && interp.catchUp?.settled ? { status: 'preview' } : {}) }, ctx.now());
  if (!interp.catchUp?.settled) return { kind: 'done', result: { skipped: 'files still being read' } };
  const runId = `claim-catch-up-${job.id}`;
  const fresh = await applyInput(ctx, { userId: INTAKE_AGENT, runId }, input.claimId, input.id, [], { mode: 'agent', jobId: job.id });
  return { kind: 'done', result: { status: fresh.status } };
}

export async function instructionDueJob(ctx: AppContext, _job: JobRecord, payload: { instructionId: string; claimId: string; until: string }): Promise<JobOutcome> {
  const ins = ctx.repos.getInstruction(ctx.db, payload.instructionId);
  if (!ins) return { kind: 'fail', reason: `instruction ${payload.instructionId} not found` };
  if (ins.status === 'retired') return { kind: 'done', result: { skipped: 'removed' } };
  if (ins.until !== payload.until) return { kind: 'done', result: { skipped: 'the end date changed' } };
  if (Date.parse(ctx.now()) < Date.parse(payload.until)) return { kind: 'retry', afterMs: Math.max(60_000, Date.parse(payload.until) - Date.parse(ctx.now())), reason: 'not yet' };
  const effect = parseEffect(ins.effect);
  const actor = { userId: SUPERVISOR };
  let resumed = false;
  if (effect?.kind === 'pause_agents') {
    const state = ctx.repos.getClaimAgentState(ctx.db, ins.claimId);
    // only when the claim is still paused by the owner who gave the instruction
    if (state.paused && (!state.pausedBy || state.pausedBy === ins.createdBy)) {
      ctx.repos.resumeClaimAgents(ctx.db, ins.claimId, { actor, now: ctx.now() });
      resumed = true;
    }
  }
  ctx.repos.appendAudit(ctx.db, { actor, action: 'claim_ai.instruction.due', entity: 'claim_instructions', entityId: ins.id, after: { claimId: ins.claimId, instructionId: ins.id, onBehalfOf: ins.createdBy, effect: effect?.kind ?? null, resumed }, at: ctx.now() });
  if (ins.sourceInputId) {
    const input = ctx.repos.getAiInput(ctx.db, ins.sourceInputId);
    if (input) logInput(ctx, input, 'instruction_due', SUPERVISOR, { ...(ins.sourceActionKey ? { actionKey: `${ins.sourceActionKey}:due` } : {}), note: resumed ? 'agents resumed' : 'the hold ended' });
  }
  nudgeAutopilot(ctx, ins.claimId, 'standing instruction ended');
  return { kind: 'done', result: { resumed } };
}
