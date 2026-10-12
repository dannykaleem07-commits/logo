// owned by intake-server
/**
 * Bundle service (docs/SMART-INTAKE.md §6, §6.3): create, rename, add files, cancel, reopen, and the owner decision
 * helper `decide` (append the decision → bump the revision → audit → recompute synchronously). Files never disappear:
 * excluding, moving and splitting off are decisions; the computed state is re-derived every time.
 */
import type { Actor, BundleDecisionKind, BundleSource, IntakeBundleRecord, IntakeItemRecord } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { conflict, notFound } from '../../errors.js';
import type { StagedUpload } from '../../services/evidence.js';
import { consumeStagedImport, consumeUpload, createItemFromStaged, enqueueProcess, itemForEvidence } from '../items.js';
import type { NormalisedDoc } from '../normalise.js';
import { storeRulesReading } from '../rules.js';
import { CLOSED_STATUSES, touchBundle } from './hooks.js';
import { openCard, recomputeBundle, type BundleState } from './recompute.js';

export function requireBundle(ctx: AppContext, id: string): IntakeBundleRecord {
  const b = ctx.repos.getIntakeBundle(ctx.db, id);
  if (!b) throw notFound('intake bundle', id);
  return b;
}

/** A bundle the owner can still change (not registered, attached, cancelled or being registered). */
export function requireOpenBundle(ctx: AppContext, id: string): IntakeBundleRecord {
  const b = requireBundle(ctx, id);
  if (CLOSED_STATUSES.has(b.status)) throw conflict('BUNDLE_CLOSED', `This bundle is ${b.status}${b.status === 'cancelled' ? ' — reopen it first' : ''}`, { status: b.status });
  if (b.status === 'registering') throw conflict('BUNDLE_BUSY', 'This bundle is being registered right now');
  return b;
}

export function createBundle(ctx: AppContext, input: { name: string; source?: BundleSource; folderKey?: string; parentBundleId?: string; splitFromGroup?: string }, actor: Actor): IntakeBundleRecord {
  const now = ctx.now();
  const bundle = ctx.repos.createIntakeBundle(ctx.db, {
    name: input.name.trim().slice(0, 120),
    source: input.source ?? 'upload',
    ...(input.folderKey ? { folderKey: input.folderKey } : {}),
    ...(input.parentBundleId ? { parentBundleId: input.parentBundleId } : {}),
    ...(input.splitFromGroup ? { splitFromGroup: input.splitFromGroup } : {}),
    createdBy: actor.userId,
    now,
  });
  ctx.repos.appendBundleDecision(ctx.db, { bundleId: bundle.id, revision: bundle.revision, kind: 'create', after: { name: bundle.name, source: bundle.source }, actor: actor.userId, ...(actor.runId ? { runId: actor.runId } : {}), at: now });
  ctx.repos.appendAudit(ctx.db, { actor, action: 'intake.bundle.create', entity: 'intake_bundles', entityId: bundle.id, after: { name: bundle.name, source: bundle.source, folderKey: bundle.folderKey ?? null, parentBundleId: bundle.parentBundleId ?? null }, at: now });
  return bundle;
}

export function renameBundle(ctx: AppContext, id: string, name: string, actor: Actor): IntakeBundleRecord {
  const b = requireBundle(ctx, id);
  const now = ctx.now();
  const clean = name.trim().slice(0, 120);
  if (clean === b.name) return b;
  const revision = ctx.repos.bumpBundleRevision(ctx.db, b.id, now);
  ctx.repos.appendBundleDecision(ctx.db, { bundleId: b.id, revision, kind: 'rename', before: { name: b.name }, after: { name: clean }, actor: actor.userId, at: now });
  const out = ctx.repos.updateIntakeBundle(ctx.db, b.id, { name: clean }, now);
  ctx.repos.appendAudit(ctx.db, { actor, action: 'intake.bundle.rename', entity: 'intake_bundles', entityId: b.id, before: { name: b.name }, after: { name: clean }, at: now });
  if (!CLOSED_STATUSES.has(out.status) && out.status !== 'registering') recomputeBundle(ctx, b.id);
  return ctx.repos.requireIntakeBundle(ctx.db, b.id);
}

export interface AddedFile {
  fileId: string;
  itemId: string;
  filename: string;
  outcome: 'added' | 'already_in_bundle';
}

