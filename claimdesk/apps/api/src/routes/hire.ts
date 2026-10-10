import type { FastifyInstance } from 'fastify';
import { calculateHire, type HireAgreement, type HireCalculation } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { parse } from '../schemas/common.js';
import { correctHireBody, createHireBody, endHireBody, pricingGuideQuery } from '../schemas/hire.js';
import { recomputeClocks } from '../services/claimView.js';
import { gtaRatesFor } from '../services/kb.js';
import { gateFor } from '../services/override.js';
import { hirePricingFor, hirePricingSnapshot, type HirePricingSnapshot } from '../services/hirePricing.js';
import { correctHireDates, hireCostedTo, isLateEntry } from '../services/hireCorrection.js';
import { createHireRecord, enforceabilityGaps } from '../services/hireCreate.js';
import { endHireRecord } from '../services/hireEnd.js';
import { syncReservationFromHire } from '../booking/service.js';
import { nudgeAutopilot } from '../autopilot/nudge.js';
import { assertNoHardStop, params, requireClaim } from './helpers.js';

/** Moved to services/hireCreate.ts (SUPREME-AUTOPILOT §B.9); re-exported for existing importers. */
export { enforceabilityGaps };

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
    ctx.repos.requireFleetUnit(ctx.db, body.fleetUnitId);
    // 2–6 in one transaction (services/hireCreate.ts, SUPREME-AUTOPILOT §B.9): the hire and its on-hire diary row.
    const created = ctx.db.transaction((tx) =>
      createHireRecord(ctx, tx, request, gate, {
        ...body,
        claimId: id,
        excessPence: body.excessPence,
        ...(body.enforceability ? { enforceability: body.enforceability } : {}),
        reservation: 'create',
        userId: request.user.id,
      }),
    );
    // 7. Clocks and the answer.
    recomputeClocks(ctx, id);
    nudgeAutopilot(ctx, id, 'hire recorded');
    const { hire, allocation, pricing, warnings } = created;
    return reply.status(201).send({ hire, allocation, enforceabilityGaps: enforceabilityGaps(hire), pricing, warnings });
  });

  app.post('/claims/:id/hire/:hireId/end', async (request) => {
    const { id, hireId } = params<{ id: string; hireId: string }>(request);
    requireClaim(ctx, id);
    const body = parse(endHireBody, request.body);
    const gate = gateFor(ctx, request);
    const rates = gtaRatesFor(ctx);
    const hire = ctx.db.transaction((tx) => endHireRecord(ctx, tx, request, gate, { claimId: id, hireId, endAt: body.endAt, endTrigger: body.endTrigger, collectedAt: body.collectedAt, odometerIn: body.odometerIn, reason: body.reason, userId: request.user.id }));
    const clocks = recomputeClocks(ctx, id);
    nudgeAutopilot(ctx, id, 'hire ended');
    return { hire, calculation: calculateHire(hire, hire.endAt, { rates, ...(hire.clientGtaGroup ? { likeForLikeGroup: hire.clientGtaGroup } : {}) }), clocks };
  });

  /** Correct a hire's dates, rate or groups; backdating allowed; reason required (§C.3). */
  app.patch('/claims/:id/hire/:hireId', async (request) => {
    const { id, hireId } = params<{ id: string; hireId: string }>(request);
    requireClaim(ctx, id);
    const body = parse(correctHireBody, request.body);
    const result = await correctHireDates(ctx, request, id, hireId, body);
    syncReservationFromHire(ctx, hireId);
    return result;
  });
}

