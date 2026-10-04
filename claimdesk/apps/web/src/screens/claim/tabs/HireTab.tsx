import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { FleetUse, HireAgreement, HireEndTrigger, Pence, RecoveryRecord, StorageRecord } from '@ccguk/domain';
import { formatGBP, HIRE_DAY_CONVENTION, londonDate } from '@ccguk/domain';
import { api } from '../../../api/client';
import { useEndHire, useEndStorage, useFleet, useGtaRates, useHire, usePostHire, usePostRecovery, usePostStorage, useRecovery, useStorage } from '../../../api/hooks';
import { Card } from '../../../components/Card';
import { Badge, VerificationBadge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Modal } from '../../../components/Modal';
import { KeyValue } from '../../../components/KeyValue';
import { DateText } from '../../../components/DateText';
import { Money } from '../../../components/Money';
import { ClockPill } from '../../../components/ClockPill';
import { Checkbox, DateTimeInput, MoneyInput, Select, TextArea, TextInput } from '../../../components/Form';
import { EmptyState } from '../../../components/EmptyState';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { partyName, pickList, type ClaimView } from '../claimFile';
import { useClaimClocks } from '../useClaimDerived';
import { BasisText } from '../components/BasisText';
import { EvidencePicker } from '../components/EvidencePicker';
import { offHireClocks, storageCapClock } from '../lib/clocksView';
import {
  endHireBodyFrom,
  endStorageBodyFrom,
  enforceabilityChecklist,
  enforceabilityScore,
  GTA_BENCHMARK_NOTE,
  HIRE_TRIGGERS,
  hireRunning,
  hireTotals,
  recoveryBodyFrom,
  recoveryTotals,
  STORAGE_TRIGGERS,
  storageBodyFrom,
  storageTotals,
  triggerLabel,
  type EndHireForm,
  type EndStorageForm,
  type RecoveryForm,
  type StorageEndTrigger,
  type StorageForm
} from '../lib/hire';

