// owned by mail
/** mail job handlers and Needs-you resolvers (docs/SUPREME-DESIGN.md §C.2, §C.7). Registered by agent/handlers/index.ts (foundation). */
import type { JobHandler, NeedsYouResolver } from '../contracts.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each handler has its own payload/result types
export const mailJobHandlers: JobHandler<any, any>[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each resolver has its own payload type
export const mailNeedsYouResolvers: NeedsYouResolver<any>[] = [];
