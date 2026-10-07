// owned by runtime
/**
 * Agents control room, daily log, autonomy / notification settings, notifications and tasks client
 * (docs/SUPREME-DESIGN.md §L.1, §L.3, §L.4, §L.7, §N.6 runtime row). Shapes mirror apps/api/src/routes/{agents,
 * dailyLog,autonomySettings,notifications,tasks}.ts; web code never imports API code.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentName, AutonomySettings, EmailKind, JobStatus, JobType, Lane, NotificationSettings } from '@ccguk/domain';
import { request, seg } from './client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentsPillState = 'running' | 'paused' | 'stopped' | 'off';

export interface RateLimitSnapshot {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  type?: string;
  utilization?: number;
  resetsAt?: string;
}

export interface RunningJob {
  jobId: string;
  type: JobType;
  agent: string;
  lane: Lane;
  claimId?: string;
  attempt: number;
  startedAt: string;
  elapsedMs: number;
}

export interface AgentCard {
  name: AgentName;
  paused: boolean;
  running: RunningJob[];
  queued: number;
  waitingForYou: number;
  cap: number | null;
  lastRuns: Array<{ id: string; jobType: JobType; claimId: string | null; outcome: string | null; startedAt: string; endedAt: string | null }>;
  successRate: number | null;
  avgDurationMs: number | null;
}

export interface AgentsStatus {
  at: string;
  pill: { state: AgentsPillState; label: string };
  jobsEnabled: boolean;
  enabled: boolean;
  driver: string;
  killSwitch: boolean;
  usage: {
    pausedUntil: string | null;
    pauseReason: string | null;
    fiveHour: RateLimitSnapshot | null;
    sevenDay: RateLimitSnapshot | null;
    economy: boolean;
    gate: { maxPriority: number; reason: string };
    costTodayUsd: number;
    dailyUsdCap: number;
    reservePercent: number;
  };
  lanes: Record<Lane, { busy: number; limit: number; open: boolean; reason: string | null }>;
  queue: { queued: number; waitingUsage: number; waitingUser: number; dead: number };
  agents: AgentCard[];
  pausedClaims: number;
  heartbeat: { at: string; started: number; dead: number; requeued: number; registryProblems: string[] } | null;
}

export interface AgentJob {
  id: string;
  type: JobType;
  agent: AgentName | 'system';
  claimId?: string;
  payload: unknown;
  status: JobStatus;
  lane: Lane;
  mutates: boolean;
  priority: number;
  runAfter: string;
  attempts: number;
  maxAttempts: number;
  idempotencyKey?: string;
  parentJobId?: string;
  correlationId: string;
  depth: number;
  result?: unknown;
  error?: string;
  needsYouId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface AgentJobAttempt {
  id: string;
  jobId: string;
  attempt: number;
  startedAt: string;
  finishedAt?: string;
  outcome: string;
  error?: string;
  runId?: string;
}

export interface AgentRun {
  id: string;
  jobId: string;
  agent: AgentName;
  jobType: JobType;
  claimId?: string;
  driver: string;
  model: string;
  effort: string;
  promptVersion: string;
  startedAt: string;
  endedAt?: string;
  outcome?: string;
  numTurns?: number;
  toolCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  rateLimit?: unknown;
  result?: unknown;
  error?: string;
}

export interface AgentToolCall {
  id: string;
  runId: string;
  seq: number;
  tool: string;
  actionClass: string;
  decision: 'allowed' | 'asked' | 'denied' | 'invalid' | 'error';
  ruleIds?: string[];
  inputRedacted?: unknown;
  outputSummary?: string;
  httpStatus?: number;
  needsYouId?: string;
  durationMs?: number;
  at: string;
}

export interface AgentSchedule {
  id: string;
  jobType: JobType;
  payload?: unknown;
  everyMinutes?: number;
  atLocal?: string;
  weekdays?: number[];
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string;
  lastJobId?: string;
  updatedAt: string;
}

export interface LogLine {
  at: string;
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
  generatedAt: string;
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
    usage: { driver: string; fiveHourPeak?: number; sevenDay?: number; costUsd?: number };
  };
}

export interface DailyLogResponse {
  day: string;
  stored: boolean;
  compiledAt: string;
  log: DailyLog;
}

export interface AutonomyResponse {
  settings: AutonomySettings;
  defaults: AutonomySettings;
  alwaysAsk: { templates: string[]; emailKinds: EmailKind[]; classes: string[]; deny: string[] };
  emailKinds: EmailKind[];
  templates: Array<{ id: string; title: string; kind: string; alwaysAsk: boolean }>;
}

export type AutonomyPatch = Partial<Omit<AutonomySettings, 'thresholds' | 'limits'>> & {
  thresholds?: Partial<AutonomySettings['thresholds']>;
  limits?: Partial<AutonomySettings['limits']>;
};

export interface NotificationRow {
  id: string;
  needsYouId?: string;
  level: string;
  title: string;
  body: string;
  link?: string;
  channels: string[];
  deliveries: Array<{ channel: string; at: string; ok: boolean; error?: string }>;
  createdAt: string;
  readAt?: string;
}

export interface NotificationTestResult {
  notification: NotificationRow;
  result: { notificationId: string; deliveries: Array<{ channel: string; ok: boolean; status: string; error?: string }> };
  platform: string;
}

export interface TaskRow {
  id: string;
  claimId: string;
  claimReference: string | null;
  kind: string;
  title: string;
  note?: string;
  actionCode?: string;
  dueAt: string;
  status: 'open' | 'done' | 'cancelled';
  createdBy: string;
  createdAt: string;
  completedBy?: string;
  completedAt?: string;
}

export interface JobFilters {
  status?: JobStatus | '';
  type?: JobType | '';
  claimId?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export const agentsApi = {
  status: () => request<AgentsStatus>('/agents/status'),
  killSwitch: (on: boolean, reason?: string) => request<AgentsStatus>('/agents/kill-switch', { method: 'POST', body: { on, ...(reason ? { reason } : {}) } }),
  pauseAgent: (name: AgentName, reason?: string) => request<AgentsStatus>(`/agents/${seg(name)}/pause`, { method: 'POST', body: reason ? { reason } : {} }),
  resumeAgent: (name: AgentName) => request<AgentsStatus>(`/agents/${seg(name)}/resume`, { method: 'POST', body: {} }),
  jobs: (f: JobFilters = {}) => request<{ items: AgentJob[]; total: number }>('/agents/jobs', { query: { status: f.status || undefined, type: f.type || undefined, claimId: f.claimId || undefined, limit: f.limit ?? 100 } }),
  job: (id: string) => request<{ job: AgentJob; attempts: AgentJobAttempt[]; runs: AgentRun[]; children: AgentJob[] }>(`/agents/jobs/${seg(id)}`),
  retryJob: (id: string) => request<AgentJob>(`/agents/jobs/${seg(id)}/retry`, { method: 'POST', body: {} }),
  cancelJob: (id: string) => request<AgentJob>(`/agents/jobs/${seg(id)}/cancel`, { method: 'POST', body: {} }),
  runs: (f: { agent?: AgentName | ''; claimId?: string; limit?: number } = {}) => request<{ items: AgentRun[] }>('/agents/runs', { query: { agent: f.agent || undefined, claimId: f.claimId || undefined, limit: f.limit ?? 100 } }),
  run: (id: string) => request<{ run: AgentRun; toolCalls: AgentToolCall[]; job: AgentJob | null }>(`/agents/runs/${seg(id)}`),
  schedules: () => request<{ items: AgentSchedule[] }>('/agents/schedules'),
  patchSchedule: (id: string, body: { enabled?: boolean; atLocal?: string | null; everyMinutes?: number | null }) => request<AgentSchedule>(`/agents/schedules/${seg(id)}`, { method: 'PATCH', body }),
  runScheduleNow: (id: string) => request<{ jobs: AgentJob[] }>(`/agents/schedules/${seg(id)}/run-now`, { method: 'POST', body: {} }),
  dailyLog: (day?: string) => request<DailyLogResponse>('/daily-log', { query: { day } }),
  compileDailyLog: (day?: string) => request<DailyLogResponse>('/daily-log/compile', { method: 'POST', body: day ? { day } : {} }),
  autonomy: () => request<AutonomyResponse>('/settings/autonomy'),
  patchAutonomy: (patch: AutonomyPatch) => request<{ settings: AutonomySettings }>('/settings/autonomy', { method: 'PATCH', body: patch }),
  notificationSettings: () => request<{ settings: NotificationSettings; smsAvailable: boolean }>('/settings/notifications'),
  patchNotificationSettings: (patch: Partial<NotificationSettings>) => request<{ settings: NotificationSettings; smsAvailable: boolean }>('/settings/notifications', { method: 'PATCH', body: patch }),
  notifications: (unread = false) => request<{ items: NotificationRow[]; unread: number }>('/notifications', { query: { unread: unread ? 1 : undefined } }),
  testNotification: () => request<NotificationTestResult>('/notifications/test', { method: 'POST', body: {} }),
  tasks: (f: { claimId?: string; status?: 'open' | 'done' | 'cancelled' | 'all' } = {}) => request<{ items: TaskRow[] }>('/tasks', { query: { claimId: f.claimId, status: f.status } }),
};

export const agentsQk = {
  all: ['agents'] as const,
  status: ['agents', 'status'] as const,
  jobs: (f: JobFilters) => ['agents', 'jobs', f] as const,
  job: (id: string) => ['agents', 'job', id] as const,
  runs: (agent: string) => ['agents', 'runs', agent] as const,
  run: (id: string) => ['agents', 'run', id] as const,
  schedules: ['agents', 'schedules'] as const,
  dailyLog: (day: string) => ['daily-log', day] as const,
  autonomy: ['settings', 'autonomy'] as const,
  notificationSettings: ['settings', 'notifications'] as const,
};

/** The top-bar pill polls with the Needs-you badge. */
export const AGENTS_POLL_MS = 15_000;

