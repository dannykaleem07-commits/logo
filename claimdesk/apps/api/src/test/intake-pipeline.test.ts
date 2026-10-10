// owned by intake
/**
 * Intake pipeline (docs/SUPREME-DESIGN.md §G.1, §G.2): sniffing (lying extensions included), PDF/DOCX/EML
 * normalisation, the CCGUK form fingerprint, the entry points (multipart, chunked upload, import folder, the mail
 * slice's email payload) and FakeDriver extraction → append-only extraction rows → proposals. Every document is
 * generated here; no model is ever called (FakeDriver fixtures in apps/api/src/ai/fixtures/intake).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { builtinAssetBytes } from '@ccguk/documents';
import { createTestApp, FNOL, type TestApp } from './helpers.js';
import { queued, runJob } from './fixtures/mail/helpers.js';
import { auditRows, drainIntake, jobsOf, makeBlankPdf, makeEml, makeHeicHeader, makeTextPdf } from './fixtures/intake/helpers.js';
import { sniff, SNIFF_TABLE } from '../intake/sniff.js';
import { normalise, pdfText } from '../intake/normalise.js';
import { fingerprintCcgukForm } from '../intake/fingerprint.js';
import { scanStagedIntakeImports } from '../intake/items.js';
import { enqueueJob } from '../agent/core.js';
import { storeEvidenceBuffer } from '../services/evidence.js';
import { stageImport } from '../services/imports.js';
import { makePng } from '../seed/png.js';

const NOW = '2026-10-07T09:00:00.000Z';

let t: TestApp;
let claimId: string;

beforeEach(async () => {
  t = await createTestApp(NOW, { config: { aiDriverOverride: 'fake' } });
  const r = await t.api<{ id: string }>('POST', '/claims', FNOL);
  expect(r.status).toBe(201);
  claimId = r.body.id;
});
afterEach(async () => {
  await t.close();
});

/** multipart/form-data body for app.inject. */
function multipart(files: Array<{ filename: string; mime: string; content: Buffer }>, fields: Record<string, string> = {}): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----intake-test-boundary';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.filename}"\r\nContent-Type: ${f.mime}\r\n\r\n`));
    parts.push(f.content, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function upload(files: Array<{ filename: string; mime: string; content: Buffer }>, fields: Record<string, string> = {}) {
  const m = multipart(files, fields);
  const res = await t.app.inject({ method: 'POST', url: '/api/intake', payload: m.payload, headers: m.headers });
  return { status: res.statusCode, body: JSON.parse(res.body) as { items: Array<{ id: string; status: string; evidence: { id: string; claimId: string | null } }> } };
}

describe('sniff (magic bytes, never the extension)', () => {
  it('recognises every type in the table and flags lying extensions', async () => {
    const pdf = await makeTextPdf([['hello']]);
    const png = makePng({ width: 8, height: 8 });
    const docx = Buffer.from(builtinAssetBytes('form.ccguk_09_accident_report'));
    const cases: Array<[Buffer, string, string, boolean]> = [
      [pdf, 'scan.pdf', 'pdf', true],
      [pdf, 'holiday.jpg', 'pdf', false], // a PDF pretending to be a photo
      [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]), 'photo.jpeg', 'jpeg', true],
      [png, 'report.pdf', 'png', false], // a PNG pretending to be a PDF
      [Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'), 'x.gif', 'gif', true],
      [Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]), 'x.webp', 'webp', true],
      [makeHeicHeader(), 'IMG_0001.HEIC', 'heic', true],
      [makeHeicHeader(), 'IMG_0001.jpg', 'heic', false],
      [docx, 'form.docx', 'docx', true],
      [docx, 'form.doc', 'docx', false],
      [Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('random.txt')]), 'bundle.zip', 'zip', true],
      [makeEml({ from: 'a@example.test', to: 'b@example.test', subject: 'Hi', body: 'Hello' }), 'message.eml', 'eml', true],
      [Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from('__substg1.0_0037001F', 'utf16le')]), 'mail.msg', 'msg', true],
      [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), 'old.doc', 'ole', true],
      [Buffer.from('MSCF\0\0\0\0', 'latin1'), 'AUDATEX.cab', 'cab', true],
      [Buffer.from('SQLite format 3\0rest', 'latin1'), 'data.db', 'sqlite', true],
      [Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.from('Standard ACE DB\0', 'latin1')]), 'parts.accdb', 'jet', true],
      [Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]), 'call.wav', 'wav', true],
      [Buffer.from('ID3\x04\x00rest', 'latin1'), 'call.mp3', 'mp3', true],
      [Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A \0\0\0\0M4A isom')]), 'memo.m4a', 'm4a', true],
      [Buffer.from('OggS\0\x02rest', 'latin1'), 'voice.ogg', 'ogg', true],
      [Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]), 'clip.webm', 'webm', true],
      [Buffer.from('Just some notes about the accident.\n', 'utf8'), 'notes.txt', 'text', true],
      [Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0x00]), 'blob.bin', 'unknown', false],
    ];
    for (const [buf, name, kind, matches] of cases) {
      const s = sniff(buf, name);
      expect(s.kind, name).toBe(kind);
      expect(s.mime, name).toBe(SNIFF_TABLE[s.kind].mime);
      expect(s.extensionMatches, name).toBe(matches);
    }
    expect(sniff(Buffer.alloc(0)).kind).toBe('unknown');
    expect(sniff(pdf).extensionMatches).toBe(true); // no filename: nothing to contradict
  });
});

