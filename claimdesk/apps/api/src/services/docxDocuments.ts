/**
 * DOCX claim documents (TEMPLATES-VEHICLES-DESKTOP §C.6): the values form for a claim and a template, and generation
 * of a filled Word document as a GeneratedDocument (format 'docx').
 *
 * Generation, step by step:
 *   1. the template row must be active and its warnings acknowledged (409 TEMPLATE_WARNINGS_UNACKNOWLEDGED); the bytes
 *      are re-hashed against the row (409 TEMPLATE_CHANGED) and re-scanned when the scanner version moved on;
 *   2. the effective mapping (built-in JSON ⊕ override, or the saved upload mapping) must validate (409 TEMPLATE_CHANGED);
 *   3. clocks are recomputed and the merge source is built from the claim;
 *   4. buildFillPlan — block issues stop generation (400 SLOT_NOT_FILLABLE / VALUES_REQUIRED, 409 GUARD_BLOCKED);
 *   5. fillDocx (core properties: "<template title> — <reference>");
 *   6. the preview HTML goes to documents.html and through the consistency engine under the canonical template id;
 *      flags that the unfilled template text raises too are cleared by the system (TEMPLATE_BASELINE), plan warnings
 *      become warn flags;
 *   7. the .docx is written to DOCUMENTS_DIR/<claimId>/<docId>.docx and one transaction creates (or supersedes) the
 *      draft, stores the consistency report and audits document.create.
 * The engine fills blanks; it never rewrites printed wording, and signature boxes are never filled.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalTemplateId, TEMPLATE_CLOCKS, type ClaimBundle, type ConsistencyCode, type ConsistencyFlag, type ConsistencyReport, type GeneratedDocument, type ISODateTime } from '@ccguk/domain';
import { buildFillPlan, docxToPreviewHtml, fillDocx, formatDateLong, SCANNER_VERSION, sha256Hex, type DocxScan, type FillPlan, type PlanRow, type SlotInput, type TemplateMapping, type VerificationStatus } from '@ccguk/documents';
import type { Actor, DocumentTemplateRow } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { badRequest, conflict, HttpError } from '../errors.js';
import type { ClaimTemplateValuesQuery, GenerateDocxBody } from '../schemas/docxTemplates.js';
import { loadBundle, recomputeClocks } from './claimView.js';
import { claimHeader, defaultRecipientRole, type RecipientRole } from './documentData.js';
import { runConsistency, type DocUser } from './documents.js';
import { effectiveMapping, scanCached, templateBytes, templateSummary, warningsAcknowledged, type DocxTemplateSummary } from './docxTemplates.js';
import { buildMergeSource, type MergeSubject } from './mergeSource.js';

export type { GenerateDocxBody };

/** The reproducibility record kept in documents.data_snapshot._docx (§C.3). */
export interface DocxSnapshot {
  templateId: string;
  templateSha256: string;
  fileVersion: number;
  mappingRevision: number;
  scannerVersion: number;
  variant?: string;
  subject?: MergeSubject;
  /** What the handler typed (re-used on supersede). */
  inputs: Record<string, SlotInput>;
  confirm: string[];
  values: Array<{ slotId: string; key?: string; label?: string; display: string; origin: PlanRow['origin']; verification?: VerificationStatus }>;
  removedBlocks: string[];
  docxSha256: string;
  /** Additive: who acknowledged the template warnings, and when (baseline suppression relies on it). */
  warningsAcknowledgedAt?: string;
  warningsAcknowledgedBy?: string;
  /** Additive: flags cleared because the unfilled template prints the same wording. */
  baselineSuppressed?: Array<{ code: string; excerpt?: string }>;
}

export interface ClaimTemplateValues {
  template: DocxTemplateSummary;
  claimId: string;
  variant?: string;
  subjects: {
    witnesses?: Array<{ id: string; name: string }>;
    offers?: Array<{ id: string; label: string }>;
    hires?: Array<{ id: string; label: string }>;
    recipients?: Array<{ partyId?: string; role: string; label: string }>;
    exhibits?: Array<{ id: string; label: string }>;
  };
  groups: Array<{ section: string; title: string; rows: PlanRow[] }>;
  issues: FillPlan['issues'];
  summary: { fromClaim: number; toConfirm: number; toEnter: number; leftForSigning: number; leftAsPrinted: number };
}

