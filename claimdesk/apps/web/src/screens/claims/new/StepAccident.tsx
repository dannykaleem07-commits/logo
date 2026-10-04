import type { StepProps } from './NewClaimPage';
import { CIRCUMSTANCES_CAPTION, INJURY_REFERRAL_NOTICE, MIN_CIRCUMSTANCES_CHARS, TAKEN_COLD_LABEL, TP_REG_UNKNOWN_LABEL, WITNESS_RELATIONSHIP_HINT, type AccidentForm } from './fnol';
import type { WitnessInput } from '../../../api/client';
import { Button } from '../../../components/Button';
import { Checkbox, DateTimeInput, TextArea, TextInput, YesNo } from '../../../components/Form';
import { Badge } from '../../../components/Badge';

/** Step 4 — accident, third party, witnesses, injuries (→ referral), roadworthy / driveable / airbags. */
export function StepAccident({ state, update, errors }: StepProps) {
  const a = state.accident;
  const setA = <K extends keyof AccidentForm>(k: K, v: AccidentForm[K]) => update((s) => ({ ...s, accident: { ...s.accident, [k]: v } }));
  const setTp = (k: keyof typeof state.thirdParty) => (v: string) => update((s) => ({ ...s, thirdParty: { ...s.thirdParty, [k]: v } }));
  const setWitness = (i: number, patch: Partial<WitnessInput>) => update((s) => ({ ...s, witnesses: s.witnesses.map((w, idx) => (idx === i ? { ...w, ...patch } : w)) }));
  const removeWitness = (i: number) => update((s) => ({ ...s, witnesses: s.witnesses.filter((_, idx) => idx !== i) }));

  return (
    <div className="stack">
      <h2>Accident</h2>
      <div className="form-grid">
        <DateTimeInput label="Date and time" required value={a.occurredAt} onChange={(v) => setA('occurredAt', v)} error={errors['accident.occurredAt']} max={new Date().toISOString().slice(0, 16)} />
        <TextInput label="Location" required value={a.location} onChange={(v) => setA('location', v)} error={errors['accident.location']} placeholder="Road, junction, town" />
        <TextInput label="Postcode (approx.)" value={a.postcode} onChange={(v) => setA('postcode', v)} inputClassName="input-reg" />
        <div />
        <TextArea
          className="span-2"
          label={
            <>
              Circumstances <Badge tone="navy">{CIRCUMSTANCES_CAPTION}</Badge>
            </>
          }
          required
          value={a.circumstances}
          onChange={(v) => setA('circumstances', v)}
          error={errors['accident.circumstances']}
          hint={`Type what the client says, as they say it (at least ${MIN_CIRCUMSTANCES_CHARS} characters). Ask open questions only ('what happened next?'). Highway Code references and the liability narrative are added by the handler later, not here.`}
          rows={7}
        />
        <div className="span-2">
          <Checkbox label={<strong>{TAKEN_COLD_LABEL}</strong>} checked={a.takenCold} onChange={(v) => setA('takenCold', v)} />
          {errors['accident.takenCold'] && (
            <div className="field-error" role="alert">
              {errors['accident.takenCold']}
            </div>
          )}
        </div>
      </div>

      <div className="grid-3">
        <YesNo label="Police attended?" value={a.policeAttended} onChange={(v) => setA('policeAttended', v)} />
        <TextInput label="Police reference" value={a.policeReference} onChange={(v) => setA('policeReference', v)} disabled={a.policeAttended !== true} />
        <div />
        <YesNo label="CCTV likely available?" value={a.cctvAvailable} onChange={(v) => setA('cctvAvailable', v)} hint="Council / TfL / premises — footage is overwritten within weeks (§7 days 1–7)." />
        <YesNo label="Dashcam footage?" value={a.dashcamAvailable} onChange={(v) => setA('dashcamAvailable', v)} />
        <div />
      </div>

      <fieldset className="fieldset">
        <legend>Third party</legend>
        <div className="form-grid">
          <TextInput label="Third-party registration" value={state.thirdParty.registration} onChange={setTp('registration')} inputClassName="input-reg" error={errors['thirdParty.registration']} placeholder="As given by the client" disabled={state.thirdParty.registrationUnknown} hint="Mandatory intake question: the claim opens with an INTAKE_INCOMPLETE flag until it is recorded or marked unknown." />
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <Checkbox label={TP_REG_UNKNOWN_LABEL} checked={state.thirdParty.registrationUnknown} onChange={(v) => update((s) => ({ ...s, thirdParty: { ...s.thirdParty, registrationUnknown: v, registration: v ? '' : s.thirdParty.registration } }))} />
          </div>
          <TextInput label="Third-party driver name" value={state.thirdParty.driverName} onChange={setTp('driverName')} />
          <TextInput label="Third-party insurer" value={state.thirdParty.insurerName} onChange={setTp('insurerName')} hint="As stated; confirmed via askMID / the insurer later." />
          <TextInput label="Third-party policy number" value={state.thirdParty.insurerPolicyNumber} onChange={setTp('insurerPolicyNumber')} />
          <TextInput className="span-2" label="Third-party contact details" value={state.thirdParty.contact} onChange={setTp('contact')} />
        </div>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Witnesses</legend>
        {state.witnesses.length === 0 && <p className="muted small">No witnesses recorded.</p>}
        <div className="stack-sm">
          {state.witnesses.map((w, i) => (
            <div key={i} className="form-grid" style={{ alignItems: 'end' }}>
              <TextInput label="Name" required value={w.name} onChange={(v) => setWitness(i, { name: v })} error={errors[`witness.${i}.name`]} />
              <TextInput label="Phone / email" value={w.phone ?? ''} onChange={(v) => setWitness(i, { phone: v })} />
              <TextInput label="Relationship to claimant" required value={w.relationshipToClaimant ?? ''} onChange={(v) => setWitness(i, { relationshipToClaimant: v })} error={errors[`witness.${i}.relationship`]} hint={WITNESS_RELATIONSHIP_HINT} />
              <div className="row" style={{ paddingBottom: 4 }}>
                <Checkbox label="Independent (no connection)" checked={w.independent ?? false} onChange={(v) => setWitness(i, { independent: v })} />
                <Button size="sm" variant="ghost" onClick={() => removeWitness(i)}>
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 8 }}>
          <Button size="sm" onClick={() => update((s) => ({ ...s, witnesses: [...s.witnesses, { name: '', phone: '', relationshipToClaimant: '', independent: false }] }))}>
            Add witness
          </Button>
        </div>
      </fieldset>

      <h3>Injuries and vehicle condition</h3>
      <div className="grid-2">
        <YesNo label="Was anyone injured?" required value={a.injuries} onChange={(v) => setA('injuries', v)} error={errors['accident.injuries']} />
        {a.injuries && (
          <div className="stack-sm">
            <div className="notice notice-info" role="status">
              <strong>Referral out — no fee.</strong> {INJURY_REFERRAL_NOTICE}
            </div>
            <TextInput label="Refer to (solicitor / firm)" value={state.injury.referralTo} onChange={(v) => update((s) => ({ ...s, injury: { ...s.injury, referralTo: v } }))} placeholder="Leave blank to assign later" />
            <TextInput label="Injury notes" value={state.injury.notes} onChange={(v) => update((s) => ({ ...s, injury: { ...s.injury, notes: v } }))} placeholder="Who, what, whether seen by a doctor" />
          </div>
        )}
      </div>
      <div className="grid-3">
        <YesNo label="Roadworthy after the accident?" required value={a.roadworthyAfter} onChange={(v) => setA('roadworthyAfter', v)} error={errors['accident.roadworthyAfter']} hint="Lights, tyres, steering, leaks, sharp edges." />
        <YesNo label="Driveable?" required value={a.driveable} onChange={(v) => setA('driveable', v)} error={errors['accident.driveable']} />
        <YesNo label="Airbags deployed?" required value={a.airbagsDeployed} onChange={(v) => setA('airbagsDeployed', v)} error={errors['accident.airbagsDeployed']} />
      </div>
    </div>
  );
}
