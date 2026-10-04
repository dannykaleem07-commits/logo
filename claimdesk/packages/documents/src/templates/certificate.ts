/**
 * Certificates — certificate.signature.
 *
 * The e-signature completion certificate (BLUEPRINT §3.8): which document was signed (title, template id and version,
 * hash), who signed it (name, contact, OTP channel and verification time, IP address, user agent), when, and the
 * certificate id. It states that the document was generated from ledger data at its creation timestamp, and it
 * refuses to render a signature dated before that timestamp.
 *
 * The data is the esign module's `CertificateJson` reshaped for printing; the API builds it from the SignatureRecord
 * and the GeneratedDocument. The certificate may relate to a document without a claim (a fleet hire), so `claim` is
 * optional and the certificate id is the fallback reference.
 */
import type { ISODate, ISODateTime } from '@ccguk/domain';
import { brand } from '../brand.js';
import { type ClaimHeader, type CompanySettings, sampleClaim, sampleSettings } from '../common.js';
import { dateParts, escapeHtml, formatDateTime, toISODate } from '../format.js';
import { baseLayout, callout, keyValueTable } from '../layout.js';
import { type AnyTemplate, registerTemplate, type Template } from '../registry.js';

type DateLike = ISODate | ISODateTime;

/**
 * Thrown when the certificate's timestamps are out of order: a signature before the document existed, or a
 * passcode verified before the document existed or after the signature it is supposed to authorise.
 */
export class CertificateDateError extends Error {
  constructor(signedAt: string, createdAt: string, message?: string) {
    super(message ?? `certificate.signature: signedAt (${signedAt}) is earlier than the document creation timestamp (${createdAt}). A document cannot be signed before it exists.`);
    this.name = 'CertificateDateError';
  }
}

export interface SignatureCertificateData {
  settings: CompanySettings;
  /** Certificate date (when it was generated). */
  date: DateLike;
  claim?: ClaimHeader;
  certificateId: string;
  document: {
    id: string;
    title: string;
    templateId: string;
    templateVersion: string;
    /** SHA-256 of the signed PDF. */
    sha256: string;
    /** When the document was generated from ledger data. */
    createdAt: ISODateTime;
    supersedesId?: string;
    reExecutedOn?: ISODate;
  };
  signer: {
    name: string;
    /** Email address or mobile number the one-time passcode was sent to. */
    contact: string;
    otpChannel: 'email' | 'sms';
    otpVerifiedAt: ISODateTime;
    ipAddress: string;
    userAgent: string;
    signedAt: ISODateTime;
    /** Hash of the document at the moment of signing — must equal document.sha256. */
    documentSha256AtSigning: string;
  };
  /** Computed by the esign module; printed as stated. */
  integrity?: { hashMatchesDocument: boolean; signedAfterCreation: boolean };
}

