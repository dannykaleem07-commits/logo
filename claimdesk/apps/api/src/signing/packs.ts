// owned by ap-paperwork
/**
 * Stage packs in the API (docs/SUPREME-AUTOPILOT.md §D.5, §D.6, §E.4):
 *
 *   preparePack           create (or continue) the pack for a claim and stage: each item is generated from the claim's
 *                         records as a draft — Word templates through the DOCX generator (values from the claim's value
 *                         resolver, never typed by a model), HTML templates with data built by code — and SD's
 *                         `review.check` is queued for each. Items whose data is missing are reported (Needs-you
 *                         `question`), never invented.
 *   onPackDocumentReviewed  the reviewer's hook (casework `document.after_review`): a pack member is reviewed with its
 *                         pack; when every item has a review the pack is `awaiting_approval` and Needs-you `approve_pack`
 *                         is raised. Pack members never get one approve_document card each.
 *   approvePack           the owner approves every document (human — agreements/forms/invoices are always-ask) and,
 *                         with `send`, emails the pack: to the client with the `letter.signature_request` cover (one
 *                         `signature_requests` row per document to sign, chased by `signing.chase`), to the at-fault
 *                         insurer for insurer items. Owner-approved sends go out after the 30-second Undo.
 */
import type { Actor } from '@ccguk/db';
import {
  activePackItems,
  derivePackStatus,
  isDocxTemplateId,
  nextChaseAt,
  PACK_STAGE_LABELS,
  PACK_STAGE_STEP,
  packItemKey,
  packSendGroups,
  resolvePackItems,
  type ClaimBundle,
  type DocumentPack,
  type GeneratedDocument,
  type Id,
  type PackStage,
} from '@ccguk/domain';
import { DocumentDataError } from '@ccguk/documents';
import type { AppContext } from '../context.js';
import { conflict, HttpError } from '../errors.js';
import { createNeedsYou, enqueueJob } from '../agent/core.js';
import { nudgeAutopilot } from '../autopilot/nudge.js';
import { eligibilityFor } from '../eligibility/service.js';
import { loadBundle } from '../services/claimView.js';
import { chronology, hireBlock, headSummaries } from '../services/documentData.js';
import { approveDocument, clearDocumentFlag, createClaimDocument } from '../services/documents.js';
import { createDocxClaimDocument } from '../services/docxDocuments.js';
import { assertHuman } from '../services/humanOnly.js';
import { ownerCompose } from '../mail/outbox.js';
import { audit, AUTOPILOT_USER_ID, docUserFor, packDocuments, packSigner, salutationOf, signingSettings } from './common.js';
import { syncEnforceabilityFromPack } from './enforceability.js';

const OPEN_PACK = (p: DocumentPack): boolean => p.status !== 'superseded' && p.status !== 'cancelled';
const DAY_MS = 86_400_000;
const dateOnly = (iso: string): string => iso.slice(0, 10);

/** The open pack of a claim for a stage (and reservation, when the stage is about one). */
export function openPackFor(ctx: AppContext, claimId: Id, stage: PackStage, reservationId?: Id): DocumentPack | undefined {
  return ctx.repos.listDocumentPacks(ctx.db, { claimId, stage }).find((p) => OPEN_PACK(p) && (reservationId === undefined || p.reservationId === reservationId));
}

// ---------------------------------------------------------------------------
// Predicates (§D.6 `when`) — evaluated over the claim's records until the Autopilot catalogue (ap-autopilot) owns them
// ---------------------------------------------------------------------------

export function packPredicates(ctx: AppContext, bundle: ClaimBundle): (id: string) => boolean | undefined {
  const has = (type: string) => bundle.events.some((e) => e.type === type);
  const ledgerHas = (head: string) => bundle.ledger.some((e) => e.head === head && (e.kind === 'claimed' || e.kind === 'invoiced'));
  return (id) => {
    switch (id) {
      case 'vehicle.recovery_storage_or_engineer_needed':
        return bundle.recovery.length > 0 || bundle.storage.length > 0 || bundle.claim.accident.roadworthyAfter === false || has('engineer_instructed') || Boolean(bundle.report);
      case 'means.impecuniosity_relied_on':
        try {
          return eligibilityFor(ctx, bundle.claim.id, bundle).means.basis === 'impecunious';
        } catch {
          return undefined;
        }
      case 'storage.claimed':
        return bundle.storage.length > 0 || ledgerHas('storage');
      case 'recovery.claimed':
        return bundle.recovery.length > 0 || ledgerHas('recovery');
      case 'engineer.instructed':
        return has('engineer_instructed') || Boolean(bundle.report) || ledgerHas('engineer_fee');
      default:
        return undefined;
    }
  };
}

