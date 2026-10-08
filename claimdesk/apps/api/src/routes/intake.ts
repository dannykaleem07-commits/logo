// owned by intake
/**
 * Intake routes (docs/SUPREME-DESIGN.md §G, §N.6, §L.8). Registered by routes/index.ts (foundation).
 *
 *   POST /intake                        multipart (files up to 512 MiB each, per-route limit) with optional claimId, or
 *                                       JSON {uploadId} (a completed chunked upload, purpose intake) / {importId} (a
 *                                       staged import) / {evidenceId} (evidence already stored: "also read this file")
 *   GET  /intake?status=&claimId=&limit=&offset=     items (claimId=none → items with no claim)
 *   GET  /intake/:id                    item detail: page text, extractions, proposals, children, open cards
 *   POST /intake/:id/retry {from?, claimId?}         re-run from process / extract / apply; claimId links it first
 *   POST /intake/new-claim-draft {itemIds}           CreateClaimBody prefill + per-field sources (stored under an id)
 *   GET  /intake/new-claim-draft/:id                 that draft (the New Claim wizard reads it with ?intakeDraft=)
 *   GET  /claims/:id/proposals?status=
 *   POST /proposals/apply {ids, values?}             as the owner (any pending proposal) or as an agent run (auto only)
 *   POST /proposals/reject {ids, reason}             owner only
 *
 * With JOBS_ENABLED=true (never in tests) an idempotent scan picks up staged imports with purpose `intake` every 60 s.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IntakeItemRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { badRequest, HttpError } from '../errors.js';
import { parse } from '../schemas/common.js';
import { discardStaged, stageStream, type StagedUpload } from '../services/evidence.js';
import { enqueueJob } from '../agent/core.js';
import { jobsEnabled } from '../jobs.js';
import { attachItemToClaim } from '../agent/handlers/intake.js';
import { applyProposals, ownerApplier, rejectProposals, type Applier } from '../intake/apply.js';
import { installCallerContext } from '../intake/callerContext.js';
import { consumeStagedImport, consumeUpload, createItemFromStaged, enqueueProcess, itemForEvidence, scanStagedIntakeImports } from '../intake/items.js';
import { buildNewClaimDraft, requireDraft } from '../intake/newClaimDraft.js';
import { settleItemStatus } from '../intake/pipeline.js';
import { itemDetail, itemRow, proposalView } from '../intake/views.js';
import { params, requireClaim } from './helpers.js';

const MIB = 1024 * 1024;
/** §G.1: multipart intake uploads up to 512 MiB per file (the app-wide default stays 25 MiB). */
export const INTAKE_MAX_FILE_BYTES = 512 * MIB;
export const INTAKE_MAX_FILES = 10;
/** The staged-import scan interval (JOBS_ENABLED only). */
export const INTAKE_SCAN_MS = 60_000;

const STATUSES = ['queued', 'normalising', 'extracting', 'proposed', 'applied', 'needs_you', 'failed', 'quota_wait', 'skipped'] as const;

const jsonBody = z
  .object({
    uploadId: z.string().min(1).optional(),
    importId: z.string().min(1).optional(),
    evidenceId: z.string().min(1).optional(),
    claimId: z.string().min(1).optional(),
  })
  .refine((b) => [b.uploadId, b.importId, b.evidenceId].filter(Boolean).length === 1, 'Give exactly one of uploadId, importId or evidenceId (or upload the file as multipart)');

