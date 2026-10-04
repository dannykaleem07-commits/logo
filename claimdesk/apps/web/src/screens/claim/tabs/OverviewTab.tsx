import { Link } from 'react-router-dom';
import type { CaseAcceptance } from '@ccguk/domain';
import { Card } from '../../../components/Card';
import { KeyValue } from '../../../components/KeyValue';
import { DateText } from '../../../components/DateText';
import { Money } from '../../../components/Money';
import { ClockPill } from '../../../components/ClockPill';
import { Badge } from '../../../components/Badge';
import { EmptyState } from '../../../components/EmptyState';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { Table, type Column } from '../../../components/Table';
import { openClocks } from '../../../lib/clocks';
import type { ClaimView } from '../claimFile';
import { useClaimAcceptance, useClaimClocks, useClaimGates } from '../useClaimDerived';
import { useUserName } from '../../../api/hooks';

/** Plain-English labels for the acceptance perimeter flags (the codes stay in the audit trail). */
const PERIMETER_LABEL: Record<string, string> = {
  LSA_LITIGATION_DRAFTS_ONLY: 'Litigation documents are drafts for the claimant or a solicitor to sign (Legal Services Act 2007 s.12)',
  PERSONAL_INJURY_REFER_OUT: 'Personal injury element: refer out to a PI solicitor, no referral fee (LASPO 2012 ss.56–60)',
};
import { GatesRow } from '../components/GatesRow';
import { BasisText } from '../components/BasisText';
import { headLabel, positionByHead, type HeadPosition } from '../lib/ledger';

