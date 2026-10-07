// owned by intake
/**
 * Who is calling (docs/SUPREME-DESIGN.md §C.7): a Needs-you resolver runs AS THE SIGNED-IN OWNER, in-process, with only
 * the owner's `Actor`. To apply confirmed fields through the existing routes as that owner (so the routes' validation
 * and audit rows apply exactly as for a click in the app), intake keeps the caller's credentials for the duration of
 * the request in an AsyncLocalStorage store and forwards them to `ctx.inject`.
 *
 * The store is set by an `onRequest` hook (callback style, so the rest of the request runs inside it) for people only —
 * never for agent principals — and is read only when its user id equals the resolver's actor. In header-auth mode
 * (tests) the X-User-Id of the actor is enough.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';
import type { Actor } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';

export interface CallerCredentials {
  userId: string;
  /** Headers that authenticate the caller again on an in-process request (cookie, or X-User-Id in header mode). */
  headers: Record<string, string>;
}

const store = new AsyncLocalStorage<CallerCredentials>();

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Register the hook on the /api scope (idempotent per instance). */
export function installCallerContext(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, done) => {
    const userId = request.user?.id;
    if (!userId || request.agent || userId.startsWith('agent:') || userId === 'system') {
      done();
      return;
    }
    const headers: Record<string, string> = {};
    const cookie = first(request.headers.cookie);
    if (cookie) headers.cookie = cookie;
    const xUser = first(request.headers['x-user-id']);
    if (xUser) headers['x-user-id'] = xUser;
    store.run({ userId, headers }, done);
  });
}

/** The current request's caller, if any. */
export function currentCaller(): CallerCredentials | undefined {
  return store.getStore();
}

/** Run `fn` with explicit caller credentials (routes that already hold the request use this). */
export function withCaller<T>(caller: CallerCredentials, fn: () => T): T {
  return store.run(caller, fn);
}

/**
 * Headers that make an in-process request act as `actor` (a person). Refuses agents and the system; refuses when the
 * caller's credentials are not available (a resolver must run inside the owner's request).
 */
export function ownerHeaders(ctx: AppContext, actor: Actor): Record<string, string> {
  if (!actor.userId || actor.userId === 'system' || actor.userId.startsWith('agent:')) throw new HttpError(403, 'HUMAN_REQUIRED', 'Only a signed-in person can confirm fields');
  const caller = currentCaller();
  if (caller && caller.userId === actor.userId && Object.keys(caller.headers).length) return { ...caller.headers };
  if (ctx.config.authMode === 'header') return { 'x-user-id': actor.userId };
  throw new HttpError(409, 'OWNER_SESSION_REQUIRED', 'Confirmed fields are applied inside the owner’s own request; try again from the app');
}