const listQuery = z.object({
  status: z.string().optional(),
  claimId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const retryBody = z.object({ from: z.enum(['process', 'extract', 'apply']).optional(), claimId: z.string().min(1).optional() }).default({});
const draftBody = z.object({ itemIds: z.array(z.string().min(1)).min(1).max(50) });
const applyBody = z.object({ ids: z.array(z.string().min(1)).min(1).max(200), values: z.record(z.string()).optional(), claimId: z.string().optional() });
const rejectBody = z.object({ ids: z.array(z.string().min(1)).min(1).max(200), reason: z.string().trim().min(3).max(2000) });
const proposalsQuery = z.object({ status: z.enum(['pending', 'applied', 'rejected', 'superseded']).optional() });

function contentLength(request: FastifyRequest): number | undefined {
  const raw = request.headers['content-length'];
  const n = raw === undefined ? NaN : Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function tooLarge(): HttpError {
  return new HttpError(413, 'FILE_TOO_LARGE', `A file for intake can be up to ${INTAKE_MAX_FILE_BYTES / MIB} MB; larger files go through the chunked upload or the import folder`, { limitBytes: INTAKE_MAX_FILE_BYTES, useChunked: true });
}

/** Mark the open confirm card superseded once nothing on it is pending any more. */
function closeSettledCards(ctx: AppContext, itemIds: Iterable<string>, actor: string): void {
  for (const itemId of itemIds) {
    settleItemStatus(ctx, itemId);
    const pending = ctx.repos.listClaimUpdateProposals(ctx.db, { intakeItemId: itemId, status: 'pending' });
    if (pending.length) continue;
    const card = ctx.repos.findOpenNeedsYouByDedupeKey(ctx.db, `confirm_fields:${itemId}`);
    if (card) ctx.repos.transitionNeedsYou(ctx.db, card.id, { to: 'superseded', actor, note: 'every field on this card was decided on the Intake screen', now: ctx.now() });
  }
}

export function registerIntakeRoutes(app: FastifyInstance, ctx: AppContext): void {
  installCallerContext(app);

  if (jobsEnabled(ctx)) {
    let timer: NodeJS.Timeout | undefined;
    let running = false;
    const scan = async () => {
      if (running) return;
      running = true;
      try {
        await scanStagedIntakeImports(ctx);
      } catch (err) {
        ctx.logger.warn('intake: staged import scan failed', { error: String(err) });
      } finally {
        running = false;
      }
    };
    app.addHook('onReady', async () => {
      timer = setInterval(() => void scan(), INTAKE_SCAN_MS);
      timer.unref();
      void scan();
    });
    app.addHook('onClose', async () => {
      if (timer) clearInterval(timer);
    });
  }

  app.post('/intake', async (request, reply) => {
    const items: IntakeItemRecord[] = [];
    if (request.isMultipart()) {
      const declared = contentLength(request);
      if (declared !== undefined && declared > INTAKE_MAX_FILE_BYTES * INTAKE_MAX_FILES + MIB) throw tooLarge();
      const staged: Array<{ staged: StagedUpload; filename: string; mime: string }> = [];
      const fields: Record<string, string> = {};
      try {
        // Per-call limits are deep-merged over the plugin's 25 MiB by @fastify/multipart, so 512 MiB applies here only.
        for await (const part of request.parts({ limits: { fileSize: INTAKE_MAX_FILE_BYTES, files: INTAKE_MAX_FILES, fields: 20 } })) {
          if (part.type === 'file') {
            const s = await stageStream(ctx, part.file);
            if (part.file.truncated) {
              discardStaged(s);
              throw tooLarge();
            }
            if (s.bytes === 0) {
              discardStaged(s);
              continue;
            }
            staged.push({ staged: s, filename: part.filename || 'upload', mime: part.mimetype || 'application/octet-stream' });
          } else {
            fields[part.fieldname] = typeof part.value === 'string' ? part.value : String(part.value);
          }
        }
        if (!staged.length) throw badRequest('No file in the upload');
        const claimId = fields.claimId?.trim() || undefined;
        if (claimId) requireClaim(ctx, claimId);
        while (staged.length) {
          const s = staged.shift()!;
          const r = await createItemFromStaged(ctx, { source: 'upload', ...(claimId ? { claimId } : {}), staged: s.staged, filename: s.filename, mime: s.mime, actor: request.actor });
          items.push(r.item);
        }
      } catch (err) {
        for (const s of staged) discardStaged(s.staged);
        if ((err as { code?: string })?.code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge();
        throw err;
      }
    } else {
      const body = parse(jsonBody, request.body ?? {});
      if (body.claimId) requireClaim(ctx, body.claimId);
      if (body.uploadId) items.push((await consumeUpload(ctx, body.uploadId, { ...(body.claimId ? { claimId: body.claimId } : {}), actor: request.actor })).item);
      else if (body.importId) items.push((await consumeStagedImport(ctx, body.importId, { ...(body.claimId ? { claimId: body.claimId } : {}), actor: request.actor })).item);
      else if (body.evidenceId) {
        const ev = ctx.repos.requireEvidence(ctx.db, body.evidenceId);
        if (body.claimId && ev.claimId && ev.claimId !== body.claimId) throw badRequest('That evidence is on another claim');
        const existing = ctx.repos.findIntakeItemByEvidence(ctx.db, ev.id);
        const item = existing ?? itemForEvidence(ctx, { evidenceId: ev.id, claimId: body.claimId ?? ev.claimId ?? null, source: 'upload', createdBy: request.actor.userId });
        if (!existing) enqueueProcess(ctx, item, request.actor.userId);
        items.push(item);
      }
    }
    return reply.status(201).send({ items: items.map((i) => itemRow(ctx, ctx.repos.requireIntakeItem(ctx.db, i.id))) });
  });

  app.get('/intake', async (request) => {
    const q = parse(listQuery, request.query);
    const statuses = q.status ? q.status.split(',').map((s) => s.trim()).filter((s): s is (typeof STATUSES)[number] => (STATUSES as readonly string[]).includes(s)) : undefined;
    const claimId = q.claimId === 'none' ? null : q.claimId || undefined;
    const filter = { ...(statuses?.length ? { status: statuses } : {}), ...(claimId !== undefined ? { claimId } : {}) };
    const items = ctx.repos.listIntakeItems(ctx.db, { ...filter, limit: q.limit ?? 100, offset: q.offset ?? 0 });
    return { items: items.map((i) => itemRow(ctx, i)), total: ctx.repos.countIntakeItems(ctx.db, filter) };
  });

  // Registered before /intake/:id so the static segment wins.
  app.post('/intake/new-claim-draft', async (request, reply) => {
    const body = parse(draftBody, request.body);
    const draft = buildNewClaimDraft(ctx, body.itemIds, request.actor.userId);
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'intake.new_claim_draft', entity: 'intake_items', entityId: body.itemIds[0]!, after: { draftId: draft.id, itemIds: draft.itemIds, fields: Object.keys(draft.sources) }, at: ctx.now() });
    return reply.status(201).send(draft);
  });

  app.get('/intake/new-claim-draft/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    return requireDraft(ctx, id);
  });

  app.get('/intake/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    return itemDetail(ctx, ctx.repos.requireIntakeItem(ctx.db, id));
  });

  app.post('/intake/:id/retry', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(retryBody, request.body ?? {});
    let item = ctx.repos.requireIntakeItem(ctx.db, id);
    if (body.claimId && body.claimId !== item.claimId) {
      attachItemToClaim(ctx, item.id, body.claimId, request.actor);
      item = ctx.repos.requireIntakeItem(ctx.db, id);
      if (!body.from) return { item: itemRow(ctx, item), queued: 'intake.apply' };
    }
    const extracted = Boolean(ctx.repos.latestIntakeExtraction(ctx.db, item.id));
    const from = body.from ?? (!item.normalised || ['failed', 'skipped', 'queued', 'normalising'].includes(item.status) ? 'process' : !extracted ? 'extract' : 'apply');
    if (from === 'extract' && !item.normalised) throw badRequest('This item was never read; retry from process');
    const attempt = `r${Date.parse(ctx.now())}`;
    const type = from === 'process' ? 'intake.process' : from === 'extract' ? 'intake.extract' : 'intake.apply';
    ctx.repos.updateIntakeItem(ctx.db, item.id, { status: from === 'process' ? 'queued' : from === 'extract' ? 'extracting' : item.status, error: null }, ctx.now());
    enqueueJob(ctx, { type, payload: { itemId: item.id }, ...(item.claimId ? { claimId: item.claimId } : {}), idempotencyKey: `${type}:${item.id}:${attempt}`, createdBy: request.actor.userId });
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'intake.retry', entity: 'intake_items', entityId: item.id, after: { from, claimId: item.claimId ?? null }, at: ctx.now() });
    return { item: itemRow(ctx, ctx.repos.requireIntakeItem(ctx.db, item.id)), queued: type };
  });

  app.get('/claims/:id/proposals', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const q = parse(proposalsQuery, request.query);
    return { items: ctx.repos.listClaimUpdateProposals(ctx.db, { claimId: id, ...(q.status ? { status: q.status } : {}) }).map(proposalView) };
  });

  app.post('/proposals/apply', async (request) => {
    const body = parse(applyBody, request.body);
    const proposals = ctx.repos.listClaimUpdateProposals(ctx.db, { ids: body.ids });
    if (proposals.length !== new Set(body.ids).size) throw badRequest('Unknown proposal id');
    let applier: Applier;
    if (request.agent) {
      // An agent run (claim_field_apply): automatic proposals on its own claim only, with the same run token.
      const scope = request.agent.claimScope;
      if (!scope) throw new HttpError(403, 'AGENT_FORBIDDEN', 'Only a run scoped to one claim can apply proposals', { rule: 'claim_scope' });
      const bad = proposals.find((p) => p.policyDecision !== 'auto' || p.claimId !== scope);
      if (bad) throw new HttpError(403, 'AGENT_FORBIDDEN', 'Agents apply only automatic proposals on their own claim; the rest wait for the owner', { rule: 'intake_confirm', proposalId: bad.id });
      if (body.values && Object.keys(body.values).length) throw new HttpError(403, 'AGENT_FORBIDDEN', 'Agents cannot change a proposed value', { rule: 'intake_confirm' });
      applier = { kind: 'agent', actor: request.actor, headers: { authorization: String(request.headers.authorization ?? '') }, claimScope: scope, release: () => undefined };
    } else {
      applier = ownerApplier(ctx, request.actor);
    }
    const results = await applyProposals(ctx, proposals, applier, { ...(body.values ? { values: body.values } : {}) });
    closeSettledCards(ctx, new Set(proposals.map((p) => p.intakeItemId).filter((x): x is string => Boolean(x))), request.actor.userId);
    return { results, proposals: ctx.repos.listClaimUpdateProposals(ctx.db, { ids: body.ids }).map(proposalView) };
  });

  app.post('/proposals/reject', async (request) => {
    if (request.agent) throw new HttpError(403, 'AGENT_FORBIDDEN', 'Only the owner rejects proposals', { rule: 'human_only' });
    const body = parse(rejectBody, request.body);
    const rejected = rejectProposals(ctx, body.ids, request.actor, body.reason);
    const proposals = ctx.repos.listClaimUpdateProposals(ctx.db, { ids: body.ids });
    closeSettledCards(ctx, new Set(proposals.map((p) => p.intakeItemId).filter((x): x is string => Boolean(x))), request.actor.userId);
    return { rejected: rejected.length, proposals: proposals.map(proposalView) };
  });
}
