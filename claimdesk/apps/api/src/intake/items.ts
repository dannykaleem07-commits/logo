// owned by intake
/**
 * Intake entry points (docs/SUPREME-DESIGN.md §G.1): every file becomes write-once evidence (on its claim, or with no
 * claim yet) and an intake item, then `intake.process` is queued.
 *
 *  - Web upload (POST /intake multipart), a chunked upload (`{uploadId}` → its staged import), the import folder
 *    (`{importId}`, or the 60-second scan of staged imports with purpose `intake`), and email attachments (the mail
 *    slice queues `intake.process {evidenceId, claimId, source:'email'}`; the item is created when that job runs).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Actor, IntakeItemRecord, IntakeSource } from '@ccguk/db';
import type { EvidenceKind } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { conflict, notFound } from '../errors.js';
import { enqueueJob } from '../agent/core.js';
import { stageExistingFile, storeEvidence, type StagedUpload } from '../services/evidence.js';
import { getStagedImport, kindFromMime, listStagedImports, markImportConsumed, markImportFailed, stagedImportPath, type StagedImport } from '../services/imports.js';
import { uploadsRoot } from '../services/uploads.js';

/** Evidence kind for an intake file before it is classified (the owner can re-file it). */
export function intakeEvidenceKind(mime: string): EvidenceKind {
  return kindFromMime(mime);
}

/** Queue `intake.process` for an item (idempotent per item; `attempt` makes a retry a new job). */
export function enqueueProcess(ctx: AppContext, item: IntakeItemRecord, createdBy: string, attempt?: string): void {
  enqueueJob(ctx, {
    type: 'intake.process',
    payload: { itemId: item.id },
    ...(item.claimId ? { claimId: item.claimId } : {}),
    idempotencyKey: `intake.process:${item.id}${attempt ? `:${attempt}` : ''}`,
    createdBy,
  });
}

export interface NewItemInput {
  source: IntakeSource;
  claimId?: string;
  parentItemId?: string;
  staged: StagedUpload;
  filename: string;
  mime: string;
  actor: Actor;
  description?: string;
}

/** Store the bytes as evidence (deduped by hash on the same claim) and create the item (one per evidence row). */
export async function createItemFromStaged(ctx: AppContext, input: NewItemInput): Promise<{ item: IntakeItemRecord; created: boolean; evidenceId: string }> {
  if (input.claimId) ctx.repos.requireClaim(ctx.db, input.claimId);
  const stored = await storeEvidence(ctx, {
    ...(input.claimId ? { claimId: input.claimId } : {}),
    staged: input.staged,
    filename: input.filename,
    mime: input.mime || 'application/octet-stream',
    fields: { kind: intakeEvidenceKind(input.mime), description: input.description ?? 'Added for intake (read by the agents)' },
    actor: input.actor,
  });
  const existing = ctx.repos.findIntakeItemByEvidence(ctx.db, stored.evidence.id, { parentItemId: input.parentItemId ?? null });
  if (existing) return { item: existing, created: false, evidenceId: stored.evidence.id };
  const item = ctx.repos.createIntakeItem(ctx.db, {
    source: input.source,
    evidenceId: stored.evidence.id,
    ...(input.claimId ? { claimId: input.claimId } : {}),
    ...(input.parentItemId ? { parentItemId: input.parentItemId } : {}),
    createdBy: input.actor.userId,
    now: ctx.now(),
  });
  ctx.repos.appendAudit(ctx.db, { actor: input.actor, action: 'intake.create', entity: 'intake_items', entityId: item.id, after: { source: item.source, evidenceId: item.evidenceId, claimId: item.claimId ?? null, parentItemId: item.parentItemId ?? null, filename: input.filename }, at: ctx.now() });
  enqueueProcess(ctx, item, input.actor.userId);
  return { item, created: true, evidenceId: stored.evidence.id };
}

/** An item for an existing evidence row (email attachments; the Evidence tab's "also read this file"). */
export function itemForEvidence(ctx: AppContext, input: { evidenceId: string; claimId?: string | null; source: IntakeSource; createdBy: string; parentItemId?: string }): IntakeItemRecord {
  const ev = ctx.repos.requireEvidence(ctx.db, input.evidenceId);
  const existing = ctx.repos.findIntakeItemByEvidence(ctx.db, ev.id, input.parentItemId ? { parentItemId: input.parentItemId } : {});
  if (existing) return existing;
  const claimId = input.claimId ?? ev.claimId ?? undefined;
  const item = ctx.repos.createIntakeItem(ctx.db, { source: input.source, evidenceId: ev.id, ...(claimId ? { claimId } : {}), ...(input.parentItemId ? { parentItemId: input.parentItemId } : {}), createdBy: input.createdBy, now: ctx.now() });
  ctx.repos.appendAudit(ctx.db, { actor: { userId: input.createdBy }, action: 'intake.create', entity: 'intake_items', entityId: item.id, after: { source: item.source, evidenceId: ev.id, claimId: claimId ?? null, parentItemId: item.parentItemId ?? null, filename: ev.filename }, at: ctx.now() });
  return item;
}

