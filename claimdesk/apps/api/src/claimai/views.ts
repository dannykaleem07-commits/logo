// owned by claimai-server
/**
 * The JSON the AI input panel reads (docs/CLAIM-AI-INPUT.md §11.1): `AiInputSummary`, `AiInputDetail` (with the
 * catch-up view), `AiInputPanel`. Everything is derived from the stored input, its interpretation and the append-only
 * log; private notes never leave the input (they are shown to the owner only, never in "What changed").
 */
import { CORRESPONDENCE_KIND_LABEL, STATUS_LABEL, TIER_LABEL, WAITING_LABEL, type CatchUpFilePlan, type PlannedAction, type WhatChanged } from '@ccguk/domain';

const aiWaitingLabel = (reason: string): string => WAITING_LABEL[reason] ?? 'Waiting for the AI.';
import type { ClaimAiInputRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { aiWaitingReason } from '../agent/core.js';
import { docTypeLabel } from '../intake/proposals.js';
import { fileStage, pendingSplitItems } from '../intake/bundles/views.js';
import { lineResults, type LineResult } from './apply.js';
import { listInstructionViews, userName, type StandingInstructionView } from './instructions.js';
import { interpretationOf } from './service.js';

export type WaitingReason = 'agents_off' | 'kill_switch' | 'usage' | 'sign_in';

export interface AiActionView {
  key: string;
  type: PlannedAction['type'];
  tier: PlannedAction['tier'];
  tierLabel: string;
  ticked: boolean;
  tickable: boolean;
  title: string;
  detail: string | null;
  why: string | null;
  at: string | null;
  precision: 'date' | 'datetime' | null;
  quote: string | null;
  source: PlannedAction['source'];
  from: PlannedAction['from'];
  confidence: number;
  current: string | null;
  params: Record<string, unknown>;
  editable: PlannedAction['editable'];
  undo: { available: boolean; why: string | null };
  state: 'proposed' | 'applied' | 'not_applied' | 'skipped' | 'failed' | 'needs_you' | 'undone';
  result: { refs: Record<string, string>; message: string | null; error: { code: string; message: string } | null; at: string | null } | null;
  link: string | null;
  bundleFileId: string | null;
}

const REF_KEYS = ['eventId', 'correctingEventId', 'taskId', 'instructionId', 'proposalId', 'hireId', 'needsYouId', 'jobId', 'outboxId', 'offerId', 'correspondenceId', 'evidenceId'] as const;

function refsOf(r: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of REF_KEYS) if (typeof r[k] === 'string') out[k] = r[k] as string;
  return out;
}

function linkOf(claimId: string, a: PlannedAction, r: LineResult | undefined): string | null {
  if (r?.refs.needsYouId) return `/needs-you?item=${String(r.refs.needsYouId)}`;
  if (a.link) return a.link;
  switch (a.type) {
    case 'event':
    case 'note':
    case 'record_correspondence':
      return r ? `/claims/${claimId}/chronology` : null;
    case 'hire_end':
    case 'hire_correct':
    case 'hire_start':
      return `/claims/${claimId}/hire`;
    case 'offer_received':
    case 'offer_decision':
      return `/claims/${claimId}/offers`;
    case 'money':
      return `/claims/${claimId}/ledger`;
    case 'file_evidence':
      return r ? `/claims/${claimId}/evidence` : null;
    default:
      return null;
  }
}

export function actionView(claimId: string, a0: PlannedAction, r: LineResult | undefined): AiActionView {
  const a = r?.action ?? a0;
  const p = a.params as Record<string, unknown>;
  const at = (p.at ?? p.endAt ?? p.dueAt ?? p.until ?? p.startAt ?? null) as string | null;
  const undoAvailable = Boolean(r && (r.state === 'applied' || r.state === 'needs_you') && a.undoable);
  return {
    key: a.key,
    type: a.type,
    tier: a.tier,
    tierLabel: TIER_LABEL[a.tier],
    ticked: a.ticked,
    tickable: a.tickable && !(r && (r.state === 'applied' || r.state === 'needs_you' || r.state === 'undone')),
    title: a.title,
    detail: a.detail,
    why: a.why,
    at,
    precision: at ? ((p.precision as 'date' | 'datetime' | undefined) ?? 'datetime') : null,
    quote: a.quote,
    source: a.source,
    from: a.from,
    confidence: a.confidence,
    current: (p.current as string | null | undefined) ?? null,
    params: p,
    editable: r && r.state !== 'failed' && r.state !== 'not_applied' ? [] : a.editable,
    undo: { available: undoAvailable, why: undoAvailable ? null : (a.undoWhy ?? (r ? null : 'Not applied yet')) },
    state: r?.state ?? 'proposed',
    result: r ? { refs: refsOf(r.refs), message: r.message, error: r.error, at: r.at } : null,
    link: linkOf(claimId, a, r),
    bundleFileId: (p.bundleFileId as string | undefined) ?? null,
  };
}

