/**
 * Engineering routes: estimates (lines, totals, import, reconcile, approve → labour library), labour-library suggest/add,
 * PAV (comparables captured manually, assess, approve), engineer's report (create/update, checklist, issue → report_issued
 * event + report.engineer document), total loss (assess, predict).
 */
import type { FastifyInstance } from 'fastify';
import { assessPav, computeTotals, LIBRARY_MIN_OBSERVATIONS, reconcile, type Comparable, type Estimate, type EstimateLine, type PavSubject } from '@ccguk/domain';
import type { Actor } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { badRequest, conflict, HttpError } from '../errors.js';
import { parse } from '../schemas/common.js';
import { comparableBody, engineerReportBody, estimateBody, estimateImportBody, estimatePatchBody, issueReportBody, labourAddBody, labourSuggestQuery, pavBody, reconcileBody, totalLossAssessBody, totalLossPredictBody, type EstimateLineInput } from '../schemas/services.js';
import { loadBundle, recomputeClocks } from '../services/claimView.js';
import { createClaimDocument } from '../services/documents.js';
import { assessTotalLoss, engineerReportChecklist, extractLinesProvider, predictTotalLoss } from '../services/engineeringFallbacks.js';
import { gtaRatesFor } from '../services/kb.js';
import { gateFor } from '../services/override.js';
import { applyEventSideEffects } from '../services/sideEffects.js';
import { assertHuman } from '../services/humanOnly.js';
import { params, requireClaim } from './helpers.js';
import { gtaRate } from '@ccguk/domain';

/** Per-route body limit of POST /claims/:id/estimate/import (other JSON routes keep the 2 MiB app limit). */
export const ESTIMATE_IMPORT_BODY_LIMIT = 16 * 1024 * 1024;

function toLines(ctx: AppContext, inputs: EstimateLineInput[]): EstimateLine[] {
  return inputs.map((l) => ({ ...l, id: l.id ?? ctx.repos.newId() }));
}

function withTotals(e: Omit<Estimate, 'totals'> & { totals?: Estimate['totals'] }): Estimate {
  return { ...e, totals: computeTotals(e) };
}

