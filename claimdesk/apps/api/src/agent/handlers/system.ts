// owned by runtime
/**
 * Runtime job handlers and Needs-you resolvers (docs/SUPREME-DESIGN.md §C.2, §C.6, §C.7, §J). Registered by
 * agent/handlers/index.ts (foundation).
 *
 * Jobs (all deterministic, never paused by usage windows):
 *   clocks.refresh     hourly recompute of every open claim's clocks — and the deadline guard's fallback draft
 *                      (payload `{ fallback }`: the standard template drafted with the existing builder, no AI, plus
 *                      Needs-you `ai_paused` with an approve option)
 *   watch.poll         nightly Companies House poll of the watch list
 *   dailylog.compile   the daily log for a London day (§J.2)
 *   retention.cleanup  agent-runs dirs older than 7 days, debug transcripts older than 30 days
 *   notify.dispatch    deliver a notification (in-app, toast; SMS in Phase 2)
 * Resolvers: setup, ai_paused, failure, question.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ClaimStatus, ISODateTime } from '@ccguk/domain';
import type { Actor } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import type { JobHandler, NeedsYouResolver } from '../contracts.js';
import { createNeedsYou, londonDay, londonHhmm } from '../core.js';
import { compileAndStoreDailyLog } from '../dailyLog.js';
import { dispatch, notificationForNeedsYou, type DispatchOptions } from '../../notify/index.js';
import { recomputeClocks } from '../../services/claimView.js';
import { approveDocument, createClaimDocument } from '../../services/documents.js';
import { pollWatchList } from '../../routes/watch.js';

const CLOSED: ReadonlySet<ClaimStatus> = new Set(['settled', 'closed', 'declined']);
const SUPERVISOR: Actor = { userId: 'agent:supervisor' };

/** Recompute and cache clocks for every open claim (the existing hourly job). */
export function refreshAllClocks(ctx: AppContext, actor: Actor): { claims: number; clocks: number; breached: number } {
  const open = ctx.repos.listClaims(ctx.db, { limit: 100_000 }).filter((c) => !CLOSED.has(c.status));
  let clocks = 0;
  let breached = 0;
  for (const c of open) {
    try {
      const derived = recomputeClocks(ctx, c.id);
      clocks += derived.length;
      breached += derived.filter((k) => k.status === 'breached').length;
    } catch (err) {
      ctx.logger.warn('clocks refresh failed for claim', { claimId: c.id, error: String(err) });
    }
  }
  ctx.repos.appendAudit(ctx.db, { actor, action: 'job.clocks_refresh', entity: 'jobs', entityId: 'clocks_refresh', after: { claims: open.length, clocks, breached }, at: ctx.now() });
  return { claims: open.length, clocks, breached };
}

// ---------------------------------------------------------------------------
// Deadline guard fallback (§A.5, §C.6)
// ---------------------------------------------------------------------------

export const fallbackSchema = z.object({
  claimId: z.string().min(1),
  clockKind: z.string().min(1),
  label: z.string(),
  dueAt: z.string().min(1),
  templateId: z.string().nullable(),
  reason: z.enum(['ai_paused', 'review_failed']),
  pausedUntil: z.string().nullable().optional(),
});
export type DeadlineFallback = z.infer<typeof fallbackSchema>;

