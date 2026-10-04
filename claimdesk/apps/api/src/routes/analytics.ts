/** Analytics routes — derived from the ledger and chronology (services/analytics.ts). */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { cycleTimes, debtorDays, interventions, overview, reductions } from '../services/analytics.js';

export function registerAnalyticsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/analytics/overview', async () => overview(ctx));
  app.get('/analytics/debtor-days', async () => debtorDays(ctx));
  app.get('/analytics/reductions', async () => reductions(ctx));
  app.get('/analytics/cycle-times', async () => cycleTimes(ctx));
  app.get('/analytics/interventions', async () => interventions(ctx));
}
