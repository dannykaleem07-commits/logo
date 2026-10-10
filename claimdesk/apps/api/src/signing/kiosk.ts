// owned by ap-paperwork
/**
 * In-person signing kiosk (docs/SUPREME-AUTOPILOT.md §E.2, §E.3, §I.6).
 *
 *   createKioskSession   POST /packs/:id/kiosk (human-only): a one-pack session — 32 random bytes as the token (only its
 *                        sha256 is stored), the TTL from Settings (30 minutes), bound to the pack, the signer and the
 *                        person who opened it. The page is /sign/kiosk/:token (or the LAN address when the tablet
 *                        listener is on).
 *   resolveKiosk         every /api/kiosk/:token/* call: unknown / expired / closed token → 401; pinned to the first
 *                        device that opens it (IP + user agent).
 *   startPackSignature   ONE code for the whole pack: the existing `generateOtp` with documentId = pack id and
 *                        documentSha256 = sha256(sorted member sha256s). Emailed to the signer when the mailbox is set
 *                        up (transactional, not the outbox), else shown to the Claims Team member (audited
 *                        `document.sign.code_shown_to_handler`). `assertHuman` on the session's creator.
 *   verifyPackSignature  the code (5 attempts), every document read, the pack unchanged, typed name, consent and a drawn
 *                        signature (PNG ≤ 200 KB, stored as `signature_image` evidence) → each document to sign gets its
 *                        own SignatureRecord and certificate; documents to keep count as handed over.
 *   closeKiosk           exit needs the creator's password.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Actor } from '@ccguk/db';
import { activePackItems, generateOtp, verifyOtp, type DocumentPack, type GeneratedDocument, type Id, type KioskSession, type Party } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { conflict, HttpError } from '../errors.js';
import { readDocumentPdfVerified, renderDocumentPdf, signingSecret } from '../services/documents.js';
import { storeEvidenceBuffer } from '../services/evidence.js';
import { assertHuman } from '../services/humanOnly.js';
import { verifyPassword } from '../services/auth.js';
import { mailAccount, fromHeader } from '../mail/common.js';
import { newMessageId, smtpFor } from '../mail/transport.js';
import { nudgeAutopilot } from '../autopilot/nudge.js';
import { audit, maskEmail, packSha256, packSigner, sha256Of, signingSettings } from './common.js';
import { signDocumentWithCertificate } from './certificate.js';
import { refreshPackFromDocuments } from './packs.js';
import { syncEnforceabilityFromPack } from './enforceability.js';
import { lanKioskBaseUrl } from './lanServer.js';
import { afterDocumentsSigned } from './wet.js';

export const KIOSK_MAX_ATTEMPTS = 5;
export const KIOSK_PNG_MAX_BYTES = 200 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface KioskChallenge {
  token: string;
  nonce: string;
  issuedAt: string;
  contact: string;
  packSha256: string;
  method: 'kiosk_otp_email' | 'kiosk_handler_code';
  attempts: number;
}

/** Per-session state that does not need to survive a restart (a restart means opening the kiosk again). */
const reads = new Map<Id, Set<Id>>();
const challenges = new Map<Id, KioskChallenge>();

/** Test hook. */
export function kioskChallengeFor(sessionId: Id): Readonly<KioskChallenge> | undefined {
  return challenges.get(sessionId);
}

