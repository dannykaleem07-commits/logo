import { describe, it, expect } from 'vitest';
import type { GeneratedDocument, SignatureRecord } from '../types.js';
import { generateOtp, verifyOtp, normaliseContact, buildCertificate, certificateIdFor, signatureDateChecks, reExecutionLine } from './index.js';
import { formatLongDate, formatLongDateTime } from './dates.js';
import { fixtureDocument } from '../evidence/bundle.fixture.js';

const base = {
  secret: 'test-secret-do-not-use',
  documentId: 'doc-cha-1',
  documentSha256: 'B'.repeat(64),
  contact: 'Amir@Example.com',
  channel: 'email' as const,
  issuedAt: '2026-10-04T10:00:00Z'
};

describe('OTP generate/verify', () => {
  it('round-trips: a 6-digit code, a 64-hex token, expiry 10 minutes after issue', () => {
    const otp = generateOtp(base);
    expect(otp.code).toMatch(/^\d{6}$/);
    expect(otp.token).toMatch(/^[0-9a-f]{64}$/);
    expect(otp.expiresAt).toBe('2026-10-04T10:10:00.000Z');
    expect(otp.channel).toBe('email');
    const ok = verifyOtp({ ...base, token: otp.token, code: otp.code, now: '2026-10-04T10:05:00Z' });
    expect(ok).toEqual({ ok: true, expiresAt: '2026-10-04T10:10:00.000Z' });
  });

  it('is deterministic for the same inputs and different for a different document or contact', () => {
    const a = generateOtp(base);
    const b = generateOtp(base);
    expect(a).toEqual(b);
    expect(generateOtp({ ...base, documentId: 'doc-other' }).code === a.code && generateOtp({ ...base, documentId: 'doc-other' }).token === a.token).toBe(false);
    expect(generateOtp({ ...base, contact: 'someone@else.com' }).token).not.toBe(a.token);
    expect(generateOtp({ ...base, nonce: '1' }).token).not.toBe(a.token);
    expect(generateOtp({ ...base, secret: 'other' }).token).not.toBe(a.token);
  });

  it('contact normalisation means case/spacing of the email or phone does not break verification', () => {
    expect(normaliseContact('  Amir@Example.COM ')).toBe('amir@example.com');
    expect(normaliseContact('+44 7700 900123')).toBe('07700900123');
    const otp = generateOtp(base);
    expect(verifyOtp({ ...base, contact: 'amir@example.com', token: otp.token, code: otp.code, now: base.issuedAt }).ok).toBe(true);
    expect(verifyOtp({ ...base, documentSha256: 'b'.repeat(64), token: otp.token, code: otp.code, now: base.issuedAt }).ok).toBe(true);
  });

  it('expires at exactly ttl minutes; custom ttl honoured', () => {
    const otp = generateOtp(base);
    expect(verifyOtp({ ...base, token: otp.token, code: otp.code, now: '2026-10-04T10:10:00Z' }).ok).toBe(true); // on the boundary
    const late = verifyOtp({ ...base, token: otp.token, code: otp.code, now: '2026-10-04T10:10:01Z' });
    expect(late).toEqual({ ok: false, reason: 'expired', expiresAt: '2026-10-04T10:10:00.000Z' });
    const short = generateOtp({ ...base, ttlMinutes: 2 });
    expect(short.expiresAt).toBe('2026-10-04T10:02:00.000Z');
    expect(verifyOtp({ ...base, ttlMinutes: 2, token: short.token, code: short.code, now: '2026-10-04T10:03:00Z' }).reason).toBe('expired');
    // a verifier using the default ttl against a short-ttl token still agrees on the code (ttl is not in the HMAC)
    expect(verifyOtp({ ...base, token: short.token, code: short.code, now: '2026-10-04T10:01:00Z' }).ok).toBe(true);
  });

  it('rejects a wrong code, a tampered token, a different document and malformed input', () => {
    const otp = generateOtp(base);
    const wrongCode = String((Number(otp.code) + 1) % 1_000_000).padStart(6, '0');
    expect(verifyOtp({ ...base, token: otp.token, code: wrongCode, now: base.issuedAt }).reason).toBe('code_mismatch');
    const tampered = (otp.token[0] === 'a' ? 'b' : 'a') + otp.token.slice(1);
    expect(verifyOtp({ ...base, token: tampered, code: otp.code, now: base.issuedAt }).reason).toBe('code_mismatch');
    expect(verifyOtp({ ...base, documentSha256: 'c'.repeat(64), token: otp.token, code: otp.code, now: base.issuedAt }).reason).toBe('code_mismatch');
    expect(verifyOtp({ ...base, issuedAt: '2026-10-04T10:00:01Z', token: otp.token, code: otp.code, now: base.issuedAt }).reason).toBe('code_mismatch');
    expect(verifyOtp({ ...base, token: otp.token, code: '12345', now: base.issuedAt }).reason).toBe('malformed');
    expect(verifyOtp({ ...base, token: 'zz', code: otp.code, now: base.issuedAt }).reason).toBe('malformed');
    expect(verifyOtp({ ...base, token: otp.token, code: otp.code, now: 'not a date' }).reason).toBe('malformed');
    expect(verifyOtp({ ...base, token: otp.token, code: otp.code, now: '2026-10-04T09:00:00Z' }).reason).toBe('not_yet_valid');
    expect(() => generateOtp({ ...base, secret: '' })).toThrow();
    expect(() => generateOtp({ ...base, issuedAt: 'yesterday' })).toThrow();
  });
});

