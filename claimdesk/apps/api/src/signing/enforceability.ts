// owned by ap-paperwork
/**
 * Signed paperwork → hire enforceability (docs/SUPREME-AUTOPILOT.md §E.5): the HireAgreement fields the signed or sent
 * hire-start pack proves.
 *
 *   CCGUK-03 hirer copy (canonical agreement.credit_hire) signed           → signedAt, documentId
 *   CCGUK-03 + Sch 3 sent to the client (durable medium) or kiosk-handed    → enforceability.cancellationInfoProvidedAt
 *   form.cancellation_sch3 given (sent or kiosk)                           → enforceability.schedule3FormProvidedAt
 *   form.express_request_to_start signed                                   → expressRequestToStartAt, expressRequestEvidenceId
 *   the signed agreement's template is art 60F-compliant by its own terms  → cca60fCompliant = true (else the owner confirms)
 *
 * With a hire (by id, or the reservation's), the proven fields are written to it (only fields not set yet; the
 * owner's own entries are never overwritten) and the HIRE_ENFORCEABILITY_GAP flag is re-assessed.
 */
import { canonicalTemplateId, type HireAgreement, type Id, type ISODateTime } from '@ccguk/domain';
import type { Db } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { enforceabilityGaps } from '../services/hireCreate.js';

/**
 * Agreement templates whose own wording carries the RAO art 60F credit terms (≤ 12 payments within 12 months, no
 * interest or charges). The HTML credit hire agreement states them in its section 5. The CCGUK-03 Word template does
 * not carry that metadata, so a hire signed on it needs the owner's confirmation (PATCH …/hire/:hireId/paperwork).
 */
export const ART_60F_COMPLIANT_TEMPLATES: ReadonlySet<string> = new Set(['agreement.credit_hire']);

const later = (a?: string, b?: string): string | undefined => (!a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b);

export interface ProvenPaperwork {
  signedAt?: ISODateTime;
  documentId?: Id;
  enforceability?: Partial<HireAgreement['enforceability']>;
}

/** What the reservation's hire-start pack proves (pure read). */
export function provenFromPack(ctx: AppContext, tx: Db, reservationId: Id): ProvenPaperwork {
  const r = ctx.repos.getReservation(tx, reservationId);
  if (!r) return {};
  const packs = ctx.repos.listDocumentPacks(tx, { claimId: r.claimId, stage: 'hire_start', reservationId }).filter((p) => p.status !== 'superseded' && p.status !== 'cancelled');
  const pack = packs[0];
  if (!pack) return {};
  const kioskDone = ctx.repos
    .listKioskSessions(tx, { packId: pack.id })
    .map((s) => s.completedAt)
    .filter((x): x is string => Boolean(x))
    .sort()[0];
  const docs = pack.items.filter((i) => i.documentId && i.status !== 'not_needed').map((i) => ({ item: i, doc: ctx.repos.getDocument(tx, i.documentId!, { includeHtml: false }) }));
  const agreement = docs.find((d) => canonicalTemplateId(d.item.templateId) === 'agreement.credit_hire' && d.item.purpose === 'sign');
  const sch3 = docs.find((d) => d.item.templateId === 'form.cancellation_sch3');
  const express = docs.find((d) => d.item.templateId === 'form.express_request_to_start');
  const given = (d: (typeof docs)[number] | undefined): string | undefined => (d?.doc?.sentAt ? d.doc.sentAt : kioskDone);
  const out: ProvenPaperwork = {};
  const e: Partial<HireAgreement['enforceability']> = {};
  if (agreement?.doc?.status === 'signed' && agreement.doc.signature?.signedAt) {
    out.signedAt = agreement.doc.signature.signedAt;
    out.documentId = agreement.doc.id;
    if (ART_60F_COMPLIANT_TEMPLATES.has(agreement.doc.templateId)) e.cca60fCompliant = true;
  }
  const agreementGiven = given(agreement);
  const sch3Given = given(sch3);
  if (sch3Given) e.schedule3FormProvidedAt = sch3Given;
  if (agreementGiven && sch3Given) e.cancellationInfoProvidedAt = later(agreementGiven, sch3Given)!;
  if (express?.doc?.status === 'signed' && express.doc.signature?.signedAt) {
    e.expressRequestToStartAt = express.doc.signature.signedAt;
    if (express.doc.signature.evidenceId) e.expressRequestEvidenceId = express.doc.signature.evidenceId;
  }
  if (Object.keys(e).length) out.enforceability = e;
  return out;
}

