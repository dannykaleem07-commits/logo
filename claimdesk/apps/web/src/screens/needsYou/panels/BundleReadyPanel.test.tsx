// @vitest-environment jsdom
// owned by intake-web
/** Needs-you new_claim, case-bundle variant (docs/SMART-INTAKE.md §9, §11.5): renders only for payload.bundleId. */
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../test/harness';
import type { NeedsYouItem } from '../../../api/needsYouApi';
import { BundleReadyPanel, bundleIdOf } from './BundleReadyPanel';
import { panelFor } from '../kindPanels';
import { BUNDLE_DETAIL, summaryOf } from '../../intake/bundles/__fixtures__/bundleDetail';
import { mockApi } from '../../intake/bundles/__fixtures__/mockApi';

const base: NeedsYouItem = {
  id: 'ny-1',
  kind: 'new_claim',
  title: 'New claim ready: Jane Doe – Corsa crash',
  summary: 'Prepared from 13 documents',
  options: [],
  payload: {},
  priority: 'normal',
  status: 'open',
  createdBy: 'agent:intake',
  createdAt: '2026-10-07T09:00:00.000Z',
} as unknown as NeedsYouItem;

afterEach(() => vi.unstubAllGlobals());

describe('BundleReadyPanel', () => {
  it('is the registered panel for new_claim', () => {
    expect(panelFor('new_claim')).toBe(BundleReadyPanel);
  });

  it('renders nothing for an old per-file card', () => {
    const fetch = vi.fn(mockApi({}).fetch);
    vi.stubGlobal('fetch', fetch);
    const { container } = renderWithProviders(<BundleReadyPanel item={{ ...base, payload: { itemId: 'item-1' } }} closed={false} />);
    expect(container.textContent).toBe('');
    expect(fetch).not.toHaveBeenCalled();
    expect(bundleIdOf({ itemId: 'x' })).toBeNull();
  });

  it('shows the live bundle, key fields, counts, the first blocker and Open bundle', async () => {
    const summary = { ...summaryOf(BUNDLE_DETAIL), autoRegister: { settingOn: false, eligible: false, blockers: BUNDLE_DETAIL.register.blockers } };
    vi.stubGlobal('fetch', vi.fn(mockApi({ 'GET /intake/bundles/:id/progress': () => ({ bundle: summary, files: [] }) }).fetch));
    renderWithProviders(
      <BundleReadyPanel
        item={{ ...base, payload: { bundleId: 'b1', name: 'Jane Doe – Corsa crash', revision: 7, keyFields: [{ label: 'Client', value: 'Jane Doe' }, { label: 'Registration', value: 'KX21 ABC' }], counts: { files: 13, conflicts: 2, missing: 3, signalsWarn: 2 }, blockers: [] } }}
        closed={false}
      />,
    );
    expect(await screen.findByText('Needs review')).toBeTruthy();
    expect(screen.getByText('KX21 ABC')).toBeTruthy();
    expect(screen.getByText('2 to check')).toBeTruthy();
    expect(screen.getByText('3 documents missing')).toBeTruthy();
    expect(screen.getByText('3 things worth a look')).toBeTruthy();
    expect(screen.getByText(/Before Register works: 2 details conflict/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open bundle' }).getAttribute('href')).toBe('/intake/bundles/b1');
  });
});
