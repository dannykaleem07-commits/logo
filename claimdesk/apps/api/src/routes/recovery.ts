import type { FastifyInstance } from 'fastify';
import { recoveryCharge } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { parse } from '../schemas/common.js';
import { createRecoveryBody } from '../schemas/hire.js';
import { params, requireClaim } from './helpers.js';

/** Recovery: £90 call-out + £3/loaded mile + £25 admin (+VAT) from the rate card; the charge is written to the ledger as 'claimed' under 'recovery'. */
export function registerRecoveryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/claims/:id/recovery', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    return { recovery: ctx.repos.listRecovery(ctx.db, id).map((r) => ({ ...r, charge: recoveryCharge(r) })) };
  });

  app.post('/claims/:id/recovery', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(createRecoveryBody, request.body);
    const rc = ctx.settings().rateCard;
    const now = ctx.now();
    const input = {
      claimId: id,
      at: body.at,
      fromLocation: body.fromLocation,
      toLocation: body.toLocation,
      loadedMiles: body.loadedMiles,
      calloutPence: body.calloutPence ?? rc.recoveryCalloutPence,
      perLoadedMilePence: body.perLoadedMilePence ?? rc.perMilePence,
      adminPence: body.adminPence ?? rc.adminPence,
      vatRate: body.vatRate ?? rc.vatRate,
      evidenceIds: body.evidenceIds ?? [],
    };
    const charge = recoveryCharge(input);
    const result = ctx.db.transaction((tx) => {
      const recovery = ctx.repos.createRecovery(tx, input);
      const ledgerEntry = ctx.repos.appendLedgerEntry(tx, {
        claimId: id,
        head: 'recovery',
        kind: 'claimed',
        amountPence: charge.netPence,
        vatPence: charge.vatPence,
        date: body.at.slice(0, 10),
        description: `Recovery ${body.fromLocation} → ${body.toLocation}: call-out ${(charge.calloutPence / 100).toFixed(2)} + ${charge.loadedMiles} loaded miles × ${(charge.perLoadedMilePence / 100).toFixed(2)} + admin ${(charge.adminPence / 100).toFixed(2)} (ex VAT)`,
        counterpartyId: body.counterpartyId,
        sourceEvidenceId: body.evidenceIds?.[0],
        createdBy: request.user.id,
        createdAt: now,
      });
      ctx.repos.appendEvent(tx, { claimId: id, type: 'recovery', at: body.at, summary: `Vehicle recovered from ${body.fromLocation} to ${body.toLocation} (${body.loadedMiles} loaded miles)`, data: { recoveryId: recovery.id, ledgerEntryId: ledgerEntry.id, netPence: charge.netPence, grossPence: charge.grossPence }, attributableTo: 'ccguk', createdBy: request.user.id, recordedAt: now });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'recovery.create', entity: 'recovery_records', entityId: recovery.id, after: { ...recovery, charge, ledgerEntryId: ledgerEntry.id }, at: now });
      return { recovery, ledgerEntry };
    });
    return reply.status(201).send({ ...result, charge });
  });
}
