/** Left-nav entries. Keep in sync with router.tsx; the next-stage screens replace the placeholders in place. */
export interface NavItem {
  to: string;
  label: string;
  icon: 'dashboard' | 'claims' | 'new' | 'fleet' | 'directory' | 'kb' | 'analytics' | 'watch' | 'settings';
  end?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/claims', label: 'Claims', icon: 'claims', end: true },
  { to: '/claims/new', label: 'New claim', icon: 'new' },
  { to: '/fleet', label: 'Fleet', icon: 'fleet' },
  { to: '/directory', label: 'Directory', icon: 'directory' },
  { to: '/kb', label: 'Knowledge base', icon: 'kb' },
  { to: '/analytics', label: 'Analytics', icon: 'analytics' },
  { to: '/watch', label: 'Watch list', icon: 'watch' },
  { to: '/settings', label: 'Settings', icon: 'settings' }
];
