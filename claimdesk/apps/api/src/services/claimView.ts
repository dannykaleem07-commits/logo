/**
 * Claim view assembly: ClaimBundle (from @ccguk/db) + derived clocks, evidence gates, playbook actions and the
 * acceptance assessment. Clocks are recomputed and cached (`replaceClocks`) whenever the chronology changes.
 */
import { evaluateGates, type CaseAcceptance, type ClaimBundle, type Clock, type GateResult, type Id, type PlaybookAction } from '@ccguk/domain';
import { callDeriveClocks } from '../engines.js';
import type { AppContext } from '../context.js';
import { assessAcceptanceFallback, deriveClocksFallback, nextActionsFallback } from './fallbacks.js';

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

/** Derive clocks for the bundle: domain engine when present, supplemented by the API-side kinds it does not emit. */
export function deriveClocksFor(ctx: AppContext, bundle: ClaimBundle): Array<Omit<Clock, 'id' | 'claimId'> & { id?: string }> {
  const now = ctx.now();
  const engine = ctx.engines().deriveClocks;
  const fromDomain = engine ? callDeriveClocks(engine, bundle, now).map(({ claimId: _c, ...rest }) => rest) : [];
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

export function actionsFor(ctx: AppContext, bundle: ClaimBundle, gates: GateResult[]): PlaybookAction[] {
  const engine = ctx.engines().nextActions;
  if (engine) {
    const rules = ctx.kb.playbookRules();
    return engine(bundle, ctx.now(), rules.length ? rules : undefined);
  }
  return nextActionsFallback(bundle, gates, ctx.now());
}

export function acceptanceFor(ctx: AppContext, bundle: ClaimBundle, gates: GateResult[]): CaseAcceptance {
  const engine = ctx.engines().assessAcceptance;
  return engine ? engine(bundle, ctx.now()) : assessAcceptanceFallback(bundle, gates);
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
