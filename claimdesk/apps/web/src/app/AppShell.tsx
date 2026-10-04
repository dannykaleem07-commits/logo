import { useEffect, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { NAV_ITEMS } from './nav';
import { MenuIcon, NavIcon, SearchIcon } from './Icons';
import { useDashboardData, useHealth } from '../api/hooks';
import { ErrorBoundary } from '../components/ErrorBoundary';

/**
 * Layout: left nav (drawer on phones), top bar with global search + the two global badges
 * (blocked documents, clocks due today / overdue), and the routed page.
 */
export function AppShell() {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setNavOpen(false), [location.pathname]);

  return (
    <div className="shell">
      <div className={`nav-backdrop ${navOpen ? 'open' : ''}`} onClick={() => setNavOpen(false)} aria-hidden="true" />
      <SideNav open={navOpen} />
      <TopBar onMenu={() => setNavOpen((o) => !o)} />
      <main className="main" id="main">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}

function SideNav({ open }: { open: boolean }) {
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
        <div className="status">
          <span className={`dot ${apiState}`} />
          <span>{apiState === 'ok' ? 'API connected' : apiState === 'down' ? 'API unreachable' : 'Checking API…'}</span>
        </div>
        <div style={{ marginTop: 6 }}>Courtesy Cars Group UK Ltd · 17430389</div>
      </div>
    </nav>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
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
    </header>
  );
}
