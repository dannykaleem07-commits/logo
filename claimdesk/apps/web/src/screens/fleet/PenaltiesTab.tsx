import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { PenaltyNotice } from '@ccguk/domain';
import { formatRegistration } from '@ccguk/domain';
import { api, isApiError } from '../../api/client';
import { useFleet, useInvalidateClaim, usePenalties } from '../../api/hooks';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DateText } from '../../components/DateText';
import { EmptyState } from '../../components/EmptyState';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { Loading } from '../../components/Spinner';
import { Money } from '../../components/Money';
import { Table, type Column } from '../../components/Table';
import { Checkbox } from '../../components/Form';
import { useToast } from '../../components/Toast';
import { todayISO } from '../../lib/dates';
import { isTerminalStage, nextStages, penaltyBasis, penaltyDocumentTemplate, PENALTY_KIND_LABEL, PENALTY_STAGE_LABEL, penaltyStageTone, sortPenalties, unitRegistration, type FleetUnitView, type PenaltyView } from './fleet';
import { DueCell } from './UnitsTab';
import { TransitionDialog } from './TransitionDialog';

/** PCN / NIP / charge notices (GET /fleet/penalties) with stage transitions and notice-document generation. */
export function PenaltiesTab({ onLogNotice }: { onLogNotice: () => void }) {
  const penalties = usePenalties();
  const fleet = useFleet();
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidateClaim();
  const today = todayISO();
  const [showClosed, setShowClosed] = useState(false);
  const [transition, setTransition] = useState<{ notice: PenaltyView; stage: PenaltyNotice['stage'] } | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);

  const units = (fleet.data ?? []) as FleetUnitView[];
  const rows = useMemo(() => sortPenalties((penalties.data ?? []) as PenaltyView[]).filter((p) => showClosed || !isTerminalStage(p.stage)), [penalties.data, showClosed]);
  const open = (penalties.data ?? []).filter((p) => !isTerminalStage(p.stage)).length;

  const generate = async (p: PenaltyView) => {
    const tpl = penaltyDocumentTemplate(p);
    if (!tpl || !p.claimId) return;
    setGenerating(p.id);
    try {
      const doc = await api.createDocument(p.claimId, { templateId: tpl.templateId, data: { penaltyId: p.id, hireAgreementId: p.hireAgreementId } });
      invalidate(p.claimId);
      toast.success(`${tpl.label.replace('Generate ', '')} drafted (${doc.status}) — review and approve on the claim file`);
      navigate(`/claims/${p.claimId}/documents`);
    } catch (e) {
      toast.error(isApiError(e) ? `${e.code}: ${e.message}` : (e as Error).message);
    } finally {
      setGenerating(null);
    }
  };

  const columns: Column<PenaltyView>[] = [
    {
      key: 'notice',
      header: 'Notice',
      render: (p) => (
        <span className="stack-sm" style={{ gap: 2 }}>
          <span className="strong">{p.noticeNumber}</span>
          <span className="xs muted">
            {PENALTY_KIND_LABEL[p.kind]} · {p.issuer}
          </span>
        </span>
      )
    },
    {
      key: 'unit',
      header: 'Unit',
      render: (p) => {
        const unit = units.find((u) => u.id === p.fleetUnitId);
        const reg = p.registration ?? (unit ? unitRegistration(unit) : '');
        return reg ? <span className="reg-plate" style={{ fontSize: '0.75em' }}>{formatRegistration(reg)}</span> : <span className="mono xs">{p.fleetUnitId}</span>;
      }
    },
    { key: 'contravention', header: 'Contravention', render: (p) => <DateText value={p.contraventionAt} time /> },
    { key: 'received', header: 'Received', render: (p) => <DateText value={p.receivedAt} /> },
    { key: 'amount', header: 'Amount', numeric: true, render: (p) => <Money pence={p.amountPence} /> },
    { key: 'discount', header: 'Discount by', render: (p) => (isTerminalStage(p.stage) ? <DateText value={p.discountDeadline} /> : <DueCell date={p.discountDeadline} today={today} />) },
    { key: 'response', header: 'Respond by', render: (p) => (isTerminalStage(p.stage) ? <DateText value={p.responseDeadline} /> : <DueCell date={p.responseDeadline} today={today} />) },
    { key: 'stage', header: 'Stage', render: (p) => <Badge tone={penaltyStageTone(p.stage)} dot={p.stage === 'received'}>{PENALTY_STAGE_LABEL[p.stage]}</Badge> },
    {
      key: 'hirer',
      header: 'Hirer',
      render: (p) =>
        p.claimId ? (
          <Link to={`/claims/${p.claimId}/overview`} className="small">
            {p.hirerName ?? p.claimReference ?? 'claim file'}
          </Link>
        ) : p.hireAgreementId ? (
          <span className="mono xs" title="Hire agreement — the claim file is not linked yet">
            {p.hireAgreementId}
          </span>
        ) : (
          <span className="muted small">not identified</span>
        )
    },
    {
      key: 'actions',
      header: 'Next step',
      render: (p) => {
        const tpl = penaltyDocumentTemplate(p);
        return (
          <span className="stage-actions">
            {nextStages(p.stage).map((s) => (
              <Button key={s} size="sm" variant={s === 'cancelled' || s === 'paid' ? 'ghost' : 'secondary'} onClick={() => setTransition({ notice: p, stage: s })}>
                {transitionLabel(s)}
              </Button>
            ))}
            {tpl && (
              <Button size="sm" variant="primary" onClick={() => generate(p)} disabled={!p.claimId} loading={generating === p.id} title={p.claimId ? 'Drafts the notice on the hirer’s claim file for review and approval' : 'Identify the hirer first: the notice is drafted on the hire agreement’s claim file'}>
                {tpl.label}
              </Button>
            )}
          </span>
        );
      }
    }
  ];

  return (
    <div className="stack">
      <Card
        flush
        title="Penalty notices"
        actions={
          <>
            <Badge tone={open > 0 ? 'amber' : 'grey'}>{open} open</Badge>
            <Checkbox label="Show paid / cancelled" checked={showClosed} onChange={setShowClosed} />
            <Button variant="primary" onClick={onLogNotice}>
              Log notice
            </Button>
          </>
        }
      >
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }} className="stack-sm">
          <p className="basis">
            Workflow: log on receipt → identify the hirer from the signed agreement → transfer liability (Road Traffic (Owner Liability) Regs 2000 Sch 2 particulars) or answer the s.172 request within 28 days → representations → appeal. Notice documents are drafted on the hirer's claim file and go through consistency check → approval → send; nothing is sent from here.
          </p>
        </div>
        {penalties.isLoading ? (
          <Loading label="Loading notices…" />
        ) : penalties.error ? (
          <div style={{ padding: 16 }}>
            <ApiErrorNotice error={penalties.error} what="load penalty notices" />
          </div>
        ) : (
          <Table
            columns={columns}
            rows={rows}
            rowKey={(p) => p.id}
            caption="Penalty notices"
            empty={
              (penalties.data?.length ?? 0) === 0 ? (
                <EmptyState title="No penalty notices logged" action={<Button variant="primary" onClick={onLogNotice}>Log a notice</Button>}>
                  Log every PCN, NIP or charge notice the day it arrives: the discount and response clocks run from the date of service.
                </EmptyState>
              ) : (
                <EmptyState title="No open notices">
                  <Button size="sm" variant="ghost" onClick={() => setShowClosed(true)}>
                    Show paid / cancelled
                  </Button>
                </EmptyState>
              )
            }
          />
        )}
      </Card>
      {rows.length > 0 && (
        <Card title="Deadline basis">
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {[...new Set(rows.map((r) => r.kind))].map((k) => (
              <li key={k}>
                <strong>{PENALTY_KIND_LABEL[k]}:</strong> {penaltyBasis(k)}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <TransitionDialog notice={transition?.notice ?? null} stage={transition?.stage ?? null} onClose={() => setTransition(null)} />
    </div>
  );
}

function transitionLabel(s: PenaltyNotice['stage']): string {
  switch (s) {
    case 'hirer_identified':
      return 'Identify hirer';
    case 'liability_transferred':
      return 'Transfer liability';
    case 'representations':
      return 'Representations';
    case 'appeal':
      return 'Appeal';
    case 'paid':
      return 'Mark paid';
    case 'cancelled':
      return 'Cancelled';
    case 'escalated':
      return 'Escalated';
    case 'received':
      return 'Received';
  }
}
