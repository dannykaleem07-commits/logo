import type { FastifyInstance } from 'fastify';
import { calculateHire, formatGBP, HIRE_END_TRIGGER_TEXT, offHireDeadline, type HireAgreement, type HireCalculation } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { conflict } from '../errors.js';
import { parse } from '../schemas/common.js';
import { correctHireBody, createHireBody, endHireBody, pricingGuideQuery } from '../schemas/hire.js';
import { recomputeClocks } from '../services/claimView.js';
import { canAllocateFor } from '../engines.js';
import { gtaRatesFor } from '../services/kb.js';
import { gateFor, type OverrideTarget } from '../services/override.js';
import { hirePricingFor, hirePricingSnapshot, pricingColumns, type HirePricingSnapshot } from '../services/hirePricing.js';
import {
  correctHireDates,
  endsBeforeStart,
  hireCostedTo,
  hireDateWarnings,
  isLateEntry,
  refuseEndBeforeStart,
  refuseOverlap,
  registrationOf,
  syncDatesInvalidFlag,
  syncFleetStatus,
} from '../services/hireCorrection.js';
import { assertNoHardStop, params, requireClaim } from './helpers.js';

export function enforceabilityGaps(h: HireAgreement): string[] {
  const gaps: string[] = [];
  const e = h.enforceability;
  if (!e.cancellationInfoProvidedAt) gaps.push('CCR 2013 Sch 2 cancellation information not recorded');
  if (!e.schedule3FormProvidedAt) gaps.push('CCR 2013 Sch 3 cancellation form not recorded');
  if (!e.expressRequestToStartAt) gaps.push('Express request to start within the cancellation period (reg 36) not recorded');
  if (!e.cca60fCompliant) gaps.push('RAO art 60F exemption not confirmed (≤12 payments within 12 months, no interest or charges)');
  if (!h.signedAt) gaps.push('Agreement not signed');
  return gaps;
}

/** One correction of a hire, read back from its `hire.correct` audit row. */
export interface HireCorrectionView {
  at: string;
  by: string;
  byName?: string;
  reason: string;
  changes: Record<string, { from: unknown; to: unknown }>;
}

