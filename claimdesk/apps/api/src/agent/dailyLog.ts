// owned by runtime
/**
 * The daily log (docs/SUPREME-DESIGN.md §J.2): a deterministic query over what the agents did on one London day —
 * `audit_log` rows written by `agent:*`, `agent_runs`, `outbox_events` (when the mail tables have rows), `needs_you`,
 * tasks and clocks. Compiled at 18:00 London by `dailylog.compile` and on demand; stored in `daily_logs`.
 * The headline is built by code; the optional AI paragraph (`dailylog.narrate`) is off by default and not used here.
 */
import { londonWallToUtc, type AgentName, type ISODateTime } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { DriverKind } from '../ai/types.js';
import { londonDay } from './core.js';

export interface LogLine {
  at: ISODateTime;
  claimId?: string;
  reference?: string;
  agent: AgentName;
  text: string;
  why?: string;
  ruleIds?: string[];
  link: string;
}

export interface DailyLog {
  day: string;
  generatedAt: ISODateTime;
  headline: string;
  counts: {
    emailsIn: number; emailsSent: number; autoSent: number; undone: number; drafts: number; fieldsPrefilled: number;
    needsYouOpened: number; needsYouResolved: number; tasksDone: number; deadlinesMet: number; deadlinesAtRisk: number;
    aiRuns: number; aiFailures: number; usagePausedMinutes: number;
  };
  sections: {
    sentAutomatically: LogLine[];
    waitingForYou: LogLine[];
    updatedRecords: LogLine[];
    deadlines: LogLine[];
    problems: LogLine[];
    usage: { driver: DriverKind | 'off'; fiveHourPeak?: number; sevenDay?: number; costUsd?: number };
  };
}

/** [start, end) of a London calendar day as UTC ISO instants. */
export function londonDayBounds(day: string): { start: ISODateTime; end: ISODateTime } {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  if (!y || !m || !d) throw new Error(`invalid day ${day}`);
  const start = new Date(londonWallToUtc(Date.UTC(y, m - 1, d))).toISOString();
  const end = new Date(londonWallToUtc(Date.UTC(y, m - 1, d + 1))).toISOString();
  return { start, end };
}

const AGENT_NAMES = new Set<string>(['intake', 'mail', 'case_manager', 'drafter', 'reviewer', 'researcher', 'supervisor', 'engineer', 'calls', 'critic', 'judge']);
const agentOf = (userId: string | null | undefined): AgentName => {
  const n = (userId ?? '').replace(/^agent:/, '');
  return (AGENT_NAMES.has(n) ? n : 'supervisor') as AgentName;
};

const parse = (s: string | null | undefined): unknown => {
  if (s === null || s === undefined) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);

interface AuditRow {
  id: string;
  at: string;
  user_id: string;
  action: string;
  entity: string;
  entity_id: string;
  before: string | null;
  after: string | null;
  run_id: string | null;
}

/** Audit actions that are bookkeeping, not record updates. */
const NOT_RECORD_UPDATE = /^(agent\.|needs_you\.|ai\.|job\.|email\.send|notifications?\.)/;
const DRAFT_ACTION = /(^document\.(create|generate|draft)|^docx[._-]?document\.(create|generate)|^outbox\.(draft|create)|^email\.draft)/;
const PREFILL_ACTION = /(proposal\.apply|^vehicle\.update|^party\.update|^claim\.update|field\.apply|^intake\.apply)/;

