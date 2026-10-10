// owned by ap-paperwork
/**
 * Wet / scanned signatures and the follow-up around every signature (docs/SUPREME-AUTOPILOT.md §D.7, §E.4, §E.5).
 *
 *   markDocumentSigned   POST /documents/:id/mark-signed (human-only): a person confirms a returned scan or paper copy →
 *                        SignatureRecord (method wet_ink | scan, otpChannel 'none', the evidence id) with its
 *                        certificate; the signature requests close; packs and enforceability follow.
 *   runSigningChase      `signing.chase` (09:15 weekdays): one `chaser` email per pack and claim after 2 and 5 days (the
 *                        `letter.signature_chase` wording, drafted as agent:autopilot through the normal reviewer and
 *                        autonomy path), then after 7 days Needs-you `question` "call the client" and a `call` task.
 *   runMatchReturns      `signing.match_return` (every 15 min): new evidence on claims with open requests is matched by
 *                        document type (intake `signed_ccguk_form` / evidence kind `signed_document`), the document title
 *                        and the signer's name in its text → Needs-you `confirm_signed`. Agents never mark anything signed.
 *   afterDocumentsSigned events `documents_signed` and — when CCGUK-01 is signed first — `services_agreed` (§D.7: the
 *                        GTA 4.1 clock starts from a recorded event).
 */
import type { Actor } from '@ccguk/db';
import { chaseAction, nextChaseAt, type Evidence, type GeneratedDocument, type Id, type SignatureRequest } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { badRequest, conflict, HttpError } from '../errors.js';
import { createNeedsYou } from '../agent/core.js';
import { actAsAutopilot } from '../autopilot/act.js';
import { nudgeAutopilot } from '../autopilot/nudge.js';
import { assertHuman } from '../services/humanOnly.js';
import { appendPaperworkEvent, audit, AUTOPILOT_USER_ID, salutationOf, signingSettings } from './common.js';
import { signDocumentWithCertificate } from './certificate.js';
import { refreshPackFromDocuments } from './packs.js';
import { syncEnforceabilityFromPack } from './enforceability.js';

const OPEN_REQUEST: SignatureRequest['status'][] = ['prepared', 'sent', 'chased', 'returned'];

// ---------------------------------------------------------------------------
// After a signature (kiosk or wet ink)
// ---------------------------------------------------------------------------

export function afterDocumentsSigned(ctx: AppContext, claimId: Id, documentIds: Id[], actor: Actor, meta: { method: string; packId?: Id; given?: Id[] }): void {
  if (!documentIds.length) return;
  const docs = documentIds.map((id) => ctx.repos.getDocument(ctx.db, id, { includeHtml: false })).filter((d): d is GeneratedDocument => Boolean(d));
  appendPaperworkEvent(ctx, claimId, 'documents_signed', `Signed (${meta.method.replace(/_/g, ' ')}): ${docs.map((d) => d.title).join(', ')}`, { documentIds, method: meta.method, ...(meta.packId ? { packId: meta.packId } : {}), ...(meta.given?.length ? { given: meta.given } : {}) }, actor);
  const loa = docs.find((d) => d.templateId === 'agreement.ccguk_01_customer_loa');
  if (loa) {
    const bundleEvents = ctx.repos.listEvents(ctx.db, claimId);
    if (!bundleEvents.some((e) => e.type === 'services_agreed')) appendPaperworkEvent(ctx, claimId, 'services_agreed', `Services agreed: ${loa.title} signed`, { documentId: loa.id, method: meta.method }, actor);
  }
  // Close any open signature requests for these documents.
  for (const d of docs) {
    for (const r of ctx.repos.listSignatureRequests(ctx.db, { documentId: d.id, status: OPEN_REQUEST })) {
      ctx.repos.transitionSignatureRequest(ctx.db, r.id, 'signed', { signedAt: d.signature?.signedAt ?? ctx.now(), confirmedBy: actor.userId, nextChaseAt: null, ...(d.signature?.evidenceId && meta.method !== 'kiosk_otp_email' && meta.method !== 'kiosk_handler_code' ? { returnedEvidenceId: d.signature.evidenceId } : {}) }, actor.userId, `signed (${meta.method})`, ctx.now());
    }
  }
}