/** Role of a top-level file by its name and type (children get theirs from the pipeline hooks). */
function roleFor(filename: string, mime: string): 'document' | 'archive' | 'email' {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (ext === 'zip' || mime === 'application/zip' || mime === 'application/x-zip-compressed') return 'archive';
  if (ext === 'eml' || mime === 'message/rfc822') return 'email';
  return 'document';
}

/**
 * Put an intake item in the bundle. An item read before it joined a bundle (an earlier upload of the same bytes) gets
 * its rules reading now, so the bundle can use it without reading the file again.
 */
export function addItemToBundle(ctx: AppContext, bundle: IntakeBundleRecord, item: IntakeItemRecord, actor: Actor): AddedFile {
  const ev = ctx.repos.requireEvidence(ctx.db, item.evidenceId);
  const r = ctx.repos.addBundleFile(ctx.db, { bundleId: bundle.id, intakeItemId: item.id, evidenceId: item.evidenceId, role: roleFor(ev.filename, ev.mime), addedBy: actor.userId, now: ctx.now() });
  if (r.created) {
    const doc = item.normalised as NormalisedDoc | undefined;
    const hasRules = ctx.repos.listIntakeExtractions(ctx.db, item.id).some((e) => ctx.repos.extractionEngine(e) === 'rules');
    if (doc?.pageTexts?.length && !hasRules && !['queued', 'normalising'].includes(item.status)) storeRulesReading(ctx, item, doc, ev.filename);
    // children already made from this item (EML attachments, ZIP entries, segments) join too
    for (const child of ctx.repos.listIntakeItems(ctx.db, { parentItemId: item.id })) {
      ctx.repos.addBundleFile(ctx.db, { bundleId: bundle.id, intakeItemId: child.id, evidenceId: child.evidenceId, parentFileId: r.file.id, role: 'attachment', addedBy: actor.userId, now: ctx.now() });
    }
  }
  return { fileId: r.file.id, itemId: item.id, filename: ev.filename, outcome: r.created ? 'added' : 'already_in_bundle' };
}

export type AddSource = { staged: StagedUpload; filename: string; mime: string } | { uploadId: string } | { importId: string } | { evidenceId: string };

/** Add files (multipart staged files, a chunked upload, a staged import or stored evidence) to an open bundle. */
export async function addFilesToBundle(ctx: AppContext, bundleId: string, sources: AddSource[], actor: Actor): Promise<AddedFile[]> {
  let bundle = requireOpenBundle(ctx, bundleId);
  const out: AddedFile[] = [];
  for (const s of sources) {
    let item: IntakeItemRecord;
    if ('staged' in s) item = (await createItemFromStaged(ctx, { source: 'upload', staged: s.staged, filename: s.filename, mime: s.mime, actor, description: `Added to the intake bundle '${bundle.name}'` })).item;
    else if ('uploadId' in s) item = (await consumeUpload(ctx, s.uploadId, { actor })).item;
    else if ('importId' in s) item = (await consumeStagedImport(ctx, s.importId, { actor })).item;
    else {
      const ev = ctx.repos.requireEvidence(ctx.db, s.evidenceId);
      const existing = ctx.repos.findIntakeItemByEvidence(ctx.db, ev.id);
      item = existing ?? itemForEvidence(ctx, { evidenceId: ev.id, claimId: ev.claimId ?? null, source: 'upload', createdBy: actor.userId });
      if (!existing) enqueueProcess(ctx, item, actor.userId);
    }
    out.push(addItemToBundle(ctx, bundle, ctx.repos.requireIntakeItem(ctx.db, item.id), actor));
  }
  const added = out.filter((f) => f.outcome === 'added');
  const now = ctx.now();
  if (added.length) {
    bundle = ctx.repos.requireIntakeBundle(ctx.db, bundle.id);
    const revision = touchBundle(ctx, bundle);
    ctx.repos.appendBundleDecision(ctx.db, { bundleId: bundle.id, revision, kind: 'add_files', after: { fileIds: added.map((f) => f.fileId), filenames: added.map((f) => f.filename) }, actor: actor.userId, ...(actor.runId ? { runId: actor.runId } : {}), at: now });
  }
  ctx.repos.appendAudit(ctx.db, { actor, action: 'intake.bundle.add_files', entity: 'intake_bundles', entityId: bundle.id, after: { added: added.length, already: out.length - added.length, files: out.map((f) => ({ fileId: f.fileId, itemId: f.itemId, filename: f.filename, outcome: f.outcome })) }, at: now });
  return out;
}

