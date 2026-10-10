// owned by ap-clash
/**
 * Driver profile form (docs/SUPREME-AUTOPILOT.md §F.1): licence facts and the DVLA check result for one party.
 * ClaimDesk cannot query DVLA — the person checks (gov.uk "View or share your driving licence" with the client's check
 * code) and records the date and summary here. Saving is human-only and audited; the claim's clash checks and the
 * autopilot re-run. Usable from the eligibility review, the Hire tab and the handover dialog.
 */
import { useEffect, useState } from 'react';
import type { DriverProfile, LicenceCountry } from '@ccguk/domain';
import { Button } from '../../../components/Button';
import { Checkbox, Select, TextArea, TextInput } from '../../../components/Form';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { useDriverProfile, useSaveDriverProfile, type DriverProfileBody } from '../../../api/clashApi';

interface Form {
  licenceNumber: string;
  licenceCountry: LicenceCountry;
  licenceType: DriverProfile['licenceType'];
  fullLicenceSince: string;
  licenceExpiry: string;
  points: string;
  endorsements: string;
  restriction78: boolean;
  otherRestrictions: string;
  disqualifiedUntil: string;
  faultAccidents3y: string;
  unspentConvictions: string;
  dvlaCheckedOn: string;
  dvlaSummary: string;
}

const today = (): string => new Date().toISOString().slice(0, 10);

export function profileToForm(p: DriverProfile | null, licenceNumber: string | null): Form {
  return {
    licenceNumber: p?.licenceNumber ?? licenceNumber ?? '',
    licenceCountry: p?.licenceCountry ?? 'GB',
    licenceType: p?.licenceType ?? 'full',
    fullLicenceSince: p?.fullLicenceSince ?? '',
    licenceExpiry: p?.licenceExpiry ?? '',
    points: p?.points === null || p?.points === undefined ? '' : String(p.points),
    endorsements: (p?.endorsements ?? []).map((e) => `${e.code} ${e.offenceDate} ${e.points}`).join('\n'),
    restriction78: (p?.restrictionCodes ?? []).includes('78'),
    otherRestrictions: (p?.restrictionCodes ?? []).filter((c) => c !== '78').join(', '),
    disqualifiedUntil: p?.disqualifiedUntil ?? '',
    faultAccidents3y: p?.faultAccidents3y === null || p?.faultAccidents3y === undefined ? '' : String(p.faultAccidents3y),
    unspentConvictions: (p?.unspentConvictions ?? []).join('\n'),
    dvlaCheckedOn: p?.dvlaCheck?.checkedAt?.slice(0, 10) ?? '',
    dvlaSummary: p?.dvlaCheck?.summary ?? '',
  };
}

/** Form → request body, or the problems (plain English). Endorsements: one per line "CODE YYYY-MM-DD POINTS". */
export function formToBody(f: Form): { body?: DriverProfileBody; problems: string[] } {
  const problems: string[] = [];
  const endorsements: DriverProfileBody['endorsements'] = [];
  for (const line of f.endorsements.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^([A-Za-z]{2}\d{2})\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2})$/.exec(line);
    if (!m) problems.push(`Endorsement "${line}" should look like "SP30 2024-03-01 3"`);
    else endorsements.push({ code: m[1]!.toUpperCase(), offenceDate: m[2]!, points: Number(m[3]) });
  }
  const points = f.points.trim() === '' ? null : Number(f.points);
  if (points !== null && !(Number.isInteger(points) && points >= 0)) problems.push('Points must be a whole number');
  const accidents = f.faultAccidents3y.trim() === '' ? null : Number(f.faultAccidents3y);
  if (accidents !== null && !(Number.isInteger(accidents) && accidents >= 0)) problems.push('Fault accidents must be a whole number');
  if (f.dvlaCheckedOn && !f.dvlaSummary.trim()) problems.push('Say what the DVLA check showed');
  const restrictions = [...(f.restriction78 ? ['78'] : []), ...f.otherRestrictions.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)];
  if (problems.length) return { problems };
  return {
    problems,
    body: {
      ...(f.licenceNumber.trim() ? { licenceNumber: f.licenceNumber.trim().toUpperCase() } : {}),
      licenceCountry: f.licenceCountry,
      licenceType: f.licenceType,
      ...(f.fullLicenceSince ? { fullLicenceSince: f.fullLicenceSince } : {}),
      ...(f.licenceExpiry ? { licenceExpiry: f.licenceExpiry } : {}),
      categories: [],
      restrictionCodes: Array.from(new Set(restrictions)),
      points,
      endorsements,
      ...(f.disqualifiedUntil ? { disqualifiedUntil: f.disqualifiedUntil } : {}),
      disqualifications5y: f.disqualifiedUntil ? null : 0,
      faultAccidents3y: accidents,
      unspentConvictions: f.unspentConvictions.split('\n').map((x) => x.trim()).filter(Boolean),
      medicalConditionsDeclared: null,
      ...(f.dvlaCheckedOn ? { dvlaCheck: { checkedAt: `${f.dvlaCheckedOn}T12:00:00.000Z`, summary: f.dvlaSummary.trim() } } : {}),
      source: f.dvlaCheckedOn ? 'dvla_check' : 'declared',
    },
  };
}