export function compileDailyLog(ctx: AppContext, day: string): DailyLog {
  const { start, end } = londonDayBounds(day);
  const sqlite = ctx.handle.sqlite;
  const now = ctx.now();
  const hasTable = (t: string): boolean => Boolean(sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t));
  const refs = new Map<string, string | undefined>();
  const refOf = (claimId: string | null | undefined): string | undefined => {
    if (!claimId) return undefined;
    if (!refs.has(claimId)) refs.set(claimId, ctx.repos.getClaim(ctx.db, claimId)?.reference);
    return refs.get(claimId);
  };
  const line = (l: Omit<LogLine, 'reference' | 'claimId'> & { claimId?: string | null }): LogLine => {
    const { claimId, ...rest } = l;
    const reference = refOf(claimId ?? undefined);
    return { ...rest, ...(claimId ? { claimId } : {}), ...(reference ? { reference } : {}) };
  };

  // --- agent audit rows -------------------------------------------------------------------------
  const audit = sqlite.prepare(`SELECT id, at, user_id, action, entity, entity_id, before, after, run_id FROM audit_log WHERE user_id LIKE 'agent:%' AND at >= ? AND at < ? ORDER BY at, rowid`).all(start, end) as AuditRow[];
  const claimOfAudit = (r: AuditRow): string | undefined => {
    const after = parse(r.after) as { claimId?: unknown } | undefined;
    if (after && typeof after.claimId === 'string') return after.claimId;
    if (r.entity === 'claims') return r.entity_id;
    return undefined;
  };
  const policyByRun = new Map<string, { ruleIds: string[]; reasons: string[] }>();
  for (const r of audit) {
    if (r.action !== 'agent.policy' || !r.run_id) continue;
    const a = parse(r.after) as { ruleIds?: string[]; reasons?: string[] } | undefined;
    policyByRun.set(r.run_id, { ruleIds: a?.ruleIds ?? [], reasons: a?.reasons ?? [] });
  }
  const updatedRecords: LogLine[] = [];
  let drafts = 0;
  let fieldsPrefilled = 0;
  for (const r of audit) {
    if (DRAFT_ACTION.test(r.action)) drafts += 1;
    if (PREFILL_ACTION.test(r.action)) fieldsPrefilled += 1;
    if (NOT_RECORD_UPDATE.test(r.action)) continue;
    const policy = r.run_id ? policyByRun.get(r.run_id) : undefined;
    const claimId = claimOfAudit(r);
    updatedRecords.push(
      line({
        at: r.at,
        claimId,
        agent: agentOf(r.user_id),
        text: `${r.action.replace(/[._]/g, ' ')} (${r.entity})`,
        ...(policy?.reasons.length ? { why: policy.reasons.join('; ') } : {}),
        ...(policy?.ruleIds.length ? { ruleIds: policy.ruleIds } : {}),
        link: claimId ? `/claims/${claimId}` : r.run_id ? `/agents?run=${r.run_id}` : '/agents',
      }),
    );
  }

  // --- runs ---------------------------------------------------------------------------------------
  const runs = sqlite.prepare(`SELECT id, agent, job_type, claim_id, driver, outcome, cost_usd, rate_limit, error, started_at FROM agent_runs WHERE started_at >= ? AND started_at < ? ORDER BY started_at`).all(start, end) as Array<{
    id: string; agent: string; job_type: string; claim_id: string | null; driver: string; outcome: string | null; cost_usd: number | null; rate_limit: string | null; error: string | null; started_at: string;
  }>;
  const failedRuns = runs.filter((r) => r.outcome !== null && r.outcome !== 'ok');
  let fiveHourPeak: number | undefined;
  let costUsd = 0;
  for (const r of runs) {
    costUsd += n(r.cost_usd);
    const rl = parse(r.rate_limit) as { utilization?: number; type?: string } | undefined;
    if (rl && typeof rl.utilization === 'number' && (!rl.type || rl.type === 'five_hour')) fiveHourPeak = Math.max(fiveHourPeak ?? 0, rl.utilization);
  }

  // --- outbox ---------------------------------------------------------------------------------------
  const sentAutomatically: LogLine[] = [];
  let emailsSent = 0;
  let autoSent = 0;
  let undone = 0;
  if (hasTable('outbox_events') && hasTable('outbox')) {
    const sent = sqlite
      .prepare(
        `SELECT e.outbox_id, e.at, e.actor, o.claim_id, o.kind, o.to_json, o.policy, o.approved_by, o.created_by, o.subject FROM outbox_events e JOIN outbox o ON o.id = e.outbox_id
         WHERE e.to_status = 'sent' AND e.at >= ? AND e.at < ? ORDER BY e.at`,
      )
      .all(start, end) as Array<{ outbox_id: string; at: string; actor: string; claim_id: string | null; kind: string; to_json: string; policy: string | null; approved_by: string | null; created_by: string; subject: string }>;
    emailsSent = sent.length;
    for (const s of sent) {
      const policy = parse(s.policy) as { outcome?: string; ruleIds?: string[]; reasons?: string[] } | undefined;
      if (policy?.outcome !== 'auto_held' || s.approved_by) continue;
      autoSent += 1;
      const to = (parse(s.to_json) as string[] | undefined) ?? [];
      sentAutomatically.push(
        line({
          at: s.at,
          claimId: s.claim_id,
          agent: agentOf(s.created_by.startsWith('agent:') ? s.created_by : 'agent:mail'),
          text: `Sent ${s.kind.replace(/_/g, ' ')} to ${to.join(', ') || 'recipient'}`,
          ...(policy.reasons?.length ? { why: policy.reasons.join('; ') } : {}),
          ...(policy.ruleIds?.length ? { ruleIds: policy.ruleIds } : {}),
          link: `/outbox/${s.outbox_id}`,
        }),
      );
    }
    const u = sqlite.prepare(`SELECT count(*) AS c FROM outbox_events WHERE from_status = 'held' AND to_status = 'cancelled' AND at >= ? AND at < ?`).get(start, end) as { c: number };
    undone = n(u?.c);
  }
  let emailsIn = 0;
  if (hasTable('mail_messages')) {
    const r = sqlite.prepare(`SELECT count(*) AS c FROM mail_messages WHERE direction = 'in' AND created_at >= ? AND created_at < ?`).get(start, end) as { c: number };
    emailsIn = n(r?.c);
  }

  // --- Needs-you ------------------------------------------------------------------------------------
  const opened = sqlite.prepare(`SELECT count(*) AS c FROM needs_you WHERE created_at >= ? AND created_at < ?`).get(start, end) as { c: number };
  const resolvedCount = sqlite.prepare(`SELECT count(*) AS c FROM needs_you WHERE status = 'resolved' AND resolved_at >= ? AND resolved_at < ?`).get(start, end) as { c: number };
  const waiting = sqlite
    .prepare(`SELECT id, kind, claim_id, title, priority, created_at, created_by FROM needs_you WHERE status IN ('open','snoozed') AND created_at < ? ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at LIMIT 200`)
    .all(end) as Array<{ id: string; kind: string; claim_id: string | null; title: string; priority: string; created_at: string; created_by: string }>;
  const waitingForYou = waiting.map((w) =>
    line({ at: w.created_at, claimId: w.claim_id, agent: agentOf(w.created_by), text: w.title, why: `${w.kind.replace(/_/g, ' ')} · ${w.priority}`, link: `/needs-you/${w.id}` }),
  );

  // --- tasks -----------------------------------------------------------------------------------------
  const tasksDone = n((sqlite.prepare(`SELECT count(*) AS c FROM tasks WHERE status = 'done' AND completed_at >= ? AND completed_at < ?`).get(start, end) as { c: number })?.c);

  // --- deadlines ---------------------------------------------------------------------------------------
  // Clock instants carry offsets (+01:00), so compare parsed instants, not strings.
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const horizonMs = endMs + 24 * 3_600_000;
  const clocks = (
    sqlite.prepare(`SELECT id, claim_id, kind, label, due_at, status, met_at FROM clocks WHERE status IN ('met','running','breached')`).all() as Array<{
      id: string; claim_id: string; kind: string; label: string; due_at: string; status: string; met_at: string | null;
    }>
  )
    .filter((c) => (c.status === 'met' ? c.met_at !== null && Date.parse(c.met_at) >= startMs && Date.parse(c.met_at) < endMs : Date.parse(c.due_at) < horizonMs))
    .sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
  const deadlines: LogLine[] = [];
  let deadlinesMet = 0;
  let deadlinesAtRisk = 0;
  for (const c of clocks) {
    if (c.status === 'met') deadlinesMet += 1;
    else deadlinesAtRisk += 1;
    deadlines.push(
      line({
        at: c.status === 'met' ? (c.met_at ?? c.due_at) : c.due_at,
        claimId: c.claim_id,
        agent: 'case_manager',
        text: c.status === 'met' ? `Met: ${c.label}` : c.status === 'breached' ? `Overdue: ${c.label}` : `Due soon: ${c.label}`,
        why: c.kind,
        link: `/claims/${c.claim_id}/clocks`,
      }),
    );
  }

  // --- problems ------------------------------------------------------------------------------------------
  const problems: LogLine[] = [];
  for (const r of failedRuns) {
    problems.push(line({ at: r.started_at, claimId: r.claim_id, agent: agentOf(`agent:${r.agent}`), text: `${r.job_type} run ended: ${r.outcome}`, ...(r.error ? { why: r.error.slice(0, 200) } : {}), link: `/agents?run=${r.id}` }));
  }
  const dead = sqlite.prepare(`SELECT id, type, agent, claim_id, error, finished_at FROM agent_jobs WHERE status = 'dead' AND finished_at >= ? AND finished_at < ? ORDER BY finished_at`).all(start, end) as Array<{
    id: string; type: string; agent: string; claim_id: string | null; error: string | null; finished_at: string;
  }>;
  for (const j of dead) problems.push(line({ at: j.finished_at, claimId: j.claim_id, agent: agentOf(`agent:${j.agent}`), text: `${j.type} job stopped`, ...(j.error ? { why: j.error.slice(0, 200) } : {}), link: `/agents?job=${j.id}` }));
  for (const r of audit.filter((a) => a.action === 'agent.tool.denied')) {
    const a = parse(r.after) as { rule?: string; tool?: string; message?: string } | undefined;
    problems.push(line({ at: r.at, claimId: claimOfAudit(r), agent: agentOf(r.user_id), text: `Refused: ${a?.tool ?? r.entity}`, ...(a?.message ? { why: a.message } : {}), ...(a?.rule ? { ruleIds: [a.rule] } : {}), link: r.run_id ? `/agents?run=${r.run_id}` : '/agents' }));
  }
  problems.sort((a, b) => a.at.localeCompare(b.at));

  // --- usage pauses (audited by the supervisor/worker as ai.pause) ------------------------------------------
  const pauses = sqlite.prepare(`SELECT at, after FROM audit_log WHERE action = 'ai.pause' AND at < ? ORDER BY at`).all(end) as Array<{ at: string; after: string | null }>;
  let pausedMs = 0;
  let coveredUntil = Date.parse(start);
  for (const p of pauses) {
    const until = (parse(p.after) as { until?: string } | undefined)?.until;
    if (!until) continue;
    const from = Math.max(Date.parse(p.at), coveredUntil, Date.parse(start));
    const to = Math.min(Date.parse(until), Date.parse(end), Date.parse(now));
    if (to > from) {
      pausedMs += to - from;
      coveredUntil = to;
    }
  }

  const settings = ctx.repos.getAgentSettings(ctx.db);
  const usageState = ctx.repos.getAiUsageState(ctx.db);
  const seven = usageState.sevenDay as { utilization?: number } | undefined;
  const driver = (settings.ai.driver === 'off' ? (runs[0]?.driver as DriverKind | undefined) ?? 'off' : settings.ai.driver) as DriverKind | 'off';

  const counts: DailyLog['counts'] = {
    emailsIn,
    emailsSent,
    autoSent,
    undone,
    drafts,
    fieldsPrefilled,
    needsYouOpened: n(opened?.c),
    needsYouResolved: n(resolvedCount?.c),
    tasksDone,
    deadlinesMet,
    deadlinesAtRisk,
    aiRuns: runs.length,
    aiFailures: failedRuns.length,
    usagePausedMinutes: Math.round(pausedMs / 60_000),
  };
  return {
    day,
    generatedAt: now,
    headline: dailyHeadline(counts, waitingForYou.length),
    counts,
    sections: {
      sentAutomatically,
      waitingForYou,
      updatedRecords,
      deadlines,
      problems,
      usage: { driver, ...(fiveHourPeak !== undefined ? { fiveHourPeak } : {}), ...(typeof seven?.utilization === 'number' ? { sevenDay: seven.utilization } : {}), ...(costUsd > 0 ? { costUsd: Math.round(costUsd * 100) / 100 } : {}) },
    },
  };
}

