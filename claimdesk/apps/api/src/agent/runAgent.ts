// owned by gateway
/**
 * runAgent (docs/SUPREME-DESIGN.md §A.1) — the only caller of an AiDriver:
 *   1 mint the run token + RunContext (claimScope = job.claimId, TTL = timeout + 2 min), make `<agentRunsDir>/<runId>`
 *     and copy the attachments into `input/` (each copy re-hashed against its recorded sha256);
 *   2 assemble the prompts (§O) → AiRunRequest; insert the agent_runs row (running); audit `agent.run.start`;
 *   3 driver.run(req, executor, abort signal) — tool calls go through the dispatcher (§B.3);
 *   4 validate the result with the zod twin of the result schema; record usage, cost and the rate limit
 *     (ai_usage_state; a usage limit pauses AI until reset + 2 min); revoke the token; audit `agent.run.end`;
 *   5 return { outcome, result, runId } — the job handler turns it into follow-ups (never the driver).
 */
import { randomUUID, createHash } from 'node:crypto';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { RESULT_SCHEMAS, type ResultSchemaId } from '@ccguk/domain';
import type { z } from 'zod/v4';
import type { AppContext } from '../context.js';
import type { AiAttachment, AiRunOutcome, AiRunRequest, AiUsage } from '../ai/types.js';
import type { AgentInput, AgentRunResult, AgentSpec, JobRecord, RunContext } from './contracts.js';
import { agentUserId, mintRunToken, revokeRunToken } from './principal.js';
import { executorFor, registerRun, unregisterRun } from './dispatcher.js';
import { assemblePrompts } from '../ai/prompts.js';
import { getDriver, isOffDriver } from '../ai/driverFactory.js';
import { validateWithTwin, zodFromJsonSchema } from '../ai/strictSchema.js';
import { recordApiCost } from '../ai/pricing.js';
import { createNeedsYou } from './core.js';
import { hashFile } from '../services/evidence.js';

/** Grace added to the run token's lifetime beyond the run timeout (§A.1: timeout + 2 min). */
export const RUN_TOKEN_GRACE_MS = 2 * 60_000;
/** Extra time the outer abort waits for a driver's own timeout handling. */
export const ABORT_GRACE_MS = 5_000;
/** A usage limit pauses AI until its reset plus this margin (§A.5); an unknown reset waits 15 minutes. */
export const USAGE_RESUME_MARGIN_MS = 2 * 60_000;
export const USAGE_UNKNOWN_RESET_MS = 15 * 60_000;
/** A sign-in / key failure pauses AI this long unless the owner says it is fixed first (§A.7). */
export const AUTH_FAILED_PAUSE_MS = 24 * 60 * 60_000;

const twins = new Map<ResultSchemaId, z.ZodType>();
/** The zod twin of a result schema (cached). */
export function resultTwin(id: ResultSchemaId): z.ZodType {
  let t = twins.get(id);
  if (!t) {
    t = zodFromJsonSchema(RESULT_SCHEMAS[id]);
    twins.set(id, t);
  }
  return t;
}

/** Effective model/effort/turns/timeout: spec defaults ← quality switch ← Settings per-job ← call overrides. */
export function effectiveModel(ctx: AppContext, spec: AgentSpec, overrides: AgentInput['overrides'] = {}): AgentSpec['defaults'] {
  const ai = ctx.repos.getAgentSettings(ctx.db).ai;
  let model = spec.defaults.model;
  if (ai.quality === 'economy' && model === 'claude-opus-5-5') model = 'claude-sonnet-5-5';
  if (ai.quality === 'best' && model === 'claude-sonnet-5-5') model = 'claude-opus-5-5';
  const per = ai.perJob[spec.jobType] ?? {};
  return {
    model: overrides.model ?? per.model ?? model,
    effort: overrides.effort ?? per.effort ?? spec.defaults.effort,
    maxTurns: overrides.maxTurns ?? per.maxTurns ?? spec.defaults.maxTurns,
    timeoutMs: overrides.timeoutMs ?? per.timeoutMs ?? spec.defaults.timeoutMs,
  };
}

class AttachmentError extends Error {
  readonly code = 'ATTACHMENT_TAMPERED';
}

/** Copy attachments into `<runDir>/input`, re-hashing each copy (streamed, never loaded whole) against its recorded sha256. */
export async function copyAttachments(runDir: string, attachments: AiAttachment[]): Promise<AiAttachment[]> {
  if (!attachments.length) return [];
  const inputDir = path.join(runDir, 'input');
  mkdirSync(inputDir, { recursive: true });
  const out: AiAttachment[] = [];
  for (const [i, a] of attachments.entries()) {
    const safe = path.basename(a.path).replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || `file${i}`;
    const target = path.join(inputDir, `${String(i + 1).padStart(2, '0')}-${safe}`);
    copyFileSync(a.path, target);
    const sha = await hashFile(target);
    if (sha !== a.sha256.toLowerCase()) throw new AttachmentError(`Attachment ${a.label} does not match its recorded hash; it was not given to the agent`);
    out.push({ ...a, path: target });
  }
  return out;
}

