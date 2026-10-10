// owned by ap-autopilot
/**
 * The Case Brief's Autopilot part (docs/SUPREME-AUTOPILOT.md §A.10): the `autopilot` section (stage, mode, due /
 * waiting / blocked steps from the stored plan) and the booking / offer facts drafts may use as `{{fact:…}}`
 * placeholders. Read from the stored records only (never re-plans, never searches), so the brief stays cheap and
 * byte-stable for identical state.
 */
import { formatRegistration, offHireDeadline, offHireTrigger, stepTitle, type AutopilotFacts, type ClaimBundle, type Movement, type Reservation } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { dateFact, textFact, numberFact, type FactValue } from '../casework/facts.js';

export interface AutopilotBriefSection {
  stage: string;
  mode: string;
  due: Array<{ id: string; title: string; dueAt: string | null }>;
  waiting: Array<{ id: string; title: string; on: string }>;
  blocked: Array<{ id: string; reason: string }>;
  /** Step ids the autopilot owns on this claim (not applicable / skipped ones left out). */
  steps: string[];
}

const RANK: Record<Reservation['status'], number> = { on_hire: 5, confirmed: 4, held: 3, returned: 2, expired: 1, cancelled: 0 };

/** Delivery / collection window in owner and client words: "Tuesday 13 October 2026, 10:00–12:00". */
export function windowText(startIso: string, endIso: string): string {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(startIso)).replace(',', '');
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day}, ${time.format(new Date(startIso))}–${time.format(new Date(endIso))}`;
}

/** "Tuesday 13 October 2026 at 10:00" (Europe/London). */
export function dateTimeText(iso: string): string {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso)).replace(',', '');
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  return `${day} at ${time}`;
}

function shortAddress(m: Pick<Movement, 'address' | 'postcode'>, mask: boolean): string {
  const a = m.address as { line1?: string; postcode?: string } | null;
  const pc = a?.postcode ?? m.postcode ?? '';
  if (mask) return pc ? `${pc.split(' ')[0]} area` : 'the agreed address';
  return [a?.line1, pc].filter((x) => x && String(x).trim()).join(', ') || 'the address we agreed';
}

export function autopilotBriefParts(ctx: AppContext, bundle: ClaimBundle, opts: { mask: boolean }): { facts: Record<string, FactValue>; section?: AutopilotBriefSection } {
  const facts: Record<string, FactValue> = {};
  const claimId = bundle.claim.id;
  let section: AutopilotBriefSection | undefined;
  try {
    const rec = ctx.repos.getClaimAutopilot(ctx.db, claimId);
    const plan = rec?.plan;
    if (plan) {
      section = {
        stage: plan.stage,
        mode: rec.mode,
        due: plan.due.map((id) => ({ id, title: stepTitle(id), dueAt: plan.steps.find((s) => s.id === id)?.dueAt ?? null })),
        waiting: plan.steps.filter((s) => s.status === 'waiting').map((s) => ({ id: s.id, title: stepTitle(s.id), on: s.waitingOn ?? 'time' })),
        blocked: plan.steps.filter((s) => s.status === 'blocked').map((s) => ({ id: s.id, reason: s.blockedBy[0]?.message ?? 'blocked' })),
        steps: plan.steps.filter((s) => s.status !== 'not_applicable' && s.status !== 'skipped').map((s) => s.id),
      };
    }
    if (bundle.vehicle.gtaGroup) facts['client.vehicle.gtaGroup'] = textFact(bundle.vehicle.gtaGroup, `vehicle:${bundle.vehicle.id}`);
    const reservations = ctx.repos.listReservations(ctx.db, { claimId }).filter((r) => r.status !== 'cancelled' && r.status !== 'expired');
    const r = reservations.sort((a, b) => RANK[b.status] - RANK[a.status] || (a.createdAt < b.createdAt ? 1 : -1))[0];
    if (r) {
      const src = `reservation:${r.id}`;
      const unit = ctx.repos.getFleetUnit(ctx.db, r.fleetUnitId);
      const v = unit ? ctx.repos.getVehicle(ctx.db, unit.vehicleId) : undefined;
      if (v) {
        facts['booking.unit.registration'] = textFact(formatRegistration(v.registration), src);
        facts['booking.unit.makeModel'] = textFact([v.make, v.model].filter(Boolean).join(' ') || formatRegistration(v.registration), src);
        facts['booking.unit.transmission'] = textFact(v.transmission === 'automatic' ? 'automatic' : v.transmission === 'manual' ? 'manual' : 'gearbox to be confirmed', src);
        const seats = (v.spec as { seats?: number } | undefined)?.seats;
        if (typeof seats === 'number') facts['booking.unit.seats'] = numberFact(seats, src);
      }
      facts['booking.unit.gtaGroup'] = textFact(r.gtaGroup, src);
      facts['booking.startAt'] = dateFact(r.startAt, src);
      if (r.agreementNumber) facts['booking.agreementNumber'] = textFact(r.agreementNumber, src);
      const moves = ctx.repos.listMovements(ctx.db, { reservationId: r.id }).filter((m) => m.status !== 'cancelled' && m.status !== 'failed');
      const delivery = moves.find((m) => m.kind === 'delivery');
      if (delivery) {
        facts['booking.delivery.window'] = textFact(windowText(delivery.windowStart, delivery.windowEnd), `movement:${delivery.id}`);
        facts['booking.delivery.addressShort'] = textFact(shortAddress(delivery, opts.mask), `movement:${delivery.id}`);
      }
      const collection = moves.find((m) => m.kind === 'collection');
      if (collection) facts['booking.collection.window'] = textFact(windowText(collection.windowStart, collection.windowEnd), `movement:${collection.id}`);
      const offer = ctx.repos.listHireOffers(ctx.db, { reservationId: r.id }).pop();
      if (offer) {
        facts['offer.expiresAt'] = textFact(dateTimeText(offer.expiresAt), `hire_offer:${offer.id}`);
        facts['offer.likeForLike'] = textFact(offer.terms.likeForLike, `hire_offer:${offer.id}`);
      } else if (r.ranking?.likeForLike.sentence) {
        facts['offer.likeForLike'] = textFact(r.ranking.likeForLike.sentence, src);
      }
      if (r.status === 'held' && r.holdExpiresAt && !facts['offer.expiresAt']) {
        facts['offer.expiresAt'] = textFact(dateTimeText(r.holdExpiresAt), src);
      }
    }
    const trig = offHireTrigger({ bundle, reservations: ctx.repos.listReservations(ctx.db, { claimId }) } as unknown as AutopilotFacts);
    if (trig) facts['hire.offHireDeadline'] = dateFact(offHireDeadline(trig.trigger, trig.at).dueAt, `event:${trig.trigger}`);
    const packs = ctx.repos.listDocumentPacks(ctx.db, { claimId }).filter((p) => p.status !== 'superseded' && p.status !== 'cancelled');
    const latest = packs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    if (latest) {
      const titles = latest.items.filter((i) => i.status !== 'not_needed' && i.purpose !== 'internal').map((i) => i.templateId.replace(/^[a-z]+\./, '').replace(/_/g, ' '));
      if (titles.length) facts['pack.documentList'] = textFact(titles.join('; '), `pack:${latest.id}`);
    }
  } catch (err) {
    ctx.logger.warn('autopilot: brief facts failed', { claimId, error: String(err) });
  }
  return { facts, ...(section ? { section } : {}) };
}