describe('buildCertificate', () => {
  const document = fixtureDocument('doc-cha-1', 'agreement.credit_hire', { title: 'Credit hire agreement', templateVersion: '1.2.0', sha256: 'b'.repeat(64), createdAt: '2026-09-21T10:00:00Z' });
  const signature: Omit<SignatureRecord, 'certificateId' | 'certificatePdfPath'> = {
    signerPartyId: 'p-claimant',
    signerName: 'Amir Hussain',
    signerContact: 'amir@example.com',
    otpChannel: 'sms',
    otpVerifiedAt: '2026-09-21T10:29:00Z',
    ipAddress: '203.0.113.9',
    userAgent: 'Mozilla/5.0 (iPhone)',
    signedAt: '2026-09-21T10:30:00Z',
    documentSha256: 'b'.repeat(64)
  };

  it('assembles every required field and a stable certificate id', () => {
    const cert = buildCertificate({ document, signature, otpToken: 'f'.repeat(64), generatedAt: '2026-09-21T10:31:00Z' });
    expect(cert.certificateId).toBe(certificateIdFor('doc-cha-1', 'b'.repeat(64), '2026-09-21T10:30:00Z', 'f'.repeat(64)));
    expect(cert.certificateId).toMatch(/^CERT-[0-9A-F]{16}$/);
    expect(cert.json.document).toEqual({ id: 'doc-cha-1', claimId: 'claim-1', title: 'Credit hire agreement', templateId: 'agreement.credit_hire', templateVersion: '1.2.0', sha256: 'b'.repeat(64), createdAt: '2026-09-21T10:00:00Z' });
    expect(cert.json.signer.name).toBe('Amir Hussain');
    expect(cert.json.signer.contact).toBe('amir@example.com');
    expect(cert.json.signer.otpChannel).toBe('sms');
    expect(cert.json.signer.otpVerifiedAt).toBe('2026-09-21T10:29:00Z');
    expect(cert.json.signer.ipAddress).toBe('203.0.113.9');
    expect(cert.json.signer.userAgent).toBe('Mozilla/5.0 (iPhone)');
    expect(cert.json.signer.signedAt).toBe('2026-09-21T10:30:00Z');
    expect(cert.json.integrity).toEqual({ hashMatchesDocument: true, signedAfterCreation: true });
    // the OTP token itself never appears; only its fingerprint
    expect(JSON.stringify(cert.json)).not.toContain('f'.repeat(64));
    // 21 September 2026 is in British Summer Time: the signer saw 11:30 on their own clock; the UTC instant stays alongside
    expect(cert.lines).toContain('Signed: 21 September 2026 11:30 BST (10:30 UTC)');
    expect(cert.lines).toContain('Identity verified by one-time passcode sent by SMS to amir@example.com, verified 21 September 2026 11:29 BST (10:29 UTC)');
    expect(cert.lines).toContain('Document: Credit hire agreement (agreement.credit_hire v1.2.0, id doc-cha-1)');
    expect(cert.lines).toContain(`Hash at signing: ${'b'.repeat(64)} (matches document)`);
    expect(cert.lines.at(-1)).toBe('Signature time is after document creation.');
  });

  it('flags a hash mismatch and a signature before creation in the lines and json', () => {
    const cert = buildCertificate({
      document,
      signature: { ...signature, documentSha256: 'c'.repeat(64), signedAt: '2026-09-20T10:30:00Z', certificateId: 'CERT-GIVEN' },
      otpToken: 'f'.repeat(64),
      generatedAt: '2026-09-21T10:31:00Z',
      issuer: 'Test Issuer'
    });
    expect(cert.certificateId).toBe('CERT-GIVEN');
    expect(cert.json.issuer).toBe('Test Issuer');
    expect(cert.json.integrity).toEqual({ hashMatchesDocument: false, signedAfterCreation: false });
    expect(cert.lines.some((l) => l.includes('DOES NOT MATCH DOCUMENT'))).toBe(true);
    expect(cert.lines.at(-1)).toContain('WARNING');
  });

  it('includes the supersession line for re-executed documents', () => {
    const cert = buildCertificate({ document: { ...document, supersedesId: 'doc-cha-0', reExecutedOn: '2026-10-04' }, signature, otpToken: 'f'.repeat(64), generatedAt: '2026-10-04T12:00:00Z' });
    // the certificate is a human-read document: the re-execution date is printed long-form, never as raw ISO
    expect(cert.lines).toContain('Supersedes document doc-cha-0; re-executed on 4 October 2026');
    expect(cert.json.document.supersedesId).toBe('doc-cha-0');
  });
});

