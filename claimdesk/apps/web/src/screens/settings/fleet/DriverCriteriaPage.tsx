// owned by ap-clash
/**
 * Settings > Fleet > Driver criteria (docs/SUPREME-AUTOPILOT.md §F.2, §I.8, §L): the default criteria (Settings >
 * Autopilot, `eligibility.defaultCriteria`) and each fleet policy's own criteria. The defaults are generic UK
 * hire-insurer norms and are labelled "check against your policy". Admin / approver only (the API enforces it; agents
 * can never change criteria).
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { DriverCriteria, LicenceCountry } from '@ccguk/domain';
import { PageHeader } from '../../../components/PageHeader';
import { Card } from '../../../components/Card';
import { Button } from '../../../components/Button';
import { Badge } from '../../../components/Badge';
import { Checkbox, TextInput } from '../../../components/Form';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { useDefaultCriteria, usePolicies, usePolicyCriteria, useSaveDefaultCriteria, useSavePolicyCriteria } from '../../../api/clashApi';
import { BUILT_IN, COUNTRY_LABEL, CRITERIA_NOTICE, fromForm, summarise, toForm, type CriteriaForm } from './criteria';

function CriteriaEditor({ value, onSave, saving, extra }: { value: DriverCriteria; onSave: (c: DriverCriteria) => void; saving: boolean; extra?: ReactNode }) {
  const [form, setForm] = useState<CriteriaForm>(() => toForm(value));
  const [problems, setProblems] = useState<string[]>([]);
  useEffect(() => setForm(toForm(value)), [value]);
  const set = (k: keyof CriteriaForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (list: 'licenceCountriesEligible' | 'licenceCountriesRefer', c: LicenceCountry) => (on: boolean) =>
    setForm((f) => ({ ...f, [list]: on ? Array.from(new Set([...f[list], c])) : f[list].filter((x) => x !== c) }));
  const save = () => {
    const r = fromForm(form);
    setProblems(r.problems);
    if (r.criteria) onSave(r.criteria);
  };
  return (
    <div className="stack">
      <h3>Age at the start of the hire</h3>
      <div className="form-grid">
        <TextInput label="Not eligible under" value={form.minAge} onChange={set('minAge')} type="number" />
        <TextInput label="Refer to the insurer under" value={form.referBelowAge} onChange={set('referBelowAge')} type="number" />
        <TextInput label="Refer to the insurer over" value={form.referAboveAge} onChange={set('referAboveAge')} type="number" />
        <TextInput label="Not eligible over" value={form.maxAge} onChange={set('maxAge')} type="number" />
      </div>
      <h3>Full licence held for (years)</h3>
      <div className="form-grid">
        <TextInput label="Not eligible under" value={form.minYearsFullLicence} onChange={set('minYearsFullLicence')} type="number" />
        <TextInput label="Refer to the insurer under" value={form.referBelowYearsFullLicence} onChange={set('referBelowYearsFullLicence')} type="number" />
      </div>
      <h3>Points, endorsements, accidents</h3>
      <div className="form-grid">
        <TextInput label="Eligible with up to (points)" value={form.maxPointsEligible} onChange={set('maxPointsEligible')} type="number" />
        <TextInput label="Refer with up to (points; more is not eligible)" value={form.maxPointsRefer} onChange={set('maxPointsRefer')} type="number" />
        <TextInput label="Endorsement codes that exclude (prefixes, e.g. DR, CD4)" value={form.excludedEndorsementPrefixes} onChange={set('excludedEndorsementPrefixes')} className="span-2" />
        <TextInput label="Endorsement codes to refer (prefixes)" value={form.referEndorsementPrefixes} onChange={set('referEndorsementPrefixes')} />
        <TextInput label="Look back (years) for endorsements" value={form.excludedLookbackYears} onChange={set('excludedLookbackYears')} type="number" />
        <TextInput label="Disqualification within (years) is not eligible" value={form.disqualificationLookbackYears} onChange={set('disqualificationLookbackYears')} type="number" />
        <TextInput label="Fault accidents in 3 years: eligible up to" value={form.maxFaultAccidents3yEligible} onChange={set('maxFaultAccidents3yEligible')} type="number" />
        <TextInput label="Fault accidents in 3 years: refer up to" value={form.maxFaultAccidents3yRefer} onChange={set('maxFaultAccidents3yRefer')} type="number" />
      </div>
      <h3>Licence country, checks and excess</h3>
      <div className="form-grid">
        <div>
          <strong className="small">Eligible licence countries</strong>
          {(Object.keys(COUNTRY_LABEL) as Array<keyof typeof COUNTRY_LABEL>).map((c) => (
            <Checkbox key={`e-${c}`} label={COUNTRY_LABEL[c]} checked={form.licenceCountriesEligible.includes(c)} onChange={toggle('licenceCountriesEligible', c)} />
          ))}
        </div>
        <div>
          <strong className="small">Refer to the insurer</strong>
          {(Object.keys(COUNTRY_LABEL) as Array<keyof typeof COUNTRY_LABEL>).map((c) => (
            <Checkbox key={`r-${c}`} label={COUNTRY_LABEL[c]} checked={form.licenceCountriesRefer.includes(c)} disabled={form.licenceCountriesEligible.includes(c)} onChange={toggle('licenceCountriesRefer', c)} />
          ))}
        </div>
        <TextInput label="DVLA check no older than (days) at handover" value={form.requireDvlaCheckWithinDays} onChange={set('requireDvlaCheckWithinDays')} type="number" />
        <TextInput label="Young-driver excess (£, blank = not set)" value={form.youngDriverExcessPounds} onChange={set('youngDriverExcessPounds')} />
        <Checkbox label="Refer drivers with unspent motoring or dishonesty convictions" checked={form.unspentConvictionsRefer} onChange={(v) => setForm((f) => ({ ...f, unspentConvictionsRefer: v }))} />
        <p className="muted small">Provisional licences are never accepted.</p>
      </div>
      {problems.length > 0 && (
        <ul className="field-error">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="row">
        <Button variant="primary" loading={saving} onClick={save}>
          Save
        </Button>
        {extra}
      </div>
    </div>
  );
}

function PolicyCriteria({ policyId, label }: { policyId: string; label: string }) {
  const q = usePolicyCriteria(policyId);
  const save = useSavePolicyCriteria(policyId);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ApiErrorNotice error={q.error} />;
  const v = q.data!;
  const done = (msg: string) => ({ onSuccess: () => toast.success(msg), onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)) });
  return (
    <Card
      title={
        <span className="row">
          {label}
          {v.source === 'policy' ? <Badge tone="blue">Own criteria</Badge> : <Badge tone="amber">Using the defaults — check against your policy</Badge>}
        </span>
      }
      actions={
        <Button size="sm" onClick={() => setEditing((x) => !x)}>
          {editing ? 'Close' : v.source === 'policy' ? 'Edit' : 'Set criteria for this policy'}
        </Button>
      }
    >
      <p className="small">{summarise(v.effective)}</p>
      {editing && (
        <CriteriaEditor
          value={v.effective}
          saving={save.isPending}
          onSave={(c) => save.mutate(c, done('Policy criteria saved'))}
          extra={
            v.source === 'policy' ? (
              <Button variant="ghost" onClick={() => save.mutate(null, done('This policy now uses the defaults'))}>
                Use the defaults instead
              </Button>
            ) : null
          }
        />
      )}
    </Card>
  );
}

export function DriverCriteriaPage() {
  const defaults = useDefaultCriteria();
  const saveDefaults = useSaveDefaultCriteria();
  const policies = usePolicies();
  const toast = useToast();
  return (
    <div className="page">
      <PageHeader title="Driver criteria" />
      <div className="notice notice-warn" role="note" style={{ marginBottom: 16 }}>
        <strong>Check against your policy.</strong> {CRITERIA_NOTICE} ClaimDesk cannot query DVLA: the licence check is recorded by a person.
      </div>
      <Card title={<span className="row">Default criteria <Badge tone="amber">Generic defaults — check against your policy</Badge></span>}>
        <p className="muted small">Used for every policy that has no criteria of its own. Built-in starting point: {summarise(BUILT_IN)}.</p>
        {defaults.isLoading ? (
          <Loading />
        ) : defaults.error ? (
          <ApiErrorNotice error={defaults.error} />
        ) : (
          <CriteriaEditor
            value={defaults.data ?? BUILT_IN}
            saving={saveDefaults.isPending}
            onSave={(c) => saveDefaults.mutate(c, { onSuccess: () => toast.success('Default criteria saved'), onError: (e) => toast.error(e instanceof Error ? e.message : String(e)) })}
          />
        )}
      </Card>
      <h2>Per policy</h2>
      {policies.isLoading ? (
        <Loading />
      ) : policies.error ? (
        <ApiErrorNotice error={policies.error} />
      ) : (policies.data?.items ?? []).length === 0 ? (
        <p className="muted">No fleet insurance policies yet (Fleet → Policies).</p>
      ) : (
        (policies.data?.items ?? []).map((p) => <PolicyCriteria key={p.id} policyId={p.id} label={`${p.insurerName} — ${p.policyNumber} (${p.startDate} to ${p.endDate})`} />)
      )}
    </div>
  );
}
