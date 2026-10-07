// owned by runtime
/**
 * runtime tools (docs/SUPREME-DESIGN.md §B.4). Registered by agent/tools/index.ts (foundation).
 *
 * `needs_you_create` (class `draft`, policy `auto`): an agent explains a situation to the owner — a question, missing
 * information, a legal matter, a suspicious email, a problem. It never acts; the owner's answer is recorded on the item
 * and the waiting job (if any) resumes. Kinds that carry a structured payload a slice resolver depends on
 * (approve_send, confirm_fields, offer_decision, money, …) are raised by those slices' own code, not by this tool.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { UNSUPPORTED_SCHEMA_KEYWORDS, type JsonSchema, type NeedsYouKind, type NeedsYouOption } from '@ccguk/domain';
import type { ToolDef } from '../contracts.js';
import { DEFAULT_MAX_OUTPUT_CHARS } from '../contracts.js';
import { createNeedsYou } from '../core.js';

/** Kinds an agent may raise with this tool. */
export const AGENT_NEEDS_YOU_KINDS = ['question', 'missing_info', 'legal_review', 'spoof_warning', 'override_needed', 'failure'] as const satisfies readonly NeedsYouKind[];

const basis = z.strictObject({ kind: z.enum(['fact', 'kb', 'pack', 'rule', 'event', 'evidence', 'memory', 'message']), id: z.string(), label: z.string().nullable() });
const draftRef = z.strictObject({ kind: z.enum(['outbox', 'document', 'docx', 'proposal', 'task', 'memory']), id: z.string() });

export const needsYouCreateInput = z.strictObject({
  kind: z.enum(AGENT_NEEDS_YOU_KINDS),
  title: z.string().min(3).max(160),
  summary: z.string().min(3).max(4000),
  recommendation: z.strictObject({ action: z.string().max(500), why: z.string().max(2000), confidence: z.number().min(0).max(1), basis: z.array(basis).max(20) }).nullable(),
  draftRefs: z.array(draftRef).max(10),
  priority: z.enum(['urgent', 'high', 'normal', 'low']),
  dueAt: z.iso.datetime({ offset: true }).nullable(),
});
export type NeedsYouCreateInput = z.infer<typeof needsYouCreateInput>;

/** z.toJSONSchema → strict-compatible (drop the keywords strict tools do not support, §B.5). */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if ((UNSUPPORTED_SCHEMA_KEYWORDS as readonly string[]).includes(k) || k === 'format') continue;
      out[k] = strip(val);
    }
    return out;
  };
  return strip(z.toJSONSchema(schema)) as JsonSchema;
}

function optionsFor(kind: NeedsYouCreateInput['kind'], hasDrafts: boolean): NeedsYouOption[] {
  if (kind === 'question') {
    return [
      { id: 'answer', label: 'Answer', tone: 'primary', requiresReason: true },
      { id: 'dismiss', label: 'Dismiss', tone: 'neutral' },
    ];
  }
  if (kind === 'missing_info' && hasDrafts) {
    return [
      { id: 'approve', label: 'Approve the prepared request', tone: 'primary' },
      { id: 'edit', label: 'Edit then approve', tone: 'neutral', requiresEdit: true },
      { id: 'reject', label: 'Reject', tone: 'danger', requiresReason: true },
    ];
  }
  return [
    { id: 'acknowledge', label: 'Done', tone: 'primary' },
    { id: 'dismiss', label: 'Dismiss', tone: 'neutral' },
  ];
}

const needsYouCreate: ToolDef<NeedsYouCreateInput, { status: 'created' | 'existing'; needsYouId: string }> = {
  name: 'needs_you_create',
  title: 'Ask the owner (Needs you)',
  description:
    'Raise an item in the owner\'s Needs-you inbox: a question, missing information (with the prepared request as a draft ref), a legal matter, a suspicious email or a problem. Use it whenever something needed is missing or a decision belongs to the owner. It never sends, approves or changes anything.',
  class: 'draft',
  input: needsYouCreateInput,
  strictSchema: toStrictJsonSchema(needsYouCreateInput),
  async run(input, rc, ctx) {
    const hash = createHash('sha256').update(`${input.kind}\n${input.title}`).digest('hex').slice(0, 16);
    const created = ctx.repos.findOpenNeedsYouByDedupeKey(ctx.db, `agent:${rc.correlationId}:${hash}`);
    const item = createNeedsYou(ctx, {
      kind: input.kind,
      ...(rc.claimScope ? { claimId: rc.claimScope } : {}),
      title: input.title,
      summary: input.summary,
      ...(input.recommendation ? { recommendation: input.recommendation } : {}),
      options: optionsFor(input.kind, input.draftRefs.length > 0),
      payload: { draftRefs: input.draftRefs, runId: rc.runId, jobId: rc.jobId },
      priority: input.priority,
      ...(input.dueAt ? { dueAt: new Date(Date.parse(input.dueAt)).toISOString() } : {}),
      createdBy: `agent:${rc.agent}`,
      dedupeKey: `agent:${rc.correlationId}:${hash}`,
      correlationId: rc.correlationId,
    });
    return { status: created ? 'existing' : 'created', needsYouId: item.id };
  },
  describe: (input, rc) => ({ class: 'draft', kind: `needs_you.${input.kind}`, ...(rc.claimScope ? { claimId: rc.claimScope } : {}), confidence: 1 }),
  maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool has its own input/output types
export const needsYouTools: ToolDef<any, any>[] = [needsYouCreate];
