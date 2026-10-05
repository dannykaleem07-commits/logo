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
import { registerJobsModule } from '../jobs.js';

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
  registerJobsModule,
];

export function registerAllRoutes(app: FastifyInstance, ctx: AppContext): void {
  for (const register of routeModules) register(app, ctx);
}
