// owned by ap-paperwork
/**
 * Paperwork tools (docs/SUPREME-AUTOPILOT.md §H.2). Registered by agent/tools/index.ts.
 *   signatures_list  read   GET /claims/:id/signatures (signed documents with method, open signature requests, packs)
 *   pack_prepare     draft  enqueue `pack.prepare` (in-process): the pack's documents are generated from the file by
 *                           code and reviewed; approval stays with the owner (Needs-you approve_pack)
 * Outputs carry ids, titles and statuses only (no document text, no other claim).
 */
import { z } from 'zod/v4';
import { PACK_STAGES, type ActionDescriptor } from '@ccguk/domain';
import type { RunContext, ToolDef } from '../contracts.js';
import { DEFAULT_MAX_OUTPUT_CHARS } from '../contracts.js';
import { toolInputSchema } from '../../ai/strictSchema.js';
import { enqueueJob } from '../core.js';
import { agentUserId } from '../principal.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
type AnyTool = ToolDef<any, any>;

const id = () => z.string().min(1).max(128);
const enc = encodeURIComponent;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as unknown[]).map(obj) : []);

function tool<S extends z.ZodType>(def: Omit<AnyTool, 'input' | 'strictSchema' | 'maxOutputChars'> & { input: S; maxOutputChars?: number }): AnyTool {
  return { ...def, strictSchema: toolInputSchema(def.input), maxOutputChars: def.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS } as AnyTool;
}

const signaturesList = tool({
  name: 'signatures_list',
  title: 'List signatures and paperwork packs',
  description:
    "The claim's signed documents (how each was signed: kiosk code by email, code shown to the Claims Team, wet ink or scan), the open signature requests (sent, chased, returned) and the paperwork packs with their status. Read-only. You never mark anything signed: a person confirms returned copies.",
  class: 'read',
  input: z.strictObject({ claimId: id().describe('ClaimDesk claim id') }),
  http: (i: { claimId: string }) => ({ method: 'GET', url: `/claims/${enc(i.claimId)}/signatures` }),
  httpRoute: { method: 'GET', pattern: '/claims/:id/signatures' },
  describe: (i: { claimId: string }, rc: RunContext): ActionDescriptor => ({ class: 'read', kind: 'read.signatures_list', claimId: i.claimId ?? rc.claimScope, confidence: 1 }),
  shape: (raw) => {
    const r = obj(raw);
    return {
      signatures: arr(r.signatures).map((s) => ({ documentId: s.documentId, title: s.title, templateId: s.templateId, signedAt: s.signedAt, method: s.method, packId: s.packId ?? null })),
      requests: arr(r.requests).map((q) => ({ id: q.id, documentId: q.documentId, status: q.status, sentAt: q.sentAt ?? null, chaseCount: q.chaseCount, nextChaseAt: q.nextChaseAt ?? null })),
      packs: arr(r.packs).map((p) => ({ id: p.id, stage: p.stage, status: p.status, reservationId: p.reservationId ?? null, items: arr(p.view).map((i) => ({ templateId: i.templateId, variant: i.variant ?? null, status: i.status, title: i.title ?? null, verdict: i.verdict ?? null })) })),
    };
  },
});

const packPrepare = tool({
  name: 'pack_prepare',
  title: 'Prepare a paperwork pack',
  description:
    'Prepare the documents for a stage (signup, hire_offer, hire_start, off_hire, billing, payment, closure): each is generated from the claim file by code and checked by the reviewer, then the owner approves the whole pack in one Needs-you card. Nothing is approved, signed or sent by this tool. Give reservationId for hire_start and off_hire.',
  class: 'draft',
  input: z.strictObject({
    claimId: id().describe('ClaimDesk claim id'),
    stage: z.enum(PACK_STAGES as unknown as [string, ...string[]]).describe('Paperwork stage'),
    reservationId: id().nullable().describe('The booking the pack is for (hire_start, off_hire); null otherwise'),
  }),
  run: async (i: { claimId: string; stage: string; reservationId: string | null }, rc, ctx) => {
    const job = enqueueJob(ctx, {
      type: 'pack.prepare',
      payload: { claimId: i.claimId, stage: i.stage, ...(i.reservationId ? { reservationId: i.reservationId } : {}) },
      claimId: i.claimId,
      idempotencyKey: `pack.prepare:${i.claimId}:${i.stage}:${i.reservationId ?? '-'}:0`,
      ...(rc.jobId.startsWith('autopilot:') ? {} : { parentJobId: rc.jobId }),
      correlationId: rc.correlationId,
      createdBy: agentUserId(rc.agent),
    });
    return { jobId: job.id, status: job.status, note: 'Queued. The documents are generated from the file and reviewed; the owner approves the pack.' };
  },
  describe: (i: { claimId: string; stage: string }, rc: RunContext): ActionDescriptor => ({ class: 'draft', kind: `pack.prepare.${i.stage}`, claimId: i.claimId ?? rc.claimScope, confidence: 1 }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const signingTools: ToolDef<any, any>[] = [signaturesList, packPrepare];
