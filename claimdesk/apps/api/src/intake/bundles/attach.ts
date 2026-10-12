// owned by intake-server
/**
 * Attach a bundle (or one of its groups) to an existing claim (docs/SMART-INTAKE.md §6.9) — owner only. The group's
 * files are filed on the claim; every reconciled detail is proposed against the claim through the existing proposal
 * policy (auto / confirm / never); the owner's ticked keys are applied as the owner; everything else waiting goes
 * into one bundle `confirm_fields` card. Ticked chronology entries, damage observations, the missing-documents request
 * (checked against what the claim already holds) and the clash / Autopilot nudge follow.
 *
 * Also home to the helpers registration shares (chronology entries, field proposals, the bundle confirm card).
 */
import {
  BUNDLE_KEY_TARGET,
  reconcileBundle,
  type BundleFieldKey,
  type ChecklistItem,
  type DraftField,
  type EventType,
  type TimelineProposal,
} from '@ccguk/domain';
import type { Actor, ClaimUpdateProposalRecord } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { createNeedsYou } from '../../agent/core.js';
import type { NeedsYouItem } from '../../agent/contracts.js';
import { claimChanged } from '../../autopilot/claimChanged.js';
import { badRequest, notFound } from '../../errors.js';
import { appendClaimEvent } from '../../mail/common.js';
import { applyProposals, ownerApplier, type Applier } from '../../intake/apply.js';
import type { ConfirmCardPayload } from '../pipeline.js';
import { proposeField } from '../proposals.js';
import { loadClaimSnapshot, targetLabel } from '../targets.js';
import { recordBundleCorrections } from './corrections.js';
import { recordDamageObservations } from './damage.js';
import { fileBundleEvidence, linkItemsToClaim } from './file.js';
import { BUNDLE_AGENT } from './hooks.js';
import { LOW_CONFIDENCE, MIN_CONFLICT_CONFIDENCE, openCard, recomputeBundle, type BundleState } from './recompute.js';
import { prepareMissingDocsRequest, type RequestResult } from './requestDocs.js';
import { requireOpenBundle } from './service.js';
import { bundleSummary } from './views.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ATTRIBUTABLE = new Set(['insurer', 'client', 'ccguk', 'repairer', 'engineer', 'third_party', 'none']);
const toInstant = (at: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(at) ? `${at}T12:00:00.000Z` : at);

/** Append the ticked chronology proposals (skipping any already written — retry-safe). Owner-only types never. */
export function appendTimelineEvents(ctx: AppContext, state: BundleState, claimId: string, items: TimelineProposal[], filed: Record<string, string>, actor: Actor): number {
  const existing = new Set(
    ctx.repos
      .listEvents(ctx.db, claimId)
      .map((e) => (e.data as { intakeTimelineId?: string } | undefined)?.intakeTimelineId)
      .filter((x): x is string => Boolean(x)),
  );
  let n = 0;
  for (const t of items) {
    if (t.class === 'owner_only' || existing.has(t.id)) continue;
    const src = t.sources[0];
    const evidenceIds = [...new Set(t.sources.map((s) => filed[s.fileId]).filter((x): x is string => Boolean(x)))];
    appendClaimEvent(
      ctx,
      claimId,
      {
        type: t.eventType as EventType,
        at: toInstant(t.at),
        summary: t.summary,
        evidenceIds,
        ...(ATTRIBUTABLE.has(t.attributableTo) ? { attributableTo: t.attributableTo as 'insurer' } : {}),
        data: { intakeBundleId: state.bundle.id, intakeTimelineId: t.id, sourceFileId: src?.fileId ?? null, page: src?.page ?? null, quote: src?.quote ?? null },
      },
      actor,
    );
    existing.add(t.id);
    n += 1;
  }
  return n;
}

