// owned by ap-autopilot
/**
 * autopilot job handlers and Needs-you resolvers (docs/SUPREME-AUTOPILOT.md §H.1, §H.3). Registered by
 * agent/handlers/index.ts. Stub created by ap-foundation.
 */
import type { JobHandler, NeedsYouResolver } from '../contracts.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const autopilotJobHandlers: JobHandler<any, any>[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const autopilotNeedsYouResolvers: NeedsYouResolver<any>[] = [];