// ---------------------------------------------------------------------------
// Mark signed (human)
// ---------------------------------------------------------------------------

export interface MarkSignedInput {
  evidenceId: Id;
  signerPartyId?: Id;
  /** The date written on the signed copy (YYYY-MM-DD) or an ISO date-time. */
  signedOn: string;
  method: 'wet_ink' | 'scan';
}

export async function markDocumentSigned(ctx: AppContext, documentId: Id, input: MarkSignedInput, actor: Actor, req: { ip: string; userAgent: string }): Promise<{ document: GeneratedDocument; certificateId: string }> {
  assertHuman(actor, 'mark a document signed');
  const doc = ctx.repos.requireDocument(ctx.db, documentId, { includeHtml: false });
  if (!doc.claimId) throw conflict('DOCUMENT_STATE', 'Only a claim document can be marked signed');
  const evidence = ctx.repos.getEvidence(ctx.db, input.evidenceId);
  if (!evidence || evidence.claimId !== doc.claimId) throw badRequest('Choose the returned scan from this claim’s evidence', { code: 'EVIDENCE_REQUIRED' });
  const request = ctx.repos.listSignatureRequests(ctx.db, { documentId, status: OPEN_REQUEST })[0];
  const claim = ctx.repos.requireClaim(ctx.db, doc.claimId);
  const signer = ctx.repos.requireParty(ctx.db, input.signerPartyId ?? request?.signerPartyId ?? claim.claimantId);
  const now = ctx.now();
  const day = input.signedOn.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest('signedOn must be a date (YYYY-MM-DD)');
  if (day > now.slice(0, 10)) throw badRequest('The signing date cannot be in the future');
  if (day < doc.createdAt.slice(0, 10)) throw conflict('DATE_BEFORE_CREATION', `The document was created on ${doc.createdAt.slice(0, 10)}; it cannot have been signed on ${day}`);
  // The time of a wet signature is not known: noon on the day, never before the document existed or after now.
  let signedAt = input.signedOn.length > 10 ? new Date(input.signedOn).toISOString() : `${day}T12:00:00.000Z`;
  if (Date.parse(signedAt) < Date.parse(doc.createdAt)) signedAt = doc.createdAt;
  if (Date.parse(signedAt) > Date.parse(now)) signedAt = now;
  const r = await signDocumentWithCertificate(ctx, {
    document: doc,
    signature: {
      signerPartyId: signer.id,
      signerName: signer.name,
      signerContact: signer.email ?? signer.phone ?? 'on file',
      otpChannel: 'none',
      otpVerifiedAt: now,
      ipAddress: req.ip,
      userAgent: req.userAgent.slice(0, 500),
      signedAt,
      documentSha256: doc.sha256,
      method: input.method,
      evidenceId: evidence.id,
      ...(request?.packId ? { packId: request.packId } : {}),
    },
    proofToken: `wet:${evidence.sha256}:${now}`,
    actor,
  });
  audit(ctx, actor, 'document.mark_signed', 'documents', doc.id, { evidenceId: evidence.id, signerPartyId: signer.id, signedOn: day, method: input.method, certificateId: r.certificateId });
  afterDocumentsSigned(ctx, doc.claimId, [doc.id], actor, { method: input.method, ...(request?.packId ? { packId: request.packId } : {}) });
  for (const p of ctx.repos.listDocumentPacksWithDocument(ctx.db, doc.claimId, doc.id)) {
    const next = refreshPackFromDocuments(ctx, p.id);
    if (next.reservationId) syncEnforceabilityFromPack(ctx, ctx.db, { reservationId: next.reservationId });
  }
  nudgeAutopilot(ctx, doc.claimId, `${doc.title} marked signed`);
  return { document: r.document, certificateId: r.certificateId };
}

// ---------------------------------------------------------------------------
// signing.chase
// ---------------------------------------------------------------------------

export interface ChaseRunResult {
  chased: Array<{ claimId: Id; packId?: Id; requestIds: Id[]; outboxId?: string; error?: string }>;
  calls: Array<{ claimId: Id; requestIds: Id[]; needsYouId: Id }>;
  waiting: number;
}