// ---------------------------------------------------------------------------
// Code-built data for the HTML templates the pack prints (no model ever writes these)
// ---------------------------------------------------------------------------

const USE_TEXT: Record<string, string> = {
  credit_hire: 'Social, domestic and pleasure, and commuting',
  self_drive: 'Social, domestic and pleasure, and commuting',
  pco: 'Private hire (licensed PCO work) as permitted by the policy',
};

function vehicleOfUnit(ctx: AppContext, fleetUnitId: Id): { makeModel: string; registration: string } | undefined {
  const unit = ctx.repos.getFleetUnit(ctx.db, fleetUnitId);
  const v = unit ? ctx.repos.getVehicle(ctx.db, unit.vehicleId) : undefined;
  if (!v) return undefined;
  return { makeModel: [v.make, v.model, v.variant].filter(Boolean).join(' ') || v.registration, registration: v.registration };
}

function addressShort(a: { line1?: string; postcode?: string } | null | undefined): string {
  return [a?.line1, a?.postcode].filter((x) => x && x.trim()).join(', ') || 'the address we agreed';
}

/** Extra data for an HTML pack item; undefined = the template's own builder supplies everything. */
export function packItemExtra(ctx: AppContext, bundle: ClaimBundle, pack: DocumentPack, templateId: string): Record<string, unknown> | undefined {
  const reservation = pack.reservationId ? ctx.repos.getReservation(ctx.db, pack.reservationId) : undefined;
  const signer = packSigner(ctx, pack);
  const now = ctx.now();
  switch (templateId) {
    case 'form.hire_cover_confirmation': {
      if (!reservation) return {};
      const unit = ctx.repos.getFleetUnit(ctx.db, reservation.fleetUnitId);
      const policy = unit?.policyId ? ctx.repos.getPolicy(ctx.db, unit.policyId) : undefined;
      const drivers = [reservation.hirerPartyId, ...reservation.driverPartyIds.filter((d) => d !== reservation.hirerPartyId)].map((id) => ctx.repos.getParty(ctx.db, id)?.name).filter((x): x is string => Boolean(x));
      return {
        hirer: { name: signer.name, addressLines: addressLinesOf(signer), ...(signer.email ? { email: signer.email } : {}) },
        cover: {
          insurerName: policy?.insurerName,
          policyNumber: policy?.policyNumber,
          permittedDrivers: drivers,
          use: USE_TEXT[reservation.use] ?? USE_TEXT.credit_hire,
          periodStart: dateOnly(reservation.startAt),
          ...(policy?.endDate ? { policyEndsOn: policy.endDate } : {}),
          vehicle: vehicleOfUnit(ctx, reservation.fleetUnitId),
          certificateAttached: Boolean(policy?.evidenceId),
        },
      };
    }
    case 'form.hire_period_validation': {
      const hire = hireBlock(ctx, bundle, now);
      const h = bundle.hire.find((x) => x.id === hire?.agreementId);
      const vehicle = h ? vehicleOfUnit(ctx, h.fleetUnitId) : undefined;
      return {
        hirePeriod: hire ? { agreementNumber: hire.agreementNumber, startAt: dateOnly(hire.startAt), endAt: dateOnly(hire.endAt), days: hire.days, vehicle, vehicleGroup: hire.gtaGroup } : undefined,
        milestones: chronology(bundle)
          .filter((e) => ['accident', 'hire_started', 'hire_ended', 'engineer_instructed', 'inspection', 'repair_authorised', 'repair_started', 'repair_completed', 'total_loss_declared', 'tl_payment_received', 'hire_vehicle_collected', 'ncaf_sent'].includes(String(e.type)))
          .map((e) => ({ date: dateOnly(e.date), description: e.description, ...(e.attributableTo ? { attributableTo: e.attributableTo } : {}) })),
        hirer: { name: signer.name },
      };
    }
    case 'letter.booking_confirmation': {
      if (!reservation) return {};
      const movement = ctx.repos.listMovements(ctx.db, { reservationId: reservation.id }).filter((m) => m.status !== 'cancelled' && m.status !== 'failed' && (pack.stage === 'off_hire' ? m.kind === 'collection' : m.kind === 'delivery'))[0];
      const v = vehicleOfUnit(ctx, reservation.fleetUnitId);
      return {
        salutationName: salutationOf(signer),
        booking: {
          makeModel: v?.makeModel,
          registration: v?.registration,
          ...(reservation.agreementNumber ? { agreementNumber: reservation.agreementNumber } : {}),
          startAt: dateOnly(reservation.startAt),
          ...(movement ? { movement: { kind: movement.kind === 'collection' ? 'collection' : 'delivery', windowStart: movement.windowStart, windowEnd: movement.windowEnd, addressShort: addressShort(movement.address) } } : {}),
        },
      };
    }
    case 'letter.closure': {
      const heads = headSummaries(bundle);
      const claimed = heads.reduce((t, h) => t + h.claimedPence, 0);
      const received = heads.reduce((t, h) => t + h.receivedPence, 0);
      return {
        salutationName: salutationOf(signer),
        outcome: received >= claimed && claimed > 0 ? 'The claim has been paid and your file is now complete.' : 'Your claim has come to an end and your file is now complete.',
        closedOn: dateOnly(now),
        ...(claimed > 0
          ? {
              figures: [
                { label: 'Claimed', valuePence: claimed },
                { label: 'Received', valuePence: received },
                { label: 'Outstanding', valuePence: Math.max(0, claimed - received), emphasis: true },
              ],
            }
          : {}),
      };
    }
    case 'form.cancellation_sch3':
    case 'form.express_request_to_start':
      // Before the handover there is no hire yet: the builders take the booking's facts (signing/reservationData.ts).
      return pack.reservationId ? { reservationId: pack.reservationId } : undefined;
    default:
      return undefined;
  }
}

