/**
 * Route registry. Each module is `register<Name>Routes(app, ctx)` in `src/routes/<name>.ts` and is mounted under
 * `/api` by app.ts. The services agent appends its modules (evidence, documents, engineering, fleet, directory, kb,
 * watch, analytics, settings) to the `routeModules` array below — keep it a plain array.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { RouteModule } from './helpers.js';
import { registerHealthRoutes } from './health.js';
import { registerAuthRoutes } from './auth.js';
import { registerClaimsRoutes } from './claims.js';
import { registerPartiesRoutes } from './parties.js';
import { registerVehiclesRoutes } from './vehicles.js';
import { registerLedgerRoutes } from './ledger.js';
import { registerEventsRoutes } from './events.js';
import { registerHireRoutes } from './hire.js';
import { registerStorageRoutes } from './storage.js';
import { registerRecoveryRoutes } from './recovery.js';
import { registerOffersRoutes } from './offers.js';
import { registerEvidenceRoutes } from './evidence.js';
import { registerDocumentsRoutes } from './documents.js';
import { registerEngineeringRoutes } from './engineering.js';
import { registerFleetRoutes } from './fleet.js';
import { registerDirectoryRoutes } from './directory.js';
import { registerWatchRoutes } from './watch.js';
import { registerAnalyticsRoutes } from './analytics.js';
import { registerSettingsRoutes } from './settings.js';
import { registerCatalogueRoutes } from './catalogue.js';
import { registerGtaRatesRoutes } from './gtaRates.js';
import { registerDocxTemplatesRoutes } from './docxTemplates.js';
import { registerUpdatesRoutes } from './updates.js';
import { registerJobsModule } from '../jobs.js';
// ClaimDesk Supreme phase 1 (docs/SUPREME-DESIGN.md §N.6, §P): stubs created by foundation, filled by each slice.
import { registerMcpRoutes } from './mcp.js';
import { registerAiRoutes } from './ai.js';
import { registerAgentRoutes } from './agents.js';
import { registerNeedsYouRoutes } from './needsYou.js';
import { registerDailyLogRoutes } from './dailyLog.js';
import { registerNotificationsRoutes } from './notifications.js';
import { registerAutonomySettingsRoutes } from './autonomySettings.js';
import { registerTasksRoutes } from './tasks.js';
import { registerMailRoutes } from './mail.js';
import { registerOutboxRoutes } from './outbox.js';
import { registerIntakeRoutes } from './intake.js';
import { registerCaseworkRoutes } from './casework.js';
import { registerBrainRoutes } from './brain.js';
import { registerModels3dRoutes } from './models3d.js';
// ClaimDesk Supreme Autopilot (docs/SUPREME-AUTOPILOT.md §H.4): stubs by ap-foundation, filled by each owning slice.
import { registerAutopilotSettingsRoutes } from './autopilotSettings.js';
import { registerAutopilotRoutes } from './autopilot.js';
import { registerBookingsRoutes } from './bookings.js';
import { registerClashesRoutes } from './clashes.js';
import { registerSigningRoutes } from './signing.js';
import { registerKioskRoutes } from './kiosk.js';
// Knowledge Builder (docs/SUPREME-KNOWLEDGE-BUILDER.md §10.3)
import { registerKnowledgeRoutes } from './knowledge.js';
import { registerKnowledgeLearningRoutes } from './knowledgeLearning.js';
import { registerKnowledgeResearchRoutes } from './knowledgeResearch.js';
import { registerKnowledgeUseRoutes } from './knowledgeUse.js';

export const routeModules: RouteModule[] = [
  registerHealthRoutes,
  registerAuthRoutes,
  registerClaimsRoutes,
  registerPartiesRoutes,
  registerVehiclesRoutes,
  registerLedgerRoutes,
  registerEventsRoutes,
  registerHireRoutes,
  registerStorageRoutes,
  registerRecoveryRoutes,
  registerOffersRoutes,
  // services half
  registerEvidenceRoutes,
  registerDocumentsRoutes,
  registerEngineeringRoutes,
  registerFleetRoutes,
  registerDirectoryRoutes,
  registerWatchRoutes,
  registerAnalyticsRoutes,
  registerSettingsRoutes,
  registerCatalogueRoutes,
  registerGtaRatesRoutes,
  registerDocxTemplatesRoutes,
  registerUpdatesRoutes,
  // Supreme phase 1
  registerMcpRoutes, // gateway
  registerAiRoutes, // gateway
  registerAgentRoutes, // runtime
  registerNeedsYouRoutes, // runtime
  registerDailyLogRoutes, // runtime
  registerNotificationsRoutes, // runtime
  registerAutonomySettingsRoutes, // runtime
  registerTasksRoutes, // runtime
  registerMailRoutes, // mail
  registerOutboxRoutes, // mail
  registerIntakeRoutes, // intake
  registerCaseworkRoutes, // casework
  registerBrainRoutes, // casework
  registerModels3dRoutes, // exact-models (licensed 3D models)
  // Autopilot
  registerAutopilotSettingsRoutes, // ap-foundation
  registerAutopilotRoutes, // ap-autopilot
  registerBookingsRoutes, // ap-booking
  registerClashesRoutes, // ap-clash
  registerSigningRoutes, // ap-paperwork
  registerKioskRoutes, // ap-paperwork (token auth, /api/kiosk/*)
  // Knowledge Builder
  registerKnowledgeRoutes, // knowledge-core
  registerKnowledgeLearningRoutes, // knowledge-learners
  registerKnowledgeResearchRoutes, // knowledge-research
  registerKnowledgeUseRoutes, // knowledge-use
  registerJobsModule,
];

export function registerAllRoutes(app: FastifyInstance, ctx: AppContext): void {
  for (const register of routeModules) register(app, ctx);
}