function chaseBody(signerName: string, titles: string[], chaseNumber: number): string {
  return [
    `Dear ${signerName},`,
    '',
    `${chaseNumber > 1 ? 'We wrote to you again recently' : 'This is a reminder'} about the documents we sent you to sign. We have not yet received these signed documents back:`,
    ...titles.map((t) => `- ${t}`),
    '',
    'Please sign and return them as soon as you can: scan or photograph every page and reply to this email, or bring or post them to our office. If you have already sent them, thank you — please disregard this reminder.',
    '',
    'If you have a question about any of the documents, or you cannot print them, call us and we will help.',
    '',
    'Claims Team, Courtesy Cars Group UK Ltd',
  ].join('\n');
}

export async function runSigningChase(ctx: AppContext, job: { id: string; correlationId?: string }): Promise<ChaseRunResult> {
  const now = ctx.now();
  const schedule = signingSettings(ctx).chase;
  const due = ctx.repos.listDueSignatureRequests(ctx.db, now);
  const groups = new Map<string, SignatureRequest[]>();
  for (const r of due) {
    const key = `${r.claimId}|${r.packId ?? '-'}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: ChaseRunResult = { chased: [], calls: [], waiting: 0 };
  for (const [, reqs] of groups) {
    const claimId = reqs[0]!.claimId;
    const claim = ctx.repos.getClaim(ctx.db, claimId);
    if (!claim) continue;
    const decisions = reqs.map((r) => ({ r, a: chaseAction(r, now, schedule) }));
    const toChase = decisions.filter((d) => d.a.action === 'chase');
    const toCall = decisions.filter((d) => d.a.action === 'call');
    out.waiting += decisions.filter((d) => d.a.action === 'wait').length;
    if (toChase.length) {
      const signer = ctx.repos.getParty(ctx.db, toChase[0]!.r.signerPartyId);
      const titles = toChase.map((d) => ctx.repos.getDocument(ctx.db, d.r.documentId, { includeHtml: false })?.title ?? 'Document');
      const chaseNumber = Math.max(...toChase.map((d) => (d.a.action === 'chase' ? d.a.chaseNumber : 1)));
      let outboxId: string | undefined;
      let error: string | undefined;
      if (!signer?.email) error = 'no email address on file for the signer';
      else {
        const res = await actAsAutopilot(ctx, {
          claimId,
          step: null,
          tool: 'email_draft',
          input: { claimId, kind: 'chaser', to: [signer.email], cc: null, subject: 'Reminder: documents to sign', bodyText: chaseBody(salutationOf(signer), titles, chaseNumber), attach: [], inReplyToMessageId: null },
          jobId: job.id,
          ...(job.correlationId ? { correlationId: job.correlationId } : {}),
        });
        if (res.ok) {
          try {
            outboxId = (JSON.parse(res.content) as { outboxId?: string }).outboxId;
          } catch {
            /* content shape is the tool's */
          }
        } else error = res.content.slice(0, 300);
      }
      if (!error) {
        for (const d of toChase) {
          const count = d.r.chaseCount + 1;
          const next = nextChaseAt(d.r.sentAt!, count, schedule);
          ctx.repos.transitionSignatureRequest(ctx.db, d.r.id, 'chased', { chaseCount: count, lastChasedAt: now, nextChaseAt: next ?? null }, AUTOPILOT_USER_ID, `chase ${count}${outboxId ? ` (outbox ${outboxId})` : ''}`, now);
        }
      }
      out.chased.push({ claimId, ...(reqs[0]!.packId ? { packId: reqs[0]!.packId } : {}), requestIds: toChase.map((d) => d.r.id), ...(outboxId ? { outboxId } : {}), ...(error ? { error } : {}) });
    }
    if (toCall.length) {
      const signer = ctx.repos.getParty(ctx.db, toCall[0]!.r.signerPartyId);
      const titles = toCall.map((d) => ctx.repos.getDocument(ctx.db, d.r.documentId, { includeHtml: false })?.title ?? 'Document');
      const ny = createNeedsYou(ctx, {
        kind: 'question',
        claimId,
        title: `Call ${signer?.name ?? 'the client'} about unsigned documents on ${claim.reference}`,
        summary: `Signed copies have not come back after ${schedule.callAfterDays} days and two reminders: ${titles.join(', ')}. Please call ${signer?.name ?? 'the client'}${signer?.phone ? ` on ${signer.phone}` : ''}, or offer to sign at the office.`,
        options: [{ id: 'ok', label: 'I will call', tone: 'primary' }],
        payload: { requestIds: toCall.map((d) => d.r.id), packId: toCall[0]!.r.packId ?? null },
        priority: 'high',
        createdBy: AUTOPILOT_USER_ID,
        dedupeKey: `signing_call:${claimId}:${toCall[0]!.r.packId ?? toCall[0]!.r.documentId}`,
        ...(job.correlationId ? { correlationId: job.correlationId } : {}),
      });
      try {
        ctx.repos.createTask(ctx.db, { claimId, kind: 'call', title: `Call ${signer?.name ?? 'the client'}: signed documents not returned`, note: titles.join(', '), dueAt: now, createdBy: AUTOPILOT_USER_ID, now });
      } catch (err) {
        ctx.logger.warn('could not create the call task', { claimId, error: String(err) });
      }
      for (const d of toCall) ctx.repos.transitionSignatureRequest(ctx.db, d.r.id, 'chased', { chaseCount: d.r.chaseCount + 1, nextChaseAt: null }, AUTOPILOT_USER_ID, 'call the client', now);
      out.calls.push({ claimId, requestIds: toCall.map((d) => d.r.id), needsYouId: ny.id });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// signing.match_return
// ---------------------------------------------------------------------------

export interface MatchRunResult {
  matched: Array<{ requestId: Id; evidenceId: Id; documentId: Id; score: number; needsYouId: Id }>;
  checked: number;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function evidenceText(ctx: AppContext, e: Evidence): { text: string; docType?: string; pages?: number } {
  const item = ctx.repos.findIntakeItemByEvidence(ctx.db, e.id);
  let text = `${e.filename} ${e.description ?? ''}`;
  if (item?.normalised) {
    try {
      text += ` ${JSON.stringify(item.normalised).slice(0, 200_000)}`;
    } catch {
      /* not serialisable */
    }
  }
  return { text: norm(text), ...(item?.docType ? { docType: item.docType } : {}), ...(item?.pages ? { pages: item.pages } : {}) };
}

/** Score how well a piece of evidence looks like the signed return of a request (0 = not at all). */
export function scoreReturn(evidence: { kind: string; docType?: string; text: string }, doc: { title: string; templateId: string }, signerName: string): number {
  let score = 0;
  if (evidence.docType === 'signed_ccguk_form' || evidence.kind === 'signed_document') score += 2;
  const title = norm(doc.title);
  if (title && evidence.text.includes(title)) score += 2;
  else {
    const words = title.split(' ').filter((w) => w.length > 3);
    if (words.length && words.filter((w) => evidence.text.includes(w)).length >= Math.ceil(words.length * 0.6)) score += 1;
  }
  const ccguk = /ccguk_(\d\d)/.exec(doc.templateId)?.[1];
  if (ccguk && (evidence.text.includes(`ccguk ${ccguk}`) || evidence.text.includes(`ccguk${ccguk}`))) score += 1;
  if (signerName && evidence.text.includes(norm(signerName))) score += 1;
  return score;
}

export async function runMatchReturns(ctx: AppContext, job: { id: string; correlationId?: string }): Promise<MatchRunResult> {
  const open = ctx.repos.listSignatureRequests(ctx.db, { status: ['sent', 'chased'] });
  const out: MatchRunResult = { matched: [], checked: 0 };
  const byClaim = new Map<Id, SignatureRequest[]>();
  for (const r of open) byClaim.set(r.claimId, [...(byClaim.get(r.claimId) ?? []), r]);
  for (const [claimId, reqs] of byClaim) {
    const all = ctx.repos.listSignatureRequests(ctx.db, { claimId });
    const used = new Set(all.map((r) => r.returnedEvidenceId).filter(Boolean) as string[]);
    // Evidence a person already said is not the signed copy is never offered again.
    for (const r of all)
      for (const ev of ctx.repos.listSignatureRequestEvents(ctx.db, r.id)) {
        const m = /matched evidence (\S+)/.exec(ev.note ?? '');
        if (m) used.add(m[1]!);
      }
    const since = reqs.map((r) => r.sentAt ?? r.createdAt).sort()[0]!;
    const candidates = ctx.repos
      .listEvidenceForClaim(ctx.db, claimId)
      .filter((e) => !used.has(e.id) && e.uploadedAt >= since && (e.mime === 'application/pdf' || e.mime.startsWith('image/')) && e.kind !== 'signature_image');
    for (const e of candidates) {
      out.checked += 1;
      const info = evidenceText(ctx, e);
      let best: { r: SignatureRequest; doc: GeneratedDocument; score: number } | undefined;
      for (const r of reqs) {
        if (r.returnedEvidenceId) continue;
        if (Date.parse(e.uploadedAt) < Date.parse(r.sentAt ?? r.createdAt)) continue;
        const doc = ctx.repos.getDocument(ctx.db, r.documentId, { includeHtml: false });
        if (!doc || doc.status === 'signed') continue;
        const signer = ctx.repos.getParty(ctx.db, r.signerPartyId);
        const score = scoreReturn({ kind: e.kind, ...(info.docType ? { docType: info.docType } : {}), text: info.text }, doc, signer?.name ?? '');
        if (score >= 2 && (!best || score > best.score)) best = { r, doc, score };
      }
      if (!best) continue;
      const now = ctx.now();
      const req = ctx.repos.transitionSignatureRequest(ctx.db, best.r.id, 'returned', { returnedEvidenceId: e.id }, AUTOPILOT_USER_ID, `matched evidence ${e.id} (score ${best.score})`, now);
      best.r.returnedEvidenceId = e.id;
      const claim = ctx.repos.requireClaim(ctx.db, claimId);
      const ny = createNeedsYou(ctx, {
        kind: 'confirm_signed',
        claimId,
        title: `Confirm the signed ${best.doc.title} on ${claim.reference}`,
        summary: `A returned copy (${e.filename}) looks like the signed ${best.doc.title}. Check the scan against the document we sent and confirm the date it was signed.`,
        recommendation: { action: 'Check each page and confirm', why: 'Only a person may mark a document signed.', confidence: Math.min(0.9, 0.4 + best.score * 0.1), basis: [{ kind: 'rule', id: 'signing.match_return', label: 'Returned scan matched (§E.4)' }] },
        options: [
          { id: 'confirm', label: 'Confirm signed', tone: 'primary' },
          { id: 'not_signed', label: 'Not signed', tone: 'neutral' },
          { id: 'wrong_document', label: 'Wrong document', tone: 'danger' },
        ],
        payload: { signatureRequestId: req.id, documentId: best.doc.id, evidenceId: e.id, title: best.doc.title, signerPartyId: req.signerPartyId, filename: e.filename, score: best.score, suggestedSignedOn: e.uploadedAt.slice(0, 10) },
        priority: 'normal',
        createdBy: AUTOPILOT_USER_ID,
        dedupeKey: `confirm_signed:${req.id}:${e.id}`,
        ...(job.correlationId ? { correlationId: job.correlationId } : {}),
      });
      out.matched.push({ requestId: req.id, evidenceId: e.id, documentId: best.doc.id, score: best.score, needsYouId: ny.id });
    }
  }
  return out;
}

/** confirm_signed "not signed" / "wrong document": the request goes back to waiting (chases continue). */
export function rejectReturn(ctx: AppContext, requestId: Id, actor: Actor, why: 'not_signed' | 'wrong_document', note?: string): SignatureRequest {
  assertHuman(actor, 'reject a returned copy');
  const r = ctx.repos.requireSignatureRequest(ctx.db, requestId);
  if (r.status !== 'returned') return r;
  const back = r.chaseCount > 0 ? 'chased' : 'sent';
  const schedule = signingSettings(ctx).chase;
  const next = r.sentAt ? nextChaseAt(r.sentAt, r.chaseCount, schedule) : undefined;
  return ctx.repos.transitionSignatureRequest(ctx.db, r.id, back, { nextChaseAt: next ?? null, returnedEvidenceId: null }, actor.userId, `${why === 'not_signed' ? 'returned copy is not signed' : 'returned copy is a different document'}${note ? `: ${note}` : ''}`, ctx.now());
}

export function requireSignedOn(v: unknown, fallback: string): string {
  const s = typeof v === 'string' && v.trim() ? v.trim() : fallback;
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) throw new HttpError(400, 'VALIDATION', 'Give the date written on the signed copy (YYYY-MM-DD)');
  return s;
}
