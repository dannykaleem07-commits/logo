// owned by knowledge-learners
/**
 * Knowledge learners: observe, consolidate, statistics, curator (docs/SUPREME-KNOWLEDGE-BUILDER.md §10.1). STUB created by knowledge-core:
 * the arrays stay empty until knowledge-learners lands (its schedules are advanced without a job meanwhile, and the contracts
 * test lists these job types as awaiting the slice). knowledge-learners adds its handlers here (built with `knowledgeHandler()`
 * from knowledge/jobs.ts);
 * agent/handlers/index.ts already concatenates both arrays, so the slice never edits the registry.
 */
import type { JobHandler, NeedsYouResolver } from '../contracts.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const knowledgeLearningJobHandlers: JobHandler<any, any>[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const knowledgeLearningNeedsYouResolvers: NeedsYouResolver<any>[] = [];
