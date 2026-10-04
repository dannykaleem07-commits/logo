import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useMe } from '../api/hooks';
import { Loading } from '../components/Spinner';
import { ApiErrorNotice } from '../components/ApiErrorNotice';
import { Button } from '../components/Button';
import { loginPath, pathOf } from '../lib/auth';

/**
 * Everything except /login sits behind this gate. It asks GET /api/auth/me: while that loads it shows the usual
 * spinner, a 401 (no or expired session) sends the user to /login?next=<this page>, and a dead API gets a plain
 * message with a retry instead of a bounce to the sign-in screen.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();

  if (me.data) return <>{children}</>;
  if (me.data === null) return <Navigate to={loginPath(pathOf(location))} replace />;
  if (me.isError) {
    return (
      <div className="auth-gate">
        <div className="auth-gate-box stack">
          <ApiErrorNotice error={me.error} what="check your sign-in" />
          <div className="row">
            <Button variant="primary" onClick={() => void me.refetch()} loading={me.isFetching}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="auth-gate">
      <Loading label="Checking your sign-in…" />
    </div>
  );
}
