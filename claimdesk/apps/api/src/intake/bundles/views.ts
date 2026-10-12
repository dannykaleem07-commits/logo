// owned by intake-server
/**
 * JSON views of bundles (docs/SMART-INTAKE.md §8.1): `BundleSummary`, `BundleDetail`, `BundleFileView` and the cheap
 * progress view the web polls every 3 s. The detail recomputes first when the stored computation is older than the
 * bundle's revision (open bundles only; a closed bundle shows what it was registered/attached/cancelled with).
 */
import type { BundleComputed, Blocker, RiskSignal } from '@ccguk/domain';
import type { IntakeBundleFileRecord, IntakeBundleRecord } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { docTypeLabel } from '../proposals.js';
import type { NormalisedDoc } from '../normalise.js';
import { itemWaiting } from '../views.js';
import { CLOSED_STATUSES } from './hooks.js';
import { aiWaiting, computeBundle, recomputeBundle } from './recompute.js';

export type FileStage = 'stored' | 'reading' | 'splitting' | 'waiting_ai' | 'reading_ai' | 'read' | 'read_rules_only' | 'unpacked' | 'skipped' | 'failed';
export type Readiness = 'reading' | 'needs_review' | 'ready_to_register' | 'registered' | 'attached' | 'cancelled';
type Waiting = { reason: 'agents_off' | 'kill_switch' | 'usage' | 'sign_in'; until?: string } | null;

const STAGE_LABEL: Record<FileStage, string> = {
  stored: 'Stored — waiting to be read',
  reading: 'Reading',
  splitting: 'Splitting into separate documents',
  waiting_ai: 'Read from its text — the AI will check it when agents are back',
  reading_ai: 'Read from its text — the AI is reading it now',
  read: 'Read',
  read_rules_only: 'Read from its text only',
  unpacked: 'Unpacked',
  skipped: 'Not something intake can read',
  failed: 'Could not be read',
};
const WAITING_LABEL: Record<string, string> = {
  agents_off: 'Waiting for the AI — agents are off',
  kill_switch: 'Waiting for the AI — the kill switch is on',
  usage: 'Waiting for the AI — usage limit reached',
  sign_in: 'Waiting for the AI — AI sign-in needs fixing',
};

interface StageInfo {
  stage: FileStage;
  stageLabel: string;
  waiting: Waiting;
}

function pendingSplitItems(ctx: AppContext): Set<string> {
  return new Set(
    ctx.repos
      .listAgentJobs(ctx.db, { type: 'intake.split', status: ['queued', 'leased', 'waiting_usage'], limit: 2000 })
      .map((j) => (j.payload as { itemId?: string } | undefined)?.itemId)
      .filter((x): x is string => Boolean(x)),
  );
}

export function fileStage(ctx: AppContext, f: IntakeBundleFileRecord, splitting: Set<string>): StageInfo {
  const item = ctx.repos.getIntakeItem(ctx.db, f.intakeItemId);
  if (!item) return { stage: 'failed', stageLabel: STAGE_LABEL.failed, waiting: null };
  const doc = item.normalised as NormalisedDoc | undefined;
  const engines = ctx.repos.listIntakeExtractions(ctx.db, item.id).map((e) => ctx.repos.extractionEngine(e));
  const hasAi = engines.includes('ai');
  const hasRules = engines.includes('rules');
  const mk = (stage: FileStage, waiting: Waiting = null, label?: string): StageInfo => ({ stage, stageLabel: label ?? STAGE_LABEL[stage], waiting });
  if (splitting.has(item.id)) return mk('splitting');
  switch (item.status) {
    case 'queued':
      return mk('stored');
    case 'normalising':
      return mk('reading');
    case 'failed':
      return mk('failed');
    case 'skipped':
      return doc?.kind === 'archive' && (doc.entries?.length ?? 0) > 0 ? mk('unpacked') : mk('skipped');
    case 'extracting':
    case 'quota_wait': {
      if (hasAi) return mk('read');
      const w = itemWaiting(ctx, item) ?? (item.status === 'quota_wait' ? aiWaiting(ctx) : null);
      if (w) return mk('waiting_ai', w, hasRules ? STAGE_LABEL.waiting_ai : WAITING_LABEL[w.reason]);
      return mk(hasRules ? 'reading_ai' : 'reading');
    }
    default:
      return mk(hasAi ? 'read' : hasRules ? 'read_rules_only' : 'read');
  }
}