describe('signatureDateChecks and reExecutionLine', () => {
  const sig = (signedAt: string): SignatureRecord => ({
    signerPartyId: 'p-claimant',
    signerName: 'Amir Hussain',
    signerContact: 'amir@example.com',
    otpChannel: 'email',
    otpVerifiedAt: signedAt,
    ipAddress: '203.0.113.9',
    userAgent: 'UA',
    signedAt,
    documentSha256: 'b'.repeat(64),
    certificateId: 'CERT-X'
  });

  it('blocks a signature earlier than creation', () => {
    const docs: GeneratedDocument[] = [fixtureDocument('d1', 'agreement.credit_hire', { createdAt: '2026-09-21T10:00:00Z', signature: sig('2026-09-20T18:00:00Z') })];
    const flags = signatureDateChecks(docs, 'claim-1');
    expect(flags).toHaveLength(1);
    expect(flags[0]!.code).toBe('DATE_BEFORE_CREATION');
    expect(flags[0]!.severity).toBe('block');
    expect(flags[0]!.message).toContain('signed on 20 September 2026 19:00 BST (18:00 UTC) but was created on 21 September 2026 11:00 BST (10:00 UTC)');
    expect(flags[0]!.excerpt).toBe('d1');
  });

  it('warns when two agreements share a signing date, ignoring forms and other claims', () => {
    const docs: GeneratedDocument[] = [
      fixtureDocument('d1', 'agreement.credit_hire', { createdAt: '2026-09-21T10:00:00Z', signature: sig('2026-09-21T10:30:00Z') }),
      fixtureDocument('d2', 'agreement.storage', { title: 'Storage agreement', createdAt: '2026-09-21T10:00:00Z', signature: sig('2026-09-21T16:45:00Z') }),
      fixtureDocument('d3', 'form.statement_of_need', { createdAt: '2026-09-21T10:00:00Z', signature: sig('2026-09-21T10:35:00Z') }), // a form, not an agreement
      fixtureDocument('d4', 'agreement.credit_hire', { claimId: 'claim-2', createdAt: '2026-09-21T10:00:00Z', signature: sig('2026-09-21T10:30:00Z') }), // other claim
      fixtureDocument('d5', 'agreement.credit_hire', { status: 'superseded', createdAt: '2026-09-21T10:00:00Z', signature: sig('2026-09-21T10:30:00Z') }) // superseded
    ];
    const flags = signatureDateChecks(docs, 'claim-1');
    expect(flags).toHaveLength(1);
    expect(flags[0]!.code).toBe('DUPLICATE_SIGNATURE_DATE');
    expect(flags[0]!.severity).toBe('warn');
    expect(flags[0]!.message).toContain('2 agreements on this file are signed on 21 September 2026');
    expect(flags[0]!.excerpt).toBe('d1,d2');
    // different dates → nothing
    docs[1] = { ...docs[1]!, signature: sig('2026-09-22T09:00:00Z') };
    expect(signatureDateChecks(docs, 'claim-1')).toEqual([]);
  });

  it('writes the re-execution line', () => {
    const previous = fixtureDocument('d0', 'agreement.credit_hire', { templateVersion: '1.2.0' });
    expect(reExecutionLine(previous, '2026-10-04')).toBe('re-executed on 4 October 2026, supersedes version 1.2.0');
    expect(reExecutionLine(previous, '2026-10-04T15:00:00Z', '2')).toBe('re-executed on 4 October 2026, supersedes version 2');
  });

  it('formats dates', () => {
    expect(formatLongDate('2026-10-04')).toBe('4 October 2026');
    expect(formatLongDate('2026-01-31T23:59:00Z')).toBe('31 January 2026');
    expect(formatLongDateTime('2026-10-04T09:05:00Z')).toBe('4 October 2026 10:05 BST (09:05 UTC)');
    expect(formatLongDateTime('2026-01-15T09:05:00Z')).toBe('15 January 2026 09:05 GMT (09:05 UTC)');
    // BST ends 01:00 UTC on Sunday 25 October 2026 (last Sunday of October)
    expect(formatLongDateTime('2026-10-25T00:30:00Z')).toBe('25 October 2026 01:30 BST (00:30 UTC)');
    expect(formatLongDateTime('2026-10-25T01:30:00Z')).toBe('25 October 2026 01:30 GMT (01:30 UTC)');
    expect(formatLongDateTime('2026-10-24T23:30:00+01:00')).toBe('24 October 2026 23:30 BST (22:30 UTC)');
    expect(formatLongDate('garbage')).toBe('garbage');
  });
});

