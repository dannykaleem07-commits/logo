import type { FastifyInstance } from 'fastify';
import { LedgerImmutableError } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { parse } from '../schemas/common.js';
import { ledgerEntryBody, ledgerListQuery } from '../schemas/ledger.js';
import { requireClaim, params } from './helpers.js';

/** Ledger — append-only (ARCHITECTURE 3). Corrections are new rows with `supersedesId`. */
export function registerLedgerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/claims/:id/ledger', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const q = parse(ledgerListQuery, request.query);
    const entries = ctx.repos.listLedger(ctx.db, id, { head: q.head, kind: q.kind, includeSuperseded: q.includeSuperseded === 'true' });
    return { entries, sums: ctx.repos.sumLedger(ctx.db, id), position: ctx.repos.ledgerPosition(ctx.db, id), totalPaidPence: ctx.repos.totalPaid(ctx.db, id) };
  });

  app.post('/claims/:id/ledger', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(ledgerEntryBody, request.body);
    const entry = ctx.db.transaction((tx) => {
      const e = ctx.repos.appendLedgerEntry(tx, { ...body, claimId: id, createdBy: request.user.id, createdAt: ctx.now() });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'ledger.append', entity: 'ledger_entries', entityId: e.id, after: e, at: ctx.now() });
      return e;
    });
    return reply.status(201).send(entry);
  });

  // Never update or delete: the repos throw LedgerImmutableError, which the error handler maps to 409.
  const immutable = async () => {
    throw new LedgerImmutableError('update');
  };
  app.patch('/claims/:id/ledger/:entryId', immutable);
  app.put('/claims/:id/ledger/:entryId', immutable);
  app.delete('/claims/:id/ledger/:entryId', async () => {
    throw new LedgerImmutableError('delete');
  });
}