export function OverviewTab({ view }: { view: ClaimView }) {
  const handlerName = useUserName(view.claim.handlerId);
  const now = new Date();
  const clocks = useClaimClocks(view);
  const gates = useClaimGates(view);
  const acceptance = useClaimAcceptance(view);
  const open = openClocks(clocks.clocks).slice(0, 8);
  const position = positionByHead(view.ledger);
  const c = view.claim;

  const moneyColumns: Column<HeadPosition>[] = [
    { key: 'head', header: 'Head', render: (r) => headLabel(r.head) },
    { key: 'claimed', header: 'Claimed', numeric: true, render: (r) => <Money pence={r.claimedPence} blankZero /> },
    { key: 'offered', header: 'Offered', numeric: true, render: (r) => <Money pence={r.offeredPence} blankZero /> },
    { key: 'paid', header: 'Paid', numeric: true, render: (r) => <Money pence={r.paidPence} blankZero /> },
    { key: 'outstanding', header: 'Outstanding', numeric: true, render: (r) => <strong><Money pence={r.outstandingPence} /></strong> }
  ];

  return (
    <div className="stack">
      <Card
        title="Evidence gates"
        actions={
          <Link className="btn btn-ghost btn-sm" to="../gates">
            Detail
          </Link>
        }
      >
        {gates.isLoading ? <Loading /> : <GatesRow gates={gates.gates} />}
        <ApiErrorNotice error={gates.error} what="load the gates" />
        <p className="xs muted" style={{ margin: '10px 0 0' }}>
          A claim cannot move to payment pack until its gates are green (BLUEPRINT principle 2). Hover or expand a tile for what is missing.
        </p>
      </Card>

      <div className="grid-2">
        <Card title="Claim">
          <KeyValue
            items={[
              { label: 'Opened', value: <DateText value={c.openedAt} time /> },
              { label: 'Accident', value: <DateText value={c.accident.occurredAt} time /> },
              { label: 'Location', value: [c.accident.location, c.accident.postcode].filter(Boolean).join(', ') },
              {
                label: 'Liability',
                value: (
                  <span className="row" style={{ gap: 6 }}>
                    <Badge tone={c.liability === 'admitted' ? 'green' : c.liability === 'denied' ? 'red' : 'amber'}>{c.liability}</Badge>
                    {c.liabilityScore !== undefined && <span className="small muted">score {c.liabilityScore}/100</span>}
                  </span>
                )
              },
              { label: 'At-fault insurer', value: view.atFaultInsurer ? `${view.atFaultInsurer.name}${c.atFaultInsurerRef ? ` · ref ${c.atFaultInsurerRef}` : ' · no handling reference yet'}` : '—' },
              { label: "Client's insurer", value: [view.claim.clientInsurerId ? ((view as { clientInsurer?: { name?: string } }).clientInsurer?.name ?? 'On file') : '', c.clientPolicyNumber ? `policy ${c.clientPolicyNumber}` : ''].filter(Boolean).join(' · ') || '—' },
              { label: 'Handler', value: handlerName ?? '—' },
              { label: 'Track', value: c.track ? c.track.replace(/_/g, ' ') : '—' },
              { label: 'GTA', value: c.gtaSubscriber ? 'Subscriber' : 'Non-subscriber — GTA figures are an industry benchmark only (GTA 2.7(j))' },
              { label: 'Injury', value: c.injuryReferral ? `Referred to ${c.injuryReferral.referredTo} on ${c.injuryReferral.referredAt.slice(0, 10)} — no fee taken` : c.accident.injuries ? 'Reported — referral required (no fee)' : 'None reported' },
              { label: 'Vehicle', value: `${view.vehicle.make} ${view.vehicle.model}${view.vehicle.yearOfManufacture ? ` (${view.vehicle.yearOfManufacture})` : ''} · ${view.vehicle.gtaGroup ? `group ${view.vehicle.gtaGroup}` : 'group not mapped'}` },
              { label: 'Driveable after', value: c.accident.driveable === undefined ? '—' : c.accident.driveable ? 'Yes' : 'No' },
              { label: 'Roadworthy after', value: c.accident.roadworthyAfter === undefined ? '—' : c.accident.roadworthyAfter ? 'Yes' : 'No (period argument)' }
            ]}
          />
        </Card>
        <Card title="Case acceptance">
          {acceptance.isLoading ? <Loading /> : acceptance.acceptance ? <AcceptanceCard a={acceptance.acceptance} /> : <EmptyState title="Not assessed yet">The API scores liability, Tescher costs exposure and readiness from the file.</EmptyState>}
          <ApiErrorNotice error={acceptance.error} what="load the acceptance assessment" />
        </Card>
      </div>

      <div className="grid-2">
        <Card
          title="Key clocks"
          flush
          actions={
            <Link className="btn btn-ghost btn-sm" to="../clocks">
              All clocks
            </Link>
          }
        >
          {clocks.isLoading ? (
            <Loading />
          ) : open.length === 0 ? (
            <EmptyState title="No open clocks">Clocks derive from the events you log on the chronology.</EmptyState>
          ) : (
            <ul className="list">
              {open.map((k) => (
                <li key={k.id}>
                  <div className="list-main">
                    <div className="list-title">{k.label}</div>
                    <div className="list-sub">
                      <BasisText basis={k.basis} />
                      {k.attributableTo ? <span> · on {k.attributableTo}</span> : null}
                    </div>
                  </div>
                  <ClockPill clock={k} now={now} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card
          title="Money by head"
          flush
          actions={
            <Link className="btn btn-ghost btn-sm" to="../ledger">
              Ledger
            </Link>
          }
        >
          {position.heads.length === 0 ? (
            <EmptyState title="Nothing on the ledger yet">Claimed, offered, paid and outstanding by head appear as entries are added.</EmptyState>
          ) : (
            <>
              <Table columns={moneyColumns} rows={position.heads} rowKey={(r) => r.head} caption="Money by head of loss" />
              <div className="row-between" style={{ padding: '10px 20px', borderTop: '1px solid var(--line)', fontSize: 'var(--fs-sm)' }}>
                <span className="muted">
                  Claimed <Money pence={position.totals.claimedPence} /> · offered <Money pence={position.totals.offeredPence} /> · paid <Money pence={position.totals.paidPence} />
                </span>
                <strong>
                  Outstanding <Money pence={position.totals.outstandingPence} />
                </strong>
              </div>
            </>
          )}
        </Card>
      </div>

      <Card title="Parties">
        <div className="grid-3">
          <KeyValue stack items={[{ label: 'Claimant', value: view.claimant.name }, { label: 'Contact', value: [view.claimant.phone, view.claimant.email].filter(Boolean).join(' · ') || '—' }, { label: 'Address', value: view.claimant.address ? [view.claimant.address.line1, view.claimant.address.town, view.claimant.address.postcode].filter(Boolean).join(', ') : '—' }]} />
          <KeyValue stack items={[{ label: 'Driver', value: view.driver ? view.driver.name : 'Claimant drove' }, { label: 'Third parties', value: view.thirdParties.length ? view.thirdParties.map((p) => p.name).join(', ') : '—' }, { label: 'Third-party vehicle', value: view.thirdPartyVehicle ? `${view.thirdPartyVehicle.registration} ${view.thirdPartyVehicle.make} ${view.thirdPartyVehicle.model}`.trim() : '—' }]} />
          <KeyValue stack items={[{ label: 'Witnesses', value: c.accident.independentWitness === undefined ? '—' : c.accident.independentWitness ? 'Independent witness' : 'No independent witness' }, { label: 'CCTV / dashcam', value: [c.accident.cctvAvailable ? 'CCTV' : '', c.accident.dashcamAvailable ? 'dashcam' : ''].filter(Boolean).join(' · ') || 'none known' }, { label: 'Police', value: c.accident.policeAttended ? `Attended${c.accident.policeReference ? ` · ${c.accident.policeReference}` : ''}` : 'Not attended' }]} />
        </div>
      </Card>
    </div>
  );
}

function scoreTone(score: number): 'red' | 'amber' | 'green' {
  return score < 40 ? 'red' : score < 70 ? 'amber' : 'green';
}

const READINESS_TONE = { ready: 'green', partial: 'amber', none: 'red' } as const;
const EXPOSURE_TONE = { low: 'green', medium: 'amber', high: 'red' } as const;
const DECISION_TONE = { accept: 'green', accept_with_conditions: 'amber', decline: 'red' } as const;

export function AcceptanceCard({ a }: { a: CaseAcceptance }) {
  const tone = scoreTone(a.liabilityScore);
  return (
    <div className="stack">
      <div>
        <div className="row-between small">
          <span>Liability score</span>
          <strong>{a.liabilityScore}/100</strong>
        </div>
        <div className={`score-bar ${tone}`} role="meter" aria-valuenow={a.liabilityScore} aria-valuemin={0} aria-valuemax={100} aria-label="Liability score">
          <span style={{ width: `${Math.max(0, Math.min(100, a.liabilityScore))}%` }} />
        </div>
      </div>
      <KeyValue
        items={[
          {
            label: 'Costs exposure',
            value: (
              <div>
                <Badge tone={EXPOSURE_TONE[a.costsExposure]}>{a.costsExposure}</Badge>
                {a.hireToOtherHeadsRatio !== undefined && <span className="small"> · hire : other heads = {a.hireToOtherHeadsRatio.toFixed(1)}</span>}
                <div className="basis" style={{ marginTop: 4 }}>
                  Tescher v Direct Accident Management [2025] EWCA Civ 733 (two-stage test): where hire dwarfs the other heads the court may treat the litigation as run for the hire provider and make a non-party costs order (see also Kindertons v Murtagh [2024] EWHC 471 (KB)). Weak-liability files should not run on hire without strong evidence.
                </div>
              </div>
            )
          },
          { label: 'Impecuniosity', value: <Badge tone={READINESS_TONE[a.impecuniosityReadiness]}>{a.impecuniosityReadiness}</Badge> },
          { label: 'Enforceability', value: <Badge tone={READINESS_TONE[a.enforceabilityReadiness]}>{a.enforceabilityReadiness}</Badge> },
          {
            label: 'Decision',
            value: (
              <Badge tone={DECISION_TONE[a.decision]} dot>
                {a.decision.replace(/_/g, ' ')}
              </Badge>
            )
          },
          { label: 'Perimeter', value: a.perimeterFlags.length ? a.perimeterFlags.map((f) => PERIMETER_LABEL[f] ?? f.replace(/_/g, ' ').toLowerCase()).join('; ') : 'No perimeter flags', hidden: false }
        ]}
      />
      {a.conditions.length > 0 && (
        <div>
          <div className="small strong">Conditions</div>
          <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {a.conditions.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}
      {a.reasons.length > 0 && (
        <details>
          <summary className="small muted" style={{ cursor: 'pointer' }}>
            Reasons ({a.reasons.length})
          </summary>
          <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {a.reasons.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
