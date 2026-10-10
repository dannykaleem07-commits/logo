// owned by ap-autopilot
/**
 * Commitment verification (docs/SUPREME-AUTOPILOT.md §D.3): called at the end of the mail slice's `describeOutbox`.
 *
 *  1 `descriptor.step` comes from `outbox.autopilot_step_id` or, when empty (a draft the drafter wrote after an
 *    autopilot hand-off), from STEP_FOR_SEND[kind or template] — with the effective mode and green of the claim's stored
 *    plan. Outboxes no step owns are left untouched (phase-1 behaviour).
 *  2 For kinds `hire_offer` / `booking_update`, `descriptor.commitment = { kind, refId, verified, reasons }`, verified
 *    by code only when every §D.3 condition holds (one bound offer / planned movement; the reservation held /
 *    confirmed for this claim, the hold not expiring within 30 minutes; the terms hash unchanged; a fresh clash check
 *    with no block and no green-blocking warn; owner-authorised, or the step green and automatic).
 *  3 The fixed, code-built sentences of these emails (the neutral intervention sentence carries the word "offer")
 *    are not the client being offered a settlement: for a verified commitment on an automatic step the deterministic
 *    touch scan is re-run on the text without them, and `settlement` is cleared only when that re-scan finds none.
 *    Anything the reviewer flagged for money, liability or legal still asks.
 */
import {
  GREEN_BLOCKING_CLASH_CODES,
  OFFER_FIXED_SENTENCES,
  STEP_FOR_SEND,
  isAutopilotStepId,
  type ActionDescriptor,
  type AutopilotPlan,
  type CommitmentContext,
  type StepContext,
} from '@ccguk/domain';
import type { OutboxRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { checkClashes } from '../clash/service.js';
import { termsStillMatch } from './hireOffers.js';

const HOLD_MARGIN_MS = 30 * 60_000;
/** The reviewer's deterministic `settlement` touch (casework/review.ts detTouches), re-run on the text without the fixed sentences. */
const SETTLEMENT_RE = /\b(offer|settle(ment)?|without prejudice|full and final|accept(ed|ance)?|counter[- ]?offer|part 36)\b/i;

function storedPlan(ctx: AppContext, claimId: string | undefined): AutopilotPlan | undefined {
  if (!claimId) return undefined;
  try {
    return ctx.repos.getClaimAutopilot(ctx.db, claimId)?.plan;
  } catch {
    return undefined;
  }
}

/** The step an outbox email is sent for (§D.3 point 1). */
export function stepForOutbox(ctx: AppContext, o: OutboxRecord, templateId?: string): StepContext | undefined {
  const id = o.autopilotStepId ?? (templateId ? STEP_FOR_SEND[templateId] : undefined) ?? STEP_FOR_SEND[o.kind];
  if (!id || !isAutopilotStepId(id)) return undefined;
  const st = storedPlan(ctx, o.claimId)?.steps.find((s) => s.id === id);
  if (!st) return o.autopilotStepId ? { id, mode: 'confirm', green: false } : undefined;
  return { id, mode: st.mode, green: st.green };
}

function verifyOffer(ctx: AppContext, o: OutboxRecord, step: StepContext | undefined): CommitmentContext {
  const reasons: string[] = [];
  const offers = ctx.repos.listHireOffers(ctx.db, { claimId: o.claimId }).filter((x) => x.outboxId === o.id && x.status === 'draft');
  if (offers.length !== 1) return { kind: 'hire_offer', refId: o.id, verified: false, reasons: ['No single prepared offer is bound to this email'] };
  const offer = offers[0]!;
  const r = ctx.repos.getReservation(ctx.db, offer.reservationId);
  const now = Date.parse(ctx.now());
  if (!r || r.claimId !== o.claimId) reasons.push('The held car is not on this claim');
  else {
    if (r.status !== 'held') reasons.push(`The car is no longer held (${r.status})`);
    if (!r.holdExpiresAt || Date.parse(r.holdExpiresAt) - now < HOLD_MARGIN_MS) reasons.push('The hold expires within 30 minutes');
    if (!termsStillMatch(ctx, offer).match) reasons.push('The booking changed after the offer was drafted');
    reasons.push(...clashReasons(ctx, r.id));
  }
  const ownerAuthorised = offer.authorisedBy !== 'autopilot_green';
  if (!ownerAuthorised && !(step?.green && step.mode === 'auto')) reasons.push('The offer is not green and was not authorised by the owner');
  return { kind: 'hire_offer', refId: offer.id, verified: reasons.length === 0, reasons };
}

function clashReasons(ctx: AppContext, reservationId: string): string[] {
  try {
    const { findings } = checkClashes(ctx, { kind: 'reservation', reservationId, stage: 'confirm' });
    return findings.filter((f) => f.severity === 'block' || (f.severity === 'warn' && (GREEN_BLOCKING_CLASH_CODES as readonly string[]).includes(f.code))).map((f) => `Clash ${f.code}: ${f.message}`);
  } catch (err) {
    return [`The clash check could not run (${err instanceof Error ? err.message : String(err)})`];
  }
}

function verifySlot(ctx: AppContext, o: OutboxRecord): CommitmentContext {
  const moves = ctx.repos.listMovements(ctx.db, { claimId: o.claimId }).filter((m) => m.noticeOutboxId === o.id && m.status === 'planned');
  if (moves.length !== 1) return { kind: 'delivery_slot', refId: o.id, verified: false, reasons: ['No single planned delivery or collection is bound to this email'] };
  const m = moves[0]!;
  const reasons: string[] = [];
  const r = ctx.repos.getReservation(ctx.db, m.reservationId);
  if (!r || r.claimId !== o.claimId) reasons.push('The booking is not on this claim');
  else {
    if (m.kind === 'delivery' && r.status !== 'confirmed') reasons.push(`The booking is not confirmed (${r.status})`);
    if (m.kind === 'collection' && r.status !== 'on_hire') reasons.push(`The car is not on hire (${r.status})`);
    reasons.push(...clashReasons(ctx, r.id));
  }
  return { kind: 'delivery_slot', refId: m.id, verified: reasons.length === 0, reasons };
}

export function applyAutopilotCommitment(ctx: AppContext, outbox: OutboxRecord, descriptor: ActionDescriptor): ActionDescriptor {
  try {
    const step = stepForOutbox(ctx, outbox, descriptor.templateId);
    let out: ActionDescriptor = step ? { ...descriptor, step } : descriptor;
    if (outbox.kind === 'hire_offer') out = { ...out, commitment: verifyOffer(ctx, outbox, step) };
    else if (outbox.kind === 'booking_update' && ctx.repos.listMovements(ctx.db, { claimId: outbox.claimId }).some((m) => m.noticeOutboxId === outbox.id)) out = { ...out, commitment: verifySlot(ctx, outbox) };
    if (out.commitment?.verified && out.step?.mode === 'auto' && out.review?.touches.settlement) {
      let text = `${outbox.subject}\n${outbox.bodyText}`;
      for (const s of OFFER_FIXED_SENTENCES) text = text.split(s).join(' ');
      if (!SETTLEMENT_RE.test(text)) out = { ...out, review: { ...out.review, touches: { ...out.review.touches, settlement: false } } };
    }
    return out;
  } catch (err) {
    ctx.logger.warn('autopilot: commitment check failed; the send asks the owner', { outboxId: outbox.id, error: String(err) });
    return outbox.kind === 'hire_offer' ? { ...descriptor, commitment: { kind: 'hire_offer', refId: outbox.id, verified: false, reasons: ['The commitment check failed'] } } : descriptor;
  }
}
