// owned by knowledge-use
/**
 * Golden replay runs (docs/SUPREME-KNOWLEDGE-BUILDER.md §12.1). Each run is written once to the append-only
 * `eval_runs` and recorded as `knowledge.replay.run` (knowledge_changes + audit_log, KR-12).
 *
 *   gate     on a proposed `rule` (queued by the store when it waits for the owner): the active rules plus the
 *            candidate over the frozen cases; the verdict is attached to the candidate's history and shown with its card
 *   nightly  the active version's rules over all cases (the metrics trend)
 *   drafts   (AI, off by default) up to 10 drafts the owner approved without edits are re-drafted with the candidate
 *            learned version and with the baseline, read-only (every follow-up discarded); the reviewer's deterministic
 *            tiers a and b and the similarity to the approved text decide `no_worse`
 *
 * Correlational evidence from the business's own history, not proof. n is always recorded.
 */
import { AI_JOB_DEFAULTS, describeReplay, isoWeekOf, replayRules, textJaccard, type KnowledgeItem, type DraftReplayResult, type RuleData, type ToolName } from '@ccguk/domain';
import type { Actor } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import type { AgentSpec, JobOutcome, JobRecord } from '../../agent/contracts.js';
import { londonDay } from '../../agent/core.js';
import { runAgent } from '../../agent/runAgent.js';
import { buildCaseBrief } from '../../casework/caseBrief.js';
import { factsTier, rulesTier, type ReviewTarget } from '../../casework/review.js';
import { activeLearnedRules } from '../store.js';
import { recordKnowledgeChange } from '../changes.js';
import { getKnowledgeSettings } from '../settings.js';
import { withKnowledgeVersion } from '../use/retrieve.js';
import { rows, tableExists } from '../use/sql.js';
import { refreshEvalCases } from './cases.js';

const SUPERVISOR: Actor = { userId: 'agent:supervisor' };

export interface ReplayRunSummary {
  evalRunId: string;
  verdict: 'no_worse' | 'worse' | 'inconclusive' | 'error';
  cases: number;
  casesAffected?: number;
  summary: string;
}

function record(ctx: AppContext, items: readonly KnowledgeItem[], run: { id: string; verdict: string; mode: string }, summary: string, actor: Actor, jobId: string | null): void {
  const now = ctx.now();
  ctx.db.transaction((tx) => {
    if (!items.length) recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.replay.run', after: { evalRunId: run.id, mode: run.mode, verdict: run.verdict }, reason: summary, jobId });
    for (const item of items) recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.replay.run', item, after: { evalRunId: run.id, mode: run.mode, verdict: run.verdict }, reason: summary, jobId, needsYouId: item.needsYouId });
  });
}