/** A staged import (purpose `intake`) → evidence + item; the import is marked consumed by `intake`. */
export async function consumeStagedImport(ctx: AppContext, importId: string, opts: { claimId?: string; actor: Actor }): Promise<{ item: IntakeItemRecord; created: boolean }> {
  const imp = getStagedImport(ctx, importId);
  if (!imp) throw notFound('import', importId);
  if (imp.status === 'consumed') {
    const res = (imp.result ?? {}) as { itemId?: string };
    const prior = imp.consumedBy === 'intake' && res.itemId ? ctx.repos.getIntakeItem(ctx.db, res.itemId) : undefined;
    if (prior) return { item: prior, created: false };
    throw conflict('IMPORT_CONSUMED', `Import ${importId} was already used by ${imp.consumedBy ?? 'another step'}`, { consumedBy: imp.consumedBy });
  }
  const file = stagedImportPath(ctx, importId);
  if (!existsSync(file)) throw conflict('IMPORT_FILE_MISSING', `The file for import ${importId} is no longer in the imports folder`);
  let claimId = opts.claimId;
  if (!claimId && imp.claimRef) claimId = ctx.repos.getClaimByReference(ctx.db, imp.claimRef)?.id;
  const staged = stageExistingFile(ctx, file, imp.sha256, imp.bytes);
  const { item, created } = await createItemFromStaged(ctx, {
    source: imp.source === 'folder' ? 'folder' : 'upload',
    ...(claimId ? { claimId } : {}),
    staged,
    filename: imp.filename,
    mime: imp.mime,
    actor: opts.actor,
  });
  markImportConsumed(ctx, importId, 'intake', { itemId: item.id, evidenceId: item.evidenceId });
  return { item, created };
}

/** A completed chunked upload (purpose `intake`) → its staged import → item. */
export async function consumeUpload(ctx: AppContext, uploadId: string, opts: { claimId?: string; actor: Actor }): Promise<{ item: IntakeItemRecord; created: boolean }> {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(uploadId)) throw notFound('upload', uploadId);
  const file = path.join(uploadsRoot(ctx), uploadId, 'session.json');
  if (!existsSync(file)) throw notFound('upload', uploadId);
  let session: { status?: string; purpose?: string; result?: { importId?: string } };
  try {
    session = JSON.parse(readFileSync(file, 'utf8')) as typeof session;
  } catch {
    throw conflict('UPLOAD_CORRUPT', `Upload ${uploadId} cannot be read`);
  }
  if (session.status !== 'complete' || !session.result?.importId) throw conflict('UPLOAD_INCOMPLETE', 'Finish the upload (POST /uploads/:id/complete) before reading it');
  if (session.purpose !== 'intake') throw conflict('UPLOAD_PURPOSE', `Upload ${uploadId} was made for ${session.purpose ?? 'another purpose'}, not intake`);
  return consumeStagedImport(ctx, session.result.importId, opts);
}

/** System actor for the folder scan. */
export const INTAKE_SCAN_ACTOR: Actor = { userId: 'agent:intake' };

/**
 * Pick up every staged import with purpose `intake` (the import folder's `intake\` and chunked uploads not yet
 * claimed). Idempotent: consumed imports are skipped; a failure marks that import failed and the scan continues.
 */
export async function scanStagedIntakeImports(ctx: AppContext): Promise<{ created: number; failed: number }> {
  let created = 0;
  let failed = 0;
  const staged: StagedImport[] = listStagedImports(ctx, { purpose: 'intake', status: 'staged' });
  for (const imp of staged.reverse()) {
    try {
      const r = await consumeStagedImport(ctx, imp.id, { actor: INTAKE_SCAN_ACTOR });
      if (r.created) created += 1;
    } catch (err) {
      failed += 1;
      ctx.logger.warn('intake: a staged import could not be read', { importId: imp.id, error: String(err) });
      try {
        markImportFailed(ctx, imp.id, err instanceof Error ? err.message : String(err));
      } catch {
        /* already consumed elsewhere */
      }
    }
  }
  return { created, failed };
}
