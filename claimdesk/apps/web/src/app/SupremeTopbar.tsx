// owned by runtime
/**
 * Top-bar Agents pill and Needs-you badge (docs/SUPREME-DESIGN.md §L.1), mounted by AppShell inside `.topbar-badges`.
 * Pill: green "Agents running", amber "Paused — usage resets 14:05", red "Agents stopped", grey "Agents off" → /agents.
 * Badge: the open Needs-you count (urgent in red) → /needs-you. Both poll every 15 s; failures render nothing.
 */
import { Link } from 'react-router-dom';
import { pillTone, useAgentsStatus } from '../api/agentsApi';
import { useNeedsYouCount } from '../api/needsYouApi';

const DOT: Record<ReturnType<typeof pillTone>, string> = { green: 'var(--green, #1f8a4c)', amber: 'var(--amber, #b7791f)', red: 'var(--red, #c0392b)', grey: 'var(--grey, #8a8f98)' };

export function SupremeTopbar() {
  const status = useAgentsStatus();
  const count = useNeedsYouCount();
  const pill = status.data?.pill;
  const total = count.data?.total ?? 0;
  const urgent = count.data?.urgent ?? 0;
  return (
    <>
      {pill && (
        <Link to="/agents" className={`topbar-badge ${pill.state === 'stopped' ? 'hot' : pill.state === 'paused' ? 'warm' : ''}`} title={`${pill.label} — open the agents control room`} data-testid="agents-pill">
          <span aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: DOT[pillTone(pill.state)], marginRight: 6 }} />
          <span className="label-long">{pill.label}</span>
          <span className="label-short">{pill.state === 'running' ? 'Agents' : pill.state === 'paused' ? 'Paused' : pill.state === 'stopped' ? 'Stopped' : 'Off'}</span>
        </Link>
      )}
      {count.data && (
        <Link to="/needs-you" className={`topbar-badge ${urgent > 0 ? 'hot' : total > 0 ? 'warm' : ''}`} title={urgent > 0 ? `${total} items need you (${urgent} urgent)` : `${total} items need you`} data-testid="needs-you-badge">
          <span className="label-long">Needs you</span>
          <span className="label-short">You</span>
          <span className="count">{urgent > 0 ? `${total} · ${urgent} urgent` : total}</span>
        </Link>
      )}
    </>
  );
}