function kioskError(code: string, message: string): HttpError {
  return new HttpError(401, code, message);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface KioskCreated {
  sessionId: Id;
  token: string;
  path: string;
  lanUrl?: string;
  expiresAt: string;
  signer: { partyId: Id; name: string };
}

function kioskDocuments(ctx: AppContext, pack: DocumentPack): Array<{ item: DocumentPack['items'][number]; document: GeneratedDocument }> {
  return activePackItems(pack.items)
    .filter((i) => (i.purpose === 'sign' || i.purpose === 'give') && i.documentId)
    .map((i) => ({ item: i, document: ctx.repos.requireDocument(ctx.db, i.documentId!, { includeHtml: false }) }));
}

export function createKioskSession(ctx: AppContext, packId: Id, actor: Actor): KioskCreated {
  assertHuman(actor, 'open the signing kiosk');
  const pack = ctx.repos.requireDocumentPack(ctx.db, packId);
  if (!['approved', 'sent', 'signed'].includes(pack.status)) throw conflict('PACK_STATE', `Approve the pack before signing it (status is ${pack.status})`);
  const docs = kioskDocuments(ctx, pack);
  if (!docs.some((d) => d.item.purpose === 'sign' && d.document.status !== 'signed')) throw conflict('NOTHING_TO_SIGN', 'Every document in this pack is already signed');
  const unapproved = docs.filter((d) => d.document.status !== 'approved' && d.document.status !== 'sent' && d.document.status !== 'signed');
  if (unapproved.length) throw conflict('DOCUMENT_STATE', `Approve these documents first: ${unapproved.map((d) => d.document.title).join(', ')}`);
  const signer = packSigner(ctx, pack);
  const settings = signingSettings(ctx);
  const token = randomBytes(32).toString('base64url');
  const now = ctx.now();
  const expiresAt = new Date(Date.parse(now) + settings.kioskTtlMinutes * 60_000).toISOString();
  const lanBase = lanKioskBaseUrl();
  const session = ctx.repos.createKioskSession(ctx.db, { packId: pack.id, claimId: pack.claimId, signerPartyId: signer.id, tokenSha256: sha256Of(token), lan: Boolean(lanBase), createdBy: actor.userId, createdAt: now, expiresAt });
  audit(ctx, actor, 'kiosk.create', 'kiosk_sessions', session.id, { packId: pack.id, claimId: pack.claimId, signerPartyId: signer.id, expiresAt, lan: Boolean(lanBase) });
  const path = `/sign/kiosk/${token}`;
  return { sessionId: session.id, token, path, ...(lanBase ? { lanUrl: `${lanBase}${path}` } : {}), expiresAt, signer: { partyId: signer.id, name: signer.name } };
}

// ---------------------------------------------------------------------------
// Resolve (token auth)
// ---------------------------------------------------------------------------

export interface KioskRequestInfo {
  ip: string;
  userAgent: string;
}

export function resolveKiosk(ctx: AppContext, token: string, req: KioskRequestInfo, opts: { allowCompleted?: boolean } = {}): { session: KioskSession; pack: DocumentPack; signer: Party; creator: Actor } {
  if (!token || token.length < 20 || token.length > 128) throw kioskError('KIOSK_TOKEN', 'This signing link is not valid');
  let session = ctx.repos.getKioskSessionByTokenSha256(ctx.db, sha256Of(token));
  if (!session) throw kioskError('KIOSK_TOKEN', 'This signing link is not valid');
  if (session.closedReason) throw kioskError('KIOSK_CLOSED', 'This signing session has ended. Please hand the device back to the Claims Team.');
  if (Date.parse(ctx.now()) > Date.parse(session.expiresAt)) throw kioskError('KIOSK_EXPIRED', 'This signing session has expired. Please ask the Claims Team to start again.');
  if (session.completedAt && !opts.allowCompleted) throw new HttpError(409, 'KIOSK_DONE', 'These documents are already signed. Please hand the device back to the Claims Team.');
  if (!session.openedAt) {
    session = ctx.repos.updateKioskSession(ctx.db, session.id, { openedAt: ctx.now(), openedIp: req.ip, openedUserAgent: req.userAgent.slice(0, 500) });
    audit(ctx, { userId: session.createdBy, ip: req.ip }, 'kiosk.open', 'kiosk_sessions', session.id, { packId: session.packId, ip: req.ip, userAgent: req.userAgent.slice(0, 200) });
  } else if (session.openedIp !== req.ip || session.openedUserAgent !== req.userAgent.slice(0, 500)) {
    throw kioskError('KIOSK_DEVICE', 'This signing link is already open on another device');
  }
  const pack = ctx.repos.requireDocumentPack(ctx.db, session.packId);
  const signer = ctx.repos.requireParty(ctx.db, session.signerPartyId);
  return { session, pack, signer, creator: { userId: session.createdBy, ip: req.ip } };
}

export interface KioskSummary {
  sessionId: Id;
  packLabel: string;
  signer: { name: string };
  documents: Array<{ id: Id; title: string; purpose: 'sign' | 'give'; read: boolean; signed: boolean }>;
  otp: { delivery: 'email' | 'handler'; contactMasked?: string };
  expiresAt: string;
  completed: boolean;
}

function otpDeliveryFor(ctx: AppContext, signer: Party): 'email' | 'handler' {
  const account = mailAccount(ctx);
  return signingSettings(ctx).otpDelivery === 'email' && account?.enabled && signer.email ? 'email' : 'handler';
}

const LABELS: Record<string, string> = { signup: 'Sign-up documents', hire_offer: 'Hire documents', hire_start: 'Hire agreement and handover documents', off_hire: 'Vehicle return documents', billing: 'Claim documents', payment: 'Claim documents', closure: 'Closing documents' };

export function kioskSummary(ctx: AppContext, token: string, req: KioskRequestInfo): KioskSummary {
  const { session, pack, signer } = resolveKiosk(ctx, token, req, { allowCompleted: true });
  const read = reads.get(session.id) ?? new Set<Id>();
  return {
    sessionId: session.id,
    packLabel: LABELS[pack.stage] ?? 'Documents',
    signer: { name: signer.name },
    documents: kioskDocuments(ctx, pack).map((d) => ({ id: d.document.id, title: d.document.title, purpose: d.item.purpose === 'sign' ? 'sign' : 'give', read: read.has(d.document.id), signed: d.document.status === 'signed' })),
    otp: { delivery: otpDeliveryFor(ctx, signer), ...(signer.email ? { contactMasked: maskEmail(signer.email) } : {}) },
    expiresAt: session.expiresAt,
    completed: Boolean(session.completedAt),
  };
}

export async function kioskDocumentPdf(ctx: AppContext, token: string, documentId: Id, req: KioskRequestInfo): Promise<Buffer> {
  const { pack } = resolveKiosk(ctx, token, req, { allowCompleted: true });
  const member = kioskDocuments(ctx, pack).find((d) => d.document.id === documentId);
  if (!member) throw new HttpError(404, 'NOT_FOUND', 'That document is not part of this signing session');
  const stored = readDocumentPdfVerified(ctx, member.document);
  if (stored) {
    if (!stored.intact) throw conflict('DOCUMENT_PDF_TAMPERED', 'The stored PDF does not match its approved hash; the Claims Team must re-issue it');
    return stored.pdf;
  }
  const full = ctx.repos.requireDocument(ctx.db, documentId, { includeHtml: true });
  return (await renderDocumentPdf(ctx, full)).pdf;
}

export function kioskMarkRead(ctx: AppContext, token: string, documentId: Id, req: KioskRequestInfo): { read: Id[] } {
  const { session, pack, creator } = resolveKiosk(ctx, token, req);
  if (!kioskDocuments(ctx, pack).some((d) => d.document.id === documentId)) throw new HttpError(404, 'NOT_FOUND', 'That document is not part of this signing session');
  const set = reads.get(session.id) ?? new Set<Id>();
  set.add(documentId);
  reads.set(session.id, set);
  audit(ctx, creator, 'kiosk.read', 'kiosk_sessions', session.id, { documentId });
  return { read: [...set] };
}

// ---------------------------------------------------------------------------
// One code for the pack
// ---------------------------------------------------------------------------

export interface KioskOtpStarted {
  channel: 'email' | 'handler';
  contactMasked?: string;
  expiresAt: string;
  /** Shown to the Claims Team member when no mailbox is set up (audited). */
  handlerCode?: string;
  /** Development and tests only. */
  devCode?: string;
}

export async function startPackSignature(ctx: AppContext, token: string, req: KioskRequestInfo): Promise<KioskOtpStarted> {
  const { session, pack, signer, creator } = resolveKiosk(ctx, token, req);
  assertHuman(creator, 'start a signature');
  const claim = ctx.repos.requireClaim(ctx.db, pack.claimId);
  const now = ctx.now();
  const nonce = randomUUID();
  const contact = signer.email ?? `party:${signer.id}`;
  const sha = packSha256(ctx, pack);
  let channel = otpDeliveryFor(ctx, signer);
  const otp = generateOtp({ secret: signingSecret(ctx), documentId: pack.id, documentSha256: sha, contact, channel: 'email', issuedAt: now, nonce });
  if (channel === 'email') {
    const account = mailAccount(ctx)!;
    try {
      const smtp = await smtpFor(ctx, account);
      await smtp.send({
        from: fromHeader(account),
        to: [signer.email!],
        cc: [],
        bcc: [],
        subject: `Your signing code [${claim.reference}]`,
        text: [`Dear ${signer.name},`, '', `Your one-time code to sign your documents with Courtesy Cars Group UK Ltd is: ${otp.code}`, '', 'Enter it on the signing screen. It expires in 10 minutes. If you did not ask for this code, tell the Claims Team.', '', 'Claims Team, Courtesy Cars Group UK Ltd'].join('\n'),
        messageId: newMessageId(account.fromAddress),
        attachments: [],
      });
      audit(ctx, creator, 'document.sign.otp_sent', 'document_packs', pack.id, { sessionId: session.id, channel: 'email', contact: maskEmail(contact), expiresAt: otp.expiresAt, tokenSha256: sha256Of(otp.token) });
    } catch (err) {
      audit(ctx, creator, 'document.sign.otp_failed', 'document_packs', pack.id, { sessionId: session.id, error: String(err).slice(0, 300) });
      channel = 'handler';
    }
  }
  if (channel === 'handler') audit(ctx, creator, 'document.sign.code_shown_to_handler', 'document_packs', pack.id, { sessionId: session.id, signerPartyId: signer.id, tokenSha256: sha256Of(otp.token) });
  challenges.set(session.id, { token: otp.token, nonce, issuedAt: now, contact, packSha256: sha, method: channel === 'email' ? 'kiosk_otp_email' : 'kiosk_handler_code', attempts: 0 });
  return {
    channel,
    ...(channel === 'email' && signer.email ? { contactMasked: maskEmail(signer.email) } : {}),
    expiresAt: otp.expiresAt,
    ...(channel === 'handler' ? { handlerCode: otp.code } : {}),
    ...(ctx.config.env !== 'production' ? { devCode: otp.code } : {}),
  };
}

export interface KioskSignInput {
  typedName: string;
  drawnSignaturePngBase64: string;
  code: string;
  consent: boolean;
}

export interface KioskSignResult {
  signed: Array<{ documentId: Id; certificateId: string }>;
  given: Id[];
  completedAt: string;
}

export async function verifyPackSignature(ctx: AppContext, token: string, input: KioskSignInput, req: KioskRequestInfo): Promise<KioskSignResult> {
  const { session, pack, signer, creator } = resolveKiosk(ctx, token, req);
  assertHuman(creator, 'complete a signature');
  if (!input.consent) throw new HttpError(400, 'CONSENT_REQUIRED', 'Please confirm that you agree to sign electronically');
  const typedName = input.typedName.trim();
  if (typedName.length < 2) throw new HttpError(400, 'NAME_REQUIRED', 'Please type your full name');
  const challenge = challenges.get(session.id);
  if (!challenge) throw new HttpError(400, 'OTP_NO_CHALLENGE', 'Ask for a code first');
  if (challenge.attempts >= KIOSK_MAX_ATTEMPTS) {
    challenges.delete(session.id);
    throw new HttpError(400, 'OTP_LOCKED', 'Too many attempts — ask for a new code');
  }
  challenge.attempts += 1;
  const now = ctx.now();
  const result = verifyOtp({ secret: signingSecret(ctx), token: challenge.token, documentId: pack.id, documentSha256: challenge.packSha256, contact: challenge.contact, issuedAt: challenge.issuedAt, code: input.code, now, nonce: challenge.nonce });
  if (!result.ok) {
    audit(ctx, creator, 'document.sign.fail', 'document_packs', pack.id, { sessionId: session.id, reason: result.reason, attempts: challenge.attempts });
    throw new HttpError(400, 'OTP_INVALID', result.reason === 'expired' ? 'The code has expired — ask for a new one' : 'That code is not right — please check it and try again', { reason: result.reason });
  }
  const docs = kioskDocuments(ctx, pack);
  const read = reads.get(session.id) ?? new Set<Id>();
  const unread = docs.filter((d) => !read.has(d.document.id));
  if (unread.length) throw conflict('KIOSK_NOT_READ', `Please read every document first: ${unread.map((d) => d.document.title).join(', ')}`);
  if (packSha256(ctx, pack) !== challenge.packSha256) {
    challenges.delete(session.id);
    throw conflict('DOCUMENT_CHANGED', 'A document changed after the code was issued — ask the Claims Team to start again');
  }
  const png = Buffer.from(input.drawnSignaturePngBase64.replace(/^data:image\/png;base64,/, ''), 'base64');
  if (png.length === 0 || png.length > KIOSK_PNG_MAX_BYTES || !png.subarray(0, 8).equals(PNG_MAGIC)) throw new HttpError(400, 'SIGNATURE_IMAGE', 'Please draw your signature again');
  const drawnSha = sha256Of(png);
  const evidence = (await storeEvidenceBuffer(ctx, png, { claimId: pack.claimId, filename: `signature-${pack.id}.png`, mime: 'image/png', fields: { kind: 'signature_image', description: `Signature drawn at the kiosk by ${typedName} (pack ${pack.id})` } as never, actor: creator })).evidence;
  const signed: KioskSignResult['signed'] = [];
  const given: Id[] = [];
  for (const d of docs) {
    if (d.item.purpose !== 'sign') {
      given.push(d.document.id);
      continue;
    }
    if (d.document.status === 'signed') continue;
    const r = await signDocumentWithCertificate(ctx, {
      document: ctx.repos.requireDocument(ctx.db, d.document.id, { includeHtml: false }),
      signature: {
        signerPartyId: signer.id,
        signerName: typedName,
        signerContact: signer.email ?? 'in person at the office',
        otpChannel: challenge.method === 'kiosk_otp_email' ? 'email' : 'none',
        otpVerifiedAt: now,
        ipAddress: req.ip,
        userAgent: req.userAgent.slice(0, 500),
        signedAt: now,
        documentSha256: d.document.sha256,
        method: challenge.method,
        drawnSignatureSha256: drawnSha,
        evidenceId: evidence.id,
        packId: pack.id,
        packSha256: challenge.packSha256,
      },
      proofToken: challenge.token,
      actor: creator,
    });
    signed.push({ documentId: d.document.id, certificateId: r.certificateId });
  }
  challenges.delete(session.id);
  reads.delete(session.id);
  ctx.repos.updateKioskSession(ctx.db, session.id, { completedAt: now });
  // Documents to keep were handed over in the kiosk (read on screen); the pack records them as given.
  const items = pack.items.map((i) => (i.documentId && given.includes(i.documentId) && i.status !== 'signed' ? { ...i, status: 'sent' as const } : i));
  ctx.repos.updateDocumentPack(ctx.db, pack.id, { items }, now);
  refreshPackFromDocuments(ctx, pack.id);
  audit(ctx, creator, 'kiosk.sign', 'kiosk_sessions', session.id, { packId: pack.id, signed: signed.map((s) => s.documentId), given, method: challenge.method, evidenceId: evidence.id, drawnSignatureSha256: drawnSha });
  afterDocumentsSigned(ctx, pack.claimId, signed.map((s) => s.documentId), creator, { method: challenge.method, packId: pack.id, given });
  if (pack.reservationId) syncEnforceabilityFromPack(ctx, ctx.db, { reservationId: pack.reservationId });
  nudgeAutopilot(ctx, pack.claimId, 'documents signed at the kiosk');
  return { signed, given, completedAt: now };
}

export async function closeKiosk(ctx: AppContext, token: string, password: string, req: KioskRequestInfo): Promise<{ closed: true }> {
  const { session } = resolveKiosk(ctx, token, req, { allowCompleted: true });
  const hash = ctx.repos.getPasswordHash(ctx.db, session.createdBy);
  const ok = hash ? await verifyPassword(password, hash) : false;
  if (!ok) {
    audit(ctx, { userId: session.createdBy, ip: req.ip }, 'kiosk.close_refused', 'kiosk_sessions', session.id, { reason: 'wrong password' });
    throw new HttpError(401, 'KIOSK_PASSWORD', 'That password is not right');
  }
  ctx.repos.updateKioskSession(ctx.db, session.id, { closedReason: session.completedAt ? 'completed' : 'closed_by_handler' });
  challenges.delete(session.id);
  reads.delete(session.id);
  audit(ctx, { userId: session.createdBy, ip: req.ip }, 'kiosk.close', 'kiosk_sessions', session.id, { packId: session.packId, completed: Boolean(session.completedAt) });
  return { closed: true };
}