const fmtLondon = (iso: ISODateTime): string => {
  const day = londonDay(iso);
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y} ${londonHhmm(iso)}`;
};

/** Draft the standard letter for a due clock without AI and ask the owner to approve it. */
export function draftDeadlineFallback(ctx: AppContext, f: DeadlineFallback): { documentId?: string; needsYouId: string; error?: string } {
  let documentId: string | undefined;
  let error: string | undefined;
  if (f.templateId) {
    try {
      const doc = createClaimDocument(ctx, {
        claimId: f.claimId,
        templateId: f.templateId,
        user: { id: 'agent:supervisor', name: 'Claims Team, Courtesy Cars Group UK Ltd', role: 'handler' },
        actor: SUPERVISOR,
      });
      documentId = doc.id;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      ctx.logger.warn('deadline guard: standard letter could not be drafted', { claimId: f.claimId, templateId: f.templateId, error });
    }
  }
  const why = f.reason === 'ai_paused' ? `AI is paused${f.pausedUntil ? ` until ${londonHhmm(f.pausedUntil)}` : ''}` : 'The last agent review of this claim failed';
  const title = documentId ? `${why} — "${f.label}" is due ${fmtLondon(f.dueAt)}; approve the standard letter?` : `${why} — "${f.label}" is due ${fmtLondon(f.dueAt)}`;
  const summary = documentId
    ? `The deadline guard drafted the standard ${f.templateId} letter with the normal template (no AI). Check it and approve it, then send or post it as usual.`
    : `The deadline guard could not prepare a standard letter for this deadline${error ? ` (${error.slice(0, 200)})` : ''}. Please handle it yourself.`;
  const item = createNeedsYou(ctx, {
    kind: 'ai_paused',
    claimId: f.claimId,
    title,
    summary,
    options: documentId
      ? [
          { id: 'approve', label: 'Approve the standard letter', tone: 'primary' },
          { id: 'dismiss', label: 'I will handle it', tone: 'neutral' },
        ]
      : [{ id: 'dismiss', label: 'I will handle it', tone: 'neutral' }],
    payload: { documentId: documentId ?? null, templateId: f.templateId, clockKind: f.clockKind, dueAt: f.dueAt, reason: f.reason, pausedUntil: f.pausedUntil ?? null, draftRefs: documentId ? [{ kind: 'document', id: documentId }] : [] },
    priority: Date.parse(f.dueAt) - Date.parse(ctx.now()) < 4 * 3_600_000 ? 'urgent' : 'high',
    dueAt: new Date(Date.parse(f.dueAt)).toISOString(),
    createdBy: 'agent:supervisor',
    dedupeKey: `deadline_guard:${f.claimId}:${f.clockKind}:${londonDay(new Date(Date.parse(f.dueAt)).toISOString())}`,
  });
  return { ...(documentId ? { documentId } : {}), needsYouId: item.id, ...(error ? { error } : {}) };
}

// ---------------------------------------------------------------------------
// Retention (§K.6)
// ---------------------------------------------------------------------------

export const AGENT_RUN_RETENTION_DAYS = 7;
export const TRANSCRIPT_RETENTION_DAYS = 30;
/** Debug transcripts (when switched on) live beside agent-runs: `<home>/agent-transcripts`. */
export const transcriptsDir = (ctx: AppContext): string => path.join(ctx.config.appHome, 'agent-transcripts');

export function cleanupRetention(ctx: AppContext, now: ISODateTime = ctx.now()): { runDirsRemoved: number; transcriptsRemoved: number } {
  const t = Date.parse(now);
  let runDirsRemoved = 0;
  let transcriptsRemoved = 0;
  const sweep = (dir: string, maxAgeDays: number, onRemove: () => void, keep?: (p: string, ageMs: number) => boolean): void => {
    if (!dir || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        const age = t - statSync(p).mtimeMs;
        if (age <= maxAgeDays * 86_400_000) continue;
        if (keep?.(p, age)) continue;
        rmSync(p, { recursive: true, force: true });
        onRemove();
      } catch (err) {
        ctx.logger.warn('retention: could not remove', { path: p, error: String(err) });
      }
    }
  };
  // A run dir holding a debug transcript is kept for the transcript retention instead.
  const hasTranscript = (p: string): boolean => {
    try {
      return statSync(p).isDirectory() && readdirSync(p).some((f) => f.startsWith('transcript'));
    } catch {
      return false;
    }
  };
  sweep(ctx.config.agentRunsDir, AGENT_RUN_RETENTION_DAYS, () => (runDirsRemoved += 1), (p, age) => age <= TRANSCRIPT_RETENTION_DAYS * 86_400_000 && hasTranscript(p));
  sweep(transcriptsDir(ctx), TRANSCRIPT_RETENTION_DAYS, () => (transcriptsRemoved += 1));
  return { runDirsRemoved, transcriptsRemoved };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Options the notify handler passes to dispatch (tests inject a toast runner via ctx.services.notify). */
const dispatchOptions = (ctx: AppContext): DispatchOptions => ((ctx.services as { notify?: DispatchOptions }).notify ?? {});

const clocksRefresh: JobHandler<{ fallback?: DeadlineFallback }, unknown> = {
  type: 'clocks.refresh',
  agent: 'supervisor',
  lane: 'io',
  usesAi: false,
  mutatesClaim: false,
  payload: z.object({ fallback: fallbackSchema.optional() }).passthrough(),
  defaultPriority: 6,
  maxAttempts: 3,
  timeoutMs: 10 * 60_000,
  async run({ ctx, payload }) {
    if (payload.fallback) return { kind: 'done', result: draftDeadlineFallback(ctx, payload.fallback) };
    return { kind: 'done', result: refreshAllClocks(ctx, ctx.repos.SYSTEM_ACTOR) };
  },
};

const watchPoll: JobHandler<Record<string, unknown>, unknown> = {
  type: 'watch.poll',
  agent: 'supervisor',
  lane: 'io',
  usesAi: false,
  mutatesClaim: false,
  payload: z.object({}).passthrough(),
  defaultPriority: 6,
  maxAttempts: 3,
  timeoutMs: 15 * 60_000,
  async run({ ctx }) {
    return { kind: 'done', result: await pollWatchList(ctx, ctx.repos.SYSTEM_ACTOR) };
  },
};

const dailyLogCompile: JobHandler<{ day?: string }, unknown> = {
  type: 'dailylog.compile',
  agent: 'supervisor',
  lane: 'io',
  usesAi: false,
  mutatesClaim: false,
  payload: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).passthrough(),
  defaultPriority: 5,
  maxAttempts: 3,
  timeoutMs: 5 * 60_000,
  async run({ ctx, payload }) {
    const log = compileAndStoreDailyLog(ctx, payload.day ?? londonDay(ctx.now()));
    return { kind: 'done', result: { day: log.day, headline: log.headline } };
  },
};

const retentionCleanup: JobHandler<Record<string, unknown>, unknown> = {
  type: 'retention.cleanup',
  agent: 'supervisor',
  lane: 'io',
  usesAi: false,
  mutatesClaim: false,
  payload: z.object({}).passthrough(),
  defaultPriority: 8,
  maxAttempts: 2,
  timeoutMs: 10 * 60_000,
  async run({ ctx }) {
    return { kind: 'done', result: cleanupRetention(ctx) };
  },
};

const notifyDispatch: JobHandler<{ needsYouId?: string; notificationId?: string }, unknown> = {
  type: 'notify.dispatch',
  agent: 'supervisor',
  lane: 'io',
  usesAi: false,
  mutatesClaim: false,
  payload: z.object({ needsYouId: z.string().optional(), notificationId: z.string().optional() }).passthrough(),
  defaultPriority: 1,
  maxAttempts: 3,
  timeoutMs: 60_000,
  async run({ ctx, payload }) {
    let id = payload.notificationId;
    if (!id && payload.needsYouId) id = notificationForNeedsYou(ctx, payload.needsYouId)?.id;
    if (!id) return { kind: 'fail', reason: 'nothing to notify (unknown Needs-you item or notification)' };
    const res = await dispatch(ctx, id, dispatchOptions(ctx));
    const failed = res.deliveries.filter((d) => !d.ok);
    // A toast failure is not worth retrying forever: the in-app row is already there. Retry once, then accept.
    if (failed.length && failed.some((d) => d.channel !== 'toast')) return { kind: 'retry', afterMs: 60_000, reason: failed.map((d) => `${d.channel}: ${d.error ?? d.status}`).join('; ') };
    return { kind: 'done', result: res };
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each handler has its own payload/result types
export const systemJobHandlers: JobHandler<any, any>[] = [clocksRefresh, watchPoll, dailyLogCompile, retentionCleanup, notifyDispatch];

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

const setupResolver: NeedsYouResolver<{ resumeAi?: boolean }> = {
  kind: 'setup',
  async resolve(ctx, item, choice, actor) {
    if (choice.optionId === 'dismiss') return;
    // "I've fixed it": lift a sign-in / setup pause so the next tick tries again.
    const usage = ctx.repos.getAiUsageState(ctx.db);
    const now = ctx.now();
    if (usage.pausedUntil && /auth|setup|sign/i.test(usage.pauseReason ?? '')) {
      ctx.repos.unpauseAi(ctx.db, now);
      ctx.repos.appendAudit(ctx.db, { actor, action: 'ai.resume', entity: 'ai_usage_state', entityId: 'default', before: { pausedUntil: usage.pausedUntil, pauseReason: usage.pauseReason ?? null }, at: now });
    }
    // The jobs the sign-in failure stopped run again now: those waiting on the pause, and (belt and braces) any that
    // failed with a sign-in error since the item was raised.
    const since = item.createdAt ? new Date(Date.parse(item.createdAt) - 24 * 60 * 60_000).toISOString() : undefined;
    const resumed: string[] = [];
    for (const j of ctx.repos.listAgentJobs(ctx.db, { status: 'waiting_usage', limit: 1000 })) {
      if (!/sign-in/i.test(j.error ?? '')) continue;
      ctx.repos.resumeAgentJob(ctx.db, j.id, { now });
      resumed.push(j.id);
    }
    for (const j of ctx.repos.listAgentJobs(ctx.db, { status: 'failed', limit: 1000 })) {
      if (!(j.error ?? '').startsWith('AI sign-in failed') || (since && j.updatedAt < since)) continue;
      ctx.repos.resumeAgentJob(ctx.db, j.id, { resetAttempts: true, now });
      resumed.push(j.id);
    }
    if (resumed.length) ctx.repos.appendAudit(ctx.db, { actor, action: 'agents.job.retry', entity: 'agent_jobs', entityId: resumed[0]!, after: { jobIds: resumed, reason: 'AI sign-in fixed', needsYouId: item.id }, at: now });
  },
};

const aiPausedResolver: NeedsYouResolver<{ documentId?: string | null }> = {
  kind: 'ai_paused',
  async resolve(ctx, item, choice, actor) {
    if (choice.optionId !== 'approve') return;
    const documentId = item.payload?.documentId;
    if (!documentId) return;
    // As the owner: the human-only approval check passes and the audit shows the owner.
    await approveDocument(ctx, documentId, actor, choice.note ?? 'Approved the standard letter while AI was paused (deadline guard)');
  },
};

const failureResolver: NeedsYouResolver<{ jobId?: string }> = {
  kind: 'failure',
  async resolve(ctx, item, choice, actor) {
    if (choice.optionId !== 'retry') return;
    const jobId = item.payload?.jobId;
    if (!jobId || !ctx.repos.getAgentJob(ctx.db, jobId)) return;
    const job = ctx.repos.resumeAgentJob(ctx.db, jobId, { resetAttempts: true, now: ctx.now() });
    ctx.repos.appendAudit(ctx.db, { actor, action: 'agents.job.retry', entity: 'agent_jobs', entityId: jobId, after: { status: job.status, needsYouId: item.id }, at: ctx.now() });
  },
};

const questionResolver: NeedsYouResolver<unknown> = {
  kind: 'question',
  // The owner's answer is stored on the item (resolution) and the waiting job is re-queued by the generic resolve.
  async resolve() {},
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each resolver has its own payload type
export const systemNeedsYouResolvers: NeedsYouResolver<any>[] = [setupResolver, aiPausedResolver, failureResolver, questionResolver];
