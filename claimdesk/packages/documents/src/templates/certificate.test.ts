import { describe, expect, it } from 'vitest';
import { brand } from '../brand.js';
import { findProhibitedContent, htmlToText } from '../guards.js';
import { DocumentDataError, hasTemplate, listTemplates, missingRequiredData, renderTemplate } from '../registry.js';
import { CertificateDateError, certificateTemplates, signatureCertificateTemplate } from './certificate.js';

describe('certificate.signature', () => {
  const sample = signatureCertificateTemplate.sample();
  const rendered = renderTemplate('certificate.signature', sample);
  const text = htmlToText(rendered.html);

  it('is registered at 1.0.0 with kind certificate and renders cleanly', () => {
    expect(certificateTemplates.map((t) => t.id)).toEqual(['certificate.signature']);
    expect(hasTemplate('certificate.signature')).toBe(true);
    expect(listTemplates().find((m) => m.id === 'certificate.signature')).toMatchObject({ kind: 'certificate', version: '1.0.0' });
    expect(missingRequiredData(signatureCertificateTemplate, sample)).toEqual([]);
    expect(renderTemplate('certificate.signature', signatureCertificateTemplate.sample()).html).toBe(rendered.html);
    expect(rendered.title).toBe('Signature completion certificate CERT-3F9A1C2B7D4E6F80');
    expect(rendered.html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(rendered.html).toContain('class="logo-lockup"');
    expect(rendered.html).toContain(brand.company.statusLine);
    expect(rendered.html).toContain('company number 17430389');
    expect(findProhibitedContent(rendered.html)).toEqual([]);
    for (const needle of ['Invalid Date', 'NaN', 'undefined', 'our solicitors', 'legal advice']) expect(text).not.toContain(needle);
  });

  it('prints the document, template id and version, hash, signer, contact, OTP channel and time, IP, user agent, signed time and certificate id', () => {
    expect(text).toContain('Certificate CERT-3F9A1C2B7D4E6F80');
    expect(text).toContain('Document Credit Hire Agreement CHA-2026-00012');
    expect(text).toContain('Document id doc_01J8EXAMPLE0000000000000001');
    expect(text).toContain('Template agreement.credit_hire version 1.1.0');
    expect(text).toContain('SHA-256 of the signed document a3f1c9e2b7d04c6e8f21a5b9c3d7e1f0a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d1');
    expect(text).toContain('Claim reference CCG-2026-00012');
    expect(text).toContain('Signer Ms Jane Example');
    expect(text).toContain('Contact used for verification jane.example@example.test');
    expect(text).toContain('One-time passcode sent by Email');
    expect(text).toContain('Passcode verified 10 August 2026, 09:40');
    expect(text).toContain('Signed 10 August 2026, 09:41');
    expect(text).toContain('IP address 203.0.113.42');
    expect(text).toContain('Device (user agent) Mozilla/5.0 (iPhone');
    expect(text).toContain('Hash of the document at signing a3f1c9e2b7d04c6e8f21a5b9c3d7e1f0a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d1');
  });

  it('notes that the document was generated from ledger data at its creation timestamp and that the hash matches', () => {
    expect(text).toContain('Generated from ledger data 10 August 2026, 09:05');
    expect(text).toContain('The document was generated from ledger data at 10 August 2026, 09:05 and has not been altered since');
    expect(text).toContain('Document hash at signing matches the document hash.');
    expect(text).toContain('Signature time is after document creation');
    expect(text).toContain('it is not itself signed');
  });

  it('says SMS when the passcode went by text, and flags a hash mismatch as stated by the esign module', () => {
    const data = { ...sample, signer: { ...sample.signer, otpChannel: 'sms' as const, contact: '07700 900123' }, integrity: { hashMatchesDocument: false, signedAfterCreation: true } };
    const t = htmlToText(renderTemplate('certificate.signature', data).html);
    expect(t).toContain('One-time passcode sent by SMS');
    expect(t).toContain('Contact used for verification 07700 900123');
    expect(t).toContain('DOES NOT MATCH');
  });

  it('refuses a signature dated before the document was created, whether by the timestamps or by the esign integrity flag', () => {
    expect(() => renderTemplate('certificate.signature', { ...sample, signer: { ...sample.signer, signedAt: '2026-08-10T09:04:00+01:00' } })).toThrow(CertificateDateError);
    expect(() => renderTemplate('certificate.signature', { ...sample, integrity: { hashMatchesDocument: true, signedAfterCreation: false } })).toThrow(CertificateDateError);
  });

  it('refuses a passcode verified after the signature, or before the document existed', () => {
    expect(() => renderTemplate('certificate.signature', { ...sample, signer: { ...sample.signer, otpVerifiedAt: '2026-08-10T09:41:01+01:00' } })).toThrow(CertificateDateError);
    expect(() => renderTemplate('certificate.signature', { ...sample, signer: { ...sample.signer, otpVerifiedAt: '2026-08-10T09:41:01+01:00' } })).toThrow(/after the document was signed/);
    expect(() => renderTemplate('certificate.signature', { ...sample, signer: { ...sample.signer, otpVerifiedAt: '2026-08-10T09:04:59+01:00' } })).toThrow(/before the document was generated/);
    expect(() => renderTemplate('certificate.signature', { ...sample, signer: { ...sample.signer, otpVerifiedAt: sample.signer.signedAt } })).not.toThrow(); // same instant is fine
    expect(() => renderTemplate('certificate.signature', { ...sample, signer: { ...sample.signer, otpVerifiedAt: 'yesterday' } })).toThrow(TypeError);
  });

  it('falls back to the certificate id as the reference when there is no claim', () => {
    const { claim: _claim, ...noClaim } = sample;
    const html = renderTemplate('certificate.signature', noClaim).html;
    expect(html).toContain('Our ref</th><td>CERT-3F9A1C2B7D4E6F80');
    expect(htmlToText(html)).not.toContain('Claim reference');
  });

  it('refuses to render without the signature record fields', () => {
    let err: unknown;
    try {
      renderTemplate('certificate.signature', { ...sample, signer: { ...sample.signer, ipAddress: '', userAgent: undefined as never } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DocumentDataError);
    expect((err as DocumentDataError).missing).toEqual(['signer.ipAddress', 'signer.userAgent']);
  });
});
