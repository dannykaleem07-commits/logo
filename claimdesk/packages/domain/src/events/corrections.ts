/**
 * Append-only event corrections (docs/V03-MANAGER-MODE-HIRE-PRICING.md §C.2). Events are never edited: a correcting
 * event carries `data.correctsEventId` naming the event it replaces, the way a ledger row carries `supersedesId`.
 * Every reader of a claim's events (clocks, documents, analytics) works from `liveEvents()`, which drops the corrected
 * ones; the chronology still shows them, struck through. Pure.
 */
import type { ClaimEvent, Id } from '../types.js';

/** `data.correctsEventId` on an event marks the event it replaces (append-only correction, like ledger supersedesId). */
export const CORRECTS_EVENT_KEY = 'correctsEventId';

/** The id of the event `e` corrects (a non-empty string `data.correctsEventId`), else undefined. */
export function correctedEventId(e: ClaimEvent): Id | undefined {
  const v = e.data?.[CORRECTS_EVENT_KEY];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Ids of every event some other event corrects. A chain A ← B ← C yields {A, B}. */
export function supersededEventIds(events: readonly ClaimEvent[]): Set<Id> {
  const out = new Set<Id>();
  for (const e of events) {
    const target = correctedEventId(e);
    if (target && target !== e.id) out.add(target);
  }
  return out;
}

/** Events with every corrected one removed (chains: A corrected by B corrected by C → only C). Order preserved. */
export function liveEvents<T extends ClaimEvent>(events: readonly T[]): T[] {
  const superseded = supersededEventIds(events);
  if (superseded.size === 0) return [...events];
  return events.filter((e) => !superseded.has(e.id));
}
