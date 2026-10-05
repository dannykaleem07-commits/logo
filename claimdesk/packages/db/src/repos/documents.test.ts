import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { DocumentStateError, ValidationError } from '../errors.js';
import { createTestDatabase } from '../testing.js';
import { listAudit } from './audit.js';
import { approveDocument, attachSignature, clearDocumentFlag, createDraft, getDocument, listDocuments, listSignaturesForClaim, markDocumentSent, setConsistency, setDocumentPdf, supersedeDocument, voidDocument, type CreateDraftInput } from './documents.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

const approver = { userId: 'approver-1' };
const handler = { userId: 'handler-1' };

function draft(overrides: Partial<CreateDraftInput> = {}): CreateDraftInput {
  return {
    claimId: 'claim-1',
    templateId: 'letter.chaser_7',
    templateVersion: '1.0.0',
    title: 'Chaser',
    html: '<p>We received £1,287.</p>',
    sha256: 'abc'.padEnd(64, '0'),
    dataSnapshot: { paidPence: 111200 },
    createdBy: 'handler-1',
    ...overrides,
  };
}

describe('documents workflow', () => {
  it('draft → consistency block → cannot approve → clear flag with reason → approve → send', () => {
    const d = createDraft(h.db, draft());
    expect(d.status).toBe('draft');
    const blocked = setConsistency(h.db, d.id, {
      checkedAt: '2026-09-26T09:00:00.000Z',
      blocked: true,
      flags: [{ code: 'AMOUNT_PAID_MISMATCH', severity: 'block', message: 'draft says £1,287; ledger has £1,112', draftValue: '£1,287', ledgerValue: '£1,112.00' }],
    });
    expect(blocked.status).toBe('blocked');
    expect(() => approveDocument(h.db, d.id, approver)).toThrow(DocumentStateError);
    expect(() => markDocumentSent(h.db, d.id, handler, { sentVia: 'email' })).toThrow(DocumentStateError);
    expect(() => clearDocumentFlag(h.db, d.id, 'AMOUNT_PAID_MISMATCH', approver, '')).toThrow(ValidationError);
    const cleared = clearDocumentFlag(h.db, d.id, 'AMOUNT_PAID_MISMATCH', approver, 'figure corrected in draft and re-rendered');
    expect(cleared.status).toBe('draft');
    expect(cleared.consistency?.blocked).toBe(false);
    expect(cleared.consistency?.flags[0]?.clearedBy).toBe('approver-1');
    expect(() => approveDocument(h.db, d.id, { userId: 'system' })).toThrow(ValidationError);
    const approved = approveDocument(h.db, d.id, approver);
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe('approver-1');
    expect(() => approveDocument(h.db, d.id, approver)).toThrow(DocumentStateError);
    const sent = markDocumentSent(h.db, d.id, handler, { sentVia: 'email', sentAt: '2026-09-26T10:00:00.000Z' });
    expect(sent.status).toBe('sent');
    expect(sent.sentVia).toBe('email');
    expect(listAudit(h.db, { entity: 'documents', entityId: d.id }).map((a) => a.action)).toEqual(['document.send', 'document.approve', 'document.flag.clear']);
    expect(() => setConsistency(h.db, d.id, { checkedAt: 'x', flags: [], blocked: false })).toThrow(DocumentStateError);
  });

  it('a draft created with a blocking report starts blocked; a clean report unblocks', () => {
    const d = createDraft(h.db, draft({ consistency: { checkedAt: 'x', blocked: true, flags: [{ code: 'LEGACY_DETAIL', severity: 'block', message: 'Car Flex' }] } }));
    expect(d.status).toBe('blocked');
    expect(setConsistency(h.db, d.id, { checkedAt: 'y', blocked: false, flags: [] }).status).toBe('draft');
  });

  it('lists without html by default and with html on request', () => {
    createDraft(h.db, draft());
    createDraft(h.db, draft({ templateId: 'letter.ncaf', claimId: 'claim-2' }));
    const list = listDocuments(h.db, { claimId: 'claim-1' });
    expect(list).toHaveLength(1);
    expect(list[0]!.html).toBe('');
    expect(listDocuments(h.db, { templateId: 'letter.ncaf', includeHtml: true })[0]!.html).toContain('£1,287');
    expect(getDocument(h.db, list[0]!.id, { includeHtml: false })?.html).toBe('');
    expect(getDocument(h.db, list[0]!.id)?.html).toContain('<p>');
  });

  it('supersede marks the old one superseded and links the new draft (re-executed on date)', () => {
    const old = createDraft(h.db, draft({ templateId: 'agreement.credit_hire' }));
    const next = supersedeDocument(h.db, old.id, approver, draft({ templateId: 'agreement.credit_hire', html: '<p>v2</p>', sha256: 'def'.padEnd(64, '0') }), { reExecutedOn: '2026-09-27' });
    expect(next.supersedesId).toBe(old.id);
    expect(next.reExecutedOn).toBe('2026-09-27');
    expect(next.status).toBe('draft');
    expect(getDocument(h.db, old.id)?.status).toBe('superseded');
    expect(() => voidDocument(h.db, next.id, approver, '')).toThrow(ValidationError);
    expect(voidDocument(h.db, next.id, approver, 'wrong template').status).toBe('void');
  });

  it('attachSignature checks the hash and the creation-timestamp floor and records the certificate', () => {
    const d = createDraft(h.db, draft({ templateId: 'agreement.credit_hire', createdAt: '2026-08-10T10:00:00.000Z' }));
    const sig = {
      signerPartyId: 'party-1',
      signerName: 'Jane Doe',
      signerContact: 'jane@example.test',
      otpChannel: 'email' as const,
      otpVerifiedAt: '2026-08-10T10:04:00.000Z',
      ipAddress: '203.0.113.5',
      userAgent: 'Mozilla/5.0',
      signedAt: '2026-08-10T10:05:00.000Z',
      documentSha256: d.sha256,
      certificateId: 'cert-1',
    };
    expect(() => attachSignature(h.db, d.id, { ...sig, documentSha256: 'f'.repeat(64) })).toThrow(ValidationError);
    expect(() => attachSignature(h.db, d.id, { ...sig, signedAt: '2026-08-09T10:05:00.000Z' })).toThrow(/before the document was created/);
    const signed = attachSignature(h.db, d.id, sig);
    expect(signed.status).toBe('signed');
    expect(signed.signature?.certificateId).toBe('cert-1');
    expect(() => attachSignature(h.db, d.id, { ...sig, certificateId: 'cert-2' })).toThrow(DocumentStateError);
    const sigs = listSignaturesForClaim(h.db, 'claim-1');
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({ documentId: d.id, certificateId: 'cert-1', signedAt: '2026-08-10T10:05:00.000Z' });
    // a signed agreement can be sent
    expect(markDocumentSent(h.db, d.id, handler, { sentVia: 'email' }).status).toBe('sent');
  });
});

