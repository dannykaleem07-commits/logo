import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import type { OnFileMatch } from '@ccguk/domain';
import { formatRegistration, normaliseRegistration, isValidUkRegistration } from '@ccguk/domain';
import type { StepProps } from './NewClaimPage';
import { fleetUnitHardStop, lookupLinkedClaims, needsHandEntry, vehicleLookupMode, type FnolVehicleState } from './fnol';
import { useVehicleLookup } from '../../../api/hooks';
import { isApiError } from '../../../api/client';
import { useLookupMode } from '../../../api/vehiclesApi';
import { Button } from '../../../components/Button';
import { Checkbox, TextInput } from '../../../components/Form';
import { KeyValue } from '../../../components/KeyValue';
import { Badge, VerificationBadge, StatusBadge } from '../../../components/Badge';
import { DateText } from '../../../components/DateText';
import { VehiclePicker, MANUAL_MODE_NOTICE, type VehiclePickerValue } from '../../vehicles/VehiclePicker';
import { OnFileMatches } from '../../vehicles/OnFileMatches';
import { CopyDetailsPanel } from '../../vehicles/CopyDetailsPanel';
import { applyOnFile, describeVehicle, FUEL_LABEL } from '../../vehicles/vehiclePickerModel';
import { LOOKUP_PROVIDER_LABEL } from '../../claim/lib/vehicle';

/**
 * Step 3 — registration → search. Live mode (DVLA/DVSA keys set): the lookup as before, still showing what is on
 * file. Manual mode (no keys): the button reads "Search", ClaimDesk searches its own records, and the details come from
 * a vehicle already on file ("Use this vehicle"), a Total Car Check paste or the catalogue cascade — all unverified.
 * Cross-file duplicate banner and fleet hard stop as before (lessons f, h). In manager mode the fleet hard stop and a
 * non-UK plate are warnings: the server still raises the fleet block flag on the claim.
 */
export function StepVehicle({ state, update, errors, warnings = {}, managerOn = false }: StepProps) {
  const lookup = useVehicleLookup();
  const settingsMode = useLookupMode();
  const v = state.vehicle;
  const reg = normaliseRegistration(v.registration);
  const regValid = reg.length > 0 && isValidUkRegistration(reg);
  // Manager mode: a non-UK plate can still be searched (ClaimDesk's own records; the details are typed by hand).
  const canSearch = regValid || (managerOn && reg.length >= 2);
  const mode = vehicleLookupMode(v, settingsMode);
  const manualMode = mode === 'manual';

  const setVehicle = useCallback((patch: Partial<FnolVehicleState>) => update((s) => ({ ...s, vehicle: { ...s.vehicle, ...patch } })), [update]);
  const setPicker = useCallback((next: VehiclePickerValue) => update((s) => ({ ...s, vehicle: { ...s.vehicle, picker: next } })), [update]);

  const runLookup = async (registration: string = reg) => {
    const r = normaliseRegistration(registration);
    if (!r || (!isValidUkRegistration(r) && !(managerOn && r.length >= 2))) return;
    update((s) => ({ ...s, vehicle: { ...s.vehicle, registration: r === normaliseRegistration(s.vehicle.registration) ? s.vehicle.registration : r, lookupState: 'loading', lookupError: '', lookup: null, onFile: null, picker: { ...s.vehicle.picker, registration: r } } }));
    try {
      const result = await lookup.mutateAsync(r);
      update((s) => ({ ...s, vehicle: { ...s.vehicle, lookup: result, lookupState: result.status === 'ok' ? 'ok' : 'manual', useManual: result.status !== 'ok' } }));
    } catch (e) {
      const msg = isApiError(e) && e.isNetwork ? 'API unreachable — enter the vehicle by hand.' : (e as Error).message;
      update((s) => ({ ...s, vehicle: { ...s.vehicle, lookupState: 'error', lookupError: msg, useManual: true } }));
    }
  };

  const pickOnFile = (m: OnFileMatch) => setVehicle({ onFile: m, useManual: false });
  const changeDetails = () => {
    const m = v.onFile;
    if (!m) return;
    update((s) => ({ ...s, vehicle: { ...s.vehicle, onFile: null, useManual: true, picker: applyOnFile(s.vehicle.picker, m) } }));
  };

  const linked = lookupLinkedClaims(state);
  const hardStop = fleetUnitHardStop(state);
  const ok = v.lookup?.status === 'ok' ? v.lookup : null;
  const searched = v.lookupState !== 'idle' && v.lookupState !== 'loading';
  const onFile = v.lookup?.onFile ?? [];
  const showHandEntry = searched && needsHandEntry(v);
  const pickerErrors: Partial<Record<keyof VehiclePickerValue, string>> = {};
  for (const [k, msg] of Object.entries(errors)) if (k.startsWith('vehicle.')) (pickerErrors as Record<string, string>)[k.slice('vehicle.'.length)] = msg;

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
            onChange={(e) => {
              const text = e.target.value;
              update((s) => ({ ...s, vehicle: { ...s.vehicle, registration: text, lookupState: 'idle', lookup: null, lookupError: '', useManual: false, onFile: null, picker: { ...s.vehicle.picker, registration: normaliseRegistration(text) } } }));
            }}
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
          <Button variant="primary" onClick={() => void runLookup()} disabled={!canSearch} loading={v.lookupState === 'loading'}>
            {manualMode ? 'Search' : 'Look up'}
          </Button>
        </div>
        {errors['vehicle.registration'] ? (
          <div className="field-error">{errors['vehicle.registration']}</div>
        ) : errors['vehicle.lookup'] ? (
          <div className="field-error">{errors['vehicle.lookup']}</div>
        ) : warnings['vehicle.registration'] || warnings['vehicle.lookup'] ? (
          <div className="field-warning manager-field-warning" role="status">
            {warnings['vehicle.registration'] ?? warnings['vehicle.lookup']}
          </div>
        ) : manualMode ? null : (
          <div className="field-hint">DVLA Vehicle Enquiry Service and DVSA MOT history when API keys are set; otherwise ClaimDesk searches its own records (details entered are recorded as unverified).</div>
        )}
      </div>

      {manualMode && (
        <div className="notice notice-info" role="status">
          {MANUAL_MODE_NOTICE}
        </div>
      )}

      {hardStop &&
        (managerOn ? (
          <div className="manager-note" role="status">
            <strong>Fleet unit — allowed in manager mode.</strong> {formatRegistration(reg)} is a CCGUK fleet vehicle. The claim opens with a hard-stop flag on the file until the registration is corrected or the flag is cleared with a reason.
          </div>
        ) : (
          <div className="notice notice-danger" role="alert">
            <strong>Hard stop — fleet unit.</strong> {formatRegistration(reg)} is a CCGUK fleet vehicle. A fleet unit cannot be the client vehicle on a claim. Check the registration with the client.
          </div>
        ))}

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
          <strong>Search failed.</strong> {v.lookupError}
        </div>
      )}

      {v.onFile ? (
        <OnFileSummary match={v.onFile} onChange={changeDetails} />
      ) : (
        searched &&
        onFile.length > 0 && (
          <fieldset className="fieldset">
            <legend>Already on file</legend>
            <OnFileMatches matches={onFile} onUse={pickOnFile} onSearchRegistration={(r) => void runLookup(r)} blockFleet={!managerOn} />
          </fieldset>
        )
      )}

      {!v.onFile && ok && (
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
            <Checkbox label="Override with details entered by hand" checked={v.useManual} onChange={(val) => setVehicle({ useManual: val })} hint="Only if the client says the record is wrong. Hand-entered values are stored as unverified." />
          </div>
        </fieldset>
      )}

      {v.lookupState === 'manual' && v.lookup?.status === 'manual_required' && !v.onFile && !manualMode && (
        <div className="notice notice-info">
          <strong>Enter the details.</strong> {v.lookup.reason ?? 'The lookup services did not return this registration.'} Use Total Car Check or the V5C, MOT certificate or the client. They are stored as <em>unverified</em> until a document backs them.
        </div>
      )}

      {showHandEntry && (
        <>
          <CopyDetailsPanel registration={reg} value={v.picker} onChange={setPicker} links={v.lookup?.externalLinks} />
          <VehiclePicker value={v.picker} onChange={setPicker} mode="claim" showRegistration={false} lookupMode={mode ?? 'manual'} onUseOnFile={pickOnFile} errors={pickerErrors} />
          <div className="form-grid">
            <TextInput
              label="Odometer (miles)"
              value={v.odometerMiles}
              onChange={(t) => setVehicle({ odometerMiles: t })}
              inputMode="numeric"
              error={errors['vehicle.odometerMiles']}
              warning={warnings['vehicle.odometerMiles']}
              hint="As stated by the client; a photo of the odometer is captured at handover."
            />
          </div>
        </>
      )}
      {errors['vehicle.fleet'] && (
        <div className="field-error" role="alert">
          {errors['vehicle.fleet']}
        </div>
      )}
      {showHandEntry && managerOn && pickerWarningLines(warnings).length > 0 && (
        <div className="field-warning manager-field-warning" role="status">
          {pickerWarningLines(warnings).join(' ')}
        </div>
      )}
    </div>
  );
}

