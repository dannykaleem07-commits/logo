import type { StepProps } from './NewClaimPage';
import { DISCLOSURE_TEXT, DISCLOSURE_TITLE, handlerOptions, type FnolChannel } from './fnol';
import { useMe, useUsers } from '../../../api/hooks';
import { Checkbox, Select } from '../../../components/Form';

const CHANNELS: Array<{ value: FnolChannel; label: string }> = [
  { value: 'phone', label: 'Phone (accident line)' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'web_form', label: 'Web form' },
  { value: 'email', label: 'Email' },
  { value: 'in_person', label: 'In person' }
];

/** Step 1 — the recording disclosure is shown first and must be acknowledged before anything else is captured. */
export function StepDisclosure({ state, update, errors, warnings = {} }: StepProps) {
  const me = useMe().data ?? null;
  const users = useUsers().data ?? [];
  const handlers = handlerOptions(users, me, state.handlerId);
  const handlerName = (id: string) => handlers.find((h) => h.value === id)?.name ?? id;
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
        <Select
          label="Handler"
          value={state.handlerId}
          onChange={(v) => update((s) => ({ ...s, handlerId: v ?? '', disclosure: s.disclosure.acknowledged ? { ...s.disclosure, acknowledgedBy: v ? handlerName(v) : '' } : s.disclosure }))}
          options={handlers.map(({ value, label }) => ({ value, label }))}
          placeholder="Choose the handler"
          hint="Defaults to you. The claim is assigned to this person."
        />
      </div>
      <Checkbox
        label={<strong>The disclosure was read to the client and they agreed to continue.</strong>}
        checked={state.disclosure.acknowledged}
        onChange={(v) => update((s) => ({ ...s, disclosure: { ...s.disclosure, acknowledged: v, readAt: v ? new Date().toISOString() : '', acknowledgedBy: v && s.handlerId ? handlerName(s.handlerId) : '' } }))}
      />
      {errors['disclosure'] ? (
        <div className="field-error" role="alert">
          {errors['disclosure']}
        </div>
      ) : warnings['disclosure'] ? (
        <div className="field-warning manager-field-warning" role="status">
          {warnings['disclosure']} Record the disclosure on the claim as soon as it is given.
        </div>
      ) : null}
    </div>
  );
}