export function registerEngineeringRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ----- Estimates -----------------------------------------------------------
  app.get('/claims/:id/estimate', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const latest = ctx.repos.getLatestEstimate(ctx.db, id);
    return latest ?? null;
  });
  app.get('/claims/:id/estimates', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    return { items: ctx.repos.listEstimates(ctx.db, id) };
  });

  app.post('/claims/:id/estimate', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const claim = requireClaim(ctx, id);
    const body = parse(estimateBody, request.body);
    const now = ctx.now();
    const settings = ctx.settings();
    const draft = withTotals({
      id: ctx.repos.newId(),
      claimId: id,
      vehicleId: body.vehicleId ?? claim.clientVehicleId,
      lines: toLines(ctx, body.lines),
      labourRatePence: body.labourRatePence,
      paintRatePence: body.paintRatePence ?? body.labourRatePence,
      paintMaterialsMethod: body.paintMaterialsMethod,
      paintMaterialsPerHourPence: body.paintMaterialsPerHourPence,
      vatRate: body.vatRate ?? settings.rateCard.vatRate,
      importedFromEvidenceId: body.importedFromEvidenceId,
      importedTotalPence: body.importedTotalPence,
      createdAt: now,
    });
    const estimate = ctx.db.transaction((tx) => {
      const e = ctx.repos.createEstimate(tx, { ...draft, reconciled: draft.importedTotalPence !== undefined ? reconcile(draft, draft.importedTotalPence).reconciled : undefined });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'estimate.create', entity: 'estimates', entityId: e.id, after: { claimId: id, lines: e.lines.length, netPence: e.totals.netPence }, at: now });
      return e;
    });
    return reply.status(201).send(estimate);
  });

  app.patch('/claims/:id/estimate/:eid', async (request) => {
    const { id, eid } = params<{ id: string; eid: string }>(request);
    requireClaim(ctx, id);
    const body = parse(estimatePatchBody, request.body);
    const before = ctx.repos.requireEstimate(ctx.db, eid);
    if (before.claimId !== id) throw conflict('WRONG_CLAIM', 'Estimate belongs to another claim');
    if (before.approvedBy) throw conflict('ESTIMATE_APPROVED', 'An approved estimate is not edited — create a new estimate');
    const merged = withTotals({
      ...before,
      ...(body.lines ? { lines: toLines(ctx, body.lines) } : {}),
      ...(body.labourRatePence !== undefined ? { labourRatePence: body.labourRatePence } : {}),
      ...(body.paintRatePence !== undefined ? { paintRatePence: body.paintRatePence } : {}),
      ...(body.paintMaterialsMethod ? { paintMaterialsMethod: body.paintMaterialsMethod } : {}),
      ...(body.paintMaterialsPerHourPence !== undefined ? { paintMaterialsPerHourPence: body.paintMaterialsPerHourPence } : {}),
      ...(body.vatRate !== undefined ? { vatRate: body.vatRate } : {}),
      ...(body.importedTotalPence !== undefined ? { importedTotalPence: body.importedTotalPence } : {}),
      ...(body.importedFromEvidenceId ? { importedFromEvidenceId: body.importedFromEvidenceId } : {}),
    });
    const now = ctx.now();
    return ctx.db.transaction((tx) => {
      const { id: _i, claimId: _c, createdAt: _t, ...patch } = merged;
      const e = ctx.repos.updateEstimate(tx, eid, { ...patch, reconciled: merged.importedTotalPence !== undefined ? reconcile(merged, merged.importedTotalPence).reconciled : undefined });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'estimate.update', entity: 'estimates', entityId: eid, before: { netPence: before.totals.netPence, lines: before.lines.length }, after: { netPence: e.totals.netPence, lines: e.lines.length }, at: now });
      return e;
    });
  });

  /** Estimate text from big Audatex/bodyshop PDFs: per-route body limit 16 MiB (SUPREME §0.3, §R.2 step 1). */
  app.post('/claims/:id/estimate/import', { bodyLimit: ESTIMATE_IMPORT_BODY_LIMIT }, async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const claim = requireClaim(ctx, id);
    const body = parse(estimateImportBody, request.body);
    let text = body.text ?? '';
    if (!text.trim() && body.evidenceId) {
      const ev = ctx.repos.requireEvidence(ctx.db, body.evidenceId);
      if (!ev.mime.startsWith('text/')) {
        throw new HttpError(422, 'PDF_TEXT_REQUIRED', 'PDF → text is not performed server-side: extract the text in the browser (pdf.js) or through the optional extraction provider and import the text, keeping the PDF as evidence.', { evidenceId: ev.id, mime: ev.mime, provider: extractLinesProvider().name });
      }
      const { absoluteEvidencePath } = await import('../services/evidence.js');
      const { readFileSync } = await import('node:fs');
      text = readFileSync(absoluteEvidencePath(ctx, ev.storagePath), 'utf8');
    }
    const extracted = await extractLinesProvider().extract({ text });
    if (!extracted.lines.length) throw badRequest('No estimate lines could be parsed from the text', { note: extracted.note });
    const settings = ctx.settings();
    const now = ctx.now();
    const labourRate = body.labourRatePence ?? extracted.lines.find((l) => l.kind === 'labour' && l.ratePence)?.ratePence ?? 0;
    const draft = withTotals({
      id: ctx.repos.newId(),
      claimId: id,
      vehicleId: claim.clientVehicleId,
      lines: extracted.lines.map((l) => ({ ...l, source: 'import' as const, confirmedByEngineer: false })),
      labourRatePence: labourRate,
      paintRatePence: body.paintRatePence ?? labourRate,
      paintMaterialsMethod: body.paintMaterialsMethod ?? 'paint_system',
      paintMaterialsPerHourPence: body.paintMaterialsPerHourPence,
      vatRate: settings.rateCard.vatRate,
      importedFromEvidenceId: body.evidenceId,
      importedTotalPence: body.importedTotalPence,
      createdAt: now,
    });
    const reconciliation = body.importedTotalPence !== undefined ? reconcile(draft, body.importedTotalPence) : undefined;
    const estimate = ctx.db.transaction((tx) => {
      const e = ctx.repos.createEstimate(tx, { ...draft, reconciled: reconciliation?.reconciled });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'estimate.import', entity: 'estimates', entityId: e.id, after: { claimId: id, lines: e.lines.length, provider: extracted.provider, evidenceId: body.evidenceId, reconciled: reconciliation?.reconciled }, at: now });
      return e;
    });
    return reply.status(201).send({ estimate, reconciliation, provider: extracted.provider, note: 'Imported lines are unconfirmed until the engineer confirms each one.' });
  });

  app.post('/claims/:id/estimate/:eid/reconcile', async (request) => {
    const { id, eid } = params<{ id: string; eid: string }>(request);
    requireClaim(ctx, id);
    const body = parse(reconcileBody, request.body ?? {}) ?? {};
    const e = ctx.repos.requireEstimate(ctx.db, eid);
    const total = body.importedTotalPence ?? e.importedTotalPence;
    if (total === undefined) throw badRequest('importedTotalPence is required (none stored on the estimate)');
    const result = reconcile(e, total, body.tolerancePence);
    const now = ctx.now();
    ctx.db.transaction((tx) => {
      ctx.repos.updateEstimate(tx, eid, { importedTotalPence: total, reconciled: result.reconciled });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'estimate.reconcile', entity: 'estimates', entityId: eid, after: { importedTotalPence: total, ok: result.reconciled }, at: now });
    });
    return { estimateId: eid, ...result };
  });

  app.post('/claims/:id/estimate/:eid/approve', async (request) => {
    const { id, eid } = params<{ id: string; eid: string }>(request);
    assertHuman(request.actor, 'approve an estimate');
    requireClaim(ctx, id);
    const e = ctx.repos.requireEstimate(ctx.db, eid);
    if (e.claimId !== id) throw conflict('WRONG_CLAIM', 'Estimate belongs to another claim');
    if (e.approvedBy) throw conflict('ESTIMATE_APPROVED', `Already approved by ${e.approvedBy}`);
    const unconfirmed = e.lines.filter((l) => !l.confirmedByEngineer && !l.preExisting);
    if (unconfirmed.length) {
      gateFor(ctx, request).refuse(conflict('LINES_UNCONFIRMED', `${unconfirmed.length} line(s) are not confirmed by the engineer`, { lineIds: unconfirmed.map((l) => l.id) }), { claimId: id, entity: 'estimates', entityId: eid });
    }
    const now = ctx.now();
    return ctx.db.transaction((tx) => {
      const approved = ctx.repos.updateEstimate(tx, eid, { approvedBy: request.user.id });
      const added = addToLabourLibrary(ctx, tx, approved);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'estimate.approve', entity: 'estimates', entityId: eid, after: { approvedBy: request.user.id, labourEntriesAdded: added }, at: now });
      return { ...approved, labourEntriesAdded: added };
    });
  });

  // ----- Labour library --------------------------------------------------------
  app.get('/engineering/labour-library/suggest', async (request) => {
    const q = parse(labourSuggestQuery, request.query);
    const stats = ctx.repos.labourStats(ctx.db, q);
    return {
      items: stats.map((s) => ({ ...s, suggestedHours: s.count >= LIBRARY_MIN_OBSERVATIONS ? s.medianHours : null, note: s.count >= LIBRARY_MIN_OBSERVATIONS ? `Median of ${s.count} approved CCGUK estimates` : `Only ${s.count} approved observation(s); ${LIBRARY_MIN_OBSERVATIONS} needed before a median is offered` })),
      total: ctx.repos.countLabourEntries(ctx.db),
      basis: 'Medians of CCGUK’s own approved estimates (BLUEPRINT §4.5(c)); no third-party times table.',
    };
  });
  app.get('/engineering/labour-library', async () => ({ items: ctx.repos.listLabourEntries(ctx.db), total: ctx.repos.countLabourEntries(ctx.db) }));
  app.post('/engineering/labour-library', async (request, reply) => {
    const body = parse(labourAddBody, request.body);
    const e = ctx.repos.requireEstimate(ctx.db, body.estimateId);
    if (!e.approvedBy) throw conflict('ESTIMATE_NOT_APPROVED', 'Only approved estimates feed the labour library');
    const now = ctx.now();
    const added = ctx.db.transaction((tx) => {
      const n = addToLabourLibrary(ctx, tx, e);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'labour_library.add', entity: 'labour_library', entityId: e.id, after: { estimateId: e.id, added: n }, at: now });
      return n;
    });
    return reply.status(201).send({ estimateId: e.id, added, total: ctx.repos.countLabourEntries(ctx.db) });
  });

  // ----- PAV -----------------------------------------------------------------
  app.get('/claims/:id/pav', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    return ctx.repos.getLatestPav(ctx.db, id) ?? null;
  });

  const runAssessment = (claimId: string, subjectOverride: Partial<PavSubject> | undefined, comps: Comparable[], opts: { tradeGuidePence?: number; tradeGuideSource?: string; override?: { pavPence: number; reason: string }; iqrMultiplier?: number; filter?: Record<string, unknown> }, action: string, actor: Actor) => {
    const bundle = loadBundle(ctx, claimId);
    const latest = bundle.pav;
    const subject = { ...defaultSubject(bundle), ...(latest?.subject ?? {}), ...(subjectOverride ?? {}) } as PavSubject;
    const now = ctx.now();
    let result: ReturnType<typeof assessPav> | undefined;
    let warnings: string[] = [];
    if (comps.length) {
      result = assessPav(subject, comps, { ...(opts.filter ?? {}), claimId, now, tradeGuidePence: opts.tradeGuidePence ?? latest?.tradeGuidePence, tradeGuideSource: opts.tradeGuideSource ?? latest?.tradeGuideSource, override: opts.override, iqrMultiplier: opts.iqrMultiplier });
      warnings = result.warnings;
    }
    return ctx.db.transaction((tx) => {
      const pav = ctx.repos.createPav(tx, result
        ? { claimId, subject: result.subject, comparables: result.comparables, perMilePence: result.perMilePence, perMileSource: result.perMileSource, medianPence: result.medianPence, iqrLowPence: result.iqrLowPence, iqrHighPence: result.iqrHighPence, tradeGuidePence: result.tradeGuidePence, tradeGuideSource: result.tradeGuideSource, pavPence: result.pavPence, overrideReason: result.overrideReason, reasoning: result.reasoning, createdAt: now }
        : { claimId, subject, comparables: comps, perMilePence: 0, perMileSource: 'fallback_band', medianPence: 0, iqrLowPence: 0, iqrHighPence: 0, tradeGuidePence: opts.tradeGuidePence, tradeGuideSource: opts.tradeGuideSource, pavPence: 0, reasoning: 'No comparables captured yet — add dated adverts (URL + screenshot/PDF) and assess.', createdAt: now });
      ctx.repos.appendAudit(tx, { actor, action, entity: 'pav_assessments', entityId: pav.id, after: { claimId, comparables: comps.length, medianPence: pav.medianPence, pavPence: pav.pavPence, overrideReason: pav.overrideReason }, at: now });
      return { ...pav, auditTrail: result?.auditTrail ?? [], warnings, keptCount: result?.keptCount, consideredCount: result?.consideredCount ?? comps.length, vatNote: result?.vatNote };
    });
  };

  app.post('/claims/:id/pav', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(pavBody, request.body ?? {});
    const comps = (body.comparables ?? []).map((c) => ({ ...c, id: ctx.repos.newId(), capturedAt: c.capturedAt ?? ctx.now() }) as Comparable);
    return reply.status(201).send(runAssessment(id, body.subject as Partial<PavSubject> | undefined, comps, body, 'pav.create', request.actor));
  });

  app.post('/claims/:id/pav/comparables', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(comparableBody, request.body);
    const latest = ctx.repos.getLatestPav(ctx.db, id);
    let capturedAt = body.capturedAt;
    if (body.evidenceId) {
      const ev = ctx.repos.requireEvidence(ctx.db, body.evidenceId);
      if (ev.claimId && ev.claimId !== id) throw conflict('WRONG_CLAIM', 'Evidence belongs to another claim');
      capturedAt = capturedAt ?? ev.capturedAt ?? ev.uploadedAt;
    }
    const comparable = { ...body, id: ctx.repos.newId(), capturedAt: capturedAt ?? ctx.now() } as Comparable;
    const comps = [...(latest?.comparables ?? []).map((c) => ({ ...c, normalisedPricePence: undefined, excluded: undefined, exclusionReason: undefined })), comparable];
    return reply.status(201).send(runAssessment(id, undefined, comps, {}, 'pav.comparable.add', request.actor));
  });

  app.post('/claims/:id/pav/assess', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(pavBody, request.body ?? {});
    const latest = ctx.repos.getLatestPav(ctx.db, id);
    const comps = (body.comparables?.map((c) => ({ ...c, id: ctx.repos.newId(), capturedAt: c.capturedAt ?? ctx.now() }) as Comparable) ?? latest?.comparables.map((c) => ({ ...c, normalisedPricePence: undefined, excluded: undefined, exclusionReason: undefined })) ?? []);
    if (!comps.length) throw conflict('NO_COMPARABLES', 'Add comparables (manually captured adverts) before assessing');
    return runAssessment(id, body.subject as Partial<PavSubject> | undefined, comps, body, 'pav.assess', request.actor);
  });

  app.post('/claims/:id/pav/:pid/approve', async (request) => {
    const { id, pid } = params<{ id: string; pid: string }>(request);
    assertHuman(request.actor, 'approve a PAV');
    requireClaim(ctx, id);
    const pav = ctx.repos.requirePav(ctx.db, pid);
    if (pav.claimId !== id) throw conflict('WRONG_CLAIM', 'PAV belongs to another claim');
    const retained = pav.comparables.filter((c) => !c.excluded).length;
    if (retained < 3) {
      gateFor(ctx, request).refuse(conflict('TOO_FEW_COMPARABLES', 'At least three retained comparables are needed before a PAV is approved', { retained }), { claimId: id, entity: 'pav_assessments', entityId: pid });
    }
    const now = ctx.now();
    return ctx.db.transaction((tx) => {
      const approved = ctx.repos.approvePav(tx, pid, request.user.id, now);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'pav.approve', entity: 'pav_assessments', entityId: pid, after: { pavPence: approved.pavPence, approvedBy: request.user.id }, at: now });
      return approved;
    });
  });

  // ----- Engineer's report ---------------------------------------------------
  app.get('/claims/:id/engineer-report', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    return ctx.repos.getLatestEngineerReport(ctx.db, id) ?? null;
  });

  app.post('/claims/:id/engineer-report', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const claim = requireClaim(ctx, id);
    const body = parse(engineerReportBody, request.body ?? {});
    const settings = ctx.settings();
    const now = ctx.now();
    const engineerPartyId = body.engineerPartyId ?? ctx.repos.listParties(ctx.db, { roles: ['engineer'], limit: 1 })[0]?.id;
    if (!engineerPartyId) throw badRequest('engineerPartyId is required (no party with the engineer role exists)');
    const latestEstimate = ctx.repos.getLatestEstimate(ctx.db, id);
    const latestPav = ctx.repos.getLatestPav(ctx.db, id);
    const report = ctx.db.transaction((tx) => {
      const r = ctx.repos.createEngineerReport(tx, {
        claimId: id,
        vehicleId: body.vehicleId ?? claim.clientVehicleId,
        engineerPartyId,
        engineerQualifications: body.engineerQualifications ?? '',
        instructedBy: body.instructedBy ?? settings.companyName,
        instructedAt: body.instructedAt ?? now,
        inspectionAt: body.inspectionAt,
        inspectionPlace: body.inspectionPlace,
        inspectionBasis: body.inspectionBasis ?? 'physical',
        inspectionConditions: body.inspectionConditions,
        odometerMiles: body.odometerMiles,
        preAccidentCondition: body.preAccidentCondition ?? '',
        damageDescription: body.damageDescription ?? '',
        consistentWithCircumstances: body.consistentWithCircumstances ?? true,
        consistencyNote: body.consistencyNote,
        repairMethod: body.repairMethod,
        estimateId: body.estimateId ?? latestEstimate?.id,
        roadworthy: body.roadworthy ?? false,
        roadworthyReason: body.roadworthyReason ?? '',
        repairDurationWorkingDays: body.repairDurationWorkingDays,
        pavAssessmentId: body.pavAssessmentId ?? latestPav?.id,
        salvageCategory: body.salvageCategory,
        salvageValuePence: body.salvageValuePence,
        adasNotes: body.adasNotes,
        evNotes: body.evNotes,
        diagnosticFaultCodes: body.diagnosticFaultCodes,
        photoEvidenceIds: body.photoEvidenceIds ?? ctx.repos.listEvidenceForClaim(tx, id, { kind: 'photo' }).map((e) => e.id),
        forCourt: body.forCourt ?? false,
        feePence: body.feePence ?? settings.rateCard.engineerFeePence,
        createdAt: now,
      });
      if (!ctx.repos.firstEventOfType(tx, id, 'engineer_instructed')) ctx.repos.appendEvent(tx, { claimId: id, type: 'engineer_instructed', at: r.instructedAt, summary: `Engineer instructed (${r.instructedBy})`, data: { reportId: r.id }, attributableTo: 'ccguk', createdBy: request.user.id, recordedAt: now });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'engineer_report.create', entity: 'engineer_reports', entityId: r.id, after: { claimId: id, engineerPartyId, inspectionBasis: r.inspectionBasis }, at: now });
      return r;
    });
    recomputeClocks(ctx, id);
    return reply.status(201).send(report);
  });

  app.patch('/claims/:id/engineer-report/:rid', async (request) => {
    const { id, rid } = params<{ id: string; rid: string }>(request);
    requireClaim(ctx, id);
    const body = parse(engineerReportBody, request.body ?? {});
    const before = ctx.repos.requireEngineerReport(ctx.db, rid);
    if (before.claimId !== id) throw conflict('WRONG_CLAIM', 'Report belongs to another claim');
    if (before.issuedAt) throw conflict('REPORT_ISSUED', 'An issued report is not edited — issue a supplementary report');
    const now = ctx.now();
    return ctx.db.transaction((tx) => {
      const r = ctx.repos.updateEngineerReport(tx, rid, body);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'engineer_report.update', entity: 'engineer_reports', entityId: rid, after: body, at: now });
      return r;
    });
  });

  app.get('/claims/:id/engineer-report/checklist', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const bundle = loadBundle(ctx, id);
    if (!bundle.report) return { complete: false, missing: ['report'], items: [] };
    return engineerReportChecklist(bundle.report, bundle, bundle.estimate);
  });

  app.post('/claims/:id/engineer-report/:rid/issue', async (request) => {
    const { id, rid } = params<{ id: string; rid: string }>(request);
    assertHuman(request.actor, "issue an engineer's report");
    requireClaim(ctx, id);
    const report = ctx.repos.requireEngineerReport(ctx.db, rid);
    if (report.claimId !== id) throw conflict('WRONG_CLAIM', 'Report belongs to another claim');
    if (report.issuedAt) throw conflict('REPORT_ISSUED', `Report already issued at ${report.issuedAt}`);
    const bundle = loadBundle(ctx, id);
    const checklist = engineerReportChecklist(report, bundle, bundle.estimate);
    // `force` is still accepted but no longer bypasses on its own: an incomplete checklist is overridden only through the
    // gate in manager mode (0.3 §A.6 B32), and the event records it.
    parse(issueReportBody, request.body ?? {});
    const gate = gateFor(ctx, request);
    let forced = false;
    if (!checklist.complete) {
      gate.refuse(conflict('CHECKLIST_INCOMPLETE', `The report checklist is incomplete: ${checklist.missing.join(', ')}`, { missing: checklist.missing, items: checklist.items }), { claimId: id, entity: 'engineer_reports', entityId: rid });
      forced = true;
    }
    const now = ctx.now();
    const { issued, event, effects } = ctx.db.transaction((tx) => {
      const r = ctx.repos.issueEngineerReport(tx, rid, { issuedAt: now });
      const e = ctx.repos.appendEvent(tx, { claimId: id, type: 'report_issued', at: now, summary: `Engineer’s report issued${report.totalLoss?.decision === 'total_loss' ? ' — total loss' : ''}`, data: { reportId: rid, ...(forced ? { forced: true, overrideReason: gate.reason } : {}) }, attributableTo: 'engineer', createdBy: request.user.id, recordedAt: now });
      const fx = applyEventSideEffects({ ...ctx, db: tx }, e, request.actor);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'engineer_report.issue', entity: 'engineer_reports', entityId: rid, after: { issuedAt: now, eventId: e.id, checklistComplete: checklist.complete }, at: now });
      return { issued: r, event: e, effects: fx };
    });
    let document: unknown;
    let documentNote: string | undefined;
    try {
      const doc = createClaimDocument(ctx, { claimId: id, templateId: 'report.engineer', user: request.user, actor: request.actor });
      ctx.db.transaction((tx) => {
        ctx.repos.updateEngineerReport(tx, rid, { documentId: doc.id });
        ctx.repos.appendAudit(tx, { actor: request.actor, action: 'engineer_report.document', entity: 'engineer_reports', entityId: rid, after: { documentId: doc.id, templateId: 'report.engineer' }, at: ctx.now() });
      });
      document = doc;
    } catch (err) {
      if (err instanceof HttpError && (err.code === 'TEMPLATE_NOT_FOUND' || err.statusCode === 400)) documentNote = `report.engineer document not generated: ${err.message}`;
      else throw err;
    }
    const clocks = recomputeClocks(ctx, id);
    return { report: { ...issued, documentId: (document as { id?: string } | undefined)?.id ?? issued.documentId }, event, effects, document: document ?? null, documentNote, clocks };
  });

  // ----- Total loss ----------------------------------------------------------
  app.post('/claims/:id/total-loss/assess', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(totalLossAssessBody, request.body ?? {});
    const bundle = loadBundle(ctx, id);
    const settings = ctx.settings();
    const repairNet = body.repairNetPence ?? bundle.estimate?.totals.netPence;
    if (repairNet === undefined) throw badRequest('repairNetPence is required (no estimate on the claim)');
    const pav = body.pavPence ?? bundle.pav?.pavPence;
    if (pav === undefined) throw badRequest('pavPence is required (no PAV assessment on the claim)');
    const salvage = body.salvagePence ?? bundle.report?.salvageValuePence;
    if (salvage === undefined) throw badRequest('salvagePence is required — the actual bid/offer or the engineer’s estimate, never a fixed percentage');
    const hire = [...bundle.hire].sort((a, b) => b.startAt.localeCompare(a.startAt))[0];
    const group = hire?.gtaGroup ?? bundle.vehicle.gtaGroup ?? 'S1';
    const benchmark = gtaRate(group, ctx.now(), gtaRatesFor(ctx));
    const hireDaily = body.hireDailyRatePence ?? hire?.dailyRatePence ?? benchmark?.dailyRatePence ?? 0;
    const storageOpen = bundle.storage.some((s) => !s.endAt);
    const estimateHours = bundle.estimate ? bundle.estimate.totals.labourHours + bundle.estimate.totals.paintHours : 0;
    const repairDays = body.projectedRepairWorkingDays ?? bundle.report?.repairDurationWorkingDays ?? (estimateHours ? Math.ceil(estimateHours / 6) + 5 : 10);
    const assessment = assessTotalLoss({
      repairNetPence: repairNet,
      projectedRepairWorkingDays: repairDays,
      hireDailyRatePence: hireDaily,
      storageDailyRatePence: body.storageDailyRatePence ?? bundle.storage[0]?.dailyRatePence ?? settings.rateCard.storageDailyPence,
      storageOpen,
      pavPence: pav,
      salvagePence: salvage,
      salvageSource: body.salvageSource ?? (bundle.report?.salvageValuePence !== undefined ? 'estimate' : 'estimate'),
      salvageCategory: body.salvageCategory ?? bundle.report?.salvageCategory,
      daysToPavPayment: body.daysToPavPayment ?? 10,
    });
    const now = ctx.now();
    ctx.db.transaction((tx) => {
      if (bundle.report && !bundle.report.issuedAt) ctx.repos.updateEngineerReport(tx, bundle.report.id, { totalLoss: assessment, salvageCategory: assessment.salvageCategory ?? bundle.report.salvageCategory, salvageValuePence: assessment.salvagePence });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'total_loss.assess', entity: 'claims', entityId: id, after: { decision: assessment.decision, marginPence: assessment.marginPence, repairRouteCostPence: assessment.repairRouteCostPence, totalLossRouteCostPence: assessment.totalLossRouteCostPence, storedOnReport: Boolean(bundle.report && !bundle.report.issuedAt) }, at: now });
    });
    return { ...assessment, gtaBenchmark: benchmark ? { group, dailyRatePence: benchmark.dailyRatePence, verification: benchmark.verification, note: 'industry benchmark — CCGUK is not a GTA subscriber' } : undefined };
  });

  app.post('/claims/:id/total-loss/predict', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(totalLossPredictBody, request.body);
    const prediction = predictTotalLoss(body);
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'total_loss.predict', entity: 'claims', entityId: id, after: { probability: prediction.probability, band: prediction.band, calibrated: prediction.calibrated }, at: ctx.now() });
    return { ...prediction, note: prediction.calibrated ? undefined : 'Rules-first estimate; not calibrated until 100 outcomes are recorded.' };
  });
}

