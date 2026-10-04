import { Link } from 'react-router-dom';
import type { GateResult } from '@ccguk/domain';
import { Card } from '../../../components/Card';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { GateBadge } from '../../../components/Badge';
import type { ClaimView } from '../claimFile';
import { useClaimGates } from '../useClaimDerived';
import { GatesRow, gateLabel } from '../components/GatesRow';

/** Where each gate is fed from, so a red tile is one click from the fix. */
const WHERE_TO_FIX: Record<GateResult['gate'], Array<{ label: string; to: string }>> = {
  need: [
    { label: 'Statement of need (form)', to: '../documents' },
    { label: 'Claimant details', to: '../overview' }
  ],
  use: [
    { label: 'Odometer photos at delivery and collection', to: '../evidence' },
    { label: 'Hire agreement odometers', to: '../hire' }
  ],
  period: [
    { label: 'Chronology (engineer, authorisation, parts, repair dates)', to: '../chronology' },
    { label: "Engineer's report (roadworthy / repair days)", to: '../engineering/report' }
  ],
  rate: [
    { label: 'Hire agreement rate and GTA group', to: '../hire' },
    { label: 'Basic hire rate comparators (screenshots)', to: '../evidence' }
  ],
  impecuniosity: [
    { label: 'Statement of means (form)', to: '../documents' },
    { label: 'Bank statements, payslips', to: '../evidence' }
  ],
  mitigation: [
    { label: 'Intervention register', to: '../offers' },
    { label: 'Mitigation questionnaire (form)', to: '../documents' }
  ],
  enforceability: [{ label: 'Hire agreement checklist (CCR 2013, art 60F)', to: '../hire' }],
  liability: [
    { label: 'CCTV / dashcam / witness statements', to: '../evidence' },
    { label: 'Accident details and liability score', to: '../overview' }
  ]
};

export function GatesTab({ view }: { view: ClaimView }) {
  const { gates, isLoading, error } = useClaimGates(view);
  return (
    <div className="stack">
      <Card title="Evidence gates" actions={<span className="small muted">need · use · period · rate · impecuniosity · mitigation · enforceability · liability</span>}>
        <ApiErrorNotice error={error} what="load the gates" />
        {isLoading ? <Loading /> : <GatesRow gates={gates} expanded />}
      </Card>
      {gates.length > 0 && (
        <Card title="What closes each gate" flush>
          <ul className="list">
            {gates.map((g) => (
              <li key={g.gate}>
                <div className="list-main">
                  <div className="list-title row" style={{ gap: 8 }}>
                    {gateLabel(g.gate)} <GateBadge gate={g} />
                  </div>
                  <div className="list-sub">
                    {g.missing.length ? `Missing: ${g.missing.join('; ')}` : 'Complete — nothing missing.'}
                  </div>
                  <div className="row xs" style={{ gap: 10, marginTop: 4 }}>
                    {WHERE_TO_FIX[g.gate].map((w) => (
                      <Link key={w.to + w.label} to={w.to}>
                        {w.label} →
                      </Link>
                    ))}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <p className="xs muted">
        Gates are evaluated by the API from the file (documents count once approved, sent or signed; a draft proves nothing). The payment pack is blocked until every gate the pack needs is green (GTA 6.1–6.3 is the benchmark pack for a non-subscriber).
      </p>
    </div>
  );
}
