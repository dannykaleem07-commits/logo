import { isApiError } from '../api/client';
import { describeErrorDetails } from '../lib/errorDetails';

/** Shown under a refusal that only a manager can override (docs/V03-MANAGER-MODE-HIRE-PRICING.md §A.1 point 5). */
export const MANAGER_CAN_OVERRIDE = 'A manager (admin or approver) can override this in manager mode.';

/**
 * Consistent inline error for a failed query or mutation. Network failures say so plainly (the API may simply be down).
 * The error's details (reasons, flags, missing items …) are listed under the message in plain English.
 */
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
    const lines = describeErrorDetails(error.code, error.details);
    return (
      <div className="notice notice-danger" role="alert">
        <strong>{error.override?.label ?? error.code}</strong> — {error.message}
        {lines.length > 0 && (
          <ul className="error-details">
            {lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
        {error.override?.allowed === false && <div className="error-override-hint">{MANAGER_CAN_OVERRIDE}</div>}
      </div>
    );
  }
  return (
    <div className="notice notice-danger" role="alert">
      {(error as Error)?.message ?? String(error)}
    </div>
  );
}