function excerptOf(input: ClaimAiInputRecord, files: number): string {
  if (input.kind === 'catch_up') return (input.text.trim() || `${files} file${files === 1 ? '' : 's'}`).slice(0, 200);
  return (input.text.trim() || input.extraText?.trim() || '').slice(0, 200);
}

function headlineOf(actions: AiActionView[], questions: number, waiting: boolean): string {
  const bits: string[] = [];
  const applied = actions.filter((a) => a.state === 'applied' && a.type !== 'private_note');
  for (const a of applied.slice(0, 3)) bits.push(a.title.replace(/^Add to chronology: /, '').replace(/ — .*$/, '').slice(0, 60));
  if (applied.length > 3) bits.push(`${applied.length - 3} more`);
  const ny = actions.filter((a) => a.state === 'needs_you').length;
  if (ny) bits.push(`${ny} for Needs-you`);
  const tick = actions.filter((a) => a.state === 'proposed' && a.tier === 'confirm').length;
  if (tick && !applied.length) bits.push(`${tick} to tick`);
  if (questions) bits.push(`${questions} question${questions === 1 ? '' : 's'}`);
  if (waiting) bits.push('waiting for the AI');
  if (!bits.length) bits.push(actions.length ? `${actions.length} line${actions.length === 1 ? '' : 's'} to check` : 'nothing to do');
  return bits.join(' · ');
}

export function summaryView(ctx: AppContext, input: ClaimAiInputRecord) {
  const interp = interpretationOf(input);
  const results = lineResults(ctx.repos.listAiInputLog(ctx.db, input.id));
  const actions = interp.actions.map((a) => actionView(input.claimId, a, results.get(a.key)));
  const waitingAi = input.status === 'waiting_ai' || (input.status === 'partly_applied' && interp.pendingText.length > 0) ? aiWaitingReason(ctx) : null;
  const files = input.bundleId ? ctx.repos.listBundleFiles(ctx.db, input.bundleId) : [];
  const answered = new Set((input.answers as Array<{ questionId?: string }>).map((a) => a.questionId));
  const openQuestions = interp.questions.filter((q) => !answered.has(q.id)).length;
  let bundle: { id: string; files: number; inProgress: number; filed: number } | null = null;
  if (input.bundleId) {
    const splitting = pendingSplitItems(ctx);
    const inProgress = files.filter((f) => ['stored', 'reading', 'splitting', 'reading_ai'].includes(fileStage(ctx, f, splitting).stage)).length;
    bundle = { id: input.bundleId, files: files.length, inProgress, filed: files.filter((f) => f.filedClaimId === input.claimId).length };
  }
  return {
    id: input.id,
    claimId: input.claimId,
    kind: input.kind,
    channel: input.channel,
    status: input.status,
    statusLabel: STATUS_LABEL[input.status] ?? input.status,
    excerpt: excerptOf(input, files.length),
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    createdByName: userName(ctx, input.createdBy),
    appliedAt: input.appliedAt ?? null,
    engine: input.engine ?? null,
    counts: {
      actions: actions.length,
      applied: actions.filter((a) => a.state === 'applied').length,
      waitingTick: actions.filter((a) => a.state === 'proposed' && a.tier === 'confirm').length,
      needsYou: actions.filter((a) => a.state === 'needs_you').length,
      undone: actions.filter((a) => a.state === 'undone').length,
      failed: actions.filter((a) => a.state === 'failed').length,
      questions: openQuestions,
    },
    headline: headlineOf(actions, openQuestions, Boolean(waitingAi)),
    waiting: waitingAi,
    bundle,
  };
}
export type AiInputSummary = ReturnType<typeof summaryView>;

const PLAN_LABEL: Record<CatchUpFilePlan['plan'], string> = {
  file_and_record: 'File and record',
  file_only: 'Just file',
  already_on_file: 'Already on file',
  other_claim: 'Belongs to another claim',
  excluded: 'Not filed',
  ask: 'Who sent it?',
};