function defaultSubject(bundle: ReturnType<typeof loadBundle>): PavSubject {
  const v = bundle.vehicle;
  const latestOdo = [...v.odometer].sort((a, b) => b.date.localeCompare(a.date))[0];
  return {
    vehicleId: v.id,
    registration: v.registration,
    make: v.make,
    model: v.model,
    trim: v.variant,
    year: v.yearOfManufacture ?? new Date(bundle.claim.accident.occurredAt).getUTCFullYear() - 5,
    fuelType: v.fuelType,
    transmission: v.transmission,
    odometerAtLoss: latestOdo?.miles ?? 0,
    odometerBasis: latestOdo?.source === 'mot' ? 'projected_from_mot' : 'reading',
    conditionGrade: 'good',
    conditionAdjustmentPct: 0,
    previousWriteOffCategory: v.previousWriteOffCategory,
    claimantPostcode: bundle.claimant.address?.postcode,
    vatRegisteredClaimant: bundle.claimant.vatRegistered,
  };
}

/** Labour/paint lines with a panel, operation and hours from an approved estimate → labour library (once per estimate). */
function addToLabourLibrary(ctx: AppContext, tx: AppContext['db'], e: Estimate): number {
  if (!e.approvedBy) return 0;
  if (ctx.repos.listLabourEntries(tx).some((x) => x.estimateId === e.id)) return 0;
  const vehicle = ctx.repos.getVehicle(tx, e.vehicleId);
  if (!vehicle) return 0;
  let added = 0;
  for (const l of e.lines) {
    if ((l.kind !== 'labour' && l.kind !== 'paint') || l.preExisting || !l.panel || !l.hours || l.hours <= 0) continue;
    ctx.repos.addLabourEntry(tx, { make: vehicle.make, model: vehicle.model, panel: l.panel, operation: l.operation, hours: l.hours, ratePence: l.ratePence ?? (l.kind === 'paint' ? e.paintRatePence : e.labourRatePence), source: 'approved_estimate', estimateId: e.id });
    added += 1;
  }
  return added;
}
