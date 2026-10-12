// @vitest-environment jsdom
// owned by intake-web
/** New bundle (docs/SMART-INTAKE.md §11.3): the name keeps focus while typing; files wait for a name; create → bundle page with the upload queue. */
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, typeAndExpectFocus } from '../../../test/harness';
import { NewBundlePage } from './NewBundlePage';
import { existingUploadQueue, resetUploadQueues } from './uploadQueue';
import { BUNDLE_DETAIL, summaryOf } from './__fixtures__/bundleDetail';
import { mockApi } from './__fixtures__/mockApi';

afterEach(() => {
  vi.unstubAllGlobals();
  resetUploadQueues();
});

function render() {
  const api = mockApi({
    'POST /intake/bundles': (c) => ({ status: 201, body: { ...summaryOf(BUNDLE_DETAIL), id: 'b-new', name: (c.body as { name: string }).name } }),
    'GET /limits': () => ({ maxEvidenceBytes: 2048 * 1024 * 1024, chunkThresholdBytes: 64 * 1024 * 1024, chunkBytes: 8 * 1024 * 1024 }),
    'POST /intake/bundles/:id/files': () => ({ status: 201, body: { files: [], bundle: summaryOf(BUNDLE_DETAIL) } }),
  });
  vi.stubGlobal('fetch', vi.fn(api.fetch));
  // No XHR in these tests: the queue falls back to fetch (mocked), so nothing ever reaches a network.
  vi.stubGlobal('XMLHttpRequest', undefined);
  const r = renderWithProviders(
    <Routes>
      <Route path="/intake/bundles/new" element={<NewBundlePage />} />
      <Route path="/intake/bundles/:id" element={<div>Bundle page opened</div>} />
    </Routes>,
    { route: '/intake/bundles/new' },
  );
  return { ...r, api };
}

describe('NewBundlePage', () => {
  it('typing the temporary name never loses focus', async () => {
    const { user } = render();
    await typeAndExpectFocus(user, screen.getByLabelText(/Temporary name/) as HTMLInputElement, 'Jane Doe – Corsa crash');
  });

  it('files chosen before a name wait for it; then the bundle is created and its page opens with the uploads queued', async () => {
    const { user, api } = render();
    const input = screen.getByLabelText('Choose files') as HTMLInputElement;
    await user.upload(input, [new File(['%PDF-1.4 x'], 'V5C.pdf', { type: 'application/pdf' }), new File(['x'], 'Thumbs.db')]);
    expect(await screen.findByText(/Type a temporary name first/)).toBeTruthy();
    expect(screen.getByText(/1 file is ready/)).toBeTruthy();
    expect(api.find('POST', '/intake/bundles')).toHaveLength(0);
    await user.type(screen.getByLabelText(/Temporary name/), 'Jane Doe – Corsa crash');
    await user.click(screen.getByRole('button', { name: 'Create the bundle and upload' }));
    expect(await screen.findByText('Bundle page opened')).toBeTruthy();
    expect(api.find('POST', '/intake/bundles')[0]!.body).toEqual({ name: 'Jane Doe – Corsa crash' });
    const q = existingUploadQueue('b-new')!;
    expect(q).toBeTruthy();
    await vi.waitFor(() => expect(q.getSnapshot().map((r) => [r.name, r.status])).toEqual([['V5C.pdf', 'sent']]));
    expect(api.find('POST', '/intake/bundles/b-new/files')).toHaveLength(1);
  });

  it('an empty bundle needs a name', async () => {
    const { user } = render();
    const create = screen.getByRole('button', { name: 'Create an empty bundle' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await user.type(screen.getByLabelText(/Temporary name/), 'Ali Example');
    expect(create.disabled).toBe(false);
    expect(screen.getByText(/inbox\\intake\\Ali Example\\/)).toBeTruthy();
  });
});
