/**
 * Word template library and DOCX claim documents (TEMPLATES-VEHICLES-DESKTOP §C): built-in sync, upload pipeline and
 * refusals, mapping save/reset, the values form, generation (acknowledgement gate, guards, signature boxes), the
 * stored .docx (hash-checked), approval to PDF through the browser converter, supersede, and HTML letters on the
 * letterhead.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// fflate (an API devDependency, the same zip library @ccguk/documents uses) builds .docx files in-test.
import { strToU8, zipSync, type Zippable } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { docxToPlainText, renderSample, scanDocx } from '@ccguk/documents';
import type { GeneratedDocument } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { recomputeClocks } from '../services/claimView.js';
import type { ClaimTemplateValues } from '../services/docxDocuments.js';
import { syncBuiltinTemplates, type DocxTemplateDetail, type DocxTemplateSummary } from '../services/docxTemplates.js';

const CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
if (!process.env.CHROMIUM_PATH && existsSync(CHROMIUM)) process.env.CHROMIUM_PATH = CHROMIUM;


type ErrorBody = { error: { code: string; message: string; details?: { id?: string; issues?: Array<{ code: string; slotId?: string }> } } };

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const run = (text: string, bold = false) => `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (inner: string) => `<w:p>${inner}</w:p>`;
const cell = (inner: string, fill?: string) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/>${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ''}</w:tcPr>${inner || '<w:p/>'}</w:tc>`;
const row = (cells: string[]) => `<w:tr>${cells.join('')}</w:tr>`;
const labelValue = (label: string) => row([cell(para(run(label, true)), 'F4F6FA'), cell(para('<w:r><w:t xml:space="preserve"></w:t></w:r>'))]);

/** A synthetic Word template: {{tokens}} in body text and a label → empty value table. */
function buildDocx(opts: { body?: string; mainContentType?: string; extraParts?: Record<string, string>; documentXml?: string; marker?: string } = {}): Uint8Array {
  const body =
    opts.body ??
    [
      para(run(`Our reference {{claim.reference}} for {{claimant.name}}${opts.marker ? ` ${opts.marker}` : ''}`)),
      `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>${labelValue('Registration')}${labelValue('Date of birth')}${labelValue('Favourite colour')}</w:tbl>`,
      para(run('Signature')),
      para(''),
    ].join('');
  const files: Record<string, string> = {
    '[Content_Types].xml': `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${opts.mainContentType ?? MAIN_CT}"/></Types>`,
    '_rels/.rels': `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': opts.documentXml ?? `${DECL}<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    ...(opts.extraParts ?? {}),
  };
  const zippable: Zippable = {};
  for (const [name, content] of Object.entries(files)) zippable[name] = [strToU8(content), { level: 6, mtime: new Date(2026, 0, 1) }];
  return zipSync(zippable);
}

