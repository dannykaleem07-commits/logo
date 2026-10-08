// owned by intake
/**
 * Applying proposals (docs/SUPREME-DESIGN.md §G.2 step 6): always through the existing routes with `ctx.inject`, so
 * route validation, refusals, audit rows and clock recomputes apply exactly as for a person.
 *
 *  - Automatic proposals run as `agent:intake` with a short-lived run token scoped to the claim — the agent perimeter
 *    (route allow-list, claim scope, no manager mode) checks every call.
 *  - Confirmed proposals run AS THE OWNER, with the owner's own credentials (intake/callerContext.ts).
 *
 * Every applied proposal also gets an `intake.apply` audit row citing `{intakeItemId, evidenceId, page, quote}`.
 */
import { randomUUID } from 'node:crypto';
import type { Actor, ClaimUpdateProposalRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { agentUserId, mintRunToken, revokeRunToken } from '../agent/principal.js';
import { ownerHeaders } from './callerContext.js';
import { loadClaimSnapshot, sameValue, targetDef, type ApplyStep } from './targets.js';

export interface Applier {
  kind: 'agent' | 'owner';
  actor: Actor;
  headers: Record<string, string>;
  /** Agents only: the one claim this applier may write to. */
  claimScope?: string;
  release(): void;
}

/** `agent:intake` with a 5-minute run token limited to `claimId`. */
export function agentApplier(ctx: AppContext, input: { claimId: string; jobId: string; runId?: string }): Applier {
  const runId = input.runId ?? `intake-apply-${randomUUID()}`;
  const token = mintRunToken({ name: 'intake', runId, jobId: input.jobId, claimScope: input.claimId }, 5 * 60_000);
  return {
    kind: 'agent',
    actor: { userId: agentUserId('intake'), runId },
    headers: { authorization: `Bearer ${token}` },
    claimScope: input.claimId,
    release: () => revokeRunToken(token),
  };
}

/** The signed-in owner (credentials of the current request). */
export function ownerApplier(ctx: AppContext, actor: Actor): Applier {
  return { kind: 'owner', actor, headers: ownerHeaders(ctx, actor), release: () => undefined };
}

export interface ApplyOutcome {
  proposalId: string;
  ok: boolean;
  /** Code + message of a refusal (route error, validator, unavailable target). */
  error?: { code: string; message: string };
  /** For an automatic apply: the value on the claim changed since the proposal (→ confirmation). */
  needsConfirmation?: boolean;
  routes?: string[];
}

async function inject(ctx: AppContext, applier: Applier, step: ApplyStep): Promise<{ status: number; body: unknown }> {
  if (!ctx.inject) throw new Error('ctx.inject is not wired (buildApp sets it)');
  const res = await ctx.inject({
    method: step.method,
    url: `/api${step.url}`,
    headers: { ...applier.headers, 'content-type': 'application/json' },
    payload: JSON.stringify(step.body),
  });
  let body: unknown;
  try {
    body = res.body ? JSON.parse(res.body) : undefined;
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body };
}

/**
 * Apply one pending proposal (optionally with the owner's edited value). On success the proposal is `applied`, other
 * pending proposals on the same target are superseded, and `intake.apply` is audited. A failure leaves it pending.
 */
export async function applyProposal(ctx: AppContext, proposal: ClaimUpdateProposalRecord, applier: Applier, opts: { value?: string; note?: string } = {}): Promise<ApplyOutcome> {
  const fail = (code: string, message: string, extra: Partial<ApplyOutcome> = {}): ApplyOutcome => ({ proposalId: proposal.id, ok: false, error: { code, message }, ...extra });
  if (proposal.status !== 'pending') return fail('PROPOSAL_DECIDED', `This proposal is already ${proposal.status}`);
  if (proposal.policyDecision === 'never') return fail('PROPOSAL_NEVER', 'This field cannot be applied on this claim');
  if (applier.kind === 'agent' && proposal.policyDecision !== 'auto') return fail('NEEDS_OWNER', 'Only the owner can apply a field that needs confirmation');
  if (applier.kind === 'agent' && proposal.claimId !== applier.claimScope) return fail('CLAIM_SCOPE', 'An agent applies proposals only on the claim of its run');
  const def = targetDef(proposal.target);
  if (!def) return fail('UNKNOWN_TARGET', `${proposal.target} is not a known field`);
  const now = ctx.now();
  const snapshot = loadClaimSnapshot(ctx, proposal.claimId);

  let value = proposal.proposedValue;
  if (opts.value !== undefined && opts.value.trim() && opts.value.trim() !== proposal.proposedValue) {
    const v = def.validate(opts.value.trim(), { now });
    if (!v.ok) return fail('VALIDATION', `${def.label}: ${v.errors.join('; ')}`);
    value = v.value ?? opts.value.trim();
  }
  const insp = def.inspect(snapshot, value);
  if (insp.unavailable) return fail('TARGET_UNAVAILABLE', insp.unavailable);
  if (insp.current && sameValue(insp.current, value)) {
    // Already there (applied by someone else meanwhile): settle the proposal without a write.
    ctx.repos.decideClaimUpdateProposal(ctx.db, proposal.id, { status: 'applied', decidedBy: applier.actor.userId, decidedAt: now, note: 'the claim already held this value' });
    return { proposalId: proposal.id, ok: true, routes: [] };
  }
  if (applier.kind === 'agent' && (insp.current || insp.createsRecord)) {
    return fail('VALUE_CHANGED', 'The claim now holds a value for this field; the owner must confirm the change', { needsConfirmation: true });
  }

  const prov = { intakeItemId: proposal.source.intakeItemId ?? proposal.intakeItemId, evidenceId: proposal.source.evidenceId, page: proposal.source.page ?? null, quote: proposal.source.quote ?? null, proposalId: proposal.id };
  const builders = def.plan(snapshot, value, prov, now);
  const responses: unknown[] = [];
  const routes: string[] = [];
  for (const build of builders) {
    const step = build(responses);
    const res = await inject(ctx, applier, step);
    routes.push(`${step.method} ${step.url}`);
    if (res.status >= 400) {
      const err = ((res.body as { error?: { code?: string; message?: string } } | undefined)?.error ?? {}) as { code?: string; message?: string };
      return fail(err.code ?? `HTTP_${res.status}`, err.message ?? `The route answered ${res.status}`, { routes });
    }
    responses.push(res.body);
  }

  ctx.db.transaction((tx) => {
    ctx.repos.decideClaimUpdateProposal(tx, proposal.id, { status: 'applied', decidedBy: applier.actor.userId, decidedAt: now, ...(opts.note ? { note: opts.note } : {}), ...(value !== proposal.proposedValue ? { appliedValue: value } : {}) });
    ctx.repos.supersedeClaimUpdateProposals(tx, { claimId: proposal.claimId, target: proposal.target, keepId: proposal.id, decidedBy: applier.actor.userId, now });
    ctx.repos.appendAudit(tx, {
      actor: applier.actor,
      action: 'intake.apply',
      entity: 'claim_update_proposals',
      entityId: proposal.id,
      before: { value: insp.current ?? null },
      after: {
        claimId: proposal.claimId,
        target: proposal.target,
        value,
        policy: proposal.policyDecision,
        confirmedBy: applier.kind === 'owner' ? applier.actor.userId : null,
        intakeItemId: prov.intakeItemId ?? null,
        evidenceId: prov.evidenceId ?? null,
        page: prov.page,
        quote: prov.quote,
        routes,
      },
      at: now,
    });
  });
  return { proposalId: proposal.id, ok: true, routes };
}

/** Order so a name / registration (which may create the party or vehicle) goes before the other fields of the role. */
export function applyOrder(a: ClaimUpdateProposalRecord, b: ClaimUpdateProposalRecord): number {
  const rank = (t: string) => (/\.(name|registration)$/.test(t) ? 0 : 1);
  return rank(a.target) - rank(b.target) || a.createdAt.localeCompare(b.createdAt);
}

/** Apply several proposals in order with one applier (released at the end). */
export async function applyProposals(ctx: AppContext, proposals: ClaimUpdateProposalRecord[], applier: Applier, opts: { values?: Record<string, string>; note?: string } = {}): Promise<ApplyOutcome[]> {
  const out: ApplyOutcome[] = [];
  try {
    for (const p of [...proposals].sort(applyOrder)) {
      const fresh = ctx.repos.getClaimUpdateProposal(ctx.db, p.id) ?? p;
      out.push(await applyProposal(ctx, fresh, applier, { ...(opts.values?.[p.id] !== undefined ? { value: opts.values[p.id] } : {}), ...(opts.note ? { note: opts.note } : {}) }));
    }
  } finally {
    applier.release();
  }
  return out;
}

/** Reject pending proposals with a reason (the owner's, or the system's). */
export function rejectProposals(ctx: AppContext, ids: string[], actor: Actor, reason: string): ClaimUpdateProposalRecord[] {
  const now = ctx.now();
  const out: ClaimUpdateProposalRecord[] = [];
  ctx.db.transaction((tx) => {
    for (const id of ids) {
      const p = ctx.repos.getClaimUpdateProposal(tx, id);
      if (!p || p.status !== 'pending') continue;
      const r = ctx.repos.decideClaimUpdateProposal(tx, id, { status: 'rejected', decidedBy: actor.userId, decidedAt: now, reason });
      ctx.repos.appendAudit(tx, { actor, action: 'intake.reject', entity: 'claim_update_proposals', entityId: id, after: { claimId: p.claimId, target: p.target, value: p.proposedValue, reason, intakeItemId: p.intakeItemId ?? null }, at: now });
      out.push(r);
    }
  });
  return out;
}