describe('normalise', () => {
  it('extracts per-page PDF text with pdfjs-dist; a PDF without a text layer is scanned', async () => {
    const pdf = await makeTextPdf([['Registration: KX21 ABC', 'VIN WVWZZZ1JZXW000001'], ['Second page text']]);
    const direct = await pdfText(pdf);
    expect(direct.numPages).toBe(2);
    expect(direct.pages[0]).toContain('KX21 ABC');
    const r = await normalise(pdf, 'v5c.pdf');
    expect(r.doc).toMatchObject({ kind: 'pdf', pages: 2, scanned: false, sniffed: 'pdf' });
    expect(r.doc.pageTexts?.[1]).toContain('Second page text');
    expect(r.textSha256).toMatch(/^[a-f0-9]{64}$/);
    const blank = await normalise(await makeBlankPdf(3), 'scan.pdf');
    expect(blank.doc).toMatchObject({ kind: 'pdf', pages: 3, scanned: true, pageTexts: [] });
    expect(blank.textSha256).toBeUndefined();
  });

  it('DOCX text through the existing scanner; the CCGUK fingerprint recognises its own form', async () => {
    const bytes = Buffer.from(builtinAssetBytes('form.ccguk_09_accident_report'));
    const r = await normalise(bytes, 'returned-form.docx');
    expect(r.doc.kind).toBe('docx');
    expect((r.doc.pageTexts?.[0] ?? '').length).toBeGreaterThan(200);
    const fp = fingerprintCcgukForm(r.doc.pageTexts![0]!);
    expect(fp?.templateId).toBe('form.ccguk_09_accident_report');
    expect(fp!.score).toBeGreaterThanOrEqual(0.5);
    expect(fingerprintCcgukForm('A short letter about nothing in particular, signed and dated.')).toBeNull();
  });

  it('EML: message text plus attachments; audio, CAB and HEIC are not read', async () => {
    const png = makePng({ width: 6, height: 6, seed: 3 });
    const eml = makeEml({ from: 'Claims <claims@insurer.example>', to: 'claims@ccguk.example', subject: 'Your client', body: 'Please find attached.', attachments: [{ filename: 'damage.png', mime: 'image/png', content: png }] });
    const r = await normalise(eml, 'message.eml');
    expect(r.doc.kind).toBe('email');
    expect(r.doc.email).toMatchObject({ subject: 'Your client' });
    expect(r.doc.pageTexts?.[0]).toMatch(/Subject: Your client[\s\S]*Please find attached/);
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0]!.content.equals(png)).toBe(true);
    expect((await normalise(Buffer.from('MSCF\0\0\0\0', 'latin1'), 'a.cab')).doc).toMatchObject({ kind: 'skipped', skipReason: expect.stringMatching(/engineer data/) });
    expect((await normalise(Buffer.from('ID3\x04\x00rest', 'latin1'), 'a.mp3')).doc.skipReason).toMatch(/Calls/);
    expect((await normalise(makeHeicHeader(), 'a.heic')).doc.kind).toBe('heic');
  });
});

