import { useEffect, useState } from 'react';
import type { Comparable, FuelType, PavAssessment, SalvageCategory, Transmission } from '@ccguk/domain';
import { formatGBP } from '@ccguk/domain';
import { api } from '../../../../api/client';
import { useAddComparable, useApprovePav, useAssessPav, usePav, usePostPav } from '../../../../api/hooks';
import { Card } from '../../../../components/Card';
import { Table, type Column } from '../../../../components/Table';
import { Badge } from '../../../../components/Badge';
import { Button } from '../../../../components/Button';
import { Modal } from '../../../../components/Modal';
import { KeyValue } from '../../../../components/KeyValue';
import { DateText } from '../../../../components/DateText';
import { Money } from '../../../../components/Money';
import { Checkbox, DateTimeInput, MoneyInput, Select, TextInput } from '../../../../components/Form';
import { EmptyState } from '../../../../components/EmptyState';
import { Loading } from '../../../../components/Spinner';
import { ApiErrorNotice } from '../../../../components/ApiErrorNotice';
import { useToast } from '../../../../components/Toast';
import type { ClaimView } from '../../claimFile';
import { EvidencePicker } from '../../components/EvidencePicker';
import { comparableBodyFrom, comparableStats, CONDITION_OPTIONS, emptyComparableForm, FUEL_OPTIONS, PAV_MIN_COMPARABLES, SALVAGE_OPTIONS, SELLER_OPTIONS, SERVICE_HISTORY_OPTIONS, subjectFormFrom, subjectFrom, TRANSMISSION_OPTIONS, type ComparableForm, type SubjectForm } from '../../lib/engineering';

