import type { InterventionOffer } from '@ccguk/domain';
import type { StepProps } from './NewClaimPage';
import { SCRIPT_GUARD_NOTE, SCRIPT_GUARD_QUESTION, type OfferForm } from './fnol';
import { Checkbox, DateTimeInput, MoneyInput, Select, TextArea, TextInput, YesNo } from '../../../components/Form';

const CHANNELS: Array<{ value: InterventionOffer['channel']; label: string }> = [
  { value: 'phone', label: 'Phone call' },
  { value: 'sms', label: 'SMS' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'Email' },
  { value: 'letter', label: 'Letter' },
  { value: 'portal', label: 'Portal' },
  { value: 'via_client', label: 'Told to the client in person' }
];

const DECISIONS: Array<{ value: InterventionOffer['clientDecision']; label: string }> = [
  { value: 'pending', label: 'Not decided yet' },
  { value: 'accepted', label: 'Client accepted it' },
  { value: 'declined', label: 'Client declined it' }
];

/**
 * The script guard, at the end of the accident step (0.3 §E6). A "yes" is captured as an intervention-register entry.
 * No advice is given here.
 */
export function StepScriptGuard({ state, update, errors, warnings = {} }: StepProps) {
  const o = state.offer;
  const set = <K extends keyof OfferForm>(k: K, v: OfferForm[K]) => update((s) => ({ ...s, offer: { ...s.offer, [k]: v } }));

  return (
    <div className="stack">
      <h2 id="vehicle-offers">Vehicle offers</h2>
      <div className="disclosure" style={{ fontSize: 'var(--fs-lg)' }}>
        “{SCRIPT_GUARD_QUESTION}”
      </div>
      <p className="muted small">{SCRIPT_GUARD_NOTE}</p>
      <YesNo label="Has anyone offered the client a vehicle?" required value={o.offered} onChange={(v) => set('offered', v)} error={errors['offer.offered']} warning={warnings['offer.offered']} />

      {o.offered && (
        <fieldset className="fieldset">
          <legend>Offer details</legend>
          <div className="form-grid">
            <TextInput label="By whom (offeror)" required value={o.offerorName} onChange={(v) => set('offerorName', v)} error={errors['offer.offerorName']} warning={warnings['offer.offerorName']} placeholder="Insurer / company / person named by the client" />
            <Select label="How" value={o.channel} onChange={(v) => v && set('channel', v)} options={CHANNELS} />
            <DateTimeInput label="When" required value={o.receivedAt} onChange={(v) => set('receivedAt', v)} error={errors['offer.receivedAt']} warning={warnings['offer.receivedAt']} />
            <TextInput label="What exactly (vehicle / class)" value={o.vehicleClassOffered} onChange={(v) => set('vehicleClassOffered', v)} error={errors['offer.what']} warning={warnings['offer.what']} placeholder="e.g. 'a small hatchback', 'like-for-like SUV'" />
            <MoneyInput label="Daily rate quoted, if any (£)" value={o.dailyRatePence} onChange={(v) => set('dailyRatePence', v)} hint="Leave blank if no rate was mentioned." />
            <div className="field" style={{ justifyContent: 'flex-end' }}>
              <Checkbox label="Rate stated as including VAT" checked={o.rateIncludesVat} onChange={(v) => set('rateIncludesVat', v)} disabled={o.dailyRatePence === null} />
            </div>
            <MoneyInput label="Excess mentioned (£)" value={o.excessPence} onChange={(v) => set('excessPence', v)} />
            <TextInput label="Mileage limit per day" value={o.mileageLimitPerDay} onChange={(v) => set('mileageLimitPerDay', v)} inputMode="numeric" />
            <YesNo label="Delivery included?" value={o.deliveryIncluded} onChange={(v) => set('deliveryIncluded', v)} />
            <YesNo label="Insurance included?" value={o.insuranceIncluded} onChange={(v) => set('insuranceIncluded', v)} />
            <TextInput label="Duration stated" value={o.durationStated} onChange={(v) => set('durationStated', v)} placeholder="e.g. 'until repairs are done'" />
            <TextArea className="span-2" label="Other terms, in the client's words" value={o.otherTerms} onChange={(v) => set('otherTerms', v)} rows={3} error={!o.vehicleClassOffered ? errors['offer.what'] : undefined} warning={!o.vehicleClassOffered ? warnings['offer.what'] : undefined} />
            <Select label="Client's decision so far" value={o.clientDecision} onChange={(v) => v && set('clientDecision', v)} options={DECISIONS} />
            <TextInput label="Client's reasons, as given" value={o.clientReasons} onChange={(v) => set('clientReasons', v)} placeholder="Record only what the client says" />
          </div>
          <p className="xs muted" style={{ marginTop: 10 }}>
            The suitability assessment and the written reply to the offeror are completed on the claim file (Offers tab) — reply due within 1 working day of the offer.
          </p>
        </fieldset>
      )}
    </div>
  );
}
