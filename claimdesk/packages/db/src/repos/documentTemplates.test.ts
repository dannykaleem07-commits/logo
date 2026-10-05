import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { createTestDatabase } from '../testing.js';
import { listAudit } from './audit.js';
import {
  acknowledgeTemplateWarnings,
  createUploadedTemplate,
  getDocumentTemplate,
  listDocumentTemplates,
  patchDocumentTemplate,
  replaceTemplateFile,
  requireDocumentTemplate,
  saveTemplateMapping,
  templateWarningsAcknowledged,
  upsertBuiltinTemplate,
  type TemplateWarning,
} from './documentTemplates.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

const admin = { userId: 'admin-1' };
const system = { userId: 'system' as const };
const scan = { scannerVersion: 1, slots: [{ id: 'title/reference' }], blocks: [], outline: [], warnings: [] };
const brandWarning: TemplateWarning = { code: 'BRAND_CLAIM_IMAGE', message: 'accreditation strip' };

function builtin(sha = 'a'.repeat(64), warnings: TemplateWarning[] = [brandWarning]) {
  return { id: 'form.ccguk_05_payment_direction', kind: 'form' as const, title: 'Payment Authorisation & Settlement Direction', recipientRole: 'client' as const, fileName: 'CCGUK-05.docx', sha256: sha, bytes: 1234, scanVersion: 1, scan, warnings };
}

function upload(id = 'letter.user_my_letter_ab12', sha = 'b'.repeat(64)) {
  return { id, kind: 'letter' as const, title: 'My letter', description: 'test', fileName: 'my.docx', filePath: `${id}/v1-${sha.slice(0, 12)}.docx`, sha256: sha, bytes: 999, scanVersion: 1, scan, warnings: [], mapping: { schemaVersion: 1, templateId: id, entries: [{ slot: 'title/reference', key: 'claim.reference' }] } };
}

