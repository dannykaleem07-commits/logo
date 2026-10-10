// @vitest-environment jsdom
// owned by ap-foundation
/** Autopilot web wiring (docs/SUPREME-AUTOPILOT.md §H.3, §I, §K): kind panels, claim tab, routes and stub screens. */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AUTOPILOT_NEEDS_YOU_KINDS } from '@ccguk/domain';
import { KIND_PANELS, panelFor } from '../screens/needsYou/kindPanels';
import { KIND_LABEL } from '../screens/needsYou/needsYou';
import { AGENT_TAB_IDS, CLAIM_TABS, splitClaimTabs } from '../screens/claim/claimFile';
import { routes } from '../app/router';
import { ClashPanel } from '../screens/claim/components/ClashPanel';
import type { NeedsYouItem } from '../api/needsYouApi';
import { renderWithProviders } from './harness';

describe('Autopilot wiring', () => {
  it('registers a panel and a label for every Autopilot Needs-you kind', () => {
    for (const kind of AUTOPILOT_NEEDS_YOU_KINDS) {
      expect(panelFor(kind), kind).toBeDefined();
      expect(KIND_LABEL[kind].length).toBeGreaterThan(3);
    }
    expect(panelFor('approve_send')).toBeUndefined();
    expect(Object.keys(KIND_PANELS).sort()).toEqual([...AUTOPILOT_NEEDS_YOU_KINDS].sort());
  });

  it('puts the Autopilot tab first among the agent tabs (primary and More rows unchanged)', () => {
    expect(AGENT_TAB_IDS[0]).toBe('autopilot');
    const { agent, primary } = splitClaimTabs(CLAIM_TABS);
    expect(agent.map((t) => t.label)).toEqual(['Autopilot', 'Mailbox', 'Agent']);
    expect(primary).toHaveLength(6);
  });

  it('routes the kiosk outside the app shell and the Autopilot settings inside it', () => {
    expect(routes.map((r) => r.path)).toContain('/sign/kiosk/:token');
    const shell = routes.find((r) => r.path === '/')!;
    const paths = (shell.children ?? []).map((r) => r.path);
    expect(paths).toEqual(expect.arrayContaining(['settings/autopilot', 'settings/fleet/criteria']));
  });

  it('renders a stub panel and the clash panel placeholder', () => {
    const Panel = panelFor('choose_car')!;
    renderWithProviders(<Panel item={{ id: 'n1', kind: 'choose_car' } as unknown as NeedsYouItem} closed={false} />);
    expect(screen.getByText(/coming with Autopilot/i)).toBeTruthy();
  });

  it('the clash panel stub accepts the agreed props', () => {
    renderWithProviders(<ClashPanel findings={[]} managerMode={false} onAcknowledge={() => undefined} onOverride={() => undefined} />);
    expect(screen.getByText(/Clash checks: coming with Autopilot/)).toBeTruthy();
  });
});
