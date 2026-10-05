// @vitest-environment jsdom
/** Claim file tabs: primary row + "More ▾" menu (docs/V03-MANAGER-MODE-HIRE-PRICING.md §E1). */
import { useState } from 'react';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge } from '../components/Badge';
import { Tabs } from '../components/Tabs';
import { CLAIM_TABS, isClaimTab, MORE_TAB_IDS, PRIMARY_TAB_IDS, splitClaimTabs } from '../screens/claim/claimFile';
import { renderWithProviders } from './harness';

describe('splitClaimTabs', () => {
  it('primary row: Overview · Hire · Documents · Evidence · Vehicle · Next actions; More holds the rest; ids unchanged', () => {
    const { primary, more } = splitClaimTabs(CLAIM_TABS);
    expect(primary.map((t) => t.label)).toEqual(['Overview', 'Hire', 'Documents', 'Evidence', 'Vehicle', 'Next actions']);
    expect(more.map((t) => t.label)).toEqual(['Chronology', 'Ledger', 'Clocks', 'Evidence gates', 'Offers', 'Engineering', 'Flags']);
    expect(primary.map((t) => t.id)).toEqual([...PRIMARY_TAB_IDS]);
    expect(more.map((t) => t.id)).toEqual([...MORE_TAB_IDS]);
    // every one of the 13 route ids is still a tab, in one group only
    const ids = ['overview', 'chronology', 'ledger', 'clocks', 'gates', 'hire', 'offers', 'evidence', 'documents', 'engineering', 'vehicle', 'actions', 'flags'];
    for (const id of ids) expect(isClaimTab(id)).toBe(true);
    expect(primary.length + more.length).toBe(13);
    expect(new Set([...primary, ...more].map((t) => t.id)).size).toBe(13);
  });
  it('keeps badges on the items it splits', () => {
    const tabs = CLAIM_TABS.map((t) => (t.id === 'flags' ? { ...t, badge: 'B' } : t));
    expect(splitClaimTabs(tabs).more.find((t) => t.id === 'flags')?.badge).toBe('B');
  });
});

function Host({ start = 'overview' }: { start?: string }) {
  const [value, setValue] = useState(start);
  const { primary, more } = splitClaimTabs(CLAIM_TABS);
  return (
    <>
      <Tabs items={primary} more={more} moreBadge={<Badge tone="red">2</Badge>} value={value} onChange={setValue} ariaLabel="Claim file sections" />
      <output data-testid="value">{value}</output>
    </>
  );
}

describe('Tabs with a More menu', () => {
  it('shows the primary tabs and a More button with the badge; the menu lists the rest and picks one', async () => {
    const { user } = renderWithProviders(<Host />);
    expect(within(screen.getByRole('tablist')).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Hire', 'Documents', 'Evidence', 'Vehicle', 'Next actions']);
    const more = screen.getByRole('button', { name: /More/ });
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(more.textContent).toContain('2');
    await user.click(more);
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitemradio').map((m) => m.textContent)).toEqual(['Chronology', 'Ledger', 'Clocks', 'Evidence gates', 'Offers', 'Engineering', 'Flags']);
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Ledger' }));
    expect(screen.getByTestId('value').textContent).toBe('ledger');
    expect(screen.queryByRole('menu')).toBeNull();
    // the button now shows the current tab's name
    expect(screen.getByRole('button', { name: /Ledger/ }).getAttribute('aria-haspopup')).toBe('menu');
  });

  it('is keyboard accessible: ArrowDown opens on the first item, arrows move, Enter picks, Escape closes back on the button', async () => {
    const { user } = renderWithProviders(<Host />);
    const more = screen.getByRole('button', { name: /More/ });
    more.focus();
    await user.keyboard('{ArrowDown}');
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement?.textContent).toBe('Chronology');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement?.textContent).toBe('Clocks');
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement?.textContent).toBe('Ledger');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more);
    await user.keyboard('{ArrowDown}');
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await user.keyboard('{End}{Enter}');
    expect(screen.getByTestId('value').textContent).toBe('flags');
  });

  it('a click outside closes the menu', async () => {
    const { user } = renderWithProviders(<Host start="gates" />);
    const more = screen.getByRole('button', { name: /Evidence gates/ });
    await user.click(more);
    expect(screen.getByRole('menu')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Hire' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByTestId('value').textContent).toBe('hire');
  });
});
