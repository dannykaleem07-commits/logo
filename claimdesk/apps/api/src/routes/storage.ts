import type { FastifyInstance } from 'fastify';
import { storageCharge } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { conflict } from '../errors.js';
import { parse } from '../schemas/common.js';
import { createStorageBody, endStorageBody } from '../schemas/hire.js';
import { recomputeClocks } from '../services/claimView.js';
import { params, requireClaim } from './helpers.js';

export function registerStorageRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/claims/:id/storage', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const now = ctx.now();
    return { storage: ctx.repos.listStorage(ctx.db, id).map((s) => ({ ...s, charge: storageCharge({ ...s, endAt: s.endAt ?? now }) })) };
  });

  app.post('/claims/:id/storage', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(createStorageBody, request.body);
    const settings = ctx.settings();
    const now = ctx.now();
    const storage = ctx.db.transaction((tx) => {
      const s = ctx.repos.createStorage(tx, { claimId: id, location: body.location, startAt: body.startAt, dailyRatePence: body.dailyRatePence ?? settings.rateCard.storageDailyPence, vatRate: body.vatRate ?? settings.rateCard.vatRate });
      ctx.repos.appendEvent(tx, { claimId: id, type: 'storage_started', at: body.startAt, summary: `Storage started at ${body.location} (${(s.dailyRatePence / 100).toFixed(2)}/day ex VAT)`, data: { storageId: s.id }, attributableTo: 'ccguk', createdBy: request.user.id, recordedAt: now });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'storage.create', entity: 'storage_records', entityId: s.id, after: s, at: now });
      return s;
    });
    recomputeClocks(ctx, id);
    return reply.status(201).send(storage);
  });

  app.post('/claims/:id/storage/:sid/end', async (request) => {
    const { id, sid } = params<{ id: string; sid: string }>(request);
    requireClaim(ctx, id);
    const body = parse(endStorageBody, request.body);
    const current = ctx.repos.requireStorage(ctx.db, sid);
    if (current.claimId !== id) throw conflict('WRONG_CLAIM', `Storage ${sid} belongs to another claim`);
    const now = ctx.now();
    const storage = ctx.db.transaction((tx) => {
      const s = ctx.repos.endStorage(tx, sid, { endAt: body.endAt, endTrigger: body.endTrigger });
      const charge = storageCharge({ ...s, endAt: body.endAt });
      ctx.repos.appendEvent(tx, { claimId: id, type: 'storage_ended', at: body.endAt, summary: `Storage at ${s.location} ended — trigger ${body.endTrigger}${body.reason ? `: ${body.reason}` : ''}`, data: { storageId: s.id, endTrigger: body.endTrigger, days: charge.days, netPence: charge.netPence }, attributableTo: 'ccguk', createdBy: request.user.id, recordedAt: now });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'storage.end', entity: 'storage_records', entityId: s.id, before: { endAt: null }, after: { endAt: s.endAt, endTrigger: body.endTrigger, reason: body.reason ?? null }, at: now });
      return s;
    });
    const clocks = recomputeClocks(ctx, id);
    return { storage, charge: storageCharge({ ...storage, endAt: storage.endAt ?? now }), clocks };
  });
}
