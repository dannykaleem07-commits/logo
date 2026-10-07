/**
 * Usage-limit, auth and typed-error classification for the subscription CLI (docs/SUPREME-DESIGN.md §A.2) — owned by
 * `gateway`. Table-driven: every pattern below has its own unit test. Classification never calls a model.
 *
 *  - usage_limited: a `rate_limit_event` with `status: "rejected"`; a typed `api_error: "usage_limit_reached"` with
 *    `api_error_params.rate_limit_info.resetsAt`; the legacy text `Claude AI usage limit reached|<epoch>`; the text
 *    `(5-hour|weekly|session) limit reached` (with a reset time when one is printed). An unparsable reset leaves
 *    `resetsAt` undefined: the supervisor resumes in 15 minutes with backoff.
 *  - auth_failed: HTTP 401, "OAuth token has expired", "Please run /login", `authentication_error`.
 *  - error (not retryable): `pdf_too_large`, `pdf_password_protected`, `claude_code_version_too_old`.
 *  - error (retryable): `no_response`, `max_output_tokens`, a process exit without a result.
 */
import type { RateLimitSnapshot } from './types.js';

export type Classification =
  | { kind: 'usage_limited'; resetsAt?: string; limitType?: string; pattern: string }
  | { kind: 'auth_failed'; message: string; pattern: string }
  | { kind: 'error'; retryable: boolean; code: string; message: string; pattern: string };

/** What the stream told us about a failure (texts from result/assistant/stderr, typed error fields, HTTP status). */
export interface FailureSignals {
  texts: string[];
  apiError?: string;
  apiErrorParams?: unknown;
  status?: number;
  rateLimit?: RateLimitSnapshot;
}

/** Epoch seconds or milliseconds, a numeric string, or an ISO string → ISO (undefined when unparsable). */
export function toIso(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  if (typeof value === 'string' && value.trim()) {
    const v = value.trim();
    if (/^\d+(\.\d+)?$/.test(v)) return toIso(Number(v));
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return undefined;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

interface UsagePattern {
  id: string;
  test(s: FailureSignals): { resetsAt?: string; limitType?: string } | undefined;
}

/** Usage-limit patterns, in order. */
export const USAGE_LIMIT_PATTERNS: readonly UsagePattern[] = [
  {
    id: 'rate_limit_event_rejected',
    test: (s) => (s.rateLimit?.status === 'rejected' ? { resetsAt: s.rateLimit.resetsAt, limitType: s.rateLimit.type } : undefined),
  },
  {
    id: 'api_error_usage_limit_reached',
    test: (s) => {
      if (s.apiError !== 'usage_limit_reached') return undefined;
      const info = obj(obj(s.apiErrorParams).rate_limit_info ?? obj(s.apiErrorParams).rateLimitInfo);
      const limitType = typeof info.rateLimitType === 'string' ? info.rateLimitType : typeof info.type === 'string' ? info.type : undefined;
      return { resetsAt: toIso(info.resetsAt ?? info.resets_at), ...(limitType ? { limitType } : {}) };
    },
  },
  {
    id: 'legacy_usage_limit_text',
    test: (s) => {
      for (const t of s.texts) {
        const m = /Claude AI usage limit reached\|(\d{9,13})/.exec(t);
        if (m) return { resetsAt: toIso(Number(m[1])) };
      }
      return undefined;
    },
  },
  {
    id: 'window_limit_reached_text',
    test: (s) => {
      for (const t of s.texts) {
        const m = /(5-hour|weekly|session) limit reached/i.exec(t);
        if (!m) continue;
        const kind = m[1]!.toLowerCase();
        const limitType = kind === '5-hour' ? 'five_hour' : kind === 'weekly' ? 'seven_day' : 'session';
        // A reset printed as an epoch or ISO instant is used; a wall-clock phrase ("resets 3pm") is not guessed.
        const epoch = /resets?\D{0,20}(\d{10,13})/i.exec(t)?.[1];
        const iso = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))/.exec(t)?.[1];
        return { resetsAt: epoch ? toIso(Number(epoch)) : iso ? toIso(iso) : undefined, limitType };
      }
      return undefined;
    },
  },
];

/** Auth-failure patterns (each unit-tested). */
export const AUTH_PATTERNS: ReadonlyArray<{ id: string; test(s: FailureSignals): boolean }> = [
  { id: 'http_401', test: (s) => s.status === 401 || s.texts.some((t) => /\b401\b.*(unauthori[sz]ed|authentication)|API Error: 401/i.test(t)) },
  { id: 'oauth_token_expired', test: (s) => s.texts.some((t) => /OAuth token has expired/i.test(t)) },
  { id: 'please_run_login', test: (s) => s.texts.some((t) => /Please run \/login/i.test(t)) },
  { id: 'authentication_error', test: (s) => s.apiError === 'authentication_error' || s.apiError === 'authentication_failed' || s.texts.some((t) => /authentication_error|authentication_failed/i.test(t)) },
];

/** Typed errors that are not usage or auth (§A.2). */
export const TYPED_ERRORS: ReadonlyArray<{ code: string; retryable: boolean; message: string }> = [
  { code: 'pdf_too_large', retryable: false, message: 'A PDF is too large for the model (over 32 MB or 600 pages); the owner must split or summarise it' },
  { code: 'pdf_password_protected', retryable: false, message: 'A PDF is password-protected; the owner must provide an unlocked copy' },
  { code: 'claude_code_version_too_old', retryable: false, message: 'Claude Code is too old for ClaimDesk; update Claude Code' },
  { code: 'no_response', retryable: true, message: 'The model returned no response' },
  { code: 'max_output_tokens', retryable: true, message: 'The model hit its output limit' },
];

/** Classify a failure; undefined when nothing matched (the caller decides, usually a retryable error). */
export function classifyFailure(s: FailureSignals): Classification | undefined {
  for (const p of USAGE_LIMIT_PATTERNS) {
    const hit = p.test(s);
    if (hit) return { kind: 'usage_limited', pattern: p.id, ...(hit.resetsAt ? { resetsAt: hit.resetsAt } : {}), ...(hit.limitType ? { limitType: hit.limitType } : {}) };
  }
  for (const p of AUTH_PATTERNS) {
    if (p.test(s)) return { kind: 'auth_failed', pattern: p.id, message: 'Claude sign-in failed: sign Claude in again (run `claude setup-token` from Settings > AI)' };
  }
  for (const e of TYPED_ERRORS) {
    if (s.apiError === e.code || s.texts.some((t) => t.includes(e.code))) return { kind: 'error', pattern: e.code, code: e.code, retryable: e.retryable, message: e.message };
  }
  return undefined;
}