function audit(ctx: AppContext, rc: Pick<RunContext, 'agent' | 'runId'>, action: 'agent.run.start' | 'agent.run.end', after: Record<string, unknown>): void {
  try {
    ctx.repos.appendAudit(ctx.db, { actor: { userId: agentUserId(rc.agent), runId: rc.runId }, action, entity: 'agent_runs', entityId: rc.runId, after, at: ctx.now() });
  } catch (err) {
    ctx.logger.error(`could not audit ${action}`, { error: String(err) });
  }
}

const usageOf = (o: AiRunOutcome): AiUsage | undefined => ('usage' in o ? o.usage : undefined);
const messageOf = (o: AiRunOutcome): string | undefined =>
  o.kind === 'ok' ? undefined : o.kind === 'error' || o.kind === 'auth_failed' ? o.message : o.kind === 'invalid_output' ? o.errors.join('; ') : o.kind === 'refused' ? (o.explanation ?? o.category ?? 'refused') : o.kind === 'usage_limited' ? `usage limit${o.limitType ? ` (${o.limitType})` : ''}${o.resetsAt ? ` until ${o.resetsAt}` : ''}` : o.kind;

export async function runAgent(ctx: AppContext, spec: AgentSpec, job: JobRecord, input: AgentInput): Promise<AgentRunResult> {
  const runId = randomUUID();
  let driver;
  try {
    driver = getDriver(ctx);
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'DRIVER_UNAVAILABLE';
    return { runId, outcome: { kind: 'error', retryable: false, code, message: err instanceof Error ? err.message : String(err) } };
  }
  if (isOffDriver(driver)) return { runId, outcome: await driver.run() };

  const m = effectiveModel(ctx, spec, input.overrides);
  const claimScope = job.claimId ?? undefined;
  const token = mintRunToken({ name: spec.name, runId, jobId: job.id, ...(claimScope ? { claimScope } : {}) }, m.timeoutMs + RUN_TOKEN_GRACE_MS);
  const runDir = path.join(ctx.config.agentRunsDir, runId);
  const rc: RunContext = { runId, jobId: job.id, agent: spec.name, ...(claimScope ? { claimScope } : {}), token, allowedTools: new Set(spec.tools), runDir, correlationId: job.correlationId };
  const startedAt = ctx.now();
  let outcome: AiRunOutcome;
  let result: unknown;
  let rowStarted = false;
  try {
    mkdirSync(path.join(runDir, 'input'), { recursive: true });
    const attachments = await copyAttachments(runDir, input.attachments ?? []);
    const prompts = assemblePrompts(spec, { ...input, attachments }, ctx);
    const resultSchema = RESULT_SCHEMAS[spec.resultSchemaId];
    const req: AiRunRequest = {
      runId,
      jobId: job.id,
      agent: spec.name,
      jobType: spec.jobType,
      ...(claimScope ? { claimId: claimScope } : {}),
      model: m.model,
      effort: m.effort,
      maxTurns: m.maxTurns,
      timeoutMs: m.timeoutMs,
      system: prompts.system,
      user: prompts.user,
      attachments,
      tools: [...spec.tools],
      allowRead: spec.allowRead,
      resultSchema,
      resultSchemaId: spec.resultSchemaId,
      runDir,
      promptVersion: prompts.promptVersion,
    };
    const inputSha256 = createHash('sha256')
      .update(prompts.system.map((b) => b.text).join('\n\u0000'))
      .update('\u0000')
      .update(prompts.user)
      .update(attachments.map((a) => a.sha256).join(','))
      .digest('hex');
    ctx.repos.startAgentRun(ctx.db, { id: runId, jobId: job.id, agent: spec.name, jobType: spec.jobType, ...(claimScope ? { claimId: claimScope } : {}), driver: driver.kind, model: m.model, effort: m.effort, promptVersion: prompts.promptVersion, inputSha256, startedAt });
    rowStarted = true;
    audit(ctx, rc, 'agent.run.start', { jobId: job.id, jobType: spec.jobType, claimId: claimScope ?? null, driver: driver.kind, model: m.model, effort: m.effort, promptVersion: prompts.promptVersion, tools: spec.tools });
    registerRun(rc);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), m.timeoutMs + ABORT_GRACE_MS);
    try {
      outcome = await driver.run(req, executorFor(ctx, rc), ac.signal);
    } catch (err) {
      outcome = { kind: 'error', retryable: true, code: (err as { code?: string }).code ?? 'DRIVER_FAILED', message: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }

    if (outcome.kind === 'ok') {
      const v = validateWithTwin(resultTwin(spec.resultSchemaId), outcome.result);
      if (v.ok) result = v.value;
      else outcome = { kind: 'invalid_output', raw: JSON.stringify(outcome.result ?? null).slice(0, 4000), errors: v.errors, usage: outcome.usage };
    }
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'RUN_SETUP_FAILED';
    outcome = { kind: 'error', retryable: code !== 'ATTACHMENT_TAMPERED' && code !== 'PROMPT_FILE_MISSING', code, message: err instanceof Error ? err.message : String(err) };
  } finally {
    revokeRunToken(token);
    unregisterRun(runId);
  }

  // Usage, cost, rate limit, pause.
  const usage = usageOf(outcome);
  let costUsd = usage?.costUsd;
  if (driver.kind === 'api_key' && usage) {
    try {
      costUsd = recordApiCost(ctx, usage, outcome.kind === 'ok' ? outcome.model : m.model).costUsd;
    } catch (err) {
      ctx.logger.warn('could not record API cost', { error: String(err) });
    }
  }
  if (outcome.kind === 'usage_limited') {
    const now = ctx.now();
    const reset = outcome.resetsAt ? Date.parse(outcome.resetsAt) + USAGE_RESUME_MARGIN_MS : Date.parse(now) + USAGE_UNKNOWN_RESET_MS;
    try {
      const until = new Date(Math.max(reset, Date.parse(now) + 60_000)).toISOString();
      const reason = `usage_limited${outcome.limitType ? `:${outcome.limitType}` : ''}`;
      ctx.repos.pauseAi(ctx.db, { until, reason, now });
      // The daily log's "Minutes AI was paused" reads these rows.
      ctx.repos.appendAudit(ctx.db, { actor: { userId: 'agent:supervisor', runId }, action: 'ai.pause', entity: 'ai_usage_state', entityId: 'default', after: { until, reason, jobId: job.id }, at: now });
    } catch (err) {
      ctx.logger.warn('could not pause AI after a usage limit', { error: String(err) });
    }
  }
  if (outcome.kind === 'auth_failed') {
    // §A.7: a sign-in / key failure stops every AI run until the owner fixes it. Pause AI (the setup resolver's "I've
    // fixed it" lifts the pause; it also lapses after a day so a fixed sign-in is picked up) and ask once per day.
    const now = ctx.now();
    try {
      const until = new Date(Date.parse(now) + AUTH_FAILED_PAUSE_MS).toISOString();
      ctx.repos.pauseAi(ctx.db, { until, reason: 'auth_failed', now });
      ctx.repos.appendAudit(ctx.db, { actor: { userId: 'agent:supervisor', runId }, action: 'ai.pause', entity: 'ai_usage_state', entityId: 'default', after: { until, reason: 'auth_failed', jobId: job.id }, at: now });
      createNeedsYou(ctx, {
        kind: 'setup',
        title: driver.kind === 'api_key' ? 'AI paused: the Anthropic API key was refused' : 'AI paused: Claude Code needs signing in again',
        summary:
          driver.kind === 'api_key'
            ? 'The Anthropic API refused the stored key, so every AI job is paused. Open Settings > AI, check or replace the key, then choose "I\'ve fixed it". Mail, sends already approved, clocks and the daily log carry on.'
            : 'The Claude Code CLI reported that it is not signed in (or the sign-in expired), so every AI job is paused. Open Settings > AI and follow the sign-in steps, then choose "I\'ve fixed it". Mail, sends already approved, clocks and the daily log carry on.',
        options: [
          { id: 'fixed', label: "I've fixed it", tone: 'primary' },
          { id: 'dismiss', label: 'Dismiss', tone: 'neutral' },
        ],
        payload: { reason: 'auth_failed', driver: driver.kind, message: outcome.message.slice(0, 500), link: '/settings/ai' },
        priority: 'urgent',
        createdBy: 'system',
        dedupeKey: `setup:ai_auth:${now.slice(0, 10)}`,
      });
    } catch (err) {
      ctx.logger.warn('could not pause AI after a sign-in failure', { error: String(err) });
    }
  }
  if (rowStarted) {
    try {
      ctx.repos.finishAgentRun(ctx.db, runId, {
        outcome: outcome.kind,
        endedAt: ctx.now(),
        ...(outcome.kind === 'ok' ? { model: outcome.model } : {}),
        ...(usage ? { numTurns: usage.numTurns, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(usage?.rateLimit ? { rateLimit: usage.rateLimit } : {}),
        ...(result !== undefined ? { result } : {}),
        ...(messageOf(outcome) ? { error: messageOf(outcome)! } : {}),
      });
    } catch (err) {
      ctx.logger.error('could not finish the agent run row', { error: String(err), runId });
    }
    audit(ctx, rc, 'agent.run.end', { outcome: outcome.kind, startedAt, ...(outcome.kind === 'error' ? { code: outcome.code ?? null, retryable: outcome.retryable } : {}), ...(usage ? { numTurns: usage.numTurns, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}) });
  }
  return { runId, outcome, ...(result !== undefined ? { result } : {}) };
}
