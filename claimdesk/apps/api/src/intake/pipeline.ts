// owned by intake
/**
 * The intake pipeline (docs/SUPREME-DESIGN.md §G.2, §C.2): `intake.process` (cpu, deterministic) → `intake.extract`
 * (ai) → `intake.apply` (io, deterministic). Job handlers live in agent/handlers/intake.ts and call these.
 *
 *   process  sniff → normalise → (HEIC: Needs-you question; audio/CAB/…: skipped; EML: attachments become child items)
 *            → item `extracting` → follow-up `intake.extract`
 *   extract  runAgent(INTAKE_SPEC) → append-only `intake_extractions` row → item doc type → follow-up `intake.apply`
 *   apply    with a claim: proposals from the extraction → auto ones applied as agent:intake → the rest in ONE
 *            Needs-you `confirm_fields` card; with no claim: an FNOL-like document raises Needs-you `new_claim`,
 *            anything else waits on the Intake screen.
 */
import { open, readFile } from 'node:fs/promises';
import type { ExtractedField, IntakeExtraction } from '@ccguk/domain';
import type { Actor, ClaimUpdateProposalRecord, IntakeItemRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import type { EnqueueInput, JobOutcome, JobRecord, NeedsYouItem } from '../agent/contracts.js';
import { authFailedWait, createNeedsYou } from '../agent/core.js';
import { runAgent } from '../agent/runAgent.js';
import { readEvidenceVerified, stageBuffer } from '../services/evidence.js';
import { agentApplier, applyProposals, rejectProposals } from './apply.js';
import { fingerprintCcgukForm } from './fingerprint.js';
import { createItemFromStaged } from './items.js';
import { documentText, normalise, type NormalisedDoc } from './normalise.js';
import { docTypeLabel, FNOL_LIKE_DOC_TYPES, proposeFromFields } from './proposals.js';
import { sniff } from './sniff.js';
import { extractionInput, INTAKE_SPEC } from './spec.js';
import { targetLabel } from './targets.js';
import { normaliseVrm } from './validators.js';

export const INTAKE_ACTOR: Actor = { userId: 'agent:intake' };
/** Files above this are kept as evidence but not read by intake. */
export const MAX_INTAKE_READ_BYTES = 256 * 1024 * 1024;
/** Kinds whose whole content is parsed for text; they are read into memory up to MAX_INTAKE_PARSE_BYTES. */
const PARSED_KINDS: ReadonlySet<string> = new Set(['pdf', 'docx', 'eml', 'text']);
export const MAX_INTAKE_PARSE_BYTES = 64 * 1024 * 1024;
/** Enough for every magic-byte check (zip entry names are looked for in the first 4 MiB). */
const SNIFF_HEAD_BYTES = 4 * 1024 * 1024;
/** The model's image limit: larger photos stay as evidence and are not attached to the model. */
export const MAX_MODEL_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_MODEL_PDF_BYTES = 32 * 1024 * 1024;

async function readHead(file: string, max: number): Promise<Buffer> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
/** Children per email (attachments beyond this are listed but not read). */
export const MAX_EMAIL_ATTACHMENTS = 25;

const followUp = (type: 'intake.extract' | 'intake.apply', item: IntakeItemRecord, job: JobRecord, extra: Record<string, unknown> = {}): EnqueueInput => ({
  type,
  payload: { itemId: item.id, ...extra },
  ...(item.claimId ? { claimId: item.claimId } : {}),
  idempotencyKey: `${type}:${item.id}${job.idempotencyKey?.match(/:r[\w-]+$/)?.[0] ?? ''}`,
  parentJobId: job.id,
  createdBy: INTAKE_ACTOR.userId,
});

function setStatus(ctx: AppContext, id: string, status: IntakeItemRecord['status'], extra: Parameters<AppContext['repos']['updateIntakeItem']>[2] = {}): IntakeItemRecord {
  return ctx.repos.updateIntakeItem(ctx.db, id, { ...extra, status }, ctx.now());
}

// ---------------------------------------------------------------------------
// intake.process
// ---------------------------------------------------------------------------

export async function processItem(ctx: AppContext, item: IntakeItemRecord, job: JobRecord): Promise<JobOutcome> {
  const ev = ctx.repos.getEvidence(ctx.db, item.evidenceId);
  if (!ev) {
    setStatus(ctx, item.id, 'failed', { error: `Evidence ${item.evidenceId} is missing` });
    return { kind: 'fail', reason: 'evidence missing', deadLetter: true };
  }
  setStatus(ctx, item.id, 'normalising', { error: null });
  if (ev.bytes > MAX_INTAKE_READ_BYTES) {
    setStatus(ctx, item.id, 'skipped', { error: `This file is ${Math.round(ev.bytes / 1048576)} MB — kept as evidence, too large for intake to read` });
    return { kind: 'done', result: { status: 'skipped', reason: 'too large' } };
  }
  const read = await readEvidenceVerified(ctx, ev);
  if (!read) {
    setStatus(ctx, item.id, 'failed', { error: 'The stored file is missing' });
    return { kind: 'fail', reason: 'evidence file missing', deadLetter: true };
  }
  if (!read.intact) {
    setStatus(ctx, item.id, 'failed', { error: 'The stored file failed its integrity check; it was not read' });
    return { kind: 'fail', reason: 'evidence tampered', deadLetter: true };
  }
  // Sniff from the head of the file; read the whole file only for the kinds that are parsed (PDF, Word, email, text)
  // and only up to MAX_INTAKE_PARSE_BYTES. Images and everything else are never buffered (the model gets the path).
  const head = await readHead(read.absolutePath, SNIFF_HEAD_BYTES);
  const sniffed = sniff(head, ev.filename);
  let bytes = head;
  if (PARSED_KINDS.has(sniffed.kind) && read.size > head.length) {
    if (read.size > MAX_INTAKE_PARSE_BYTES) {
      setStatus(ctx, item.id, 'skipped', { sniffedType: sniffed.kind, error: `This ${sniffed.kind.toUpperCase()} is ${Math.round(read.size / 1048576)} MB — kept as evidence; too large for intake to read` });
      return { kind: 'done', result: { status: 'skipped', reason: 'too large to parse' } };
    }
    bytes = await readFile(read.absolutePath);
  }
  let result;
  try {
    result = await normalise(bytes, ev.filename, sniffed);
  } catch (err) {
    setStatus(ctx, item.id, 'failed', { sniffedType: sniffed.kind, error: `The ${sniffed.kind.toUpperCase()} could not be read: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1000) });
    return { kind: 'done', result: { status: 'failed', reason: 'unreadable' } };
  }
  const doc: NormalisedDoc = { ...result.doc };
  const text = documentText(doc);
  if (text) doc.fingerprint = fingerprintCcgukForm(text);
  const base = { sniffedType: sniffed.kind, pages: doc.pages ?? null, textSha256: result.textSha256 ?? null, normalised: doc };

  if (doc.kind === 'heic') {
    const ny = createNeedsYou(ctx, {
      kind: 'question',
      ...(item.claimId ? { claimId: item.claimId } : {}),
      title: `Export ${ev.filename} as JPEG`,
      summary: `${ev.filename} is an iPhone HEIC photo. ClaimDesk cannot read HEIC files yet. Open it on the PC (Photos → Save as / Export) or set the iPhone camera to "Most Compatible", save it as a JPEG and add the JPEG again. The original stays as evidence.`,
      options: [
        { id: 'done', label: 'Done — I added the JPEG', tone: 'primary' },
        { id: 'dismiss', label: 'Not needed', tone: 'neutral' },
      ],
      payload: { intakeItemId: item.id, evidenceId: ev.id, reason: 'heic' },
      priority: 'low',
      createdBy: INTAKE_ACTOR.userId,
      dedupeKey: `intake:heic:${item.id}`,
      correlationId: job.correlationId,
    });
    setStatus(ctx, item.id, 'needs_you', base);
    return { kind: 'done', result: { status: 'needs_you', needsYouId: ny.id } };
  }
  if (doc.kind === 'image' && ev.bytes > MAX_MODEL_IMAGE_BYTES) {
    setStatus(ctx, item.id, 'skipped', { ...base, error: `This photo is ${Math.round(ev.bytes / 1048576)} MB — kept as evidence; too large to give the agents (over ${MAX_MODEL_IMAGE_BYTES / 1048576} MB)` });
    return { kind: 'done', result: { status: 'skipped', reason: 'image too large for the model' } };
  }
  if (doc.kind === 'skipped') {
    setStatus(ctx, item.id, 'skipped', { ...base, error: doc.skipReason ?? 'not read' });
    return { kind: 'done', result: { status: 'skipped', reason: doc.skipReason } };
  }

  // An email: each attachment becomes its own (child) item on the same claim.
  const children: string[] = [];
  if (doc.kind === 'email' && result.attachments.length) {
    for (const a of result.attachments.slice(0, MAX_EMAIL_ATTACHMENTS)) {
      const { item: child } = await createItemFromStaged(ctx, {
        source: item.source,
        ...(item.claimId ? { claimId: item.claimId } : {}),
        parentItemId: item.id,
        staged: stageBuffer(ctx, a.content),
        filename: a.filename,
        mime: a.mime,
        actor: INTAKE_ACTOR,
        description: `Attachment of ${ev.filename}`,
      });
      children.push(child.id);
    }
  }

  if (!text && !doc.scanned && doc.kind !== 'image') {
    setStatus(ctx, item.id, 'skipped', { ...base, error: 'The document has no text to read' });
    return { kind: 'done', result: { status: 'skipped', reason: 'no text', children } };
  }
  setStatus(ctx, item.id, 'extracting', base);
  return { kind: 'done', result: { status: 'extracting', sniffed: sniffed.kind, children }, followUps: [followUp('intake.extract', item, job, { evidenceId: item.evidenceId })] };
}

// ---------------------------------------------------------------------------
// intake.extract
// ---------------------------------------------------------------------------

export async function extractItem(ctx: AppContext, item: IntakeItemRecord, job: JobRecord): Promise<JobOutcome> {
  const ev = ctx.repos.requireEvidence(ctx.db, item.evidenceId);
  const doc = (item.normalised ?? undefined) as NormalisedDoc | undefined;
  if (!doc) return { kind: 'fail', reason: 'not normalised yet (run intake.process first)' };
  const read = await readEvidenceVerified(ctx, ev);
  if (!read?.intact) {
    setStatus(ctx, item.id, 'failed', { error: 'The stored file failed its integrity check; it was not given to the agent' });
    return { kind: 'fail', reason: 'evidence tampered or missing', deadLetter: true };
  }
  setStatus(ctx, item.id, 'extracting');
  const claimReference = item.claimId ? ctx.repos.getClaim(ctx.db, item.claimId)?.reference : undefined;
  // The file itself goes to the model only within its limits (images 20 MB, PDFs 32 MB); the text always does.
  const attachOk = ev.bytes <= (doc.kind === 'image' ? MAX_MODEL_IMAGE_BYTES : MAX_MODEL_PDF_BYTES);
  const r = await runAgent(ctx, INTAKE_SPEC, job, extractionInput({ item, evidence: ev, doc, ...(attachOk ? { absolutePath: read.absolutePath } : {}), ...(claimReference ? { claimReference } : {}) }));
  const o = r.outcome;
  if (o.kind === 'ok' && r.result) {
    const x = r.result as IntakeExtraction;
    const extraction = ctx.repos.appendIntakeExtraction(ctx.db, {
      intakeItemId: item.id,
      runId: r.runId,
      schemaId: INTAKE_SPEC.resultSchemaId,
      fields: x.fields,
      summary: x.summary,
      warnings: x.warnings,
      now: ctx.now(),
    });
    setStatus(ctx, item.id, 'proposed', { docType: x.docType, docTypeConfidence: x.docTypeConfidence, normalised: { ...doc, formTemplateId: x.formTemplateId } });
    return { kind: 'done', result: { extractionId: extraction.id, runId: r.runId, docType: x.docType, fields: x.fields.length }, followUps: [followUp('intake.apply', item, job, { extractionId: extraction.id })] };
  }
  if (o.kind === 'usage_limited') {
    setStatus(ctx, item.id, 'quota_wait');
    return { kind: 'wait_usage', until: o.resetsAt ?? new Date(Date.parse(ctx.now()) + 15 * 60_000).toISOString() };
  }
  if (o.kind === 'auth_failed') {
    // §A.7: waits with the AI pause and runs again after "I've fixed it" — it does not fail for good.
    setStatus(ctx, item.id, 'quota_wait');
    return authFailedWait(ctx, o.message);
  }
  const message = o.kind === 'error' ? o.message : o.kind === 'invalid_output' ? `invalid result: ${o.errors.join('; ')}` : o.kind === 'refused' ? `refused: ${o.explanation ?? o.category ?? ''}` : o.kind;
  const retryable = (o.kind === 'error' && o.retryable) || o.kind === 'timeout' || o.kind === 'invalid_output';
  if (retryable && job.attempts < job.maxAttempts) {
    setStatus(ctx, item.id, 'extracting', { error: message.slice(0, 1000) });
    return { kind: 'retry', afterMs: 60_000, reason: message };
  }
  setStatus(ctx, item.id, 'failed', { error: (o.kind === 'error' && o.code === 'AI_OFF' ? 'AI is switched off (Settings > AI). Switch it on, then Retry.' : message).slice(0, 1000) });
  // §C.3: after the last attempt the job is dead and the owner gets a Needs-you failure (AI off has its own setup path).
  return { kind: 'fail', reason: message, deadLetter: !(o.kind === 'error' && o.code === 'AI_OFF') };
}

// ---------------------------------------------------------------------------
// intake.apply
// ---------------------------------------------------------------------------

export interface ConfirmCardPayload {
  itemId: string;
  claimId: string;
  evidenceId: string;
  docType: string | null;
  proposals: Array<{ id: string; target: string; label: string; currentValue: string | null; proposedValue: string; confidence: number; sensitive: boolean; page: number | null; quote: string | null; reasons: string[]; ruleIds: string[]; validator: string | null }>;
  /** Values from this document that were refused outright (e.g. a registration that is not the claim vehicle's). */
  warnings: string[];
}

const proposalView = (p: ClaimUpdateProposalRecord): ConfirmCardPayload['proposals'][number] => ({
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
});

/** ONE grouped Needs-you `confirm_fields` card per document ("V5C: 9 fields filled, 3 need you"). */
export function raiseConfirmCard(ctx: AppContext, item: IntakeItemRecord, pending: ClaimUpdateProposalRecord[], filled: number, correlationId?: string, refused: ClaimUpdateProposalRecord[] = [], runId?: string): NeedsYouItem {
  const label = docTypeLabel(item.docType);
  const ev = ctx.repos.getEvidence(ctx.db, item.evidenceId);
  const warnings = refused.map((p) => `${targetLabel(p.target)} ${p.proposedValue} was not applied: ${(p.validator?.policy?.reasons ?? []).join('; ') || 'not applicable on this claim'}`);
  const payload: ConfirmCardPayload = { itemId: item.id, claimId: item.claimId!, evidenceId: item.evidenceId, docType: item.docType ?? null, proposals: pending.map(proposalView), warnings };
  const lines = payload.proposals.map((p) => `• ${p.label}: ${p.proposedValue}${p.currentValue ? ` (on file: ${p.currentValue})` : ''} — ${Math.round(p.confidence * 100)}%${p.page ? `, page ${p.page}` : ''}${p.reasons.length ? ` — ${p.reasons.join('; ')}` : ''}`);
  const warningText = warnings.length ? `Warning: ${warnings.map((w) => (/[.!?]$/.test(w) ? w : `${w}.`)).join(' ')}\n` : '';
  return createNeedsYou(ctx, {
    kind: 'confirm_fields',
    claimId: item.claimId!,
    title: `${label}: ${filled} field${filled === 1 ? '' : 's'} filled, ${pending.length} need${pending.length === 1 ? 's' : ''} you`,
    summary: `${warningText}From ${ev?.filename ?? 'a document'}. Tick the values to apply; the rest are rejected.\n${lines.join('\n')}`.slice(0, 4000),
    recommendation: {
      action: 'Check each value against the document and apply the ones that are right',
      why: `${warningText}These overwrite a value on file, are personal details (date of birth, licence, policy number), add a person or vehicle, come from a document for another vehicle, or were read with less than 90% confidence.`.slice(0, 2000),
      confidence: Math.min(...pending.map((p) => p.confidence)),
      basis: [{ kind: 'evidence', id: item.evidenceId, label: ev?.filename ?? null }],
    },
    options: [
      { id: 'apply', label: 'Apply the ticked values', tone: 'primary' },
      { id: 'reject', label: 'Reject all', tone: 'danger', requiresReason: true },
    ],
    payload,
    priority: 'normal',
    createdBy: INTAKE_ACTOR.userId,
    dedupeKey: `confirm_fields:${item.id}`,
    ...(correlationId ? { correlationId } : {}),
    ...(runId ? { runId } : {}),
  });
}

/** A claim whose client or third-party vehicle has this registration (a suggestion for `new_claim`, never automatic). */
function claimByRegistration(ctx: AppContext, fields: ExtractedField[]): { id: string; reference: string; registration: string } | undefined {
  for (const f of fields) {
    if (!f.target || !/^vehicle:[a-z_]+\.registration$/.test(f.target) || !f.value) continue;
    const reg = normaliseVrm(f.value);
    const claims = ctx.repos.listClaimsForRegistration(ctx.db, reg);
    if (claims.length === 1) return { id: claims[0]!.id, reference: claims[0]!.reference, registration: reg };
  }
  return undefined;
}

export interface NewClaimPayload {
  itemId: string;
  evidenceId: string;
  docType: string | null;
  summary: string | null;
  suggestedClaim: { id: string; reference: string; registration: string } | null;
}

export function raiseNewClaimCard(ctx: AppContext, item: IntakeItemRecord, fields: ExtractedField[], summary: string | undefined, correlationId?: string): NeedsYouItem {
  const label = docTypeLabel(item.docType);
  const ev = ctx.repos.getEvidence(ctx.db, item.evidenceId);
  const suggested = claimByRegistration(ctx, fields);
  const payload: NewClaimPayload = { itemId: item.id, evidenceId: item.evidenceId, docType: item.docType ?? null, summary: summary ?? null, suggestedClaim: suggested ?? null };
  return createNeedsYou(ctx, {
    kind: 'new_claim',
    title: suggested ? `${label} — for ${suggested.reference}, or a new claim?` : `${label} with no claim — start a new claim?`,
    summary: `${ev?.filename ?? 'A document'} is not linked to a claim. ${summary ?? ''}${suggested ? `\nIts registration ${suggested.registration} is on ${suggested.reference}.` : ''}`.trim(),
    recommendation: suggested
      ? { action: `Attach it to ${suggested.reference}`, why: `The registration ${suggested.registration} matches that claim.`, confidence: 0.7, basis: [{ kind: 'evidence', id: item.evidenceId, label: ev?.filename ?? null }] }
      : { action: 'Start a claim from this document', why: 'It reads like the start of a new matter and no claim matches it. Opening a claim is always your decision.', confidence: 0.6, basis: [{ kind: 'evidence', id: item.evidenceId, label: ev?.filename ?? null }] },
    options: [
      { id: 'start', label: 'Prepare a new claim from it', tone: 'primary' },
      { id: 'attach', label: 'Attach to a claim…', tone: 'neutral', requiresEdit: true },
      { id: 'dismiss', label: 'Not a claim', tone: 'neutral' },
    ],
    payload,
    priority: 'normal',
    createdBy: INTAKE_ACTOR.userId,
    dedupeKey: `new_claim:${item.id}`,
    ...(correlationId ? { correlationId } : {}),
  });
}

export async function applyItem(ctx: AppContext, item: IntakeItemRecord, job: JobRecord, extractionId?: string): Promise<JobOutcome> {
  const extraction = extractionId ? ctx.repos.getIntakeExtraction(ctx.db, extractionId) : ctx.repos.latestIntakeExtraction(ctx.db, item.id);
  const fields = (extraction && Array.isArray(extraction.fields) ? extraction.fields : []) as ExtractedField[];

  if (!item.claimId) {
    if (item.docType && FNOL_LIKE_DOC_TYPES.has(item.docType) && !item.parentItemId) {
      const ny = raiseNewClaimCard(ctx, item, fields, extraction?.summary, job.correlationId);
      setStatus(ctx, item.id, 'needs_you');
      return { kind: 'done', result: { status: 'needs_you', needsYouId: ny.id } };
    }
    setStatus(ctx, item.id, 'proposed');
    return { kind: 'done', result: { status: 'proposed', reason: 'no claim — waiting on the Intake screen' } };
  }

  const { proposals, skipped } = proposeFromFields(ctx, { claimId: item.claimId, intakeItemId: item.id, evidenceId: item.evidenceId, ...(extraction ? { extractionId: extraction.id } : {}), ...(extraction?.runId ? { runId: extraction.runId } : {}), fields });
  // Tool-made proposals for the item count too.
  const pendingAuto = ctx.repos.listClaimUpdateProposals(ctx.db, { intakeItemId: item.id, status: 'pending', policyDecision: 'auto' }).filter((p) => p.claimId === item.claimId);
  const outcomes = pendingAuto.length ? await applyProposals(ctx, pendingAuto, agentApplier(ctx, { claimId: item.claimId, jobId: job.id, ...(extraction?.runId ? { runId: extraction.runId } : {}) })) : [];
  // An automatic apply the claim no longer allows becomes a confirmation (never a silent overwrite).
  for (const o of outcomes) {
    if (o.ok) continue;
    const p = ctx.repos.getClaimUpdateProposal(ctx.db, o.proposalId);
    if (p?.status === 'pending') ctx.repos.setClaimUpdateProposalPolicy(ctx.db, p.id, 'confirm', { decision: { error: `${o.error?.code}: ${o.error?.message}` }, policy: { ruleIds: [...(p.validator?.policy?.ruleIds ?? []), 'intake_apply_failed'], reasons: [...(p.validator?.policy?.reasons ?? []), `automatic apply refused: ${o.error?.message ?? 'unknown'}`] } });
  }
  const applied = outcomes.filter((o) => o.ok).length;
  const pendingConfirm = ctx.repos.listClaimUpdateProposals(ctx.db, { intakeItemId: item.id, status: 'pending', policyDecision: 'confirm' });
  const refused = proposals.filter((p) => p.policyDecision === 'never').length;
  let needsYouId: string | undefined;
  if (pendingConfirm.length) {
    needsYouId = raiseConfirmCard(ctx, ctx.repos.requireIntakeItem(ctx.db, item.id), pendingConfirm, applied, job.correlationId, proposals.filter((p) => p.policyDecision === 'never'), extraction?.runId).id;
    setStatus(ctx, item.id, 'needs_you');
  } else {
    setStatus(ctx, item.id, 'applied');
  }
  return { kind: 'done', result: { applied, confirm: pendingConfirm.length, refused, skipped: skipped.length, ...(needsYouId ? { needsYouId } : {}) } };
}

/** Owner rejected the remaining confirmations of an item: also used by the reject route. */
export function rejectRemaining(ctx: AppContext, itemId: string, actor: Actor, reason: string): number {
  const pending = ctx.repos.listClaimUpdateProposals(ctx.db, { intakeItemId: itemId, status: 'pending' });
  return rejectProposals(ctx, pending.map((p) => p.id), actor, reason).length;
}

/** Item status after the owner decided proposals (applied when nothing is pending). */
export function settleItemStatus(ctx: AppContext, itemId: string): void {
  const item = ctx.repos.getIntakeItem(ctx.db, itemId);
  if (!item || !item.claimId) return;
  const pending = ctx.repos.listClaimUpdateProposals(ctx.db, { intakeItemId: itemId, status: 'pending' });
  if (!pending.length && (item.status === 'needs_you' || item.status === 'proposed')) setStatus(ctx, itemId, 'applied');
}
