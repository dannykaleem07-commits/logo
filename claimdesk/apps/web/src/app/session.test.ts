/**
 * The 401 → /login?next= wiring: request() reports a 401 from any non-public route to the registered handler
 * (and still throws), the public auth routes never trigger it, and the installed handler forgets the user and
 * navigates once per burst. fetch is stubbed; no DOM needed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { api, ApiError, PUBLIC_AUTH_PATHS, redirectsOn401, request, setUnauthorizedHandler } from '../api/client';
import { fetchCurrentUser, qk, userFromMe } from '../api/hooks';
import { installSessionExpiryRedirect } from './session';

function respond(status: number, body?: unknown) {
  return vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

const unauthenticated = { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue', requestId: 'r1' } };
const user = { id: 'courtesycars', name: 'Courtesy Cars', username: 'courtesycars', email: 'claims@courtesycars.net', role: 'admin' as const };

afterEach(() => {
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

describe('redirectsOn401', () => {
  it('exempts exactly the public auth routes', () => {
    expect([...PUBLIC_AUTH_PATHS]).toEqual(['/auth/login', '/auth/logout', '/auth/me', '/auth/login-defaults']);
    for (const p of PUBLIC_AUTH_PATHS) expect(redirectsOn401(p), p).toBe(false);
    expect(redirectsOn401('/auth/me?x=1')).toBe(false);
    expect(redirectsOn401('auth/login/')).toBe(false);
  });
  it('redirects for everything else, change-password included (it needs a session)', () => {
    for (const p of ['/claims', '/claims/c1/ledger', '/settings', '/health', '/auth/change-password', '/authors']) expect(redirectsOn401(p), p).toBe(true);
  });
});

describe('request() and the unauthorized handler', () => {
  it('calls the handler on a 401 from a protected route and still throws the ApiError', async () => {
    vi.stubGlobal('fetch', respond(401, unauthenticated));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    const err = await request('/claims').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).code).toBe('UNAUTHENTICATED');
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it('does not call it for the auth calls themselves or for other statuses', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal('fetch', respond(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Username or password is incorrect', requestId: 'r' } }));
    await expect(api.login({ username: 'courtesycars', password: 'wrong' })).rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    await expect(api.loginDefaults()).rejects.toMatchObject({ status: 401 });
    await expect(api.logout()).rejects.toMatchObject({ status: 401 });
    vi.stubGlobal('fetch', respond(403, { error: { code: 'FORBIDDEN', message: 'no', requestId: 'r' } }));
    await expect(request('/claims')).rejects.toMatchObject({ status: 403 });
    expect(handler).not.toHaveBeenCalled();
  });
  it('sends credentials and the JSON body to POST /auth/login', async () => {
    const fetchMock = respond(200, { user });
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.login({ username: 'courtesycars', password: 'CourtesyCars123!' })).resolves.toEqual({ user });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/login');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(String(init.body))).toEqual({ username: 'courtesycars', password: 'CourtesyCars123!' });
  });
  it('logout and change-password accept 204', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await expect(api.logout()).resolves.toBeUndefined();
    await expect(api.changePassword({ currentPassword: 'CourtesyCars123!', newPassword: 'a-much-longer-passphrase' })).resolves.toBeUndefined();
  });
});

describe('fetchCurrentUser / userFromMe (GET /auth/me)', () => {
  it('maps 200 {user} to the user and 401 to null', async () => {
    vi.stubGlobal('fetch', respond(200, { user }));
    await expect(fetchCurrentUser()).resolves.toEqual(user);
    vi.stubGlobal('fetch', respond(401, unauthenticated));
    await expect(fetchCurrentUser()).resolves.toBeNull();
  });
  it('keeps a dead API an error (the gate shows "API unreachable", not the sign-in screen)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    await expect(fetchCurrentUser()).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
  });
  it('userFromMe accepts {user} or a bare user and rejects anything without an id', () => {
    expect(userFromMe({ user })).toEqual(user);
    expect(userFromMe(user)).toEqual(user);
    expect(userFromMe({ user: {} })).toBeNull();
    expect(userFromMe({})).toBeNull();
    expect(userFromMe(null)).toBeNull();
  });
});

describe('installSessionExpiryRedirect', () => {
  it('forgets the user and navigates to /login?next=<current page>, once per burst', async () => {
    vi.stubGlobal('fetch', respond(401, unauthenticated));
    const qc = new QueryClient();
    qc.setQueryData(qk.me, user);
    let current = '/claims/c1/ledger?tab=x';
    const navigate = vi.fn((to: string) => {
      current = to; // like the browser router: the location is /login once the navigation lands
    });
    installSessionExpiryRedirect(navigate, qc, () => current);
    await Promise.allSettled([request('/claims/c1'), request('/claims/c1/ledger'), request('/claims/c1/clocks')]);
    await new Promise((r) => setTimeout(r, 0));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/login?next=%2Fclaims%2Fc1%2Fledger%3Ftab%3Dx');
    expect(qc.getQueryData(qk.me)).toBeNull();
  });
  it('does nothing on the sign-in screen', async () => {
    vi.stubGlobal('fetch', respond(401, unauthenticated));
    const qc = new QueryClient();
    const navigate = vi.fn();
    installSessionExpiryRedirect(navigate, qc, () => '/login?next=%2Fclaims');
    await request('/claims').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(navigate).not.toHaveBeenCalled();
  });
  it('can be uninstalled', async () => {
    vi.stubGlobal('fetch', respond(401, unauthenticated));
    const navigate = vi.fn();
    const uninstall = installSessionExpiryRedirect(navigate, new QueryClient(), () => '/claims');
    uninstall();
    await request('/claims').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(navigate).not.toHaveBeenCalled();
  });
});
