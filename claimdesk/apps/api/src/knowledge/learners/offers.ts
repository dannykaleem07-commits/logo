// owned by knowledge-learners
/**
 * Offers (docs/SUPREME-KNOWLEDGE-BUILDER.md §6.3, docs/SUPREME-AUTOPILOT.md §N). Every insurer offer becomes an
 * append-only `offer_observations` row — kind, head, amount, what we claimed for that head at the time, and the
 * owner's decision when known (a later decision is a new row). Code makes no decision and reads nothing back into
 * offers: `offer_record`, the registers and `needs_you` are only read.
 *
 * Sources:
 *   settlement_offers                 settlement offers (the register of AP §D.9; migration 0012) → kind 'settlement'
 *   intervention_offers               courtesy-car (intervention) offers ONLY → kind 'intervention', head 'hire',
 *                                     amount = the daily rate; decision = the client's decision
 *   needs_you(kind 'offer_decision')  only when the offer is in neither register (older cards)
 *   ledger 'offered'                  → kind 'settlement' (or 'pav' for the pav head)
 *   claim_events                      pav_offer_received → 'pav', part36_received → 'part36', reduction_received →
 *                                     'settlement' (a part payment offered in settlement of a head)
 */
import type { OfferObservationDecision, OfferObservationInput, OfferObservationKind } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { all, insurerSlugsByClaim, json } from './common.js';

const SETTLEMENT_DECISION: Record<string, OfferObservationDecision | null> = { open: null, accepted: 'accept', countered: 'counter', rejected: 'reject', lapsed: 'lapsed', superseded: null };
const CLIENT_DECISION: Record<string, OfferObservationDecision | null> = { pending: null, accepted: 'accept', declined: 'reject' };

interface LedgerRow {
  id: string;
  claim_id: string;
  head: string;
  kind: string;
  amount_pence: number;
  date: string;
  supersedes_id: string | null;
}

/** Effective ledger rows (a row superseded by another is dropped). */
export function effectiveLedger(rows: readonly LedgerRow[]): LedgerRow[] {
  const superseded = new Set(rows.map((r) => r.supersedes_id).filter((x): x is string => Boolean(x)));
  return rows.filter((r) => !superseded.has(r.id));
}

/** What we claimed for a head (or every head) on a date: `claimed`, else `invoiced`, effective rows up to that date. */
export function claimedAt(rows: readonly LedgerRow[], head: string | null, at: string): number | null {
  const day = at.slice(0, 10);
  const scoped = rows.filter((r) => (head === null || r.head === head) && r.date.slice(0, 10) <= day);
  const claimed = scoped.filter((r) => r.kind === 'claimed').reduce((s, r) => s + r.amount_pence, 0);
  const invoiced = scoped.filter((r) => r.kind === 'invoiced').reduce((s, r) => s + r.amount_pence, 0);
  const v = claimed || invoiced;
  return v > 0 ? v : null;
}

export interface ObserveOffersResult {
  inserted: number;
  bySource: Record<string, number>;
}

