// owned by knowledge-research
/**
 * Knowledge research: gap scan, researcher, web research, fetcher, watch (docs/SUPREME-KNOWLEDGE-BUILDER.md §10.1). STUB created by knowledge-core:
 * the arrays stay empty until knowledge-research lands (its schedules are advanced without a job meanwhile, and the contracts
 * test lists these job types as awaiting the slice). knowledge-research adds its handlers here (built with `knowledgeHandler()`
 * from knowledge/jobs.ts);
 * agent/handlers/index.ts already concatenates both arrays, so the slice never edits the registry.
 */
import type { JobHandler, NeedsYouResolver } from '../contracts.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const knowledgeResearchJobHandlers: JobHandler<any, any>[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const knowledgeResearchNeedsYouResolvers: NeedsYouResolver<any>[] = [];
