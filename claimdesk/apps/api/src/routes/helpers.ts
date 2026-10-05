import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Claim, Id } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { conflict, HttpError } from '../errors.js';

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

/** Who may change shared configuration: the template library, GTA benchmark rates and the vehicle catalogue. */
export const CONFIG_ROLES = ['admin', 'approver'] as const;

/**
 * 403 FORBIDDEN unless the signed-in user has one of `roles`. The dev/test default user (header auth mode, never in
 * production) is not checked, so tests that do not name a user keep working; a named user always is.
 */
export function requireRole(request: FastifyRequest, roles: readonly string[] = CONFIG_ROLES): void {
  const u = request.user;
  if (u?.assumed) return;
  if (!u || !roles.includes(u.role)) throw new HttpError(403, 'FORBIDDEN', `Only ${roles.join(' or ')} users can do this (you are signed in as ${u?.role ?? 'nobody'}).`);
}

/** Fastify preHandler form of requireRole. */
export const configRolesOnly = async (request: FastifyRequest): Promise<void> => requireRole(request);
