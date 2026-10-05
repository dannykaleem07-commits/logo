import { overrideRule } from '@ccguk/domain';
import { useUsers } from '../../../api/hooks';
import { useClaimAudit, type AuditEntryView } from '../../../api/managerApi';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { Card } from '../../../components/Card';
import { DateText } from '../../../components/DateText';
import { EmptyState } from '../../../components/EmptyState';
import { Loading } from '../../../components/Spinner';
import { Table, type Column } from '../../../components/Table';
import { auditActionLabel, auditReasonText } from '../../../lib/managerMode';
import type { ClaimView } from '../claimFile';
import { FlagsBanner } from '../components/FlagsBanner';
import { FLAG_MEANING } from '../../../lib/flagNames';


export function FlagsTab({ view }: { view: ClaimView }) {
  const flags = [...(view.flags ?? view.claim.flags)].sort((a, b) => Number(Boolean(a.clearedAt)) - Number(Boolean(b.clearedAt)) || b.raisedAt.localeCompare(a.raisedAt));
  return (
    <div className="stack">
      <Card title="Flags" actions={<span className="small muted">{flags.filter((f) => !f.clearedAt).length} open · {flags.filter((f) => f.clearedAt).length} cleared</span>}>
        {flags.length === 0 ? <EmptyState title="No flags on this file">Flags are raised by the system (cross-file checks, connected parties, old company details) or by a handler.</EmptyState> : <FlagsBanner claimId={view.claim.id} flags={flags} showCleared />}
      </Card>
      <AuditTrailCard claimId={view.claim.id} />
      <Card title="What the flags mean" flush>
        <ul className="list">
          {FLAG_MEANING.map((f) => (
            <li key={f.code}>
              <div className="list-main">
                <div className="list-title" title={f.code}>
                  {f.name}
                </div>
                <div className="list-sub">{f.meaning}</div>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/** Read-only audit trail of this claim (0.3 §A.8): overrides, hire corrections, flag clearances and other audited actions. */
function AuditTrailCard({ claimId }: { claimId: string }) {
  const audit = useClaimAudit(claimId);
  const users = useUsers();
  const nameOf = (id: string) => (id === 'system' ? 'System' : (users.data?.find((u) => u.id === id)?.name ?? id));
  const rows = audit.data ?? [];
  const columns: Column<AuditEntryView>[] = [
    { key: 'when', header: 'When', width: '150px', render: (r) => <DateText value={r.at} time /> },
    { key: 'who', header: 'Who', width: '150px', render: (r) => nameOf(r.userId) },
    {
      key: 'what',
      header: 'What',
      render: (r) => {
        const override = r.action.startsWith('override.');
        return <span style={override ? { color: 'var(--red)', fontWeight: 600 } : undefined}>{auditActionLabel(r.action, (code) => overrideRule(code)?.label)}</span>;
      }
    },
    { key: 'why', header: 'Reason / details', render: (r) => <span className="audit-details">{auditReasonText(r) || '—'}</span> }
  ];
  return (
    <Card title="Audit trail" actions={<span className="small muted">{rows.length ? `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}, newest first` : ''}</span>} flush>
      {audit.isLoading ? (
        <Loading label="Loading the audit trail…" />
      ) : audit.error ? (
        <div style={{ padding: 12 }}>
          <ApiErrorNotice error={audit.error} what="load the audit trail" />
        </div>
      ) : (
        <div className="audit-table">
          <Table columns={columns} rows={rows} rowKey={(r) => r.id} empty="Nothing audited on this claim yet." caption="Audit trail" />
        </div>
      )}
    </Card>
  );
}