/** Propose every reconciled detail with a claim target against the claim (existing proposal policy). */
export function proposeBundleFields(ctx: AppContext, state: BundleState, claimId: string, fields: DraftField[]): ClaimUpdateProposalRecord[] {
  const snapshot = loadClaimSnapshot(ctx, claimId);
  const out: ClaimUpdateProposalRecord[] = [];
  for (const f of fields) {
    const target = BUNDLE_KEY_TARGET[f.key as BundleFieldKey];
    if (!target || !f.value || f.status === 'conflict' || f.status === 'invalid') continue;
    const src = f.source;
    const r = proposeField(ctx, {
      claimId,
      ...(src?.itemId ? { intakeItemId: src.itemId } : {}),
      target,
      value: f.value,
      confidence: f.status === 'owner_set' ? 1 : f.confidence,
      source: { ...(src?.itemId ? { intakeItemId: src.itemId } : {}), ...(src?.evidenceId ? { evidenceId: src.evidenceId } : {}), page: src?.page ?? null, quote: src?.quote ?? null, label: src?.label ?? `bundle '${state.bundle.name}'`, via: f.status === 'owner_set' ? 'owner' : 'extraction' },
      snapshot,
    });
    if (r.kind === 'proposed' && r.proposal.status === 'pending') out.push(r.proposal);
  }
  return out;
}

/** One `confirm_fields` card for the bundle's waiting proposals on the claim (§9). */
export function raiseBundleConfirmCard(ctx: AppContext, state: BundleState, claimId: string, pending: ClaimUpdateProposalRecord[]): NeedsYouItem | null {
  if (!pending.length) return null;
  const claim = ctx.repos.requireClaim(ctx.db, claimId);
  const proposals = pending.map((p) => ({
    id: p.id,
    target: p.target,
    label: targetLabel(p.target),
    currentValue: p.currentValue ?? null,
    proposedValue: p.proposedValue,
    confidence: p.confidence,
    sensitive: p.sensitive,
    page: p.source.page ?? null,
    quote: p.source.quote ?? null,
    reasons: p.validator?.policy?.reasons ?? [],
    ruleIds: p.validator?.policy?.ruleIds ?? [],
    validator: p.validator?.validator && !p.validator.validator.ok ? (p.validator.validator.message ?? 'failed its check') : null,
  }));
  const first = pending.find((p) => p.intakeItemId)?.intakeItemId ?? '';
  const payload: ConfirmCardPayload & { bundleId: string } = { bundleId: state.bundle.id, itemId: first, claimId, evidenceId: pending[0]!.source.evidenceId ?? '', docType: null, proposals, warnings: [] };
  return createNeedsYou(ctx, {
    kind: 'confirm_fields',
    claimId,
    title: `${claim.reference}: ${pending.length} detail${pending.length === 1 ? '' : 's'} from '${state.bundle.name}' need${pending.length === 1 ? 's' : ''} you`,
    summary: `Tick the values to apply; the rest are rejected.\n${proposals.map((p) => `• ${p.label}: ${p.proposedValue}${p.currentValue ? ` (on file: ${p.currentValue})` : ''} — ${Math.round(p.confidence * 100)}%`).join('\n')}`.slice(0, 4000),
    recommendation: { action: 'Check each value against its document and apply the ones that are right', why: 'These overwrite a value on file, are personal details, add a person or vehicle, or were read with less than 90% confidence.', confidence: Math.min(...pending.map((p) => p.confidence)), basis: [] },
    options: [
      { id: 'apply', label: 'Apply the ticked values', tone: 'primary' },
      { id: 'reject', label: 'Reject all', tone: 'danger', requiresReason: true },
    ],
    payload,
    priority: 'normal',
    createdBy: BUNDLE_AGENT,
    dedupeKey: `confirm_fields:bundle:${state.bundle.id}:${claimId}`,
  });
}

/**
 * The checklist recomputed against what the claim already holds (§6.9): its evidence (by kind, and how many photos /
 * licence images) and its own details (the other side, the client's account, the police reference). An attach to a
 * claim that is well under way must not ask the client again for what is already on file.
 */