function addressLinesOf(p: { address?: { line1?: string; line2?: string; town?: string; county?: string; postcode?: string } }): string[] {
  const a = p.address;
  const lines = [a?.line1, a?.line2, a?.town, a?.county, a?.postcode].filter((x): x is string => Boolean(x && x.trim()));
  return lines.length ? lines : ['Address to be confirmed'];
}

/**
 * System reconciliation of flags on code-built pack data (audited, reason given; a person's flags are never touched):
 *  - UNKNOWN_REFERENCE on a date-time built by code: it prints formatted, so the "unused extra text" check cannot find
 *    it verbatim;
 *  - HIRE_PERIOD_MISMATCH "no hire agreement" on the confirmed booking's own start date: before the handover the hire
 *    record does not exist yet — the planned start comes from the booking (it is created from it at handover).
 */
function reconcilePackFlags(ctx: AppContext, doc: GeneratedDocument, reservation?: { startAt: string; agreementNumber?: string }): void {
  const bookedDays = reservation ? new Set([reservation.startAt.slice(0, 10), londonDay(reservation.startAt)]) : undefined;
  const open = (doc.consistency?.flags ?? []).filter((f) => !f.clearedAt);
  const dateFlags = open.filter((f) => f.code === 'UNKNOWN_REFERENCE' && /^\d{4}-\d{2}-\d{2}T/.test(f.draftValue ?? ''));
  for (let i = dateFlags.length - 1; i >= 0; i -= 1) {
    try {
      clearDocumentFlag(ctx, doc.id, { code: 'UNKNOWN_REFERENCE', index: open.filter((f) => f.code === 'UNKNOWN_REFERENCE').indexOf(dateFlags[i]!), reason: 'System: a date-time built by code from the booking record; it prints formatted' }, { userId: 'system' });
    } catch {
      /* already cleared */
    }
  }
  if (!bookedDays) return;
  for (const f of open.filter((x) => x.code === 'HIRE_PERIOD_MISMATCH' && x.ledgerValue === 'no hire agreement' && bookedDays.has(String(x.draftValue ?? '')))) {
    try {
      clearDocumentFlag(ctx, doc.id, { code: 'HIRE_PERIOD_MISMATCH', ...(f.excerpt !== undefined ? { excerpt: f.excerpt } : {}), reason: `System: the planned hire start of the confirmed booking${reservation?.agreementNumber ? ` ${reservation.agreementNumber}` : ''}; the hire record is created from it at the handover` }, { userId: 'system' });
    } catch {
      /* already cleared */
    }
  }
}