export function DriverProfileForm({ partyId, onSaved }: { partyId: string; onSaved?: () => void }) {
  const q = useDriverProfile(partyId);
  const save = useSaveDriverProfile(partyId);
  const toast = useToast();
  const [form, setForm] = useState<Form>(() => profileToForm(null, null));
  const [problems, setProblems] = useState<string[]>([]);
  useEffect(() => {
    if (q.data) setForm(profileToForm(q.data.profile, q.data.drivingLicenceNumber));
  }, [q.data]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ApiErrorNotice error={q.error} />;
  const set = <K extends keyof Form>(k: K) => (v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const submit = () => {
    const r = formToBody(form);
    setProblems(r.problems);
    if (!r.body) return;
    save.mutate(r.body, {
      onSuccess: () => {
        toast.success('Driver details saved');
        onSaved?.();
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
    });
  };
  return (
    <div className="stack">
      <p className="muted small">
        {q.data?.name}
        {q.data?.dateOfBirth ? `, born ${q.data.dateOfBirth}` : ' — date of birth not on file (add it to the person)'}
      </p>
      <div className="form-grid">
        <TextInput label="Licence number" value={form.licenceNumber} onChange={set('licenceNumber')} />
        <Select<LicenceCountry>
          label="Issued in"
          value={form.licenceCountry}
          onChange={(v) => set('licenceCountry')((v || 'unknown') as LicenceCountry)}
          options={[
            { value: 'GB', label: 'Great Britain' },
            { value: 'NI', label: 'Northern Ireland' },
            { value: 'EU_EEA', label: 'EU / EEA' },
            { value: 'OTHER', label: 'Another country' },
            { value: 'unknown', label: 'Not known yet' },
          ]}
        />
        <Select<DriverProfile['licenceType']>
          label="Licence type"
          value={form.licenceType}
          onChange={(v) => set('licenceType')((v || 'unknown') as DriverProfile['licenceType'])}
          options={[
            { value: 'full', label: 'Full' },
            { value: 'provisional', label: 'Provisional' },
            { value: 'international', label: 'International' },
            { value: 'unknown', label: 'Not known yet' },
          ]}
        />
        <TextInput label="Full licence since (YYYY-MM-DD)" value={form.fullLicenceSince} onChange={set('fullLicenceSince')} type="text" />
        <TextInput label="Licence valid until (YYYY-MM-DD)" value={form.licenceExpiry} onChange={set('licenceExpiry')} />
        <TextInput label="Penalty points (blank = not known)" value={form.points} onChange={set('points')} />
        <TextArea label="Endorsements (one per line: SP30 2024-03-01 3)" value={form.endorsements} onChange={set('endorsements')} />
        <div>
          <Checkbox label="Restriction 78: automatic cars only" checked={form.restriction78} onChange={set('restriction78')} />
          <TextInput label="Other restriction codes" value={form.otherRestrictions} onChange={set('otherRestrictions')} />
        </div>
        <TextInput label="Disqualified until (YYYY-MM-DD, if any)" value={form.disqualifiedUntil} onChange={set('disqualifiedUntil')} />
        <TextInput label="Fault accidents in the last 3 years" value={form.faultAccidents3y} onChange={set('faultAccidents3y')} />
        <TextArea label="Unspent convictions (one per line)" value={form.unspentConvictions} onChange={set('unspentConvictions')} />
        <TextInput label="DVLA check done on (YYYY-MM-DD)" value={form.dvlaCheckedOn} onChange={(v) => set('dvlaCheckedOn')(v)} hint={`ClaimDesk cannot query DVLA: check with the client's share code (today is ${today()})`} />
        <TextArea label="What the DVLA check showed" value={form.dvlaSummary} onChange={set('dvlaSummary')} />
      </div>
      {problems.length > 0 && (
        <ul className="field-error">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="row">
        <Button variant="primary" loading={save.isPending} onClick={submit}>
          Save driver details
        </Button>
      </div>
    </div>
  );
}
