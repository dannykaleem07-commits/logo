import type { StepProps } from './NewClaimPage';
import { DISCLOSURE_TEXT, DISCLOSURE_TITLE } from './fnol';
import { Checkbox, Select, TextInput } from '../../../components/Form';
import type { CreateClaimBody } from '../../../api/client';

const CHANNELS: Array<{ value: CreateClaimBody['channel']; label: string }> = [
  { value: 'phone', label: 'Phone (accident line)' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'web_form', label: 'Web form' },
  { value: 'email', label: 'Email' },
  { value: 'in_person', label: 'In person' }
];

/** Step 1 — the recording disclosure is shown first and must be acknowledged before anything else is captured. */
export function StepDisclosure({ state, update, errors }: StepProps) {
  return (
    <div className="stack">
      <h2>{DISCLOSURE_TITLE}</h2>
      <p className="muted small">Read this to the client before taking any detail. The acknowledgement and its time are stored on the claim.</p>
      <div className="disclosure">
        {DISCLOSURE_TEXT.map((p, i) => (
          <p key={i} style={{ marginBottom: i === DISCLOSURE_TEXT.length - 1 ? 0 : 12 }}>
            {p}
          </p>
        ))}
      </div>
      <div className="form-grid">
        <Select label="Channel" value={state.channel} onChange={(v) => v && update({ channel: v })} options={CHANNELS} />
        <TextInput label="Handler (your name or id)" value={state.handlerId} onChange={(v) => update({ handlerId: v })} placeholder="e.g. DK" />
      </div>
      <Checkbox
        label={<strong>The disclosure was read to the client and they agreed to continue.</strong>}
        checked={state.disclosure.acknowledged}
        onChange={(v) => update({ disclosure: { ...state.disclosure, acknowledged: v, readAt: v ? new Date().toISOString() : '', acknowledgedBy: state.handlerId } })}
      />
      {errors['disclosure'] && (
        <div className="field-error" role="alert">
          {errors['disclosure']}
        </div>
      )}
    </div>
  );
}
