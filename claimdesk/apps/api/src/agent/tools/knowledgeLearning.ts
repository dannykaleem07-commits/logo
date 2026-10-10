// owned by knowledge-learners
/**
 * MCP tools of knowledge-learners (docs/SUPREME-KNOWLEDGE-BUILDER.md §10.2). In-process `run` tools, available only to
 * the curator (`knowledge.curate` job; agent `researcher`) — every call checks the run's job type and cluster.
 *
 *   corrections_get           read   the cluster's corrections as MASKED diffs (SD §K.3 masks; figures, dates,
 *                                    references and party names as placeholders), plus the recurring edits code found
 *   knowledge_curate_propose  draft  propose a style fact, template snippet, rule (restrictive / advisory effects over
 *                                    RULE_FACT_IDS only), strategy or procedure for the cluster — through the store,
 *                                    which decides (KN-01…KN-19). Origin `curated`, use limit internal; the support is
 *                                    the number of the given corrections that share one identical edit.
 * Neither can record a check, approve, or touch claims, money or offers.
 */
import { z } from 'zod/v4';
import { recurringEdits, sha8, type KnowledgeArea, type KnowledgeData, type KnowledgeKind, type KnowledgeScope, type ActionDescriptor } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import type { RunContext, ToolDef } from '../contracts.js';
import { DEFAULT_MAX_OUTPUT_CHARS } from '../contracts.js';
import { agentUserId } from '../principal.js';
import { toolInputSchema } from '../../ai/strictSchema.js';
import { maskedCluster } from '../../knowledge/learners/corrections.js';
import { proposeKnowledge } from '../../knowledge/store.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
type AnyTool = ToolDef<any, any>;

function tool<S extends z.ZodType>(def: Omit<AnyTool, 'input' | 'strictSchema' | 'maxOutputChars'> & { input: S; maxOutputChars?: number }): AnyTool {
  return { ...def, strictSchema: toolInputSchema(def.input), maxOutputChars: def.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS } as AnyTool;
}

const toolError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

/** The curate job this run belongs to (refuses any other job type). */
function curateJob(ctx: AppContext, rc: RunContext): { clusterKey: string | null } {
  const job = ctx.repos.getAgentJob(ctx.db, rc.jobId);
  if (!job || job.type !== 'knowledge.curate') throw toolError('CURATE_ONLY', 'This tool is only for the knowledge curator (knowledge.curate)');
  const p = (job.payload ?? {}) as { clusterKey?: unknown };
  return { clusterKey: typeof p.clusterKey === 'string' ? p.clusterKey : null };
}

function assertCluster(ctx: AppContext, rc: RunContext, clusterKey: string): void {
  const job = curateJob(ctx, rc);
  if (job.clusterKey && job.clusterKey !== clusterKey) throw toolError('CLUSTER_SCOPE', `This run curates cluster ${job.clusterKey} only`);
}

const correctionsGet = tool({
  name: 'corrections_get',
  title: 'Read a corrections cluster (masked)',
  description:
    'The owner’s corrections in one cluster as masked word diffs (eq / ins / del), newest last, with the edits code found repeated. Personal data, figures, dates, references and party names are placeholders. Read only: nothing is stored or changed.',
  class: 'read',
  input: z.strictObject({ clusterKey: z.string().min(3).max(300) }),
  run: async (i: { clusterKey: string }, rc: RunContext, ctx: AppContext) => {
    assertCluster(ctx, rc, i.clusterKey);
    const corrections = maskedCluster(ctx, i.clusterKey, 30);
    const repeated = recurringEdits(
      corrections.map((c) => ({ ops: c.ops })),
      Math.min(3, Math.max(1, corrections.length)),
    ).slice(0, 15);
    return { clusterKey: i.clusterKey, correctionIds: corrections.map((c) => c.id), corrections, repeatedEdits: repeated };
  },
  describe: (): ActionDescriptor => ({ class: 'read', kind: 'read.corrections_get', confidence: 1 }),
  maxOutputChars: 60_000,
});

const KINDS = ['rule', 'strategy', 'template_snippet', 'procedure', 'fact'] as const;
const AREAS = ['style', 'procedural', 'strategy', 'contact'] as const;

