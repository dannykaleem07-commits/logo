// owned by ap-paperwork
/**
 * Signed-pack status for a reservation (docs/SUPREME-AUTOPILOT.md §B.9, §C.2 SIGNATURES_MISSING): is the hire-start pack
 * signed and provided, and what is missing. The handover refuses (through the override gate) until it is.
 */
import { activePackItems, type DocumentPack } from '@ccguk/domain';
import type { AppContext } from '../context.js';

/** The hire-start pack of a reservation: the newest one that is not superseded or cancelled. */
export function hireStartPackFor(ctx: AppContext, reservationId: string): DocumentPack | undefined {
  const r = ctx.repos.getReservation(ctx.db, reservationId);
  if (!r) return undefined;
  return ctx.repos.listDocumentPacks(ctx.db, { claimId: r.claimId, stage: 'hire_start', reservationId }).find((p) => p.status !== 'superseded' && p.status !== 'cancelled');
}

export function signedPackStatus(ctx: AppContext, reservationId: string): { signed: boolean; missing: string[] } {
  const pack = hireStartPackFor(ctx, reservationId);
  if (!pack) return { signed: false, missing: ['hire-start pack not prepared'] };
  const missing: string[] = [];
  for (const item of activePackItems(pack.items)) {
    if (item.purpose === 'internal' || item.purpose === 'send_insurer') continue;
    const doc = item.documentId ? ctx.repos.getDocument(ctx.db, item.documentId, { includeHtml: false }) : undefined;
    const title = doc?.title ?? item.templateId;
    if (item.purpose === 'sign') {
      if (doc?.status !== 'signed') missing.push(`${title} not signed`);
    } else if (item.status !== 'sent' && item.status !== 'signed' && !doc?.sentAt) {
      missing.push(`${title} not given to the hirer`);
    }
  }
  return { signed: missing.length === 0, missing };
}