function readiness(b: IntakeBundleRecord, c: BundleComputed | undefined): Readiness {
  if (b.status === 'registered' || b.status === 'attached' || b.status === 'cancelled') return b.status;
  if (b.status === 'open' || b.status === 'reading' || b.status === 'reconciling') return 'reading';
  if (b.status === 'registering') return 'needs_review';
  return c?.register.canRegister ? 'ready_to_register' : 'needs_review';
}

function reasoningView(ctx: AppContext, b: IntakeBundleRecord): { status: IntakeBundleRecord['reasoningStatus']; at: string | null; waiting: Waiting } {
  const latest = ctx.repos.latestBundleReasoning(ctx.db, b.id);
  let status = b.reasoningStatus;
  let waiting: Waiting = null;
  if (status === 'queued' || status === 'waiting_ai') {
    const w = aiWaiting(ctx);
    if (w) {
      status = 'waiting_ai';
      waiting = w;
    }
  }
  return { status, at: latest?.createdAt ?? null, waiting };
}

function computedOf(b: IntakeBundleRecord): BundleComputed | undefined {
  return b.computed && typeof b.computed === 'object' ? (b.computed as BundleComputed) : undefined;
}

export function bundleSummary(ctx: AppContext, bundle: IntakeBundleRecord, opts: { files?: IntakeBundleFileRecord[]; stages?: Map<string, StageInfo> } = {}) {
  const b = bundle;
  const c = computedOf(b);
  const files = opts.files ?? ctx.repos.listBundleFiles(ctx.db, b.id);
  const splitting = opts.stages ? new Set<string>() : pendingSplitItems(ctx);
  const stages = opts.stages ?? new Map(files.map((f) => [f.id, fileStage(ctx, f, splitting)]));
  const st = [...stages.values()].map((s) => s.stage);
  const count = (...xs: FileStage[]) => st.filter((s) => xs.includes(s)).length;
  const settings = ctx.repos.getAgentSettings(ctx.db).intake;
  const claim = b.claimId ? ctx.repos.getClaim(ctx.db, b.claimId) : undefined;
  const signals: RiskSignal[] = c?.signals ?? [];
  return {
    id: b.id,
    name: b.name,
    status: b.status,
    readiness: readiness(b, c),
    source: b.source,
    folderKey: b.folderKey ?? null,
    parentBundleId: b.parentBundleId ?? null,
    revision: b.revision,
    computedRevision: b.computedRevision ?? null,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    createdBy: b.createdBy,
    fileCounts: {
      total: files.length,
      read: count('read', 'read_rules_only', 'unpacked'),
      inProgress: count('stored', 'reading', 'splitting', 'reading_ai'),
      waitingAi: count('waiting_ai'),
      failed: count('failed'),
      skipped: count('skipped'),
      duplicates: c ? Object.values(c.files).filter((f) => f.duplicate).length : 0,
    },
    groupCount: c?.groups.length ?? 0,
    conflictsOpen: c?.conflicts.filter((x) => x.status === 'open').length ?? 0,
    missingDocs: c?.checklist.items.filter((i) => i.status === 'missing' || i.status === 'partial').length ?? 0,
    signals: { warn: signals.filter((s) => s.severity === 'warn' && !s.acknowledged).length, info: signals.filter((s) => s.severity === 'info' && !s.acknowledged).length },
    reasoning: reasoningView(ctx, b),
    autoRegister: { settingOn: settings.bundles.autoRegister, eligible: Boolean(c?.auto.eligible) && b.autoEligible, blockers: (c?.auto.blockers ?? []) as Blocker[] },
    claim: claim ? { id: claim.id, reference: claim.reference } : null,
    needsYouId: b.needsYouId ?? null,
    error: b.error ?? null,
  };
}
export type BundleSummaryView = ReturnType<typeof bundleSummary>;

