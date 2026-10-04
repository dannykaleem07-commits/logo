import { Link } from 'react-router-dom';
import { formatRegistration, normaliseRegistration, isValidUkRegistration } from '@ccguk/domain';
import type { StepProps } from './NewClaimPage';
import type { ManualVehicleForm } from './fnol';
import { fleetUnitHardStop, lookupLinkedClaims } from './fnol';
import { useVehicleLookup } from '../../../api/hooks';
import { isApiError } from '../../../api/client';
import { Button } from '../../../components/Button';
import { Checkbox, DateInput, Select, TextInput } from '../../../components/Form';
import { KeyValue } from '../../../components/KeyValue';
import { Badge, VerificationBadge, StatusBadge } from '../../../components/Badge';
import { DateText } from '../../../components/DateText';

const FUELS: Array<{ value: NonNullable<ManualVehicleForm['fuelType']> extends '' ? never : Exclude<ManualVehicleForm['fuelType'], ''>; label: string }> = [
  { value: 'petrol', label: 'Petrol' },
  { value: 'diesel', label: 'Diesel' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'plugin_hybrid', label: 'Plug-in hybrid' },
  { value: 'electric', label: 'Electric' },
  { value: 'lpg', label: 'LPG' },
  { value: 'other', label: 'Other' }
];

