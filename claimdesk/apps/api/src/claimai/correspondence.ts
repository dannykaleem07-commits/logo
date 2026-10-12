// owned by claimai-server
/**
 * Off-system correspondence records (docs/CLAIM-AI-INPUT.md §2.1, §9): a letter or email sent or received outside
 * ClaimDesk, recorded with its real date and the chronology event it implies (marked "recorded late, source: <file>").
 * Never an outbox row (the outbox is ClaimDesk's sending machine). Append-only: a withdrawal is a superseding row plus a
 * correcting note on its event.
 */
import { randomUUID } from 'node:crypto';
import { COPY, type ActionParams, type EventType } from '@ccguk/domain';
import { isLateEntry } from '../services/hireCorrection.js';
import type { Actor, ClaimCorrespondenceRecord, CorrespondenceChannel, CorrespondenceDateSource } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { appendClaimEvent } from '../mail/common.js';

export interface RecordResult {
  correspondenceId: string;
  eventId: string | null;
  extraEventId: string | null;
  created: boolean;
}

const CHANNELS = new Set(['email', 'post', 'hand', 'phone', 'portal', 'unknown']);
const SOURCES = new Set(['document', 'email_header', 'owner', 'file_metadata']);

/** The live record for a bundle file (or evidence) of this claim, if any. */
export function liveRecordFor(ctx: AppContext, claimId: string, q: { bundleFileId?: string | null; evidenceId?: string | null }): ClaimCorrespondenceRecord | undefined {
  return ctx.repos.listCorrespondence(ctx.db, claimId).find((r) => (q.bundleFileId && r.bundleFileId === q.bundleFileId) || (q.evidenceId && r.evidenceId === q.evidenceId));
}

/** The last row of a record's chain (the withdrawal), so a re-record supersedes it. */
function chainTail(ctx: AppContext, claimId: string, evidenceId: string, direction: 'out' | 'in'): string | null {
  const rows = ctx.repos.listCorrespondence(ctx.db, claimId, { includeWithdrawn: true }).filter((r) => r.evidenceId === evidenceId && r.direction === direction);
  if (!rows.length) return null;
  const superseded = new Set(rows.map((r) => r.supersedesId).filter(Boolean));
  const tail = rows.filter((r) => !superseded.has(r.id)).pop();
  return tail && tail.withdrawn ? tail.id : null;
}

/**
 * Record one letter / email: the back-dated chronology event (with its late-entry marks) and the record, plus the
 * second event a first insurer letter implies (handling_ref_received). Idempotent per (claim, evidence, direction).
 */