function catchUpView(ctx: AppContext, input: ClaimAiInputRecord) {
  if (!input.bundleId) return null;
  const interp = interpretationOf(input);
  const plans = new Map((interp.catchUp?.files ?? []).map((p) => [p.fileId, p]));
  const files = ctx.repos.listBundleFiles(ctx.db, input.bundleId);
  const bundle = ctx.repos.getIntakeBundle(ctx.db, input.bundleId);
  const computed = bundle?.computed as { files?: Record<string, { groupKey?: string; duplicate?: { of: string } | null; docType?: string | null }>; groups?: Array<{ key: string; kind: string; claim: { id: string; reference: string } | null; reasons: Array<{ text: string; fileId?: string }> }> } | undefined;
  const splitting = pendingSplitItems(ctx);
  const results = lineResults(ctx.repos.listAiInputLog(ctx.db, input.id));
  const overrides = new Map<string, boolean>();
  for (const l of ctx.repos.listAiInputLog(ctx.db, input.id)) if (l.kind === 'file_override' && l.actionKey && (l.action as { direction?: string } | undefined)?.direction) overrides.set(l.actionKey, true);
  const counts = { total: files.length, read: 0, inProgress: 0, waitingAi: 0, failed: 0, skipped: 0, duplicates: 0 };
  const out = files.map((f) => {
    const stage = fileStage(ctx, f, splitting);
    if (['read', 'read_rules_only', 'unpacked'].includes(stage.stage)) counts.read += 1;
    if (['stored', 'reading', 'splitting', 'reading_ai'].includes(stage.stage)) counts.inProgress += 1;
    if (stage.stage === 'waiting_ai') counts.waitingAi += 1;
    if (stage.stage === 'failed') counts.failed += 1;
    if (stage.stage === 'skipped') counts.skipped += 1;
    const c = computed?.files?.[f.id];
    if (c?.duplicate) counts.duplicates += 1;
    const ev = ctx.repos.getEvidence(ctx.db, f.evidenceId);
    const item = ctx.repos.getIntakeItem(ctx.db, f.intakeItemId);
    const p = plans.get(f.id);
    const group = computed?.groups?.find((g) => g.key === c?.groupKey);
    const rec = [...results.entries()].find(([, r]) => r.state === 'applied' && r.action?.type === 'record_correspondence' && r.action.params.bundleFileId === f.id)?.[1];
    const docType = (c?.docType ?? item?.docType ?? null) as string | null;
    return {
      fileId: f.id,
      itemId: f.intakeItemId,
      evidenceId: f.evidenceId,
      filename: ev?.filename ?? '(missing file)',
      mime: ev?.mime ?? 'application/octet-stream',
      bytes: ev?.bytes ?? 0,
      role: f.role,
      parentFileId: f.parentFileId ?? null,
      segment: f.role === 'segment' && f.pageFrom && f.pageTo ? { fromPage: f.pageFrom, toPage: f.pageTo } : null,
      stage: stage.stage,
      stageLabel: stage.stageLabel,
      waiting: stage.waiting,
      docType,
      docTypeLabel: docType ? docTypeLabel(docType) : null,
      pages: (item?.normalised as { pages?: number } | undefined)?.pages ?? null,
      groupKey: c?.groupKey ?? 'unsure',
      plan: p?.plan ?? 'ask',
      planLabel: p?.plan === 'other_claim' && group?.claim ? `Belongs to ${group.claim.reference}` : PLAN_LABEL[p?.plan ?? 'ask'],
      alreadyOnFile: p?.alreadyOnFile ?? null,
      duplicateOf: c?.duplicate?.of ?? null,
      otherClaim: group?.kind === 'existing_claim' && group.claim ? { id: group.claim.id, reference: group.claim.reference, reasons: group.reasons.map((r) => r.text).slice(0, 3) } : null,
      direction: p?.direction.direction ?? 'unknown',
      directionWhy: f.role === 'pack' && !overrides.has(f.id) ? 'The original pack — its pages are read and filed one by one' : (p?.direction.why ?? 'Still being read'),
      directionConfidence: p?.direction.confidence ?? 0,
      directionSetBy: overrides.has(f.id) ? ('owner' as const) : ('auto' as const),
      realDate: p?.realDate.at ?? null,
      dateSource: p?.realDate.source ?? null,
      dateWhy: p?.realDate.why ?? '',
      dateFlag: p?.dateFlag ?? null,
      kind: p?.kind?.kind ?? null,
      kindLabel: p?.kind ? CORRESPONDENCE_KIND_LABEL[p.kind.kind] : null,
      counterparty: p?.direction.counterparty.name ?? null,
      alreadyRecorded: p?.alreadyRecorded ? { how: p.alreadyRecorded.how, at: p.alreadyRecorded.at, text: `Already recorded (${p.alreadyRecorded.how === 'event' ? 'chronology' : p.alreadyRecorded.how} ${p.alreadyRecorded.at.slice(0, 10)})` } : null,
      evidenceKind: p?.evidenceKind ?? 'document',
      filed: f.filedClaimId === input.claimId && f.filedEvidenceId ? { evidenceId: f.filedEvidenceId, kind: f.filedKind ?? 'document', at: f.filedAt ?? '' } : null,
      recorded: rec ? { correspondenceId: String(rec.refs.correspondenceId ?? ''), eventId: (rec.refs.eventId as string | undefined) ?? null } : null,
      fileUrl: `/api/evidence/${f.filedClaimId === input.claimId && f.filedEvidenceId ? f.filedEvidenceId : f.evidenceId}/file`,
    };
  });
  const readiness: 'reading' | 'ready' | 'applied' = input.status === 'applied' || input.status === 'partly_applied' || input.status === 'undone' ? 'applied' : interp.catchUp?.settled ? 'ready' : 'reading';
  return {
    bundleId: input.bundleId,
    readiness,
    autoApply: input.autoApply,
    filesDone: input.filesDone,
    fileCounts: counts,
    files: out,
    willDo: interp.catchUp?.willDo ?? [],
    blockers: (interp.catchUp?.blockers ?? []).map((b) => ({ code: b.code, text: b.text, fileId: b.fileId ?? null })),
    note: input.text.trim() || null,
  };
}

