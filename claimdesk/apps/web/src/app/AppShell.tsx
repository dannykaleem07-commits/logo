import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { NAV_ITEMS } from './nav';
import { MenuIcon, NavIcon, SearchIcon, ShieldIcon, SignOutIcon } from './Icons';
import { minutesText, useManagerMode } from './managerMode';
import { clearSignedInState } from './session';
import { useDashboardData, useHealth, useLogout, useMe } from '../api/hooks';
import type { AuthUser } from '../api/client';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { LOGIN_PATH } from '../lib/auth';
import { SHELL_CONTACT_LINE, versionLabel } from '../screens/settings/settings';
import { UpdateNotice } from '../screens/settings/UpdateNotice';

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
        <ManagerBanner />
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
    clearSignedInState(queryClient);
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
        <UpdateNotice />
      </div>
    </nav>
  );
}

function TopBar({ onMenu, ...userProps }: { onMenu: () => void } & UserProps) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const location = useLocation();
  const urlQ = params.get('q') ?? '';
  const onClaims = location.pathname === '/claims';
  const [q, setQ] = useState(onClaims ? urlQ : '');
  const inputRef = useRef<HTMLInputElement>(null);
  const narrow = useNarrowScreen();
  // Follow the claims list's ?q= only when the q string itself (or the page) changes, and never while the user is
  // typing here; other pages' ?q= (e.g. the KB search) is not the global search.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setQ(onClaims ? urlQ : '');
  }, [urlQ, onClaims]);
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
        <input ref={inputRef} type="search" placeholder={narrow ? 'Search' : 'Search registration, claim ref or name'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Global search" />
      </form>
      <div className="topbar-badges">
        <Link to="/#blocked-documents" className={`topbar-badge ${blocked > 0 ? 'hot' : ''}`} title="Documents blocked by the consistency engine (need a human to clear each flag)">
          <span className="label-long">Blocked documents</span>
          <span className="label-short">Blocked</span>
          <span className="count">{blocked}</span>
        </Link>
        <Link to="/#clocks" className={`topbar-badge topbar-clocks ${overdue > 0 ? 'hot' : dueToday > 0 ? 'warm' : ''}`} title="Clocks due today and overdue (open the dashboard list)">
          <span className="label-long">{clocksPillText(overdue, dueToday)}</span>
          <span className="label-short">{overdue > 0 ? `${overdue} overdue` : `${dueToday} due today`}</span>
        </Link>
      </div>
      <ManagerToggle />
      <UserBox {...userProps} place="top" />
    </header>
  );
}

/** Top-bar clocks pill: "11 overdue · 1 due today". */
export function clocksPillText(overdue: number, dueToday: number): string {
  return `${overdue} overdue · ${dueToday} due today`;
}

/** Phones and narrow tablets (the nav becomes a drawer at the same width). Server render: false. */
function useNarrowScreen(query = '(max-width: 900px)'): boolean {
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [query]);
  return narrow;
}

/** "Manager mode" / "Manager mode ON" (admin and approver only). One click, no dialog (docs/V03 §A.1). */
function ManagerToggle() {
  const mm = useManagerMode();
  const [failed, setFailed] = useState<string | null>(null);
  if (!mm.allowed) return null;
  const toggle = async () => {
    setFailed(null);
    try {
      if (mm.on) await mm.turnOff('user');
      else await mm.turnOn();
    } catch (e) {
      setFailed((e as Error)?.message ?? 'Could not change manager mode');
    }
  };
  return (
    <button
      type="button"
      className={`manager-toggle ${mm.on ? 'on' : ''}`}
      onClick={() => void toggle()}
      disabled={mm.pending}
      aria-pressed={mm.on}
      aria-busy={mm.pending || undefined}
      title={failed ?? (mm.on ? 'Manager mode is on: click to turn it off' : 'Turn manager mode on: override anything that would normally stop you (every override is audited)')}
    >
      <ShieldIcon />
      <span className="manager-toggle-long">{mm.on ? 'Manager mode ON' : 'Manager mode'}</span>
      <span className="manager-toggle-short">{mm.on ? 'ON' : 'Manager'}</span>
    </button>
  );
}

/** The full-width "Manager mode is on" banner under the top bar, with the reason box and Turn off. */
function ManagerBanner() {
  const mm = useManagerMode();
  if (!mm.on) return null;
  return (
    <div className="manager-banner" role="region" aria-label="Manager mode">
      <div className="manager-banner-text">
        <strong>Manager mode is on.</strong> Anything that would normally stop you can be overridden, and every override is recorded in the audit log.
      </div>
      <label className="manager-banner-reason">
        <span>Reason</span>
        <input type="text" className="input" value={mm.reason} maxLength={500} onChange={(e) => mm.setReason(e.target.value)} onBlur={() => !mm.reason.trim() && mm.setReason('Manager override')} />
      </label>
      <span className="manager-banner-idle">Switches off after {minutesText(mm.idleMinutes)} without activity</span>
      <button type="button" className="manager-banner-off" onClick={() => void mm.turnOff('user').catch(() => undefined)} disabled={mm.pending}>
        Turn off
      </button>
    </div>
  );
}
