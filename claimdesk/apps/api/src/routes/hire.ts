import type { FastifyInstance } from 'fastify';
import { calculateHire, offHireDeadline, type HireAgreement } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { conflict } from '../errors.js';
import { parse } from '../schemas/common.js';
import { createHireBody, endHireBody } from '../schemas/hire.js';
import { recomputeClocks } from '../services/claimView.js';
import { canAllocateFor } from '../engines.js';
import { gtaRatesFor } from '../services/kb.js';
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

export function registerHireRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/claims/:id/hire', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const hire = ctx.repos.listHire(ctx.db, id);
    const rates = gtaRatesFor(ctx);
    return { hire: hire.map((h) => ({ ...h, calculation: calculateHire(h, h.endAt ?? ctx.now(), { rates }), enforceabilityGaps: enforceabilityGaps(h) })) };
  });

  app.post('/claims/:id/hire', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const claim = requireClaim(ctx, id);
    assertNoHardStop(claim);
    const body = parse(createHireBody, request.body);
    const unit = ctx.repos.requireFleetUnit(ctx.db, body.fleetUnitId);
    const policies = ctx.repos.listPolicies(ctx.db);
    const allocation = canAllocateFor(unit, body.use, policies, body.startAt, ctx.repos.getVehicle(ctx.db, unit.vehicleId));
    const active = ctx.repos.activeHireForFleetUnit(ctx.db, unit.id);
    if (active) allocation.reasons.push(`Unit already on hire under ${active.agreementNumber} (claim ${active.claimId})`);
    if (active || !allocation.ok) {
      if (!body.overrideAllocation || active) throw conflict('ALLOCATION_REFUSED', `Fleet unit ${unit.id} cannot be allocated for ${body.use}`, { reasons: allocation.reasons });
    }
    const settings = ctx.settings();
    const now = ctx.now();
    const hire = ctx.db.transaction((tx) => {
      const h = ctx.repos.createHire(tx, {
        claimId: id,
        fleetUnitId: unit.id,
        startAt: body.startAt,
        dailyRatePence: body.dailyRatePence ?? unit.dailyRatePence,
        vatRate: body.vatRate ?? settings.rateCard.vatRate,
        gtaGroup: body.gtaGroup ?? unit.gtaGroup,
        excessPence: body.excessPence,
        excessWaiverDailyPence: body.excessWaiverDailyPence,
        additionalDrivers: body.additionalDrivers,
        deliveredAt: body.deliveredAt,
        odometerOut: body.odometerOut,
        signedAt: body.signedAt,
        enforceability: body.enforceability,
        needStatementEvidenceId: body.needStatementEvidenceId,
      });
      ctx.repos.updateFleetUnit(tx, unit.id, { status: 'on_hire' });
      ctx.repos.appendEvent(tx, {
        claimId: id,
        type: 'hire_started',
        at: body.startAt,
        summary: `Hire ${h.agreementNumber} started on fleet unit ${unit.id} (group ${h.gtaGroup}, ${(h.dailyRatePence / 100).toFixed(2)}/day ex VAT)`,
        data: { hireId: h.id, fleetUnitId: unit.id, use: body.use, allocation },
        attributableTo: 'ccguk',
        createdBy: request.user.id,
        recordedAt: now,
      });
      const gaps = enforceabilityGaps(h);
      if (gaps.length) {
        ctx.repos.addClaimFlag(tx, id, { code: 'HIRE_ENFORCEABILITY_GAP', severity: 'warn', message: `Hire ${h.agreementNumber}: ${gaps.join('; ')}`, raisedBy: 'system' });
      }
      ctx.repos.appendAudit(tx, {
        actor: request.actor,
        action: 'hire.create',
        entity: 'hire_agreements',
        entityId: h.id,
        after: { claimId: id, fleetUnitId: unit.id, use: body.use, allocation, override: body.overrideAllocation ?? null, enforceabilityGaps: gaps },
        at: now,
      });
      return h;
    });
    recomputeClocks(ctx, id);
    return reply.status(201).send({ hire, allocation, enforceabilityGaps: enforceabilityGaps(hire) });
  });

  app.post('/claims/:id/hire/:hireId/end', async (request) => {
    const { id, hireId } = params<{ id: string; hireId: string }>(request);
    requireClaim(ctx, id);
    const body = parse(endHireBody, request.body);
    const current = ctx.repos.requireHire(ctx.db, hireId);
    if (current.claimId !== id) throw conflict('WRONG_CLAIM', `Hire ${hireId} belongs to another claim`);
    const now = ctx.now();
    const rates = gtaRatesFor(ctx);
    const hire = ctx.db.transaction((tx) => {
      const h = ctx.repos.endHire(tx, hireId, { endAt: body.endAt, endTrigger: body.endTrigger, collectedAt: body.collectedAt, odometerIn: body.odometerIn });
      ctx.repos.updateFleetUnit(tx, h.fleetUnitId, { status: 'available' });
      const deadline = offHireDeadline(body.endTrigger, body.endAt);
      const calc = calculateHire(h, h.endAt, { rates });
      ctx.repos.appendEvent(tx, {
        claimId: id,
        type: 'hire_ended',
        at: body.endAt,
        summary: `Hire ${h.agreementNumber} ended — trigger ${body.endTrigger}${body.reason ? `: ${body.reason}` : ''}`,
        data: { hireId: h.id, endTrigger: body.endTrigger, basis: deadline.basis, days: calc.days, netPence: calc.netPence, grossPence: calc.grossPence, odometerIn: body.odometerIn },
        attributableTo: 'ccguk',
        createdBy: request.user.id,
        recordedAt: now,
      });
      if (body.odometerIn !== undefined) {
        const claim = ctx.repos.requireClaim(tx, id);
        void claim; // odometer at collection belongs to the hire vehicle (fleet unit), recorded on the agreement
      }
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'hire.end', entity: 'hire_agreements', entityId: h.id, before: { endAt: current.endAt ?? null }, after: { endAt: h.endAt, endTrigger: body.endTrigger, reason: body.reason ?? null }, at: now });
      return h;
    });
    const clocks = recomputeClocks(ctx, id);
    return { hire, calculation: calculateHire(hire, hire.endAt, { rates }), clocks };
  });
}