/** Gate mode: the candidate rule(s) plus the active rules over every frozen case. */
export function runReplayGate(ctx: AppContext, itemIds: readonly string[], opts: { jobId?: string | null; actor?: Actor } = {}): ReplayRunSummary {
  const settings = getKnowledgeSettings(ctx);
  const startedAt = ctx.now();
  refreshEvalCases(ctx);
  const cases = ctx.repos.listEvalCases(ctx.db);
  const candidates = ctx.repos.getKnowledgeItems(ctx.db, [...itemIds]).filter((i) => i.kind === 'rule');
  const keys = new Set(candidates.map((c) => c.itemKey));
  const active = activeLearnedRules(ctx).filter((r) => !keys.has(r.item.itemKey));
  const rules = [...active.map((r) => ({ itemId: r.itemId, data: r.data })), ...candidates.map((c) => ({ itemId: c.id, data: c.data as RuleData }))];
  const opts2 = { tolerancePct: settings.replay.worseTolerancePct, minCases: settings.replay.minCases };
  const result = candidates.length ? replayRules(cases, rules, opts2) : null;
  const summary = result ? describeReplay(result, { minCases: settings.replay.minCases }) : 'Replay: no rule to replay (the item is not a proposed rule).';
  const run = ctx.repos.insertEvalRun(ctx.db, {
    mode: 'gate',
    baselineVersion: ctx.repos.getKnowledgePackState(ctx.db).activeVersion,
    candidate: { itemIds: candidates.map((c) => c.id), itemKeys: candidates.map((c) => c.itemKey), activeRuleIds: active.map((a) => a.itemId) },
    cases: cases.length,
    metrics: result ? { casesAffected: result.casesAffected, consistent: result.consistent, inconsistent: result.inconsistent, perRule: result.perRule } : {},
    verdict: result?.verdict ?? 'inconclusive',
    details: { hardViolations: result?.hardViolations ?? [], summary, tolerancePct: opts2.tolerancePct, minCases: opts2.minCases, honesty: 'Correlation from our own history, not proof.' },
    startedAt,
    finishedAt: ctx.now(),
    jobId: opts.jobId ?? null,
    createdBy: (opts.actor ?? SUPERVISOR).userId,
  });
  record(ctx, candidates, run, summary, opts.actor ?? SUPERVISOR, opts.jobId ?? null);
  return { evalRunId: run.id, verdict: run.verdict, cases: cases.length, casesAffected: result?.casesAffected ?? 0, summary };
}

/** Nightly mode: the active version's rules over every case (the trend). */
export function runReplayNightly(ctx: AppContext, opts: { jobId?: string | null; actor?: Actor } = {}): ReplayRunSummary {
  const settings = getKnowledgeSettings(ctx);
  const startedAt = ctx.now();
  const refreshed = refreshEvalCases(ctx);
  const cases = ctx.repos.listEvalCases(ctx.db);
  const active = activeLearnedRules(ctx);
  const result = replayRules(cases, active.map((r) => ({ itemId: r.itemId, data: r.data })), { tolerancePct: settings.replay.worseTolerancePct, minCases: settings.replay.minCases });
  const summary = active.length ? describeReplay(result, { minCases: settings.replay.minCases }) : 'Replay: no active learned rules.';
  const version = ctx.repos.getKnowledgePackState(ctx.db).activeVersion;
  const run = ctx.repos.insertEvalRun(ctx.db, {
    mode: 'nightly',
    baselineVersion: version,
    candidate: { version, ruleIds: active.map((a) => a.itemId) },
    cases: cases.length,
    metrics: { casesAffected: result.casesAffected, consistent: result.consistent, inconsistent: result.inconsistent, perRule: result.perRule, newCases: refreshed.created },
    verdict: active.length ? result.verdict : 'inconclusive',
    details: { hardViolations: result.hardViolations, summary },
    startedAt,
    finishedAt: ctx.now(),
    jobId: opts.jobId ?? null,
    createdBy: (opts.actor ?? SUPERVISOR).userId,
  });
  record(ctx, [], run, summary, opts.actor ?? SUPERVISOR, opts.jobId ?? null);
  return { evalRunId: run.id, verdict: run.verdict, cases: cases.length, casesAffected: result.casesAffected, summary };
}

// ---------------------------------------------------------------------------
// Draft replay (AI, off by default)
// ---------------------------------------------------------------------------

/** Read-only tools for the re-drafting run (drafting tools are never given: nothing can be created). */
export const REPLAY_DRAFT_TOOLS: readonly ToolName[] = ['claim_brief', 'templates_list', 'documents_list', 'document_get', 'evidence_list', 'kb_search', 'kb_entry', 'brain_search', 'memory_recall', 'knowledge_search', 'insurer_profile'];