export const signatureCertificateTemplate: Template<SignatureCertificateData> = {
  id: 'certificate.signature',
  version: '1.0.0',
  kind: 'certificate',
  title: 'Signature completion certificate',
  description: 'E-signature completion certificate: document title, template id and version, hash; signer name, contact, OTP channel and verification time, IP address, user agent, signed time; certificate id; creation timestamp of the document.',
  requiredData: [
    'settings.registeredOffice',
    'date',
    'certificateId',
    'document.id',
    'document.title',
    'document.templateId',
    'document.templateVersion',
    'document.sha256',
    'document.createdAt',
    'signer.name',
    'signer.contact',
    'signer.otpChannel',
    'signer.otpVerifiedAt',
    'signer.ipAddress',
    'signer.userAgent',
    'signer.signedAt',
    'signer.documentSha256AtSigning'
  ],
  titleFor: (d) => `Signature completion certificate ${d.certificateId}`,
  sample: () => ({
    settings: sampleSettings(),
    date: '2026-08-10T09:41:30+01:00',
    claim: sampleClaim(),
    certificateId: 'CERT-3F9A1C2B7D4E6F80',
    document: {
      id: 'doc_01J8EXAMPLE0000000000000001',
      title: 'Credit Hire Agreement CHA-2026-00012',
      templateId: 'agreement.credit_hire',
      templateVersion: '1.1.0',
      sha256: 'a3f1c9e2b7d04c6e8f21a5b9c3d7e1f0a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d1',
      createdAt: '2026-08-10T09:05:00+01:00'
    },
    signer: {
      name: 'Ms Jane Example',
      contact: 'jane.example@example.test',
      otpChannel: 'email',
      otpVerifiedAt: '2026-08-10T09:40:12+01:00',
      ipAddress: '203.0.113.42',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
      signedAt: '2026-08-10T09:41:00+01:00',
      documentSha256AtSigning: 'a3f1c9e2b7d04c6e8f21a5b9c3d7e1f0a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d1'
    },
    integrity: { hashMatchesDocument: true, signedAfterCreation: true }
  }),
  render: (d) => {
    const s = dateParts(d.signer.signedAt);
    const c = dateParts(d.document.createdAt);
    const before = s.hasTime && c.hasTime ? Date.parse(d.signer.signedAt) < Date.parse(d.document.createdAt) : toISODate(d.signer.signedAt) < toISODate(d.document.createdAt);
    if (before || d.integrity?.signedAfterCreation === false) throw new CertificateDateError(d.signer.signedAt, d.document.createdAt);
    const otpAt = Date.parse(d.signer.otpVerifiedAt);
    if (Number.isNaN(otpAt)) throw new TypeError(`certificate.signature: signer.otpVerifiedAt is not a valid ISO date-time: ${d.signer.otpVerifiedAt}`);
    if (otpAt > Date.parse(d.signer.signedAt)) {
      throw new CertificateDateError(
        d.signer.signedAt,
        d.signer.otpVerifiedAt,
        `certificate.signature: the one-time passcode was verified at ${d.signer.otpVerifiedAt}, after the document was signed at ${d.signer.signedAt}. The identity check must precede the signature.`
      );
    }
    if (otpAt < Date.parse(d.document.createdAt)) {
      throw new CertificateDateError(
        d.signer.otpVerifiedAt,
        d.document.createdAt,
        `certificate.signature: the one-time passcode was verified at ${d.signer.otpVerifiedAt}, before the document was generated at ${d.document.createdAt}. The passcode is issued only once the document hash is fixed.`
      );
    }

    const hashMatches = d.integrity?.hashMatchesDocument ?? d.signer.documentSha256AtSigning.toLowerCase() === d.document.sha256.toLowerCase();

    const documentRows = [
      { label: 'Document', value: d.document.title },
      { label: 'Document id', value: d.document.id },
      { label: 'Template', value: `${d.document.templateId} version ${d.document.templateVersion}` },
      { label: 'Generated from ledger data', value: formatDateTime(d.document.createdAt) },
      { label: 'SHA-256 of the signed document', value: d.document.sha256 }
    ];
    if (d.document.supersedesId) documentRows.push({ label: 'Supersedes document', value: d.document.supersedesId });
    if (d.document.reExecutedOn) documentRows.push({ label: 'Re-executed on', value: formatDateTime(d.document.reExecutedOn) });
    if (d.claim) documentRows.push({ label: 'Claim reference', value: d.claim.ourReference });

    const signerRows = [
      { label: 'Signer', value: d.signer.name },
      { label: 'Contact used for verification', value: d.signer.contact },
      { label: 'One-time passcode sent by', value: d.signer.otpChannel === 'sms' ? 'SMS' : 'Email' },
      { label: 'Passcode verified', value: formatDateTime(d.signer.otpVerifiedAt) },
      { label: 'Signed', value: formatDateTime(d.signer.signedAt) },
      { label: 'IP address', value: d.signer.ipAddress },
      { label: 'Device (user agent)', value: d.signer.userAgent },
      { label: 'Hash of the document at signing', value: d.signer.documentSha256AtSigning }
    ];

    const body = `
<p>This certificate records the electronic signature of the document below through the ClaimDesk signing flow operated by ${escapeHtml(
      brand.company.registeredName
    )}. The signer’s identity was verified by a one-time passcode sent to the contact shown; the document’s hash was fixed before the passcode was issued and is recorded again at the moment of signing.</p>
${keyValueTable(documentRows, 'Document')}
${keyValueTable(signerRows, 'Signature')}
${callout(
  `<p>Document hash at signing ${hashMatches ? 'matches' : 'DOES NOT MATCH'} the document hash. Signature time is after document creation (${escapeHtml(formatDateTime(d.document.createdAt))}). The document was generated from ledger data at ${escapeHtml(
    formatDateTime(d.document.createdAt)
  )} and has not been altered since: any change would change the SHA-256 printed above.</p>`,
  'Integrity'
)}
<p class="small muted">Certificate ${escapeHtml(d.certificateId)} generated ${escapeHtml(formatDateTime(d.date))}. The certificate is produced by the system from the signature record; it is not itself signed. Times are shown in Europe/London.</p>`;

    return baseLayout({
      title: 'Signature completion certificate',
      subtitle: d.certificateId,
      kind: 'certificate',
      reference: d.claim?.ourReference ?? d.certificateId,
      date: d.date,
      settings: d.settings,
      closing: '',
      meta: [{ label: 'Certificate', value: d.certificateId }],
      bodyHtml: body
    });
  }
};
registerTemplate(signatureCertificateTemplate);

/** Every template in this file, in registration order. */
export const certificateTemplates: ReadonlyArray<AnyTemplate> = [signatureCertificateTemplate];
