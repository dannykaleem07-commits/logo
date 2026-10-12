// owned by intake
/**
 * Proposals (docs/SUPREME-DESIGN.md §G.2 step 5, §D.2 rules 7–9): an extracted value is validated, compared with what
 * the claim holds, and stored as a `claim_update_proposals` row with a policy decision:
 *
 *   auto     the field is empty, confidence ≥ 0.9, the validator passes and the field is not sensitive — and the
 *            autonomy policy (`decide()`, class `internal`) says `auto` (§D.2 rule 9);
 *   confirm  overwriting, below 0.9, sensitive, a failed validator, a new party/vehicle, or `decide()` asks
 *            (rules 3, 6, 7, 8) or denies (kill switch: the owner can still confirm);
 *   never    the target cannot be applied on this claim (e.g. a different registration for the vehicle on file).
 *
 * Liability, ledger figures and claim status are not proposable at all (the FieldTarget union is closed).
 */
import { decide, isFieldTarget, type DocType, type ExtractedField, type FieldTarget } from '@ccguk/domain';
import type { ClaimUpdateProposalRecord, ProposalChecks, ProposalPolicy, ProposalSource } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { autonomyState, getAutonomy } from '../agent/core.js';
import { loadClaimSnapshot, sameValue, targetDef, vehicleOf, type ClaimSnapshot, type ValidationHints } from './targets.js';

/** §G.2 step 5: automatic only at or above this confidence (stricter than the policy's internal 0.85). */
export const AUTO_APPLY_CONFIDENCE = 0.9;

export interface PolicyInput {
  claimId: string;
  target: FieldTarget;
  sensitive: boolean;
  overwrites: boolean;
  createsRecord: boolean;
  confidence: number;
  validatorOk: boolean;
  unavailable?: string;
  /** Code-found reasons that force the owner's confirmation (a document for another vehicle, a VIN already elsewhere). */
  forceConfirm?: Array<{ ruleId: string; reason: string }>;
}

export interface PolicyResult {
  policy: ProposalPolicy;
  ruleIds: string[];
  reasons: string[];
}

/** The proposal's policy: `decide()` for an internal action, then the stricter intake rules. */
export function proposalPolicy(ctx: AppContext, i: PolicyInput): PolicyResult {
  if (i.unavailable) return { policy: 'never', ruleIds: ['target_unavailable'], reasons: [i.unavailable] };
  const d = decide(
    { class: 'internal', kind: `field.${i.target}`, claimId: i.claimId, confidence: i.confidence, sensitive: i.sensitive, overwrites: i.overwrites || i.createsRecord },
    getAutonomy(ctx),
    autonomyState(ctx, { claimId: i.claimId, agent: 'intake' }),
  );
  const ruleIds = [...d.ruleIds];
  const reasons = [...d.reasons];
  let policy: ProposalPolicy = d.outcome === 'auto' || d.outcome === 'auto_held' ? 'auto' : 'confirm';
  if (i.sensitive) {
    // The reason is always shown (decide() may already have asked for another reason, e.g. an overwrite).
    if (!ruleIds.includes('internal_sensitive')) ruleIds.push('intake_sensitive');
    reasons.push('sensitive field (personal details)');
    policy = 'confirm';
  }
  if (i.overwrites && !ruleIds.includes('internal_sensitive')) {
    ruleIds.push('intake_overwrites');
    reasons.push('the claim already holds a different value');
    policy = 'confirm';
  }
  if (i.createsRecord) {
    ruleIds.push('intake_creates_record');
    reasons.push('adds a new person or vehicle to the claim');
    policy = 'confirm';
  }
  if (!i.validatorOk) {
    ruleIds.push('intake_validator');
    reasons.push('the value failed its check');
    policy = 'confirm';
  }
  for (const f of i.forceConfirm ?? []) {
    ruleIds.push(f.ruleId);
    reasons.push(f.reason);
    policy = 'confirm';
  }
  if (i.confidence < AUTO_APPLY_CONFIDENCE) {
    ruleIds.push('intake_confidence');
    reasons.push(`confidence ${Math.round(i.confidence * 100)}% is below ${Math.round(AUTO_APPLY_CONFIDENCE * 100)}%`);
    policy = 'confirm';
  }
  return { policy, ruleIds: [...new Set(ruleIds)], reasons: [...new Set(reasons)] };
}

export interface ProposeFieldInput {
  claimId: string;
  intakeItemId?: string;
  target: string;
  value: string;
  confidence: number;
  source: ProposalSource;
  hints?: Omit<ValidationHints, 'now'>;
  /** Reuse a snapshot across many fields of one document. */
  snapshot?: ClaimSnapshot;
  /** Set when this document's registration for the field's vehicle role differs from the claim's ("KX21ABC vs DK18WRE"). */
  vehicleMismatch?: { document: string; claim: string };
}