/** GET /claims/:id/hire item (§C.3). */
export type HireListItem = HireAgreement & {
  calculation: HireCalculation;
  enforceabilityGaps: string[];
  pricing: HirePricingSnapshot;
  recordedAt: string;
  recordedBy?: string;
  recordedByName?: string;
  backdated: boolean;
  corrections: HireCorrectionView[];
};

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function registerHireRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/claims/:id/hire', async (request) => {
    const { id } = params<{ id: string }>(request);
    const claim = requireClaim(ctx, id);
    const now = ctx.now();
    const rates = gtaRatesFor(ctx);
    const clientVehicle = ctx.repos.getVehicle(ctx.db, claim.clientVehicleId);
    const names = new Map(ctx.repos.listUsers(ctx.db).map((u) => [u.id, u.name]));
    // every hire_started, corrected ones included: the first one for a hire says who recorded it
    const started = ctx.repos.listEvents(ctx.db, id, { type: 'hire_started' });
    const hire: HireListItem[] = ctx.repos.listHireWithRecordedAt(ctx.db, id).map(({ recordedAt, ...h }) => {
      const pricing = hirePricingSnapshot(ctx, h, clientVehicle, rates);
      const likeForLikeGroup = h.clientGtaGroup ?? pricing.clientGtaGroup ?? undefined;
      const calculation = calculateHire(h, hireCostedTo(h, now), { rates, ...(likeForLikeGroup ? { likeForLikeGroup } : {}) });
      const first = started.find((e) => e.data?.['hireId'] === h.id && !e.data?.['correction']) ?? started.find((e) => e.data?.['hireId'] === h.id);
      const corrections: HireCorrectionView[] = ctx.repos
        .listAudit(ctx.db, { entityId: h.id, action: 'hire.correct' })
        .sort((a, b) => a.at.localeCompare(b.at))
        .map((a) => {
          const before = asRecord(a.before);
          const after = asRecord(a.after);
          const changes: Record<string, { from: unknown; to: unknown }> = {};
          for (const k of Object.keys(before)) {
            if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changes[k] = { from: before[k] ?? null, to: after[k] ?? null };
          }
          const byName = names.get(a.userId);
          return { at: a.at, by: a.userId, ...(byName ? { byName } : {}), reason: typeof after['reason'] === 'string' ? after['reason'] : '', changes };
        });
      const recordedBy = first?.createdBy;
      const recordedByName = recordedBy ? names.get(recordedBy) : undefined;
      return {
        ...h,
        calculation,
        enforceabilityGaps: enforceabilityGaps(h),
        pricing,
        recordedAt,
        ...(recordedBy ? { recordedBy } : {}),
        ...(recordedByName ? { recordedByName } : {}),
        backdated: isLateEntry(h.startAt, recordedAt),
        corrections,
      };
    });
    return { hire };
  });

  /** The pricing guide for a fleet car on this claim (§B.3). */
  app.get('/claims/:id/hire/pricing-guide', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const q = parse(pricingGuideQuery, request.query);
    const unit = ctx.repos.requireFleetUnit(ctx.db, q.fleetUnitId);
    return hirePricingFor(ctx, id, unit, q.startAt ?? ctx.now(), q.clientGroup);
  });

  app.post('/claims/:id/hire', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const claim = requireClaim(ctx, id);
    // 1. Hard stop (overridable in manager mode).
    const gate = gateFor(ctx, request);
    assertNoHardStop(claim, gate);
    const body = parse(createHireBody, request.body);
    const unit = ctx.repos.requireFleetUnit(ctx.db, body.fleetUnitId);
    const target: OverrideTarget = { claimId: id, entity: 'fleet_units', entityId: unit.id };
    const endAt = body.endAt;
    const endTrigger = endAt ? (body.endTrigger ?? 'manual') : undefined;
    // 2. End before start.
    const invalid = endsBeforeStart(body.startAt, endAt);
    if (invalid) refuseEndBeforeStart(gate, body.startAt, endAt!, target);
    // 3. Allocation with an on-hire unit treated as available: the period overlap decides that case.
    const policies = ctx.repos.listPolicies(ctx.db);
    const allocation = canAllocateFor({ ...unit, status: unit.status === 'on_hire' ? 'available' : unit.status }, body.use, policies, body.startAt, ctx.repos.getVehicle(ctx.db, unit.vehicleId));
    // 4. Period overlap with the car's other hires.
    refuseOverlap(ctx, gate, unit, { startAt: body.startAt, endAt: endAt ?? null }, target);
    // 5. Allocation refused (status, use, policy, MOT, tax).
    if (!allocation.ok) gate.refuse(conflict('ALLOCATION_REFUSED', `${registrationOf(ctx, unit)} cannot be allocated for ${body.use}: ${allocation.reasons.join('; ')}`, { reasons: allocation.reasons }), target);

    const settings = ctx.settings();
    const now = ctx.now();
    const hireGroup = body.gtaGroup?.trim().toUpperCase() || unit.gtaGroup;
    const pricing = hirePricingFor(ctx, id, { ...unit, gtaGroup: hireGroup }, body.startAt, body.clientGtaGroup);
    const cols = pricingColumns(pricing);
    const lateEntry = isLateEntry(body.startAt, now);
    const rates = gtaRatesFor(ctx);
    // 6. One transaction.
    const hire = ctx.db.transaction((tx) => {
      const h = ctx.repos.createHire(
        tx,
        {
          claimId: id,
          fleetUnitId: unit.id,
          startAt: body.startAt,
          ...(endAt ? { endAt, endTrigger } : {}),
          dailyRatePence: body.dailyRatePence ?? unit.dailyRatePence,
          vatRate: body.vatRate ?? settings.rateCard.vatRate,
          gtaGroup: hireGroup,
          excessPence: body.excessPence,
          excessWaiverDailyPence: body.excessWaiverDailyPence,
          additionalDrivers: body.additionalDrivers,
          deliveredAt: body.deliveredAt,
          odometerOut: body.odometerOut,
          signedAt: body.signedAt,
          enforceability: body.enforceability,
          needStatementEvidenceId: body.needStatementEvidenceId,
          fleetDailyRatePence: cols.fleetDailyRatePence,
          ...(cols.clientGtaGroup ? { clientGtaGroup: cols.clientGtaGroup } : {}),
          ...(cols.clientGtaDailyRatePence !== null ? { clientGtaDailyRatePence: cols.clientGtaDailyRatePence } : {}),
          ...(cols.hireGtaDailyRatePence !== null ? { hireGtaDailyRatePence: cols.hireGtaDailyRatePence } : {}),
          ...(cols.pricingNote ? { pricingNote: cols.pricingNote } : {}),
        },
        { allowEndBeforeStart: invalid },
      );
      syncFleetStatus(ctx, tx, unit.id, now);
      ctx.repos.appendEvent(tx, {
        claimId: id,
        type: 'hire_started',
        at: body.startAt,
        summary: `Hire ${h.agreementNumber} started on ${registrationOf(ctx, unit)} (group ${h.gtaGroup}, ${formatGBP(h.dailyRatePence)}/day ex VAT)${lateEntry ? ' — entered late' : ''}`,
        data: { hireId: h.id, fleetUnitId: unit.id, use: body.use, allocation, lateEntry },
        attributableTo: 'ccguk',
        createdBy: request.user.id,
        recordedAt: now,
      });
      if (h.endAt && h.endTrigger) {
        const deadline = offHireDeadline(h.endTrigger, h.endAt);
        const calc = calculateHire(h, h.endAt, { rates });
        ctx.repos.appendEvent(tx, {
          claimId: id,
          type: 'hire_ended',
          at: h.endAt,
          summary: `Hire ${h.agreementNumber} ended — ${HIRE_END_TRIGGER_TEXT[h.endTrigger]}${body.endReason ? `: ${body.endReason}` : ''}`,
          data: { hireId: h.id, endTrigger: h.endTrigger, basis: deadline.basis, days: calc.days, netPence: calc.netPence, grossPence: calc.grossPence, lateEntry: isLateEntry(h.endAt, now) },
          attributableTo: 'ccguk',
          createdBy: request.user.id,
          recordedAt: now,
        });
      }
      const gaps = enforceabilityGaps(h);
      if (gaps.length) {
        ctx.repos.addClaimFlag(tx, id, { code: 'HIRE_ENFORCEABILITY_GAP', severity: 'warn', message: `Hire ${h.agreementNumber}: ${gaps.join('; ')}`, raisedBy: 'system' });
      }
      if (invalid) syncDatesInvalidFlag(ctx, tx, id, h.agreementNumber);
      ctx.repos.appendAudit(tx, {
        actor: request.actor,
        action: 'hire.create',
        entity: 'hire_agreements',
        entityId: h.id,
        after: {
          claimId: id,
          fleetUnitId: unit.id,
          use: body.use,
          allocation,
          override: body.overrideAllocation ?? null,
          enforceabilityGaps: gaps,
          lateEntry,
          ...(h.endAt ? { endAt: h.endAt, endTrigger: h.endTrigger, endReason: body.endReason ?? null } : {}),
          pricing: {
            hireGroup: h.gtaGroup,
            hireGtaDailyRatePence: cols.hireGtaDailyRatePence,
            clientGtaGroup: cols.clientGtaGroup,
            clientGroupSource: pricing.clientCar.source,
            clientGtaDailyRatePence: cols.clientGtaDailyRatePence,
            fleetDailyRatePence: cols.fleetDailyRatePence,
            agreedDailyRatePence: h.dailyRatePence,
            differencePerDayPence: pricing.differencePerDayPence,
            higherGroup: pricing.higherGroup,
          },
        },
        at: now,
      });
      return h;
    });
    // 7. Clocks and the answer.
    recomputeClocks(ctx, id);
    const warnings = [...hireDateWarnings(claim, hire.startAt, hire.endAt, now), ...allocation.warnings];
    return reply.status(201).send({ hire, allocation, enforceabilityGaps: enforceabilityGaps(hire), pricing, warnings });
  });

  app.post('/claims/:id/hire/:hireId/end', async (request) => {
    const { id, hireId } = params<{ id: string; hireId: string }>(request);
    requireClaim(ctx, id);
    const body = parse(endHireBody, request.body);
    const current = ctx.repos.requireHire(ctx.db, hireId);
    if (current.claimId !== id) throw conflict('WRONG_CLAIM', `Hire ${hireId} belongs to another claim`);
    if (current.endAt) throw conflict('HIRE_ALREADY_ENDED', 'Use Edit dates to change the end', { endAt: current.endAt });
    const gate = gateFor(ctx, request);
    const invalid = endsBeforeStart(current.startAt, body.endAt);
    if (invalid) refuseEndBeforeStart(gate, current.startAt, body.endAt, { claimId: id, entity: 'hire_agreements', entityId: hireId });
    const now = ctx.now();
    const rates = gtaRatesFor(ctx);
    const lateEntry = isLateEntry(body.endAt, now);
    const hire = ctx.db.transaction((tx) => {
      const h = ctx.repos.endHire(tx, hireId, { endAt: body.endAt, endTrigger: body.endTrigger, collectedAt: body.collectedAt, odometerIn: body.odometerIn }, { allowEndBeforeStart: invalid });
      syncFleetStatus(ctx, tx, h.fleetUnitId, now);
      const deadline = offHireDeadline(body.endTrigger, body.endAt);
      const calc = calculateHire(h, h.endAt, { rates });
      ctx.repos.appendEvent(tx, {
        claimId: id,
        type: 'hire_ended',
        at: body.endAt,
        summary: `Hire ${h.agreementNumber} ended — ${HIRE_END_TRIGGER_TEXT[body.endTrigger]}${body.reason ? `: ${body.reason}` : ''}${lateEntry ? ' — entered late' : ''}`,
        data: { hireId: h.id, endTrigger: body.endTrigger, basis: deadline.basis, days: calc.days, netPence: calc.netPence, grossPence: calc.grossPence, odometerIn: body.odometerIn, lateEntry },
        attributableTo: 'ccguk',
        createdBy: request.user.id,
        recordedAt: now,
      });
      if (invalid) syncDatesInvalidFlag(ctx, tx, id, h.agreementNumber);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'hire.end', entity: 'hire_agreements', entityId: h.id, before: { endAt: current.endAt ?? null }, after: { endAt: h.endAt, endTrigger: body.endTrigger, reason: body.reason ?? null, lateEntry }, at: now });
      return h;
    });
    const clocks = recomputeClocks(ctx, id);
    return { hire, calculation: calculateHire(hire, hire.endAt, { rates, ...(hire.clientGtaGroup ? { likeForLikeGroup: hire.clientGtaGroup } : {}) }), clocks };
  });

  /** Correct a hire's dates, rate or groups; backdating allowed; reason required (§C.3). */
  app.patch('/claims/:id/hire/:hireId', async (request) => {
    const { id, hireId } = params<{ id: string; hireId: string }>(request);
    requireClaim(ctx, id);
    const body = parse(correctHireBody, request.body);
    return correctHireDates(ctx, request, id, hireId, body);
  });
}

