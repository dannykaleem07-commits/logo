import { isApiError } from '../api/client';

/** Consistent inline error for a failed query. Network failures say so plainly (the API may simply be down). */
export function ApiErrorNotice({ error, what = 'load this' }: { error: unknown; what?: string }) {
  if (!error) return null;
  if (isApiError(error)) {
    if (error.isNetwork || error.status === 502 || error.status === 503 || error.status === 504) {
      return (
        <div className="notice notice-warn" role="alert">
          <strong>API unreachable.</strong> Could not {what}: the ClaimDesk API is not responding. Start it with <code>pnpm dev:api</code> or check the proxy.
        </div>
      );
    }
    return (
      <div className="notice notice-danger" role="alert">
        <strong>{error.code}</strong> — {error.message}
      </div>
    );
  }
  return (
    <div className="notice notice-danger" role="alert">
      {(error as Error)?.message ?? String(error)}
    </div>
  );
}
