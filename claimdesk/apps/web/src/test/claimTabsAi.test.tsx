// @vitest-environment jsdom
// owned by claimai-web
/**
 * The AI input tab in the claim file (docs/CLAIM-AI-INPUT.md §14.1): its own group between the primary row and the agent
 * tabs; the primary row, More and the agent group are unchanged; /claims/:id/ai renders the tab under the header button.
 */
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { AI_TAB_IDS, CLAIM_TABS, isClaimTab, MORE_TAB_IDS, PRIMARY_TAB_IDS, splitClaimTabs } from '../screens/claim/claimFile';
import { ClaimFilePage } from '../screens/claim/ClaimFilePage';
import { mockApi } from '../screens/intake/bundles/__fixtures__/mockApi';
import { panelFixture, updatePreview } from '../screens/claim/ai/__fixtures__/fixtures';
import { renderWithProviders } from './harness';

afterEach(() => vi.unstubAllGlobals());

describe('AI input tab group', () => {
  it('is its own group; primary, More and agent groups are unchanged', () => {
    const { primary, more, agent, ai } = splitClaimTabs(CLAIM_TABS);
    expect(ai.map((t) => [t.id, t.label])).toEqual([['ai', 'AI input']]);
    expect(AI_TAB_IDS).toEqual(['ai']);
    expect(primary.map((t) => t.id)).toEqual([...PRIMARY_TAB_IDS]);
    expect(more.map((t) => t.id)).toEqual([...MORE_TAB_IDS]);
    expect(agent.map((t) => t.label)).toEqual(['Autopilot', 'Mailbox', 'Agent']);
    expect(isClaimTab('ai')).toBe(true);
    // every tab sits in exactly one group
    const all = [...primary, ...more, ...agent, ...ai].map((t) => t.id);
    expect(new Set(all).size).toBe(CLAIM_TABS.length);
  });

  it('the claim file shows the header button and the tab between the primary row and the agent tabs', async () => {
    const claim = {
      claim: { id: 'c1', reference: 'CCG-2026-00001', status: 'hire_active', linkedClaimIds: [], flags: [] },
      claimant: { id: 'p1', name: 'Jane Doe' },
      vehicle: { registration: 'AB12CDE', make: 'Vauxhall', model: 'Corsa' },
      atFaultInsurer: { id: 'p2', name: 'Example Mutual' },
      thirdParties: [],
      flags: [],
      clocks: [],
      documents: [],
      offers: [],
      actions: [],
      events: [],
      hire: [],
      evidence: [],
    };
    const api = mockApi({
      'GET /claims/:id': () => claim,
      'GET /claims/:id/ai-input': () => panelFixture(),
      'GET /claims/:id/ai-input/inputs': () => panelFixture().history,
      'GET /claims/:id/ai-input/u1': () => updatePreview(),
      'GET /claims/:id/ai-input/cu1': () => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'gone' } } }),
    });
    vi.stubGlobal('fetch', vi.fn(api.fetch));
    renderWithProviders(
      <Routes>
        <Route path="/claims/:id/*" element={<ClaimFilePage />} />
      </Routes>,
      { route: '/claims/c1/ai' },
    );
    expect(await screen.findByRole('button', { name: 'AI input (2 waiting for you)' })).toBeTruthy();
    const strip = screen.getByRole('tablist', { name: 'Claim file sections' });
    const labels = within(strip)
      .getAllByRole('tab')
      .map((t) => t.textContent);
    expect(labels.slice(0, 6)).toEqual(['Overview', 'Hire', 'Documents', 'Evidence', 'Vehicle', 'Next actions']);
    expect(labels[6]).toMatch(/^AI input/);
    expect(labels.slice(7)).toEqual(['Autopilot', 'Mailbox', 'Agent']);
    const aiTab = within(strip).getByRole('tab', { name: /AI input/ });
    expect(aiTab.getAttribute('aria-selected')).toBe('true');
    expect(within(aiTab).getByText('2')).toBeTruthy();
    expect(await screen.findByText(/^I understood/)).toBeTruthy();
  });
});
