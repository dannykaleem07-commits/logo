// @vitest-environment jsdom
// owned by intake-web
/** Claim Overview intake brief card (docs/SMART-INTAKE.md §11.5): shown when the claim came from a bundle; nothing on 404. */
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../test/harness';
import { IntakeBriefCard, isCaseBrief } from './IntakeBriefCard';
import { CASE_BRIEF } from '../../intake/bundles/__fixtures__/bundleDetail';
import { mockApi } from '../../intake/bundles/__fixtures__/mockApi';

afterEach(() => vi.unstubAllGlobals());

describe('IntakeBriefCard', () => {
  it('shows the brief and collapses to the summary', async () => {
    vi.stubGlobal('fetch', vi.fn(mockApi({ 'GET /claims/:id/intake-brief': () => CASE_BRIEF }).fetch));
    const { user } = renderWithProviders(<IntakeBriefCard claimId="c-new" />);
    expect(await screen.findByText('Case brief (from the documents)')).toBeTruthy();
    expect(screen.getByText('Liability guide — your decision')).toBeTruthy();
    expect(screen.getByText('Driving licence, back')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open in Needs you' }).getAttribute('href')).toBe('/needs-you/ny-req-1');
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByText('Liability guide — your decision')).toBeNull();
    expect(screen.getByText(CASE_BRIEF.summary)).toBeTruthy();
  });

  it('renders nothing when the claim has no intake bundle (404) or the body is not a brief', async () => {
    const fetch = vi.fn(mockApi({ 'GET /claims/:id/intake-brief': () => ({ status: 404, body: { error: { code: 'NO_INTAKE_BUNDLE', message: 'No bundle' } } }) }).fetch);
    vi.stubGlobal('fetch', fetch);
    const { container } = renderWithProviders(<IntakeBriefCard claimId="c1" />);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('');
    expect(isCaseBrief({})).toBe(false);
    expect(isCaseBrief(CASE_BRIEF)).toBe(true);
  });
});
