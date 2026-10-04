/**
 * Sign-in screen model (pure; unit-tested): what the form pre-fills and what each failure says.
 */
import { isApiError, type LoginDefaults } from '../../api/client';

/** The default account's username. Pre-filled even when GET /auth/login-defaults cannot be reached. */
export const DEFAULT_LOGIN_USERNAME = 'courtesycars';

export interface LoginFormValues {
  username: string;
  password: string;
}

/**
 * What the boxes start with.
 *  - No answer yet, or the call failed → the default username only (never a password the API did not send).
 *  - `prefill: false` (LOGIN_PREFILL turned off) → both empty.
 *  - Otherwise the username from the API (default if blank) and the password only when the API sent one, which it
 *    does only while the default account still has its default password.
 */
export function loginPrefill(defaults: LoginDefaults | null | undefined): LoginFormValues {
  if (!defaults || typeof defaults !== 'object') return { username: DEFAULT_LOGIN_USERNAME, password: '' };
  if (defaults.prefill === false) return { username: '', password: '' };
  const username = typeof defaults.username === 'string' && defaults.username.trim() ? defaults.username.trim() : DEFAULT_LOGIN_USERNAME;
  const password = typeof defaults.password === 'string' ? defaults.password : '';
  return { username, password };
}

/** Client-side check before posting; null when the form can be sent. */
export function loginFormError(values: LoginFormValues): string | null {
  const user = values.username.trim();
  if (!user && !values.password) return 'Enter your username and password.';
  if (!user) return 'Enter your username.';
  if (!values.password) return 'Enter your password.';
  return null;
}

export const LOGIN_MESSAGES = {
  invalid: 'Username or password is incorrect.',
  rateLimited: 'Too many failed attempts for this username. Wait 15 minutes, then try again.',
  network: 'Cannot reach the ClaimDesk server. Check it is running, then try again.',
  server: 'The server could not sign you in just now. Try again in a moment.'
} as const;

/** The one-line error under the sign-in form for whatever POST /auth/login threw. */
export function loginErrorMessage(error: unknown): string {
  if (!error) return '';
  if (isApiError(error)) {
    if (error.code === 'LOGIN_RATE_LIMITED' || error.status === 429) return LOGIN_MESSAGES.rateLimited;
    if (error.code === 'INVALID_CREDENTIALS' || error.status === 401) return LOGIN_MESSAGES.invalid;
    if (error.isNetwork || error.status === 502 || error.status === 503 || error.status === 504) return LOGIN_MESSAGES.network;
    if (error.status >= 500) return LOGIN_MESSAGES.server;
    if (error.status === 400) return 'Enter your username and password.';
    return error.message || LOGIN_MESSAGES.server;
  }
  return error instanceof Error && error.message ? error.message : LOGIN_MESSAGES.server;
}