describe('DOCX document columns (migration 0004)', () => {
  it('HTML drafts default to format html with no DOCX fields', () => {
    const d = createDraft(h.db, draft());
    expect(d.format).toBe('html');
    expect(d.docxPath).toBeUndefined();
    expect(d.docxSha256).toBeUndefined();
    expect(d.pdfConverter).toBeUndefined();
  });

  it('createDraft / supersedeDocument / setDocumentPdf carry format, docxPath, docxSha256 and pdfConverter', () => {
    const sha = 'd'.repeat(64);
    const d = createDraft(h.db, draft({ templateId: 'form.ccguk_07_statement_of_means', templateVersion: '1.1.0', format: 'docx', docxPath: 'claim-1/x.docx', docxSha256: sha, sha256: sha }));
    expect(d).toMatchObject({ format: 'docx', docxPath: 'claim-1/x.docx', docxSha256: sha, sha256: sha });
    expect(listDocuments(h.db, { claimId: 'claim-1' })[0]).toMatchObject({ format: 'docx', docxSha256: sha });

    const withPdf = setDocumentPdf(h.db, d.id, { pdfPath: 'claim-1/x.pdf', sha256: 'e'.repeat(64), pdfConverter: 'browser' });
    expect(withPdf).toMatchObject({ pdfPath: 'claim-1/x.pdf', sha256: 'e'.repeat(64), pdfConverter: 'browser', docxSha256: sha });
    // an HTML render without a converter id leaves the column alone
    expect(setDocumentPdf(h.db, d.id, { pdfPath: 'claim-1/x.pdf', sha256: 'f'.repeat(64) }).pdfConverter).toBe('browser');

    const sha2 = 'a'.repeat(64);
    const next = supersedeDocument(h.db, d.id, handler, draft({ templateId: d.templateId, templateVersion: '1.1.0', format: 'docx', docxPath: 'claim-1/y.docx', docxSha256: sha2, sha256: sha2 }));
    expect(next).toMatchObject({ format: 'docx', docxPath: 'claim-1/y.docx', docxSha256: sha2, supersedesId: d.id });
    expect(getDocument(h.db, d.id)?.status).toBe('superseded');
  });
});
