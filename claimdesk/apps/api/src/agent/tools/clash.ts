// owned by ap-clash
/**
 * clash tools (docs/SUPREME-AUTOPILOT.md §H.2). Registered by agent/tools/index.ts.
 *   clash_check        read*    POST /clashes/check (persists findings for the claim; class read because it changes
 *                               nothing the claim relies on)
 *   eligibility_get    read     GET  /claims/:id/eligibility
 *   eligibility_assess internal POST /claims/:id/eligibility/assess (records the computed assessment)
 * Outputs name no other claim: related claim ids are dropped from what the model sees (counts only).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import type { ActionDescriptor, Decision } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import type { NeedsYouInput, RunContext, ToolDef } from '../contracts.js';
import { DEFAULT_MAX_OUTPUT_CHARS } from '../contracts.js';
import { toolInputSchema } from '../../ai/strictSchema.js';
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

const read =
  (kind: string) =>
  (i: { claimId?: string | null }, rc: RunContext): ActionDescriptor => ({ class: 'read', kind: `read.${kind}`, ...((i.claimId ?? rc.claimScope) ? { claimId: (i.claimId ?? rc.claimScope)! } : {}), confidence: 1 });

/** A finding as the model sees it: no other claim's ids or references. */
function shapeFinding(f: Record<string, unknown>): Record<string, unknown> {
  const related = obj(f.related);
  return {
    code: f.code,
    severity: f.severity,
    overrideClass: f.overrideClass,
    message: f.message,
    ...(f.status ? { status: f.status } : {}),
    ...(f.id ? { findingId: f.id } : {}),
    ...(f.reservationId ? { reservationId: f.reservationId } : {}),
    ...(f.fleetUnitId ? { fleetUnitId: f.fleetUnitId } : {}),
    otherClaims: Array.isArray(related.claimIds) ? related.claimIds.length : 0,
  };
}

const clashCheck = tool({
  name: 'clash_check',
  title: 'Check for booking clashes',
  description:
    "Run the clash catalogue for a claim, or for a proposed booking of one fleet car (give fleetUnitId, and the period). Returns block / warn / info findings with plain-English messages; the findings are stored on the claim. Block findings stop a booking: you never override them (a manager does, in the booking dialog). Messages never name other claims.",
  class: 'read',
  input: z.strictObject({
    claimId: id().describe('ClaimDesk claim id'),
    fleetUnitId: id().nullable().describe('Fleet car to check a proposed booking for (null: check the claim itself)'),
    startAt: z.string().min(10).max(40).nullable().describe('Proposed start (ISO 8601); null = now'),
    expectedEndAt: z.string().min(10).max(40).nullable().describe('Proposed expected end (ISO 8601); null = the default projection'),
  }),
  http: (i: { claimId: string; fleetUnitId: string | null; startAt: string | null; expectedEndAt: string | null }) => ({
    method: 'POST',
    url: '/clashes/check',
    body: { claimId: i.claimId, ...(i.fleetUnitId ? { fleetUnitId: i.fleetUnitId } : {}), ...(i.startAt ? { startAt: i.startAt } : {}), ...(i.expectedEndAt ? { expectedEndAt: i.expectedEndAt } : {}) },
  }),
  httpRoute: { method: 'POST', pattern: '/clashes/check' },
  describe: read('clash_check'),
  shape: (raw) => {
    const r = obj(raw);
    return { blocks: r.blocks ?? [], greenBlocking: r.greenBlocking ?? [], findings: arr(r.findings).map(shapeFinding) };
  },
});

const eligibilityGet = tool({
  name: 'eligibility_get',
  title: 'Read the hire eligibility',
  description:
    "The claim's hire eligibility: each driver against the fleet policy's criteria (eligible / refer / ineligible / unknown, with reasons and what is missing), the client's need, means and roadworthiness (when hire should start). ClaimDesk cannot query DVLA: a missing licence check must be asked of the client.",
  class: 'read',
  input: z.strictObject({ claimId: id().describe('ClaimDesk claim id') }),
  http: (i: { claimId: string }) => ({ method: 'GET', url: `/claims/${enc(i.claimId)}/eligibility` }),
  httpRoute: { method: 'GET', pattern: '/claims/:id/eligibility' },
  describe: read('eligibility_get'),
  shape: (raw) => {
    const r = obj(raw);
    const s = obj(r.summary);
    const drv = (d: unknown) => {
      const x = obj(d);
      return { outcome: x.outcome, reasons: arr(x.reasons).map((y) => ({ code: y.code, outcome: y.outcome, message: y.message })), missing: x.missing, automaticOnly: x.automaticOnly, ageAtStart: x.ageAtStart, yearsFullLicence: x.yearsFullLicence };
    };
    return {
      overall: s.overall,
      green: s.green,
      reasons: s.reasons,
      driver: drv(s.driver),
      additionalDrivers: arr(s.additionalDrivers).map(drv),
      need: s.need,
      means: s.means,
      roadworthiness: s.roadworthiness,
      injury: s.injury,
      criteriaSource: r.criteriaSource,
    };
  },
});

/** A Needs-you item when the policy wants the owner to confirm recording the assessment. */
function askOwner(input: Record<string, unknown>, rc: RunContext, _ctx: AppContext, d: Decision): NeedsYouInput {
  return {
    kind: 'question',
    ...(typeof input.claimId === 'string' ? { claimId: input.claimId } : rc.claimScope ? { claimId: rc.claimScope } : {}),
    title: 'Record the hire eligibility assessment?',
    summary: `The ${rc.agent} agent wants to record the eligibility assessment; the autonomy policy asks you first (${d.reasons.join('; ') || d.ruleIds.join(', ')}).`,
    payload: { tool: 'eligibility_assess', input, decision: { outcome: d.outcome, ruleIds: d.ruleIds, reasons: d.reasons }, runId: rc.runId },
    priority: 'normal',
    createdBy: agentUserId(rc.agent),
    correlationId: rc.correlationId,
    dedupeKey: `ask:${rc.runId}:eligibility_assess:${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16)}`,
  };
}

const eligibilityAssess = tool({
  name: 'eligibility_assess',
  title: 'Record the hire eligibility assessment',
  description:
    'Compute and record the eligibility assessment (drivers, need, means, roadworthiness, injury) for the claim. Append-only: only the parts whose inputs changed are written. It never decides for the insurer: a referred driver needs the fleet insurer\'s written acceptance, recorded by the owner.',
  class: 'internal',
  input: z.strictObject({ claimId: id().describe('ClaimDesk claim id') }),
  http: (i: { claimId: string }) => ({ method: 'POST', url: `/claims/${enc(i.claimId)}/eligibility/assess`, body: {} }),
  httpRoute: { method: 'POST', pattern: '/claims/:id/eligibility/assess' },
  describe: (i: { claimId: string }) => ({ class: 'internal', kind: 'eligibility.assess', claimId: i.claimId, confidence: 1 }),
  onAsk: askOwner,
  shape: (raw) => {
    const r = obj(raw);
    const s = obj(r.summary);
    return { overall: s.overall, green: s.green, reasons: s.reasons, written: r.written };
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const clashTools: ToolDef<any, any>[] = [clashCheck, eligibilityGet, eligibilityAssess];