function londonDay(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

export interface PrepareFailure {
  templateId: string;
  variant?: string;
  code: string;
  message: string;
}

export interface PreparePackResult {
  pack: DocumentPack;
  created: Array<{ templateId: string; variant?: string; documentId: Id; reviewJobId?: string }>;
  failed: PrepareFailure[];
  reused: boolean;
}

export interface PreparePackInput {
  claimId: Id;
  stage: PackStage;
  reservationId?: Id;
  /** Supersede the open pack of this stage and start again (e.g. after the booking changed). */
  restart?: boolean;
  actor: Actor;
  parentJobId?: string;
  correlationId?: string;
}

function failureOf(err: unknown): { code: string; message: string } {
  if (err instanceof DocumentDataError) return { code: 'TEMPLATE_DATA_MISSING', message: `Missing: ${err.missing.join(', ')}` };
  if (err instanceof HttpError) {
    const issues = (err.details as { issues?: Array<{ message?: string }> } | undefined)?.issues;
    return { code: err.code, message: issues?.length ? `${err.message}` : err.message };
  }
  return { code: 'FAILED', message: err instanceof Error ? err.message : String(err) };
}

export async function preparePack(ctx: AppContext, input: PreparePackInput): Promise<PreparePackResult> {
  const claim = ctx.repos.requireClaim(ctx.db, input.claimId);
  if (input.reservationId) {
    const r = ctx.repos.requireReservation(ctx.db, input.reservationId);
    if (r.claimId !== claim.id) throw conflict('WRONG_CLAIM', 'That booking belongs to another claim');
  }
  let pack = openPackFor(ctx, claim.id, input.stage, input.reservationId);
  if (pack && input.restart) {
    ctx.repos.updateDocumentPack(ctx.db, pack.id, { status: 'superseded' }, ctx.now());
    audit(ctx, input.actor, 'pack.supersede', 'document_packs', pack.id, { claimId: claim.id, stage: input.stage });
    pack = undefined;
  }
  const bundle = loadBundle(ctx, claim.id, true);
  let reused = true;
  if (!pack) {
    reused = false;
    const items = resolvePackItems(input.stage, packPredicates(ctx, bundle));
    pack = ctx.repos.createDocumentPack(ctx.db, { claimId: claim.id, stage: input.stage, ...(input.reservationId ? { reservationId: input.reservationId } : {}), items, createdBy: input.actor.userId, at: ctx.now() });
    audit(ctx, input.actor, 'pack.create', 'document_packs', pack.id, { claimId: claim.id, stage: input.stage, reservationId: input.reservationId ?? null, items: items.map((i) => ({ key: packItemKey(i), status: i.status })) });
  }
  const created: PreparePackResult['created'] = [];
  const failed: PrepareFailure[] = [];
  if (pack.status !== 'preparing') return { pack, created, failed, reused };

  const user = docUserFor(ctx, input.actor);
  const items = [...pack.items];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    if (item.status !== 'pending' || item.documentId) continue;
    try {
      let doc: GeneratedDocument;
      if (isDocxTemplateId(item.templateId)) {
        const hire = pack.reservationId ? bundle.hire.find((h) => h.reservationId === pack!.reservationId) : undefined;
        doc = await createDocxClaimDocument(ctx, {
          claimId: claim.id,
          body: { templateId: item.templateId, ...(item.variant ? { variant: item.variant } : {}), ...(hire ? { subject: { hireAgreementId: hire.id } } : {}) },
          user,
          actor: input.actor,
        });
      } else {
        const extra = packItemExtra(ctx, bundle, pack, item.templateId);
        doc = createClaimDocument(ctx, { claimId: claim.id, templateId: item.templateId, ...(extra ? { extra } : {}), user, actor: input.actor });
        const reservation = pack.reservationId ? ctx.repos.getReservation(ctx.db, pack.reservationId) : undefined;
        reconcilePackFlags(ctx, doc, reservation && !bundle.hire.some((h) => h.reservationId === reservation.id) ? reservation : undefined);
        doc = ctx.repos.requireDocument(ctx.db, doc.id, { includeHtml: false });
      }
      const kind = doc.format === 'docx' ? 'docx' : 'document';
      const review = enqueueJob(ctx, {
        type: 'review.check',
        payload: { targetKind: kind, targetId: doc.id, claimId: claim.id, loop: 0 },
        claimId: claim.id,
        idempotencyKey: `review.check:${kind}:${doc.id}:0`,
        createdBy: input.actor.userId,
        ...(input.parentJobId ? { parentJobId: input.parentJobId } : {}),
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      });
      items[i] = { ...item, documentId: doc.id, status: 'drafted' };
      created.push({ templateId: item.templateId, ...(item.variant ? { variant: item.variant } : {}), documentId: doc.id, reviewJobId: review.id });
    } catch (err) {
      failed.push({ templateId: item.templateId, ...(item.variant ? { variant: item.variant } : {}), ...failureOf(err) });
    }
  }
  const status = failed.length ? 'preparing' : derivePackStatus('preparing', items);
  pack = ctx.repos.updateDocumentPack(ctx.db, pack.id, { items, status }, ctx.now());
  audit(ctx, input.actor, 'pack.prepare', 'document_packs', pack.id, { claimId: claim.id, stage: input.stage, created: created.map((c) => c.documentId), failed });
  if (failed.length) {
    createNeedsYou(ctx, {
      kind: 'question',
      claimId: claim.id,
      title: `${PACK_STAGE_LABELS[input.stage]} on ${claim.reference}: some paperwork could not be prepared`,
      summary: `These documents need details that are not on the file yet: ${failed.map((f) => `${f.templateId}${f.variant ? ` (${f.variant})` : ''} — ${f.message}`).join('; ')}`.slice(0, 2000),
      options: [{ id: 'ok', label: 'I will add the details', tone: 'primary' }],
      payload: { packId: pack.id, stage: input.stage, failed, stepId: PACK_STAGE_STEP[input.stage] },
      priority: input.stage === 'hire_start' ? 'high' : 'normal',
      createdBy: input.actor.userId,
      dedupeKey: `pack_missing:${pack.id}`,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    });
  }
  if (activePackItems(pack.items).length === 0) raiseApprovePack(ctx, pack);
  return { pack, created, failed, reused };
}

