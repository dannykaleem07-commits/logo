// owned by intake
/**
 * intake tools (docs/SUPREME-DESIGN.md §B.4). Registered by agent/tools/index.ts (foundation).
 *
 *  - `claim_field_propose` [internal]: the extractor proposes one claim/vehicle/party field with its source. Creating
 *    the proposal changes nothing on the claim; the proposal's own policy (auto / confirm / never) comes from
 *    `decide()` for an internal field update plus the intake rules (intake/proposals.ts) — sensitive, overwriting or
 *    low-confidence values are confirmed by the owner in ONE grouped Needs-you card per document (intake.apply).
 *  - `claim_field_apply` [internal]: apply proposals that are already `auto` through `POST /proposals/apply` (which
 *    calls the existing claim / vehicle / party routes with the same run token). Not in any agent's tool list today;
 *    it declares the routes intake writes through, so the agent perimeter's allow-list (§B.2 rule 1) covers them.
 */
import { z } from 'zod/v4';
import { FIELD_TARGETS, type ActionDescriptor } from '@ccguk/domain';
import type { RunContext, ToolDef } from '../contracts.js';
import { DEFAULT_MAX_OUTPUT_CHARS } from '../contracts.js';
import type { AppContext } from '../../context.js';
import { toolInputSchema } from '../../ai/strictSchema.js';
import { proposeField } from '../../intake/proposals.js';
import { TARGET_ROUTES, targetLabel } from '../../intake/targets.js';

const id = () => z.string().min(1).max(128);

export const claimFieldProposeInput = z.strictObject({
  claimId: id().describe('The claim of this run'),
  target: z.enum(FIELD_TARGETS as unknown as [string, ...string[]]).describe('Where the value goes on the claim (closed list)'),
  value: z.string().min(1).max(2000).describe('The value exactly as read (code normalises and validates it)'),
  confidence: z.number().min(0).max(1),
  source: z.strictObject({
    evidenceId: id().describe('The evidence file the value was read from'),
    page: z.number().int().min(1).max(10_000).nullable(),
    quote: z.string().max(500).nullable().describe('The exact words the value was read from'),
  }),
});
export type ClaimFieldProposeInput = z.infer<typeof claimFieldProposeInput>;

/** The intake item a run is working on (from its job payload). */
function itemIdOfRun(ctx: AppContext, rc: RunContext): string | undefined {
  const job = ctx.repos.getAgentJob(ctx.db, rc.jobId);
  const p = (job?.payload ?? {}) as { itemId?: unknown };
  return typeof p.itemId === 'string' ? p.itemId : undefined;
}

const claimFieldPropose: ToolDef<ClaimFieldProposeInput, unknown> = {
  name: 'claim_field_propose',
  title: 'Propose a claim field',
  description:
    'Propose one value for the claim, a vehicle or a party, read from a document, with the page and the exact quote. Code validates it, compares it with what is on file and decides: empty + confident + valid + not sensitive fields fill automatically; anything else waits for the owner in one grouped confirmation. It never changes liability, money or the claim status, and never overwrites without the owner.',
  class: 'internal',
  input: claimFieldProposeInput as unknown as ToolDef<ClaimFieldProposeInput>['input'],
  strictSchema: toolInputSchema(claimFieldProposeInput),
  async run(input, rc, ctx) {
    const claim = ctx.repos.requireClaim(ctx.db, input.claimId);
    const ev = ctx.repos.getEvidence(ctx.db, input.source.evidenceId);
    if (!ev) throw Object.assign(new Error(`Evidence ${input.source.evidenceId} not found`), { code: 'NOT_FOUND' });
    const itemId = itemIdOfRun(ctx, rc);
    const item = itemId ? ctx.repos.getIntakeItem(ctx.db, itemId) : undefined;
    if (ev.claimId && ev.claimId !== claim.id) throw Object.assign(new Error('That evidence is on another claim'), { code: 'CLAIM_SCOPE' });
    if (!ev.claimId && item?.evidenceId !== ev.id) throw Object.assign(new Error('That evidence is not the document of this run'), { code: 'CLAIM_SCOPE' });
    const r = proposeField(ctx, {
      claimId: claim.id,
      ...(item ? { intakeItemId: item.id } : {}),
      target: input.target,
      value: input.value,
      confidence: input.confidence,
      source: { ...(item ? { intakeItemId: item.id } : {}), evidenceId: ev.id, page: input.source.page, quote: input.source.quote, via: 'tool', runId: rc.runId },
    });
    if (r.kind === 'skipped') return { status: 'skipped', target: input.target, reason: r.reason };
    const p = r.proposal;
    return {
      status: p.status === 'rejected' ? 'refused' : 'proposed',
      proposalId: p.id,
      target: p.target,
      label: targetLabel(p.target),
      policy: p.policyDecision,
      reasons: p.validator?.policy?.reasons ?? [],
      validator: p.validator?.validator ?? null,
      note: p.policyDecision === 'auto' ? 'Will be filled automatically after extraction.' : p.policyDecision === 'confirm' ? 'Will be put to the owner in one grouped confirmation.' : 'Cannot be applied on this claim.',
    };
  },
  // Creating a proposal changes nothing; the per-field policy is decided inside (proposals.ts).
  describe: (input, rc): ActionDescriptor => ({ class: 'internal', kind: 'field.propose', claimId: input.claimId ?? rc.claimScope, confidence: 1 }),
  maxOutputChars: 4_000,
};

export const claimFieldApplyInput = z.strictObject({
  claimId: id(),
  proposalIds: z.array(id()).min(1).max(50),
});
export type ClaimFieldApplyInput = z.infer<typeof claimFieldApplyInput>;

const claimFieldApply: ToolDef<ClaimFieldApplyInput, unknown> = {
  name: 'claim_field_apply',
  title: 'Apply automatic field proposals',
  description: 'Apply proposals whose policy is already auto (empty field, confident, valid, not sensitive) through the existing claim, vehicle and party routes. Anything else is refused and stays with the owner.',
  class: 'internal',
  input: claimFieldApplyInput as unknown as ToolDef<ClaimFieldApplyInput>['input'],
  strictSchema: toolInputSchema(claimFieldApplyInput),
  http: (input) => ({ method: 'POST', url: '/proposals/apply', body: { claimId: input.claimId, ids: input.proposalIds } }),
  httpRoute: [{ method: 'POST', pattern: '/proposals/apply' }, ...TARGET_ROUTES],
  describe: (input, rc, ctx): ActionDescriptor => {
    const proposals = ctx.repos.listClaimUpdateProposals(ctx.db, { ids: input.proposalIds });
    const allAuto = proposals.length === input.proposalIds.length && proposals.every((p) => p.policyDecision === 'auto' && p.status === 'pending' && p.claimId === input.claimId);
    const confidence = proposals.length ? Math.min(...proposals.map((p) => p.confidence)) : 0;
    return { class: 'internal', kind: 'field.apply', claimId: input.claimId ?? rc.claimScope, confidence, sensitive: !allAuto || proposals.some((p) => p.sensitive), overwrites: proposals.some((p) => Boolean(p.currentValue)) };
  },
  maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool has its own input/output types
export const intakeTools: ToolDef<any, any>[] = [claimFieldPropose, claimFieldApply];
