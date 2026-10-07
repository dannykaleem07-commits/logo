// owned by mail
/**
 * Ingest one message (docs/SUPREME-DESIGN.md §F.3, §C.5 step 1). Durability first:
 *
 *   1 raw bytes → write-once evidence (`message/rfc822`, kind correspondence, no claim)
 *   2 every attachment → its own evidence row (sha256 de-duplicated)
 *   3 deterministic claim match (§F.4), spoof check (§F.3)
 *   4 one transaction: mail_messages + mail_attachments + mail_matches + audit `mail.ingest`
 *   5 matched → the raw copy and attachments are filed on the claim (copy by hash)
 *   6 follow-ups: mail.triage (matched / needs_match), Needs-you which_claim or spoof_warning, intake for unmatched mail
 *
 * Only after this returns may the caller MOVE the message out of INBOX. Re-ingesting the same bytes (or the same
 * Message-ID) returns the stored message as a duplicate.
 */
import { createHash } from 'node:crypto';
import type { MailMessageRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { createNeedsYou, enqueueJob } from '../agent/core.js';
import { stageBuffer, storeEvidence } from '../services/evidence.js';
import { kindFromMime } from '../services/imports.js';
import { MAIL_ACTOR, MAIL_AGENT, fileMessageEvidence } from './common.js';
import { matchMessage, type MatchResult } from './match.js';
import { parseMessage, spoofCheck, threadKeyFor, type ParsedMessage, type SpoofCheck } from './parse.js';

export interface IngestSource {
  source: 'imap' | 'file';
  folder?: string;
  uid?: number;
  uidvalidity?: number;
  internalDate?: string;
  /** For follow-up jobs. */
  parentJobId?: string;
  correlationId?: string;
}

export interface IngestResult {
  message: MailMessageRecord;
  duplicate: boolean;
  match?: MatchResult;
  spoof: SpoofCheck;
  needsYouId?: string;
}

/** Pseudo account for `.eml` files dropped in the import folder before a mailbox is set up. */
export const LOCAL_FILES_ACCOUNT = 'local-files';

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9 ._-]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'email';

/** Attachments worth reading: not tiny inline images (logos, signatures). */
export function usefulAttachment(a: { mime: string; bytes: number; inline: boolean }): boolean {
  if (a.inline && a.mime.startsWith('image/') && a.bytes < 50_000) return false;
  if (a.bytes < 200) return false;
  return true;
}