// ---------------------------------------------------------------------------
// Review hook and the approve_pack card
// ---------------------------------------------------------------------------

/**
 * Called by casework `document.after_review` before it decides anything for a document. Returns true when the document
 * belongs to an open pack (the pack is then updated and, when complete, raises `approve_pack`); the caller then stops.
 */
export function onPackDocumentReviewed(ctx: AppContext, doc: Pick<GeneratedDocument, 'id' | 'claimId'>, review: { id: string; verdict: string }): boolean {
  if (!doc.claimId) return false;
  const packs = ctx.repos.listDocumentPacksWithDocument(ctx.db, doc.claimId, doc.id).filter(OPEN_PACK);
  if (!packs.length) return false;
  for (const p of packs) {
    const items = p.items.map((i) => (i.documentId === doc.id && (i.status === 'pending' || i.status === 'drafted') ? { ...i, status: 'reviewed' as const, reviewId: review.id } : i));
    const status = derivePackStatus(p.status, items);
    const next = ctx.repos.updateDocumentPack(ctx.db, p.id, { items, status }, ctx.now());
    audit(ctx, { userId: 'agent:reviewer' }, 'pack.item_reviewed', 'document_packs', p.id, { documentId: doc.id, reviewId: review.id, verdict: review.verdict, packStatus: status });
    if (next.status === 'awaiting_approval') raiseApprovePack(ctx, next);
  }
  return true;
}

export interface PackItemView {
  key: string;
  templateId: string;
  variant?: string;
  purpose: DocumentPack['items'][number]['purpose'];
  signer?: string;
  status: DocumentPack['items'][number]['status'];
  documentId?: Id;
  title?: string;
  documentStatus?: string;
  format?: string;
  reviewId?: Id;
  verdict?: string;
  issues?: Array<{ code?: string; severity?: string; message?: string }>;
  signedAt?: string;
  sentAt?: string;
}

export interface PackView extends DocumentPack {
  label: string;
  stepId: string;
  signer: { partyId: Id; name: string; email?: string };
  view: PackItemView[];
  sendTo: Array<{ target: 'client' | 'at_fault_insurer'; address?: string; documents: number }>;
  signatureRequests: ReturnType<AppContext['repos']['listSignatureRequests']>;
}

export function packView(ctx: AppContext, pack: DocumentPack): PackView {
  const signer = packSigner(ctx, pack);
  const claim = ctx.repos.requireClaim(ctx.db, pack.claimId);
  const insurer = claim.atFaultInsurerId ? ctx.repos.getParty(ctx.db, claim.atFaultInsurerId) : undefined;
  const view: PackItemView[] = pack.items.map((i) => {
    const d = i.documentId ? ctx.repos.getDocument(ctx.db, i.documentId, { includeHtml: false }) : undefined;
    const r = i.reviewId ? ctx.repos.getReview(ctx.db, i.reviewId) : undefined;
    const issues = r ? [r.rules, r.facts, r.critic].flatMap((x) => ((x as { issues?: unknown } | undefined)?.issues as PackItemView['issues']) ?? []).slice(0, 10) : undefined;
    return {
      key: packItemKey(i),
      templateId: i.templateId,
      ...(i.variant ? { variant: i.variant } : {}),
      purpose: i.purpose,
      ...(i.signer ? { signer: i.signer } : {}),
      status: i.status,
      ...(i.documentId ? { documentId: i.documentId } : {}),
      ...(d ? { title: d.title, documentStatus: d.status, format: d.format ?? 'html' } : {}),
      ...(i.reviewId ? { reviewId: i.reviewId } : {}),
      ...(r ? { verdict: r.verdict } : {}),
      ...(issues?.length ? { issues } : {}),
      ...(d?.signature?.signedAt ? { signedAt: d.signature.signedAt } : {}),
      ...(d?.sentAt ? { sentAt: d.sentAt } : {}),
    };
  });
  const sendTo = packSendGroups(pack.items).map((g) => ({ target: g.target, ...(g.target === 'client' ? (signer.email ? { address: signer.email } : {}) : insurer?.email ? { address: insurer.email } : {}), documents: g.items.length }));
  return {
    ...pack,
    label: PACK_STAGE_LABELS[pack.stage],
    stepId: PACK_STAGE_STEP[pack.stage],
    signer: { partyId: signer.id, name: signer.name, ...(signer.email ? { email: signer.email } : {}) },
    view,
    sendTo,
    signatureRequests: ctx.repos.listSignatureRequests(ctx.db, { packId: pack.id }),
  };
}