export function checklistAgainstClaim(ctx: AppContext, claimId: string, items: ChecklistItem[]): ChecklistItem[] {
  const claim = ctx.repos.getClaim(ctx.db, claimId);
  const evidence = ctx.repos.listEvidenceForClaim(ctx.db, claimId);
  const count = (kind: string): number => evidence.filter((e) => e.kind === kind).length;
  const kinds = new Set(evidence.map((e) => e.kind as string));
  const HAS: Record<string, string[]> = { v5c: ['v5c'], licence_front: ['licence'], insurance_certificate: ['insurance_certificate'], estimate_or_report: ['estimate', 'engineer_report'], bank_details: ['bank_statement'], mot_certificate: ['mot_certificate'], witness_statements: ['witness_statement'], signed_hire_docs: ['signed_document'] };
  const onClaim = (id: string): string | null => {
    if (HAS[id]?.some((k) => kinds.has(k))) return 'Already on the claim';
    if (id === 'licence_back' && count('licence') >= 2) return 'Already on the claim';
    if (id === 'damage_photos' && count('photo') >= 4) return 'Already on the claim';
    if (!claim) return null;
    if (id === 'tp_details' && (claim.thirdPartyVehicleId || claim.atFaultInsurerId)) return 'The other side is already on the claim';
    if (id === 'accident_account' && claim.accident?.circumstances?.trim()) return 'The client’s account is already on the claim';
    if (id === 'police_report' && claim.accident?.policeReference?.trim()) return 'The police reference is already on the claim';
    return null;
  };
  return items.map((i) => {
    if (i.status === 'have' || i.status === 'not_needed') return i;
    const why = onClaim(i.id);
    return why ? { ...i, status: 'have' as const, why } : i;
  });
}

// ---------------------------------------------------------------------------
// attachBundle
// ---------------------------------------------------------------------------

export interface AttachOptions {
  claimId: string;
  groupKey?: string;
  apply?: string[];
  /** Called from registration for a leftover claim group (the bundle is mid-registration). */
  internal?: boolean;
  state?: BundleState;
}

export interface AttachOutcome {
  claim: { id: string; reference: string };
  filed: { evidence: number; duplicatesSkipped: number };
  events: number;
  proposals: { applied: number; pending: number; needsYouId: string | null };
  request: RequestResult;
  files: number;
}

export async function attachGroup(ctx: AppContext, bundleId: string, actor: Actor, opts: AttachOptions): Promise<AttachOutcome> {
  if (!opts.internal) requireOpenBundle(ctx, bundleId);
  const claim = ctx.repos.getClaim(ctx.db, opts.claimId);
  if (!claim) throw notFound('claim', opts.claimId);
  const groupKey = opts.groupKey ?? 'main';
  const state = opts.state ?? recomputeBundle(ctx, bundleId);
  const group = state.computed.groups.find((g) => g.key === groupKey);
  if (!group) throw notFound('group', groupKey);
  if (group.kind === 'excluded') throw badRequest('Excluded files are not attached');
  const fileIds = group.fileIds;

  const filing = await fileBundleEvidence(ctx, state, claim.id, fileIds, actor, { copies: state.owner.fileCopies });
  linkItemsToClaim(ctx, state, claim.id, fileIds, actor);

  // details: the main draft, or a draft from this group's files alone
  let fields: DraftField[];
  if (groupKey === 'main') fields = state.computed.draft.fields;
  else {
    const ids = new Set(fileIds);
    const cands = [...state.readings.entries()].filter(([id]) => ids.has(id)).flatMap(([, r]) => r.candidates);
    fields = reconcileBundle({ candidates: cands, decisions: [], minConflictConfidence: MIN_CONFLICT_CONFIDENCE, lowConfidence: LOW_CONFIDENCE }).fields;
  }
  const proposals = proposeBundleFields(ctx, state, claim.id, fields);
  const wanted = new Set((opts.apply ?? []).map((k) => BUNDLE_KEY_TARGET[k as BundleFieldKey]).filter(Boolean));
  const toApply = proposals.filter((p) => p.policyDecision === 'auto' || wanted.has(p.target as never));
  const applier: Applier = ownerApplier(ctx, actor);
  let applied = 0;
  if (toApply.length) {
    const results = await applyProposals(ctx, toApply, applier, { note: `from intake bundle '${state.bundle.name}'` });
    applied = results.filter((r) => r.ok).length;
  }
  const proposed = new Set(proposals.map((p) => p.id));
  const pending = ctx.repos.listClaimUpdateProposals(ctx.db, { claimId: claim.id, status: 'pending' }).filter((p) => proposed.has(p.id));
  const card = raiseBundleConfirmCard(ctx, state, claim.id, pending);

  const ids = new Set(fileIds);
  const events = appendTimelineEvents(ctx, state, claim.id, state.computed.timeline.filter((t) => t.ticked && t.sources.some((s) => ids.has(s.fileId))), filing.filed, actor);
  recordDamageObservations(ctx, state, claim.id, filing.filed, actor, { fileIds: ids });
  let request: RequestResult = { outboxId: null, needsYouId: null, reason: null };
  if (groupKey === 'main' && state.settings.bundles.prepareMissingDocsRequest) {
    request = prepareMissingDocsRequest(ctx, { claimId: claim.id, bundleId: state.bundle.id, items: checklistAgainstClaim(ctx, claim.id, state.computed.checklist.items) });
  }
  claimChanged(ctx, [claim.id], actor.userId, 'documents attached from an intake bundle');
  return { claim: { id: claim.id, reference: claim.reference }, filed: { evidence: filing.evidence, duplicatesSkipped: filing.duplicatesSkipped }, events, proposals: { applied, pending: pending.length, needsYouId: card?.id ?? null }, request, files: fileIds.length };
}

