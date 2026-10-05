import { useEffect, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { NAV_ITEMS } from './nav';
import { MenuIcon, NavIcon, SearchIcon, SignOutIcon } from './Icons';
import { qk, useDashboardData, useHealth, useLogout, useMe } from '../api/hooks';
import type { AuthUser } from '../api/client';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { LOGIN_PATH } from '../lib/auth';
import { SHELL_CONTACT_LINE, versionLabel } from '../screens/settings/settings';

/**
 * Layout: left nav (drawer on phones), top bar with global search + the two global badges
 * (blocked documents, clocks due today / overdue), the signed-in user with "Sign out", and the routed page.
 * Rendered inside <AuthGate>, so `useMe()` already holds the user.
 */
export function AppShell() {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setNavOpen(false), [location.pathname]);
  const user = useMe().data ?? null;
  const { signOut, signingOut } = useSignOut();
  const userProps = { user, onSignOut: signOut, signingOut };

  return (
    <div className="shell">
      <div className={`nav-backdrop ${navOpen ? 'open' : ''}`} onClick={() => setNavOpen(false)} aria-hidden="true" />
      <SideNav open={navOpen} {...userProps} />
      <TopBar onMenu={() => setNavOpen((o) => !o)} {...userProps} />
      <main className="main" id="main">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}

/**
 * Sign out: end the session on the server (a failure still signs out locally — the cookie may already be gone),
 * leave the shell, then drop every cached query so nothing from this session is shown to the next person.
 */
function useSignOut() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const logout = useLogout();
  const [signingOut, setSigningOut] = useState(false);
  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout.mutateAsync();
    } catch {
      // already signed out, or the API is down: carry on and leave the shell
    }
    // flushSync commits the route change before the cache is emptied, so the auth gate never re-renders here
    // with an empty cache (which would bounce to /login?next=… instead of a clean /login).
    await navigate(LOGIN_PATH, { replace: true, flushSync: true });
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== qk.loginDefaults[0] || q.queryKey[1] !== qk.loginDefaults[1] });
  };
  return { signOut, signingOut };
}

interface UserProps {
  user: AuthUser | null;
  onSignOut: () => void;
  signingOut: boolean;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[parts.length - 1]![0]}` : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

/** Name, role and "Sign out". `place` picks the styling: the top bar (desktop) or the nav drawer (phones). */
function UserBox({ user, onSignOut, signingOut, place }: UserProps & { place: 'top' | 'nav' }) {
  const name = user?.name || user?.username || 'Signed in';
  return (
    <div className={place === 'top' ? 'topbar-user' : 'nav-user'}>
      <span className="user-avatar" aria-hidden="true">
        {initials(name)}
      </span>
      <span className="user-text">
        <span className="user-name" title={user?.email || undefined}>
          {name}
        </span>
        {user?.role && <span className="user-role">{user.role}</span>}
      </span>
      <button type="button" className="signout-btn" onClick={onSignOut} disabled={signingOut} aria-busy={signingOut || undefined}>
        <SignOutIcon />
        <span>{signingOut ? 'Signing out…' : 'Sign out'}</span>
      </button>
    </div>
  );
}

function SideNav({ open, ...userProps }: { open: boolean } & UserProps) {
  const health = useHealth();
  const apiState = health.isError ? 'down' : health.data ? 'ok' : 'unknown';
  return (
    <nav className={`nav ${open ? 'open' : ''}`} aria-label="Main">
      <Link to="/" className="nav-brand">
        <span className="nav-brand-logo">
          <img src="/logo.png" alt="Courtesy Cars UK" />
        </span>
        <span className="nav-brand-text">
          <span className="nav-brand-name">ClaimDesk</span>
          <span className="nav-brand-sub">CCGUK</span>
        </span>
      </Link>
      <ul className="nav-list">
        {NAV_ITEMS.map((item) => (
          <li key={item.to}>
            <NavLink to={item.to} end={item.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''} ${item.icon === 'new' ? 'nav-cta' : ''}`}>
              <NavIcon name={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="nav-foot">
        <UserBox {...userProps} place="nav" />
        <div className="status">
          <span className={`dot ${apiState}`} />
          <span>{apiState === 'ok' ? 'API connected' : apiState === 'down' ? 'API unreachable' : 'Checking API…'}</span>
        </div>
        <div style={{ marginTop: 6 }}>Courtesy Cars Group UK Ltd · 17430389</div>
        <div className="xs">{SHELL_CONTACT_LINE}</div>
        <div className="app-version" title={health.data?.version ? `Version ${health.data.version}` : undefined}>
          {versionLabel(health.data?.version)}
        </div>
      </div>
    </nav>
  );
}

function TopBar({ onMenu, ...userProps }: { onMenu: () => void } & UserProps) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  useEffect(() => setQ(params.get('q') ?? ''), [params]);
  const dash = useDashboardData();
  const blocked = dash.blockedDocuments.length;
  const dueToday = dash.clocksToday.length;
  const overdue = dash.clocksOverdue.length;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    navigate(term ? `/claims?q=${encodeURIComponent(term)}` : '/claims');
  };

  return (
    <header className="topbar">
      <button type="button" className="topbar-menu" onClick={onMenu} aria-label="Open navigation">
        <MenuIcon />
      </button>
      <form className="topbar-search" role="search" onSubmit={submit}>
        <SearchIcon />
        <input type="search" placeholder="Search registration, claim ref or name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Global search" />
      </form>
      <div className="topbar-badges">
        <Link to="/#blocked-documents" className={`topbar-badge ${blocked > 0 ? 'hot' : ''}`} title="Documents blocked by the consistency engine (need a human to clear each flag)">
          <span className="label-long">Blocked documents</span>
          <span className="label-short">Blocked</span>
          <span className="count">{blocked}</span>
        </Link>
        <Link to="/#clocks" className={`topbar-badge ${overdue > 0 ? 'hot' : dueToday > 0 ? 'warm' : ''}`} title={`${overdue} overdue, ${dueToday} due today`}>
          <span className="label-long">Clocks due today</span>
          <span className="label-short">Clocks</span>
          <span className="count">{overdue > 0 ? `${dueToday}+${overdue}` : dueToday}</span>
        </Link>
      </div>
      <UserBox {...userProps} place="top" />
    </header>
  );
}