/** Needs-you approve_pack (§H.3): every document with its reviewer verdict, the signer and who it goes to. */
export function raiseApprovePack(ctx: AppContext, pack: DocumentPack): void {
  const claim = ctx.repos.requireClaim(ctx.db, pack.claimId);
  const v = packView(ctx, pack);
  const docs = v.view.filter((i) => i.status !== 'not_needed');
  const notPass = docs.filter((d) => d.verdict && d.verdict !== 'pass');
  const money = pack.stage === 'billing' || pack.stage === 'payment';
  createNeedsYou(ctx, {
    kind: 'approve_pack',
    claimId: pack.claimId,
    title: `Approve the ${v.label.toLowerCase()} for ${claim.reference}`,
    summary: `${docs.length} document${docs.length === 1 ? '' : 's'} prepared and reviewed${notPass.length ? ` (${notPass.length} with reviewer notes)` : ''}. Signer: ${v.signer.name}.${v.sendTo.length ? ` Goes to: ${v.sendTo.map((s) => `${s.target === 'client' ? 'the client' : 'the at-fault insurer'}${s.address ? ` (${s.address})` : ''}`).join(' and ')}.` : ''}`,
    recommendation: {
      action: notPass.length ? 'Check the documents with reviewer notes, then approve' : v.sendTo.some((s) => s.target === 'client') ? 'Approve and send to the client' : 'Approve',
      why: notPass.length ? 'The reviewer raised points on some documents.' : 'Every document was generated from the file and passed the reviewer.',
      confidence: notPass.length ? 0.5 : 0.9,
      basis: [{ kind: 'rule', id: `pack:${pack.stage}`, label: `${v.label} (SUPREME-AUTOPILOT §D.6)` }],
    },
    options: [
      { id: 'approve_send', label: 'Approve and send', tone: 'primary' },
      { id: 'approve_only', label: 'Approve only (sign in person)', tone: 'neutral' },
      { id: 'edit', label: 'Edit a document', tone: 'neutral' },
      { id: 'reject', label: 'Reject', tone: 'danger', requiresReason: true },
    ],
    payload: { packId: pack.id, stage: pack.stage, stepId: v.stepId, items: docs, signer: v.signer, sendTo: v.sendTo, money },
    priority: pack.stage === 'hire_start' ? 'high' : 'normal',
    createdBy: AUTOPILOT_USER_ID,
    dedupeKey: `approve_pack:${pack.id}`,
  });
}

/** Close the open approve_pack card of a pack (when the pack was approved or rejected elsewhere). */
function closeApprovePackCard(ctx: AppContext, packId: Id, actor: Actor, optionId: string): void {
  const item = ctx.repos.findOpenNeedsYouByDedupeKey(ctx.db, `approve_pack:${packId}`);
  if (!item || item.status !== 'open') return;
  try {
    ctx.repos.resolveNeedsYou(ctx.db, item.id, { actor: actor.userId, optionId, note: 'Done from the pack', now: ctx.now() });
  } catch {
    /* resolved meanwhile */
  }
}

// ---------------------------------------------------------------------------
// Approve, send, reject
// ---------------------------------------------------------------------------

export interface ApprovePackResult {
  pack: DocumentPack;
  approved: Id[];
  sent?: SendPackResult;
}

export async function approvePack(ctx: AppContext, packId: Id, actor: Actor, opts: { send: boolean; note?: string; fromNeedsYou?: boolean }): Promise<ApprovePackResult> {
  assertHuman(actor, 'approve paperwork');
  let pack = ctx.repos.requireDocumentPack(ctx.db, packId);
  if (!OPEN_PACK(pack)) throw conflict('PACK_STATE', `This pack is ${pack.status}`);
  const active = activePackItems(pack.items);
  const missing = active.filter((i) => !i.documentId);
  if (missing.length) throw conflict('PACK_INCOMPLETE', `Some documents are not prepared yet: ${missing.map((m) => m.templateId).join(', ')}`);
  const approved: Id[] = [];
  const items = [...pack.items];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    if (item.status === 'not_needed' || !item.documentId) continue;
    const doc = ctx.repos.requireDocument(ctx.db, item.documentId, { includeHtml: false });
    if (doc.status === 'draft' || doc.status === 'blocked') {
      await approveDocument(ctx, doc.id, actor, opts.note ?? `Approved with the ${PACK_STAGE_LABELS[pack.stage].toLowerCase()}`);
      approved.push(doc.id);
    } else if (doc.status === 'void' || doc.status === 'superseded') throw conflict('DOCUMENT_STATE', `${doc.title} is ${doc.status}; prepare the pack again`);
    if (item.status === 'pending' || item.status === 'drafted' || item.status === 'reviewed') items[i] = { ...item, status: 'approved' };
  }
  const now = ctx.now();
  pack = ctx.repos.updateDocumentPack(ctx.db, pack.id, { items, status: derivePackStatus(pack.status, items), approvedBy: actor.userId, approvedAt: now }, now);
  audit(ctx, actor, 'pack.approve', 'document_packs', pack.id, { claimId: pack.claimId, stage: pack.stage, approved, send: opts.send, note: opts.note ?? null });
  if (!opts.fromNeedsYou) closeApprovePackCard(ctx, pack.id, actor, opts.send ? 'approve_send' : 'approve_only');
  let sent: SendPackResult | undefined;
  if (opts.send) sent = await sendPackForSignature(ctx, pack.id, actor);
  nudgeAutopilot(ctx, pack.claimId, `${PACK_STAGE_LABELS[pack.stage]} approved`);
  return { pack: sent?.pack ?? pack, approved, ...(sent ? { sent } : {}) };
}