export function observeOffers(ctx: AppContext): ObserveOffersResult {
  const out: ObserveOffersResult = { inserted: 0, bySource: {} };
  const slugs = insurerSlugsByClaim(ctx);
  const now = ctx.now();
  const ledgerByClaim = new Map<string, LedgerRow[]>();
  for (const r of all<LedgerRow>(ctx, `SELECT id, claim_id, head, kind, amount_pence, date, supersedes_id FROM ledger_entries ORDER BY date, created_at, id`)) {
    ledgerByClaim.set(r.claim_id, [...(ledgerByClaim.get(r.claim_id) ?? []), r]);
  }
  const ledgerOf = (claimId: string): LedgerRow[] => effectiveLedger(ledgerByClaim.get(claimId) ?? []);
  const add = (o: Omit<OfferObservationInput, 'createdAt' | 'insurerSlug' | 'claimedPence'> & { claimedPence?: number | null }): void => {
    const { created } = ctx.repos.insertOfferObservation(ctx.db, {
      ...o,
      insurerSlug: slugs.get(o.claimId) ?? null,
      claimedPence: o.claimedPence !== undefined ? o.claimedPence : o.offerKind === 'intervention' ? null : claimedAt(ledgerOf(o.claimId), o.head, o.receivedAt),
      createdAt: now,
    });
    if (created) {
      out.inserted += 1;
      out.bySource[o.source] = (out.bySource[o.source] ?? 0) + 1;
    }
  };

  // Settlement register (AP §D.9).
  const registered = new Set<string>();
  for (const s of all<{ id: string; claim_id: string; head: string; amount_pence: number | null; received_at: string; status: string; decided_at: string | null }>(ctx, `SELECT id, claim_id, head, amount_pence, received_at, status, decided_at FROM settlement_offers ORDER BY received_at, id`)) {
    registered.add(s.id);
    const head = s.head === 'global' ? null : s.head;
    add({ claimId: s.claim_id, offerKind: s.head === 'pav' ? 'pav' : 'settlement', head, amountPence: s.amount_pence, receivedAt: s.received_at, source: 'settlement_register', sourceId: s.id, decision: null, decidedAt: null });
    const decision = SETTLEMENT_DECISION[s.status] ?? null;
    if (decision) add({ claimId: s.claim_id, offerKind: s.head === 'pav' ? 'pav' : 'settlement', head, amountPence: s.amount_pence, receivedAt: s.received_at, source: 'settlement_register', sourceId: s.id, decision, decidedAt: s.decided_at });
  }

  // Intervention register: courtesy-car offers only (AP §N).
  for (const i of all<{ id: string; claim_id: string; received_at: string; daily_rate_pence: number | null; client_decision: string; client_decision_at: string | null }>(ctx, `SELECT id, claim_id, received_at, daily_rate_pence, client_decision, client_decision_at FROM intervention_offers ORDER BY received_at, id`)) {
    registered.add(i.id);
    add({ claimId: i.claim_id, offerKind: 'intervention', head: 'hire', amountPence: i.daily_rate_pence, receivedAt: i.received_at, source: 'intervention_register', sourceId: i.id, decision: null, decidedAt: null, claimedPence: null });
    const decision = CLIENT_DECISION[i.client_decision] ?? null;
    if (decision) add({ claimId: i.claim_id, offerKind: 'intervention', head: 'hire', amountPence: i.daily_rate_pence, receivedAt: i.received_at, source: 'intervention_register', sourceId: i.id, decision, decidedAt: i.client_decision_at, claimedPence: null });
  }

  // Older offer_decision cards whose offer is in neither register.
  for (const n of all<{ id: string; claim_id: string | null; payload: string; created_at: string }>(ctx, `SELECT id, claim_id, payload, created_at FROM needs_you WHERE kind = 'offer_decision' ORDER BY created_at, id`)) {
    const p = json<{ offerId?: string; register?: string; head?: string | null; amountPence?: number | null; receivedAt?: string; from?: string }>(n.payload) ?? {};
    if (!n.claim_id || (p.offerId && registered.has(p.offerId))) continue;
    const kind: OfferObservationKind = p.register === 'intervention' ? 'intervention' : p.head === 'pav' ? 'pav' : 'settlement';
    add({ claimId: n.claim_id, offerKind: kind, head: kind === 'intervention' ? 'hire' : p.head ?? null, amountPence: typeof p.amountPence === 'number' ? p.amountPence : null, receivedAt: p.receivedAt ?? n.created_at, source: 'needs_you', sourceId: n.id, decision: null, decidedAt: null });
  }

  // Ledger 'offered'.
  for (const [claimId] of ledgerByClaim) {
    for (const r of ledgerOf(claimId).filter((x) => x.kind === 'offered')) {
      add({ claimId, offerKind: r.head === 'pav' ? 'pav' : 'settlement', head: r.head, amountPence: r.amount_pence, receivedAt: r.date.length === 10 ? `${r.date}T12:00:00.000Z` : r.date, source: 'ledger', sourceId: r.id, decision: null, decidedAt: null });
    }
  }

  // Events.
  const EVENT_KIND: Record<string, OfferObservationKind> = { pav_offer_received: 'pav', part36_received: 'part36', reduction_received: 'settlement' };
  for (const e of all<{ id: string; claim_id: string; type: string; at: string; data: string | null }>(ctx, `SELECT id, claim_id, type, at, data FROM claim_events WHERE type IN ('pav_offer_received','part36_received','reduction_received') ORDER BY at, id`)) {
    const d = json<Record<string, unknown>>(e.data) ?? {};
    const amount = [d.amountPence, d.offerPence, d.amount_pence].find((x) => typeof x === 'number') as number | undefined;
    const head = typeof d.head === 'string' ? d.head : e.type === 'pav_offer_received' ? 'pav' : null;
    add({ claimId: e.claim_id, offerKind: EVENT_KIND[e.type]!, head, amountPence: amount ?? null, receivedAt: e.at, source: 'event', sourceId: e.id, decision: null, decidedAt: null });
  }
  return out;
}