describe('adversarial: BST and the London calendar date', () => {
  const sig = (signedAt: string): SignatureRecord => ({
    signerPartyId: 'p-claimant',
    signerName: 'Amir Hussain',
    signerContact: 'amir@example.com',
    otpChannel: 'email',
    otpVerifiedAt: signedAt,
    ipAddress: '203.0.113.9',
    userAgent: 'UA',
    signedAt,
    documentSha256: 'b'.repeat(64),
    certificateId: 'CERT-X'
  });

  it('two agreements signed on 1 July 2026 London time are a duplicate even though their UTC dates differ', () => {
    // 2026-06-30T23:30:00Z is 00:30 BST on 1 July 2026; a UTC-date comparison would have missed this pair
    const docs: GeneratedDocument[] = [
      fixtureDocument('d1', 'agreement.credit_hire', { createdAt: '2026-06-30T20:00:00Z', signature: sig('2026-06-30T23:30:00Z') }),
      fixtureDocument('d2', 'agreement.storage', { title: 'Storage agreement', createdAt: '2026-06-30T20:00:00Z', signature: sig('2026-07-01T08:00:00Z') })
    ];
    const flags = signatureDateChecks(docs, 'claim-1');
    expect(flags.map((f) => f.code)).toEqual(['DUPLICATE_SIGNATURE_DATE']);
    expect(flags[0]!.draftValue).toBe('2026-07-01');
    expect(flags[0]!.message).toContain('signed on 1 July 2026');
  });

  it('a signature 30 minutes after creation across UTC midnight is not "before creation"', () => {
    const docs: GeneratedDocument[] = [fixtureDocument('d1', 'agreement.credit_hire', { createdAt: '2026-06-30T23:00:00Z', signature: sig('2026-06-30T23:30:00Z') })];
    expect(signatureDateChecks(docs, 'claim-1')).toEqual([]);
  });

  it('re-execution line uses the London date of an instant', () => {
    const previous = fixtureDocument('d0', 'agreement.credit_hire', { templateVersion: '1.2.0' });
    // 23:30 UTC on 30 June = 00:30 BST on 1 July
    expect(reExecutionLine(previous, '2026-06-30T23:30:00Z')).toBe('re-executed on 1 July 2026, supersedes version 1.2.0');
  });

  it('OTP expiry is an absolute instant: an offset-bearing issuedAt verifies against a Z now', () => {
    const otp = generateOtp({ ...base, issuedAt: '2026-10-04T11:00:00+01:00' }); // 10:00Z
    expect(otp.expiresAt).toBe('2026-10-04T10:10:00.000Z');
    expect(verifyOtp({ ...base, issuedAt: '2026-10-04T11:00:00+01:00', token: otp.token, code: otp.code, now: '2026-10-04T10:09:59Z' }).ok).toBe(true);
    expect(verifyOtp({ ...base, issuedAt: '2026-10-04T11:00:00+01:00', token: otp.token, code: otp.code, now: '2026-10-04T10:10:01Z' }).reason).toBe('expired');
  });
});