/** Step 3 — registration → lookup (DVLA VES + DVSA MOT) or manual entry; cross-file duplicate banner; fleet hard stop. */
export function StepVehicle({ state, update, errors }: StepProps) {
  const lookup = useVehicleLookup();
  const v = state.vehicle;
  const reg = normaliseRegistration(v.registration);
  const regValid = reg.length > 0 && isValidUkRegistration(reg);

  const runLookup = async () => {
    if (!regValid) return;
    update((s) => ({ ...s, vehicle: { ...s.vehicle, lookupState: 'loading', lookupError: '', lookup: null } }));
    try {
      const result = await lookup.mutateAsync(reg);
      update((s) => ({ ...s, vehicle: { ...s.vehicle, lookup: result, lookupState: result.status === 'ok' ? 'ok' : 'manual', useManual: result.status !== 'ok' } }));
    } catch (e) {
      const msg = isApiError(e) && e.isNetwork ? 'API unreachable — enter the vehicle manually.' : (e as Error).message;
      update((s) => ({ ...s, vehicle: { ...s.vehicle, lookupState: 'error', lookupError: msg, useManual: true } }));
    }
  };

  const setManual = (k: keyof ManualVehicleForm) => (val: string) => update((s) => ({ ...s, vehicle: { ...s.vehicle, manual: { ...s.vehicle.manual, [k]: val } } }));
  const linked = lookupLinkedClaims(state);
  const hardStop = fleetUnitHardStop(state);
  const ok = v.lookup?.status === 'ok' ? v.lookup : null;
  const showManual = v.useManual || v.lookupState === 'manual' || v.lookupState === 'error';

  return (
    <div className="stack">
      <h2>Client vehicle</h2>
      <div className="field">
        <label className="field-label" htmlFor="reg">
          Registration<span className="req">*</span>
        </label>
        <div className="input-group">
          <input
            id="reg"
            className="input input-reg"
            value={v.registration}
            onChange={(e) => update((s) => ({ ...s, vehicle: { ...s.vehicle, registration: e.target.value, lookupState: 'idle', lookup: null, lookupError: '', useManual: false } }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void runLookup();
              }
            }}
            placeholder="AB12 CDE"
            autoCapitalize="characters"
            autoComplete="off"
            aria-invalid={errors['vehicle.registration'] ? true : undefined}
          />
          <Button variant="primary" onClick={runLookup} disabled={!regValid} loading={v.lookupState === 'loading'}>
            Look up
          </Button>
        </div>
        {errors['vehicle.registration'] ? (
          <div className="field-error">{errors['vehicle.registration']}</div>
        ) : errors['vehicle.lookup'] ? (
          <div className="field-error">{errors['vehicle.lookup']}</div>
        ) : (
          <div className="field-hint">DVLA Vehicle Enquiry Service and DVSA MOT history. Live when API keys are configured; otherwise manual entry (recorded as unverified).</div>
        )}
      </div>

      {hardStop && (
        <div className="notice notice-danger" role="alert">
          <strong>Hard stop — fleet unit.</strong> {formatRegistration(reg)} is a CCGUK fleet vehicle ({v.lookup?.fleetUnit?.id}). A fleet unit cannot be the client vehicle on a claim (lessons f, h). Check the registration with the client.
        </div>
      )}

      {linked.length > 0 && (
        <div className="notice notice-warn" role="alert">
          <strong>Cross-file registration check.</strong> {formatRegistration(reg)} already appears on {linked.length} claim{linked.length === 1 ? '' : 's'}. This FNOL opens a <em>linked but separate</em> file (own ledger, documents and insurer) and both files carry a banner.
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {linked.map((l) => (
              <li key={l.claimId}>
                <Link to={`/claims/${l.claimId}`} target="_blank" rel="noreferrer">
                  {l.reference}
                </Link>{' '}
                <StatusBadge status={l.status} /> {l.claimantName ? `· ${l.claimantName}` : ''} {l.openedAt ? <>· opened <DateText value={l.openedAt} /></> : null}
                {l.relation ? ` · ${l.relation.replace(/_/g, ' ')}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {v.lookupState === 'error' && (
        <div className="notice notice-warn">
          <strong>Lookup failed.</strong> {v.lookupError}
        </div>
      )}

      {ok && (
        <fieldset className="fieldset">
          <legend>
            Lookup result <Badge tone="green">DVLA / DVSA</Badge>
          </legend>
          <KeyValue
            items={[
              { label: 'Registration', value: <span className="reg-plate">{formatRegistration(ok.vehicle.registration)}</span> },
              { label: 'Make / model', value: [ok.vehicle.make, ok.vehicle.model, ok.vehicle.variant].filter(Boolean).join(' ') || '—' },
              { label: 'Colour', value: ok.vehicle.colour ?? '—' },
              { label: 'Fuel / transmission', value: [ok.vehicle.fuelType, ok.vehicle.transmission].filter(Boolean).join(' / ') || '—' },
              { label: 'Year', value: ok.vehicle.yearOfManufacture ?? '—' },
              { label: 'Tax', value: ok.vehicle.taxStatus ? `${ok.vehicle.taxStatus}${ok.vehicle.taxDueDate ? ` (due ${ok.vehicle.taxDueDate})` : ''}` : '—' },
              { label: 'MOT', value: ok.vehicle.motStatus ? `${ok.vehicle.motStatus}${ok.vehicle.motExpiryDate ? ` (expires ${ok.vehicle.motExpiryDate})` : ''}` : '—' },
              { label: 'MOT tests', value: ok.motHistory?.length ?? ok.vehicle.motHistory?.length ?? 0 },
              {
                label: 'Last MOT odometer',
                value: (() => {
                  const tests = ok.motHistory ?? ok.vehicle.motHistory ?? [];
                  const latest = tests.find((t) => t.odometerMiles !== undefined);
                  return latest ? `${latest.odometerMiles?.toLocaleString('en-GB')} mi on ${latest.completedDate}` : '—';
                })()
              },
              { label: 'Export marker', value: ok.vehicle.markedForExport ? 'Yes' : 'No' },
              { label: 'Verification', value: <VerificationBadge verification={ok.ves?.verification ?? 'verified'} /> }
            ]}
          />
          {ok.warnings && ok.warnings.length > 0 && (
            <ul className="small" style={{ marginTop: 8, color: 'var(--amber)' }}>
              {ok.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          <div style={{ marginTop: 12 }}>
            <Checkbox label="Override with manual entry" checked={v.useManual} onChange={(val) => update((s) => ({ ...s, vehicle: { ...s.vehicle, useManual: val } }))} hint="Only if the client says the record is wrong. Manual values are stored as unverified." />
          </div>
        </fieldset>
      )}

      {v.lookupState === 'manual' && v.lookup?.status === 'manual_required' && (
        <div className="notice notice-info">
          <strong>Manual entry required.</strong> {v.lookup.reason ?? 'The lookup services are not configured or did not return this registration.'} Enter the details from the V5C, MOT certificate or the client. They are stored as <em>unverified</em> until a document backs them.
        </div>
      )}

      {showManual && (
        <fieldset className="fieldset">
          <legend>
            Manual entry <Badge tone="amber">unverified</Badge>
          </legend>
          <div className="form-grid">
            <TextInput label="Make" required value={v.manual.make} onChange={setManual('make')} error={errors['vehicle.make']} />
            <TextInput label="Model" required value={v.manual.model} onChange={setManual('model')} error={errors['vehicle.model']} />
            <TextInput label="Colour" value={v.manual.colour} onChange={setManual('colour')} />
            <TextInput label="Year of manufacture" value={v.manual.yearOfManufacture} onChange={setManual('yearOfManufacture')} inputMode="numeric" placeholder="2019" />
            <Select label="Fuel" value={v.manual.fuelType} onChange={(val) => setManual('fuelType')(val)} options={FUELS} placeholder="Unknown" />
            <Select label="Transmission" value={v.manual.transmission} onChange={(val) => setManual('transmission')(val)} options={[{ value: 'manual', label: 'Manual' }, { value: 'automatic', label: 'Automatic' }, { value: 'unknown', label: 'Unknown' }]} placeholder="Unknown" />
            <TextInput label="VIN" value={v.manual.vin} onChange={setManual('vin')} inputClassName="input-reg" />
            <DateInput label="MOT expiry" value={v.manual.motExpiryDate} onChange={setManual('motExpiryDate')} />
            <TextInput label="Odometer (miles)" value={v.manual.odometerMiles} onChange={setManual('odometerMiles')} inputMode="numeric" hint="As stated by the client; a photo of the odometer is captured at handover." />
          </div>
        </fieldset>
      )}
      {errors['vehicle.fleet'] && (
        <div className="field-error" role="alert">
          {errors['vehicle.fleet']}
        </div>
      )}
    </div>
  );
}