export interface DecisionInput {
  kind: BundleDecisionKind;
  subject?: string | null;
  before?: unknown;
  after?: unknown;
  note?: string | null;
  /** Audit action suffix when it differs from the kind (e.g. include_file). */
  auditKind?: string;
  /** Extra audit fields (never page text). */
  audit?: Record<string, unknown>;
}

/** An owner decision: append → bump revision → audit → recompute (synchronously). */
export function decide(ctx: AppContext, bundleId: string, d: DecisionInput, actor: Actor, opts: { allowClosed?: boolean } = {}): BundleState {
  const b = opts.allowClosed ? requireBundle(ctx, bundleId) : requireOpenBundle(ctx, bundleId);
  const now = ctx.now();
  const revision = ctx.repos.bumpBundleRevision(ctx.db, b.id, now);
  ctx.repos.appendBundleDecision(ctx.db, {
    bundleId: b.id,
    revision,
    kind: d.kind,
    ...(d.subject ? { subject: d.subject } : {}),
    ...(d.before !== undefined ? { before: d.before } : {}),
    ...(d.after !== undefined ? { after: d.after } : {}),
    ...(d.note ? { note: d.note } : {}),
    actor: actor.userId,
    ...(actor.runId ? { runId: actor.runId } : {}),
    at: now,
  });
  ctx.repos.appendAudit(ctx.db, {
    actor,
    action: `intake.bundle.${d.auditKind ?? d.kind}`,
    entity: 'intake_bundles',
    entityId: b.id,
    after: { revision, subject: d.subject ?? null, ...(d.audit ?? {}) },
    at: now,
  });
  return recomputeBundle(ctx, b.id);
}

/** Cancel: the files stay (claimless evidence); the open card is superseded. */
export function cancelBundle(ctx: AppContext, bundleId: string, reason: string, actor: Actor, opts: { viaCardId?: string } = {}): IntakeBundleRecord {
  const b = requireOpenBundle(ctx, bundleId);
  const now = ctx.now();
  const revision = ctx.repos.bumpBundleRevision(ctx.db, b.id, now);
  ctx.repos.appendBundleDecision(ctx.db, { bundleId: b.id, revision, kind: 'cancel', note: reason, actor: actor.userId, at: now });
  const card = openCard(ctx, b);
  if (card && card.id !== opts.viaCardId) ctx.repos.transitionNeedsYou(ctx.db, card.id, { to: 'superseded', actor: actor.userId, note: `bundle cancelled: ${reason}`.slice(0, 500), now });
  const out = ctx.repos.updateIntakeBundle(ctx.db, b.id, { status: 'cancelled', closedBy: actor.userId, closedAt: now }, now);
  ctx.repos.appendAudit(ctx.db, { actor, action: 'intake.bundle.cancel', entity: 'intake_bundles', entityId: b.id, after: { reason: reason.slice(0, 500), revision }, at: now });
  return out;
}

/** Reopen a cancelled bundle (registered / attached bundles stay closed). */
export function reopenBundle(ctx: AppContext, bundleId: string, actor: Actor): IntakeBundleRecord {
  const b = requireBundle(ctx, bundleId);
  if (b.status !== 'cancelled') throw conflict('BUNDLE_NOT_CANCELLED', b.status === 'registered' || b.status === 'attached' ? `This bundle was ${b.status}; it cannot be reopened` : 'Only a cancelled bundle can be reopened', { status: b.status });
  const now = ctx.now();
  ctx.repos.updateIntakeBundle(ctx.db, b.id, { status: 'reconciling', closedBy: null, closedAt: null, needsYouId: null }, now);
  const revision = touchBundle(ctx, ctx.repos.requireIntakeBundle(ctx.db, b.id), { delaySeconds: 0 });
  ctx.repos.appendBundleDecision(ctx.db, { bundleId: b.id, revision, kind: 'reopen', actor: actor.userId, at: now });
  ctx.repos.appendAudit(ctx.db, { actor, action: 'intake.bundle.reopen', entity: 'intake_bundles', entityId: b.id, after: { revision }, at: now });
  recomputeBundle(ctx, b.id);
  return ctx.repos.requireIntakeBundle(ctx.db, b.id);
}
