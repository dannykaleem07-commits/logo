/**
 * Claim view assembly: ClaimBundle (from @ccguk/db) + derived clocks, evidence gates, playbook actions and the
 * acceptance assessment. Clocks are recomputed and cached (`replaceClocks`) whenever the chronology changes.
 */
import { evaluateGates, type CaseAcceptance, type Claim, type ClaimBundle, type Clock, type GateResult, type Id, type PlaybookAction, type PlaybookRule } from '@ccguk/domain';
import { assessAcceptanceFor, deriveClocksFor as domainClocks, nextActionsFor } from '../engines.js';
import type { AppContext } from '../context.js';
import { deriveClocksFallback } from './fallbacks.js';

export interface ClaimView extends ClaimBundle {
  gates: GateResult[];
  actions: PlaybookAction[];
  acceptance: CaseAcceptance;
  position: ReturnType<AppContext['repos']['ledgerPosition']>;
  linkedClaims: Array<{ id: Id; reference: string; status: string }>;
}

export function loadBundle(ctx: AppContext, claimId: Id, includeHtml = false): ClaimBundle {
  return ctx.repos.loadClaimBundle(ctx.db, claimId, { includeHtml });
}

/** Derive clocks for the bundle: the domain engine, supplemented by the API-side kinds it does not emit (off-hire triggers from the hire record). */
export function deriveClocksFor(ctx: AppContext, bundle: ClaimBundle): Array<Omit<Clock, 'id' | 'claimId'> & { id?: string }> {
  const now = ctx.now();
  const fromDomain = domainClocks(bundle, now).map(({ claimId: _c, ...rest }) => rest);
  const kinds = new Set(fromDomain.map((c) => c.kind));
  const supplement = deriveClocksFallback(bundle, now).filter((c) => !kinds.has(c.kind));
  return [...fromDomain, ...supplement];
}

/** Recompute and cache the clocks for a claim; returns the cached rows. */
export function recomputeClocks(ctx: AppContext, claimId: Id): Clock[] {
  const bundle = loadBundle(ctx, claimId);
  const derived = deriveClocksFor(ctx, bundle);
  return ctx.repos.replaceClocks(ctx.db, claimId, derived, ctx.now());
}

export function gatesFor(bundle: ClaimBundle): GateResult[] {
  return evaluateGates(bundle);
}

function playbookRules(ctx: AppContext): PlaybookRule[] {
  return (ctx.kb.playbookRules() as unknown[]).filter((r): r is PlaybookRule => {
    const o = r as Partial<PlaybookRule> | null;
    return Boolean(o && typeof o.code === 'string' && typeof o.title === 'string' && Array.isArray(o.basis));
  });
}

/**
 * Has this at-fault insurer ever paid CCGUK? Drives the vendor-verification pack action (BLUEPRINT §7). Undefined when
 * there is no other file with the insurer (unknown), false when there are files but no payment, true on any payment.
 */
export function insurerPaidBefore(ctx: AppContext, claim: Claim): boolean | undefined {
  if (!claim.atFaultInsurerId) return undefined;
  const others = ctx.repos.listClaims(ctx.db, { atFaultInsurerId: claim.atFaultInsurerId, limit: 10_000 }).filter((c) => c.id !== claim.id);
  if (!others.length) return undefined;
  return others.some((c) => ctx.repos.listLedger(ctx.db, c.id).some((e) => e.kind === 'paid' || e.kind === 'interim_paid'));
}

export function actionsFor(ctx: AppContext, bundle: ClaimBundle, gates: GateResult[]): PlaybookAction[] {
  const rules = playbookRules(ctx);
  const paidBefore = insurerPaidBefore(ctx, bundle.claim);
  return nextActionsFor(bundle, { now: ctx.now(), gates, ...(rules.length ? { rules } : {}), ...(paidBefore !== undefined ? { insurerPaidBefore: paidBefore } : {}) });
}

export function acceptanceFor(ctx: AppContext, bundle: ClaimBundle, gates: GateResult[]): CaseAcceptance {
  return assessAcceptanceFor(bundle, gates, ctx.now());
}

export function buildClaimView(ctx: AppContext, claimId: Id): ClaimView {
  const clocks = recomputeClocks(ctx, claimId);
  const bundle = { ...loadBundle(ctx, claimId), clocks };
  const gates = gatesFor(bundle);
  const actions = actionsFor(ctx, bundle, gates);
  const acceptance = acceptanceFor(ctx, bundle, gates);
  const position = ctx.repos.ledgerPosition(ctx.db, claimId);
  const linkedClaims = bundle.claim.linkedClaimIds
    .map((id) => ctx.repos.getClaim(ctx.db, id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .map((c) => ({ id: c.id, reference: c.reference, status: c.status }));
  return { ...bundle, gates, actions, acceptance, position, linkedClaims };
}