export function detailView(ctx: AppContext, input: ClaimAiInputRecord) {
  const s = summaryView(ctx, input);
  const interp = interpretationOf(input);
  const log = ctx.repos.listAiInputLog(ctx.db, input.id);
  const results = lineResults(log);
  const answers = new Map((input.answers as Array<{ questionId: string; optionId: string | null; text: string | null; date: string | null }>).map((a) => [a.questionId, a]));
  const actions = interp.actions.map((a) => actionView(input.claimId, a, results.get(a.key)));
  const busy = input.status === 'applying';
  const canApply = !busy && (input.kind === 'catch_up' ? ['preview', 'partly_applied', 'reading', 'applied'].includes(input.status) && actions.some((a) => a.state === 'proposed' && a.tickable) : ['preview', 'clarify', 'waiting_ai', 'partly_applied'].includes(input.status) && actions.some((a) => a.state === 'proposed' && (a.tickable || a.type === 'private_note')));
  return {
    ...s,
    text: input.text,
    extraText: input.extraText ?? null,
    understood: interp.understood,
    actions,
    questions: interp.questions.map((q) => {
      const a = answers.get(q.id);
      return { ...q, answer: a ? { optionId: a.optionId ?? null, text: a.text ?? null, date: a.date ?? null } : null };
    }),
    notDone: interp.notDone,
    pendingText: interp.pendingText,
    warnings: [...interp.warnings, ...(input.error ? [input.error] : []), ...(s.waiting ? [aiWaitingLabel(s.waiting.reason)] : [])],
    catchUp: input.kind === 'catch_up' ? catchUpView(ctx, input) : null,
    whatChanged: (input.summary as WhatChanged | undefined) ?? null,
    log: log.map((l) => ({ seq: l.seq, at: l.at, kind: l.kind, actionKey: l.actionKey ?? null, actor: l.actor, actorName: userName(ctx, l.actor), note: l.note ?? null })),
    canApply,
    canUndo: actions.some((a) => a.undo.available),
    canCancel: ['interpreting', 'waiting_ai', 'clarify', 'preview', 'reading', 'failed', 'nothing_to_do'].includes(input.status),
    canThinkAgain: input.kind === 'update' && Boolean(input.text.trim() || input.extraText) && !busy && !['cancelled', 'undone', 'applied'].includes(input.status),
    revision: input.revision,
  };
}
export type AiInputDetail = ReturnType<typeof detailView>;

const OPEN = ['interpreting', 'waiting_ai', 'clarify', 'preview', 'reading', 'applying', 'partly_applied'] as const;

export function panelView(ctx: AppContext, claimId: string) {
  const claim = ctx.repos.requireClaim(ctx.db, claimId);
  const waiting = aiWaitingReason(ctx);
  const open = ctx.repos.listAiInputs(ctx.db, { claimId, status: [...OPEN], limit: 50 }).map((i) => summaryView(ctx, i));
  const history = ctx.repos.listAiInputs(ctx.db, { claimId, limit: 20 }).map((i) => summaryView(ctx, i));
  const instructions: StandingInstructionView[] = listInstructionViews(ctx, claimId, { limit: 20 });
  return {
    claim: { id: claim.id, reference: claim.reference, status: claim.status },
    ai: { available: !waiting, waiting },
    open,
    instructions,
    history: { items: history, total: ctx.repos.countAiInputs(ctx.db, { claimId }) },
    badge: { open: open.length, instructions: instructions.filter((i) => i.status === 'active').length },
  };
}
export type AiInputPanel = ReturnType<typeof panelView>;
