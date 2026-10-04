import { useState } from 'react';
import type { SalvageCategory, TotalLossAssessment, TotalLossPrediction } from '@ccguk/domain';
import { formatGBP, salvageCategories, TL_PREDICTOR_CALIBRATION_NOTE } from '@ccguk/domain';
import { useAssessTotalLoss, usePredictTotalLoss } from '../../../../api/hooks';
import { Card } from '../../../../components/Card';
import { Badge } from '../../../../components/Badge';
import { Button } from '../../../../components/Button';
import { KeyValue } from '../../../../components/KeyValue';
import { Money } from '../../../../components/Money';
import { Checkbox, MoneyInput, Select, TextInput, YesNo } from '../../../../components/Form';
import { EmptyState } from '../../../../components/EmptyState';
import { ApiErrorNotice } from '../../../../components/ApiErrorNotice';
import { useToast } from '../../../../components/Toast';
import type { ClaimView } from '../../claimFile';
import { DAMAGE_ZONES, emptyPredictorForm, predictorBodyFrom, SALVAGE_OPTIONS, STRUCTURAL_INDICATORS, totalLossAssessBodyFrom, type PredictorForm, type TotalLossAssessForm } from '../../lib/engineering';

const DECISION_TONE: Record<TotalLossAssessment['decision'], 'green' | 'red' | 'amber'> = { repair: 'green', total_loss: 'red', borderline: 'amber' };
const BAND_TONE: Record<TotalLossPrediction['band'], 'green' | 'amber' | 'red'> = { low: 'green', medium: 'amber', high: 'red' };

