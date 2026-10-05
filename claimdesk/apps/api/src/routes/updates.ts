/**
 * GET /updates/check — is a newer ClaimDesk out? (docs/V03-MANAGER-MODE-HIRE-PRICING.md §F.3). Signed-in users only
 * (every non-public /api route needs a session). `?force=1` re-checks now ("Check now"; at most once a minute),
 * otherwise the answer comes from the 1 h cache. Always 200: the status says whether the check worked.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { updatesServiceFor } from '../services/updates.js';

export function registerUpdatesRoutes(app: FastifyInstance, ctx: AppContext): void {
  const updates = updatesServiceFor(ctx);
  app.get('/updates/check', async (request) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    const force = q.force === '1' || q.force === 'true';
    return updates.check(force);
  });
}
