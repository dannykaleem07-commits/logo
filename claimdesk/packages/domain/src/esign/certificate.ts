/**
 * Completion certificate payload (BLUEPRINT §3.8): signer identity, contact, channel, OTP verified time,
 * IP, user agent, signed time, document hash, template id/version.
 */
import { createHash } from 'node:crypto';
import type { GeneratedDocument, ISODateTime, SignatureRecord } from '../types.js';
import { formatLongDate, formatLongDateTime } from './dates.js';

export interface BuildCertificateInput {
  document: Pick<GeneratedDocument, 'id' | 'templateId' | 'templateVersion' | 'title' | 'sha256' | 'createdAt'> & Partial<Pick<GeneratedDocument, 'claimId' | 'supersedesId' | 'reExecutedOn'>>;
  signature: Omit<SignatureRecord, 'certificateId' | 'certificatePdfPath'> & Partial<Pick<SignatureRecord, 'certificateId'>>;
  otpToken: string;
  generatedAt: ISODateTime;
  /** Shown on the certificate; defaults to the registered name. */
  issuer?: string;
}

export interface CertificateJson {
  certificateId: string;
  issuer: string;
  generatedAt: ISODateTime;
  document: {
    id: string;
    claimId?: string;
    title: string;
    templateId: string;
    templateVersion: string;
    sha256: string;
    createdAt: ISODateTime;
    supersedesId?: string;
    reExecutedOn?: string;
  };
  signer: {
    partyId: string;
    name: string;
    contact: string;
    otpChannel: 'email' | 'sms';
    otpVerifiedAt: ISODateTime;
    otpTokenSha256: string; // the token itself is never printed
    ipAddress: string;
    userAgent: string;
    signedAt: ISODateTime;
    documentSha256AtSigning: string;
  };
  integrity: {
    hashMatchesDocument: boolean;
    signedAfterCreation: boolean;
  };
}

export interface Certificate {
  certificateId: string;
  lines: string[];
  json: CertificateJson;
}

export const DEFAULT_ISSUER = 'Courtesy Cars Group UK Ltd';

export function certificateIdFor(documentId: string, documentSha256: string, signedAt: ISODateTime, otpToken: string): string {
  const digest = createHash('sha256').update(`${documentId}|${documentSha256.toLowerCase()}|${signedAt}|${otpToken}`).digest('hex');
  return `CERT-${digest.slice(0, 16).toUpperCase()}`;
}

export function buildCertificate(input: BuildCertificateInput): Certificate {
  const { document, signature, otpToken, generatedAt } = input;
  const issuer = input.issuer ?? DEFAULT_ISSUER;
  const certificateId = signature.certificateId ?? certificateIdFor(document.id, document.sha256, signature.signedAt, otpToken);
  const hashMatchesDocument = signature.documentSha256.toLowerCase() === document.sha256.toLowerCase();
  const signedAfterCreation = Date.parse(signature.signedAt) >= Date.parse(document.createdAt);

  const json: CertificateJson = {
    certificateId,
    issuer,
    generatedAt,
    document: {
      id: document.id,
      ...(document.claimId ? { claimId: document.claimId } : {}),
      title: document.title,
      templateId: document.templateId,
      templateVersion: document.templateVersion,
      sha256: document.sha256,
      createdAt: document.createdAt,
      ...(document.supersedesId ? { supersedesId: document.supersedesId } : {}),
      ...(document.reExecutedOn ? { reExecutedOn: document.reExecutedOn } : {})
    },
    signer: {
      partyId: signature.signerPartyId,
      name: signature.signerName,
      contact: signature.signerContact,
      otpChannel: signature.otpChannel,
      otpVerifiedAt: signature.otpVerifiedAt,
      otpTokenSha256: createHash('sha256').update(otpToken).digest('hex'),
      ipAddress: signature.ipAddress,
      userAgent: signature.userAgent,
      signedAt: signature.signedAt,
      documentSha256AtSigning: signature.documentSha256
    },
    integrity: { hashMatchesDocument, signedAfterCreation }
  };

  const lines = [
    `Signature completion certificate ${certificateId}`,
    `Issued by ${issuer} on ${formatLongDateTime(generatedAt)}`,
    `Document: ${document.title} (${document.templateId} v${document.templateVersion}, id ${document.id})`,
    `Document created: ${formatLongDateTime(document.createdAt)}`,
    `Document SHA-256: ${document.sha256}`,
    ...(document.supersedesId ? [`Supersedes document ${document.supersedesId}${document.reExecutedOn ? `; re-executed on ${formatLongDate(document.reExecutedOn)}` : ''}`] : []),
    `Signer: ${signature.signerName} (party ${signature.signerPartyId})`,
    `Identity verified by one-time passcode sent by ${signature.otpChannel === 'sms' ? 'SMS' : 'email'} to ${signature.signerContact}, verified ${formatLongDateTime(signature.otpVerifiedAt)}`,
    `Signed: ${formatLongDateTime(signature.signedAt)}`,
    `IP address: ${signature.ipAddress}`,
    `User agent: ${signature.userAgent}`,
    `Hash at signing: ${signature.documentSha256}${hashMatchesDocument ? ' (matches document)' : ' (DOES NOT MATCH DOCUMENT)'}`,
    `OTP token fingerprint: ${json.signer.otpTokenSha256.slice(0, 16)}`,
    signedAfterCreation ? 'Signature time is after document creation.' : 'WARNING: signature time precedes document creation.'
  ];

  return { certificateId, lines, json };
}
