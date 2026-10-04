import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Claim, Id } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { conflict } from '../errors.js';

export type RouteModule = (app: FastifyInstance, ctx: AppContext) => void;

export function requireClaim(ctx: AppContext, id: Id): Claim {
  return ctx.repos.requireClaim(ctx.db, id);
}

export function params<T extends Record<string, string>>(request: FastifyRequest): T {
  return request.params as T;
}

/** Uncleared block flags stop progression (hard stop) — 409 HARD_STOP. */
export function assertNoHardStop(claim: Claim): void {
  const blocks = claim.flags.filter((f) => f.severity === 'block' && !f.clearedAt);
  if (blocks.length) throw conflict('HARD_STOP', `Claim ${claim.reference} has an uncleared hard stop: ${blocks.map((f) => f.code).join(', ')}`, { flags: blocks });
}
