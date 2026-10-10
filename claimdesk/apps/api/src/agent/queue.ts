// owned by runtime
/**
 * Queue runtime helpers (docs/SUPREME-DESIGN.md §C.3, §C.4): lane gates, effective concurrency, leasing with per-agent
 * caps, follow-up enqueueing and the dead-letter → Needs-you `failure` path. Persistence is the foundation's
 * `agentJobs` repo; enqueue/createNeedsYou come from `agent/core.ts`. The worker (worker.ts) runs what is leased here.
 */
import type { AgentName, ISODateTime, Lane } from '@ccguk/domain';
import { LANES } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { EnqueueInput, JobHandler, JobRecord, NeedsYouItem } from './contracts.js';
import { createNeedsYou, enqueueJob } from './core.js';
import { ALL_PRIORITIES, laneLimits, type LaneLimits } from './budgets.js';
import type { AgentSettingsRecord } from '@ccguk/db';
import { selectedDriver, type DriverChoice } from '../ai/driverFactory.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous handler registry
export type AnyJobHandler = JobHandler<any, any>;

export interface LaneGate {
  open: boolean;
  /** Highest priority number allowed to start on this lane. */
  maxPriority: number;
  /** Why the lane is closed or narrowed (for /agents/status). */
  reason?: string;
}

/** What may be leased right now (computed by the supervisor each tick, §C.6). */
export interface LaneGates {
  lanes: Record<Lane, LaneGate>;
  pausedAgents: string[];
  pausedClaims: string[];
  killSwitch: boolean;
}

/** Everything open, nothing paused (tests and the first tick before the supervisor computed anything). */
export function openGates(): LaneGates {
  return {
    lanes: { ai: { open: true, maxPriority: ALL_PRIORITIES }, io: { open: true, maxPriority: ALL_PRIORITIES }, cpu: { open: true, maxPriority: ALL_PRIORITIES } },
    pausedAgents: [],
    pausedClaims: [],
    killSwitch: false,
  };
}

/** Effective lane concurrency and per-agent caps from agent_settings. */
/**
 * Agent settings with `ai.driver` as this process actually runs it. AI_DRIVER (config.aiDriverOverride) wins over
 * Settings > AI — the rule the gateway uses to pick the driver (driverFactory.selectedDriver) — so the lanes, gates and
 * status agree with the driver runAgent will use. The fake driver (CI, scenario runs) runs like the subscription.
 */
export function effectiveAgentSettings(ctx: AppContext): AgentSettingsRecord & { driverChoice: DriverChoice } {
  const s = ctx.repos.getAgentSettings(ctx.db);
  const driverChoice = selectedDriver(ctx);
  const driver = driverChoice === 'fake' ? 'subscription_cli' : driverChoice;
  return { ...s, ai: { ...s.ai, driver }, driverChoice };
}

export function currentLaneLimits(ctx: AppContext): LaneLimits {
  return laneLimits(effectiveAgentSettings(ctx));
}

/** Default handler timeout when a job type has no handler (lease length only). */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Lease length per lane: twice the longest handler timeout on that lane (§C.3). */
export function leaseMsForLane(handlers: readonly AnyJobHandler[], lane: Lane): number {
  const max = handlers.filter((h) => h.lane === lane).reduce((m, h) => Math.max(m, h.timeoutMs || 0), 0);
  return 2 * (max || DEFAULT_TIMEOUT_MS);
}

export interface LeaseNextInput {
  lane: Lane;
  owner: string;
  now: ISODateTime;
  gates: LaneGates;
  leaseMs: number;
  /** Agents at their concurrency cap (excluded in addition to paused agents). */
  excludeAgents?: readonly string[];
}

/** Lease the next ready job of a lane under the gates (claim lock + pauses are in the lease query). */
export function leaseNext(ctx: AppContext, input: LeaseNextInput): JobRecord | undefined {
  const gate = input.gates.lanes[input.lane];
  if (!gate.open || gate.maxPriority < 0) return undefined;
  const job = ctx.repos.leaseAgentJob(ctx.db, {
    lane: input.lane,
    maxPriority: gate.maxPriority,
    now: input.now,
    owner: input.owner,
    leaseMs: input.leaseMs,
    pausedAgents: [...new Set([...input.gates.pausedAgents, ...(input.excludeAgents ?? [])])],
    pausedClaims: input.gates.pausedClaims,
  });
  return job as JobRecord | undefined;
}

/** Enqueue a finished job's follow-ups: parent correlation id, depth + 1 (the loop guard lives in enqueueJob). */
export function enqueueFollowUps(ctx: AppContext, parent: JobRecord, followUps: readonly EnqueueInput[] | undefined): JobRecord[] {
  const out: JobRecord[] = [];
  for (const f of followUps ?? []) {
    out.push(enqueueJob(ctx, { ...f, parentJobId: parent.id, correlationId: parent.correlationId, createdBy: f.createdBy || `job:${parent.id}` }));
  }
  return out;
}

const TYPE_LABEL = (t: string): string => t.replace(/[._]/g, ' ');

/** Needs-you `failure` for a dead-lettered job (one open item per job). */
export function raiseJobFailure(ctx: AppContext, job: Pick<JobRecord, 'id' | 'type' | 'claimId' | 'correlationId' | 'attempts' | 'agent'>, reason: string): NeedsYouItem {
  return createNeedsYou(ctx, {
    kind: 'failure',
    claimId: job.claimId,
    title: `An agent job failed: ${TYPE_LABEL(job.type)}`,
    summary: `The ${TYPE_LABEL(job.type)} job stopped after ${job.attempts} attempt${job.attempts === 1 ? '' : 's'}: ${reason.slice(0, 400)}. Nothing further was done for it. Retry it, or handle the work yourself and dismiss this.`,
    options: [
      { id: 'retry', label: 'Retry the job', tone: 'primary' },
      { id: 'dismiss', label: 'Dismiss — I will handle it', tone: 'neutral' },
    ],
    payload: { jobId: job.id, type: job.type, agent: job.agent, error: reason.slice(0, 2000), attempts: job.attempts },
    priority: 'high',
    createdBy: 'agent:supervisor',
    dedupeKey: `job_failure:${job.id}`,
    correlationId: job.correlationId,
  });
}

/** One open Needs-you per job type whose handler is not registered (wiring problem, not per job). */
export function raiseMissingHandler(ctx: AppContext, job: JobRecord): NeedsYouItem {
  return createNeedsYou(ctx, {
    kind: 'failure',
    title: `No handler is installed for ${TYPE_LABEL(job.type)} jobs`,
    summary: `A ${TYPE_LABEL(job.type)} job was queued but this version of ClaimDesk has no handler for it, so it was stopped. Please report this; you can dismiss it once ClaimDesk is updated.`,
    options: [{ id: 'dismiss', label: 'Dismiss', tone: 'neutral' }],
    payload: { jobId: job.id, type: job.type },
    priority: 'normal',
    createdBy: 'agent:supervisor',
    dedupeKey: `no_handler:${job.type}`,
  });
}

/** Lanes in leasing order. */
export const LANE_ORDER: readonly Lane[] = LANES;

/** Agents at or over their cap given the running counts. */
export function agentsAtCap(caps: Partial<Record<AgentName | 'system', number>>, running: ReadonlyMap<string, number>): string[] {
  const out: string[] = [];
  for (const [agent, cap] of Object.entries(caps)) if (typeof cap === 'number' && (running.get(agent) ?? 0) >= cap) out.push(agent);
  return out;
}
