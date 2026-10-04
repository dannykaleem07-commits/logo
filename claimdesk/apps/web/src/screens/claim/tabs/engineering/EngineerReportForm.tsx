import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { EngineerReport, SalvageCategory } from '@ccguk/domain';
import { SMALL_CLAIMS_EXPERT_FEE_CAP_PENCE, formatGBP } from '@ccguk/domain';
import { useEngineerReport, useIssueEngineerReport, useParties, useSaveEngineerReport } from '../../../../api/hooks';
import { Card } from '../../../../components/Card';
import { Badge } from '../../../../components/Badge';
import { Button } from '../../../../components/Button';
import { DateText } from '../../../../components/DateText';
import { Checkbox, DateTimeInput, MoneyInput, Select, TextArea, TextInput, YesNo } from '../../../../components/Form';
import { EmptyState } from '../../../../components/EmptyState';
import { Loading } from '../../../../components/Spinner';
import { ApiErrorNotice } from '../../../../components/ApiErrorNotice';
import { useToast } from '../../../../components/Toast';
import type { ClaimView } from '../../claimFile';
import { EvidencePicker } from '../../components/EvidencePicker';
import { reportBodyFrom, reportChecklist, reportFormFrom, SALVAGE_OPTIONS, unwrapReport, type ReportForm } from '../../lib/engineering';

