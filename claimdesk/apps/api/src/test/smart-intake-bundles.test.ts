// owned by intake-server
/**
 * Case bundles — the routes (docs/SMART-INTAKE.md §8.2): create / list / rename, files by multipart (≤ 10) or JSON
 * ({uploadId} / {importId} / {evidenceId}), the same file twice, the same file in two bundles, progress, cancel /
 * reopen, error shapes — and the contract check: a real BundleDetail carries every key of §8.1.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';
import { stageImport } from '../services/imports.js';
import { storeEvidenceBuffer } from '../services/evidence.js';
import { claimFormA, drain, NOW, uploadToBundle, v5cA, type TestFile } from './fixtures/smartIntake/scenario.js';
import { textPdf } from './fixtures/smartIntake/files.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let t: TestApp;

beforeEach(async () => {
  t = await createTestApp(NOW, { config: { aiDriverOverride: 'fake' } });
});
afterEach(async () => {
  await t.close();
});

const create = async (name: string) => (await t.api<Any>('POST', '/intake/bundles', { name })).body;

describe('bundles', () => {
  it('creates, lists, renames, cancels and reopens', async () => {
    const r = await t.api<Any>('POST', '/intake/bundles', { name: '  Jane Doe – Corsa crash  ' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'Jane Doe – Corsa crash', status: 'open', readiness: 'reading', source: 'upload', revision: 0, claim: null });
    expect((await t.api<Any>('POST', '/intake/bundles', { name: '' })).status).toBe(400);
    const list = await t.api<Any>('GET', '/intake/bundles');
    expect(list.body.total).toBe(1);
    const renamed = await t.api<Any>('PATCH', `/intake/bundles/${r.body.id}`, { name: 'Jane Doe' });
    expect(renamed.body.name).toBe('Jane Doe');
    expect((await t.api<Any>('POST', `/intake/bundles/${r.body.id}/cancel`, { reason: 'x' })).status).toBe(400);
    const cancelled = await t.api<Any>('POST', `/intake/bundles/${r.body.id}/cancel`, { reason: 'Uploaded by mistake' });
    expect(cancelled.body.status).toBe('cancelled');
    expect((await t.api<Any>('GET', '/intake/bundles')).body.total).toBe(0);
    expect((await t.api<Any>('GET', '/intake/bundles?status=cancelled')).body.total).toBe(1);
    expect((await t.api<Any>('POST', `/intake/bundles/${r.body.id}/fields`, { key: 'client.name', value: 'X' })).body.error.code).toBe('BUNDLE_CLOSED');
    const reopened = await t.api<Any>('POST', `/intake/bundles/${r.body.id}/reopen`, {});
    expect(reopened.body.status).not.toBe('cancelled');
    expect((await t.api<Any>('GET', '/intake/bundles/nope')).status).toBe(404);
    expect((await t.api<Any>('GET', '/intake/bundles/nope')).body.error.code).toBe('NOT_FOUND');
    const audit = (t.ctx.handle.sqlite.prepare(`SELECT action FROM audit_log WHERE action LIKE 'intake.bundle.%'`).all() as Array<{ action: string }>).map((x) => x.action);
    expect(audit).toEqual(expect.arrayContaining(['intake.bundle.create', 'intake.bundle.rename', 'intake.bundle.cancel', 'intake.bundle.reopen']));
  });

  it('adds files by multipart and JSON; the same file twice and in two bundles', async () => {
    const b = await create('Jane Doe');
    const v5c = await v5cA();
    const up = await uploadToBundle(t, b.id, [v5c, await claimFormA()]);
    expect(up.status).toBe(201);
    expect(up.body.files.map((f) => f.outcome)).toEqual(['added', 'added'].sort());
    expect(up.body.bundle.fileCounts).toMatchObject({ total: 2 });
    const again = await uploadToBundle(t, b.id, [v5c]);
    expect(again.body.files[0]!.outcome).toBe('already_in_bundle');
    const other = await create('Second look');
    const inOther = await uploadToBundle(t, other.id, [v5c]);
    expect(inOther.body.files[0]!.outcome).toBe('added');
    expect(inOther.body.files[0]!.itemId).toBe(up.body.files[0]!.itemId);
    // more than ten files in one request
    const many: TestFile[] = [];
    for (let i = 0; i < 11; i += 1) many.push({ filename: `note-${i}.txt`, mime: 'text/plain', content: Buffer.from(`note ${i}\n`) });
    expect((await uploadToBundle(t, b.id, many)).status).toBe(400);
    // chunked upload
    const pdf = await textPdf([['A letter uploaded in chunks', 'Registration: KX21 ABC']]);
    const u = await t.api<Any>('POST', '/uploads', { filename: 'chunked.pdf', bytes: pdf.length, mime: 'application/pdf', purpose: 'intake' });
    await t.app.inject({ method: 'PUT', url: `/api/uploads/${u.body.uploadId}?offset=0`, payload: pdf, headers: { 'content-type': 'application/octet-stream' } });
    expect((await t.api('POST', `/uploads/${u.body.uploadId}/complete`, {})).status).toBe(201);
    const viaUpload = await t.api<Any>('POST', `/intake/bundles/${b.id}/files`, { uploadId: u.body.uploadId });
    expect(viaUpload.status).toBe(201);
    expect(viaUpload.body.files[0].filename).toBe('chunked.pdf');
    // a staged import
    const dir = path.join(t.ctx.config.dataDir, 'drop');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'imported.pdf'), await textPdf([['An imported letter']]));
    const imp = await stageImport(t.ctx, path.join(dir, 'imported.pdf'), { purpose: 'intake', source: 'folder' });
    expect((await t.api<Any>('POST', `/intake/bundles/${b.id}/files`, { importId: imp.id })).status).toBe(201);
    // stored evidence
    const ev = await storeEvidenceBuffer(t.ctx, await textPdf([['Stored evidence letter']]), { filename: 'stored.pdf', mime: 'application/pdf', fields: { kind: 'document' }, actor: { userId: 'handler' } } as never);
    const evId = (ev as Any).evidence?.id ?? (ev as Any).id;
    expect((await t.api<Any>('POST', `/intake/bundles/${b.id}/files`, { evidenceId: evId })).status).toBe(201);
    expect((await t.api<Any>('POST', `/intake/bundles/${b.id}/files`, { uploadId: 'x', importId: 'y' })).status).toBe(400);
    const progress = await t.api<Any>('GET', `/intake/bundles/${b.id}/progress`);
    expect(progress.body.bundle.fileCounts.total).toBe(5);
    expect(progress.body.files.every((f: Any) => f.stage === 'stored')).toBe(true);
    await drain(t);
    const after = await t.api<Any>('GET', `/intake/bundles/${b.id}/progress`);
    expect(after.body.files.every((f: Any) => ['read_rules_only', 'waiting_ai', 'read', 'reading_ai'].includes(f.stage))).toBe(true);
  });

  it('a real BundleDetail carries every key of the contract (§8.1)', async () => {
    const b = await create('Jane Doe – Corsa crash');
    await uploadToBundle(t, b.id, [await v5cA(), await claimFormA()]);
    await drain(t);
    const d = (await t.api<Any>('GET', `/intake/bundles/${b.id}`)).body;
    const keys = (o: Any) => Object.keys(o).sort();
    const summaryKeys = ['id', 'name', 'status', 'readiness', 'source', 'folderKey', 'parentBundleId', 'revision', 'computedRevision', 'createdAt', 'updatedAt', 'createdBy', 'fileCounts', 'groupCount', 'conflictsOpen', 'missingDocs', 'signals', 'reasoning', 'autoRegister', 'claim', 'needsYouId', 'error', 'mode', 'targetClaim']; // mode + targetClaim: docs/CLAIM-AI-INPUT.md §11.2
    expect(keys(d)).toEqual([...summaryKeys, 'files', 'groups', 'draft', 'conflicts', 'checklist', 'timeline', 'signals', 'liability', 'register', 'aiSummary', 'decisions'].filter((k, i, a) => a.indexOf(k) === i).sort());
    expect(keys(d.fileCounts)).toEqual(['duplicates', 'failed', 'inProgress', 'read', 'skipped', 'total', 'waitingAi'].sort());
    expect(keys(d.reasoning)).toEqual(['at', 'status', 'waiting'].sort());
    expect(keys(d.autoRegister)).toEqual(['blockers', 'eligible', 'settingOn'].sort());
    expect(keys(d.files[0])).toEqual(['addedAt', 'archive', 'bytes', 'docSide', 'docType', 'docTypeConfidence', 'docTypeLabel', 'documentDate', 'duplicate', 'engine', 'error', 'evidenceId', 'excluded', 'fileUrl', 'filed', 'filename', 'groupKey', 'id', 'itemId', 'mime', 'pages', 'parentFileId', 'pdfMeta', 'photo', 'pinned', 'position', 'role', 'segment', 'sha256', 'stage', 'stageLabel', 'summary', 'waiting'].sort());
    expect(keys(d.groups[0])).toEqual(['claim', 'confidence', 'defaultAction', 'fileIds', 'key', 'kind', 'label', 'reasons', 'suggestedName', 'warnings'].sort());
    expect(keys(d.draft)).toEqual(['circumstances', 'existingParty', 'fields', 'witnesses', 'witnessesAnswered'].sort());
    expect(keys(d.draft.circumstances)).toEqual(['attribution', 'fromFileId'].sort());
    expect(keys(d.draft.fields[0])).toEqual(['alternatives', 'conflictId', 'confidence', 'display', 'key', 'keyField', 'label', 'note', 'required', 'section', 'sensitive', 'source', 'status', 'validator', 'value'].sort());
    const withSource = d.draft.fields.find((f: Any) => f.source);
    expect(keys(withSource.source)).toEqual(['confidence', 'docType', 'docTypeLabel', 'engine', 'evidenceId', 'fileId', 'filename', 'itemId', 'label', 'page', 'quote', 'quoteVerified', 'rank'].sort());
    expect(keys(d.checklist)).toEqual(['caseKind', 'caseKindLabel', 'items', 'request'].sort());
    expect(keys(d.checklist.items[0])).toEqual(['fileIds', 'id', 'label', 'status', 'why'].sort());
    expect(keys(d.checklist.request)).toEqual(['body', 'subject', 'to'].sort());
    expect(keys(d.liability)).toEqual(['band', 'note', 'reasons', 'score', 'statements'].sort());
    expect(keys(d.register)).toEqual(['blockers', 'canRegister', 'fnolWarnings', 'willDo'].sort());
    expect(keys(d.decisions[0])).toEqual(['actor', 'after', 'at', 'before', 'id', 'kind', 'note', 'subject'].sort());
    if (d.timeline[0]) expect(keys(d.timeline[0])).toEqual(['at', 'attributableTo', 'class', 'confidence', 'eventLabel', 'eventType', 'id', 'note', 'precision', 'sources', 'summary', 'ticked', 'tickedBy'].sort());
    if (d.signals[0]) expect(keys(d.signals[0])).toEqual(['acknowledged', 'basis', 'claims', 'code', 'fileIds', 'id', 'message', 'severity', 'title'].sort());
    // settings view
    const s = (await t.api<Any>('GET', '/settings/intake')).body;
    expect(keys(s)).toEqual(['defaults', 'settings'].sort());
    expect(keys(s.settings)).toEqual(['archives', 'bundles', 'duplicates', 'photos', 'split'].sort());
    const bad = await t.api<Any>('PATCH', '/settings/intake', { bundles: { quietSeconds: 'soon' } });
    expect(bad.status).toBe(400);
    const ok = await t.api<Any>('PATCH', '/settings/intake', { bundles: { quietSeconds: 5 } });
    expect(ok.body.settings.bundles.quietSeconds).toBe(5);
  });

  it('think again re-queues the AI check for the owner; the wizard draft is prepared from the case', async () => {
    const b = await create('Jane Doe – Corsa crash');
    await uploadToBundle(t, b.id, [await v5cA(), await claimFormA()]);
    await drain(t);
    const r = await t.api<Any>('POST', `/intake/bundles/${b.id}/think-again`, {});
    expect(r.status).toBe(202);
    expect(r.body.reasoning.status).toMatch(/queued|waiting_ai/);
    const jobs = t.ctx.repos.listAgentJobs(t.ctx.db, { type: 'intake.bundle_reason', limit: 10 });
    expect(jobs.some((j) => (j.payload as Any).owner === true)).toBe(true);
    const draft = await t.api<Any>('POST', `/intake/bundles/${b.id}/wizard-draft`, {});
    expect(draft.status).toBe(201);
    expect(draft.body.itemIds.length).toBe(2);
    const moved = await t.api<Any>('POST', `/intake/bundles/${b.id}/files/${(await t.api<Any>('GET', `/intake/bundles/${b.id}`)).body.files[1].id}/move`, { groupKey: 'new' });
    expect(moved.status).toBe(200);
    expect(moved.body.groups.some((g: Any) => g.key.startsWith('case:') && g.reasons.some((x: Any) => x.code === 'moved_by_owner'))).toBe(true);
    expect((await t.api<Any>('POST', `/intake/bundles/${b.id}/files/${moved.body.files[1].id}/move`, { groupKey: 'nowhere' })).status).toBe(400);
  });
});