/**
 * Called when a pack document is signed or sent, at handover, and from PATCH …/hire/:hireId/paperwork. Returns the
 * proven fields (Partial<HireAgreement>); when a hire exists they are written to it.
 */
export function syncEnforceabilityFromPack(ctx: AppContext, tx: Db, ref: { reservationId?: Id; hireId?: Id }): Partial<HireAgreement> {
  const hire = ref.hireId ? ctx.repos.getHire(tx, ref.hireId) : undefined;
  const reservationId = ref.reservationId ?? hire?.reservationId;
  if (!reservationId) return {};
  const proven = provenFromPack(ctx, tx, reservationId);
  const out: Partial<HireAgreement> = {};
  if (proven.signedAt) out.signedAt = proven.signedAt;
  if (proven.documentId) out.documentId = proven.documentId;
  if (proven.enforceability) out.enforceability = { cca60fCompliant: Boolean(proven.enforceability.cca60fCompliant), ...proven.enforceability };
  const target = hire ?? (() => {
    const r = ctx.repos.getReservation(tx, reservationId);
    return r?.hireAgreementId ? ctx.repos.getHire(tx, r.hireAgreementId) : undefined;
  })();
  if (target && Object.keys(out).length) writeProven(ctx, tx, target, out);
  return out;
}

/** Write the proven fields a hire does not have yet, re-assess the gap flag, audit. */
export function writeProven(ctx: AppContext, tx: Db, hire: HireAgreement, proven: Partial<HireAgreement>): HireAgreement {
  const patch: Partial<HireAgreement> = {};
  if (proven.signedAt && !hire.signedAt) patch.signedAt = proven.signedAt;
  if (proven.documentId && !hire.documentId) patch.documentId = proven.documentId;
  const e = proven.enforceability;
  if (e) {
    const cur = hire.enforceability;
    const next: Partial<HireAgreement['enforceability']> = {};
    if (e.cancellationInfoProvidedAt && !cur.cancellationInfoProvidedAt) next.cancellationInfoProvidedAt = e.cancellationInfoProvidedAt;
    if (e.schedule3FormProvidedAt && !cur.schedule3FormProvidedAt) next.schedule3FormProvidedAt = e.schedule3FormProvidedAt;
    if (e.expressRequestToStartAt && !cur.expressRequestToStartAt) next.expressRequestToStartAt = e.expressRequestToStartAt;
    if (e.expressRequestEvidenceId && !cur.expressRequestEvidenceId) next.expressRequestEvidenceId = e.expressRequestEvidenceId;
    if (e.cca60fCompliant && !cur.cca60fCompliant) next.cca60fCompliant = true;
    if (Object.keys(next).length) patch.enforceability = { ...cur, ...next };
  }
  if (!Object.keys(patch).length) return hire;
  const updated = ctx.repos.updateHire(tx, hire.id, patch);
  ctx.repos.appendAudit(tx, { actor: { userId: 'system' }, action: 'hire.paperwork.sync', entity: 'hire_agreements', entityId: hire.id, before: { signedAt: hire.signedAt ?? null, enforceability: hire.enforceability }, after: { signedAt: updated.signedAt ?? null, documentId: updated.documentId ?? null, enforceability: updated.enforceability }, at: ctx.now() });
  refreshGapFlag(ctx, tx, updated);
  return updated;
}

/** Clear the HIRE_ENFORCEABILITY_GAP flag for this hire once nothing is missing (system, audited). */
export function refreshGapFlag(ctx: AppContext, tx: Db, hire: HireAgreement): void {
  if (enforceabilityGaps(hire).length) return;
  const claim = ctx.repos.requireClaim(tx, hire.claimId);
  const open = claim.flags.filter((f) => f.code === 'HIRE_ENFORCEABILITY_GAP' && !f.clearedAt && f.message.includes(hire.agreementNumber));
  if (!open.length) return;
  try {
    ctx.repos.clearClaimFlag(tx, hire.claimId, 'HIRE_ENFORCEABILITY_GAP', { userId: 'system' }, `The signed hire paperwork now proves every enforceability point for ${hire.agreementNumber}`);
  } catch (err) {
    ctx.logger.warn('could not clear HIRE_ENFORCEABILITY_GAP', { hireId: hire.id, error: String(err) });
  }
}
