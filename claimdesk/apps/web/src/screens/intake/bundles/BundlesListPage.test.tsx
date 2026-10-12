// @vitest-environment jsdom
// owned by intake-web
/** Bundles list (docs/SMART-INTAKE.md §11.2): rows with readiness, progress, counts; filters re-query. */
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../test/harness';
import type { BundleSummary } from '../../../api/bundlesApi';
import { BundlesListPage } from './BundlesListPage';
import { BUNDLE_DETAIL, summaryOf } from './__fixtures__/bundleDetail';
import { mockApi } from './__fixtures__/mockApi';

afterEach(() => vi.unstubAllGlobals());

describe('BundlesListPage', () => {
  it('lists bundles with readiness, files read, conflicts, missing documents and the owner-only count', async () => {
    const reading: BundleSummary = { ...summaryOf(BUNDLE_DETAIL), id: 'b2', name: 'Inbox folder drop', source: 'folder', folderKey: 'Ali Example', readiness: 'reading', status: 'reading', fileCounts: { ...BUNDLE_DETAIL.fileCounts, read: 5, total: 12 }, conflictsOpen: 0, missingDocs: 0, signals: { warn: 0, info: 0 } };
    const registered: BundleSummary = { ...summaryOf(BUNDLE_DETAIL), id: 'b3', name: 'Sam Sample – van', readiness: 'registered', status: 'registered', claim: { id: 'c9', reference: 'CCG-2026-00042' } };
    const api = mockApi({ 'GET /intake/bundles': (c) => (c.query.status === 'done' ? { items: [registered], total: 1 } : { items: [summaryOf(BUNDLE_DETAIL), reading], total: 2 }) });
    vi.stubGlobal('fetch', vi.fn(api.fetch));
    const { user } = renderWithProviders(<BundlesListPage />, { route: '/intake' });
    const row = (await screen.findByText('Jane Doe – Corsa crash')).closest('li')!;
    expect(within(row).getByText('Needs review')).toBeTruthy();
    expect(within(row).getByText('2 conflicts')).toBeTruthy();
    expect(within(row).getByText('3 missing')).toBeTruthy();
    expect(within(row).getByTitle('Worth a look (only you see this)').textContent).toContain('3');
    expect(within(row).getByRole('link').getAttribute('href')).toBe('/intake/bundles/b1');
    const folderRow = screen.getByText('Inbox folder drop').closest('li')!;
    expect(within(folderRow).getByText('Reading 5/12')).toBeTruthy();
    expect(within(folderRow).getByLabelText('From the import folder')).toBeTruthy();
    expect(within(folderRow).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
    expect(screen.getByRole('link', { name: 'New bundle' }).getAttribute('href')).toBe('/intake/bundles/new');

    await user.click(screen.getByRole('tab', { name: 'Registered' }));
    expect(await screen.findByText('Registered CCG-2026-00042')).toBeTruthy();
    expect(api.calls.map((c) => c.query.status)).toEqual(['open', 'done']);
  });

  it('empty state points at New bundle and the import folder', async () => {
    vi.stubGlobal('fetch', vi.fn(mockApi({ 'GET /intake/bundles': () => ({ items: [], total: 0 }) }).fetch));
    renderWithProviders(<BundlesListPage />, { route: '/intake' });
    expect(await screen.findByText('No open bundles')).toBeTruthy();
    expect(screen.getByText(/inbox\\intake\\/)).toBeTruthy();
  });
});