interface ProposeInput {
  clusterKey: string;
  kind: (typeof KINDS)[number];
  area: (typeof AREAS)[number];
  title: string;
  body: string;
  data: string;
  scope: { kind: 'global' | 'insurer' | 'claim_type'; value: string | null };
  correctionIds: string[];
  confidence: number;
}

const curateTag = (clusterKey: string): string => `cluster:${clusterKey}`.slice(0, 64);

const knowledgeCuratePropose = tool({
  name: 'knowledge_curate_propose',
  title: 'Propose curated knowledge from the owner’s corrections',
  description:
    'Propose ONE item the owner’s repeated corrections show: a style fact (kind fact, area style), a template_snippet (area style), a rule (data {when, then, why, severity}: when uses only RULE_FACT_IDS; then only require_document / ask_owner / add_check / avoid_phrase / prefer_step / suggest_followup), a strategy or a procedure. `data` is the JSON of the kind’s data. It is stored as curated, internal knowledge and the policy decides: rules and strategies always wait for the owner; nothing you propose can loosen any check, send anything, approve anything or touch money or offers.',
  class: 'draft',
  input: z.strictObject({
    clusterKey: z.string().min(3).max(300),
    kind: z.enum(KINDS),
    area: z.enum(AREAS),
    title: z.string().min(3).max(200),
    body: z.string().min(1).max(4000),
    data: z.string().min(2).max(8000).describe('JSON text of the kind’s data object'),
    scope: z.strictObject({ kind: z.enum(['global', 'insurer', 'claim_type']), value: z.string().max(128).nullable() }),
    correctionIds: z.array(z.string().min(1).max(64)).min(1).max(50),
    confidence: z.number().min(0).max(1),
  }),
  run: async (i: ProposeInput, rc: RunContext, ctx: AppContext) => {
    assertCluster(ctx, rc, i.clusterKey);
    let data: unknown;
    try {
      data = JSON.parse(i.data);
    } catch {
      throw toolError('VALIDATION', 'data is not valid JSON');
    }
    if (i.kind === 'fact' && i.area !== 'style') throw toolError('VALIDATION', 'A curated fact is a style fact (area style)');
    const corrections = ctx.repos.getCorrections(ctx.db, [...new Set(i.correctionIds)]).filter((c) => c.clusterKey === i.clusterKey);
    if (!corrections.length) throw toolError('VALIDATION', 'correctionIds must be corrections of this cluster');
    // Support = how many of these corrections share one identical edit (KN-18 needs ≥ styleSupport).
    const top = recurringEdits(corrections.map((c) => ({ ops: c.diff })), 1)[0];
    const supportN = Math.max(1, top?.support ?? 1);
    const scope: KnowledgeScope = i.scope.kind === 'insurer' && i.scope.value ? { kind: 'insurer', slug: i.scope.value } : i.scope.kind === 'claim_type' && i.scope.value ? { kind: 'claim_type', tag: i.scope.value as never } : { kind: 'global' };
    const r = proposeKnowledge(
      ctx,
      {
        kind: i.kind as KnowledgeKind,
        area: i.area as KnowledgeArea,
        title: i.title,
        body: i.body,
        data: data as KnowledgeData,
        tags: ['curated', curateTag(i.clusterKey)],
        scope,
        business: ['ccguk'],
        useLimit: 'internal',
        origin: 'curated',
        confidence: i.confidence,
        supportN,
        provenance: [{ kind: 'correction', correctionIds: corrections.map((c) => c.id) }],
        ...(i.kind === 'rule' ? { itemKey: `rule:${i.clusterKey}:${sha8(i.title)}` } : {}),
        createdBy: agentUserId(rc.agent),
        originJobId: rc.jobId,
        originRunId: rc.runId,
      },
      { runId: rc.runId, jobId: rc.jobId, group: { key: `knowledge_review:curated:${curateTag(i.clusterKey)}`, title: `Your edits suggest: ${i.title}`.slice(0, 200) } },
    );
    return { itemId: r.item.id, decision: r.decision.outcome, reasons: r.decision.reasons, supportN, status: r.item.status };
  },
  describe: (i: ProposeInput): ActionDescriptor => ({ class: 'draft', kind: 'knowledge.curate_propose', confidence: typeof i?.confidence === 'number' ? i.confidence : 0.5 }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const knowledgeLearningTools: ToolDef<any, any>[] = [correctionsGet, knowledgeCuratePropose];