/** Total loss (BLUEPRINT §4.7): repair + projected hire + storage vs PAV − salvage; and the FNOL-stage predictor (§4.8). */
export function TotalLossPanel({ view }: { view: ClaimView }) {
  const claimId = view.claim.id;
  const assess = useAssessTotalLoss(claimId);
  const predict = usePredictTotalLoss(claimId);
  const toast = useToast();
  const [form, setForm] = useState<TotalLossAssessForm>({ salvagePence: view.report?.salvageValuePence ?? null, salvageSource: '', salvageCategory: view.report?.salvageCategory ?? '', repairWorkingDays: view.report?.repairDurationWorkingDays !== undefined ? String(view.report.repairDurationWorkingDays) : '' });
  const [pf, setPf] = useState<PredictorForm>(() => emptyPredictorForm(view.vehicle, view.claim.accident, new Date().getFullYear()));
  const [pfErrors, setPfErrors] = useState<Record<string, string>>({});
  const result = assess.data ?? view.report?.totalLoss;
  const activeHire = view.hire.find((h) => !h.endAt) ?? view.hire[0];
  const inputsKnown = { repair: view.estimate?.totals?.netPence, pav: view.pav?.pavPence ?? view.pav?.medianPence, hireRate: activeHire?.dailyRatePence };

  const runAssess = () => {
    assess.mutate(totalLossAssessBodyFrom(form), { onSuccess: () => toast.success('Assessed') });
  };
  const runPredict = () => {
    const r = predictorBodyFrom(pf);
    if (!r.ok) return setPfErrors(r.errors);
    setPfErrors({});
    predict.mutate(r.body);
  };
  const toggle = <T extends string>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <div className="stack">
      <div className="grid-2">
        <Card title="Inputs on file">
          <KeyValue
            items={[
              { label: 'Repair estimate (net)', value: inputsKnown.repair !== undefined ? <Money pence={inputsKnown.repair} /> : <span className="muted">no estimate saved</span> },
              { label: 'PAV', value: inputsKnown.pav !== undefined ? <Money pence={inputsKnown.pav} /> : <span className="muted">no PAV assessed</span> },
              { label: 'Hire daily rate', value: inputsKnown.hireRate !== undefined ? <span><Money pence={inputsKnown.hireRate} /> ex VAT</span> : <span className="muted">no hire agreement</span> },
              { label: 'Storage', value: view.storage.length ? `${view.storage.length} record${view.storage.length === 1 ? '' : 's'}` : <span className="muted">none</span> },
              { label: 'Repair duration (report)', value: view.report?.repairDurationWorkingDays !== undefined ? `${view.report.repairDurationWorkingDays} working days` : <span className="muted">not stated</span> }
            ]}
          />
          <div className="form-grid" style={{ marginTop: 12 }}>
            <MoneyInput label="Salvage value (£)" value={form.salvagePence} onChange={(v) => setForm((f) => ({ ...f, salvagePence: v }))} hint="Actual bid or offer — never a fixed percentage" />
            <Select label="Salvage figure is a" value={form.salvageSource} onChange={(v) => setForm((f) => ({ ...f, salvageSource: v }))} options={[{ value: 'bid', label: 'Bid received' }, { value: 'offer', label: 'Offer (CCGUK or buyer)' }, { value: 'estimate', label: 'Estimate (flagged)' }]} placeholder="—" />
            <Select<SalvageCategory> label="Salvage category (ABI Code, 28 May 2025)" value={form.salvageCategory} onChange={(v) => setForm((f) => ({ ...f, salvageCategory: v }))} options={SALVAGE_OPTIONS} placeholder="Not yet categorised" />
            <TextInput label="Projected repair (working days)" value={form.repairWorkingDays} onChange={(v) => setForm((f) => ({ ...f, repairWorkingDays: v }))} inputMode="numeric" hint="Blank = from the engineer’s report" />
          </div>
          {form.salvageCategory && (
            <div className="notice notice-info xs" style={{ marginTop: 10 }}>
              <strong>Cat {form.salvageCategory} — {salvageCategories[form.salvageCategory].name}.</strong> {salvageCategories[form.salvageCategory].description}
              {(view.vehicle.fuelType === 'electric' || view.vehicle.fuelType === 'hybrid' || view.vehicle.fuelType === 'plugin_hybrid') && <div>EV: {salvageCategories[form.salvageCategory].evNote}</div>}
            </div>
          )}
          <div className="form-actions">
            <span className="hint">Categorisation is by an Appropriately Qualified Person and is based on structural vs non-structural damage, not cost.</span>
            <Button variant="primary" loading={assess.isPending} onClick={runAssess}>
              Assess
            </Button>
          </div>
          <ApiErrorNotice error={assess.error} what="assess total loss" />
        </Card>

        <Card title={<span className="row">Decision {result && <Badge tone={DECISION_TONE[result.decision]} dot>{result.decision.replace(/_/g, ' ')}</Badge>}</span>}>
          {!result ? (
            <EmptyState title="Not assessed">Repair route = repair + projected hire + storage. Total-loss route = PAV − salvage (+ hire to payment). Borderline within 10%.</EmptyState>
          ) : (
            <div className="stack">
              <div className="grid-2">
                <div className={`notice ${result.decision === 'repair' ? 'notice-success' : ''}`}>
                  <div className="small strong">Repair route</div>
                  <div className="totals" style={{ marginTop: 6 }}>
                    <span>Repair (net)</span>
                    <span className="right">{formatGBP(result.repairNetPence)}</span>
                    <span>
                      Hire {result.projectedHireDays} d × {formatGBP(result.hireDailyRatePence)}
                    </span>
                    <span className="right">{formatGBP(result.projectedHirePence)}</span>
                    <span>Storage</span>
                    <span className="right">{formatGBP(result.projectedStoragePence)}</span>
                    <span className="total-line">Total</span>
                    <span className="right total-line">{formatGBP(result.repairRouteCostPence)}</span>
                  </div>
                  <div className="xs muted" style={{ marginTop: 4 }}>
                    {result.projectedRepairWorkingDays} working days of repair
                  </div>
                </div>
                <div className={`notice ${result.decision === 'total_loss' ? 'notice-danger' : ''}`}>
                  <div className="small strong">Total-loss route</div>
                  <div className="totals" style={{ marginTop: 6 }}>
                    <span>PAV</span>
                    <span className="right">{formatGBP(result.pavPence)}</span>
                    <span>
                      − Salvage ({result.salvageSource}
                      {result.salvageCategory ? `, Cat ${result.salvageCategory}` : ''})
                    </span>
                    <span className="right">−{formatGBP(result.salvagePence)}</span>
                    <span className="total-line">Total</span>
                    <span className="right total-line">{formatGBP(result.totalLossRouteCostPence)}</span>
                  </div>
                </div>
              </div>
              <div className="small">
                Margin: <strong>{formatGBP(result.marginPence)}</strong>{' '}
                {result.decision === 'borderline' && <span className="muted">— borderline: the routes are within 10% of each other; the insurer’s commercial decision could go either way, so hold storage and hire evidence tight.</span>}
              </div>
              {result.notes.length > 0 && (
                <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                  {result.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Card>
      </div>

      <Card title="First-notification total-loss predictor" actions={<Badge tone="amber">uncalibrated — rules first</Badge>}>
        <p className="small muted">A logistic score on age, PAV band, damage zones, airbag deployment, structural indicators and driveability. {TL_PREDICTOR_CALIBRATION_NOTE} Use it to choose the hire car and the storage plan at FNOL, not as evidence.</p>
        <div className="form-grid">
          <TextInput label="Vehicle age (years)" required value={pf.vehicleAgeYears} onChange={(v) => setPf((f) => ({ ...f, vehicleAgeYears: v }))} inputMode="numeric" error={pfErrors.vehicleAgeYears} />
          <MoneyInput label="Rough PAV (£)" required value={pf.pavBandPence} onChange={(v) => setPf((f) => ({ ...f, pavBandPence: v }))} error={pfErrors.pavBandPence} />
          <MoneyInput label="Rough repair (£, if known)" value={pf.roughRepairPence} onChange={(v) => setPf((f) => ({ ...f, roughRepairPence: v }))} />
          <div className="field">
            <span className="field-label">Damage zones</span>
            <div className="check-grid">
              {DAMAGE_ZONES.map((z) => (
                <Checkbox key={z.value} label={z.label} checked={pf.damageZones.includes(z.value)} onChange={() => setPf((f) => ({ ...f, damageZones: toggle(f.damageZones, z.value) }))} />
              ))}
            </div>
            {pfErrors.damageZones && <div className="field-error">{pfErrors.damageZones}</div>}
          </div>
          <div className="field">
            <span className="field-label">Structural indicators</span>
            <div className="check-grid">
              {STRUCTURAL_INDICATORS.filter((s) => s.value !== 'none').map((s) => (
                <Checkbox key={s.value} label={s.label} checked={pf.structuralIndicators.includes(s.value)} onChange={() => setPf((f) => ({ ...f, structuralIndicators: toggle(f.structuralIndicators, s.value) }))} />
              ))}
            </div>
          </div>
          <YesNo label="Airbags deployed?" required value={pf.airbagsDeployed} onChange={(v) => setPf((f) => ({ ...f, airbagsDeployed: v }))} error={pfErrors.airbagsDeployed} />
          <YesNo label="Driveable?" required value={pf.driveable} onChange={(v) => setPf((f) => ({ ...f, driveable: v }))} error={pfErrors.driveable} />
          <YesNo label="Fluid leaks?" value={pf.fluidLeaks} onChange={(v) => setPf((f) => ({ ...f, fluidLeaks: v }))} />
          <Checkbox label="EV or hybrid (battery / high-voltage risk)" checked={pf.isEvOrHybrid} onChange={(v) => setPf((f) => ({ ...f, isEvOrHybrid: v }))} />
        </div>
        <div className="form-actions">
          <Button variant="primary" loading={predict.isPending} onClick={runPredict}>
            Predict
          </Button>
        </div>
        <ApiErrorNotice error={predict.error} what="run the predictor" />
        {predict.data && (
          <div className="stack" style={{ marginTop: 12 }}>
            <div className="row">
              <span className="stat-value">{Math.round(predict.data.probability * 100)}%</span>
              <Badge tone={BAND_TONE[predict.data.band]} dot>
                {predict.data.band} likelihood of total loss
              </Badge>
              {!predict.data.calibrated && <Badge tone="amber">not calibrated (&lt;100 outcomes)</Badge>}
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Factor</th>
                  <th className="num">Weight</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {predict.data.factors.map((f) => (
                  <tr key={f.factor}>
                    <td>{f.factor}</td>
                    <td className="num">{f.weight.toFixed(2)}</td>
                    <td className="wrap">{f.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