export function useAgentsStatus(poll = AGENTS_POLL_MS) {
  return useQuery({ queryKey: agentsQk.status, queryFn: agentsApi.status, refetchInterval: poll, staleTime: 5_000, retry: false });
}

export function useAgentJobs(f: JobFilters) {
  return useQuery({ queryKey: agentsQk.jobs(f), queryFn: () => agentsApi.jobs(f), refetchInterval: AGENTS_POLL_MS });
}

export function useAgentJob(id: string | undefined) {
  return useQuery({ queryKey: agentsQk.job(id ?? ''), queryFn: () => agentsApi.job(id!), enabled: Boolean(id) });
}

export function useAgentRuns(agent: AgentName | '') {
  return useQuery({ queryKey: agentsQk.runs(agent), queryFn: () => agentsApi.runs({ agent }), refetchInterval: AGENTS_POLL_MS });
}

export function useAgentRun(id: string | undefined) {
  return useQuery({ queryKey: agentsQk.run(id ?? ''), queryFn: () => agentsApi.run(id!), enabled: Boolean(id) });
}

export function useSchedules() {
  return useQuery({ queryKey: agentsQk.schedules, queryFn: agentsApi.schedules });
}

export function useDailyLog(day: string) {
  return useQuery({ queryKey: agentsQk.dailyLog(day), queryFn: () => agentsApi.dailyLog(day || undefined) });
}