/** PAV workbench (BLUEPRINT §4.3–4.4): subject, hand-captured comparables, assess, approve. Adverts are never scraped. */
export function PavWorkbench({ view }: { view: ClaimView }) {
  const claimId = view.claim.id;
  const pavQ = usePav(claimId);
  const pav: PavAssessment | null = pavQ.data ?? view.pav ?? null;
  const [subject, setSubject] = useState<SubjectForm>(() => subjectFormFrom(pav, view.vehicle, view.claimant.address?.postcode));
  const [subjectErrors, setSubjectErrors] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [approver, setApprover] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [pavOverride, setPavOverride] = useState<number | null>(null);
  const postPav = usePostPav(claimId);
  const assess = useAssessPav(claimId);
  const approvePav = useApprovePav(claimId);
  const toast = useToast();

  const stamp = pav ? `${pav.id}:${pav.createdAt}` : 'none';
  useEffect(() => {
    setSubject(subjectFormFrom(pav, view.vehicle, view.claimant.address?.postcode));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);

  const result: PavAssessment | null = assess.data ?? pav;
  const stats = result ? comparableStats(result) : { total: 0, used: 0, excluded: 0 };
  const enough = stats.used >= PAV_MIN_COMPARABLES;

  const saveSubject = () => {
    const r = subjectFrom(subject, view.vehicle);
    if (!r.ok) return setSubjectErrors(r.errors);
    setSubjectErrors({});
    // POST /claims/:id/pav creates a new assessment from the subject and the comparables it is given, so the
    // current comparables are re-sent (the API re-runs normalisation and exclusions; computed fields are dropped).
    const comparables = (pav?.comparables ?? []).map(({ normalisedPricePence: _n, excluded: _e, exclusionReason: _r, ...c }) => c);
    postPav.mutate({ subject: r.body, ...(comparables.length ? { comparables } : {}) }, { onSuccess: () => toast.success('Subject saved') });
  };

  /**
   * Approval goes through POST /claims/:id/pav/:pid/approve (the approver is the signed-in user; the API needs
   * at least three retained comparables). A departure from the median is first re-assessed with
   * `override: { pavPence, reason }` — the reason is audited — and that new assessment is the one approved.
   */
  const approve = () => {
    if (!result || approver.trim().length < 2) return;
    const done = () => toast.success('PAV approved — the report and the PAV challenge letter render from this figure');
    if (pavOverride !== null && pavOverride !== result.medianPence) {
      if (overrideReason.trim().length < 5) return toast.error('Give the reason for departing from the median');
      assess.mutate({ override: { pavPence: pavOverride, reason: `${overrideReason.trim()} (approver: ${approver.trim()})` } }, { onSuccess: (p) => approvePav.mutate(p.id, { onSuccess: done }) });
      return;
    }
    approvePav.mutate(result.id, { onSuccess: done });
  };

  const columns: Column<Comparable>[] = [
    {
      key: 'source',
      header: 'Advert',
      className: 'wrap',
      render: (c) => (
        <div>
          <div className="strong">{c.source}</div>
          <div className="xs">
            {c.url && (
              <a href={c.url} target="_blank" rel="noreferrer">
                link
              </a>
            )}
            {c.evidenceId && (
              <>
                {' '}
                ·{' '}
                <a href={api.evidenceFileUrl(c.evidenceId)} target="_blank" rel="noreferrer">
                  saved copy
                </a>
              </>
            )}
            {' '}· captured <DateText value={c.capturedAt} time />
          </div>
        </div>
      )
    },
    { key: 'vehicle', header: 'Vehicle', className: 'wrap', render: (c) => `${c.year} ${c.make} ${c.model}${c.trim ? ` ${c.trim}` : ''}${c.fuelType ? ` · ${c.fuelType}` : ''}${c.transmission ? ` · ${c.transmission}` : ''}` },
    { key: 'price', header: 'Price', numeric: true, render: (c) => (c.priceOnApplication ? <Badge tone="grey">POA</Badge> : <Money pence={c.pricePence} showPence={false} />) },
    { key: 'mileage', header: 'Mileage', numeric: true, render: (c) => c.mileage.toLocaleString('en-GB') },
    { key: 'seller', header: 'Seller', render: (c) => `${c.seller}${c.distanceMiles !== undefined ? ` · ${c.distanceMiles} mi` : ''}` },
    {
      key: 'flags',
      header: 'Flags',
      render: (c) => (
        <span className="row" style={{ gap: 4 }}>
          {c.writeOffCategory && <Badge tone="amber">Cat {c.writeOffCategory}</Badge>}
          {c.exFleet && <Badge tone="grey">ex-fleet</Badge>}
          {c.optionsAdjustmentPence ? <Badge tone="grey">options {formatGBP(c.optionsAdjustmentPence)}</Badge> : null}
        </span>
      )
    },
    { key: 'norm', header: 'Normalised', numeric: true, render: (c) => <Money pence={c.normalisedPricePence} showPence={false} /> },
    { key: 'excl', header: 'Used', render: (c) => (c.excluded ? <span><Badge tone="red">excluded</Badge><div className="xs muted">{c.exclusionReason}</div></span> : <Badge tone="green">used</Badge>) }
  ];

  return (
    <div className="stack">
      <ApiErrorNotice error={pavQ.error} what="load the PAV assessment" />
      <div className="notice notice-info small">
        <strong>Basis.</strong> PAV is the cost of a like replacement in the retail market (Darbishire v Warran [1963] 1 WLR 1067). At least {PAV_MIN_COMPARABLES} retail adverts: same model and generation, year ±1, mileage ±25%, same fuel and transmission, within 50 miles (widened in stages). Each advert is viewed and saved by hand with URL, capture time and hash — never scraped (BLUEPRINT §4.2).
      </div>

      <div className="grid-2">
        <Card title="Subject vehicle" actions={<Button size="sm" loading={postPav.isPending} onClick={saveSubject}>Save subject</Button>}>
          <KeyValue items={[{ label: 'Vehicle', value: `${view.vehicle.registration} · ${view.vehicle.make} ${view.vehicle.model}${view.vehicle.yearOfManufacture ? ` (${view.vehicle.yearOfManufacture})` : ''}` }, { label: 'Fuel / transmission', value: [view.vehicle.fuelType, view.vehicle.transmission].filter(Boolean).join(' · ') || '—' }]} />
          {subjectErrors.year && <div className="notice notice-danger xs" style={{ margin: '8px 0' }}>{subjectErrors.year}</div>}
          <div className="form-grid" style={{ marginTop: 12 }}>
            <TextInput label="Odometer at loss (miles)" required value={subject.odometerAtLoss} onChange={(v) => setSubject((s) => ({ ...s, odometerAtLoss: v }))} inputMode="numeric" error={subjectErrors.odometerAtLoss} />
            <Select label="Odometer basis" required value={subject.odometerBasis} onChange={(v) => v && setSubject((s) => ({ ...s, odometerBasis: v }))} options={[{ value: 'reading', label: 'Actual reading' }, { value: 'projected_from_mot', label: 'Projected from MOT history (flagged)' }]} hint={subject.odometerBasis === 'projected_from_mot' ? 'Projected using the vehicle’s own MOT-derived annual mileage; stated as an assumption on the report' : undefined} />
            <TextInput label="Trim / variant" value={subject.trim} onChange={(v) => setSubject((s) => ({ ...s, trim: v }))} />
            <Select label="Condition grade (engineer)" required value={subject.conditionGrade} onChange={(v) => setSubject((s) => ({ ...s, conditionGrade: v }))} options={CONDITION_OPTIONS} placeholder="Choose…" error={subjectErrors.conditionGrade} />
            <TextInput label="Condition adjustment %" value={subject.conditionAdjustmentPct} onChange={(v) => setSubject((s) => ({ ...s, conditionAdjustmentPct: v }))} inputMode="decimal" error={subjectErrors.conditionAdjustmentPct} hint="−10 to +10, engineer’s call" />
            <Select label="Service history" value={subject.serviceHistory} onChange={(v) => setSubject((s) => ({ ...s, serviceHistory: v }))} options={SERVICE_HISTORY_OPTIONS} placeholder="—" />
            <Select<SalvageCategory> label="Previous write-off" value={subject.previousWriteOffCategory} onChange={(v) => setSubject((s) => ({ ...s, previousWriteOffCategory: v }))} options={SALVAGE_OPTIONS} placeholder="None known" />
            <TextInput label="Claimant postcode (radius)" value={subject.claimantPostcode} onChange={(v) => setSubject((s) => ({ ...s, claimantPostcode: v }))} inputClassName="input-reg" />
            <Checkbox label="Subject is ex-fleet" checked={subject.exFleet} onChange={(v) => setSubject((s) => ({ ...s, exFleet: v }))} />
            <Checkbox label="Claimant is VAT registered" checked={subject.vatRegisteredClaimant} onChange={(v) => setSubject((s) => ({ ...s, vatRegisteredClaimant: v }))} hint="VAT on the PAV is only recoverable where it is a real cost to the claimant" />
          </div>
          <ApiErrorNotice error={postPav.error} what="save the PAV" />
        </Card>

        <Card title="Assessment" actions={<Button size="sm" variant="primary" loading={assess.isPending} onClick={() => assess.mutate({}, { onSuccess: () => toast.success('Assessed — review exclusions and the reasoning before approving') })} disabled={stats.total === 0}>Assess</Button>}>
          {pavQ.isLoading && !pav ? (
            <Loading />
          ) : !result || result.medianPence === undefined || result.medianPence === 0 ? (
            <EmptyState title="Not assessed yet">Add at least {PAV_MIN_COMPARABLES} comparables, then assess. Normalisation, 1.5×IQR outliers and exclusions are computed by the API and shown here with reasons.</EmptyState>
          ) : (
            <div className="stack">
              <div className="stat-grid">
                <div className="stat">
                  <span className="stat-label">Median (PAV)</span>
                  <span className="stat-value">{formatGBP(result.medianPence, { showPence: false })}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">IQR band</span>
                  <span className="stat-value" style={{ fontSize: 'var(--fs-lg)' }}>
                    {formatGBP(result.iqrLowPence, { showPence: false })} – {formatGBP(result.iqrHighPence, { showPence: false })}
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-label">Per-mile factor</span>
                  <span className="stat-value" style={{ fontSize: 'var(--fs-lg)' }}>{(result.perMilePence / 100).toFixed(3)} £/mi</span>
                  <span className="stat-sub">{result.perMileSource === 'regression' ? 'from the comparables’ own price-to-mileage regression' : 'fallback band £0.05–£0.10/mile — flagged as an assumption'}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">Comparables</span>
                  <span className={`stat-value ${enough ? '' : 'amber'}`}>{stats.used}</span>
                  <span className="stat-sub">
                    {stats.excluded} excluded · {enough ? 'minimum met' : `need ${PAV_MIN_COMPARABLES}`}
                  </span>
                </div>
              </div>
              {result.tradeGuidePence !== undefined && (
                <div className="small">
                  Trade guide: <Money pence={result.tradeGuidePence} showPence={false} /> {result.tradeGuideSource ? `(${result.tradeGuideSource})` : ''} shown alongside, not used as the PAV.
                </div>
              )}
              {result.comparables.some((c) => c.excluded) && (
                <div>
                  <div className="small strong">Exclusions</div>
                  <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {result.comparables
                      .filter((c) => c.excluded)
                      .map((c) => (
                        <li key={c.id}>
                          {c.source} {c.year} {c.mileage.toLocaleString('en-GB')} mi — {c.exclusionReason ?? 'excluded'}
                        </li>
                      ))}
                  </ul>
                </div>
              )}
              <div>
                <div className="small strong">Reasoning (generated from the data; the engineer approves it)</div>
                <div className="reasoning">{result.reasoning || 'No reasoning paragraph returned.'}</div>
              </div>
              <div className="form-grid" style={{ alignItems: 'end' }}>
                <MoneyInput label="PAV asserted (£)" value={pavOverride ?? result.pavPence ?? result.medianPence} onChange={setPavOverride} hint="Median unless the engineer overrides with a reason" />
                <TextInput label="Override reason" value={overrideReason} onChange={setOverrideReason} disabled={pavOverride === null || pavOverride === result.medianPence} />
                <TextInput label="Approved by (engineer)" value={approver} onChange={setApprover} placeholder="Name / initials" />
                <div className="field" style={{ justifyContent: 'flex-end' }}>
                  <Button variant="primary" loading={postPav.isPending} onClick={approve} disabled={approver.trim().length < 2 || !enough} title={enough ? undefined : `Need ${PAV_MIN_COMPARABLES} usable comparables`}>
                    Approve PAV
                  </Button>
                </div>
              </div>
              {result.approvedBy && (
                <div className="notice notice-success small">
                  Approved by {result.approvedBy} <DateText value={result.approvedAt} time /> · PAV <Money pence={result.pavPence} />
                  {result.overrideReason ? ` · override: ${result.overrideReason}` : ''}
                </div>
              )}
            </div>
          )}
          <ApiErrorNotice error={assess.error} what="assess the PAV" />
        </Card>
      </div>

      <Card title={<span className="row">Comparables <Badge tone={enough ? 'green' : 'amber'}>{stats.used} usable / {stats.total}</Badge></span>} flush actions={<Button size="sm" variant="primary" onClick={() => setAdding(true)}>Add comparable</Button>}>
        <Table columns={columns} rows={result?.comparables ?? []} rowKey={(c) => c.id} caption="Comparables" empty={<EmptyState title="No comparables yet">View each advert, save it as PDF or screenshot, upload it as evidence (kind: advert, with the URL), then add it here with price, mileage, year, trim and distance.</EmptyState>} />
        <div className="card-footer xs muted">Audit trail: capture (PDF, URL, timestamp, hash), each adjustment, each exclusion and its reason, and who approved.</div>
      </Card>
      {adding && <AddComparableDialog view={view} subject={result?.subject} onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddComparableDialog({ view, subject, onClose }: { view: ClaimView; subject: PavAssessment['subject'] | undefined; onClose: () => void }) {
  const [form, setForm] = useState<ComparableForm>(() => emptyComparableForm(subject ?? { make: view.vehicle.make, model: view.vehicle.model, fuelType: view.vehicle.fuelType, transmission: view.vehicle.transmission }, new Date().toISOString()));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const add = useAddComparable(view.claim.id);
  const toast = useToast();
  const set = <K extends keyof ComparableForm>(k: K, v: ComparableForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const adverts = view.evidence.filter((e) => e.kind === 'advert' || e.kind === 'screenshot' || e.kind === 'pdf');
  const submit = () => {
    const r = comparableBodyFrom(form);
    if (!r.ok) return setErrors(r.errors);
    add.mutate(r.body, {
      onSuccess: () => {
        toast.success('Comparable added — re-assess to update the median');
        onClose();
      }
    });
  };
  return (
    <Modal
      open
      size="lg"
      title="Add comparable (manual capture)"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={add.isPending} onClick={submit}>
            Add comparable
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
        <div className="form-grid">
          <TextInput label="Advert URL" required type="url" value={form.url} onChange={(v) => set('url', v)} error={errors.url} autoFocus className="span-2" />
          <DateTimeInput label="Captured at" required value={form.capturedAt} onChange={(v) => set('capturedAt', v)} error={errors.capturedAt} />
          <TextInput label="Source" required value={form.source} onChange={(v) => set('source', v)} error={errors.source} placeholder="Auto Trader, dealer site…" />
          <MoneyInput label="Advertised price (£)" value={form.pricePence} onChange={(v) => set('pricePence', v)} error={errors.pricePence} />
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <Checkbox label="Price on application (excluded from the median)" checked={form.priceOnApplication} onChange={(v) => set('priceOnApplication', v)} />
          </div>
          <TextInput label="Mileage" required value={form.mileage} onChange={(v) => set('mileage', v)} inputMode="numeric" error={errors.mileage} />
          <TextInput label="Year" required value={form.year} onChange={(v) => set('year', v)} inputMode="numeric" error={errors.year} />
          <TextInput label="Make" required value={form.make} onChange={(v) => set('make', v)} error={errors.make} />
          <TextInput label="Model" required value={form.model} onChange={(v) => set('model', v)} error={errors.model} />
          <TextInput label="Trim" value={form.trim} onChange={(v) => set('trim', v)} />
          <Select<FuelType> label="Fuel" value={form.fuelType} onChange={(v) => set('fuelType', v)} options={FUEL_OPTIONS} placeholder="—" />
          <Select<Transmission> label="Transmission" value={form.transmission} onChange={(v) => set('transmission', v)} options={TRANSMISSION_OPTIONS} placeholder="—" />
          <Select label="Seller" required value={form.seller} onChange={(v) => set('seller', v)} options={SELLER_OPTIONS} error={errors.seller} />
          <TextInput label="Distance from claimant (miles)" value={form.distanceMiles} onChange={(v) => set('distanceMiles', v)} inputMode="numeric" error={errors.distanceMiles} />
          <Select<SalvageCategory> label="Write-off category" value={form.writeOffCategory} onChange={(v) => set('writeOffCategory', v)} options={SALVAGE_OPTIONS} placeholder="None stated" hint="Cat S/N adverts are excluded" />
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <Checkbox label="Ex-fleet" checked={form.exFleet} onChange={(v) => set('exFleet', v)} hint="Excluded unless the subject is ex-fleet" />
          </div>
          <MoneyInput label="Options adjustment (£, ± to match the subject)" value={form.optionsAdjustmentPence} onChange={(v) => set('optionsAdjustmentPence', v)} allowNegative />
        </div>
        <EvidencePicker label="Saved advert (PDF / screenshot) — required" single evidence={adverts} value={form.evidenceId ? [form.evidenceId] : []} onChange={(ids) => set('evidenceId', ids[0] ?? '')} error={errors.evidenceId} hint="Upload the advert on the Evidence tab (kind: advert) first" />
        <ApiErrorNotice error={add.error} what="add the comparable" />
      </form>
    </Modal>
  );
}
