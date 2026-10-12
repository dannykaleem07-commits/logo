// @vitest-environment jsdom
// owned by claimai-web
/** The claim header's AI input button (docs/CLAIM-AI-INPUT.md §14.1): badge, instructions chip, navigation with ?focus=update. */
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes, useLocation } from 'react-router-dom';
import { renderWithProviders } from '../../../test/harness';
import { mockApi } from '../../intake/bundles/__fixtures__/mockApi';
import { AiInputHeaderButton, aiInputPath } from './AiInputHeaderButton';
import { panelFixture } from './__fixtures__/fixtures';

function Where() {
  const l = useLocation();
  return <output data-testid="where">{`${l.pathname}${l.search}`}</output>;
}

function host() {
  return (
    <Routes>
      <Route path="/claims/:id" element={<AiInputHeaderButton claimId="c1" />} />
      <Route path="/claims/:id/ai" element={<Where />} />
    </Routes>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('AiInputHeaderButton', () => {
  it('shows the open count and the instructions chip, and opens the tab with the update box focused', async () => {
    vi.stubGlobal('fetch', vi.fn(mockApi({ 'GET /claims/:id/ai-input': () => panelFixture() }).fetch));
    const { user } = renderWithProviders(host(), { route: '/claims/c1' });
    const button = await screen.findByRole('button', { name: 'AI input (2 waiting for you)' });
    expect(button.textContent).toContain('2');
    expect(screen.getByRole('button', { name: '1 instruction' })).toBeTruthy();
    await user.click(button);
    expect(screen.getByTestId('where').textContent).toBe('/claims/c1/ai?focus=update');
  });

  it('the instructions chip opens the tab without focusing the box', async () => {
    vi.stubGlobal('fetch', vi.fn(mockApi({ 'GET /claims/:id/ai-input': () => panelFixture() }).fetch));
    const { user } = renderWithProviders(host(), { route: '/claims/c1' });
    await user.click(await screen.findByRole('button', { name: '1 instruction' }));
    expect(screen.getByTestId('where').textContent).toBe('/claims/c1/ai');
  });

  it('works without a badge when nothing is open (or the panel cannot be loaded)', async () => {
    vi.stubGlobal('fetch', vi.fn(mockApi({ 'GET /claims/:id/ai-input': () => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'no' } } }) }).fetch));
    renderWithProviders(host(), { route: '/claims/c1' });
    const button = await screen.findByRole('button', { name: 'AI input' });
    expect(button.querySelector('.aiin-count')).toBeNull();
    expect(screen.queryByRole('button', { name: /instruction/ })).toBeNull();
    expect(aiInputPath('c 1')).toBe('/claims/c%201/ai?focus=update');
  });
});
