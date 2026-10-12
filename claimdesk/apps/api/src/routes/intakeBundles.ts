// owned by intake-server
/**
 * Smart intake — case bundles (docs/SMART-INTAKE.md §8.2). Owner session only; agents have no tool for any of these
 * routes (route allow-list), and register / register-retry / attach / PATCH settings are also human-only (perimeter).
 *
 *   GET    /intake/bundles?status=open|done|cancelled|all&limit&offset
 *   POST   /intake/bundles {name}
 *   GET    /intake/bundles/:id                      BundleDetail (recomputed first when stale)
 *   GET    /intake/bundles/:id/progress             cheap, for polling
 *   PATCH  /intake/bundles/:id {name}
 *   POST   /intake/bundles/:id/files                multipart (≤ 10 files, 512 MiB each) or JSON {uploadId}|{importId}|{evidenceId}
 *   POST   /intake/bundles/:id/files/:fileId/{move,exclude,unsplit,file-copy}
 *   POST   /intake/bundles/:id/{fields,witnesses,confirm-new,link-party,think-again,register,register/retry,attach,cancel,reopen,wizard-draft}
 *   POST   /intake/bundles/:id/conflicts/:conflictId/choose · /conflicts/accept-preselected
 *   POST   /intake/bundles/:id/timeline/:proposalId · /signals/:signalId/ack · /groups/:groupKey/split-off
 *   GET    /intake/bundles/:id/brief · /claims/:id/intake-brief · /claims/:id/damage-zones
 *   GET    /settings/intake · PATCH /settings/intake
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEFAULT_INTAKE_SETTINGS, isBundleFieldKey, mergeDefaults, mergeIntakeSettings, nextCaseKey, preselectedChoices, type IntakeSettings } from '@ccguk/domain';
import type { BundleStatus } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { badRequest, HttpError, notFound } from '../errors.js';
import { parse } from '../schemas/common.js';
import { discardStaged, stageStream, type StagedUpload } from '../services/evidence.js';
import { buildNewClaimDraft } from '../intake/newClaimDraft.js';
import { attachBundle } from '../intake/bundles/attach.js';
import { bundleBrief, claimIntakeBrief } from '../intake/bundles/brief.js';
import { normaliseForKey } from '../intake/bundles/candidates.js';
import { damageZonesView } from '../intake/bundles/damage.js';
import { fileBundleEvidence } from '../intake/bundles/file.js';
import { CLOSED_STATUSES } from '../intake/bundles/hooks.js';
import { computeBundle, queueReasoning, recomputeBundle } from '../intake/bundles/recompute.js';
import { registerBundle, retryRegistration } from '../intake/bundles/register.js';
import { addFilesToBundle, cancelBundle, createBundle, decide, renameBundle, reopenBundle, requireBundle, requireOpenBundle, type AddSource } from '../intake/bundles/service.js';
import { splitOffGroup } from '../intake/bundles/splitOff.js';
import { bundleDetail, bundleProgress, bundleSummary } from '../intake/bundles/views.js';
import { INTAKE_MAX_FILE_BYTES, INTAKE_MAX_FILES } from './intake.js';
import { params, requireRole } from './helpers.js';

const MIB = 1024 * 1024;
const OPEN: BundleStatus[] = ['open', 'reading', 'reconciling', 'ready', 'needs_you', 'registering'];
const STATUS_FILTER: Record<string, BundleStatus[] | undefined> = { open: OPEN, done: ['registered', 'attached'], cancelled: ['cancelled'], all: undefined };

const listQuery = z.object({ status: z.enum(['open', 'done', 'cancelled', 'all']).default('open'), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });
const nameBody = z.object({ name: z.string().trim().min(1).max(120) });
const jsonFiles = z
  .object({ uploadId: z.string().min(1).optional(), importId: z.string().min(1).optional(), evidenceId: z.string().min(1).optional() })
  .refine((b) => [b.uploadId, b.importId, b.evidenceId].filter(Boolean).length === 1, 'Give exactly one of uploadId, importId or evidenceId (or upload the files as multipart)');
const moveBody = z.object({ groupKey: z.string().min(1).max(80) });
const excludeBody = z.object({ excluded: z.boolean(), reason: z.string().trim().max(500).optional() });
const fieldBody = z.object({ key: z.string().min(1), value: z.string().max(4000).nullable(), note: z.string().trim().max(500).optional() });
const witnessesBody = z.object({ witnesses: z.array(z.object({ name: z.string().trim().min(1).max(200), phone: z.string().trim().max(40).nullable().optional(), relationship: z.string().trim().max(200).nullable().optional() })).max(20), answered: z.boolean() });
const chooseBody = z.object({ value: z.string().min(1).max(4000) });
const noteBody = z.object({ note: z.string().trim().max(1000).optional() }).default({});
const linkPartyBody = z.object({ partyId: z.string().min(1).nullable() });
const tickBody = z.object({ ticked: z.boolean() });
const splitOffBody = z.object({ name: z.string().trim().min(1).max(120).optional() }).default({});
const registerBody = z
  .object({
    acceptPreselected: z.boolean().optional(),
    confirmNew: z.boolean().optional(),
    timeline: z.object({ tick: z.array(z.string()).max(200).default([]), untick: z.array(z.string()).max(200).default([]) }).optional(),
    requestMissingDocs: z.boolean().optional(),
    groups: z.record(z.enum(['split_off', 'attach', 'exclude'])).optional(),
  })
  .default({});
const attachBody = z.object({ claimId: z.string().min(1), groupKey: z.string().min(1).optional(), apply: z.array(z.string()).max(60).optional() });
const cancelBody = z.object({ reason: z.string().trim().min(3).max(2000) });

const int = (min: number, max: number) => z.number().int().min(min).max(max);
export const intakeSettingsSchema = z
  .object({
    bundles: z.object({ autoRegister: z.boolean(), autoRegisterMinConfidence: z.number().min(0.8).max(1), prepareMissingDocsRequest: z.boolean(), quietSeconds: int(0, 600), folderBundles: z.boolean(), aiReasoningRunsPerBundlePerDay: int(0, 20) }).strict(),
    split: z.object({ enabled: z.boolean(), minPages: int(2, 50) }).strict(),
    duplicates: z.object({ nearPhotoMaxDistance: int(0, 16), nearTextMinJaccard: z.number().min(0.5).max(1) }).strict(),
    photos: z.object({ beforeAccidentToleranceHours: z.number().min(0).max(72), gpsOutlierKm: z.number().min(0.1).max(100) }).strict(),
    archives: z.object({ maxEntries: int(1, 1000), maxTotalBytes: int(1024 * 1024, 4 * 1024 ** 3), maxDepth: int(0, 3), maxRatio: int(10, 1000) }).strict(),
  })
  .strict();

function contentLength(request: FastifyRequest): number | undefined {
  const raw = request.headers['content-length'];
  const n = raw === undefined ? NaN : Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
const tooLarge = (): HttpError => new HttpError(413, 'FILE_TOO_LARGE', `A file for intake can be up to ${INTAKE_MAX_FILE_BYTES / MIB} MB; larger files go through the chunked upload or the import folder`, { limitBytes: INTAKE_MAX_FILE_BYTES, useChunked: true });

function fileOf(ctx: AppContext, bundleId: string, fileId: string) {
  const f = ctx.repos.getBundleFile(ctx.db, fileId);
  if (!f || f.bundleId !== bundleId) throw notFound('bundle file', fileId);
  return f;
}

export function registerIntakeBundlesRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/intake/bundles', async (request) => {
    const q = parse(listQuery, request.query ?? {});
    const status = STATUS_FILTER[q.status];
    const items = ctx.repos.listIntakeBundles(ctx.db, { ...(status ? { status } : {}), limit: q.limit, offset: q.offset });
    return { items: items.map((b) => bundleSummary(ctx, b)), total: ctx.repos.countIntakeBundles(ctx.db, status ? { status } : {}) };
  });

  app.post('/intake/bundles', async (request, reply) => {
    const body = parse(nameBody, request.body ?? {});
    const b = createBundle(ctx, { name: body.name }, request.actor);
    return reply.status(201).send(bundleSummary(ctx, b));
  });

  app.get('/intake/bundles/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireBundle(ctx, id);
    return bundleDetail(ctx, id);
  });

  app.get('/intake/bundles/:id/progress', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireBundle(ctx, id);
    return bundleProgress(ctx, id);
  });

  app.patch('/intake/bundles/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(nameBody, request.body ?? {});
    return bundleSummary(ctx, renameBundle(ctx, id, body.name, request.actor));
  });

  app.post('/intake/bundles/:id/files', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    requireOpenBundle(ctx, id);
    const sources: AddSource[] = [];
    if (request.isMultipart()) {
      const declared = contentLength(request);
      if (declared !== undefined && declared > INTAKE_MAX_FILE_BYTES * INTAKE_MAX_FILES + MIB) throw tooLarge();
      const staged: Array<{ staged: StagedUpload; filename: string; mime: string }> = [];
      try {
        for await (const part of request.parts({ limits: { fileSize: INTAKE_MAX_FILE_BYTES, files: INTAKE_MAX_FILES, fields: 20 } })) {
          if (part.type !== 'file') continue;
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
        }
      } catch (err) {
        for (const s of staged) discardStaged(s.staged);
        if ((err as { code?: string })?.code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge();
        if ((err as { code?: string })?.code === 'FST_FILES_LIMIT') throw badRequest(`Up to ${INTAKE_MAX_FILES} files per request`);
        throw err;
      }
      if (!staged.length) throw badRequest('No file in the upload');
      sources.push(...staged);
    } else {
      const body = parse(jsonFiles, request.body ?? {});
      if (body.uploadId) sources.push({ uploadId: body.uploadId });
      else if (body.importId) sources.push({ importId: body.importId });
      else if (body.evidenceId) sources.push({ evidenceId: body.evidenceId });
    }
    let files;
    try {
      files = await addFilesToBundle(ctx, id, sources, request.actor);
    } catch (err) {
      for (const s of sources) if ('staged' in s) discardStaged(s.staged);
      throw err;
    }
    return reply.status(201).send({ files, bundle: bundleSummary(ctx, ctx.repos.requireIntakeBundle(ctx.db, id)) });
  });

  app.post('/intake/bundles/:id/files/:fileId/move', async (request) => {
    const { id, fileId } = params<{ id: string; fileId: string }>(request);
    requireOpenBundle(ctx, id);
    fileOf(ctx, id, fileId);
    const body = parse(moveBody, request.body ?? {});
    const state = computeBundle(ctx, id);
    const keys = state.computed.groups.map((g) => g.key).filter((k) => k !== 'excluded');
    let groupKey = body.groupKey;
    if (groupKey === 'new') groupKey = nextCaseKey([...keys, ...Object.values(state.owner.pins)]);
    else if (!keys.includes(groupKey) && groupKey !== 'main' && groupKey !== 'unsure') throw badRequest(`Unknown group ${groupKey} — move to an existing group or 'new'`);
    const before = state.computed.files[fileId]?.groupKey ?? null;
    decide(ctx, id, { kind: 'move_file', subject: fileId, before: { groupKey: before }, after: { groupKey }, audit: { from: before, to: groupKey } }, request.actor);
    return bundleDetail(ctx, id);
  });

  app.post('/intake/bundles/:id/files/:fileId/exclude', async (request) => {
    const { id, fileId } = params<{ id: string; fileId: string }>(request);
    fileOf(ctx, id, fileId);
    const body = parse(excludeBody, request.body ?? {});
    decide(ctx, id, { kind: body.excluded ? 'exclude_file' : 'include_file', subject: fileId, ...(body.reason ? { note: body.reason } : {}) }, request.actor);
    return bundleDetail(ctx, id);
  });

  app.post('/intake/bundles/:id/files/:fileId/unsplit', async (request) => {
    const { id, fileId } = params<{ id: string; fileId: string }>(request);
    const f = fileOf(ctx, id, fileId);
    const segments = ctx.repos.listBundleFiles(ctx.db, id).filter((x) => x.parentFileId === f.id && x.role === 'segment');
    if (f.role !== 'pack' || !segments.length) throw badRequest('Only a scanned pack that was split can be kept whole');
    decide(ctx, id, { kind: 'unsplit', subject: fileId, audit: { segments: segments.length } }, request.actor);
    return bundleDetail(ctx, id);
  });

  app.post('/intake/bundles/:id/files/:fileId/file-copy', async (request) => {
    const { id, fileId } = params<{ id: string; fileId: string }>(request);
    const b = requireBundle(ctx, id);
    fileOf(ctx, id, fileId);
    if ((b.status !== 'registered' && b.status !== 'attached') || !b.claimId) throw new HttpError(409, 'BUNDLE_NOT_REGISTERED', 'A copy can be filed once the bundle is registered or attached');
    const state = decide(ctx, id, { kind: 'add_files', subject: fileId, after: { fileCopy: true }, auditKind: 'file_copy', audit: { claimId: b.claimId } }, request.actor, { allowClosed: true });
    if (!state.computed.files[fileId]?.duplicate) throw badRequest('This file is not a copy of another file');
    await fileBundleEvidence(ctx, state, b.claimId, [fileId], request.actor, { copies: new Set([fileId]) });
    return bundleDetail(ctx, id);
  });

  app.post('/intake/bundles/:id/fields', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(fieldBody, request.body ?? {});
    if (!isBundleFieldKey(body.key)) throw badRequest(`Unknown detail ${body.key}`);
    const state = computeBundle(ctx, id);
    const current = state.computed.draft.fields.find((f) => f.key === body.key);
    if (body.value === null || !body.value.trim()) {
      decide(ctx, id, { kind: 'clear_field', subject: body.key, before: { value: current?.value ?? null }, ...(body.note ? { note: body.note } : {}) }, request.actor);
      return bundleDetail(ctx, id);
    }
    const n = normaliseForKey(body.key, body.value, ctx.now());
    if (!n.ok) throw badRequest(n.message ?? 'That value failed its check', { key: body.key });
    decide(ctx, id, { kind: 'set_field', subject: body.key, before: { value: current?.value ?? null }, after: { value: n.value, display: n.display }, ...(body.note ? { note: body.note } : {}), audit: { key: body.key } }, request.actor);
    return bundleDetail(ctx, id);
  });

  app.post('/intake/bundles/:id/witnesses', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(witnessesBody, request.body ?? {});
    const witnesses = body.witnesses.map((w) => ({ name: w.name, phone: w.phone ?? null, relationship: w.relationship ?? null }));
    decide(ctx, id, { kind: 'set_field', subject: 'witnesses', after: { witnesses, answered: body.answered }, audit: { witnesses: witnesses.length, answered: body.answered } }, request.actor);
    return bundleDetail(ctx, id);
  });

  app.post('/intake/bundles/:id/conflicts/accept-preselected', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireOpenBundle(ctx, id);
    const list = preselectedChoices(computeBundle(ctx, id).computed.conflicts);
    if (list.length) decide(ctx, id, { kind: 'accept_preselected', after: { conflicts: list }, audit: { conflicts: list.length } }, request.actor);
    return bundleDetail(ctx, id);
  });

  app.post('/intake/bundles/:id/conflicts/:conflictId/choose', async (request) => {
    const { id, conflictId } = params<{ id: string; conflictId: string }>(request);
    requireOpenBundle(ctx, id);
    const body = parse(chooseBody, request.body ?? {});
    const c = computeBundle(ctx, id).computed.conflicts.find((x) => x.id === conflictId);
    if (!c) throw notFound('conflict', conflictId);
    const option = c.options.find((o) => o.value === body.value || o.display === body.value);
    if (!option) throw badRequest('Choose one of the values the documents give (or set the detail yourself)', { options: c.options.map((o) => o.value) });
    const pre = c.options.find((o) => o.preselected);
    decide(ctx, id, { kind: 'choose_conflict', subject: conflictId, before: { preselected: pre?.value ?? null }, after: { value: option.value }, audit: { key: c.key, preselected: option.value === pre?.value } }, request.actor);
    return bundleDetail(ctx, id);
  });

  app.post('/intake/bundles/:id/confirm-new', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(noteBody, request.body ?? {});
    decide(ctx, id, { kind: 'confirm_new', ...(body.note ? { note: body.note } : {}) }, request.actor);
    return bundleDetail(ctx, id);
  });

  app.post('/intake/bundles/:id/link-party', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(linkPartyBody, request.body ?? {});
    if (body.partyId && !ctx.repos.getParty(ctx.db, body.partyId)) throw notFound('party', body.partyId);
    decide(ctx, id, { kind: 'link_party', after: { partyId: body.partyId } }, request.actor);
    return bundleDetail(ctx, id);
  });

  app.post('/intake/bundles/:id/timeline/:proposalId', async (request) => {
    const { id, proposalId } = params<{ id: string; proposalId: string }>(request);
    requireOpenBundle(ctx, id);
    const body = parse(tickBody, request.body ?? {});
    const t = computeBundle(ctx, id).computed.timeline.find((x) => x.id === proposalId);
    if (!t) throw notFound('timeline proposal', proposalId);
    if (t.class === 'owner_only' && body.ticked) throw badRequest(`${t.eventLabel} is recorded by you on the claim (Offers / Hire), not by intake`);
    decide(ctx, id, { kind: body.ticked ? 'tick_timeline' : 'untick_timeline', subject: proposalId, audit: { eventType: t.eventType } }, request.actor);
    return bundleDetail(ctx, id);
  });

  app.post('/intake/bundles/:id/signals/:signalId/ack', async (request) => {
    const { id, signalId } = params<{ id: string; signalId: string }>(request);
    requireOpenBundle(ctx, id);
    const body = parse(noteBody, request.body ?? {});
    const s = computeBundle(ctx, id).computed.signals.find((x) => x.id === signalId);
    if (!s) throw notFound('signal', signalId);
    decide(ctx, id, { kind: 'ack_signal', subject: signalId, ...(body.note ? { note: body.note } : {}), audit: { code: s.code } }, request.actor);
    return bundleDetail(ctx, id);
  });

  app.post('/intake/bundles/:id/groups/:groupKey/split-off', async (request, reply) => {
    const { id, groupKey } = params<{ id: string; groupKey: string }>(request);
    const body = parse(splitOffBody, request.body ?? {});
    const r = splitOffGroup(ctx, id, decodeURIComponent(groupKey), body.name, request.actor);
    return reply.status(201).send({ bundle: bundleSummary(ctx, r.bundle), source: bundleDetail(ctx, id) });
  });

  app.post('/intake/bundles/:id/think-again', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const b = requireOpenBundle(ctx, id);
    const state = recomputeBundle(ctx, id);
    if (!state.main.length) throw badRequest('There is nothing in this case for the AI to read yet');
    decide(ctx, id, { kind: 'think_again' }, request.actor);
    queueReasoning(ctx, ctx.repos.requireIntakeBundle(ctx.db, b.id), state.computed.fileset, { owner: true, createdBy: request.actor.userId });
    return reply.status(202).send(bundleSummary(ctx, ctx.repos.requireIntakeBundle(ctx.db, id)));
  });

  app.post('/intake/bundles/:id/register', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(registerBody, request.body ?? {});
    const r = await registerBundle(ctx, id, request.actor, {
      mode: 'owner',
      ...(body.acceptPreselected !== undefined ? { acceptPreselected: body.acceptPreselected } : {}),
      ...(body.confirmNew !== undefined ? { confirmNew: body.confirmNew } : {}),
      ...(body.timeline ? { timeline: body.timeline } : {}),
      ...(body.requestMissingDocs !== undefined ? { requestMissingDocs: body.requestMissingDocs } : {}),
      ...(body.groups ? { groups: body.groups } : {}),
    });
    return reply.status(201).send(r);
  });

  app.post('/intake/bundles/:id/register/retry', async (request) => {
    const { id } = params<{ id: string }>(request);
    return retryRegistration(ctx, id, request.actor);
  });

  app.post('/intake/bundles/:id/attach', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(attachBody, request.body ?? {});
    return attachBundle(ctx, id, request.actor, { claimId: body.claimId, ...(body.groupKey ? { groupKey: body.groupKey } : {}), ...(body.apply ? { apply: body.apply } : {}) });
  });

  app.post('/intake/bundles/:id/cancel', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(cancelBody, request.body ?? {});
    return bundleSummary(ctx, cancelBundle(ctx, id, body.reason, request.actor));
  });

  app.post('/intake/bundles/:id/reopen', async (request) => {
    const { id } = params<{ id: string }>(request);
    return bundleSummary(ctx, reopenBundle(ctx, id, request.actor));
  });

  app.post('/intake/bundles/:id/wizard-draft', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const b = requireBundle(ctx, id);
    if (CLOSED_STATUSES.has(b.status)) throw new HttpError(409, 'BUNDLE_CLOSED', `This bundle is ${b.status}`);
    const state = computeBundle(ctx, id);
    const itemIds = state.main.map((fc) => fc.item.id);
    if (!itemIds.length) throw badRequest('There is nothing in this case to prepare a claim from yet');
    const draft = buildNewClaimDraft(ctx, itemIds, request.actor.userId);
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'intake.new_claim_draft', entity: 'intake_bundles', entityId: id, after: { draftId: draft.id, itemIds: draft.itemIds }, at: ctx.now() });
    return reply.status(201).send(draft);
  });

  app.get('/intake/bundles/:id/brief', async (request) => {
    const { id } = params<{ id: string }>(request);
    return bundleBrief(ctx, id);
  });

  app.get('/claims/:id/intake-brief', async (request) => {
    const { id } = params<{ id: string }>(request);
    return claimIntakeBrief(ctx, id);
  });

  app.get('/claims/:id/damage-zones', async (request) => {
    const { id } = params<{ id: string }>(request);
    if (!ctx.repos.getClaim(ctx.db, id)) throw notFound('claim', id);
    return damageZonesView(ctx, id);
  });

  app.get('/settings/intake', async () => ({ settings: ctx.repos.getAgentSettings(ctx.db).intake, defaults: DEFAULT_INTAKE_SETTINGS }));

  app.patch('/settings/intake', async (request) => {
    requireRole(request);
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'VALIDATION', 'Send the settings to change as a JSON object');
    const before = ctx.repos.getAgentSettings(ctx.db).intake;
    const merged: IntakeSettings = mergeDefaults(before, body as Partial<IntakeSettings>) as IntakeSettings;
    parse(intakeSettingsSchema, merged);
    const next = ctx.repos.patchAgentSettings(ctx.db, { intake: mergeIntakeSettings(merged) }, request.actor, ctx.now());
    return { settings: next.intake, defaults: DEFAULT_INTAKE_SETTINGS };
  });
}