// ---------------------------------------------------------------------------
// Shared preparation
// ---------------------------------------------------------------------------

interface Prepared {
  row: DocumentTemplateRow;
  bytes: Uint8Array;
  scan: DocxScan;
  mapping: TemplateMapping;
  mappingIssues: ReturnType<typeof effectiveMapping>['issues'];
  shaOk: boolean;
  computedSha256: string;
  canonicalId: string;
  role: RecipientRole;
}

/** The template row for generation: missing or inactive → 404. */
export function requireActiveTemplate(ctx: AppContext, templateId: string): DocumentTemplateRow {
  const row = ctx.repos.getDocumentTemplate(ctx.db, templateId);
  if (!row || !row.active) throw new HttpError(404, 'TEMPLATE_NOT_FOUND', `Word template ${templateId} not found${row ? ' (it is switched off)' : ''}`, { templateId });
  return row;
}

function prepare(ctx: AppContext, templateId: string): Prepared {
  const row = requireActiveTemplate(ctx, templateId);
  const bytes = templateBytes(ctx, row);
  const computedSha256 = sha256Hex(Buffer.from(bytes));
  const shaOk = computedSha256 === row.sha256;
  // Re-scan when stale (the scan cache is keyed by the bytes' own hash, so a changed file is never read through a stale scan).
  const scan = scanCached(bytes, computedSha256);
  const eff = effectiveMapping(row, scan);
  const canonicalId = canonicalTemplateId(row.id);
  const role = (row.recipientRole as RecipientRole | undefined) ?? defaultRecipientRole(canonicalId);
  return { row, bytes, scan, mapping: eff.mapping, mappingIssues: eff.issues, shaOk, computedSha256, canonicalId, role };
}

