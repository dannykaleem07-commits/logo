// owned by knowledge-use
/**
 * knowledge-use routes (docs/SUPREME-KNOWLEDGE-BUILDER.md §10.3): GET /knowledge/search, /knowledge/used, /knowledge/evals/runs…, POST /knowledge/evals/replay, GET /knowledge/alarms, POST /knowledge/alarms/:id/ack.
 * STUB created by knowledge-core: registered by routes/index.ts; knowledge-use adds its routes here (all `/api`, session
 * auth, every write route human-only through `assertHuman`; DTOs in @ccguk/domain knowledge/api.ts).
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export function registerKnowledgeUseRoutes(_app: FastifyInstance, _ctx: AppContext): void {
  // not built yet
}