export function HireTab({ view }: { view: ClaimView }) {
  const claimId = view.claim.id;
  const hireQ = useHire(claimId);
  const storageQ = useStorage(claimId);
  const recoveryQ = useRecovery(claimId);
  const hires = pickList(hireQ.data, view.hire);
  const storage = pickList(storageQ.data, view.storage);
  const recovery = pickList(recoveryQ.data, view.recovery);
  const { clocks } = useClaimClocks(view);
  const now = new Date();
  const nowIso = now.toISOString();
  const offHire = offHireClocks(clocks).filter((c) => c.status === 'running' || c.status === 'breached');
  const storageCap = storageCapClock(clocks);
  const [ending, setEnding] = useState<HireAgreement | null>(null);
  const [endingStorage, setEndingStorage] = useState<StorageRecord | null>(null);
  const [starting, setStarting] = useState(false);
  const [addingStorage, setAddingStorage] = useState(false);
  const [addingRecovery, setAddingRecovery] = useState(false);

  return (
    <div className="stack">
      {offHire.length > 0 && (
        <div className="notice notice-warn" role="alert">
          <strong>Off-hire deadline.</strong>{' '}
          {offHire.map((c) => (
            <span key={c.id} className="row" style={{ display: 'inline-flex', gap: 8 }}>
              {c.label}: <DateText value={c.dueAt} time /> <ClockPill clock={c} now={now} /> <BasisText basis={c.basis} />
            </span>
          ))}{' '}
          Hire past the trigger is the live-file failure (lesson d): end the agreement with the trigger below.
        </div>
      )}

      <Card
        title="Hire agreements"
        actions={
          <Button size="sm" variant="primary" onClick={() => setStarting(true)}>
            Start hire
          </Button>
        }
      >
        <ApiErrorNotice error={hireQ.error} what="load hire agreements" />
        {hires.length === 0 ? (
          <EmptyState title="No hire agreement yet">Allocate a fleet unit (declared use must match the policy cover) to start hire. The GTA group and daily rate come from the unit.</EmptyState>
        ) : (
          <div className="stack">
            {hires.map((h) => (
              <HireCard key={h.id} h={h} view={view} nowIso={nowIso} onEnd={() => setEnding(h)} />
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Storage"
        actions={
          <Button size="sm" onClick={() => setAddingStorage(true)}>
            Add storage
          </Button>
        }
      >
        <ApiErrorNotice error={storageQ.error} what="load storage" />
        {storageCap && (storageCap.status === 'running' || storageCap.status === 'breached') && (
          <div className="notice notice-warn" style={{ marginBottom: 12 }}>
            <strong>Report + 48 hours.</strong> Insurers commonly cap storage at the engineer’s report plus 48 hours (live File 2). Cap due <DateText value={storageCap.dueAt} time /> <ClockPill clock={storageCap} now={now} />. Send the collect-or-pay notice so further storage is the insurer’s choice.
          </div>
        )}
        {storage.length === 0 ? (
          <EmptyState title="No storage record">Rate card £45/day ex VAT. Storage ends on report issued, total loss confirmed, payment received, collection or salvage release.</EmptyState>
        ) : (
          <div className="stack">
            {storage.map((s) => (
              <StorageCard key={s.id} s={s} nowIso={nowIso} onEnd={() => setEndingStorage(s)} />
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Recovery"
        actions={
          <Button size="sm" onClick={() => setAddingRecovery(true)}>
            Add recovery
          </Button>
        }
      >
        <ApiErrorNotice error={recoveryQ.error} what="load recovery" />
        {recovery.length === 0 ? (
          <EmptyState title="No recovery record">Rate card £90 call-out + £3 per loaded mile + £25 admin, ex VAT. Recording a recovery writes the claimed amount to the ledger.</EmptyState>
        ) : (
          <div className="stack">
            {recovery.map((r) => (
              <RecoveryCard key={r.id} r={r} />
            ))}
          </div>
        )}
      </Card>

      <EndHireDialog claimId={claimId} hire={ending} nowIso={nowIso} onClose={() => setEnding(null)} />
      <EndStorageDialog claimId={claimId} storage={endingStorage} nowIso={nowIso} onClose={() => setEndingStorage(null)} />
      <StartHireDialog claimId={claimId} view={view} open={starting} nowIso={nowIso} onClose={() => setStarting(false)} />
      <AddStorageDialog claimId={claimId} open={addingStorage} nowIso={nowIso} onClose={() => setAddingStorage(false)} />
      <AddRecoveryDialog claimId={claimId} view={view} open={addingRecovery} nowIso={nowIso} onClose={() => setAddingRecovery(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** London date the hire started (the benchmark rate is the one in force then); undefined for an unreadable start. */
function hireStartDate(startAt: string): string | undefined {
  try {
    return londonDate(startAt);
  } catch {
    return undefined;
  }
}

function HireCard({ h, view, nowIso, onEnd }: { h: HireAgreement; view: ClaimView; nowIso: string; onEnd: () => void }) {
  const running = hireRunning(h);
  // Benchmark rates in force when the hire started (knowledge base ⊕ your Settings rates); built-in table until loaded.
  const ratesQ = useGtaRates(hireStartDate(h.startAt));
  const totals = hireTotals(h, nowIso, ratesQ.data);
  const items = enforceabilityChecklist(h);
  const score = enforceabilityScore(h);
  const trigger = HIRE_TRIGGERS.find((t) => t.value === h.endTrigger);
  return (
    <section className="card service-card">
      <header className="card-header">
        <h3 className="card-title row" style={{ gap: 8 }}>
          {h.agreementNumber}
          <Badge tone={running ? 'blue' : 'grey'} dot>
            {running ? 'running' : 'ended'}
          </Badge>
          <Badge tone="grey" title={GTA_BENCHMARK_NOTE}>
            group {h.gtaGroup}
          </Badge>
          <Badge tone={score.ok === score.total ? 'green' : score.ok >= 3 ? 'amber' : 'red'} title="Enforceability checklist">
            enforceability {score.ok}/{score.total}
          </Badge>
        </h3>
        <div className="row">
          {h.documentId && (
            <Link className="btn btn-ghost btn-sm" to={`../documents/${h.documentId}`}>
              Agreement document
            </Link>
          )}
          {running && (
            <Button size="sm" variant="primary" onClick={onEnd}>
              End hire
            </Button>
          )}
        </div>
      </header>
      <div className="card-body">
        <div className="stack">
          <KeyValue
            items={[
              { label: 'Start', value: <DateText value={h.startAt} time /> },
              {
                label: 'End',
                value: h.endAt ? (
                  <span>
                    <DateText value={h.endAt} time />
                    {trigger && (
                      <div className="basis">
                        {trigger.label} — {trigger.basis}
                      </div>
                    )}
                  </span>
                ) : (
                  <span className="muted">running (costed to now)</span>
                )
              },
              { label: 'Delivered / collected', value: `${h.deliveredAt ? new Date(h.deliveredAt).toLocaleDateString('en-GB') : '—'} / ${h.collectedAt ? new Date(h.collectedAt).toLocaleDateString('en-GB') : '—'}` },
              { label: 'Odometer out / in', value: `${h.odometerOut ?? '—'} / ${h.odometerIn ?? '—'} miles` },
              {
                label: 'Daily rate (ex VAT)',
                value: (
                  <span>
                    <Money pence={h.dailyRatePence} />
                    {totals?.benchmark && (
                      <span className="basis">
                        {' '}
                        · GTA {totals.benchmark.group} {totals.benchmark.period} benchmark <Money pence={totals.benchmark.gtaDailyRatePence} />/day ({totals.benchmark.differencePence >= 0 ? '+' : ''}
                        {formatGBP(totals.benchmark.differencePence)} over the hire) <VerificationBadge verification={totals.benchmark.verification} /> — {GTA_BENCHMARK_NOTE}
                      </span>
                    )}
                  </span>
                )
              },
              { label: 'Excess', value: <span><Money pence={h.excessPence} />{h.excessWaiverDailyPence ? <span className="muted"> · waiver <Money pence={h.excessWaiverDailyPence} />/day</span> : null}</span> },
              {
                label: 'Additional drivers',
                value: h.additionalDrivers.length ? (
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {h.additionalDrivers.map((d) => (
                      <li key={d.partyId}>
                        {partyName(view, d.partyId) ?? d.partyId}
                        {d.nonStandardRisk ? <Badge tone="amber" className="small"> non-standard risk · £5.50/day capped £110 (GTA 5.4, benchmark)</Badge> : <span className="muted"> · standard risk, no charge</span>}
                        {d.evidenceIds.length ? <span className="xs muted"> · {d.evidenceIds.length} evidence</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  'None'
                )
              },
              { label: 'Signed', value: h.signedAt ? <DateText value={h.signedAt} time /> : <Badge tone="red">not signed</Badge> },
              {
                label: 'Supporting',
                value: (
                  <span className="row xs" style={{ gap: 8 }}>
                    {h.needStatementEvidenceId ? <a href={api.evidenceFileUrl(h.needStatementEvidenceId)} target="_blank" rel="noreferrer">statement of need</a> : <span className="muted">no statement of need</span>}
                    {h.mitigationQuestionnaireDocumentId ? <Link to={`../documents/${h.mitigationQuestionnaireDocumentId}`}>mitigation questionnaire</Link> : <span className="muted">no mitigation questionnaire</span>}
                    {h.statementOfMeansDocumentId ? <Link to={`../documents/${h.statementOfMeansDocumentId}`}>statement of means</Link> : <span className="muted">no statement of means</span>}
                  </span>
                )
              }
            ]}
          />
        </div>
        <div className="stack">
          <div>
            <div className="small strong" style={{ marginBottom: 6 }}>
              Charges {running ? '(indicative, to now)' : ''}
            </div>
            {totals ? (
              <div className="totals">
                <span>Days on hire</span>
                <span className="right">{totals.days}</span>
                <span>Hire {totals.days} × {formatGBP(totals.dailyRatePence)}</span>
                <span className="right">{formatGBP(totals.hirePence)}</span>
                {totals.additionalDriverPence > 0 && (
                  <>
                    <span>Additional drivers</span>
                    <span className="right">{formatGBP(totals.additionalDriverPence)}</span>
                  </>
                )}
                {totals.excessWaiverPence > 0 && (
                  <>
                    <span>Excess waiver</span>
                    <span className="right">{formatGBP(totals.excessWaiverPence)}</span>
                  </>
                )}
                <span>Net</span>
                <span className="right">{formatGBP(totals.netPence)}</span>
                <span>VAT {Math.round(totals.vatRate * 100)}%</span>
                <span className="right">{formatGBP(totals.vatPence)}</span>
                <span className="total-line">Gross</span>
                <span className="right total-line">{formatGBP(totals.grossPence)}</span>
              </div>
            ) : (
              <span className="small muted">Charges cannot be computed for this agreement.</span>
            )}
            <div className="basis" style={{ marginTop: 6 }}>
              {HIRE_DAY_CONVENTION} The invoice renders from the ledger figure, not from this card.
            </div>
            {totals?.warnings.map((w) => (
              <div key={w} className="notice notice-warn xs" style={{ marginTop: 6 }}>
                {w}
              </div>
            ))}
          </div>
          <div>
            <div className="small strong" style={{ marginBottom: 6 }}>
              Enforceability checklist
            </div>
            <ul className="checklist">
              {items.map((i) => (
                <li key={i.key}>
                  <span className={`tick ${i.ok ? 'ok' : 'no'}`} aria-label={i.ok ? 'done' : 'missing'}>
                    {i.ok ? '✓' : '!'}
                  </span>
                  <span>
                    <div>
                      {i.label}
                      {i.at ? (
                        <span className="muted">
                          {' '}
                          · <DateText value={i.at} time />
                        </span>
                      ) : i.key !== 'cca60f' ? (
                        <span className="muted"> · not recorded</span>
                      ) : null}
                    </div>
                    <div className="basis">{i.basis}</div>
                  </span>
                </li>
              ))}
            </ul>
            {h.enforceability.notes && <p className="xs muted" style={{ marginTop: 6 }}>{h.enforceability.notes}</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

function StorageCard({ s, nowIso, onEnd }: { s: StorageRecord; nowIso: string; onEnd: () => void }) {
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

function RecoveryCard({ r }: { r: RecoveryRecord }) {
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

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function EndHireDialog({ claimId, hire, nowIso, onClose }: { claimId: string; hire: HireAgreement | null; nowIso: string; onClose: () => void }) {
  const [form, setForm] = useState<EndHireForm>({ endTrigger: '', endAt: nowIso, collectedAt: '', odometerIn: '', reason: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const end = useEndHire(claimId);
  const toast = useToast();
  const trigger = HIRE_TRIGGERS.find((t) => t.value === form.endTrigger);
  const close = () => {
    setForm({ endTrigger: '', endAt: nowIso, collectedAt: '', odometerIn: '', reason: '' });
    setErrors({});
    end.reset();
    onClose();
  };
  const submit = () => {
    if (!hire) return;
    const r = endHireBodyFrom(form, hire, new Date().toISOString());
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    end.mutate(
      { hireId: hire.id, body: r.body },
      {
        onSuccess: () => {
          toast.success(`Hire ${hire.agreementNumber} ended — ${triggerLabel(HIRE_TRIGGERS, r.body.endTrigger)}`);
          close();
        }
      }
    );
  };
  return (
    <Modal
      open={hire !== null}
      title={`End hire ${hire?.agreementNumber ?? ''}`}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={end.isPending} onClick={submit}>
            End hire
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Select<HireEndTrigger> label="What ended the hire" required value={form.endTrigger} onChange={(v) => setForm((f) => ({ ...f, endTrigger: v }))} options={HIRE_TRIGGERS.map((t) => ({ value: t.value, label: t.label }))} placeholder="Choose the trigger…" error={errors.endTrigger} autoFocus />
        {trigger && <div className="notice notice-info xs">{trigger.basis}</div>}
        <DateTimeInput label="Hire ended at" required value={form.endAt} onChange={(v) => setForm((f) => ({ ...f, endAt: v }))} error={errors.endAt} />
        <div className="form-grid">
          <DateTimeInput label="Vehicle collected at" value={form.collectedAt} onChange={(v) => setForm((f) => ({ ...f, collectedAt: v }))} />
          <TextInput label="Odometer in (miles)" value={form.odometerIn} onChange={(v) => setForm((f) => ({ ...f, odometerIn: v }))} inputMode="numeric" error={errors.odometerIn} hint="Photograph it: the use gate needs delivery and collection readings" />
        </div>
        <TextArea label={form.endTrigger === 'manual' ? 'Reason (required)' : 'Note for the chronology'} value={form.reason} onChange={(v) => setForm((f) => ({ ...f, reason: v }))} rows={2} error={errors.reason} required={form.endTrigger === 'manual'} />
        <ApiErrorNotice error={end.error} what="end the hire" />
      </form>
    </Modal>
  );
}

function EndStorageDialog({ claimId, storage, nowIso, onClose }: { claimId: string; storage: StorageRecord | null; nowIso: string; onClose: () => void }) {
  const [form, setForm] = useState<EndStorageForm>({ endTrigger: '', endAt: nowIso, reason: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const end = useEndStorage(claimId);
  const toast = useToast();
  const trigger = STORAGE_TRIGGERS.find((t) => t.value === form.endTrigger);
  const close = () => {
    setForm({ endTrigger: '', endAt: nowIso, reason: '' });
    setErrors({});
    end.reset();
    onClose();
  };
  const submit = () => {
    if (!storage) return;
    const r = endStorageBodyFrom(form, storage, new Date().toISOString());
    if (!r.ok) return setErrors(r.errors);
    end.mutate(
      { storageId: storage.id, body: r.body },
      {
        onSuccess: () => {
          toast.success('Storage ended');
          close();
        }
      }
    );
  };
  return (
    <Modal
      open={storage !== null}
      title={`End storage at ${storage?.location ?? ''}`}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={end.isPending} onClick={submit}>
            End storage
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Select<StorageEndTrigger> label="What ended the storage" required value={form.endTrigger} onChange={(v) => setForm((f) => ({ ...f, endTrigger: v }))} options={STORAGE_TRIGGERS.map((t) => ({ value: t.value, label: t.label }))} placeholder="Choose the trigger…" error={errors.endTrigger} autoFocus />
        {trigger && <div className="notice notice-info xs">{trigger.basis}</div>}
        <DateTimeInput label="Storage ended at" required value={form.endAt} onChange={(v) => setForm((f) => ({ ...f, endAt: v }))} error={errors.endAt} />
        <TextArea label={form.endTrigger === 'manual' ? 'Reason (required)' : 'Note'} value={form.reason} onChange={(v) => setForm((f) => ({ ...f, reason: v }))} rows={2} error={errors.reason} />
        <ApiErrorNotice error={end.error} what="end the storage" />
      </form>
    </Modal>
  );
}

const USE_OPTIONS: Array<{ value: FleetUse; label: string }> = [
  { value: 'credit_hire', label: 'Credit hire' },
  { value: 'self_drive', label: 'Self-drive hire' },
  { value: 'pco', label: 'PCO / private hire' }
];

interface StartHireForm {
  fleetUnitId: string;
  use: FleetUse;
  startAt: string;
  dailyRatePence: Pence | null;
  gtaGroup: string;
  excessPence: Pence | null;
  excessWaiverDailyPence: Pence | null;
  deliveredAt: string;
  odometerOut: string;
  signedAt: string;
  cancellationInfoProvidedAt: string;
  schedule3FormProvidedAt: string;
  expressRequestToStartAt: string;
  cca60fCompliant: boolean;
  needStatementEvidenceId: string;
  overrideReason: string;
}

function StartHireDialog({ claimId, view, open, nowIso, onClose }: { claimId: string; view: ClaimView; open: boolean; nowIso: string; onClose: () => void }) {
  const fleet = useFleet();
  const post = usePostHire(claimId);
  const toast = useToast();
  const empty = (): StartHireForm => ({
    fleetUnitId: '',
    use: 'credit_hire',
    startAt: nowIso,
    dailyRatePence: null,
    gtaGroup: '',
    excessPence: 0,
    excessWaiverDailyPence: null,
    deliveredAt: '',
    odometerOut: '',
    signedAt: '',
    cancellationInfoProvidedAt: '',
    schedule3FormProvidedAt: '',
    expressRequestToStartAt: '',
    cca60fCompliant: false,
    needStatementEvidenceId: '',
    overrideReason: ''
  });
  const [form, setForm] = useState<StartHireForm>(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const units = (fleet.data ?? []).filter((u) => u.status !== 'disposed');
  const unit = units.find((u) => u.id === form.fleetUnitId);
  const close = () => {
    setForm(empty());
    setErrors({});
    post.reset();
    onClose();
  };
  const pickUnit = (id: string) => {
    const u = units.find((x) => x.id === id);
    setForm((f) => ({ ...f, fleetUnitId: id, dailyRatePence: u ? u.dailyRatePence : f.dailyRatePence, gtaGroup: u ? u.gtaGroup : f.gtaGroup }));
  };
  const submit = () => {
    const errs: Record<string, string> = {};
    if (!form.fleetUnitId) errs.fleetUnitId = 'Choose the fleet unit';
    if (!form.startAt) errs.startAt = 'When does hire start?';
    if (form.dailyRatePence === null || form.dailyRatePence <= 0) errs.dailyRatePence = 'Daily rate in pounds (ex VAT)';
    const odo = form.odometerOut.trim() === '' ? undefined : Number(form.odometerOut);
    if (odo !== undefined && (!Number.isInteger(odo) || odo < 0)) errs.odometerOut = 'Whole miles';
    if (Object.keys(errs).length) return setErrors(errs);
    setErrors({});
    const body: Partial<HireAgreement> & { use: FleetUse; overrideAllocation?: { reason: string } } = {
      fleetUnitId: form.fleetUnitId,
      use: form.use,
      startAt: form.startAt,
      dailyRatePence: form.dailyRatePence as Pence,
      gtaGroup: form.gtaGroup || undefined,
      excessPence: form.excessPence ?? 0,
      excessWaiverDailyPence: form.excessWaiverDailyPence ?? undefined,
      deliveredAt: form.deliveredAt || undefined,
      odometerOut: odo,
      signedAt: form.signedAt || undefined,
      enforceability: {
        cancellationInfoProvidedAt: form.cancellationInfoProvidedAt || undefined,
        schedule3FormProvidedAt: form.schedule3FormProvidedAt || undefined,
        expressRequestToStartAt: form.expressRequestToStartAt || undefined,
        cca60fCompliant: form.cca60fCompliant
      },
      needStatementEvidenceId: form.needStatementEvidenceId || undefined,
      overrideAllocation: form.overrideReason.trim() ? { reason: form.overrideReason.trim() } : undefined
    };
    post.mutate(body, {
      onSuccess: () => {
        toast.success('Hire started — NCAF and off-hire clocks derive from the chronology');
        close();
      }
    });
  };
  return (
    <Modal
      open={open}
      title="Start hire"
      size="lg"
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={post.isPending} onClick={submit}>
            Start hire
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <ApiErrorNotice error={fleet.error} what="load the fleet" />
        <div className="form-grid">
          <Select
            label="Fleet unit"
            required
            value={form.fleetUnitId}
            onChange={pickUnit}
            options={units.map((u) => ({ value: u.id, label: `${u.registration ?? u.vehicle?.registration ?? u.id} · group ${u.gtaGroup} · ${u.status.replace(/_/g, ' ')} · ${u.declaredUses.join('/')}`, disabled: u.status === 'on_hire' || u.status === 'off_road' }))}
            placeholder={fleet.isLoading ? 'Loading fleet…' : 'Choose a unit'}
            error={errors.fleetUnitId}
            autoFocus
          />
          <Select<FleetUse> label="Class of use" required value={form.use} onChange={(v) => v && setForm((f) => ({ ...f, use: v }))} options={USE_OPTIONS} hint={unit && !unit.declaredUses.includes(form.use) ? 'This unit is not declared for that use — the API will refuse the allocation (Collingwood: credit hire and self-drive are not covered together).' : 'Must match the unit’s declared use and policy cover'} />
          <DateTimeInput label="Hire starts" required value={form.startAt} onChange={(v) => setForm((f) => ({ ...f, startAt: v }))} error={errors.startAt} />
          <MoneyInput label="Daily rate (£ ex VAT)" required value={form.dailyRatePence} onChange={(v) => setForm((f) => ({ ...f, dailyRatePence: v }))} error={errors.dailyRatePence} hint={`GTA group ${form.gtaGroup || '—'} is the ${GTA_BENCHMARK_NOTE}`} />
          <MoneyInput label="Excess (£)" value={form.excessPence} onChange={(v) => setForm((f) => ({ ...f, excessPence: v }))} />
          <MoneyInput label="Excess waiver (£/day)" value={form.excessWaiverDailyPence} onChange={(v) => setForm((f) => ({ ...f, excessWaiverDailyPence: v }))} />
          <DateTimeInput label="Delivered at" value={form.deliveredAt} onChange={(v) => setForm((f) => ({ ...f, deliveredAt: v }))} />
          <TextInput label="Odometer out (miles)" value={form.odometerOut} onChange={(v) => setForm((f) => ({ ...f, odometerOut: v }))} inputMode="numeric" error={errors.odometerOut} />
        </div>
        <fieldset className="fieldset">
          <legend>Enforceability (CCR 2013; CCA 1974 / RAO art 60F)</legend>
          <div className="form-grid">
            <DateTimeInput label="Cancellation information given (Sch 2)" value={form.cancellationInfoProvidedAt} onChange={(v) => setForm((f) => ({ ...f, cancellationInfoProvidedAt: v }))} />
            <DateTimeInput label="Cancellation form given (Sch 3)" value={form.schedule3FormProvidedAt} onChange={(v) => setForm((f) => ({ ...f, schedule3FormProvidedAt: v }))} />
            <DateTimeInput label="Express request to start (reg 36)" value={form.expressRequestToStartAt} onChange={(v) => setForm((f) => ({ ...f, expressRequestToStartAt: v }))} />
            <DateTimeInput label="Agreement signed at" value={form.signedAt} onChange={(v) => setForm((f) => ({ ...f, signedAt: v }))} />
            <div className="span-2">
              <Checkbox label="Art 60F exempt: 12 or fewer payments within 12 months, no interest or charges" checked={form.cca60fCompliant} onChange={(v) => setForm((f) => ({ ...f, cca60fCompliant: v }))} />
            </div>
          </div>
          <p className="xs muted" style={{ margin: '8px 0 0' }}>Missing items raise a HIRE_ENFORCEABILITY_GAP warning on the file (W v Veolia; Dimond v Lovell).</p>
        </fieldset>
        <EvidencePicker label="Statement of need (signed)" single evidence={view.evidence} value={form.needStatementEvidenceId ? [form.needStatementEvidenceId] : []} onChange={(ids) => setForm((f) => ({ ...f, needStatementEvidenceId: ids[0] ?? '' }))} />
        <TextInput label="Override an allocation refusal (reason, audited)" value={form.overrideReason} onChange={(v) => setForm((f) => ({ ...f, overrideReason: v }))} hint="Leave blank unless the API refused the unit for this use and a manager has approved the exception" />
        <ApiErrorNotice error={post.error} what="start the hire" />
      </form>
    </Modal>
  );
}

function AddStorageDialog({ claimId, open, nowIso, onClose }: { claimId: string; open: boolean; nowIso: string; onClose: () => void }) {
  const [form, setForm] = useState<StorageForm>({ location: '', startAt: nowIso, dailyRatePence: null });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const post = usePostStorage(claimId);
  const toast = useToast();
  const close = () => {
    setForm({ location: '', startAt: nowIso, dailyRatePence: null });
    setErrors({});
    post.reset();
    onClose();
  };
  const submit = () => {
    const r = storageBodyFrom(form);
    if (!r.ok) return setErrors(r.errors);
    post.mutate(r.body, {
      onSuccess: () => {
        toast.success('Storage started');
        close();
      }
    });
  };
  return (
    <Modal
      open={open}
      title="Add storage"
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={post.isPending} onClick={submit}>
            Start storage
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextInput label="Location" required value={form.location} onChange={(v) => setForm((f) => ({ ...f, location: v }))} error={errors.location} autoFocus placeholder="Yard name and postcode" />
        <DateTimeInput label="Storage starts" required value={form.startAt} onChange={(v) => setForm((f) => ({ ...f, startAt: v }))} error={errors.startAt} />
        <MoneyInput label="Daily rate (£ ex VAT)" value={form.dailyRatePence} onChange={(v) => setForm((f) => ({ ...f, dailyRatePence: v }))} error={errors.dailyRatePence} hint="Blank = rate card (£45/day)" />
        <ApiErrorNotice error={post.error} what="start storage" />
      </form>
    </Modal>
  );
}

function AddRecoveryDialog({ claimId, view, open, nowIso, onClose }: { claimId: string; view: ClaimView; open: boolean; nowIso: string; onClose: () => void }) {
  const [form, setForm] = useState<RecoveryForm>({ at: nowIso, fromLocation: '', toLocation: '', loadedMiles: '', evidenceIds: [] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const post = usePostRecovery(claimId);
  const toast = useToast();
  const close = () => {
    setForm({ at: nowIso, fromLocation: '', toLocation: '', loadedMiles: '', evidenceIds: [] });
    setErrors({});
    post.reset();
    onClose();
  };
  const submit = () => {
    const r = recoveryBodyFrom(form);
    if (!r.ok) return setErrors(r.errors);
    post.mutate(r.body, {
      onSuccess: () => {
        toast.success('Recovery recorded and claimed on the ledger');
        close();
      }
    });
  };
  const miles = Number(form.loadedMiles);
  const preview = Number.isFinite(miles) && miles >= 0 ? recoveryTotals({ loadedMiles: miles } as RecoveryRecord) : undefined;
  return (
    <Modal
      open={open}
      title="Add recovery"
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={post.isPending} onClick={submit}>
            Record recovery
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <DateTimeInput label="Recovered at" required value={form.at} onChange={(v) => setForm((f) => ({ ...f, at: v }))} error={errors.at} />
        <div className="form-grid">
          <TextInput label="From" required value={form.fromLocation} onChange={(v) => setForm((f) => ({ ...f, fromLocation: v }))} error={errors.fromLocation} autoFocus />
          <TextInput label="To" required value={form.toLocation} onChange={(v) => setForm((f) => ({ ...f, toLocation: v }))} error={errors.toLocation} />
        </div>
        <TextInput label="Loaded miles" required value={form.loadedMiles} onChange={(v) => setForm((f) => ({ ...f, loadedMiles: v }))} inputMode="decimal" error={errors.loadedMiles} hint={preview ? `Rate card: ${formatGBP(preview.netPence)} net, ${formatGBP(preview.grossPence)} gross (£90 + £3/mile + £25 + VAT)` : undefined} />
        <EvidencePicker label="Recovery sheet / photos" evidence={view.evidence} value={form.evidenceIds} onChange={(ids) => setForm((f) => ({ ...f, evidenceIds: ids }))} />
        <ApiErrorNotice error={post.error} what="record the recovery" />
      </form>
    </Modal>
  );
}