export type ProposeFieldResult =
  | { kind: 'proposed'; proposal: ClaimUpdateProposalRecord; created: boolean }
  | { kind: 'skipped'; reason: string };

/** Validate, compare and store one proposal (duplicates of a pending proposal are returned, not repeated). */
export function proposeField(ctx: AppContext, input: ProposeFieldInput): ProposeFieldResult {
  if (!isFieldTarget(input.target)) return { kind: 'skipped', reason: `${input.target} is not a field intake may propose` };
  const def = targetDef(input.target);
  if (!def) return { kind: 'skipped', reason: `${input.target} has no definition` };
  const raw = input.value.trim();
  if (!raw) return { kind: 'skipped', reason: 'empty value' };
  const now = ctx.now();
  const snapshot = input.snapshot ?? loadClaimSnapshot(ctx, input.claimId);
  const v = def.validate(raw, { now, ...(input.hints ?? {}) });
  const value = (v.value ?? raw).slice(0, 2000);
  const insp = def.inspect(snapshot, value);
  if (insp.current && sameValue(insp.current, value) && !insp.unavailable) return { kind: 'skipped', reason: 'already on the claim' };
  const confidence = Math.max(0, Math.min(1, Number.isFinite(input.confidence) ? input.confidence : 0));
  const forceConfirm: Array<{ ruleId: string; reason: string }> = [];
  if (def.kind === 'vehicle' && def.field !== 'registration' && input.vehicleMismatch) {
    forceConfirm.push({ ruleId: 'intake_vehicle_mismatch', reason: `This document is for ${input.vehicleMismatch.document}; the claim vehicle is ${input.vehicleMismatch.claim}` });
  }
  if (def.kind === 'vehicle' && def.field === 'vin') {
    const elsewhere = vinElsewhere(ctx, vehicleOf(snapshot, def.role as never)?.id, value);
    if (elsewhere) forceConfirm.push({ ruleId: 'intake_vin_elsewhere', reason: `VIN already on ${elsewhere}` });
  }
  const pol = proposalPolicy(ctx, { claimId: input.claimId, target: def.target, sensitive: def.sensitive, overwrites: Boolean(insp.current), createsRecord: insp.createsRecord, confidence, validatorOk: v.ok, ...(insp.unavailable ? { unavailable: insp.unavailable } : {}), ...(forceConfirm.length ? { forceConfirm } : {}) });
  const checks: ProposalChecks = {
    validator: { name: def.field, ok: v.ok, ...(v.errors.length ? { message: v.errors.join('; ') } : v.notes?.length ? { message: v.notes.join('; ') } : {}), ...(v.value !== undefined ? { normalised: value } : {}) },
    policy: { ruleIds: pol.ruleIds, reasons: pol.reasons },
  };
  const { proposal, created } = ctx.repos.insertClaimUpdateProposal(ctx.db, {
    claimId: input.claimId,
    ...(input.intakeItemId ? { intakeItemId: input.intakeItemId } : {}),
    target: def.target,
    currentValue: insp.current ?? null,
    proposedValue: value,
    confidence,
    sensitive: def.sensitive,
    checks,
    source: input.source,
    policyDecision: pol.policy,
    now,
  });
  // A `never` proposal is decided at once (refused), with its reason kept.
  if (created && pol.policy === 'never') {
    const refused = ctx.repos.decideClaimUpdateProposal(ctx.db, proposal.id, { status: 'rejected', decidedBy: 'agent:intake', decidedAt: now, reason: pol.reasons.join('; ') || 'not applicable on this claim' });
    return { kind: 'proposed', proposal: refused, created };
  }
  return { kind: 'proposed', proposal, created };
}

/** Another vehicle that already carries this VIN ("KR20VXA / CCG-2026-00003"), else undefined. */
export function vinElsewhere(ctx: AppContext, ownVehicleId: string | undefined, vin: string): string | undefined {
  const norm = vin.replace(/\s+/g, '').toUpperCase();
  if (norm.length < 5) return undefined;
  const row = ctx.handle.sqlite
    .prepare(
      `SELECT v.registration AS registration,
              (SELECT c.reference FROM claims c WHERE c.client_vehicle_id = v.id OR c.third_party_vehicle_id = v.id ORDER BY c.created_at LIMIT 1) AS reference
       FROM vehicles v WHERE upper(replace(coalesce(v.vin, ''), ' ', '')) = ? AND v.id <> ? LIMIT 1`,
    )
    .get(norm, ownVehicleId ?? '') as { registration: string; reference: string | null } | undefined;
  return row ? `${row.registration}${row.reference ? ` / ${row.reference}` : ''}` : undefined;
}

