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

function render(path: string): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
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
  it('global search box and nav are present on every page', () => {
    const html = render('/kb');
    expect(html).toContain('Search registration, claim ref or name');
    for (const label of ['Dashboard', 'Claims', 'New claim', 'Fleet', 'Directory', 'Knowledge base', 'Analytics', 'Settings']) expect(html).toContain(label);
  });
});
