import { useMemo, useState } from 'react';
import type { ComplianceAlert, ISODate } from '@ccguk/domain';
import { formatRegistration } from '@ccguk/domain';
import { useFleet, useFleetAlerts } from '../../api/hooks';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DateText } from '../../components/DateText';
import { EmptyState } from '../../components/EmptyState';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { Loading } from '../../components/Spinner';
import { Money } from '../../components/Money';
import { Table, type Column } from '../../components/Table';
import { TextInput, Select } from '../../components/Form';
import { severityTone } from '../../lib/status';
import { todayISO } from '../../lib/dates';
import { ALERT_CODE_LABEL, ALERT_SEVERITY_LABEL, describeDueDate, dueTone, dueToneToBadge, FLEET_USE_LABEL, groupAlertsBySeverity, insuranceExpiry, unitDescription, unitRegistration, UNIT_STATUSES, UNIT_STATUS_LABEL, unitStatusTone, type FleetUnitView } from './fleet';
import { UnitDialog } from './UnitDialog';
import { AllocateCheckDialog } from './AllocateCheckDialog';
import { plainText } from '../../lib/plainText';

/** Units table + compliance alerts (GET /fleet, GET /fleet/alerts). */
export function UnitsTab({ onLogNotice }: { onLogNotice: (unitId: string) => void }) {
  const fleet = useFleet();
  const alerts = useFleetAlerts();
  const today = todayISO();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<FleetUnitView['status'] | ''>('');
  const [dialog, setDialog] = useState<{ kind: 'unit'; unit: FleetUnitView | null } | { kind: 'allocate'; unitId?: string } | null>(null);

  const units = (fleet.data ?? []) as FleetUnitView[];
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase().replace(/\s+/g, '');
    return units
      .filter((u) => !status || u.status === status)
      .filter((u) => !term || unitRegistration(u).toLowerCase().includes(term) || unitDescription(u).toLowerCase().replace(/\s+/g, '').includes(term) || u.gtaGroup.toLowerCase() === term)
      .sort((a, b) => unitRegistration(a).localeCompare(unitRegistration(b)));
  }, [units, q, status]);

  const alertsByUnit = useMemo(() => {
    const m = new Map<string, ComplianceAlert[]>();
    for (const a of alerts.data ?? []) m.set(a.fleetUnitId, [...(m.get(a.fleetUnitId) ?? []), a]);
    return m;
  }, [alerts.data]);

  const columns: Column<FleetUnitView>[] = [
    {
      key: 'reg',
      header: 'Reg',
      render: (u) => (
        <span className="stack-sm" style={{ gap: 2 }}>
          <span className="reg-plate" style={{ fontSize: '0.8em' }}>{formatRegistration(unitRegistration(u)) || '—'}</span>
          {(alertsByUnit.get(u.id) ?? u.alerts ?? []).some((a) => a.severity === 'block') && (
            <Badge tone="red" dot className="xs">
              blocked
            </Badge>
          )}
        </span>
      )
    },
    {
      key: 'vehicle',
      header: 'Vehicle',
      render: (u) => (
        <span className="stack-sm" style={{ gap: 4, alignItems: 'flex-start' }}>
          <span>{unitDescription(u) || <span className="muted">—</span>}</span>
          <Badge tone="navy" title="Industry benchmark group — CCGUK is not a GTA subscriber">
            GTA {u.gtaGroup || '—'}
          </Badge>
        </span>
      )
    },
    {
      key: 'uses',
      header: 'Declared uses',
      render: (u) => (
        <span className="chip-row">
          {u.declaredUses.length === 0 ? <Badge tone="red">none</Badge> : u.declaredUses.map((use) => <Badge key={use} tone="blue">{FLEET_USE_LABEL[use]}</Badge>)}
          {u.phvLicensed && <Badge tone="grey">PHV</Badge>}
        </span>
      )
    },
    {
      key: 'policy',
      header: 'Policy',
      render: (u) =>
        u.policy ? (
          <span className="small fleet-policy" title={`Covers: ${u.policy.coveredUses.map((x) => FLEET_USE_LABEL[x]).join(', ')}`}>
            {u.policy.insurerName} <span className="muted xs">{u.policy.policyNumber}</span>
          </span>
        ) : u.policyId ? (
          <span className="mono xs">{u.policyId}</span>
        ) : (
          <Badge tone="amber">no policy</Badge>
        )
    },
    {
      key: 'due',
      header: 'Due dates',
      render: (u) => (
        <DueList
          today={today}
          items={[
            ['MOT', u.vehicle?.motExpiryDate],
            ['Tax', u.vehicle?.taxDueDate],
            ['Insurance', insuranceExpiry(u)],
            ['Service', u.serviceDueDate]
          ]}
        />
      )
    },
    { key: 'rate', header: 'Rate/day', numeric: true, render: (u) => <Money pence={u.dailyRatePence} /> },
    { key: 'status', header: 'Status', render: (u) => <Badge tone={unitStatusTone(u.status)}>{UNIT_STATUS_LABEL[u.status]}</Badge> },
    {
      key: 'keeper',
      header: 'V5C address',
      render: (u) =>
        u.keeperAddressCurrent ? (
          <span className="ok-mark" title={u.keeperAddressOnV5C ? `${u.keeperAddressOnV5C.line1}, ${u.keeperAddressOnV5C.postcode}` : 'Current'}>
            ✓ current
          </span>
        ) : (
          <Badge tone="red" dot title="Tickets go to an old address and can end in county court judgments. Update the V5C with DVLA.">
            stale
          </Badge>
        )
    },
    {
      key: 'actions',
      header: '',
      render: (u) => (
        <span className="stage-actions">
          <Button size="sm" onClick={() => setDialog({ kind: 'unit', unit: u })}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'allocate', unitId: u.id })} disabled={u.status === 'disposed'}>
            Check cover
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onLogNotice(u.id)}>
            Log notice
          </Button>
        </span>
      )
    }
  ];

  return (
    <div className="stack">
      <Card
        flush
        title="Units"
        actions={
          <>
            <Button variant="ghost" onClick={() => setDialog({ kind: 'allocate' })} disabled={units.length === 0}>
              Allocation check
            </Button>
            <Button variant="primary" onClick={() => setDialog({ kind: 'unit', unit: null })}>
              Add unit
            </Button>
          </>
        }
      >
        <div className="toolbar">
          <TextInput label="Find" type="search" value={q} onChange={setQ} placeholder="Registration, make/model or group" />
          <Select<FleetUnitView['status']> label="Status" value={status} onChange={setStatus} placeholder="Any status" options={UNIT_STATUSES.map((s) => ({ value: s, label: UNIT_STATUS_LABEL[s] }))} />
          <span className="xs muted" style={{ flex: '1 1 240px' }}>
            Dates: <Badge tone="red">expired</Badge> <Badge tone="amber">≤ 30 days</Badge> <Badge tone="green">later</Badge>. GTA groups are an industry benchmark (CCGUK is not a subscriber).
          </span>
        </div>
        {fleet.isLoading ? (
          <Loading label="Loading fleet…" />
        ) : fleet.error ? (
          <div style={{ padding: 16 }}>
            <ApiErrorNotice error={fleet.error} what="load the fleet register" />
          </div>
        ) : (
          <Table
            columns={columns}
            rows={rows}
            rowKey={(u) => u.id}
            caption="Fleet units"
            empty={
              units.length === 0 ? (
                <EmptyState title="No fleet units yet" action={<Button variant="primary" onClick={() => setDialog({ kind: 'unit', unit: null })}>Add the first unit</Button>}>
                  Every unit carries its declared class of use, policy and V5C keeper address so allocation and PCN transfer are safe.
                </EmptyState>
              ) : (
                <EmptyState title="No units match" />
              )
            }
          />
        )}
      </Card>

      <Card id="alerts" title="Compliance alerts" actions={<Badge tone={(alerts.data?.length ?? 0) > 0 ? 'amber' : 'grey'}>{alerts.data?.length ?? 0}</Badge>} flush>
        {alerts.isLoading ? (
          <Loading />
        ) : alerts.error ? (
          <div style={{ padding: 16 }}>
            <ApiErrorNotice error={alerts.error} what="load fleet alerts" />
          </div>
        ) : (alerts.data?.length ?? 0) === 0 ? (
          <EmptyState title="No compliance alerts" icon="✓">
            MOT, tax, insurance, service, keeper address, class-of-use cover and penalty deadlines are all in date.
          </EmptyState>
        ) : (
          groupAlertsBySeverity(alerts.data ?? []).map((g) => (
            <div key={g.severity} className="alert-group">
              <div className="alert-group-title">
                {ALERT_SEVERITY_LABEL[g.severity]} · {g.alerts.length}
              </div>
              <ul className="list">
                {g.alerts.map((a, i) => {
                  const unit = units.find((u) => u.id === a.fleetUnitId);
                  return (
                    <li key={`${a.fleetUnitId}-${a.code}-${i}`}>
                      <div className="list-main">
                        <div className="list-title">
                          {unit ? <span className="reg-plate" style={{ fontSize: '0.75em', marginRight: 8 }}>{formatRegistration(unitRegistration(unit))}</span> : <span className="mono xs" style={{ marginRight: 8 }}>{a.fleetUnitId}</span>}
                          {ALERT_CODE_LABEL[a.code] ?? a.code}
                        </div>
                        <div className="list-sub">
                          {plainText(a.message)}
                          {a.dueDate ? (
                            <>
                              {' '}
                              · <DateText value={a.dueDate} /> ({describeDueDate(a.dueDate, today)})
                            </>
                          ) : null}
                        </div>
                      </div>
                      <span className="row" style={{ gap: 6 }}>
                        <Badge tone={severityTone(a.severity)} dot>
                          {a.severity}
                        </Badge>
                        {unit && (
                          <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'unit', unit })}>
                            Edit unit
                          </Button>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </Card>

      <UnitDialog open={dialog?.kind === 'unit'} unit={dialog?.kind === 'unit' ? dialog.unit : null} onClose={() => setDialog(null)} />
      <AllocateCheckDialog open={dialog?.kind === 'allocate'} units={units} initialUnitId={dialog?.kind === 'allocate' ? dialog.unitId : undefined} onClose={() => setDialog(null)} />
    </div>
  );
}

/** A dated cell coloured by proximity (red expired · amber ≤ 30 days · green later · grey not recorded). */
/** The four fleet due dates in one compact column (MOT, tax, insurance, service); the distance is on hover. */
export function DueList({ items, today }: { items: Array<[string, ISODate | undefined | null]>; today: ISODate }) {
  return (
    <dl className="due-list">
      {items.map(([label, date]) => {
        const tone = dueTone(date, today);
        return (
          <div key={label} className="due-list-row" title={tone === 'unknown' ? `${label}: no date recorded` : `${label}: ${describeDueDate(date, today)}`}>
            <dt>{label}</dt>
            <dd>{tone === 'unknown' ? <span className="muted">—</span> : <Badge tone={dueToneToBadge(tone)}>{<DateText value={date} />}</Badge>}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function DueCell({ date, today }: { date: ISODate | undefined | null; today: ISODate }) {
  const tone = dueTone(date, today);
  if (tone === 'unknown') return <span className="muted">—</span>;
  return (
    <span className="due-cell" title={describeDueDate(date, today)}>
      <Badge tone={dueToneToBadge(tone)}>{<DateText value={date} />}</Badge>
      <span className="xs muted">{describeDueDate(date, today)}</span>
    </span>
  );
}
