// owned by ap-clash
/**
 * Fleet clashes (docs/SUPREME-AUTOPILOT.md §C.5): every open finding with filters by code, severity, car and claim.
 * Warnings can be acknowledged and any finding resolved by hand, with a reason (both audited).
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CLASH_DEFS, type ClashSeverity } from '@ccguk/domain';
import { Card } from '../../components/Card';
import { Table, type Column } from '../../components/Table';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Select, TextInput } from '../../components/Form';
import { Modal } from '../../components/Modal';
import { Loading } from '../../components/Spinner';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { EmptyState } from '../../components/EmptyState';
import { DateText } from '../../components/DateText';
import { useToast } from '../../components/Toast';
import { useAcknowledgeClash, useFleetClashes, useResolveClash, type FleetClashFilters, type StoredFinding } from '../../api/clashApi';
import { clashLabel, MIN_REASON, SEVERITY_TONE, sortFindings } from '../claim/lib/clashes';

const STATUS_OPTIONS = [
  { value: 'active', label: 'Open and acknowledged' },
  { value: 'open', label: 'Open' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'overridden', label: 'Overridden' },
  { value: 'resolved', label: 'Resolved' },
] as const;

export function ClashesTab() {
  const [filters, setFilters] = useState<FleetClashFilters>({ status: 'active' });
  const q = useFleetClashes(filters);
  const ack = useAcknowledgeClash();
  const resolve = useResolveClash();
  const toast = useToast();
  const [acting, setActing] = useState<{ finding: StoredFinding; action: 'acknowledge' | 'resolve' } | undefined>();
  const [reason, setReason] = useState('');
  const rows = useMemo(() => sortFindings(q.data?.findings ?? []), [q.data]);

  const columns: Column<StoredFinding>[] = [
    { key: 'sev', header: 'Severity', render: (f) => <Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge>, width: '90px' },
    {
      key: 'what',
      header: 'Clash',
      render: (f) => (
        <div>
          <strong>{clashLabel(f.code)}</strong>
          <div className="small">{f.message}</div>
          {f.status !== 'open' && <div className="muted small">{`${f.status}${f.resolvedBy ? ` by ${f.resolvedBy}` : ''}${f.resolutionNote ? `: ${f.resolutionNote}` : ''}`}</div>}
        </div>
      ),
    },
    { key: 'car', header: 'Car', render: (f) => (f.registration ? <span className="mono">{f.registration}</span> : <span className="muted">—</span>) },
    { key: 'claim', header: 'Claim', render: (f) => (f.claimId ? <Link to={`/claims/${f.claimId}`}>{f.claimReference ?? f.claimId}</Link> : <span className="muted">—</span>) },
    { key: 'seen', header: 'First seen', render: (f) => <DateText value={f.firstSeenAt} /> },
    {
      key: 'act',
      header: '',
      render: (f) =>
        f.status === 'open' || f.status === 'acknowledged' ? (
          <div className="row">
            {f.severity !== 'block' && f.status === 'open' && (
              <Button size="sm" onClick={() => setActing({ finding: f, action: 'acknowledge' })}>
                I&apos;ve read this
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setActing({ finding: f, action: 'resolve' })}>
              Resolve
            </Button>
          </div>
        ) : null,
    },
  ];

  const submit = () => {
    if (!acting) return;
    const m = acting.action === 'acknowledge' ? ack : resolve;
    m.mutate(
      { id: acting.finding.id, reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success(acting.action === 'acknowledge' ? 'Acknowledged' : 'Resolved');
          setActing(undefined);
          setReason('');
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
      },
    );
  };

  return (
    <Card title="Clashes" flush>
      <div className="row" style={{ padding: 'var(--s-3, 12px)' }}>
        <Select<string>
          label="Status"
          value={filters.status ?? 'active'}
          onChange={(v) => setFilters((f) => ({ ...f, status: (v || 'active') as FleetClashFilters['status'] }))}
          options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
        <Select<string>
          label="Severity"
          value={filters.severity ?? ''}
          placeholder="Any"
          onChange={(v) => setFilters((f) => ({ ...f, severity: v as ClashSeverity | '' }))}
          options={[
            { value: 'block', label: 'Block' },
            { value: 'warn', label: 'Warning' },
            { value: 'info', label: 'Information' },
          ]}
        />
        <Select<string> label="Clash" value={filters.code ?? ''} placeholder="Any" onChange={(v) => setFilters((f) => ({ ...f, code: v }))} options={CLASH_DEFS.map((d) => ({ value: d.code, label: d.label }))} />
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ApiErrorNotice error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState title="No clashes" icon="✓">
          Nothing in the fleet diary clashes. The nightly check runs at 02:30.
        </EmptyState>
      ) : (
        <Table columns={columns} rows={rows} rowKey={(f) => f.id} caption="Clash findings" />
      )}
      {acting && (
        <Modal
          open
          title={acting.action === 'acknowledge' ? 'Acknowledge this warning' : 'Resolve this clash'}
          onClose={() => setActing(undefined)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setActing(undefined)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={reason.trim().length < MIN_REASON} loading={ack.isPending || resolve.isPending} onClick={submit}>
                Save
              </Button>
            </>
          }
        >
          <p>{acting.finding.message}</p>
          <TextInput label="Reason (kept in the audit trail)" value={reason} onChange={setReason} />
        </Modal>
      )}
    </Card>
  );
}
