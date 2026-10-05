import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { formatRegistration } from '@ccguk/domain';
import { useClaim, useUserName } from '../../api/hooks';
import { PageHeader } from '../../components/PageHeader';
import { Tabs, type TabItem } from '../../components/Tabs';
import { Loading } from '../../components/Spinner';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { Badge } from '../../components/Badge';
import { isOverdue } from '../../lib/clocks';
import { CLAIM_TABS, hasHardStop, openFlags, splitClaimTabs, type ClaimView } from './claimFile';
import { StatusControl } from './components/StatusControl';
import { FlagsBanner } from './components/FlagsBanner';
import { OverviewTab } from './tabs/OverviewTab';
import { ChronologyTab } from './tabs/ChronologyTab';
import { LedgerTab } from './tabs/LedgerTab';
import { ClocksTab } from './tabs/ClocksTab';
import { GatesTab } from './tabs/GatesTab';
import { HireTab } from './tabs/HireTab';
import { OffersTab } from './tabs/OffersTab';
import { EvidenceTab } from './tabs/EvidenceTab';
import { DocumentsTab } from './tabs/DocumentsTab';
import { DocumentView } from './tabs/DocumentView';
import { EngineeringTab } from './tabs/EngineeringTab';
import { VehicleTab } from './tabs/VehicleTab';
import { ActionsTab } from './tabs/ActionsTab';
import { FlagsTab } from './tabs/FlagsTab';
import { isBlocked } from './lib/documents';
import './claim.css';

export { CLAIM_TABS } from './claimFile';

/**
 * Claim file: header (reference, status control, claimant, registration, insurer, handler), flags banner, tab strip
 * and one nested route per tab. Every tab reads the bundle loaded here (`useClaim`) and the derived routes
 * (clocks, gates, actions, acceptance) through `useClaimDerived`.
 */
export function ClaimFilePage() {
  const { id, '*': rest } = useParams();
  const navigate = useNavigate();
  const bundle = useClaim(id);
  // Hooks before any early return: resolve the handler's name for the header.
  const handlerName = useUserName((bundle.data as ClaimView | undefined)?.claim?.handlerId);
  const current = (rest ?? '').split('/')[0] || 'overview';

  if (bundle.isLoading) {
    return (
      <div className="page">
        <Loading label="Loading claim file…" />
      </div>
    );
  }
  if (bundle.error || !bundle.data || !id) {
    return (
      <div className="page">
        <PageHeader title="Claim file" crumbs={[{ label: 'Claims', to: '/claims' }]} />
        <ApiErrorNotice error={bundle.error} what="load the claim" />
      </div>
    );
  }

  const view = bundle.data as ClaimView;
  const flags = openFlags(view);
  const hardStop = hasHardStop(view);
  const now = new Date();
  const counts = {
    flags: flags.length,
    clocks: view.clocks.filter((c) => isOverdue(c, now)).length,
    documents: view.documents.filter((d) => isBlocked(d)).length,
    offers: view.offers.filter((o) => !o.replySentAt).length,
    actions: (view.actions ?? []).filter((a) => a.priority === 'now').length
  };
  const tabs: TabItem[] = CLAIM_TABS.map((t) => {
    const n = counts[t.id as keyof typeof counts];
    const tone = t.id === 'offers' || t.id === 'actions' ? 'amber' : 'red';
    return n ? { ...t, badge: <Badge tone={tone}>{n}</Badge> } : t;
  });
  // Primary row + "More ▾" (0.3 §E1); the open-flag count shows on More while Flags sits inside it.
  const { primary, more } = splitClaimTabs(tabs);
  const moreBadge = counts.flags ? <Badge tone="red">{counts.flags}</Badge> : undefined;
  const linked = view.linkedClaims ?? view.claim.linkedClaimIds.map((lid) => ({ id: lid, reference: lid, status: '' }));

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: 'Claims', to: '/claims' }, { label: view.claim.reference }]}
        title={
          <span className="row">
            {view.claim.reference}
            <StatusControl claimId={view.claim.id} status={view.claim.status} hardStop={hardStop} />
            {hardStop && (
              <Badge tone="red" dot>
                hard stop
              </Badge>
            )}
          </span>
        }
        subtitle={
          <span className="row" style={{ gap: 8 }}>
            <strong>{view.claimant.name}</strong>
            <span className="reg-plate" style={{ fontSize: '0.8em' }}>
              {formatRegistration(view.vehicle.registration)}
            </span>
            <span>
              {view.vehicle.make} {view.vehicle.model}
            </span>
            <span>·</span>
            <span>
              {view.atFaultInsurer ? view.atFaultInsurer.name : <span className="muted">at-fault insurer not yet identified</span>}
              {view.claim.atFaultInsurerRef ? <span className="muted"> ref {view.claim.atFaultInsurerRef}</span> : view.atFaultInsurer ? <span className="muted"> (no handling ref yet)</span> : null}
            </span>
            <span>·</span>
            <span>handler {handlerName ?? <span className="muted">unassigned</span>}</span>
          </span>
        }
      />
      {linked.length > 0 && (
        <div className="notice notice-warn" style={{ marginBottom: 12 }}>
          <strong>Linked file.</strong> This registration or party is connected to{' '}
          {linked.map((l, i) => (
            <span key={l.id}>
              {i > 0 && ', '}
              <Link to={`/claims/${l.id}`}>{l.reference}</Link>
              {l.status ? ` (${l.status.replace(/_/g, ' ')})` : ''}
            </span>
          ))}
          . Each file keeps its own ledger, documents and insurer.
        </div>
      )}
      <FlagsBanner claimId={view.claim.id} flags={flags} />
      <div className="claim-tabs-wrap">
        <Tabs items={primary} more={more} moreBadge={moreBadge} narrowPrimary={3} value={current} onChange={(tab) => navigate(`/claims/${id}/${tab}`)} ariaLabel="Claim file sections" />
      </div>
      <div style={{ marginTop: 16 }} id={`tabpanel-${current}`} role="tabpanel">
        <Routes>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<OverviewTab view={view} />} />
          <Route path="chronology" element={<ChronologyTab view={view} />} />
          <Route path="ledger" element={<LedgerTab view={view} />} />
          <Route path="clocks" element={<ClocksTab view={view} />} />
          <Route path="gates" element={<GatesTab view={view} />} />
          <Route path="hire" element={<HireTab view={view} />} />
          <Route path="offers" element={<OffersTab view={view} />} />
          <Route path="evidence" element={<EvidenceTab view={view} />} />
          <Route path="documents" element={<DocumentsTab view={view} />} />
          <Route path="documents/:docId" element={<DocumentView view={view} />} />
          <Route path="engineering/*" element={<EngineeringTab view={view} />} />
          <Route path="vehicle" element={<VehicleTab view={view} />} />
          <Route path="actions" element={<ActionsTab view={view} />} />
          <Route path="flags" element={<FlagsTab view={view} />} />
          <Route path="*" element={<Navigate to="overview" replace />} />
        </Routes>
      </div>
    </div>
  );
}