function subjectFromQuery(q: ClaimTemplateValuesQuery): MergeSubject {
  const s: MergeSubject = {};
  if (q.witnessPartyId) s.witnessPartyId = q.witnessPartyId;
  if (q.offerId) s.offerId = q.offerId;
  if (q.hireAgreementId) s.hireAgreementId = q.hireAgreementId;
  if (q.recipientPartyId) s.recipientPartyId = q.recipientPartyId;
  const ex = (q.exhibitEvidenceIds ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (ex.length) s.exhibitEvidenceIds = ex;
  return s;
}

function sourceFor(ctx: AppContext, p: Prepared, claimId: string, user: DocUser, subject: MergeSubject, bundle: ClaimBundle, thisDocument?: GeneratedDocument) {
  const clockKinds = [...(TEMPLATE_CLOCKS[p.canonicalId] ?? [])];
  return buildMergeSource(ctx, claimId, user, subject, { recipientRole: p.role, deadlineClockKinds: clockKinds, bundle, ...(thisDocument ? { thisDocument } : {}) });
}

function subjectLists(ctx: AppContext, bundle: ClaimBundle, kinds: string[]): ClaimTemplateValues['subjects'] {
  const out: ClaimTemplateValues['subjects'] = {};
  if (kinds.includes('witness')) {
    const witnesses = bundle.thirdParties.filter((p) => p.roles.includes('witness'));
    out.witnesses = [{ id: bundle.claimant.id, name: `${bundle.claimant.name} (the client)` }, ...witnesses.map((w) => ({ id: w.id, name: w.name }))];
    out.exhibits = bundle.evidence.map((e) => ({ id: e.id, label: `${e.filename}${e.description ? ` — ${e.description}` : ''} (${e.kind})` }));
  }
  if (kinds.includes('offer')) {
    out.offers = bundle.offers.map((o) => ({ id: o.id, label: `${formatDateLong(o.receivedAt)} — ${o.offerorName}${o.vehicleClassOffered ? `, ${o.vehicleClassOffered}` : ''} (${o.clientDecision})` }));
  }
  if (kinds.includes('hire')) {
    out.hires = [...bundle.hire].sort((a, b) => b.startAt.localeCompare(a.startAt)).map((h) => ({ id: h.id, label: `${h.agreementNumber} — from ${formatDateLong(h.startAt)}${h.endAt ? ` to ${formatDateLong(h.endAt)}` : ' (open)'}` }));
  }
  if (kinds.includes('recipient')) {
    const r: NonNullable<ClaimTemplateValues['subjects']['recipients']> = [];
    if (bundle.atFaultInsurer) r.push({ partyId: bundle.atFaultInsurer.id, role: 'at_fault_insurer', label: `${bundle.atFaultInsurer.name} (third party insurer)` });
    r.push({ partyId: bundle.claimant.id, role: 'client', label: `${bundle.claimant.name} (the client)` });
    const own = bundle.claim.clientInsurerId ? ctx.repos.getParty(ctx.db, bundle.claim.clientInsurerId) : undefined;
    if (own) r.push({ partyId: own.id, role: 'own_insurer', label: `${own.name} (the client’s insurer)` });
    for (const p of bundle.thirdParties) if (!p.roles.includes('witness') && !r.some((x) => x.partyId === p.id)) r.push({ partyId: p.id, role: 'other', label: p.name });
    out.recipients = r;
  }
  return out;
}

function summarise(rows: PlanRow[]): ClaimTemplateValues['summary'] {
  const s = { fromClaim: 0, toConfirm: 0, toEnter: 0, leftForSigning: 0, leftAsPrinted: 0 };
  for (const r of rows) {
    if (r.policy === 'signature') s.leftForSigning += 1;
    else if (r.policy === 'never' || (r.policy === 'post-event' && r.display === '')) s.leftAsPrinted += 1;
    else if (r.needsConfirmation && !r.confirmed) s.toConfirm += 1;
    else if (r.display !== '' && r.origin !== 'handler') s.fromClaim += 1;
    else if (r.editable && r.display === '') s.toEnter += 1;
  }
  return s;
}

function grouped(rows: PlanRow[]): ClaimTemplateValues['groups'] {
  const groups: ClaimTemplateValues['groups'] = [];
  for (const r of rows) {
    let g = groups.find((x) => x.section === r.section);
    if (!g) {
      g = { section: r.section, title: r.sectionTitle || r.section, rows: [] };
      groups.push(g);
    }
    g.rows.push(r);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Values form (GET /claims/:id/docx-templates/:templateId/values)
// ---------------------------------------------------------------------------

export function claimTemplateValues(ctx: AppContext, claimId: string, templateId: string, user: DocUser, q: ClaimTemplateValuesQuery): ClaimTemplateValues {
  ctx.repos.requireClaim(ctx.db, claimId);
  const p = prepare(ctx, templateId);
  recomputeClocks(ctx, claimId);
  const bundle = loadBundle(ctx, claimId, true);
  const subject = subjectFromQuery(q);
  const source = sourceFor(ctx, p, claimId, user, subject, bundle);
  const plan = buildFillPlan(p.scan, p.mapping, source, { ...(q.variant ? { variant: q.variant } : {}) });
  const issues: FillPlan['issues'] = [...plan.issues];
  if (!warningsAcknowledged(p.row)) {
    issues.unshift({ code: 'TEMPLATE_WARNINGS_UNACKNOWLEDGED', severity: 'block', message: 'The template’s wording warnings have not been reviewed. Open the template in Settings → Document templates and confirm "I have reviewed this wording" before generating.' });
  }
  if (!p.shaOk) issues.unshift({ code: 'TEMPLATE_CHANGED', severity: 'block', message: 'The template file no longer matches the one that was checked in. Re-upload it (or reinstall the app for a built-in).' });
  const kinds = [...(p.mapping.subjects ?? [])];
  const out: ClaimTemplateValues = {
    template: templateSummary(ctx, p.row, { scan: p.scan, eff: { mapping: p.mapping, issues: p.mappingIssues } }),
    claimId,
    subjects: subjectLists(ctx, bundle, kinds),
    groups: grouped(plan.rows),
    issues,
    summary: summarise(plan.rows),
  };
  if (plan.variant) out.variant = plan.variant;
  return out;
}

// ---------------------------------------------------------------------------
// Generation (POST /claims/:id/docx-documents)
// ---------------------------------------------------------------------------

export interface CreateDocxDocumentInput {
  claimId: string;
  body: GenerateDocxBody;
  user: DocUser;
  actor: Actor;
  supersedes?: GeneratedDocument;
  reExecutedOn?: string;
  /** Re-generation: slot id → the value shown when it was confirmed (a changed figure needs confirming again). */
  confirmedDisplay?: Record<string, string>;
}

const norm = (s: string | undefined): string =>
  (s ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * Baseline suppression: a flag the unfilled template raises too (same code and the same offending text) is printed
 * wording, not something the handler or the claim data put there. It is cleared by the system with reason
 * TEMPLATE_BASELINE (multiset match, so an extra occurrence typed by a handler stays open).
 */
export function suppressBaseline(report: ConsistencyReport, baseline: ConsistencyReport, ack: { at?: string; by?: string }, now: ISODateTime): { report: ConsistencyReport; suppressed: Array<{ code: string; excerpt?: string }> } {
  // Each baseline flag can excuse one flag of the filled document: first by the same excerpt, then (a filled value
  // nearby changes the excerpt) by the same offending value.
  const pool = baseline.flags.map((f) => ({ x: `${f.code}|${norm(f.excerpt)}`, v: f.draftValue ? `${f.code}|${norm(f.draftValue)}` : undefined, used: false }));
  const matched = new Set<number>();
  const take = (i: number, pick: (b: (typeof pool)[number]) => boolean): void => {
    const b = pool.find((x) => !x.used && pick(x));
    if (!b) return;
    b.used = true;
    matched.add(i);
  };
  report.flags.forEach((f, i) => {
    if (!f.clearedAt && f.excerpt) take(i, (b) => b.x === `${f.code}|${norm(f.excerpt)}`);
  });
  report.flags.forEach((f, i) => {
    if (!f.clearedAt && !matched.has(i) && f.draftValue) take(i, (b) => b.v === `${f.code}|${norm(f.draftValue)}`);
  });
  const suppressed: Array<{ code: string; excerpt?: string }> = [];
  const who = ack.by ? ` Template warnings acknowledged by ${ack.by}${ack.at ? ` at ${ack.at}` : ''}.` : '';
  const flags = report.flags.map((f, i) => {
    if (!matched.has(i)) return f;
    suppressed.push({ code: f.code, ...(f.excerpt ? { excerpt: f.excerpt } : {}) });
    return { ...f, clearedAt: now, clearedBy: 'system', clearedReason: `TEMPLATE_BASELINE: the unfilled template prints the same wording; it is the template's own text, not a value filled from the claim.${who}` };
  });
  const blocked = flags.some((f) => f.severity === 'block' && !f.clearedAt);
  return { report: { ...report, flags, blocked }, suppressed };
}

function planError(blocks: FillPlan['issues']): HttpError {
  const details = { issues: blocks };
  const names = blocks.map((b) => b.message).join(' ');
  if (blocks.some((b) => b.code === 'SLOT_NOT_FILLABLE')) return new HttpError(400, 'SLOT_NOT_FILLABLE', `Some values cannot be typed into this template: ${names}`, details);
  if (blocks.some((b) => b.code === 'VALUES_REQUIRED')) return new HttpError(400, 'VALUES_REQUIRED', `Some required values are missing: ${names}`, details);
  if (blocks.some((b) => b.code === 'UNKNOWN_VARIANT')) return badRequest(names, details);
  return conflict('GUARD_BLOCKED', `The template cannot be generated: ${names}`, details);
}

/** Synchronous core (supersede in services/documents.ts is synchronous). */
export function createDocxClaimDocumentSync(ctx: AppContext, input: CreateDocxDocumentInput): GeneratedDocument {
  const { claimId, body } = input;
  ctx.repos.requireClaim(ctx.db, claimId);
  // 1. Template, acknowledgement, bytes
  const p = prepare(ctx, body.templateId);
  if (!warningsAcknowledged(p.row)) {
    throw conflict('TEMPLATE_WARNINGS_UNACKNOWLEDGED', `The wording warnings on "${p.row.title}" have not been reviewed. Confirm "I have reviewed this wording" on the template first.`, { templateId: p.row.id, warnings: p.row.warnings });
  }
  if (!p.shaOk) throw conflict('TEMPLATE_CHANGED', `The file behind "${p.row.title}" no longer matches the recorded sha256`, { templateId: p.row.id, recordedSha256: p.row.sha256, computedSha256: p.computedSha256 });
  // 2. Mapping
  if (p.mappingIssues.length) throw conflict('TEMPLATE_CHANGED', `The mapping of "${p.row.title}" no longer fits the template file; review it on the Templates screen`, { templateId: p.row.id, issues: p.mappingIssues });
  // 3. Clocks + merge source
  recomputeClocks(ctx, claimId);
  const bundle = loadBundle(ctx, claimId, true);
  const subject: MergeSubject = { ...(body.subject ?? {}) };
  const source = sourceFor(ctx, p, claimId, input.user, subject, bundle, input.supersedes);
  // 4. Plan
  const inputs = body.values ?? {};
  const confirm = body.confirm ?? [];
  const plan = buildFillPlan(p.scan, p.mapping, source, { values: inputs, confirm, ...(input.confirmedDisplay ? { confirmedDisplay: input.confirmedDisplay } : {}), ...(body.variant ? { variant: body.variant } : {}) });
  const blocks = plan.issues.filter((i) => i.severity === 'block');
  if (blocks.length) throw planError(blocks);
  // 5. Fill
  const now = ctx.now();
  const nowDate = new Date(now);
  const reference = bundle.claim.reference;
  const title = p.row.title;
  const filled = fillDocx(p.bytes, plan.instructions, {
    removeBlocks: plan.removeBlocks,
    coreProps: { title: `${title} — ${reference}`, subject: title, keywords: [reference, p.row.id], created: nowDate, modified: nowDate },
    now: nowDate,
    ...(p.mapping.style?.valueRun ? { valueRunStyle: p.mapping.style.valueRun } : {}),
    // a user's own template keeps its own font for the values; the CCGUK built-ins use their value style
    inheritValueStyle: p.row.source !== 'builtin',
  });
  // 6. Preview + consistency (canonical id), baseline suppression, plan warnings as flags
  const meta = { title, kind: p.row.kind, reference, date: now.slice(0, 10) };
  const html = docxToPreviewHtml(filled.docx, meta);
  const role: RecipientRole = subject.recipientPartyId && bundle.claim.clientInsurerId === subject.recipientPartyId ? 'own_insurer' : p.role;
  const checked = runConsistency(ctx, html, bundle, p.canonicalId, role, now);
  const baseline = runConsistency(ctx, docxToPreviewHtml(p.bytes, meta), bundle, p.canonicalId, role, now);
  const ack = { ...(p.row.warningsAcknowledgedAt ? { at: p.row.warningsAcknowledgedAt } : {}), ...(p.row.warningsAcknowledgedBy ? { by: p.row.warningsAcknowledgedBy } : {}) };
  const { report: suppressedReport, suppressed } = suppressBaseline(checked, baseline, ack, now);
  const planFlags: ConsistencyFlag[] = plan.issues
    .filter((i) => i.severity === 'warn')
    .map((i) => ({ code: i.code as ConsistencyCode, severity: 'warn' as const, message: i.message, ...(i.slotId ? { excerpt: i.slotId } : {}) }));
  const report: ConsistencyReport = { ...suppressedReport, flags: [...suppressedReport.flags, ...planFlags] };
  report.blocked = report.flags.some((f) => f.severity === 'block' && !f.clearedAt);
  // 7. Store the .docx and record the draft
  const docId = randomUUID();
  const docxRel = path.posix.join(claimId, `${docId}.docx`);
  const docxAbs = path.join(ctx.config.documentsDir, docxRel);
  mkdirSync(path.dirname(docxAbs), { recursive: true });
  writeFileSync(docxAbs, filled.docx, { flag: 'wx' });
  const snapshot: DocxSnapshot = {
    templateId: p.row.id,
    templateSha256: p.row.sha256,
    fileVersion: p.row.fileVersion,
    mappingRevision: p.row.mappingRevision,
    scannerVersion: SCANNER_VERSION,
    ...(plan.variant ? { variant: plan.variant } : {}),
    ...(Object.keys(subject).length ? { subject } : {}),
    inputs,
    confirm,
    values: plan.rows.map((r) => ({ slotId: r.slotId, ...(r.key ? { key: r.key } : {}), label: r.label, display: r.display, origin: r.origin, ...(r.verification ? { verification: r.verification } : {}) })),
    removedBlocks: plan.removeBlocks,
    docxSha256: filled.sha256,
    ...(p.row.warningsAcknowledgedAt ? { warningsAcknowledgedAt: p.row.warningsAcknowledgedAt } : {}),
    ...(p.row.warningsAcknowledgedBy ? { warningsAcknowledgedBy: p.row.warningsAcknowledgedBy } : {}),
    ...(suppressed.length ? { baselineSuppressed: suppressed } : {}),
  };
  const settings = ctx.settings();
  const dataSnapshot: Record<string, unknown> = {
    _docx: snapshot,
    templateId: p.row.id,
    canonicalTemplateId: p.canonicalId,
    date: now,
    claim: claimHeader(bundle),
    settings: { companyName: settings.companyName, companyNumber: settings.companyNumber, bankOnFile: Boolean(settings.bank?.sortCode && settings.bank.accountNumber) },
    ...(source.recipient ? { recipient: source.recipient } : {}),
  };
  try {
    return ctx.db.transaction((tx) => {
      const recipientPartyId = source.recipient?.partyId;
      const draftInput = {
        id: docId,
        claimId,
        templateId: p.row.id,
        templateVersion: `${p.row.fileVersion}.${p.row.mappingRevision}.0`,
        title,
        ...(recipientPartyId ? { recipientPartyId } : {}),
        html,
        sha256: filled.sha256,
        dataSnapshot,
        createdBy: input.user.id,
        createdAt: now,
        format: 'docx' as const,
        docxPath: docxRel,
        docxSha256: filled.sha256,
        ...(input.supersedes ? { reExecutedOn: input.reExecutedOn ?? now.slice(0, 10) } : {}),
      };
      const doc = input.supersedes ? ctx.repos.supersedeDocument(tx, input.supersedes.id, input.actor, draftInput, { reExecutedOn: draftInput.reExecutedOn }) : ctx.repos.createDraft(tx, draftInput);
      const stored = ctx.repos.setConsistency(tx, doc.id, report);
      ctx.repos.appendAudit(tx, {
        actor: input.actor,
        action: 'document.create',
        entity: 'documents',
        entityId: doc.id,
        after: {
          claimId,
          templateId: doc.templateId,
          templateVersion: doc.templateVersion,
          status: stored.status,
          format: 'docx',
          templateSha256: p.row.sha256,
          docxSha256: filled.sha256,
          variant: plan.variant,
          blocked: report.blocked,
          flags: report.flags.map((f) => f.code),
          baselineSuppressed: suppressed.length ? suppressed.map((s) => s.code) : undefined,
          supersedes: input.supersedes?.id,
        },
        at: now,
      });
      return stored;
    });
  } catch (err) {
    rmSync(docxAbs, { force: true });
    throw err;
  }
}

export async function createDocxClaimDocument(ctx: AppContext, input: CreateDocxDocumentInput): Promise<GeneratedDocument> {
  return createDocxClaimDocumentSync(ctx, input);
}

/** Supersede a DOCX document: the previous inputs/confirmations/subject, with any new values on top (§C.6). */
export function supersedeDocxDocument(ctx: AppContext, old: GeneratedDocument, extra: { values?: Record<string, SlotInput>; confirm?: string[]; reExecutedOn?: string }, user: DocUser, actor: Actor): GeneratedDocument {
  if (!old.claimId) throw conflict('DOCUMENT_STATE', 'Standalone documents are re-created rather than superseded');
  const prev = (old.dataSnapshot?._docx ?? undefined) as DocxSnapshot | undefined;
  if (!prev) throw conflict('DOCUMENT_STATE', `Document ${old.id} has no DOCX generation record and cannot be re-generated`);
  const body: GenerateDocxBody = {
    templateId: old.templateId,
    ...(prev.variant ? { variant: prev.variant } : {}),
    ...(prev.subject ? { subject: prev.subject } : {}),
    values: { ...(prev.inputs ?? {}), ...(extra.values ?? {}) },
    confirm: [...new Set([...(prev.confirm ?? []), ...(extra.confirm ?? [])])],
  };
  // A carried-over confirmation covers the figure the handler saw, not whatever the slot resolves to now: a GTA
  // benchmark or suggestion that has changed since is left blank until confirmed again (confirmed afresh = extra).
  const fresh = new Set(extra.confirm ?? []);
  const confirmedDisplay: Record<string, string> = {};
  for (const slotId of prev.confirm ?? []) {
    if (fresh.has(slotId)) continue;
    const shown = prev.values?.find((v) => v.slotId === slotId)?.display;
    if (shown !== undefined) confirmedDisplay[slotId] = shown;
  }
  return createDocxClaimDocumentSync(ctx, { claimId: old.claimId, body, user, actor, supersedes: old, confirmedDisplay, ...(extra.reExecutedOn ? { reExecutedOn: extra.reExecutedOn } : {}) });
}
