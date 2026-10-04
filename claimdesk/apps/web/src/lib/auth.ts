/**
 * Sign-in redirects (pure; unit-tested).
 *
 * The `next` query parameter on /login says where to go after signing in. It is attacker-controllable (anyone can
 * send a link to /login?next=…), so it is only ever honoured as a same-origin, root-relative path: it must start
 * with a single "/", never "//" or "/\" (both mean "another host" to a browser), never a full URL, and never
 * carry control characters or backslashes. Anything else falls back to the dashboard. This is what stops the
 * sign-in screen being used as an open redirect.
 */

export const LOGIN_PATH = '/login';
export const HOME_PATH = '/';
const MAX_NEXT_LENGTH = 2048;
/** Any origin works here: it is only used to resolve the path and check that it stayed on the same origin. */
const PROBE_ORIGIN = 'https://claimdesk.invalid';

/** True for /login itself (with or without a query, hash or trailing slash). */
export function isLoginPath(path: string): boolean {
  return /^\/login\/?(?:[?#]|$)/i.test(path);
}

/**
 * Return `raw` as a safe in-app path (pathname + search + hash), or "/" when it is missing, not root-relative,
 * protocol-relative, a full URL, malformed, or points back at /login (which would loop).
 */
export function sanitizeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_NEXT_LENGTH) return HOME_PATH;
  if (raw[0] !== '/') return HOME_PATH; // relative paths, "https://…", "javascript:…", " /x"
  if (raw[1] === '/' || raw[1] === '\\') return HOME_PATH; // "//evil.example", "/\evil.example"
  if (raw.includes('\\')) return HOME_PATH; // browsers read "\" as "/" in URLs
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return HOME_PATH; // tabs/newlines are stripped by URL parsers ("/\t/evil")
  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return HOME_PATH;
  }
  if (url.origin !== PROBE_ORIGIN) return HOME_PATH;
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (!path.startsWith('/') || path.startsWith('//')) return HOME_PATH;
  if (isLoginPath(path)) return HOME_PATH;
  return path;
}

/** `/login?next=<path>` for the page the user was on ("/" and unsafe paths give a bare `/login`). */
export function loginPath(currentPath?: string | null): string {
  const next = sanitizeNextPath(currentPath);
  return next === HOME_PATH ? LOGIN_PATH : `${LOGIN_PATH}?next=${encodeURIComponent(next)}`;
}

/**
 * Where a 401 from the API should send the user, or null when no redirect is wanted (already on the sign-in
 * screen — its own calls are allowed to fail without bouncing).
 */
export function unauthorizedRedirectTarget(currentPath: string): string | null {
  if (isLoginPath(currentPath)) return null;
  return loginPath(currentPath);
}

/** pathname + search + hash of a router/window location. */
export function pathOf(location: { pathname: string; search?: string; hash?: string }): string {
  return `${location.pathname}${location.search ?? ''}${location.hash ?? ''}`;
}
