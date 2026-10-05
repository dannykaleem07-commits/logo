/** Storage and recovery cards on the Hire tab. */
import type { Pence, RecoveryRecord, StorageRecord } from '@ccguk/domain';
import { formatGBP } from '@ccguk/domain';
import { api } from '../../../../api/client';
import { Badge } from '../../../../components/Badge';
import { Button } from '../../../../components/Button';
import { DateText } from '../../../../components/DateText';
import { KeyValue } from '../../../../components/KeyValue';
import { Money } from '../../../../components/Money';
import { recoveryTotals, STORAGE_TRIGGERS, storageTotals } from '../../lib/hire';

export function StorageCard({ s, nowIso, onEnd }: { s: StorageRecord; nowIso: string; onEnd: () => void }) {
  const running = !s.endAt;
  const t = storageTotals(s, nowIso);
  const trigger = STORAGE_TRIGGERS.find((x) => x.value === s.endTrigger);
  return (
    <section className="card service-card">
      <header className="card-header">
        <h3 className="card-title row" style={{ gap: 8 }}>
          {s.location}
          <Badge tone={running ? 'blue' : 'grey'} dot>
            {running ? 'in storage' : 'ended'}
          </Badge>
        </h3>
        {running && (
          <Button size="sm" variant="primary" onClick={onEnd}>
            End storage
          </Button>
        )}
      </header>
      <div className="card-body">
        <KeyValue
          items={[
            { label: 'Start', value: <DateText value={s.startAt} time /> },
            { label: 'End', value: s.endAt ? <span><DateText value={s.endAt} time />{trigger && <div className="basis">{trigger.label} — {trigger.basis}</div>}</span> : <span className="muted">running (costed to now)</span> },
            { label: 'Daily rate (ex VAT)', value: <Money pence={s.dailyRatePence} /> }
          ]}
        />
        {t ? (
          <div className="totals">
            <span>Days</span>
            <span className="right">{t.days}</span>
            <span>Net {t.days} × {formatGBP(t.dailyRatePence)}</span>
            <span className="right">{formatGBP(t.netPence)}</span>
            <span>VAT {Math.round(t.vatRate * 100)}%</span>
            <span className="right">{formatGBP(t.vatPence)}</span>
            <span className="total-line">Gross</span>
            <span className="right total-line">{formatGBP(t.grossPence)}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function RecoveryCard({ r }: { r: RecoveryRecord }) {
  const t = recoveryTotals(r);
  return (
    <section className="card service-card">
      <header className="card-header">
        <h3 className="card-title">
          {r.fromLocation} → {r.toLocation}
        </h3>
        <span className="small muted">
          <DateText value={r.at} time />
        </span>
      </header>
      <div className="card-body">
        <KeyValue
          items={[
            { label: 'Loaded miles', value: r.loadedMiles },
            { label: 'Evidence', value: r.evidenceIds.length ? r.evidenceIds.map((id) => <a key={id} href={api.evidenceFileUrl(id)} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>file</a>) : <span className="muted">none attached</span> }
          ]}
        />
        <div className="totals">
          {t.breakdown.map((l) => (
            <ContentsLine key={l.code} label={l.description} amount={l.amountPence} />
          ))}
          <span>Net</span>
          <span className="right">{formatGBP(t.netPence)}</span>
          <span>VAT {Math.round(t.vatRate * 100)}%</span>
          <span className="right">{formatGBP(t.vatPence)}</span>
          <span className="total-line">Gross</span>
          <span className="right total-line">{formatGBP(t.grossPence)}</span>
        </div>
      </div>
    </section>
  );
}

function ContentsLine({ label, amount }: { label: string; amount: Pence }) {
  return (
    <>
      <span>{label}</span>
      <span className="right">{formatGBP(amount)}</span>
    </>
  );
}
