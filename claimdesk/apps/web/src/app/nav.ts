/**
 * Left-nav entries. Keep in sync with router.tsx; the next-stage screens replace the placeholders in place.
 *
 * The nav is data-driven and grouped (0.4 calm pass):
 *  - 'top'      — reserved, shown first: Phase 1 adds "Needs you" and "Agents" here (an item routed to /needs-you or
 *                 /agents lands here on its own; any other item can set `section: 'top'`).
 *  - 'main'     — the everyday screens (the default when `section` is left out).
 *  - 'more'     — less-used screens, behind a collapsible "More" heading (always in the DOM, so every route stays reachable).
 *  - 'settings' — pinned at the bottom (Document templates and GTA rates live under Settings).
 * Adding a screen = appending one entry to NAV_ITEMS.
 */
export type NavSection = 'top' | 'main' | 'more' | 'settings';

export interface NavItem {
  to: string;
  label: string;
  icon: 'dashboard' | 'claims' | 'new' | 'fleet' | 'directory' | 'kb' | 'analytics' | 'watch' | 'settings' | 'needsYou' | 'agents' | 'intake' | 'outbox' | 'dailyLog';
  end?: boolean;
  /** Which nav group the entry sits in (default: 'main', or 'top' for /needs-you and /agents). */
  section?: NavSection;
}

export const NAV_ITEMS: NavItem[] = [
  // ClaimDesk Supreme (docs/SUPREME-DESIGN.md §L): Needs you and Agents sit in the 'top' group by their paths.
  { to: '/needs-you', label: 'Needs you', icon: 'needsYou' },
  { to: '/agents', label: 'Agents', icon: 'agents' },
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/claims', label: 'Claims', icon: 'claims', end: true },
  { to: '/claims/new', label: 'New claim', icon: 'new' },
  { to: '/fleet', label: 'Fleet', icon: 'fleet' },
  { to: '/intake', label: 'Intake', icon: 'intake' },
  { to: '/outbox', label: 'Outbox', icon: 'outbox' },
  { to: '/daily-log', label: 'Daily log', icon: 'dailyLog', section: 'more' },
  { to: '/directory', label: 'Directory', icon: 'directory', section: 'more' },
  { to: '/kb', label: 'Knowledge base', icon: 'kb', section: 'more' },
  { to: '/analytics', label: 'Analytics', icon: 'analytics', section: 'more' },
  { to: '/watch', label: 'Watch list', icon: 'watch', section: 'more' },
  { to: '/settings', label: 'Settings', icon: 'settings', section: 'settings' }
];

/** The nav groups in display order; `label` is the heading shown above the group (none for top/main/settings). */
export const NAV_SECTIONS: ReadonlyArray<{ id: NavSection; label?: string; collapsible?: boolean }> = [
  { id: 'top' },
  { id: 'main' },
  { id: 'more', label: 'More', collapsible: true },
  { id: 'settings' }
];

/** Screens that belong at the top of the nav even when their entry does not say so (Phase 1). */
const TOP_PATHS = new Set(['/needs-you', '/agents']);

export function navSectionOf(item: Pick<NavItem, 'to' | 'section'>): NavSection {
  return item.section ?? (TOP_PATHS.has(item.to) ? 'top' : 'main');
}

/** NAV_ITEMS split by section, in their original order. Empty sections are kept (the shell skips them). */
export function navItemsBySection(items: readonly NavItem[] = NAV_ITEMS): Record<NavSection, NavItem[]> {
  const out: Record<NavSection, NavItem[]> = { top: [], main: [], more: [], settings: [] };
  for (const item of items) out[navSectionOf(item)].push(item);
  return out;
}

/** True when `pathname` is (or is under) the item's route, matching how NavLink marks it active. */
export function navItemMatches(item: Pick<NavItem, 'to' | 'end'>, pathname: string): boolean {
  if (item.to === '/') return pathname === '/';
  if (item.end) return pathname === item.to || pathname === `${item.to}/`;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}
