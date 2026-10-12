// owned by intake-web
/**
 * Routes of docs/SMART-INTAKE.md §11.1 render without the API (queries stay loading during renderToString, as in
 * router.smoke.test.tsx): /intake opens on Case bundles, ?tab=files is the per-file screen, the new-bundle page, a
 * bundle page and Settings > Intake.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { routes } from '../../app/router';
import { ToastProvider } from '../../components/Toast';
import { qk } from '../../api/hooks';

function render(path: string): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  qc.setQueryData(qk.me, { id: 'courtesycars', name: 'Courtesy Cars', username: 'courtesycars', email: 'claims@example.test', role: 'admin' });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return renderToString(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('intake routes', () => {
  it('/intake opens on the case bundles tab', () => {
    const html = render('/intake');
    expect(html).toContain('Case bundles');
    expect(html).toContain('Single files');
    expect(html).toContain('Intake — case bundles');
    expect(html).toContain('New bundle');
  });
  it('?tab=files is the per-file screen, unchanged', () => {
    const html = render('/intake?tab=files');
    expect(html).toContain('Files read by the agents and the details they found');
    expect(html).not.toContain('Intake — case bundles');
  });
  it('new bundle, a bundle page and Settings > Intake', () => {
    expect(render('/intake/bundles/new')).toContain('Temporary name');
    expect(render('/intake/bundles/b1')).toContain('spinner');
    expect(render('/settings/intake')).toContain('spinner');
    expect(render('/settings')).toContain('Intake (case bundles)');
  });
});
