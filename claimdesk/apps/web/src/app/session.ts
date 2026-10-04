/**
 * Session expiry: when any API call (other than the public auth routes) answers 401, forget the signed-in user and
 * send the browser to /login?next=<the page it was on>. Installed once in main.tsx; the decision itself
 * (`unauthorizedRedirectTarget`) is pure and lives in lib/auth.ts.
 */
import type { QueryClient } from '@tanstack/react-query';
import { setUnauthorizedHandler } from '../api/client';
import { qk } from '../api/hooks';
import { pathOf, unauthorizedRedirectTarget } from '../lib/auth';

export function installSessionExpiryRedirect(
  navigate: (to: string) => unknown,
  queryClient: QueryClient,
  currentPath: () => string = () => pathOf(window.location)
): () => void {
  let redirecting = false;
  return setUnauthorizedHandler(() => {
    const target = unauthorizedRedirectTarget(currentPath());
    if (!target || redirecting) return; // already on /login, or a burst of 401s from one page
    redirecting = true;
    queryClient.setQueryData(qk.me, null); // the auth gate now redirects too, with the same target
    void Promise.resolve()
      .then(() => navigate(target))
      .catch((e: unknown) => console.warn('[ClaimDesk] sign-in redirect failed', e))
      .finally(() => {
        redirecting = false;
      });
  });
}