/** The on-file vehicle reused by id: read-only, with "Change details" to edit a copy in the picker. */
function OnFileSummary({ match, onChange }: { match: OnFileMatch; onChange: () => void }) {
  const latest = match.lookups[0];
  return (
    <fieldset className="fieldset">
      <legend>
        Using the vehicle on file <Badge tone="blue">existing record</Badge>
      </legend>
      <KeyValue
        items={[
          { label: 'Registration', value: <span className="reg-plate">{formatRegistration(match.registration)}</span> },
          { label: 'Vehicle', value: describeVehicle({ make: match.make === 'UNKNOWN' ? '' : match.make, model: match.model === 'UNKNOWN' ? '' : match.model, variant: match.variant ?? '', yearOfManufacture: match.yearOfManufacture, engineCapacityCc: match.engineCapacityCc }) || '—' },
          { label: 'Colour', value: match.colour ?? '—' },
          { label: 'Fuel', value: match.fuelType ? FUEL_LABEL[match.fuelType] : '—' },
          { label: 'Claims on this registration', value: match.claims.length ? match.claims.map((c) => c.reference).join(', ') : 'None' },
          { label: 'Last details from', value: latest ? `${LOOKUP_PROVIDER_LABEL[latest.provider] ?? latest.provider} (${latest.verification})` : 'No lookup record' }
        ]}
      />
      <div className="row" style={{ marginTop: 12 }}>
        <Button size="sm" onClick={onChange}>
          Change details
        </Button>
        <span className="xs muted">The claim will reference this vehicle record. Change details to correct or complete it (saved as unverified).</span>
      </div>
    </fieldset>
  );
}

/** Relaxed vehicle-detail checks (make, model, year …) shown once under the picker in manager mode. */
function pickerWarningLines(warnings: Record<string, string>): string[] {
  const skip = new Set(['vehicle.registration', 'vehicle.lookup', 'vehicle.fleet', 'vehicle.odometerMiles']);
  return Object.entries(warnings)
    .filter(([k]) => k.startsWith('vehicle.') && !skip.has(k))
    .map(([, msg]) => msg);
}
