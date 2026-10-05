import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Claim, Id } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { conflict, HttpError } from '../errors.js';
import { STRICT_GATE, type OverrideGate } from '../services/override.js';

export type RouteModule = (app: FastifyInstance, ctx: AppContext) => void;

export function requireClaim(ctx: AppContext, id: Id): Claim {
  return ctx.repos.requireClaim(ctx.db, id);
}

export function params<T extends Record<string, string>>(request: FastifyRequest): T {
  return request.params as T;
}

/**
 * Uncleared block flags stop progression (hard stop) — 409 HARD_STOP, refused through the override gate (class A):
 * with manager mode active the caller carries on and the override is audited; the flags stay on the file.
 */
export function assertNoHardStop(claim: Claim, gate: OverrideGate = STRICT_GATE): void {
  const blocks = claim.flags.filter((f) => f.severity === 'block' && !f.clearedAt);
  if (!blocks.length) return;
  // Plain messages, not flag codes: this text is shown in the override prompt and kept in the audit trail.
  const error = conflict('HARD_STOP', `Claim ${claim.reference} has an uncleared hard stop: ${blocks.map((f) => f.message.trim()).join(' ')}`, { flags: blocks });
  gate.refuse(error, { claimId: claim.id, entity: 'claims', entityId: claim.id });
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