/** The owner's attach (route / Needs-you resolver). */
export async function attachBundle(ctx: AppContext, bundleId: string, actor: Actor, opts: { claimId: string; groupKey?: string; apply?: string[]; viaCardId?: string }) {
  const out = await attachGroup(ctx, bundleId, actor, opts);
  const now = ctx.now();
  const groupKey = opts.groupKey ?? 'main';
  const state = recomputeBundle(ctx, bundleId);
  const group = state.computed.groups.find((g) => g.key === groupKey);
  const revision = ctx.repos.bumpBundleRevision(ctx.db, bundleId, now);
  ctx.repos.appendBundleDecision(ctx.db, { bundleId, revision, kind: 'attach', subject: groupKey, after: { claimId: out.claim.id, reference: out.claim.reference, groupKey, fileIds: group?.fileIds ?? [], events: out.events, duplicatesSkipped: out.filed.duplicatesSkipped, request: out.request }, actor: actor.userId, at: now });
  if (groupKey === 'main') {
    recordBundleCorrections(ctx, state, out.claim.id, actor);
    const card = openCard(ctx, state.bundle);
    if (card && card.id !== opts.viaCardId) ctx.repos.transitionNeedsYou(ctx.db, card.id, { to: 'superseded', actor: actor.userId, note: `attached to ${out.claim.reference}`, now });
    ctx.repos.updateIntakeBundle(ctx.db, bundleId, { status: 'attached', outcome: 'attached', claimId: out.claim.id, closedBy: actor.userId, closedAt: now }, now);
  } else {
    recomputeBundle(ctx, bundleId);
  }
  ctx.repos.appendAudit(ctx.db, { actor, action: 'intake.bundle.attach', entity: 'intake_bundles', entityId: bundleId, after: { claimId: out.claim.id, reference: out.claim.reference, groupKey, files: out.files, filed: out.filed.evidence, duplicatesSkipped: out.filed.duplicatesSkipped, events: out.events, applied: out.proposals.applied, pending: out.proposals.pending }, at: now });
  return {
    claim: out.claim,
    bundle: bundleSummary(ctx, ctx.repos.requireIntakeBundle(ctx.db, bundleId)),
    filed: out.filed,
    events: out.events,
    proposals: out.proposals,
    request: out.request,
  };
}
