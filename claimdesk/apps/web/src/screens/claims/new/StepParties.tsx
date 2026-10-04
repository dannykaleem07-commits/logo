import type { StepProps } from './NewClaimPage';
import type { PartyForm } from './fnol';
import { Checkbox, DateInput, TextInput } from '../../../components/Form';

function PartyFields({ value, onChange, errors, prefix, showLicence }: { value: PartyForm; onChange: (p: PartyForm) => void; errors: Record<string, string>; prefix: string; showLicence?: boolean }) {
  const set = (k: keyof PartyForm) => (v: string) => onChange({ ...value, [k]: v });
  return (
    <div className="form-grid">
      <TextInput label="Full legal name" required value={value.name} onChange={set('name')} error={errors[`${prefix}.name`]} autoComplete="off" />
      <DateInput label="Date of birth" value={value.dateOfBirth} onChange={set('dateOfBirth')} />
      <TextInput label="Mobile / phone" type="tel" value={value.phone} onChange={set('phone')} error={errors[`${prefix}.contact`]} />
      <TextInput label="Email" type="email" value={value.email} onChange={set('email')} error={errors[`${prefix}.email`]} />
      <TextInput label="Address line 1" value={value.line1} onChange={set('line1')} />
      <TextInput label="Address line 2" value={value.line2} onChange={set('line2')} />
      <TextInput label="Town" value={value.town} onChange={set('town')} />
      <TextInput label="Postcode" value={value.postcode} onChange={set('postcode')} inputClassName="input-reg" />
      {showLicence && <TextInput label="Driving licence number" value={value.drivingLicenceNumber} onChange={set('drivingLicenceNumber')} hint="Needed for the hire agreement; optional at FNOL." />}
    </div>
  );
}

/** Step 2 — claimant (keeper) and the driver at the time, plus the client's own insurer. */
export function StepParties({ state, update, errors }: StepProps) {
  return (
    <div className="stack">
      <h2>Claimant</h2>
      <PartyFields value={state.claimant} onChange={(claimant) => update({ claimant })} errors={errors} prefix="claimant" showLicence={state.driverSameAsClaimant} />
      <fieldset className="fieldset">
        <legend>Client's own insurer</legend>
        <div className="form-grid">
          <TextInput label="Insurer" value={state.clientInsurer.name} onChange={(v) => update({ clientInsurer: { ...state.clientInsurer, name: v } })} hint="Mandatory intake question (BLUEPRINT §3.1); if the client does not know it now the claim opens with an INTAKE_INCOMPLETE flag." />
          <TextInput label="Policy number" value={state.clientInsurer.policyNumber} onChange={(v) => update({ clientInsurer: { ...state.clientInsurer, policyNumber: v } })} hint="From the certificate or schedule; the same flag applies until it is recorded." />
        </div>
      </fieldset>
      <h2>Driver</h2>
      <Checkbox label="The claimant was driving" checked={state.driverSameAsClaimant} onChange={(v) => update({ driverSameAsClaimant: v })} />
      {!state.driverSameAsClaimant && <PartyFields value={state.driver} onChange={(driver) => update({ driver })} errors={errors} prefix="driver" showLicence />}
    </div>
  );
}