export function fileView(ctx: AppContext, f: IntakeBundleFileRecord, stage: StageInfo, c: BundleComputed | undefined) {
  const item = ctx.repos.getIntakeItem(ctx.db, f.intakeItemId);
  const ev = ctx.repos.getEvidence(ctx.db, f.evidenceId);
  const doc = item?.normalised as NormalisedDoc | undefined;
  const best = item ? ctx.repos.bestIntakeExtraction(ctx.db, item.id) : undefined;
  const fc = c?.files[f.id];
  const docType = fc?.docType ?? (item?.docType as string | undefined) ?? null;
  const skipped = (doc?.entries ?? []).filter((e) => e.outcome === 'skipped').map((e) => ({ name: e.name, reason: e.reason ?? 'skipped' }));
  return {
    id: f.id,
    itemId: f.intakeItemId,
    evidenceId: f.evidenceId,
    filename: ev?.filename ?? '(missing file)',
    mime: ev?.mime ?? 'application/octet-stream',
    bytes: ev?.bytes ?? 0,
    sha256: ev?.sha256 ?? '',
    addedAt: f.addedAt,
    position: f.position,
    role: f.role,
    parentFileId: f.parentFileId ?? null,
    segment: f.pageFrom && f.pageTo ? { fromPage: f.pageFrom, toPage: f.pageTo } : null,
    stage: stage.stage,
    stageLabel: stage.stageLabel,
    waiting: stage.waiting,
    error: item?.error ?? null,
    docType,
    docTypeLabel: docType ? docTypeLabel(docType) : null,
    docTypeConfidence: item?.docTypeConfidence ?? null,
    docSide: fc?.docSide ?? null,
    documentDate: fc?.documentDate ?? null,
    pages: item?.pages ?? doc?.pages ?? null,
    summary: best?.summary ?? null,
    engine: fc?.engine ?? (best ? ctx.repos.extractionEngine(best) : null),
    groupKey: fc?.groupKey ?? 'unsure',
    pinned: fc?.pinned ?? false,
    excluded: fc?.excluded ?? false,
    duplicate: fc?.duplicate ?? null,
    photo: fc?.photo ?? null,
    pdfMeta: doc?.pdfMeta ?? null,
    archive: doc?.kind === 'archive' ? { entries: (doc.entries ?? []).filter((e) => e.outcome === 'item').length, skipped } : null,
    filed: f.filedEvidenceId && f.filedClaimId ? { evidenceId: f.filedEvidenceId, claimId: f.filedClaimId, kind: f.filedKind ?? 'document', at: f.filedAt ?? f.updatedAt } : null,
    fileUrl: `/api/evidence/${f.evidenceId}/file`,
  };
}

/** The full bundle (recomputed first when stale and still open). */
export function bundleDetail(ctx: AppContext, bundleId: string) {
  let b = ctx.repos.requireIntakeBundle(ctx.db, bundleId);
  const open = !CLOSED_STATUSES.has(b.status) && b.status !== 'registering';
  if (open && (b.computedRevision ?? -1) < b.revision) b = recomputeBundle(ctx, b.id).bundle;
  let c = computedOf(b);
  if (!c) c = computeBundle(ctx, b.id).computed;
  const files = ctx.repos.listBundleFiles(ctx.db, b.id);
  const splitting = pendingSplitItems(ctx);
  const stages = new Map(files.map((f) => [f.id, fileStage(ctx, f, splitting)]));
  const decisions = ctx.repos.listBundleDecisions(ctx.db, b.id).slice(-50).reverse();
  return {
    ...bundleSummary(ctx, { ...b, computed: c }, { files, stages }),
    files: files.map((f) => fileView(ctx, f, stages.get(f.id)!, c)),
    groups: c.groups,
    draft: c.draft,
    conflicts: c.conflicts,
    checklist: c.checklist,
    timeline: c.timeline,
    signals: c.signals,
    liability: c.liability,
    register: c.register,
    aiSummary: c.aiSummary,
    decisions: decisions.map((d) => ({ id: d.id, kind: d.kind, subject: d.subject ?? null, before: d.before ?? null, after: d.after ?? null, note: d.note ?? null, actor: d.actor, at: d.at })),
  };
}
export type BundleDetailView = ReturnType<typeof bundleDetail>;

export function bundleProgress(ctx: AppContext, bundleId: string) {
  const b = ctx.repos.requireIntakeBundle(ctx.db, bundleId);
  const files = ctx.repos.listBundleFiles(ctx.db, b.id);
  const splitting = pendingSplitItems(ctx);
  const stages = new Map(files.map((f) => [f.id, fileStage(ctx, f, splitting)]));
  return {
    bundle: bundleSummary(ctx, b, { files, stages }),
    files: files.map((f) => {
      const s = stages.get(f.id)!;
      return { id: f.id, filename: ctx.repos.getEvidence(ctx.db, f.evidenceId)?.filename ?? '(missing file)', stage: s.stage, stageLabel: s.stageLabel, waiting: s.waiting };
    }),
  };
}