const plural = (k: number, one: string, many = `${one}s`): string => `${k} ${k === 1 ? one : many}`;

/** Deterministic one-paragraph headline. */
export function dailyHeadline(c: DailyLog['counts'], waiting: number): string {
  const parts: string[] = [];
  if (c.autoSent) parts.push(`sent ${plural(c.autoSent, 'email')} automatically${c.undone ? ` (${c.undone} undone)` : ''}`);
  if (c.drafts) parts.push(`prepared ${plural(c.drafts, 'draft')}`);
  if (c.fieldsPrefilled) parts.push(`filled in ${plural(c.fieldsPrefilled, 'detail')}`);
  if (c.emailsIn) parts.push(`filed ${plural(c.emailsIn, 'incoming email')}`);
  const did = parts.length ? `The agents ${parts.join(', ')}.` : 'The agents had nothing to do automatically today.';
  const need = waiting ? ` ${plural(waiting, 'item')} ${waiting === 1 ? 'needs' : 'need'} you.` : ' Nothing is waiting for you.';
  const risk = c.deadlinesAtRisk ? ` ${plural(c.deadlinesAtRisk, 'deadline')} due soon or overdue.` : '';
  const problems = c.aiFailures ? ` ${plural(c.aiFailures, 'agent run')} did not finish.` : '';
  const paused = c.usagePausedMinutes ? ` AI was paused for ${c.usagePausedMinutes} min.` : '';
  return `${did}${need}${risk}${problems}${paused}`.trim();
}

/** Compile and store (upsert) the log for `day`. */
export function compileAndStoreDailyLog(ctx: AppContext, day: string = londonDay(ctx.now())): DailyLog {
  const log = compileDailyLog(ctx, day);
  ctx.repos.upsertDailyLog(ctx.db, { day, log, compiledAt: log.generatedAt });
  return log;
}
