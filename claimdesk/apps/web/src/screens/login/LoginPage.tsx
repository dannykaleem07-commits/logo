import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import './login.css';
import { useHealth, useLogin, useLoginDefaults } from '../../api/hooks';
import { Button } from '../../components/Button';
import { EyeIcon } from '../../app/Icons';
import { sanitizeNextPath } from '../../lib/auth';
import { loginErrorMessage, loginFormError, loginPrefill, type LoginFormValues } from './login';
import { LEGAL_FOOTER, versionLabel } from '../settings/settings';

/**
 * Full-screen sign-in, outside the app shell. The boxes are pre-filled from GET /api/auth/login-defaults (the
 * default account, while it still has its default password); if that call fails only the username is filled.
 * After signing in the user goes to ?next (same-origin paths only — see lib/auth.ts) or the dashboard.
 */
export function LoginPage() {
  const [params] = useSearchParams();
  const next = sanitizeNextPath(params.get('next'));
  const navigate = useNavigate();
  const defaults = useLoginDefaults();
  const login = useLogin();
  const health = useHealth(); // public route: gives the version before sign-in
  const [values, setValues] = useState<LoginFormValues>(() => loginPrefill(defaults.data));
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edited = useRef(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const ids = { user: useId(), pass: useId(), error: useId() };

  // Apply the API's defaults when they arrive, unless the user has already started typing.
  useEffect(() => {
    if (defaults.data && !edited.current) setValues(loginPrefill(defaults.data));
  }, [defaults.data]);

  useEffect(() => {
    const previous = document.title;
    document.title = 'Sign in · ClaimDesk';
    return () => {
      document.title = previous;
    };
  }, []);

  const set = (key: keyof LoginFormValues) => (value: string) => {
    edited.current = true;
    setError(null);
    setValues((v) => ({ ...v, [key]: value }));
  };

  const defaultPasswordShown = Boolean(defaults.data?.password) && values.password === defaults.data?.password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (login.isPending) return;
    const invalid = loginFormError(values);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    try {
      await login.mutateAsync({ username: values.username.trim(), password: values.password });
      await navigate(next, { replace: true });
    } catch (err) {
      setError(loginErrorMessage(err));
      passwordRef.current?.focus();
      passwordRef.current?.select();
    }
  };

  return (
    <div className="login-screen">
      <main className="login-card" aria-labelledby="login-title">
        <div className="login-brand">
          <img className="login-logo" src="/logo.png" alt="Courtesy Cars UK" width={2000} height={396} />
        </div>
        <h1 id="login-title" className="login-title">
          Sign in to ClaimDesk
        </h1>
        <p className="login-sub">Courtesy Cars Group UK Ltd · claims platform</p>

        <form className="login-form" onSubmit={submit} noValidate aria-describedby={error ? ids.error : undefined}>
          <div className="field">
            <label className="field-label" htmlFor={ids.user}>
              Username
            </label>
            <input
              id={ids.user}
              name="username"
              type="text"
              className="input"
              value={values.username}
              onChange={(e) => set('username')(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              aria-invalid={error ? true : undefined}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor={ids.pass}>
              Password
            </label>
            <div className="password-wrap">
              <input
                ref={passwordRef}
                id={ids.pass}
                name="password"
                type={showPassword ? 'text' : 'password'}
                className="input"
                value={values.password}
                onChange={(e) => set('password')(e.target.value)}
                autoComplete="current-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
                aria-invalid={error ? true : undefined}
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((s) => !s)}
                aria-controls={ids.pass}
                aria-pressed={showPassword}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                <EyeIcon off={showPassword} />
                <span>{showPassword ? 'Hide' : 'Show'}</span>
              </button>
            </div>
          </div>

          <p id={ids.error} className="login-error" role="alert" aria-live="assertive">
            {error ?? ''}
          </p>

          <Button type="submit" variant="primary" size="lg" block loading={login.isPending}>
            Sign in
          </Button>

          {defaultPasswordShown && (
            <p className="login-note">
              The default account is filled in for you. Change its password in <strong>Settings → Change password</strong> once you are in; the pre-fill then stops by itself.
            </p>
          )}
        </form>
      </main>
      <footer className="login-foot">
        <span>{LEGAL_FOOTER}</span>
        <span>
          {versionLabel(health.data?.version)} · Authorised users only. Sign-ins are recorded.
        </span>
      </footer>
    </div>
  );
}