const d = AI_JOB_DEFAULTS['knowledge.replay_drafts'];
/** The re-drafting spec: the drafter's prompt, read-only tools, the draft returned as `body` (draft_replay schema). */
export const REPLAY_DRAFTS_SPEC: AgentSpec = {
  name: 'drafter',
  jobType: 'knowledge.replay_drafts',
  title: 'Draft replay (read-only)',
  promptFiles: ['drafter.md'],
  tools: [...REPLAY_DRAFT_TOOLS],
  allowRead: false,
  resultSchemaId: 'draft_replay',
  defaults: { model: d?.model ?? 'claude-opus-5-5', effort: d?.effort ?? 'medium', maxTurns: d?.maxTurns ?? 8, timeoutMs: d?.timeoutMs ?? 10 * 60_000 },
};

export const REPLAY_DRAFTS_MAX = 10;

interface ApprovedDraft {
  id: string;
  claimId: string;
  kind: string;
  subject: string;
  body: string;
}

/** Up to 10 recent drafts the owner approved and sent without an edit (no correction recorded against them). */
export function approvedUneditedDrafts(ctx: AppContext, limit = REPLAY_DRAFTS_MAX): ApprovedDraft[] {
  if (!tableExists(ctx, 'outbox')) return [];
  const edited = new Set<string>();
  if (tableExists(ctx, 'corrections')) for (const r of rows<{ target_id: string | null }>(ctx, `SELECT target_id FROM corrections WHERE target_id IS NOT NULL`)) if (r.target_id) edited.add(r.target_id);
  return rows<{ id: string; claim_id: string; kind: string; subject: string; body_text: string }>(ctx, `SELECT id, claim_id, kind, subject, body_text FROM outbox WHERE claim_id IS NOT NULL AND status = 'sent' ORDER BY created_at DESC, id LIMIT 200`)
    .filter((r) => !edited.has(r.id) && r.body_text)
    .slice(0, limit)
    .map((r) => ({ id: r.id, claimId: r.claim_id, kind: r.kind, subject: r.subject ?? '', body: r.body_text }));
}

interface ArmResult {
  drafts: number;
  passed: number;
  similarity: number;
  failures: string[];
}

async function redraft(ctx: AppContext, job: JobRecord, draft: ApprovedDraft, version: number | null): Promise<{ text: string } | { error: string }> {
  const run = await withKnowledgeVersion(version, () =>
    runAgent(ctx, REPLAY_DRAFTS_SPEC, job, {
      task: `Replay: re-draft the ${draft.kind} email on claim (claimId ${draft.claimId}) [knowledge-replay:${draft.kind}]. This is an evaluation run: nothing you write is sent or saved.`,
      brief: buildCaseBrief(ctx, draft.claimId),
      question: `Write the email again from scratch as the Claims Team would, using only read-only tools. Subject of the original: "${draft.subject.slice(0, 200)}". Put the full email body in \`body\` (figures as {{fact:<id>}} placeholders), \`citations\` empty unless you relied on KB, pack, memory or knowledge entries. Return the DraftReplayResult JSON.`,
    }),
  );
  if (run.outcome.kind !== 'ok' || !run.result) return { error: `${run.outcome.kind}${'message' in run.outcome && run.outcome.message ? `: ${run.outcome.message}` : ''}` };
  return { text: (run.result as DraftReplayResult).body ?? '' };
}

function deterministicPass(ctx: AppContext, draft: ApprovedDraft, text: string): boolean {
  const target: ReviewTarget = { kind: 'outbox', id: `replay:${draft.id}`, claimId: draft.claimId, text: `${draft.subject}\n\n${text}`, freeText: `${draft.subject}\n\n${text}`, templateId: `email.${draft.kind}`, missingInfo: false };
  const brief = buildCaseBrief(ctx, draft.claimId, { mask: false });
  const issues = [...rulesTier(ctx, target).issues, ...factsTier(ctx, target, brief).issues];
  return !issues.some((i) => i.severity === 'block' && i.code !== 'SIGNOFF_MISSING');
}

