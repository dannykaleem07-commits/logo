// owned by casework
/**
 * Agent tab client (docs/SUPREME-DESIGN.md §L.9, §N.6). Web code never imports API code, so the HTTP shapes are
 * declared here:
 *
 *   GET  /claims/:id/brief                          (casework) Case Brief + latest case review + claim notes
 *   POST /claims/:id/ask {question}                 (casework) "Ask the brain" → research.ask job (202)
 *   GET  /claims/:id/agent                          (runtime)  state, jobs, runs, open Needs-you, open tasks
 *   POST /claims/:id/agent/pause | resume | review-now (runtime)
 *   POST /tasks/:id/complete | cancel | reschedule {dueAt}  (runtime)
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Basis, CaseReviewResult } from '@ccguk/domain';
import { request, seg } from './client';

export interface FactValue {
  value: string | number | boolean | null;
  display: string;
  source: string;
  verified?: boolean;
}

export interface CaseBrief {
  version: 'brief/1';
  claimId: string;
  reference: string;
  generatedAt: string;
  facts: Record<string, FactValue>;
  claim: { status: string; liability: string; accident: { date: string; town: string; summary: string }; openFlags: Array<{ code: string; severity: string; message: string }> };
  nextActions: Array<{ code: string; title: string; why: string; dueAt: string | null; blockedBy: string[]; templateId: string | null }>;
  clocks: Array<{ id: string; label: string; dueAt: string; status: string }>;
  openTasks: Array<{ id: string; kind: string; dueAt: string; note: string }>;
  openNeedsYou: Array<{ id: string; kind: string; title: string }>;
  memory: Array<{ id: string; text: string }>;
}

export interface MemoryNote {
  id: string;
  kind: string;
  scope: string;
  text: string;
  basis: Basis[];
  status: 'proposed' | 'approved' | 'retired';
  createdBy: string;
  createdAt: string;
}

export interface BriefResponse {
  brief: CaseBrief;
  review: { runId: string; at: string; result: CaseReviewResult } | null;
  notes: MemoryNote[];
}

export interface ClaimAgentJob {
  id: string;
  type: string;
  agent: string;
  status: string;
  priority: number;
  attempts: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface ClaimAgentRun {
  id: string;
  agent: string;
  jobType: string;
  model: string;
  effort: string;
  startedAt: string;
  endedAt?: string;
  outcome?: string;
  toolCalls: number;
  error?: string;
}

export interface ClaimTask {
  id: string;
  kind: string;
  title: string;
  note?: string;
  actionCode?: string;
  dueAt: string;
  status: 'open' | 'done' | 'cancelled';
  createdBy: string;
}

export interface ClaimAgentState {
  claimId: string;
  paused: boolean;
  pausedBy?: string;
  pausedReason?: string;
  pausedAt?: string;
  lastReviewAt?: string;
  nextReviewAt?: string;
  runsToday: number;
}

export interface ClaimAgentResponse {
  state: ClaimAgentState;
  jobs: ClaimAgentJob[];
  runs: ClaimAgentRun[];
  needsYou: Array<{ id: string; kind: string; title: string; priority: string; createdAt: string }>;
  tasks: ClaimTask[];
}

export const caseworkApi = {
  brief: (claimId: string) => request<BriefResponse>(`/claims/${seg(claimId)}/brief`),
  ask: (claimId: string, question: string) => request<{ id: string; status: string }>(`/claims/${seg(claimId)}/ask`, { method: 'POST', body: { question } }),
  agent: (claimId: string) => request<ClaimAgentResponse>(`/claims/${seg(claimId)}/agent`),
  pause: (claimId: string, reason?: string) => request<ClaimAgentState>(`/claims/${seg(claimId)}/agent/pause`, { method: 'POST', body: reason ? { reason } : {} }),
  resume: (claimId: string) => request<ClaimAgentState>(`/claims/${seg(claimId)}/agent/resume`, { method: 'POST', body: {} }),
  reviewNow: (claimId: string) => request<{ id: string }>(`/claims/${seg(claimId)}/agent/review-now`, { method: 'POST', body: {} }),
  completeTask: (taskId: string) => request<ClaimTask>(`/tasks/${seg(taskId)}/complete`, { method: 'POST', body: {} }),
  rescheduleTask: (taskId: string, dueAt: string) => request<ClaimTask>(`/tasks/${seg(taskId)}/reschedule`, { method: 'POST', body: { dueAt } }),
};

export const caseworkQk = {
  all: (claimId: string) => ['casework', claimId] as const,
  brief: (claimId: string) => ['casework', claimId, 'brief'] as const,
  agent: (claimId: string) => ['casework', claimId, 'agent'] as const,
};

/** The Agent tab refreshes every 20 s while it is open (jobs move in the background). */
export const AGENT_TAB_POLL_MS = 20_000;

export function useClaimBrief(claimId: string) {
  return useQuery({ queryKey: caseworkQk.brief(claimId), queryFn: () => caseworkApi.brief(claimId), refetchInterval: AGENT_TAB_POLL_MS });
}

export function useClaimAgent(claimId: string) {
  return useQuery({ queryKey: caseworkQk.agent(claimId), queryFn: () => caseworkApi.agent(claimId), refetchInterval: AGENT_TAB_POLL_MS });
}

/** A mutation that refreshes the Agent tab afterwards. */
export function useCaseworkMutation<V, R>(claimId: string, fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSettled: () => qc.invalidateQueries({ queryKey: caseworkQk.all(claimId) }) });
}

/** Human labels for the job types shown in the claim's agent history. */
export const JOB_LABEL: Record<string, string> = {
  'case.review': 'Case review',
  'offer.analyse': 'Offer analysis',
  'draft.compose': 'Drafting',
  'review.check': 'Review',
  'research.ask': 'Research',
  'mail.triage': 'Email triage',
  'mail.reply': 'Email reply',
  'outbox.after_review': 'Send decision',
  'outbox.release': 'Send',
  'document.after_review': 'Letter decision',
  'intake.extract': 'Reading a document',
};

export const jobLabel = (type: string): string => JOB_LABEL[type] ?? type.replace(/[._]/g, ' ');

/** "pack:<id>@<v>#<entry>" / "kb:x" basis chip text. */
export function basisLabel(b: Basis): string {
  if (b.label) return b.label;
  if (b.kind === 'pack') return b.id.replace(/^pack:/, '').replace(/@[^#]+#/, ' · ');
  if (b.kind === 'fact') return b.id.replace(/\./g, ' ');
  return `${b.kind} ${b.id.length > 18 ? `${b.id.slice(0, 8)}…` : b.id}`;
}