export function recordCorrespondence(
  ctx: AppContext,
  input: { claimId: string; inputId: string; bundleId: string | null; actionKey: string; params: ActionParams; evidenceId: string | null },
  actor: Actor,
): RecordResult {
  const p = input.params;
  const direction = p.direction === 'in' ? 'in' : 'out';
  const at = p.at!;
  const existing = input.evidenceId ? ctx.repos.listCorrespondence(ctx.db, input.claimId).find((r) => r.evidenceId === input.evidenceId && r.direction === direction) : undefined;
  if (existing) return { correspondenceId: existing.id, eventId: existing.eventId ?? null, extraEventId: null, created: false };
  const correspondenceId = randomUUID();
  const lateSource = { inputId: input.inputId, bundleFileId: p.bundleFileId ?? null, filename: p.filename ?? null, evidenceId: input.evidenceId };
  const summary = (p.summary ?? `${p.label ?? 'Letter'} — ${COPY.recordedLate(p.filename ?? 'a file')}`).slice(0, 1000);
  const ev = appendClaimEvent(
    ctx,
    input.claimId,
    {
      type: (p.eventType ?? (direction === 'out' ? 'letter_out' : 'letter_in')) as EventType,
      at,
      summary,
      evidenceIds: input.evidenceId ? [input.evidenceId] : [],
      ...(direction === 'in' && p.counterpartyRole === 'at_fault_insurer' ? { attributableTo: 'insurer' as const } : direction === 'out' ? { attributableTo: 'ccguk' as const } : {}),
      data: {
        source: 'ai_input',
        aiInputId: input.inputId,
        actionKey: input.actionKey,
        recordedLate: true,
        lateEntry: isLateEntry(at, ctx.now()),
        lateSource,
        correspondenceId,
        kind: p.kind ?? null,
        direction,
        ...(p.templateId ? { templateId: p.templateId } : {}),
        ...(p.emailKind ? { emailKind: p.emailKind } : {}),
      },
    },
    actor,
  );
  let extraEventId: string | null = null;
  if (p.alsoEventType) {
    const extra = appendClaimEvent(
      ctx,
      input.claimId,
      {
        type: p.alsoEventType as EventType,
        at,
        summary: `${p.alsoEventType === 'handling_ref_received' ? 'Handling reference received' : p.alsoEventType} — ${COPY.recordedLate(p.filename ?? 'a file')}`,
        evidenceIds: input.evidenceId ? [input.evidenceId] : [],
        attributableTo: 'insurer',
        data: { source: 'ai_input', aiInputId: input.inputId, actionKey: input.actionKey, recordedLate: true, lateEntry: isLateEntry(at, ctx.now()), lateSource, correspondenceId },
      },
      actor,
    );
    extraEventId = extra.id;
  }
  const supersedesId = input.evidenceId ? chainTail(ctx, input.claimId, input.evidenceId, direction) : null;
  const { record, created } = ctx.repos.appendCorrespondence(ctx.db, {
    id: correspondenceId,
    claimId: input.claimId,
    direction,
    channel: (CHANNELS.has(p.channel ?? '') ? p.channel : 'unknown') as CorrespondenceChannel,
    kind: p.kind ?? (direction === 'out' ? 'other_out' : 'other_in'),
    templateId: p.templateId ?? null,
    emailKind: p.emailKind ?? null,
    counterpartyRole: p.counterpartyRole ?? null,
    counterpartyName: p.counterpartyName ?? null,
    at,
    dateSource: (SOURCES.has(p.dateSource ?? '') ? p.dateSource : 'owner') as CorrespondenceDateSource,
    subject: p.purpose ?? null,
    summary,
    evidenceId: input.evidenceId,
    eventId: ev.id,
    inputId: input.inputId,
    bundleId: input.bundleId,
    bundleFileId: p.bundleFileId ?? null,
    supersedesId,
    createdBy: actor.userId,
    now: ctx.now(),
  });
  ctx.repos.appendAudit(ctx.db, {
    actor,
    action: 'claim_ai.correspondence.record',
    entity: 'claim_correspondence',
    entityId: record.id,
    after: { claimId: input.claimId, inputId: input.inputId, direction, kind: record.kind, at, dateSource: record.dateSource, eventId: ev.id, extraEventId, evidenceId: input.evidenceId },
    at: ctx.now(),
  });
  return { correspondenceId: record.id, eventId: ev.id, extraEventId, created };
}

/** Withdraw a record (undo): a superseding withdrawn row and a correcting note on its event(s). */
export function withdrawRecord(ctx: AppContext, claimId: string, correspondenceId: string, eventIds: string[], actor: Actor, why: string): { correctingEventIds: string[] } {
  const live = ctx.repos.listCorrespondence(ctx.db, claimId).find((r) => r.id === correspondenceId);
  const out: string[] = [];
  if (live) ctx.repos.withdrawCorrespondence(ctx.db, live.id, { by: actor.userId, now: ctx.now() });
  for (const id of eventIds) {
    const ev = ctx.repos.listEvents(ctx.db, claimId).find((e) => e.id === id);
    if (!ev) continue;
    const c = appendClaimEvent(ctx, claimId, { type: 'note', at: ev.at, summary: why.slice(0, 1000), data: { correctsEventId: ev.id, source: 'ai_input', withdrawnCorrespondenceId: correspondenceId } }, actor);
    out.push(c.id);
  }
  ctx.repos.appendAudit(ctx.db, { actor, action: 'claim_ai.correspondence.withdraw', entity: 'claim_correspondence', entityId: correspondenceId, after: { claimId, correctingEventIds: out }, at: ctx.now() });
  return { correctingEventIds: out };
}
