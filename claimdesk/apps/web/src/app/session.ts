/**
 * Session expiry: when any API call (other than the public auth routes) answers 401, forget the signed-in user and
 * send the browser to /login?next=<the page it was on>. Installed once in main.tsx; the decision itself
 * (`unauthorizedRedirectTarget`) is pure and lives in lib/auth.ts.
 */
import type { QueryClient } from '@tanstack/react-query';
import { setManagerOverrideReason, setUnauthorizedHandler } from '../api/client';
import { qk } from '../api/hooks';
import { managerQk, OFF_VIEW } from '../api/managerApi';
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

/**
 * After a sign-out: tell every observer the user and manager mode are gone (so ManagerModeProvider drops the red bar
 * and the X-Manager-Override header at once), then empty the cache except the sign-in defaults. removeQueries alone
 * does not notify mounted observers, which kept the previous user's manager mode on the sign-in screen.
 */
export function clearSignedInState(queryClient: QueryClient): void {
  setManagerOverrideReason(null);
  if (typeof document !== 'undefined') document.body.classList.remove('manager-mode');
  queryClient.setQueryData(qk.me, null);
  queryClient.setQueryData(managerQk.mode, OFF_VIEW);
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== qk.loginDefaults[0] || q.queryKey[1] !== qk.loginDefaults[1] });
}