export interface SendPackResult {
  pack: DocumentPack;
  outboxIds: Id[];
  coverDocumentId?: Id;
  signatureRequestIds: Id[];
}

function bodyFor(stage: PackStage, target: 'client' | 'at_fault_insurer', signerName: string, titles: string[], returnBy?: string): string {
  if (target === 'at_fault_insurer') {
    return [
      'Dear Sirs,',
      '',
      `Please find attached our ${PACK_STAGE_LABELS[stage].toLowerCase()}:`,
      ...titles.map((t) => `- ${t}`),
      '',
      'Please quote both references on any reply.',
      '',
      'Yours faithfully,',
    ].join('\n');
  }
  return [
    `Dear ${signerName},`,
    '',
    'Please find attached the documents for your claim, with a covering letter that explains what to do.',
    ...titles.map((t) => `- ${t}`),
    '',
    returnBy ? `Please sign and return the documents marked for signature by ${returnBy}. You can scan or photograph the signed pages and reply to this email.` : 'Please keep these documents for your records.',
    '',
    'If you would prefer to sign at our office, reply to this email and we will arrange it.',
    '',
    'Kind regards,',
  ].join('\n');
}

export async function sendPackForSignature(ctx: AppContext, packId: Id, actor: Actor): Promise<SendPackResult> {
  assertHuman(actor, 'send paperwork');
  let pack = ctx.repos.requireDocumentPack(ctx.db, packId);
  if (pack.status !== 'approved' && pack.status !== 'signed') throw conflict('PACK_STATE', pack.status === 'sent' ? 'This pack has already been sent' : `Approve the pack before sending it (status is ${pack.status})`);
  const claim = ctx.repos.requireClaim(ctx.db, pack.claimId);
  const signer = packSigner(ctx, pack);
  const groups = packSendGroups(pack.items);
  if (!groups.length) throw conflict('NOTHING_TO_SEND', 'This pack has no documents for the client or the insurer');
  const user = docUserFor(ctx, actor);
  const now = ctx.now();
  const settings = signingSettings(ctx);
  const outboxIds: Id[] = [];
  const signatureRequestIds: Id[] = [];
  let coverDocumentId: Id | undefined;
  const docOf = (id: Id) => ctx.repos.requireDocument(ctx.db, id, { includeHtml: false });
  for (const g of groups) {
    const docs = g.items.filter((i) => i.documentId && i.status !== 'signed').map((i) => ({ item: i, doc: docOf(i.documentId!) }));
    if (!docs.length) continue;
    if (g.target === 'client') {
      if (!signer.email) throw conflict('NO_EMAIL', `No email address is on file for ${signer.name}: add one, or sign in person at the kiosk`);
      const toSign = docs.filter((d) => d.item.purpose === 'sign');
      const returnBy = toSign.length ? dateOnly(new Date(Date.parse(now) + 7 * DAY_MS).toISOString()) : undefined;
      const cover = createClaimDocument(ctx, {
        claimId: claim.id,
        templateId: 'letter.signature_request',
        extra: { salutationName: salutationOf(signer), documents: docs.map((d) => ({ title: d.doc.title, purpose: d.item.purpose === 'sign' ? 'sign' : 'give' })), returnBy: returnBy ?? dateOnly(now) },
        recipientPartyId: signer.id,
        user,
        actor,
      });
      await approveDocument(ctx, cover.id, actor, `Cover letter for the ${PACK_STAGE_LABELS[pack.stage].toLowerCase()}`);
      coverDocumentId = cover.id;
      const o = ownerCompose(
        ctx,
        {
          claimId: claim.id,
          kind: 'signature_request',
          to: [signer.email],
          subject: `Your documents to ${toSign.length ? 'sign' : 'keep'} — ${PACK_STAGE_LABELS[pack.stage]}`,
          bodyText: bodyFor(pack.stage, 'client', salutationOf(signer), docs.map((d) => d.doc.title), returnBy),
          attach: [{ documentId: cover.id }, ...docs.map((d) => ({ documentId: d.doc.id }))],
        },
        actor,
      );
      outboxIds.push(o.id);
      for (const d of toSign) {
        const existing = ctx.repos.listSignatureRequests(ctx.db, { documentId: d.doc.id, status: ['prepared', 'sent', 'chased', 'returned'] });
        if (existing.length) continue;
        const r = ctx.repos.createSignatureRequest(ctx.db, {
          packId: pack.id,
          documentId: d.doc.id,
          claimId: claim.id,
          signerPartyId: signer.id,
          method: 'wet_email',
          status: 'sent',
          sentAt: now,
          nextChaseAt: nextChaseAt(now, 0, settings.chase),
          actor: actor.userId,
          note: `Emailed with outbox ${o.id}`,
          at: now,
        });
        signatureRequestIds.push(r.id);
      }
    } else {
      const insurer = claim.atFaultInsurerId ? ctx.repos.getParty(ctx.db, claim.atFaultInsurerId) : undefined;
      if (!insurer?.email) throw conflict('NO_EMAIL', 'No email address is on file for the at-fault insurer');
      const o = ownerCompose(
        ctx,
        { claimId: claim.id, kind: 'info_provided', to: [insurer.email], subject: `${PACK_STAGE_LABELS[pack.stage]}`, bodyText: bodyFor(pack.stage, 'at_fault_insurer', signer.name, docs.map((d) => d.doc.title)), attach: docs.map((d) => ({ documentId: d.doc.id })) },
        actor,
      );
      outboxIds.push(o.id);
    }
  }
  const sentKeys = new Set(groups.flatMap((g) => g.items.map(packItemKey)));
  const items = pack.items.map((i) => (sentKeys.has(packItemKey(i)) && i.status !== 'signed' ? { ...i, status: 'sent' as const } : i));
  pack = ctx.repos.updateDocumentPack(ctx.db, pack.id, { items, status: derivePackStatus(pack.status, items), sentAt: now, ...(outboxIds[0] ? { outboxId: outboxIds[0] } : {}) }, now);
  audit(ctx, actor, 'pack.send', 'document_packs', pack.id, { claimId: claim.id, stage: pack.stage, outboxIds, signatureRequestIds, coverDocumentId: coverDocumentId ?? null });
  if (pack.reservationId) syncEnforceabilityFromPack(ctx, ctx.db, { reservationId: pack.reservationId });
  return { pack, outboxIds, signatureRequestIds, ...(coverDocumentId ? { coverDocumentId } : {}) };
}

