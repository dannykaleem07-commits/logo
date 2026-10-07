/**
 * Agent principals (docs/SUPREME-DESIGN.md §B.1): a per-run bearer token `cdk_run_<32 random bytes base64url>`, valid
 * from loopback only, kept in memory keyed by sha256(token) — the token itself is never stored. Expired tokens resolve
 * to undefined; `revokeRunToken` ends a run's access immediately.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AgentName } from '@ccguk/domain';

export interface AgentPrincipal { name: AgentName; runId: string; jobId: string; claimScope?: string; expiresAt: number }

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the agent branch of the onRequest hook for a valid run token from loopback. */
    agent?: AgentPrincipal;
  }
}

export const RUN_TOKEN_PREFIX = 'cdk_run_';

const principals = new Map<string, AgentPrincipal>();

const keyOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

function sweep(now: number): void {
  for (const [k, p] of principals) if (p.expiresAt <= now) principals.delete(k);
}

export function mintRunToken(p: Omit<AgentPrincipal, 'expiresAt'>, ttlMs: number): string {
  if (!(ttlMs > 0)) throw new Error('run token TTL must be positive');
  const now = Date.now();
  sweep(now);
  const token = `${RUN_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const principal: AgentPrincipal = { name: p.name, runId: p.runId, jobId: p.jobId, expiresAt: now + ttlMs };
  if (p.claimScope !== undefined) principal.claimScope = p.claimScope;
  principals.set(keyOf(token), principal);
  return token;
}

export function resolveRunToken(token: string): AgentPrincipal | undefined {
  if (typeof token !== 'string' || !token.startsWith(RUN_TOKEN_PREFIX)) return undefined;
  const key = keyOf(token);
  const p = principals.get(key);
  if (!p) return undefined;
  if (p.expiresAt <= Date.now()) {
    principals.delete(key);
    return undefined;
  }
  return p;
}

export function revokeRunToken(token: string): void {
  principals.delete(keyOf(token));
}

/** Revoke every token of a run (e.g. on cancel). */
export function revokeRun(runId: string): void {
  for (const [k, p] of principals) if (p.runId === runId) principals.delete(k);
}

/** The bearer token of an Authorization header, when it is a run token. */
export function bearerRunToken(header: string | string[] | undefined): string | undefined {
  const h = Array.isArray(header) ? header[0] : header;
  const m = /^Bearer\s+(\S+)$/i.exec(h?.trim() ?? '');
  return m?.[1]?.startsWith(RUN_TOKEN_PREFIX) ? m[1] : undefined;
}

/** request.ip values that are this computer. */
export const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const isLoopback = (ip: string | undefined): boolean => ip !== undefined && LOOPBACK_ADDRESSES.has(ip);

/** The user id an agent writes under (audit, events, ledger). */
export const agentUserId = (name: AgentName): string => `agent:${name}`;