function multipart(fields: Record<string, string>, file?: { name: string; bytes: Uint8Array; field?: string }): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----claimdesk${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'file'}"; filename="${file.name}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n`));
    parts.push(Buffer.from(file.bytes));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp('2026-10-05T09:00:00.000Z', { config: { docxPdfConverter: 'browser' } });
});
afterEach(async () => {
  await t.close();
});

async function upload(fields: Record<string, string>, file?: { name: string; bytes: Uint8Array; field?: string }, url = '/api/docx-templates') {
  const { payload, headers } = multipart(fields, file);
  const res = await t.app.inject({ method: 'POST', url, payload, headers });
  return { status: res.statusCode, body: JSON.parse(res.body) as DocxTemplateDetail & ErrorBody };
}

async function raw(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await t.app.inject({ method, url: `/api${url}`, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: res.statusCode, headers: res.headers, bytes: res.rawPayload, body: res.body };
}

function seedFileOne() {
  const ids = t.ctx.repos.seedFileOne(t.ctx.db);
  recomputeClocks(t.ctx, ids.claimId);
  return ids;
}

const ack = (id: string) => t.api<DocxTemplateSummary>('POST', `/docx-templates/${id}/acknowledge`, {});

describe('built-in templates', () => {
  it('lists the ten built-ins with their warnings (01, 02 legacy wording; letterhead regulated status)', async () => {
    const res = await t.api<{ items: DocxTemplateSummary[] }>('GET', '/docx-templates');
    expect(res.status).toBe(200);
    const items = res.body.items;
    expect(items.filter((i) => i.source === 'builtin')).toHaveLength(10);
    for (const i of items) {
      expect(i.format).toBe('docx');
      expect(i.active).toBe(true);
      expect(i.slotCount).toBeGreaterThan(0);
      expect(i.unmappedCount).toBe(0);
      expect(i.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const byId = new Map(items.map((i) => [i.id, i]));
    const codes = (id: string) => byId.get(id)!.warnings.map((w) => w.code);
    expect(codes('agreement.ccguk_01_customer_loa')).toContain('LEGACY_DETAIL');
    expect(codes('agreement.ccguk_02_recovery_storage_engineering')).toContain('LEGACY_DETAIL');
    expect(codes('letter.ccguk_letterhead_formal')).toContain('REGULATED_STATUS');
    expect(codes('statement.ccguk_04_witness')).toEqual([]);
    expect(byId.get('agreement.ccguk_01_customer_loa')!.warningsAcknowledged).toBe(false);
    expect(byId.get('statement.ccguk_04_witness')!.warningsAcknowledged).toBe(true);
    expect(byId.get('agreement.ccguk_03_credit_hire')!.variants.map((v) => v.id)).toEqual(['hirer', 'office']);
    expect(byId.get('agreement.ccguk_03_credit_hire')!.subjects).toEqual(['hire']);
    // the boot-time fill of a fresh database is not audited; a second sync of the same files changes nothing
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'docx_template.sync' })).toHaveLength(0);
    expect(syncBuiltinTemplates(t.ctx)).toEqual({ synced: [], failed: [] });
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'docx_template.sync' })).toHaveLength(0);
  });

  it('detail carries slots, blocks, the outline, the field dictionary and zero mapping issues', async () => {
    for (const id of ['agreement.ccguk_03_credit_hire', 'letter.ccguk_letterhead_formal']) {
      const res = await t.api<DocxTemplateDetail>('GET', `/docx-templates/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.slots.length).toBe(res.body.slotCount);
      expect(res.body.mapping).toHaveLength(res.body.slotCount);
      expect(res.body.mappingIssues).toEqual([]);
      expect(res.body.mapping.every((m) => m.origin === 'builtin')).toBe(true);
      expect(res.body.fields.length).toBeGreaterThan(100);
      if (id === 'agreement.ccguk_03_credit_hire') expect(res.body.outline.length).toBeGreaterThan(0);
      // signature boxes are signed by hand
      const sig = res.body.slots.filter((s) => s.signature).map((s) => s.id);
      for (const m of res.body.mapping.filter((x) => sig.includes(x.slotId))) expect(m.policy).toBe('signature');
    }
    expect((await t.api<ErrorBody>('GET', '/docx-templates/nope.missing')).status).toBe(404);
  });

  it('mapping override on a built-in is saved as "saved" and reset back to the curated default', async () => {
    const id = 'form.ccguk_09_accident_report';
    const detail = (await t.api<DocxTemplateDetail>('GET', `/docx-templates/${id}`)).body;
    const target = detail.mapping.find((m) => m.key && m.policy !== 'signature' && !m.ignored)!;
    const saved = await t.api<DocxTemplateDetail>('PUT', `/docx-templates/${id}/mapping`, { entries: [{ slot: target.slotId, policy: 'handler' }] });
    expect(saved.status).toBe(200);
    expect(saved.body.mappingRevision).toBe(detail.mappingRevision + 1);
    const row = saved.body.mapping.find((m) => m.slotId === target.slotId)!;
    expect(row).toMatchObject({ origin: 'saved', policy: 'handler' });
    expect(row.key).toBeUndefined();
    expect(saved.body.mappingIssues).toEqual([]);
    // an untouched row keeps its built-in status
    expect(saved.body.mapping.filter((m) => m.origin === 'builtin').length).toBe(detail.mapping.length - 1);

    const bad = await t.api<ErrorBody>('PUT', `/docx-templates/${id}/mapping`, { entries: [{ slot: 'no/such-slot', key: 'claim.reference' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('MAPPING_INVALID');
    expect(bad.body.error.details?.issues?.[0]?.code).toBe('SELECTOR_NO_MATCH');

    const reset = await t.api<DocxTemplateDetail>('DELETE', `/docx-templates/${id}/mapping`);
    expect(reset.status).toBe(200);
    expect(reset.body.mapping.every((m) => m.origin === 'builtin')).toBe(true);
    expect(reset.body.mappingRevision).toBe(detail.mappingRevision + 2);
    const actions = t.ctx.repos.listAudit(t.ctx.db, { entity: 'document_templates', entityId: id }).map((a) => a.action);
    expect(actions.filter((a) => a === 'docx_template.mapping')).toHaveLength(2);
  });

  it('PATCH, acknowledge, original file download, test fill and converters', async () => {
    const id = 'agreement.ccguk_01_customer_loa';
    const patched = await t.api<DocxTemplateSummary>('PATCH', `/docx-templates/${id}`, { description: 'Signed at the first meeting' });
    expect(patched.status).toBe(200);
    expect(patched.body.description).toBe('Signed at the first meeting');
    const acked = await ack(id);
    expect(acked.body.warningsAcknowledged).toBe(true);
    const audit = t.ctx.repos.listAudit(t.ctx.db, { entity: 'document_templates', entityId: id, action: 'docx_template.acknowledge' });
    expect(audit[0]?.userId).toBe('handler');

    const file = await raw('GET', `/docx-templates/${id}/file`);
    expect(file.status).toBe(200);
    expect(file.bytes.subarray(0, 2).toString()).toBe('PK');
    expect(file.headers['x-sha256']).toBe(patched.body.sha256);
    expect(String(file.headers['content-disposition'])).toMatch(/^attachment;/);

    const fill = await raw('POST', `/docx-templates/${id}/test-fill`, {});
    expect(fill.status).toBe(200);
    expect(fill.bytes.subarray(0, 2).toString()).toBe('PK');
    expect(docxToPlainText(new Uint8Array(fill.bytes))).toContain('CCG-2026-00012'); // the sample merge source

    const conv = await t.api<{ preference: string; order: string[]; available: Record<string, { ok: boolean }> }>('GET', '/docx-converters');
    expect(conv.status).toBe(200);
    expect(conv.body.preference).toBe('browser');
    expect(conv.body.order[0]).toBe('browser');
    expect(Object.keys(conv.body.available).sort()).toEqual(['browser', 'libreoffice', 'word']);
  });
});

describe('uploaded templates', () => {
  it('upload → stored under TEMPLATES_DIR with a suggested mapping (tokens exact, labels by synonym)', async () => {
    const res = await upload({ title: 'My test letter', kind: 'letter', description: 'synthetic' }, { name: 'my-letter.docx', bytes: buildDocx() });
    expect(res.status).toBe(201);
    const d = res.body;
    expect(d.id).toMatch(/^letter\.user_my_test_letter_[0-9a-f]{4}$/);
    expect(d).toMatchObject({ source: 'uploaded', format: 'docx', fileVersion: 1, mappingRevision: 1, kind: 'letter', title: 'My test letter', fileName: 'my-letter.docx' });
    const ref = d.mapping.find((m) => m.key === 'claim.reference');
    expect(ref).toMatchObject({ origin: 'suggested', score: 1 });
    expect(d.mapping.some((m) => m.key === 'claimant.name' && m.origin === 'suggested')).toBe(true);
    expect(d.mapping.some((m) => m.key === 'vehicle.registration')).toBe(true);
    // "Favourite colour" matches no field: left for the handler, and the template says so
    expect(d.unmappedCount).toBeGreaterThan(0);
    expect(d.warnings.map((w) => w.code)).toContain('UNMAPPED_SLOTS');
    const row = t.ctx.repos.requireDocumentTemplate(t.ctx.db, d.id);
    const abs = path.join(t.ctx.config.templatesDir, row.filePath!);
    expect(abs.startsWith(t.ctx.config.templatesDir)).toBe(true);
    expect(row.filePath).toBe(`${d.id}/v1-${d.sha256.slice(0, 12)}.docx`);
    expect(existsSync(abs)).toBe(true);
    expect(t.ctx.repos.listAudit(t.ctx.db, { entity: 'document_templates', entityId: d.id })[0]?.action).toBe('docx_template.create');

    // duplicate of an active upload
    const dup = await upload({ title: 'Again', kind: 'letter' }, { name: 'again.docx', bytes: buildDocx() });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('TEMPLATE_DUPLICATE');
    expect(dup.body.error.details?.id).toBe(d.id);

    // the list now has 11 items
    const list = await t.api<{ items: DocxTemplateSummary[] }>('GET', '/docx-templates');
    expect(list.body.items).toHaveLength(11);
  });

  it('refuses a non-zip, a macro-enabled main part, a DTD, an oversize file, a file without slots and a wrong extension', async () => {
    const notZip = await upload({ title: 'x', kind: 'form' }, { name: 'x.docx', bytes: strToU8('this is not a zip file') });
    expect(notZip.status).toBe(400);
    expect(notZip.body.error.code).toBe('INVALID_DOCX');

    const macro = await upload({ title: 'x', kind: 'form' }, { name: 'x.docx', bytes: buildDocx({ mainContentType: 'application/vnd.ms-word.document.macroEnabled.main+xml' }) });
    expect(macro.status).toBe(400);
    expect(macro.body.error.code).toBe('INVALID_DOCX');
    expect(JSON.stringify(macro.body.error.details)).toContain('MACROS_REFUSED');

    const dtd = await upload({ title: 'x', kind: 'form' }, { name: 'x.docx', bytes: buildDocx({ documentXml: `${DECL}<!DOCTYPE w:document [<!ENTITY x "boom">]><w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>` }) });
    expect(dtd.status).toBe(400);
    expect(dtd.body.error.code).toBe('INVALID_DOCX');
    expect(JSON.stringify(dtd.body.error.details)).toContain('XML_DTD_REFUSED');

    const big = new Uint8Array(15 * 1024 * 1024 + 10);
    big.set(buildDocx(), 0);
    const oversize = await upload({ title: 'x', kind: 'form' }, { name: 'x.docx', bytes: big });
    expect(oversize.status).toBe(413);

    const empty = await upload({ title: 'x', kind: 'form' }, { name: 'x.docx', bytes: buildDocx({ body: para(run('Just printed words, nothing to fill.')) }) });
    expect(empty.status).toBe(422);
    expect(empty.body.error.code).toBe('NO_FILLABLE_SLOTS');

    const ext = await upload({ title: 'x', kind: 'form' }, { name: 'x.docm', bytes: buildDocx() });
    expect(ext.status).toBe(400);
    expect(ext.body.error.code).toBe('INVALID_DOCX');

    const noKind = await upload({ title: 'x', kind: 'invoice' }, { name: 'x.docx', bytes: buildDocx() });
    expect(noKind.status).toBe(400);
    expect(noKind.body.error.code).toBe('VALIDATION');
    // nothing was stored by any refusal
    expect(t.ctx.repos.listDocumentTemplates(t.ctx.db, { includeInactive: true }).filter((r) => r.source === 'uploaded')).toEqual([]);
  });

  it('mapping save (uploads), replacement file with carried-over slots, and DELETE mapping refused for uploads', async () => {
    const up = (await upload({ title: 'Form A', kind: 'form' }, { name: 'a.docx', bytes: buildDocx() })).body;
    const colour = up.slots.find((s) => s.labelSlug === 'favourite-colour')!;
    const entries = up.mapping.filter((m) => m.key || m.policy === 'signature').map((m) => ({ slot: m.slotId, ...(m.key ? { key: m.key } : {}), policy: m.policy }));
    const saved = await t.api<DocxTemplateDetail>('PUT', `/docx-templates/${up.id}/mapping`, { entries, ignore: [colour.id] });
    expect(saved.status).toBe(200);
    expect(saved.body.mappingRevision).toBe(2);
    expect(saved.body.mapping.find((m) => m.slotId === colour.id)).toMatchObject({ ignored: true, origin: 'saved' });
    expect(saved.body.mapping.every((m) => m.origin !== 'suggested')).toBe(true);
    expect(saved.body.unmappedCount).toBe(0);
    expect(saved.body.warnings.map((w) => w.code)).not.toContain('UNMAPPED_SLOTS');

    const handlerField = saved.body.fields.find((f) => f.policy === 'handler' && f.type === 'text')!;
    const laxer = await t.api<ErrorBody>('PUT', `/docx-templates/${up.id}/mapping`, { entries: [{ slot: colour.id, key: handlerField.key, policy: 'auto' }] });
    expect(laxer.status).toBe(400);
    expect(laxer.body.error.code).toBe('MAPPING_INVALID');
    expect(laxer.body.error.details?.issues?.map((i) => i.code)).toContain('POLICY_LAXER');
    const unknownKey = await t.api<ErrorBody>('PUT', `/docx-templates/${up.id}/mapping`, { entries: [{ slot: colour.id, key: 'no.such.field' }] });
    expect(unknownKey.status).toBe(400);
    expect(unknownKey.body.error.details?.issues?.map((i) => i.code)).toContain('UNKNOWN_KEY');

    expect((await t.api<ErrorBody>('DELETE', `/docx-templates/${up.id}/mapping`)).status).toBe(400);

    const next = await upload({}, { name: 'a-v2.docx', bytes: buildDocx({ marker: '(version 2)' }) }, `/api/docx-templates/${up.id}/file`);
    expect(next.status).toBe(200);
    expect(next.body.fileVersion).toBe(2);
    const regSlot = up.mapping.find((m) => m.key === 'vehicle.registration')!.slotId;
    expect(next.body.carriedOver).toContain(regSlot);
    expect(next.body.mapping.find((m) => m.slotId === colour.id)?.ignored).toBe(true);
    expect(next.body.warningsAcknowledged).toBe(next.body.warnings.length === 0);
    const row = t.ctx.repos.requireDocumentTemplate(t.ctx.db, up.id);
    expect(row.filePath).toBe(`${up.id}/v2-${next.body.sha256.slice(0, 12)}.docx`);
    // v1 stays on disk for audit
    expect(existsSync(path.join(t.ctx.config.templatesDir, `${up.id}/v1-${up.sha256.slice(0, 12)}.docx`))).toBe(true);
    // built-ins cannot be replaced
    const builtin = await upload({}, { name: 'b.docx', bytes: buildDocx({ marker: 'x' }) }, '/api/docx-templates/form.ccguk_09_accident_report/file');
    expect(builtin.status).toBe(400);
  });
});

describe('DOCX claim documents', () => {
  const CH = 'agreement.ccguk_03_credit_hire';

  it('values for a seeded claim show origins, subjects and non-editable signature rows; unacknowledged warnings are an issue', async () => {
    const ids = seedFileOne();
    const res = await t.api<ClaimTemplateValues>('GET', `/claims/${ids.claimId}/docx-templates/${CH}/values?variant=hirer`);
    expect(res.status).toBe(200);
    const v = res.body;
    expect(v.template.id).toBe(CH);
    expect(v.variant).toBe('hirer');
    expect(v.subjects.hires?.map((h) => h.id)).toContain(ids.hireId);
    const rows = v.groups.flatMap((g) => g.rows);
    expect(rows.some((r) => r.origin === 'claim' && r.display !== '')).toBe(true);
    const sig = rows.filter((r) => r.policy === 'signature');
    expect(sig.length).toBeGreaterThan(0);
    for (const r of sig) {
      expect(r.editable).toBe(false);
      expect(r.display).toBe('');
    }
    expect(v.summary.leftForSigning).toBe(sig.length);
    expect(v.summary.fromClaim).toBeGreaterThan(0);
    expect(v.issues.map((i) => i.code)).toContain('TEMPLATE_WARNINGS_UNACKNOWLEDGED');
    // the claim reference is printed from the claim
    const claim = t.ctx.repos.requireClaim(t.ctx.db, ids.claimId);
    expect(rows.some((r) => r.display.includes(claim.reference))).toBe(true);
  });

  it('generate: 409 before acknowledgement, 201 after; .docx served with x-sha256; tamper → 409; approve → PDF by the browser converter; supersede re-uses inputs', async () => {
    const ids = seedFileOne();
    const claim = t.ctx.repos.requireClaim(t.ctx.db, ids.claimId);
    const early = await t.api<ErrorBody>('POST', `/claims/${ids.claimId}/docx-documents`, { templateId: CH });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('TEMPLATE_WARNINGS_UNACKNOWLEDGED');

    await ack(CH);
    const values = (await t.api<ClaimTemplateValues>('GET', `/claims/${ids.claimId}/docx-templates/${CH}/values`)).body;
    const editable = values.groups.flatMap((g) => g.rows).find((r) => r.editable && (r.inputType === 'text' || r.inputType === 'multiline') && r.display === '' && !r.slotId.includes('|'))!;
    expect(editable).toBeDefined();
    const created = await t.api<GeneratedDocument & ErrorBody>('POST', `/claims/${ids.claimId}/docx-documents`, { templateId: CH, subject: { hireAgreementId: ids.hireId }, values: { [editable.slotId]: 'Typed by the handler' } });
    expect(created.status).toBe(201);
    const doc = created.body;
    expect(doc.format).toBe('docx');
    expect(['draft', 'blocked']).toContain(doc.status);
    expect(doc.templateVersion).toMatch(/^1\.\d+\.0$/);
    expect(doc.docxSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.sha256).toBe(doc.docxSha256);
    expect(doc.docxPath).toBe(`${ids.claimId}/${doc.id}.docx`);
    expect(doc.html).toContain('<!DOCTYPE html>');
    const snap = doc.dataSnapshot._docx as { inputs: Record<string, unknown>; templateSha256: string; variant?: string; subject?: { hireAgreementId?: string } };
    expect(snap.inputs[editable.slotId]).toBe('Typed by the handler');
    expect(snap.variant).toBe('hirer');
    expect(snap.subject?.hireAgreementId).toBe(ids.hireId);
    const audit = t.ctx.repos.listAudit(t.ctx.db, { entity: 'documents', entityId: doc.id, action: 'document.create' })[0];
    expect(audit?.after).toMatchObject({ format: 'docx', docxSha256: doc.docxSha256, templateSha256: snap.templateSha256 });

    const file = await raw('GET', `/documents/${doc.id}/docx`);
    expect(file.status).toBe(200);
    expect(file.bytes.subarray(0, 2).toString()).toBe('PK');
    expect(file.headers['x-sha256']).toBe(doc.docxSha256);
    expect(String(file.headers['content-disposition'])).toContain(`${claim.reference} Vehicle Credit Hire Agreement.docx`);
    const text = docxToPlainText(new Uint8Array(file.bytes));
    expect(text).toContain(claim.reference);
    expect(text).toContain('Typed by the handler');
    // signature boxes stay blank in the filled file
    const filledScan = scanDocx(new Uint8Array(file.bytes));
    for (const s of filledScan.slots.filter((x) => x.signature)) expect(s.preview.replace(/[_\s/:]/g, '')).toBe('');

    // clear any open block so the draft can be approved
    let current: GeneratedDocument = doc;
    for (const f of (doc.consistency?.flags ?? []).filter((x) => x.severity === 'block' && !x.clearedAt)) {
      const cleared = await t.api<GeneratedDocument>('POST', `/documents/${doc.id}/clear-flag`, { code: f.code, excerpt: f.excerpt, reason: 'Reviewed in test' });
      expect(cleared.status).toBe(200);
      current = cleared.body;
    }
    expect(current.status).toBe('draft');

    // tamper with the stored file: refused on read and on approval, then restored
    const abs = path.join(t.ctx.config.documentsDir, doc.docxPath!);
    const original = readFileSync(abs);
    writeFileSync(abs, Buffer.concat([original, Buffer.from('x')]));
    const tampered = await t.api<ErrorBody>('GET', `/documents/${doc.id}/docx`);
    expect(tampered.status).toBe(409);
    expect(tampered.body.error.code).toBe('DOCUMENT_DOCX_TAMPERED');
    const tamperedApprove = await t.api<ErrorBody>('POST', `/documents/${doc.id}/approve`, {});
    expect(tamperedApprove.status).toBe(409);
    expect(tamperedApprove.body.error.code).toBe('DOCUMENT_DOCX_TAMPERED');
    writeFileSync(abs, original);

    const approved = await t.api<GeneratedDocument>('POST', `/documents/${doc.id}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.pdfConverter).toBe('browser');
    expect(approved.body.docxSha256).toBe(doc.docxSha256);
    const pdf = await raw('GET', `/documents/${doc.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.bytes.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.headers['x-sha256']).toBe(approved.body.sha256);
    const pdfAudit = t.ctx.repos.listAudit(t.ctx.db, { entity: 'documents', entityId: doc.id, action: 'document.pdf' })[0];
    expect(pdfAudit?.after).toMatchObject({ converter: 'browser' });
    expect(Array.isArray((pdfAudit?.after as { attempts?: unknown[] }).attempts)).toBe(true);

    // supersede: the previous inputs, subject and variant are re-used; new values merge over them
    const next = await t.api<GeneratedDocument>('POST', `/documents/${doc.id}/supersede`, { reason: 'Re-issue' });
    expect(next.status).toBe(201);
    expect(next.body.format).toBe('docx');
    expect(next.body.supersedesId).toBe(doc.id);
    const nextSnap = next.body.dataSnapshot._docx as { inputs: Record<string, unknown>; subject?: { hireAgreementId?: string } };
    expect(nextSnap.inputs[editable.slotId]).toBe('Typed by the handler');
    expect(nextSnap.subject?.hireAgreementId).toBe(ids.hireId);
    expect(t.ctx.repos.requireDocument(t.ctx.db, doc.id).status).toBe('superseded');
    const again = await raw('GET', `/documents/${next.body.id}/docx`);
    expect(docxToPlainText(new Uint8Array(again.bytes))).toContain('Typed by the handler');
    // new values in the supersede body are merged over the previous inputs
    const third = await t.api<GeneratedDocument>('POST', `/documents/${next.body.id}/supersede`, { values: { [editable.slotId]: 'Changed on re-issue' } });
    expect(third.status).toBe(201);
    expect((third.body.dataSnapshot._docx as { inputs: Record<string, unknown> }).inputs[editable.slotId]).toBe('Changed on re-issue');
    expect(docxToPlainText(new Uint8Array((await raw('GET', `/documents/${third.body.id}/docx`)).bytes))).toContain('Changed on re-issue');
  }, 120_000);

  it('baseline suppression: legacy wording printed in 01 is cleared by the system (TEMPLATE_BASELINE); the same name typed by a handler stays blocked', async () => {
    const ids = seedFileOne();
    const id = 'agreement.ccguk_01_customer_loa';
    await ack(id);
    const plain = await t.api<GeneratedDocument>('POST', `/claims/${ids.claimId}/docx-documents`, { templateId: id });
    expect(plain.status).toBe(201);
    const legacy = (plain.body.consistency?.flags ?? []).filter((f) => f.code === 'LEGACY_DETAIL');
    expect(legacy.length).toBeGreaterThan(0);
    for (const f of legacy) {
      expect(f.clearedBy).toBe('system');
      expect(f.clearedReason).toMatch(/^TEMPLATE_BASELINE/);
    }
    expect(plain.body.status).toBe('draft');
    expect((plain.body.dataSnapshot._docx as { baselineSuppressed?: unknown[]; warningsAcknowledgedBy?: string }).warningsAcknowledgedBy).toBe('handler');

    const values = (await t.api<ClaimTemplateValues>('GET', `/claims/${ids.claimId}/docx-templates/${id}/values`)).body;
    const free = values.groups.flatMap((g) => g.rows).find((r) => r.editable && (r.inputType === 'text' || r.inputType === 'multiline') && !r.slotId.includes('|'))!;
    const typed = await t.api<GeneratedDocument>('POST', `/claims/${ids.claimId}/docx-documents`, { templateId: id, values: { [free.slotId]: 'Car Flex Ltd' } });
    expect(typed.status).toBe(201);
    expect(typed.body.status).toBe('blocked');
    const open = (typed.body.consistency?.flags ?? []).filter((f) => f.code === 'LEGACY_DETAIL' && !f.clearedAt);
    expect(open).toHaveLength(1);
  });

  it('05 payment direction without bank details in Settings → 409 GUARD_BLOCKED', async () => {
    const ids = seedFileOne();
    const id = 'form.ccguk_05_payment_direction';
    await ack(id);
    expect(t.ctx.settings().bank?.sortCode ?? '').toBe('');
    const res = await t.api<ErrorBody>('POST', `/claims/${ids.claimId}/docx-documents`, { templateId: id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GUARD_BLOCKED');
    expect(res.body.error.details?.issues?.some((i) => i.code.toUpperCase().includes('BANK'))).toBe(true);
    expect(t.ctx.repos.listDocuments(t.ctx.db, { claimId: ids.claimId }).some((d) => d.templateId === id)).toBe(false);
  });

  it('input to a signature box → 400 SLOT_NOT_FILLABLE; missing required value → 400 VALUES_REQUIRED; unknown template → 404', async () => {
    const ids = seedFileOne();
    await ack(CH);
    const detail = (await t.api<DocxTemplateDetail>('GET', `/docx-templates/${CH}`)).body;
    const sig = detail.slots.find((s) => s.signature)!;
    const res = await t.api<ErrorBody>('POST', `/claims/${ids.claimId}/docx-documents`, { templateId: CH, values: { [sig.id]: 'J. Doe' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SLOT_NOT_FILLABLE');
    expect(res.body.error.details?.issues?.[0]?.slotId).toBe(sig.id);

    const letter = 'letter.ccguk_letterhead_formal';
    await ack(letter);
    const missing = await t.api<ErrorBody>('POST', `/claims/${ids.claimId}/docx-documents`, { templateId: letter });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('VALUES_REQUIRED');

    expect((await t.api<ErrorBody>('POST', `/claims/${ids.claimId}/docx-documents`, { templateId: 'form.nope' })).status).toBe(404);
    await t.api('PATCH', `/docx-templates/${CH}`, { active: false });
    expect((await t.api<ErrorBody>('POST', `/claims/${ids.claimId}/docx-documents`, { templateId: CH })).status).toBe(404);
  });
});

describe('HTML letters on the Word letterhead', () => {
  it('letterhead.docx for an approved letter.chaser_7 carries the claim reference; an invoice is NOT_A_LETTER', async () => {
    const ids = seedFileOne();
    const claim = t.ctx.repos.requireClaim(t.ctx.db, ids.claimId);
    const draft = await t.api<GeneratedDocument>('POST', `/claims/${ids.claimId}/documents`, { templateId: 'letter.chaser_7' });
    expect(draft.status).toBe(201);
    expect(draft.body.format).toBe('html');
    const approved = await t.api<GeneratedDocument>('POST', `/documents/${draft.body.id}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.body.pdfConverter).toBe('chromium-html');

    const res = await raw('GET', `/documents/${draft.body.id}/letterhead.docx`);
    expect(res.status).toBe(200);
    expect(res.bytes.subarray(0, 2).toString()).toBe('PK');
    expect(res.headers['x-sha256']).toMatch(/^[0-9a-f]{64}$/);
    const text = docxToPlainText(new Uint8Array(res.bytes));
    expect(text).toContain(claim.reference);
    expect(text).toContain('Example Insurance Ltd');
    const audit = t.ctx.repos.listAudit(t.ctx.db, { entity: 'documents', entityId: draft.body.id, action: 'document.letterhead_docx' })[0];
    expect((audit?.after as { sha256?: string }).sha256).toBe(res.headers['x-sha256']);

    // the HTML document has no Word file of its own
    expect((await t.api<ErrorBody>('GET', `/documents/${draft.body.id}/docx`)).status).toBe(404);

    // an invoice (rendered from the registry's sample data and stored as a draft on this claim)
    const sample = renderSample('invoice.storage');
    const invoice = t.ctx.repos.createDraft(t.ctx.db, { claimId: ids.claimId, templateId: 'invoice.storage', templateVersion: sample.templateVersion, title: sample.title, html: sample.html, sha256: sample.htmlSha256, dataSnapshot: {}, createdBy: 'handler' });
    expect(invoice.format).toBe('html');
    const notLetter = await t.api<ErrorBody>('GET', `/documents/${invoice.id}/letterhead.docx`);
    expect(notLetter.status).toBe(400);
    expect(notLetter.body.error.code).toBe('NOT_A_LETTER');
    // the GTA payment pack on File 1 is not a letter either
    expect((await t.api<ErrorBody>('GET', `/documents/${ids.packDocumentId}/letterhead.docx`)).body.error.code).toBe('NOT_A_LETTER');
  }, 120_000);

  it('GET /templates marks the HTML templates as format html', async () => {
    const res = await t.api<{ items: Array<{ id: string; format: string }> }>('GET', '/templates');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(10);
    expect(res.body.items.every((i) => i.format === 'html')).toBe(true);
  });
});