export async function runReplayDrafts(ctx: AppContext, job: JobRecord, opts: { ownerTriggered: boolean }): Promise<JobOutcome<Record<string, unknown>>> {
  const settings = getKnowledgeSettings(ctx);
  if (!settings.replay.draftsEnabled && !opts.ownerTriggered) return { kind: 'done', result: { result: 'disabled' } };
  const week = isoWeekOf(londonDay(ctx.now()));
  const thisWeek = ctx.repos.listEvalRuns(ctx.db, { mode: 'drafts', limit: 50 }).filter((r) => isoWeekOf(londonDay(r.startedAt)) === week).length;
  if (thisWeek >= settings.budgets.replayDraftsPerWeek) return { kind: 'done', result: { result: 'budget', week, runs: thisWeek } };
  const state = ctx.repos.getKnowledgePackState(ctx.db);
  const candidateVersion = state.activeVersion;
  const baselineVersion = candidateVersion === null ? null : (ctx.repos.getKnowledgePackVersion(ctx.db, candidateVersion)?.basedOnVersion ?? (candidateVersion > 1 ? candidateVersion - 1 : null));
  const startedAt = ctx.now();
  const drafts = approvedUneditedDrafts(ctx);
  const arms: Record<'baseline' | 'candidate', ArmResult> = { baseline: { drafts: 0, passed: 0, similarity: 0, failures: [] }, candidate: { drafts: 0, passed: 0, similarity: 0, failures: [] } };
  for (const draft of drafts) {
    for (const [arm, version] of [['baseline', baselineVersion], ['candidate', candidateVersion]] as const) {
      const r = await redraft(ctx, job, draft, version);
      if ('error' in r) {
        arms[arm].failures.push(`${draft.id}: ${r.error}`);
        continue;
      }
      arms[arm].drafts += 1;
      if (deterministicPass(ctx, draft, r.text)) arms[arm].passed += 1;
      arms[arm].similarity += textJaccard(r.text, draft.body);
    }
  }
  const metric = (a: ArmResult) => ({ drafts: a.drafts, passRatePct: a.drafts ? Math.round((a.passed / a.drafts) * 1000) / 10 : null, meanSimilarity: a.drafts ? Math.round((a.similarity / a.drafts) * 1000) / 1000 : null, failures: a.failures.slice(0, 10) });
  const b = metric(arms.baseline);
  const c = metric(arms.candidate);
  const tol = settings.replay.worseTolerancePct;
  const failed = arms.baseline.failures.length + arms.candidate.failures.length;
  const verdict: 'no_worse' | 'worse' | 'inconclusive' | 'error' =
    !drafts.length || !b.drafts || !c.drafts ? (failed ? 'error' : 'inconclusive') : (c.passRatePct ?? 0) < (b.passRatePct ?? 0) - tol || (c.meanSimilarity ?? 0) < (b.meanSimilarity ?? 0) - tol / 100 ? 'worse' : 'no_worse';
  const summary = `Draft replay: ${drafts.length} approved draft(s); candidate v${candidateVersion ?? '–'} pass ${c.passRatePct ?? '–'}% similarity ${c.meanSimilarity ?? '–'} vs baseline v${baselineVersion ?? '–'} pass ${b.passRatePct ?? '–'}% similarity ${b.meanSimilarity ?? '–'} → ${verdict}.`;
  const run = ctx.repos.insertEvalRun(ctx.db, {
    mode: 'drafts',
    baselineVersion,
    candidate: { version: candidateVersion, draftIds: drafts.map((x) => x.id) },
    cases: drafts.length,
    metrics: { baseline: b, candidate: c },
    verdict,
    details: { summary, tolerancePct: tol },
    startedAt,
    finishedAt: ctx.now(),
    jobId: job.id,
    createdBy: opts.ownerTriggered ? job.createdBy : SUPERVISOR.userId,
  });
  record(ctx, [], run, summary, opts.ownerTriggered ? { userId: job.createdBy } : SUPERVISOR, job.id);
  return { kind: 'done', result: { result: 'replayed', evalRunId: run.id, verdict, drafts: drafts.length } };
}
