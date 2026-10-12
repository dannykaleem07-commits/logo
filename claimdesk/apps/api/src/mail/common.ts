// owned by mail
/**
 * Shared mail helpers: the agent actor, the account, chronology appends with the same side effects and clock
 * recompute as `POST /claims/:id/events`, and filing a message's evidence on a claim.
 *
 * Evidence is write-once and content-addressed per claim, so an inbound message is stored once with no claim
 * (`_unassigned`) and, when it is matched, its raw copy and attachments are copied onto the claim by hash (the store
 * de-duplicates, so a second filing is free). `mail_messages.raw_evidence_id` keeps pointing at the original.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Actor, MailAccountRecord, MailMessageRecord } from '@ccguk/db';
import type { ClaimEvent, Evidence, EventType, Id } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { absoluteEvidencePath, storeEvidence, type StagedUpload } from '../services/evidence.js';
import { applyEventSideEffects } from '../services/sideEffects.js';
import { recomputeClocks } from '../services/claimView.js';

export const MAIL_AGENT = 'agent:mail';
export const MAIL_ACTOR: Actor = { userId: MAIL_AGENT };
export const FROM_NAME = 'Claims Team, Courtesy Cars Group UK Ltd';

/** The mailbox the agents use (one in practice). */
export function mailAccount(ctx: AppContext): MailAccountRecord | undefined {
  return ctx.repos.getDefaultMailAccount(ctx.db);
}

/** `"Claims Team, Courtesy Cars Group UK Ltd" <address>` (owner's rule: the identity is fixed). */
export function fromHeader(account: Pick<MailAccountRecord, 'fromAddress'>): string {
  return `"${FROM_NAME}" <${account.fromAddress}>`;
}

export interface AppendEventInput {
  type: EventType;
  at: string;
  summary: string;
  data?: Record<string, unknown>;
  evidenceIds?: Id[];
  attributableTo?: ClaimEvent['attributableTo'];
}

/** Append a chronology event exactly as the events route does (audit, side effects, clocks). */
export function appendClaimEvent(ctx: AppContext, claimId: Id, input: AppendEventInput, actor: Actor): ClaimEvent {
  const event = ctx.db.transaction((tx) => {
    const scoped = { ...ctx, db: tx };
    const e = ctx.repos.appendEvent(tx, {
      claimId,
      type: input.type,
      at: input.at,
      summary: input.summary.slice(0, 2000),
      ...(input.data ? { data: input.data } : {}),
      evidenceIds: input.evidenceIds ?? [],
      ...(input.attributableTo ? { attributableTo: input.attributableTo } : {}),
      createdBy: actor.userId,
      recordedAt: ctx.now(),
    });
    ctx.repos.appendAudit(tx, { actor, action: 'event.append', entity: 'claim_events', entityId: e.id, after: { type: e.type, at: e.at, summary: e.summary }, at: ctx.now() });
    applyEventSideEffects(scoped, e, actor);
    return e;
  });
  try {
    recomputeClocks(ctx, claimId);
  } catch (err) {
    ctx.logger.warn('clock recompute after a mail event failed', { claimId, error: String(err) });
  }
  return event;
}

/** Copy an evidence file onto a claim (same bytes, deduped by hash on that claim). */
export async function copyEvidenceToClaim(ctx: AppContext, evidenceId: Id, claimId: Id, actor: Actor, description?: string): Promise<Evidence> {
  const src = ctx.repos.requireEvidence(ctx.db, evidenceId);
  if (src.claimId === claimId) return src;
  const onClaim = ctx.repos.findEvidenceBySha256(ctx.db, src.sha256).find((e) => e.claimId === claimId);
  if (onClaim) return onClaim;
  const from = absoluteEvidencePath(ctx, src.storagePath);
  const tempPath = path.join(ctx.config.evidenceDir, '.incoming', randomUUID());
  mkdirSync(path.dirname(tempPath), { recursive: true });
  copyFileSync(from, tempPath);
  const staged: StagedUpload = { tempPath, sha256: src.sha256, bytes: src.bytes };
  const stored = await storeEvidence(ctx, { claimId, staged, filename: src.filename, mime: src.mime, fields: { kind: src.kind, ...(description ?? src.description ? { description: description ?? src.description } : {}) }, actor });
  return stored.evidence;
}

/** File a message's raw copy and attachments on its claim; returns the claim-side evidence ids (raw first). */
export async function fileMessageEvidence(ctx: AppContext, message: MailMessageRecord, claimId: Id, actor: Actor = MAIL_ACTOR): Promise<{ rawEvidenceId: Id; attachments: Array<{ mailAttachmentId: string; evidenceId: Id; filename: string; mime: string; bytes: number; inline: boolean }> }> {
  const raw = await copyEvidenceToClaim(ctx, message.rawEvidenceId, claimId, actor, `Email: ${message.subject ?? '(no subject)'}`.slice(0, 500));
  const attachments = [];
  for (const a of ctx.repos.listMailAttachments(ctx.db, message.id)) {
    const e = await copyEvidenceToClaim(ctx, a.evidenceId, claimId, actor);
    attachments.push({ mailAttachmentId: a.id, evidenceId: e.id, filename: a.filename, mime: a.mime, bytes: a.bytes, inline: a.inline });
  }
  return { rawEvidenceId: raw.id, attachments };
}

/** Claim-side evidence ids already filed for a message (no copying). */
export function filedEvidenceIds(ctx: AppContext, message: MailMessageRecord): Id[] {
  if (!message.claimId) return [];
  const shas = [ctx.repos.getEvidence(ctx.db, message.rawEvidenceId)?.sha256, ...ctx.repos.listMailAttachments(ctx.db, message.id).map((a) => a.sha256)].filter((s): s is string => Boolean(s));
  const out: Id[] = [];
  for (const sha of shas) {
    const e = ctx.repos.findEvidenceBySha256(ctx.db, sha).find((x) => x.claimId === message.claimId);
    if (e) out.push(e.id);
  }
  return out;
}

export const londonDate = (iso: string): string => new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric' });