/** Engineer's report (BLUEPRINT §4.6): every field, the forCourt toggle (CPR 35 / PD 35) and the API checklist of missing items. */
export function EngineerReportForm({ view }: { view: ClaimView }) {
  const claimId = view.claim.id;
  const reportQ = useEngineerReport(claimId);
  const unwrapped = unwrapReport(reportQ.data);
  const report: EngineerReport | null = unwrapped.report ?? view.report ?? null;
  const [form, setForm] = useState<ReportForm>(() => reportFormFrom(report));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const save = useSaveEngineerReport(claimId);
  const issue = useIssueEngineerReport(claimId);
  const engineers = useParties({ role: 'engineer', limit: 100 });
  const navigate = useNavigate();
  const toast = useToast();

  const stamp = report ? `${report.id}:${report.issuedAt ?? ''}:${report.feePence}` : 'none';
  useEffect(() => {
    if (dirty) return;
    setForm(reportFormFrom(report));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);

  const set = <K extends keyof ReportForm>(k: K, v: ReportForm[K]) => {
    setDirty(true);
    setForm((f) => ({ ...f, [k]: v }));
  };
  const isEv = view.vehicle.fuelType === 'electric' || view.vehicle.fuelType === 'hybrid' || view.vehicle.fuelType === 'plugin_hybrid';
  const checklist = reportChecklist(report, unwrapped.checklist, { track: view.claim.track, isEvOrHybrid: isEv, vehicle: view.vehicle });
  const smallClaims = view.claim.track === 'small_claims';

  const submit = () => {
    const r = reportBodyFrom(form, { vehicleId: view.vehicle.id, estimateId: view.estimate?.id, pavAssessmentId: view.pav?.id });
    if (!r.ok) {
      setErrors(r.errors);
      toast.error('Some required fields are missing');
      return;
    }
    setErrors({});
    // An unissued report is edited in place (PATCH); after issue a save starts a supplementary report (POST).
    save.mutate(
      { body: r.body, reportId: report && !report.issuedAt ? report.id : undefined },
      {
        onSuccess: () => {
          setDirty(false);
          toast.success('Report saved — checklist re-evaluated');
        }
      }
    );
  };

  /** Issue = the report_issued event (storage/off-hire triggers) plus the report.engineer draft, in one API call. */
  const generate = () => {
    if (!report) return;
    issue.mutate(
      { reportId: report.id },
      {
        onSuccess: (res) => {
          if (res.document?.id) {
            toast.success('Report issued and drafted — review the consistency report before approval');
            navigate(`/claims/${claimId}/documents/${res.document.id}`);
          } else {
            toast.warn(`Report issued. ${res.documentNote ?? 'Draft the report.engineer document from the Documents tab.'}`);
          }
        }
      }
    );
  };

  const engineerOptions = (engineers.data ?? []).map((p) => ({ value: p.id, label: p.name }));
  if (form.engineerPartyId && !engineerOptions.some((o) => o.value === form.engineerPartyId)) engineerOptions.push({ value: form.engineerPartyId, label: form.engineerPartyId });
  const canGenerate = Boolean(report) && !dirty && (checklist?.ok ?? false);

  return (
    <div className="stack">
      <ApiErrorNotice error={reportQ.error} what="load the report" />
      <div className="grid-2">
        <Card
          title="Report checklist"
          actions={
            checklist ? (
              <Badge tone={checklist.ok ? 'green' : 'red'} dot>
                {checklist.ok ? 'complete' : `${checklist.missing.length} missing`}
              </Badge>
            ) : null
          }
        >
          {reportQ.isLoading && !report ? (
            <Loading />
          ) : !checklist ? (
            <EmptyState title="Save the report to see the checklist">Instructions, engineer identity, inspection, identification, pre-accident condition, damage, repair method, roadworthiness, duration, total loss, salvage, ADAS/EV, consistency with circumstances.</EmptyState>
          ) : (
            <div className="stack-sm">
              {checklist.missing.length > 0 && (
                <ul className="checklist">
                  {checklist.missing.map((m) => (
                    <li key={m}>
                      <span className="tick no">!</span>
                      <span>{m}</span>
                    </li>
                  ))}
                </ul>
              )}
              {checklist.notes.map((n) => (
                <div key={n} className="notice notice-info xs">
                  {n}
                </div>
              ))}
              {checklist.courtItemsChecked.length > 0 && <div className="xs muted">CPR 35 / PD 35 items checked: {checklist.courtItemsChecked.join('; ')}</div>}
            </div>
          )}
        </Card>
        <Card title="Issue">
          <div className="stack-sm">
            <div className="small">
              {report?.issuedAt ? (
                <>
                  Issued <DateText value={report.issuedAt} time />
                  {report.documentId && (
                    <>
                      {' '}
                      · <Link to={`../documents/${report.documentId}`}>report document</Link>
                    </>
                  )}
                </>
              ) : (
                <span className="muted">Not issued yet.</span>
              )}
            </div>
            <div className="small">
              Fee <strong>{formatGBP(form.feePence ?? 0)}</strong> — a fee note showing the instruction date and the work done answers “fee not recoverable” (live File 2).
              {smallClaims && <span className="muted"> Small claims track: expert fees are capped at {formatGBP(SMALL_CLAIMS_EXPERT_FEE_CAP_PENCE)} per expert (PD 27A para 7.3(2)); permission is needed for expert evidence (CPR 27.5).</span>}
            </div>
            <div className="row">
              <Button variant="primary" onClick={generate} disabled={!canGenerate || Boolean(report?.issuedAt)} loading={issue.isPending} title={!report ? 'Save the report first' : report.issuedAt ? 'Already issued' : dirty ? 'Save your edits first' : !checklist?.ok ? 'Complete the missing items first' : undefined}>
                Generate report.engineer
              </Button>
              {!canGenerate && <span className="xs muted">{!report ? 'Save the report first.' : dirty ? 'Unsaved edits.' : !checklist?.ok ? 'Blocked until the checklist is complete.' : ''}</span>}
            </div>
            <ApiErrorNotice error={issue.error} what="issue the report" />
          </div>
        </Card>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="stack"
        aria-label="Engineer's report"
      >
        <Card title="Instructions and engineer">
          <div className="form-grid">
            <Select label="Engineer" required value={form.engineerPartyId} onChange={(v) => set('engineerPartyId', v)} options={engineerOptions} placeholder={engineers.isLoading ? 'Loading…' : 'Choose the engineer party'} error={errors.engineerPartyId} hint="Parties with the engineer role; independent IAEA-qualified engineers preferred (supplier risk, lesson k)" />
            <TextInput label="Qualifications (IAEA / IMI)" required value={form.engineerQualifications} onChange={(v) => set('engineerQualifications', v)} error={errors.engineerQualifications} />
            <TextInput label="Instructed by" required value={form.instructedBy} onChange={(v) => set('instructedBy', v)} error={errors.instructedBy} />
            <DateTimeInput label="Instructed at" required value={form.instructedAt} onChange={(v) => set('instructedAt', v)} error={errors.instructedAt} />
          </div>
        </Card>
        <Card title="Inspection and identification">
          <div className="form-grid">
            <Select label="Basis" required value={form.inspectionBasis} onChange={(v) => v && set('inspectionBasis', v)} options={[{ value: 'physical', label: 'Physical inspection' }, { value: 'desktop', label: 'Desktop (photographs, estimate, scan)' }]} />
            <DateTimeInput label="Inspected at" value={form.inspectionAt} onChange={(v) => set('inspectionAt', v)} />
            <TextInput label="Place of inspection" value={form.inspectionPlace} onChange={(v) => set('inspectionPlace', v)} error={errors.inspectionPlace} />
            <TextInput label="Conditions" value={form.inspectionConditions} onChange={(v) => set('inspectionConditions', v)} placeholder="Daylight, dry, vehicle on ramp…" />
            <TextInput label="Odometer (miles)" value={form.odometerMiles} onChange={(v) => set('odometerMiles', v)} inputMode="numeric" error={errors.odometerMiles} hint="Added to the mileage-conflict check" />
            <div className="field">
              <span className="field-label">Vehicle record</span>
              <span className="small">
                {view.vehicle.registration} · VIN {view.vehicle.vin ?? '—'} · MOT {view.vehicle.motStatus ?? '—'} {view.vehicle.motExpiryDate ? `to ${view.vehicle.motExpiryDate}` : ''}
              </span>
            </div>
          </div>
        </Card>
        <Card title="Findings">
          <div className="form-grid">
            <TextArea className="span-2" label="Pre-accident condition" required value={form.preAccidentCondition} onChange={(v) => set('preAccidentCondition', v)} rows={2} error={errors.preAccidentCondition} />
            <TextArea className="span-2" label="Damage description" required value={form.damageDescription} onChange={(v) => set('damageDescription', v)} rows={4} error={errors.damageDescription} />
            <YesNo label="Consistent with the stated circumstances?" required value={form.consistentWithCircumstances} onChange={(v) => set('consistentWithCircumstances', v)} error={errors.consistentWithCircumstances} />
            <TextInput label="Consistency note" value={form.consistencyNote} onChange={(v) => set('consistencyNote', v)} error={errors.consistencyNote} />
            <TextArea className="span-2" label="Repair method" value={form.repairMethod} onChange={(v) => set('repairMethod', v)} rows={2} hint={view.estimate ? `Linked estimate: ${view.estimate.id} (net ${formatGBP(view.estimate.totals.netPence)})` : 'No estimate on file yet'} />
            <YesNo label="Roadworthy?" required value={form.roadworthy} onChange={(v) => set('roadworthy', v)} error={errors.roadworthy} />
            <TextInput label="Why (roadworthiness reason)" required value={form.roadworthyReason} onChange={(v) => set('roadworthyReason', v)} error={errors.roadworthyReason} hint="The period argument rests on this" />
            <TextInput label="Repair duration (working days)" value={form.repairDurationWorkingDays} onChange={(v) => set('repairDurationWorkingDays', v)} inputMode="numeric" error={errors.repairDurationWorkingDays} />
          </div>
        </Card>
        <Card title="Total loss, salvage, ADAS and EV">
          <div className="form-grid">
            <Select<SalvageCategory> label="Salvage category" value={form.salvageCategory} onChange={(v) => set('salvageCategory', v)} options={SALVAGE_OPTIONS} placeholder="Not a total loss / not categorised" />
            <MoneyInput label="Salvage value (£)" value={form.salvageValuePence} onChange={(v) => set('salvageValuePence', v)} hint="Actual bid or offer" />
            <div className="field span-2">
              <span className="field-label">Total-loss assessment and PAV</span>
              <span className="small">
                {view.pav ? `PAV ${formatGBP(view.pav.pavPence)} (${view.pav.approvedBy ? `approved by ${view.pav.approvedBy}` : 'not yet approved'})` : 'No PAV assessment yet'} · {view.report?.totalLoss ? `decision ${view.report.totalLoss.decision.replace(/_/g, ' ')}` : 'no total-loss assessment stored'} —{' '}
                <Link to="../engineering/total-loss">Total loss panel</Link> · <Link to="../engineering/pav">PAV workbench</Link>
              </span>
            </div>
            <TextArea label="ADAS notes" value={form.adasNotes} onChange={(v) => set('adasNotes', v)} rows={2} placeholder="Sensors / cameras affected; calibration required" />
            <TextArea label={isEv ? 'EV / hybrid notes (required for this vehicle)' : 'EV / hybrid notes'} value={form.evNotes} onChange={(v) => set('evNotes', v)} rows={2} />
            <TextInput className="span-2" label="Diagnostic fault codes" value={form.diagnosticFaultCodes} onChange={(v) => set('diagnosticFaultCodes', v)} placeholder="Comma-separated, from the scan report" />
            <div className="span-2">
              <EvidencePicker label="Photographs relied on" evidence={view.evidence} kinds={['photo', 'screenshot']} value={form.photoEvidenceIds} onChange={(ids) => set('photoEvidenceIds', ids)} max={40} />
            </div>
          </div>
        </Card>
        <Card title="Court use and fee">
          <div className="form-grid">
            <div className="span-2">
              <Checkbox label="Report is for court (adds CPR Part 35 / PD 35 content)" checked={form.forCourt} onChange={(v) => set('forCourt', v)} hint="Substance of instructions, the expert’s duty to the court, a statement of truth and the Guidance for the Instruction of Experts declaration. On the small claims track most of Part 35 does not apply (CPR 27.2) and expert evidence needs permission (CPR 27.5)." />
            </div>
            <MoneyInput label="Fee (£)" required value={form.feePence} onChange={(v) => set('feePence', v)} error={errors.feePence} hint="Default £285; rendered on the fee note with the instruction date" />
          </div>
          <div className="form-actions">
            <span className="hint">{dirty ? 'Unsaved edits.' : report ? 'Saved.' : 'Not saved yet.'}</span>
            <Button type="submit" variant="primary" loading={save.isPending}>
              Save report
            </Button>
          </div>
          <ApiErrorNotice error={save.error} what="save the report" />
          <ApiErrorNotice error={engineers.error} what="load engineers" />
        </Card>
      </form>
    </div>
  );
}
