/**
 * Event side effects (BLUEPRINT §3.3/§3.4/§3.6). Appending certain event types changes the file:
 *  - intervention_offer      → an offer is logged in the intervention register (unless the event already carries offerId)
 *  - report_issued           → while storage is open: storage_report_plus_48h clock + SEND_COLLECT_OR_PAY flag
 *  - repair_completed / tl_payment_received / insurer_termination_notice
 *                            → off-hire deadline (gta.offHireDeadline) recorded as the expected end trigger on open hires
 * Every effect is audited. The caller recomputes the clock cache afterwards.
 */
import { offHireDeadline, type ClaimEvent, type HireEndTrigger, type Id, type InterventionOffer } from '@ccguk/domain';
import type { Actor } from '@ccguk/db';
import type { AppContext } from '../context.js';

export interface SideEffectResult {
  offer?: InterventionOffer;
  flags: string[];
  offHire?: { trigger: HireEndTrigger; dueAt: string; basis: string; hireIds: Id[] };
}

const OFFHIRE_BY_EVENT: Partial<Record<ClaimEvent['type'], HireEndTrigger>> = {
  repair_completed: 'repair_complete_24h',
  tl_payment_received: 'tl_payment_5wd',
  insurer_termination_notice: 'insurer_termination_1wd',
  cash_in_lieu_received: 'cash_in_lieu',
};

export function applyEventSideEffects(ctx: AppContext, event: ClaimEvent, actor: Actor): SideEffectResult {
  const { repos, db } = ctx;
  const result: SideEffectResult = { flags: [] };
  const at = ctx.now();

  if (event.type === 'intervention_offer' && !event.data?.offerId) {
    const d = (event.data ?? {}) as Record<string, unknown>;
    const offer = repos.createOffer(db, {
      claimId: event.claimId,
      receivedAt: typeof d.receivedAt === 'string' ? d.receivedAt : event.at,
      channel: (typeof d.channel === 'string' ? d.channel : 'via_client') as InterventionOffer['channel'],
      offerorName: typeof d.offerorName === 'string' && d.offerorName.trim() ? d.offerorName : event.summary,
      offerorPartyId: typeof d.offerorPartyId === 'string' ? d.offerorPartyId : undefined,
      vehicleClassOffered: typeof d.vehicleClassOffered === 'string' ? d.vehicleClassOffered : undefined,
      dailyRatePence: typeof d.dailyRatePence === 'number' ? d.dailyRatePence : undefined,
      rateIncludesVat: typeof d.rateIncludesVat === 'boolean' ? d.rateIncludesVat : undefined,
      terms: (d.terms as InterventionOffer['terms']) ?? {},
      evidenceIds: event.evidenceIds,
    });
    repos.appendAudit(db, { actor, action: 'offer.create', entity: 'intervention_offers', entityId: offer.id, after: { fromEventId: event.id, offerorName: offer.offerorName }, at });
    result.offer = offer;
  }

  if (event.type === 'report_issued') {
    const open = repos.listStorage(db, event.claimId).filter((s) => !s.endAt);
    if (open.length) {
      repos.addClaimFlag(db, event.claimId, {
        code: 'SEND_COLLECT_OR_PAY',
        severity: 'warn',
        message: `Engineer's report issued ${event.at.slice(0, 10)} while storage is open at ${open.map((s) => s.location).join(', ')}: send the collect-or-pay notice within 48 hours or storage after report + 48 h will be refused.`,
        raisedBy: 'system',
      });
      repos.appendAudit(db, { actor, action: 'claim.flag.raise', entity: 'claims', entityId: event.claimId, after: { code: 'SEND_COLLECT_OR_PAY', eventId: event.id }, at });
      result.flags.push('SEND_COLLECT_OR_PAY');
    }
  }

  const trigger = OFFHIRE_BY_EVENT[event.type];
  if (trigger) {
    const deadline = offHireDeadline(trigger, event.at);
    const hires = repos.listHire(db, event.claimId).filter((h) => !h.endAt && h.startAt <= event.at);
    for (const h of hires) {
      repos.updateHire(db, h.id, { endTrigger: trigger });
      repos.appendAudit(db, {
        actor,
        action: 'hire.expected_end',
        entity: 'hire_agreements',
        entityId: h.id,
        before: { endTrigger: h.endTrigger ?? null },
        after: { endTrigger: trigger, expectedEndAt: deadline.dueAt, basis: deadline.basis, eventId: event.id },
        at,
      });
    }
    result.offHire = { trigger, dueAt: deadline.dueAt, basis: deadline.basis, hireIds: hires.map((h) => h.id) };
  }

  return result;
}
