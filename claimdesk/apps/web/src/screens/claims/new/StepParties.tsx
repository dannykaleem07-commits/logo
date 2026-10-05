import type { StepProps } from './NewClaimPage';
import type { PartyForm } from './fnol';
import { Checkbox, DateInput, TextInput } from '../../../components/Form';

/** Shown under the client's own insurer and policy number (0.3 §E8). */
export const INTAKE_REMINDER_HINT = 'If unknown, the claim opens with a reminder to get it.';

function PartyFields({ value, onChange, errors, warnings, prefix, showLicence }: { value: PartyForm; onChange: (p: PartyForm) => void; errors: Record<string, string>; warnings: Record<string, string>; prefix: string; showLicence?: boolean }) {
  const set = (k: keyof PartyForm) => (v: string) => onChange({ ...value, [k]: v });
  return (
    <div className="form-grid">
      <TextInput label="Full legal name" required value={value.name} onChange={set('name')} error={errors[`${prefix}.name`]} warning={warnings[`${prefix}.name`]} autoComplete="off" />
      <DateInput label="Date of birth" value={value.dateOfBirth} onChange={set('dateOfBirth')} />
      <TextInput label="Mobile / phone" type="tel" value={value.phone} onChange={set('phone')} error={errors[`${prefix}.contact`]} warning={warnings[`${prefix}.contact`]} />
      <TextInput label="Email" type="email" value={value.email} onChange={set('email')} error={errors[`${prefix}.email`]} warning={warnings[`${prefix}.email`]} />
      <TextInput label="Address line 1" value={value.line1} onChange={set('line1')} />
      <TextInput label="Address line 2" value={value.line2} onChange={set('line2')} />
      <TextInput label="Town" value={value.town} onChange={set('town')} />
      <TextInput label="Postcode" value={value.postcode} onChange={set('postcode')} inputClassName="input-reg" />
      {showLicence && <TextInput label="Driving licence number" value={value.drivingLicenceNumber} onChange={set('drivingLicenceNumber')} hint="Needed for the hire agreement; optional at FNOL." />}
    </div>
  );
}

/** Step 2 — claimant (keeper) and the driver at the time, plus the client's own insurer. */
export function StepParties({ state, update, errors, warnings = {} }: StepProps) {
  return (
    <div className="stack">
      <h2>Claimant</h2>
      <PartyFields value={state.claimant} onChange={(claimant) => update({ claimant })} errors={errors} warnings={warnings} prefix="claimant" showLicence={state.driverSameAsClaimant} />
      <fieldset className="fieldset">
        <legend>Client's own insurer</legend>
        <div className="form-grid">
          <TextInput label="Insurer" value={state.clientInsurer.name} onChange={(v) => update((s) => ({ ...s, clientInsurer: { ...s.clientInsurer, name: v } }))} hint={INTAKE_REMINDER_HINT} />
          <TextInput label="Policy number" value={state.clientInsurer.policyNumber} onChange={(v) => update((s) => ({ ...s, clientInsurer: { ...s.clientInsurer, policyNumber: v } }))} hint={`From the certificate or schedule. ${INTAKE_REMINDER_HINT}`} />
        </div>
      </fieldset>
      <h2>Driver</h2>
      <Checkbox label="The claimant was driving" checked={state.driverSameAsClaimant} onChange={(v) => update({ driverSameAsClaimant: v })} />
      {!state.driverSameAsClaimant && <PartyFields value={state.driver} onChange={(driver) => update({ driver })} errors={errors} warnings={warnings} prefix="driver" showLicence />}
    </div>
  );
}