export function useAutonomySettings() {
  return useQuery({ queryKey: agentsQk.autonomy, queryFn: agentsApi.autonomy });
}

export function useNotificationSettings() {
  return useQuery({ queryKey: agentsQk.notificationSettings, queryFn: agentsApi.notificationSettings });
}

/** A mutation that refreshes everything agents-related when it settles. */
export function useAgentsMutation<A, R>(fn: (arg: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: agentsQk.all });
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export const AGENT_LABEL: Record<string, string> = {
  intake: 'Intake',
  mail: 'Mail',
  case_manager: 'Case manager',
  drafter: 'Drafter',
  reviewer: 'Reviewer',
  researcher: 'Researcher',
  supervisor: 'Supervisor',
  engineer: 'Engineer',
  calls: 'Calls',
  critic: 'Critic',
  judge: 'Judge',
  system: 'System',
};

/** Pill colour class for the top bar (§L.1): green running, amber paused, red stopped, grey off. */
export function pillTone(state: AgentsPillState): 'green' | 'amber' | 'red' | 'grey' {
  return state === 'running' ? 'green' : state === 'paused' ? 'amber' : state === 'stopped' ? 'red' : 'grey';
}

/** "42 %" from a 0..1 utilisation. */
export function percent(u: number | undefined | null): string {
  return typeof u === 'number' && Number.isFinite(u) ? `${Math.round(u * 100)} %` : '—';
}

/** "3 min 20 s" / "45 s" / "1 h 5 min". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 ? ` ${s % 60} s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** Schedule cadence in words: "every 5 min", "07:30 Mon–Fri", "18:00 daily". */
export function scheduleCadence(s: Pick<AgentSchedule, 'everyMinutes' | 'atLocal' | 'weekdays'>): string {
  if (s.everyMinutes) return s.everyMinutes % 60 === 0 ? `every ${s.everyMinutes / 60} h` : `every ${s.everyMinutes} min`;
  const days = s.weekdays ?? [];
  const when = days.length === 0 || days.length === 7 ? 'daily' : days.join(',') === '1,2,3,4,5' ? 'Mon–Fri' : days.map((d) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d - 1]).join(', ');
  return `${s.atLocal ?? '??:??'} ${when}`;
}

/** Tone for a tool-call decision in the run timeline. */
export function decisionTone(d: AgentToolCall['decision']): 'green' | 'amber' | 'red' | 'grey' {
  return d === 'allowed' ? 'green' : d === 'asked' ? 'amber' : d === 'denied' || d === 'error' || d === 'invalid' ? 'red' : 'grey';
}
