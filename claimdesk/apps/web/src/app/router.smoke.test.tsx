/**
 * Route smoke test: every route renders to a string under node (no DOM, no API). Queries stay in their
 * loading state during renderToString, so this catches hook misuse, bad imports and crashes in the
 * initial render of each screen without needing jsdom.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { routes } from './router';
import { ToastProvider } from '../components/Toast';
import { qk } from '../api/hooks';
import type { AuthUser, LoginDefaults } from '../api/client';

const USER: AuthUser = { id: 'courtesycars', name: 'Courtesy Cars', username: 'courtesycars', email: 'claims@courtesycars.net', role: 'admin' };

/**
 * `me` seeds GET /auth/me (default: signed in as the default account; null = no session; undefined = still
 * loading). `defaults` seeds GET /auth/login-defaults.
 */
function render(path: string, opts: { me?: AuthUser | null; defaults?: LoginDefaults } = { me: USER }): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  if (opts.me !== undefined) qc.setQueryData(qk.me, opts.me);
  if (opts.defaults) qc.setQueryData(qk.loginDefaults, opts.defaults);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return renderToString(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  );
}

describe('routes render without the API', () => {
  it('dashboard', () => {
    const html = render('/');
    expect(html).toContain('Dashboard');
    expect(html).toContain('Blocked documents');
    expect(html).toContain('Clocks due today');
    expect(html).toContain('/logo.png');
  });
  it('claims list', () => {
    const html = render('/claims');
    expect(html).toContain('Claims');
    expect(html).toContain('Any status');
  });
  it('new claim opens on the call-recording disclosure', () => {
    const html = render('/claims/new');
    expect(html).toContain('Call-recording disclosure');
    expect(html).toContain('This call is being recorded');
    expect(html).not.toContain('Has anyone offered you a vehicle'); // step 5 is not shown before step 1 is acknowledged
  });
  it('claim file shows its loading state', () => {
    expect(render('/claims/abc/overview')).toContain('Loading claim file');
  });
  it('fleet, directory, kb, analytics, settings, watch, capture and not-found', () => {
    expect(render('/fleet')).toContain('Units &amp; alerts');
    expect(render('/fleet/penalties')).toContain('Penalty notices');
    expect(render('/directory')).toContain('Third-party claims lines');
    expect(render('/kb')).toContain('Knowledge base');
    expect(render('/kb?view=plan')).toContain('Get-paid-faster playbook');
    expect(render('/analytics')).toContain('Debtor days by insurer');
    expect(render('/settings')).toContain('Courtesy Cars Group UK Ltd');
    expect(render('/watch')).toContain('Counterparty watch');
    expect(render('/capture')).toContain('No claim selected');
    expect(render('/capture/abc')).toContain('Guided capture');
    expect(render('/nope')).toContain('Page not found');
  });
  it('the Word templates and GTA rates settings pages are routed', () => {
    for (const [path, heading] of [['/settings/templates', 'Document templates'], ['/settings/gta-rates', 'GTA benchmark rates']] as const) {
      const html = render(path);
      expect(html, path).not.toContain('Page not found');
      expect(html, path).toContain(heading);
    }
  });
  it('global search box and nav are present on every page', () => {
    const html = render('/kb');
    expect(html).toContain('Search registration, claim ref or name');
    for (const label of ['Dashboard', 'Claims', 'New claim', 'Fleet', 'Directory', 'Knowledge base', 'Analytics', 'Settings']) expect(html).toContain(label);
  });
  it('the shell shows the signed-in user and Sign out', () => {
    const html = render('/');
    expect(html).toContain('Courtesy Cars');
    expect(html).toContain('Sign out');
  });
  it('settings has the Change password card', () => {
    const html = render('/settings');
    expect(html).toContain('Change password');
    expect(html).toMatch(/autocomplete="new-password"/i);
  });
});

describe('auth gate and sign-in screen', () => {
  it('shows the loading spinner while GET /auth/me is pending, and none of the app', () => {
    const html = render('/claims', {});
    expect(html).toContain('Checking your sign-in');
    expect(html).not.toContain('Search registration, claim ref or name');
  });
  it('renders nothing of the app without a session (it redirects to /login)', () => {
    const html = render('/claims', { me: null });
    expect(html).not.toContain('Search registration, claim ref or name');
    expect(html).not.toContain('Any status');
  });
  it('/login is outside the shell and pre-fills the default username even before login-defaults answers', () => {
    const html = render('/login', {});
    expect(html).toContain('Sign in to ClaimDesk');
    expect(html).toContain('/logo.png');
    expect(html).not.toContain('Search registration, claim ref or name');
    // HTML attribute names are case-insensitive (React's server renderer keeps the camelCase spelling)
    expect(html).toMatch(/autocomplete="username"[^>]*value="courtesycars"|value="courtesycars"[^>]*autocomplete="username"/i);
    expect(html).toMatch(/autocomplete="current-password"/i);
    expect(html).toContain('Show password');
    expect(html).toContain('>Sign in<');
  });
  it('/login pre-fills both boxes from login-defaults', () => {
    const html = render('/login?next=%2Fclaims', { defaults: { username: 'courtesycars', password: 'CourtesyCars123!', prefill: true } });
    expect(html).toContain('value="courtesycars"');
    expect(html).toContain('value="CourtesyCars123!"');
    expect(html).toContain('type="password"');
    expect(html).toContain('Change password');
  });
  it('/login fills only the username once the default password has been changed', () => {
    const html = render('/login', { defaults: { username: 'courtesycars', prefill: true } });
    expect(html).toContain('value="courtesycars"');
    expect(html).not.toContain('CourtesyCars123!');
  });
});