/** Holder hints for licence cross-checks: the same role's name / DOB in this document, else what the claim holds. */
export function holderHints(fields: ExtractedField[], snapshot: ClaimSnapshot | undefined, target: string): ValidationHints['holder'] | undefined {
  const m = /^party:(client|claimant|driver|third_party)\.drivingLicenceNumber$/.exec(target);
  if (!m) return undefined;
  const role = m[1]!;
  const pick = (f: string) => fields.find((x) => x.target === `party:${role}.${f}` && x.value)?.value ?? undefined;
  const party = !snapshot ? undefined : role === 'third_party' ? snapshot.thirdParty : role === 'driver' ? snapshot.driver : snapshot.claimant;
  const name = pick('name') ?? party?.name;
  const dob = pick('dateOfBirth') ?? party?.dateOfBirth;
  return { ...(name ? { name } : {}), ...(dob ? { dateOfBirth: dob } : {}) };
}

/** Propose every targeted field of an extraction on the item's claim. */
export function proposeFromFields(
  ctx: AppContext,
  input: { claimId: string; intakeItemId: string; evidenceId: string; extractionId?: string; runId?: string; fields: ExtractedField[] },
): { proposals: ClaimUpdateProposalRecord[]; skipped: Array<{ name: string; target: string | null; reason: string }> } {
  const snapshot = loadClaimSnapshot(ctx, input.claimId);
  const proposals: ClaimUpdateProposalRecord[] = [];
  const skipped: Array<{ name: string; target: string | null; reason: string }> = [];
  // Highest confidence first per target, so a duplicate field never wins over a better reading.
  const sorted = [...input.fields].sort((a, b) => b.confidence - a.confidence);
  // A document for a different registration than the claim's vehicle: none of its vehicle fields apply automatically.
  const mismatch = new Map<string, { document: string; claim: string }>();
  for (const f of sorted) {
    const m = f.target ? /^vehicle:([a-z_]+)\.registration$/.exec(f.target) : null;
    if (!m || !f.value || mismatch.has(m[1]!)) continue;
    const def = targetDef(f.target!);
    const insp = def?.inspect(snapshot, String(f.value).trim());
    if (insp?.unavailable && insp.current) mismatch.set(m[1]!, { document: String(f.value).trim().toUpperCase(), claim: insp.current });
  }
  const seen = new Set<string>();
  for (const f of sorted) {
    if (!f.target || f.value === null || f.value === undefined || !String(f.value).trim()) {
      skipped.push({ name: f.name, target: f.target, reason: f.target ? 'no value' : 'no claim field' });
      continue;
    }
    if (seen.has(f.target)) {
      skipped.push({ name: f.name, target: f.target, reason: 'a better reading of the same field was used' });
      continue;
    }
    seen.add(f.target);
    const holder = holderHints(input.fields, snapshot, f.target);
    const role = /^vehicle:([a-z_]+)\./.exec(f.target)?.[1];
    const vehicleMismatch = role ? mismatch.get(role) : undefined;
    const r = proposeField(ctx, {
      claimId: input.claimId,
      intakeItemId: input.intakeItemId,
      target: f.target,
      value: String(f.value),
      confidence: f.confidence,
      source: { intakeItemId: input.intakeItemId, evidenceId: input.evidenceId, page: f.page, quote: f.quote, label: f.name, via: 'extraction', ...(input.extractionId ? { extractionId: input.extractionId } : {}), ...(input.runId ? { runId: input.runId } : {}) },
      ...(holder ? { hints: { holder } } : {}),
      ...(vehicleMismatch ? { vehicleMismatch } : {}),
      snapshot,
    });
    if (r.kind === 'proposed') proposals.push(r.proposal);
    else skipped.push({ name: f.name, target: f.target, reason: r.reason });
  }
  return { proposals, skipped };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const DOC_TYPE_LABELS: Readonly<Record<DocType, string>> = {
  v5c: 'V5C',
  driving_licence: 'Driving licence',
  insurance_certificate: 'Insurance certificate',
  police_report: 'Police report',
  fnol_form: 'Accident report form',
  insurer_letter: 'Insurer letter',
  engineer_report: 'Engineer report',
  bodyshop_estimate: 'Bodyshop estimate',
  audatex_estimate: 'Audatex estimate',
  invoice: 'Invoice',
  damage_photo: 'Damage photo',
  vehicle_photo_other: 'Vehicle photo',
  signed_ccguk_form: 'Signed CCGUK form',
  bank_statement: 'Bank statement',
  payslip: 'Payslip',
  mot_certificate: 'MOT certificate',
  correspondence: 'Correspondence',
  other: 'Document',
};

export function docTypeLabel(docType: string | undefined): string {
  return (docType && DOC_TYPE_LABELS[docType as DocType]) || 'Document';
}

/** Document types that, with no claim, suggest a new claim (§G.3, Needs-you `new_claim`). */
export const FNOL_LIKE_DOC_TYPES: ReadonlySet<string> = new Set(['fnol_form', 'signed_ccguk_form', 'police_report', 'v5c', 'driving_licence', 'insurance_certificate']);
