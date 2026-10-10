// owned by ap-foundation
/**
 * actAsAutopilot (docs/SUPREME-AUTOPILOT.md §A.7): the one way the deterministic `agent:autopilot` principal acts — and
 * every slice that acts without a model uses it. It never runs a model:
 *
 *   1 records a run (`agent_runs` row: driver 'deterministic', model 'none', prompt_version 'autopilot/1:<planHash>',
 *     input_sha256 of the code-built tool call) and audits `agent.run.start`;
 *   2 mints a claim-scoped run token for `agent:autopilot` (short TTL) and builds the RunContext with `step`, so the
 *     dispatcher copies `{ id, mode, green }` onto the policy descriptor (rules 4a/4b, refined 13);
 *   3 calls `executeTool(ctx, rc, tool, input)` — the same door as every agent: allow-list (the autopilot subset of
 *     §H.2), input validation, claim scope, `decide()` (kill switch, pauses incl. the Autopilot pause, always-ask
 *     classes, shadow mode, …), the perimeter and the route as the agent;
 *   4 revokes the token, finishes the run (`ok`, or `error` when the call failed) and audits `agent.run.end`.
 *
 * The input is built by code (InputBuilders), never by a model. Failures are results (`ok: false`), never throws.
 */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { AUTOPILOT_PRINCIPAL_TOOLS, type StepContext, type ToolName } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { ToolCallResult } from '../ai/types.js';
import type { RunContext } from '../agent/contracts.js';
import { executeTool, registerRun, unregisterRun } from '../agent/dispatcher.js';
import { agentUserId, mintRunToken, revokeRunToken } from '../agent/principal.js';

/** Prompt-version prefix of autopilot runs (the plan hash follows). */
export const AUTOPILOT_RUN_VERSION = 'autopilot/1';
/** Lifetime of an autopilot run token: one tool call, including a route that renders a document. */
export const AUTOPILOT_TOKEN_TTL_MS = 5 * 60_000;

export interface ActAsAutopilotInput {
  claimId: string;
  /** The step acted for, with its effective mode and whether it is green; null for housekeeping outside a step. */
  step: StepContext | null;
  tool: ToolName;
  /** Built by code (InputBuilders) — never by a model. */
  input: unknown;
  /** The plan the action comes from (prompt_version 'autopilot/1:<planHash>'). */
  planHash?: string;
  /** The job running the step (agent_runs.job_id); defaults to a synthetic 'autopilot:<runId>'. */
  jobId?: string;
  /** Correlation id of the chain (defaults to the job id). */
  correlationId?: string;
}

export interface ActAsAutopilotResult extends ToolCallResult {
  runId: string;
}

const AUTOPILOT = 'autopilot' as const;

function audit(ctx: AppContext, runId: string, action: 'agent.run.start' | 'agent.run.end', after: Record<string, unknown>): void {
  try {
    ctx.repos.appendAudit(ctx.db, { actor: { userId: agentUserId(AUTOPILOT), runId }, action, entity: 'agent_runs', entityId: runId, after, at: ctx.now() });
  } catch (err) {
    ctx.logger.error(`could not audit ${action}`, { error: String(err) });
  }
}

/** Execute one tool call as `agent:autopilot` for a claim (§A.7). */
export async function actAsAutopilot(ctx: AppContext, args: ActAsAutopilotInput): Promise<ActAsAutopilotResult> {
  const runId = randomUUID();
  const jobId = args.jobId ?? `autopilot:${runId}`;
  const promptVersion = `${AUTOPILOT_RUN_VERSION}:${args.planHash ?? 'none'}`;
  const inputSha256 = createHash('sha256')
    .update(JSON.stringify({ tool: args.tool, input: args.input ?? null, step: args.step }))
    .digest('hex');
  const startedAt = ctx.now();

  try {
    ctx.repos.startAgentRun(ctx.db, { id: runId, jobId, agent: AUTOPILOT, jobType: 'autopilot.tick', claimId: args.claimId, driver: 'deterministic', model: 'none', effort: 'none', promptVersion, inputSha256, startedAt });
  } catch (err) {
    return { ok: false, runId, content: JSON.stringify({ error: { code: 'RUN_SETUP_FAILED', message: err instanceof Error ? err.message : String(err) } }) };
  }
  audit(ctx, runId, 'agent.run.start', { jobId, jobType: 'autopilot.tick', claimId: args.claimId, driver: 'deterministic', model: 'none', promptVersion, tool: args.tool, step: args.step });

  const token = mintRunToken({ name: AUTOPILOT, runId, jobId, claimScope: args.claimId }, AUTOPILOT_TOKEN_TTL_MS);
  const rc: RunContext = {
    runId,
    jobId,
    agent: AUTOPILOT,
    claimScope: args.claimId,
    token,
    allowedTools: new Set<ToolName>(AUTOPILOT_PRINCIPAL_TOOLS),
    runDir: path.join(ctx.config.agentRunsDir, runId),
    correlationId: args.correlationId ?? jobId,
    ...(args.step ? { step: { id: args.step.id, mode: args.step.mode, green: args.step.green } } : {}),
  };

  let result: ToolCallResult;
  registerRun(rc);
  try {
    result = await executeTool(ctx, rc, args.tool, args.input);
  } catch (err) {
    // executeTool never throws by contract; keep the run honest if it ever does.
    result = { ok: false, content: JSON.stringify({ error: { code: 'TOOL_FAILED', message: err instanceof Error ? err.message : String(err) } }) };
  } finally {
    revokeRunToken(token);
    unregisterRun(runId);
  }

  let errorCode: string | undefined;
  if (!result.ok) {
    try {
      errorCode = String((JSON.parse(result.content) as { error?: { code?: unknown } }).error?.code ?? 'TOOL_FAILED');
    } catch {
      errorCode = 'TOOL_FAILED';
    }
  }
  try {
    ctx.repos.finishAgentRun(ctx.db, runId, {
      outcome: result.ok ? 'ok' : 'error',
      endedAt: ctx.now(),
      numTurns: 0,
      result: { tool: args.tool, ok: result.ok, ...(result.needsYouId ? { needsYouId: result.needsYouId } : {}) },
      ...(errorCode ? { error: errorCode } : {}),
    });
  } catch (err) {
    ctx.logger.error('could not finish the autopilot run row', { error: String(err), runId });
  }
  audit(ctx, runId, 'agent.run.end', { outcome: result.ok ? 'ok' : 'error', startedAt, tool: args.tool, ...(errorCode ? { code: errorCode } : {}), ...(result.needsYouId ? { needsYouId: result.needsYouId } : {}) });
  return { ...result, runId };
}