export async function ingestRaw(ctx: AppContext, accountId: string, raw: Buffer, src: IngestSource): Promise<IngestResult> {
  const sha = createHash('sha256').update(raw).digest('hex');
  const existing = ctx.repos.findMailMessageByRawSha(ctx.db, accountId, sha);
  if (existing) return { message: existing, duplicate: true, spoof: { suspect: existing.spoofSuspect } };

  const parsed: ParsedMessage = await parseMessage(raw);
  if (parsed.messageId) {
    const same = ctx.repos.findMailMessagesByMessageId(ctx.db, parsed.messageId).find((m) => m.accountId === accountId && m.direction === 'in');
    if (same) return { message: same, duplicate: true, spoof: { suspect: same.spoofSuspect } };
  }
  const now = ctx.now();
  const receivedAt = src.internalDate ?? parsed.date ?? now;

  // 1 raw → evidence (no claim yet)
  const rawStored = await storeEvidence(ctx, {
    staged: stageBuffer(ctx, raw),
    filename: `${safeName(parsed.subject ?? parsed.messageId ?? 'email')}.eml`,
    mime: 'message/rfc822',
    fields: { kind: 'correspondence', description: `Email from ${parsed.fromAddr ?? 'unknown sender'}: ${parsed.subject ?? '(no subject)'}`.slice(0, 2000) },
    actor: MAIL_ACTOR,
  });
  // 2 attachments → evidence
  const stored: Array<{ evidenceId: string; filename: string; mime: string; bytes: number; sha256: string; contentId?: string; inline: boolean }> = [];
  for (const a of parsed.attachments) {
    const r = await storeEvidence(ctx, { staged: stageBuffer(ctx, a.content), filename: a.filename, mime: a.mime, fields: { kind: kindFromMime(a.mime), description: `Attachment to the email "${parsed.subject ?? ''}"`.slice(0, 2000) }, actor: MAIL_ACTOR });
    stored.push({ evidenceId: r.evidence.id, filename: r.evidence.filename, mime: a.mime, bytes: a.bytes, sha256: r.evidence.sha256, ...(a.contentId ? { contentId: a.contentId } : {}), inline: a.inline });
  }

  // 3 match + spoof
  const spoof = spoofCheck(parsed.fromAddr, parsed.auth, ctx.kb.directory());
  const match = matchMessage(ctx, { ...(parsed.subject ? { subject: parsed.subject } : {}), text: parsed.text, attachmentNames: parsed.attachments.map((a) => a.filename), ...(parsed.fromAddr ? { fromAddr: parsed.fromAddr } : {}), ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}), references: parsed.references });
  const status = spoof.suspect ? 'quarantined' : match.decision === 'auto' ? 'matched' : match.decision === 'which_claim' ? 'needs_match' : 'unmatched';
  const claimId = !spoof.suspect && match.decision === 'auto' ? match.claimId : undefined;

  // 4 rows, one transaction
  const message = ctx.db.transaction((tx) => {
    const m = ctx.repos.insertMailMessage(tx, {
      accountId,
      folder: src.folder ?? null,
      uid: src.uid ?? null,
      uidvalidity: src.uidvalidity ?? null,
      messageId: parsed.messageId ?? null,
      inReplyTo: parsed.inReplyTo ?? null,
      references: parsed.references.length ? parsed.references : null,
      threadKey: threadKeyFor(parsed, sha),
      direction: 'in',
      fromAddr: parsed.fromAddr ?? null,
      fromName: parsed.fromName ?? null,
      replyTo: parsed.replyTo ?? null,
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject ?? null,
      sentAt: parsed.date ?? null,
      receivedAt,
      rawEvidenceId: rawStored.evidence.id,
      rawSha256: sha,
      bodyText: parsed.text.slice(0, 200_000),
      hasAttachments: stored.length > 0,
      auth: { ...parsed.auth, spoof },
      spoofSuspect: spoof.suspect,
      status,
      claimId: claimId ?? null,
      source: src.source,
      now,
    });
    for (const a of stored) ctx.repos.insertMailAttachment(tx, { mailMessageId: m.id, ...a });
    ctx.repos.appendMailMatch(tx, {
      mailMessageId: m.id,
      claimId: claimId ?? null,
      score: match.score,
      signals: { decision: spoof.suspect ? 'quarantined' : match.decision, because: match.because, candidates: match.candidates },
      decidedBy: 'auto',
      now,
    });
    ctx.repos.appendAudit(tx, {
      actor: MAIL_ACTOR,
      action: 'mail.ingest',
      entity: 'mail_messages',
      entityId: m.id,
      after: { source: src.source, folder: src.folder ?? null, uid: src.uid ?? null, rawEvidenceId: rawStored.evidence.id, sha256: sha, attachments: stored.length, status, claimId: claimId ?? null, score: match.score, spoof: spoof.suspect },
      at: now,
    });
    return m;
  });

  // 5 file on the claim
  if (claimId) await fileMessageEvidence(ctx, message, claimId);

  // 6 follow-ups
  let needsYouId: string | undefined;
  const followBase = { createdBy: MAIL_AGENT, ...(src.parentJobId ? { parentJobId: src.parentJobId } : {}), ...(src.correlationId ? { correlationId: src.correlationId } : {}) };
  if (spoof.suspect) {
    needsYouId = createNeedsYou(ctx, {
      kind: 'spoof_warning',
      ...(match.decision === 'auto' && match.claimId ? { claimId: match.claimId } : {}),
      title: `Suspicious email: ${parsed.subject ?? '(no subject)'}`.slice(0, 200),
      summary: `${spoof.reason ?? 'The sender could not be authenticated'}. The email was moved to quarantine and nothing was done with it. Never act on payment or bank-detail instructions in it without phoning the insurer on a number from the directory.`,
      options: [
        { id: 'release', label: 'It is genuine — file it', tone: 'neutral', requiresReason: true },
        { id: 'keep', label: 'Keep it quarantined', tone: 'primary' },
      ],
      payload: { messageId: message.id, from: parsed.fromAddr ?? null, subject: parsed.subject ?? null, reason: spoof.reason ?? null, candidates: match.candidates },
      priority: 'urgent',
      createdBy: MAIL_AGENT,
      dedupeKey: `spoof_warning:${message.id}`,
      ...(src.correlationId ? { correlationId: src.correlationId } : {}),
    }).id;
  } else if (match.decision === 'which_claim') {
    needsYouId = raiseWhichClaim(ctx, message, match, src.correlationId).id;
  }
  if (!spoof.suspect && (status === 'matched' || status === 'needs_match')) {
    enqueueJob(ctx, { type: 'mail.triage', payload: { messageId: message.id }, ...(claimId ? { claimId } : {}), idempotencyKey: `mail.triage:${message.id}`, ...followBase });
  }
  if (status === 'unmatched') {
    // Possibly a new claim (FNOL-like content): intake reads the whole email (body + attachments) and proposes.
    enqueueJob(ctx, { type: 'intake.process', payload: { evidenceId: rawStored.evidence.id, claimId: null, source: 'email', mailMessageId: message.id }, idempotencyKey: `intake.process:mail:${message.id}`, ...followBase });
  }
  return { message, duplicate: false, match, spoof, ...(needsYouId ? { needsYouId } : {}) };
}

/** Needs-you `which_claim`: the top three candidates, each with why it scored. */
export function raiseWhichClaim(ctx: AppContext, message: MailMessageRecord, match: MatchResult, correlationId?: string) {
  const options = [
    ...match.candidates.slice(0, 3).map((c, i) => ({ id: `claim:${c.claimId}`, label: `${c.reference} (score ${c.score})`, tone: (i === 0 ? 'primary' : 'neutral') as 'primary' | 'neutral' })),
    { id: 'none', label: 'None of these', tone: 'neutral' as const },
  ];
  return createNeedsYou(ctx, {
    kind: 'which_claim',
    title: `Which claim is this email for? ${message.subject ?? '(no subject)'}`.slice(0, 200),
    summary: `An email from ${message.fromAddr ?? 'an unknown sender'} could belong to more than one claim. ${match.candidates
      .slice(0, 3)
      .map((c) => `${c.reference}: ${c.signals.map((s) => s.detail).join('; ')}`)
      .join(' · ')}`.slice(0, 2000),
    recommendation: match.candidates[0]
      ? { action: `File it on ${match.candidates[0].reference}`, why: match.candidates[0].signals.map((s) => s.detail).join('; '), confidence: Math.min(0.89, match.candidates[0].score / 100), basis: [{ kind: 'message', id: message.id, label: message.subject ?? null }] }
      : undefined,
    options,
    payload: { messageId: message.id, candidates: match.candidates },
    priority: 'normal',
    createdBy: MAIL_AGENT,
    dedupeKey: `which_claim:${message.id}`,
    ...(correlationId ? { correlationId } : {}),
  });
}