export function rejectPack(ctx: AppContext, packId: Id, actor: Actor, reason: string, opts: { fromNeedsYou?: boolean } = {}): DocumentPack {
  assertHuman(actor, 'reject paperwork');
  const pack = ctx.repos.requireDocumentPack(ctx.db, packId);
  if (!OPEN_PACK(pack)) return pack;
  const next = ctx.repos.updateDocumentPack(ctx.db, pack.id, { status: 'cancelled' }, ctx.now());
  audit(ctx, actor, 'pack.reject', 'document_packs', pack.id, { claimId: pack.claimId, stage: pack.stage, reason });
  if (!opts.fromNeedsYou) closeApprovePackCard(ctx, pack.id, actor, 'reject');
  nudgeAutopilot(ctx, pack.claimId, `${PACK_STAGE_LABELS[pack.stage]} rejected`);
  return next;
}

/** Recompute a pack's item and pack statuses from its documents (signed / sent), e.g. after a signature. */
export function refreshPackFromDocuments(ctx: AppContext, packId: Id): DocumentPack {
  const pack = ctx.repos.requireDocumentPack(ctx.db, packId);
  if (!OPEN_PACK(pack)) return pack;
  const items = pack.items.map((i) => {
    if (!i.documentId || i.status === 'not_needed') return i;
    const d = ctx.repos.getDocument(ctx.db, i.documentId, { includeHtml: false });
    if (d?.status === 'signed' && i.purpose === 'sign') return { ...i, status: 'signed' as const };
    return i;
  });
  return ctx.repos.updateDocumentPack(ctx.db, pack.id, { items, status: derivePackStatus(pack.status, items) }, ctx.now());
}

/** All packs of a claim, for the Packs panel and GET /claims/:id/packs. */
export function claimPacks(ctx: AppContext, claimId: Id): PackView[] {
  return ctx.repos.listDocumentPacks(ctx.db, { claimId }).map((p) => packView(ctx, p));
}

export { packDocuments };