describe('document templates repository', () => {
  it('upsertBuiltinTemplate inserts, keeps mapping/ack/active on refresh and resets the ack when the sha changes', () => {
    const first = upsertBuiltinTemplate(h.db, builtin(), system);
    expect(first).toMatchObject({ source: 'builtin', fileVersion: 1, mappingRevision: 0, active: true, warnings: [brandWarning] });
    expect(first.filePath).toBeUndefined();
    expect(first.mapping).toBeUndefined();
    expect(templateWarningsAcknowledged(first)).toBe(false);

    saveTemplateMapping(h.db, first.id, { schemaVersion: 1, templateId: first.id, entries: [] }, admin);
    acknowledgeTemplateWarnings(h.db, first.id, admin);
    const same = upsertBuiltinTemplate(h.db, { ...builtin(), scanVersion: 2 }, system);
    expect(same).toMatchObject({ scanVersion: 2, mappingRevision: 1, warningsAcknowledgedBy: 'admin-1', fileVersion: 1 });
    expect(same.mapping).toEqual({ schemaVersion: 1, templateId: first.id, entries: [] });

    const changed = upsertBuiltinTemplate(h.db, builtin('c'.repeat(64)), system);
    expect(changed.warningsAcknowledgedAt).toBeUndefined();
    expect(changed).toMatchObject({ sha256: 'c'.repeat(64), fileVersion: 2, mappingRevision: 1 });
    expect(listAudit(h.db, { entity: 'document_templates', entityId: first.id }).map((a) => a.action)).toEqual(
      expect.arrayContaining(['docx_template.sync', 'docx_template.mapping', 'docx_template.acknowledge']),
    );
  });

  it('the first insert can skip its audit row (boot-time cache fill); later refreshes are always audited', () => {
    const b = upsertBuiltinTemplate(h.db, builtin(), system, { auditInsert: false });
    expect(listAudit(h.db, { entity: 'document_templates', entityId: b.id })).toEqual([]);
    upsertBuiltinTemplate(h.db, builtin('e'.repeat(64)), system, { auditInsert: false });
    expect(listAudit(h.db, { entity: 'document_templates', entityId: b.id }).map((a) => a.action)).toEqual(['docx_template.sync']);
  });

  it('a failed sync deactivates a built-in and the next successful sync re-activates it; a person switching it off sticks', () => {
    upsertBuiltinTemplate(h.db, builtin(), system);
    const failed = upsertBuiltinTemplate(h.db, { ...builtin(), active: false, warnings: [{ code: 'SYNC_FAILED', message: 'Sync failed: unreadable' }] }, system);
    expect(failed.active).toBe(false);
    expect(listDocumentTemplates(h.db).map((t) => t.id)).not.toContain(failed.id);
    expect(listDocumentTemplates(h.db, { includeInactive: true }).map((t) => t.id)).toContain(failed.id);
    expect(upsertBuiltinTemplate(h.db, builtin(), system).active).toBe(true);

    patchDocumentTemplate(h.db, failed.id, { active: false }, admin);
    expect(upsertBuiltinTemplate(h.db, builtin(), system).active).toBe(false);
  });

  it('createUploadedTemplate stores the file path, the suggested mapping (revision 1) and audits docx_template.create', () => {
    const t = createUploadedTemplate(h.db, upload(), admin);
    expect(t).toMatchObject({ source: 'uploaded', fileVersion: 1, mappingRevision: 1, createdBy: 'admin-1', active: true, description: 'test' });
    expect(t.filePath).toBe(`letter.user_my_letter_ab12/v1-${'b'.repeat(12)}.docx`);
    expect(requireDocumentTemplate(h.db, t.id).scan).toEqual(scan);
    expect(listAudit(h.db, { entity: 'document_templates', entityId: t.id })[0]).toMatchObject({ action: 'docx_template.create', userId: 'admin-1' });
    expect(() => createUploadedTemplate(h.db, upload(), admin)).toThrow(ValidationError);
    expect(() => createUploadedTemplate(h.db, { ...upload('x.user_bad_0000'), kind: 'invoice' as never }, admin)).toThrow(ValidationError);
  });

  it('replaceTemplateFile bumps file_version, resets the acknowledgement and refuses built-ins', () => {
    const t = createUploadedTemplate(h.db, { ...upload(), warnings: [{ code: 'BANNED_PHRASE', message: 'x' }] }, admin);
    acknowledgeTemplateWarnings(h.db, t.id, admin);
    const r = replaceTemplateFile(h.db, t.id, { fileName: 'v2.docx', filePath: `${t.id}/v2-${'d'.repeat(12)}.docx`, sha256: 'd'.repeat(64), bytes: 1000, scan, scanVersion: 1, warnings: [{ code: 'BANNED_PHRASE', message: 'y' }], mapping: { schemaVersion: 1, templateId: t.id, entries: [] } }, admin);
    expect(r).toMatchObject({ fileVersion: 2, mappingRevision: 2, sha256: 'd'.repeat(64), fileName: 'v2.docx' });
    expect(r.warningsAcknowledgedAt).toBeUndefined();
    upsertBuiltinTemplate(h.db, builtin(), system);
    expect(() => replaceTemplateFile(h.db, 'form.ccguk_05_payment_direction', { fileName: 'x', filePath: 'x', sha256: 'e', bytes: 1, scan, scanVersion: 1, warnings: [] }, admin)).toThrow(ValidationError);
    expect(listAudit(h.db, { entity: 'document_templates', entityId: t.id }).some((a) => a.action === 'docx_template.replace')).toBe(true);
  });

  it('saveTemplateMapping increments the revision; null resets a built-in but is refused for uploads', () => {
    const b = upsertBuiltinTemplate(h.db, builtin(), system);
    expect(saveTemplateMapping(h.db, b.id, { schemaVersion: 1, templateId: b.id, entries: [{ slot: 'x', key: 'claim.reference' }] }, admin).mappingRevision).toBe(1);
    const reset = saveTemplateMapping(h.db, b.id, null, admin);
    expect(reset.mappingRevision).toBe(2);
    expect(reset.mapping).toBeUndefined();
    const u = createUploadedTemplate(h.db, upload(), admin);
    expect(() => saveTemplateMapping(h.db, u.id, null, admin)).toThrow(ValidationError);
  });

  it('patch and acknowledge are audited; acknowledge needs a person; unknown ids are NotFound', () => {
    const u = createUploadedTemplate(h.db, upload(), admin);
    const p = patchDocumentTemplate(h.db, u.id, { title: 'Renamed', recipientRole: 'at_fault_insurer', description: null }, admin);
    expect(p).toMatchObject({ title: 'Renamed', recipientRole: 'at_fault_insurer' });
    expect(p.description).toBeUndefined();
    expect(() => patchDocumentTemplate(h.db, u.id, { title: '  ' }, admin)).toThrow(ValidationError);
    expect(() => acknowledgeTemplateWarnings(h.db, u.id, system)).toThrow(ValidationError);
    const ack = acknowledgeTemplateWarnings(h.db, u.id, admin);
    expect(ack.warningsAcknowledgedBy).toBe('admin-1');
    expect(ack.warningsAcknowledgedAt).toBeTruthy();
    expect(getDocumentTemplate(h.db, 'nope')).toBeUndefined();
    expect(() => requireDocumentTemplate(h.db, 'nope')).toThrow(NotFoundError);
    const actions = listAudit(h.db, { entity: 'document_templates', entityId: u.id }).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['docx_template.create', 'docx_template.patch', 'docx_template.acknowledge']));
  });
});