describe('entry points and the FakeDriver extraction', () => {
  it('multipart upload on a claim → process → extract (append-only row) → proposals and automatic fills', async () => {
    const pdf = await makeTextPdf([['INTAKE-FIXTURE-V5C', 'Registration mark KX21 ABC', 'VIN WVWZZZ1JZXW000001']]);
    const up = await upload([{ filename: 'V5C.pdf', mime: 'application/pdf', content: pdf }], { claimId });
    expect(up.status).toBe(201);
    expect(up.body.items).toHaveLength(1);
    const itemId = up.body.items[0]!.id;
    expect(up.body.items[0]!.evidence.claimId).toBe(claimId);
    expect(jobsOf(t.ctx, 'intake.process').map((j) => j.payload)).toEqual([{ itemId }]);

    const ran = await drainIntake(t.ctx, NOW);
    expect(ran.map((r) => `${r.type}:${r.outcome}`)).toEqual(['intake.process:done', 'intake.extract:done', 'intake.apply:done']);

    const item = t.ctx.repos.requireIntakeItem(t.ctx.db, itemId);
    expect(item).toMatchObject({ status: 'needs_you', sniffedType: 'pdf', docType: 'v5c', pages: 1 });
    const extractions = t.ctx.repos.listIntakeExtractions(t.ctx.db, itemId);
    expect(extractions).toHaveLength(1);
    expect(extractions[0]!.runId).toBeTruthy();
    expect(t.ctx.repos.getAgentRun(t.ctx.db, extractions[0]!.runId!)).toMatchObject({ agent: 'intake', jobType: 'intake.extract', driver: 'fake', outcome: 'ok' });
    // the model's claim_field_propose call went through the dispatcher
    expect(t.ctx.repos.listAgentToolCalls(t.ctx.db, extractions[0]!.runId!).map((c) => [c.tool, c.decision])).toEqual([['claim_field_propose', 'allowed']]);

    const proposals = t.ctx.repos.listClaimUpdateProposals(t.ctx.db, { intakeItemId: itemId });
    const byTarget = Object.fromEntries(proposals.map((p) => [p.target, p]));
    expect(byTarget['vehicle:client.registration']).toBeUndefined(); // same as on file
    expect(byTarget['vehicle:client.make']).toBeUndefined();
    expect(byTarget['vehicle:client.vin']).toMatchObject({ policyDecision: 'auto', status: 'applied' });
    expect(byTarget['vehicle:client.firstRegistered']).toMatchObject({ policyDecision: 'auto', status: 'applied', proposedValue: '2021-03' });
    expect(byTarget['party:client.dateOfBirth']).toMatchObject({ policyDecision: 'confirm', status: 'pending', sensitive: true, proposedValue: '1990-04-12', source: { via: 'tool' } });
    expect(byTarget['vehicle:client.model']).toMatchObject({ policyDecision: 'confirm', status: 'pending', currentValue: 'Yaris' });

    // Extractions are append-only in the database.
    expect(() => t.ctx.handle.sqlite.prepare('UPDATE intake_extractions SET summary = ? WHERE id = ?').run('x', extractions[0]!.id)).toThrow(/append-only/);

    // GET /intake and /intake/:id
    const list = await t.api<{ items: Array<{ id: string; docTypeLabel: string; proposals: { pending: number } }>; total: number }>('GET', '/intake');
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({ id: itemId, docTypeLabel: 'V5C', proposals: { pending: 3 } });
    const detail = await t.api<{ pageTexts: string[]; extractions: unknown[]; proposalList: Array<{ label: string }>; needsYou: Array<{ kind: string }> }>('GET', `/intake/${itemId}`);
    expect(detail.body.pageTexts[0]).toContain('KX21 ABC');
    expect(detail.body.extractions).toHaveLength(1);
    expect(detail.body.proposalList.map((p) => p.label)).toContain('Client vehicle VIN');
    expect(detail.body.needsYou.map((n) => n.kind)).toEqual(['confirm_fields']);
  });

  it('an email explodes into child items (attachments) on the same claim', async () => {
    const png = makePng({ width: 6, height: 6, seed: 9 });
    const eml = makeEml({ from: 'Claims <claims@insurer.example>', to: 'claims@ccguk.example', subject: 'Reference', body: 'INTAKE-FIXTURE-EMAIL\nOur ref: EXI/2026/0042', attachments: [{ filename: 'rear.png', mime: 'image/png', content: png }] });
    const up = await upload([{ filename: 'insurer.eml', mime: 'message/rfc822', content: eml }], { claimId });
    const parentId = up.body.items[0]!.id;
    await drainIntake(t.ctx, NOW);
    const parent = t.ctx.repos.requireIntakeItem(t.ctx.db, parentId);
    expect(parent).toMatchObject({ sniffedType: 'eml', docType: 'insurer_letter', status: 'applied' });
    const children = t.ctx.repos.listIntakeItems(t.ctx.db, { parentItemId: parentId });
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ claimId, source: 'upload', sniffedType: 'png', docType: 'damage_photo', status: 'applied' });
    expect(t.ctx.repos.requireEvidence(t.ctx.db, children[0]!.evidenceId)).toMatchObject({ claimId, filename: 'rear.png', mime: 'image/png' });
    expect(t.ctx.repos.requireClaim(t.ctx.db, claimId).atFaultInsurerRef).toBe('EXI/2026/0042');
  });

  it('accepts the mail slice payload {evidenceId, claimId, source:"email"} exactly', async () => {
    const pdf = await makeTextPdf([['INTAKE-FIXTURE-EMAIL', 'Our ref: EXI/2026/0042']]);
    const stored = await storeEvidenceBuffer(t.ctx, pdf, { claimId, filename: 'letter.pdf', mime: 'application/pdf', fields: { kind: 'correspondence' }, actor: { userId: 'agent:mail' } });
    enqueueJob(t.ctx, { type: 'intake.process', payload: { evidenceId: stored.evidence.id, claimId, source: 'email' }, claimId, idempotencyKey: 'intake.process:mail:att-1', createdBy: 'agent:mail' });
    await drainIntake(t.ctx, NOW);
    const item = t.ctx.repos.findIntakeItemByEvidence(t.ctx.db, stored.evidence.id)!;
    expect(item).toMatchObject({ source: 'email', claimId, status: 'applied', createdBy: 'agent:mail' });
  });

  it('a chunked upload with purpose intake and the import folder both become items; the scan is idempotent', async () => {
    const pdf = await makeTextPdf([['INTAKE-FIXTURE-EMAIL', 'Our ref: EXI/2026/0042']]);
    const created = await t.api<{ uploadId: string }>('POST', '/uploads', { filename: 'big-letter.pdf', bytes: pdf.length, mime: 'application/pdf', purpose: 'intake' });
    expect(created.status).toBe(201);
    const put = await t.app.inject({ method: 'PUT', url: `/api/uploads/${created.body.uploadId}?offset=0`, payload: pdf, headers: { 'content-type': 'application/octet-stream' } });
    expect(put.statusCode).toBe(200);
    expect((await t.api('POST', `/uploads/${created.body.uploadId}/complete`, {})).status).toBe(201);
    const viaUpload = await t.api<{ items: Array<{ id: string; source: string; claimId?: string }> }>('POST', '/intake', { uploadId: created.body.uploadId, claimId });
    expect(viaUpload.status).toBe(201);
    expect(viaUpload.body.items[0]).toMatchObject({ source: 'upload', claimId });
    // the same upload again returns the same item (the import is consumed by intake)
    expect((await t.api<{ items: Array<{ id: string }> }>('POST', '/intake', { uploadId: created.body.uploadId })).body.items[0]!.id).toBe(viaUpload.body.items[0]!.id);

    // Import folder: a staged import with purpose intake (no claim) is picked up by the scan.
    const dropDir = path.join(t.ctx.config.dataDir, 'test-drop');
    mkdirSync(dropDir, { recursive: true });
    const dropped = path.join(dropDir, 'scan.pdf');
    writeFileSync(dropped, await makeTextPdf([['A dropped letter with no claim reference']]));
    const imp = await stageImport(t.ctx, dropped, { purpose: 'intake', source: 'folder' });
    expect(await scanStagedIntakeImports(t.ctx)).toEqual({ created: 1, failed: 0 });
    expect(await scanStagedIntakeImports(t.ctx)).toEqual({ created: 0, failed: 0 });
    const folderItem = t.ctx.repos.listIntakeItems(t.ctx.db, { claimId: null })[0]!;
    expect(folderItem).toMatchObject({ source: 'folder', status: 'queued' });
    expect(t.ctx.repos.requireEvidence(t.ctx.db, folderItem.evidenceId).claimId).toBeUndefined();
    const res = await t.api<{ status: string; consumedBy: string }>('GET', `/imports/${imp.id}`);
    expect(res.body).toMatchObject({ status: 'consumed', consumedBy: 'intake' });
    expect(auditRows(t.ctx, 'intake.create').length).toBe(2);
  });

  it('HEIC asks the owner to export a JPEG; a CAB is skipped; a quota refusal waits without failing', async () => {
    const heic = await upload([{ filename: 'IMG_0042.HEIC', mime: 'image/heic', content: makeHeicHeader() }], { claimId });
    const cab = await upload([{ filename: 'AUDATEX.cab', mime: 'application/octet-stream', content: Buffer.from('MSCF\0\0\0\0rest', 'latin1') }], { claimId });
    const quota = await upload([{ filename: 'letter.pdf', mime: 'application/pdf', content: await makeTextPdf([['INTAKE-FIXTURE-QUOTA']]) }], { claimId });
    await drainIntake(t.ctx, NOW);
    expect(t.ctx.repos.requireIntakeItem(t.ctx.db, heic.body.items[0]!.id)).toMatchObject({ status: 'needs_you', sniffedType: 'heic' });
    // A HEIC with a broken box structure is stored as octet-stream so the EXIF reader never sees it (it can loop).
    expect(t.ctx.repos.requireEvidence(t.ctx.db, heic.body.items[0]!.evidence.id).mime).toBe('application/octet-stream');
    const q = t.ctx.repos.findOpenNeedsYouByDedupeKey(t.ctx.db, `intake:heic:${heic.body.items[0]!.id}`);
    expect(q).toMatchObject({ kind: 'question', claimId });
    expect(q!.title).toMatch(/JPEG/);
    expect(t.ctx.repos.requireIntakeItem(t.ctx.db, cab.body.items[0]!.id)).toMatchObject({ status: 'skipped', sniffedType: 'cab', error: expect.stringMatching(/engineer data/) });
    expect(t.ctx.repos.requireIntakeItem(t.ctx.db, quota.body.items[0]!.id).status).toBe('quota_wait');
    expect(jobsOf(t.ctx, 'intake.extract').find((j) => (j.payload as { itemId: string }).itemId === quota.body.items[0]!.id)?.status).toBe('waiting_usage');
  });

  it('a driving licence photo: driving_licence, the personal details on ONE confirm card (unticked: sensitive)', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]), Buffer.alloc(64), Buffer.from([0xff, 0xd9])]);
    const up = await upload([{ filename: 'INTAKE-FIXTURE-LICENCE.jpg', mime: 'image/jpeg', content: jpeg }], { claimId });
    expect(up.status).toBe(201);
    await drainIntake(t.ctx, NOW);
    const item = t.ctx.repos.requireIntakeItem(t.ctx.db, up.body.items[0]!.id);
    expect(item).toMatchObject({ docType: 'driving_licence', sniffedType: 'jpeg', status: 'needs_you' });
    const cards = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'confirm_fields', claimId });
    expect(cards).toHaveLength(1);
    const targets = (cards[0]!.payload as { proposals: Array<{ target: string; sensitive: boolean }> }).proposals;
    expect(targets.filter((p) => p.sensitive).map((p) => p.target).sort()).toEqual(['party:client.dateOfBirth', 'party:client.drivingLicenceNumber']);
  });

  it('a bodyshop estimate PDF: bodyshop_estimate; the same registration is skipped and nothing needs the owner', async () => {
    const pdf = await makeTextPdf([['INTAKE-FIXTURE-ESTIMATE', 'Reg: KX21 ABC', 'Labour total 420.00', 'Parts total 1,180.00', 'TOTAL INC VAT 1,920.00']]);
    const up = await upload([{ filename: 'bodyshop-estimate.pdf', mime: 'application/pdf', content: pdf }], { claimId });
    await drainIntake(t.ctx, NOW);
    expect(t.ctx.repos.requireIntakeItem(t.ctx.db, up.body.items[0]!.id)).toMatchObject({ docType: 'bodyshop_estimate', status: 'applied' });
    expect(t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'confirm_fields', claimId })).toEqual([]);
  });

  it('an extraction that keeps failing ends dead with ONE Needs-you failure on the claim (§C.3)', async () => {
    const pdf = await makeTextPdf([['A letter that no fixture matches (INTAKE-NO-FIXTURE).']]);
    const up = await upload([{ filename: 'letter.pdf', mime: 'application/pdf', content: pdf }], { claimId });
    let now = NOW;
    for (let i = 0; i < 4; i += 1) {
      await drainIntake(t.ctx, now);
      now = new Date(Date.parse(now) + 2 * 60_000).toISOString();
    }
    const job = jobsOf(t.ctx, 'intake.extract').find((j) => (j.payload as { itemId: string }).itemId === up.body.items[0]!.id)!;
    expect(job.status).toBe('dead');
    const failures = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'failure', claimId });
    expect(failures).toHaveLength(1);
  });

  it('large files are never parsed whole: a 70 MiB text is skipped before it is read; a 25 MiB photo is kept but not given to the model', async () => {
    const big = Buffer.alloc(70 * 1024 * 1024, 0x61);
    const text = await upload([{ filename: 'big.txt', mime: 'text/plain', content: big }], { claimId });
    const photo = await upload([{ filename: 'big.jpg', mime: 'image/jpeg', content: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]), Buffer.alloc(25 * 1024 * 1024)]) }], { claimId });
    await drainIntake(t.ctx, NOW);
    expect(t.ctx.repos.requireIntakeItem(t.ctx.db, text.body.items[0]!.id)).toMatchObject({ status: 'skipped', sniffedType: 'text', error: expect.stringMatching(/too large for intake to read/) });
    expect(t.ctx.repos.requireIntakeItem(t.ctx.db, photo.body.items[0]!.id)).toMatchObject({ status: 'skipped', sniffedType: 'jpeg', error: expect.stringMatching(/too large to give the agents/) });
    expect(jobsOf(t.ctx, 'intake.extract')).toEqual([]);
  }, 60_000);

  it('while the agents are switched off, a document being read says why it is waiting', async () => {
    t.ctx.repos.patchAgentSettings(t.ctx.db, { agents: { enabled: false } }, { userId: 'owner' });
    const pdf = await makeTextPdf([['INTAKE-FIXTURE-V5C', 'Registration mark KX21 ABC']]);
    const up = await upload([{ filename: 'V5C.pdf', mime: 'application/pdf', content: pdf }], { claimId });
    const [proc] = queued(t.ctx, 'intake.process');
    await runJob(t.ctx, proc!);
    const row = await t.api<{ status: string; waiting: { reason: string } | null }>('GET', `/intake/${up.body.items[0]!.id}`);
    expect(row.body.status).toBe('extracting');
    expect(row.body.waiting).toEqual({ reason: 'agents_off' });
    t.ctx.repos.patchAgentSettings(t.ctx.db, { agents: { enabled: true } }, { userId: 'owner' });
    expect((await t.api<{ waiting: unknown }>('GET', `/intake/${up.body.items[0]!.id}`)).body.waiting).toBeNull();
  });

  it('refuses an upload with no file and a JSON body naming nothing', async () => {
    expect((await upload([], { claimId })).status).toBe(400);
    expect((await t.api('POST', '/intake', { claimId })).status).toBe(400);
    expect((await t.api('POST', '/intake', { importId: 'missing-import-id-123' })).status).toBe(404);
  });
});
