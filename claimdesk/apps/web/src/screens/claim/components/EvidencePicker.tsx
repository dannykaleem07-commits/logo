import type { Evidence } from '@ccguk/domain';
import { Field } from '../../../components/Form';
import { evidenceKindLabel, shortHash, sortEvidence } from '../lib/evidence';

export interface EvidencePickerProps {
  evidence: Evidence[];
  value: string[];
  onChange: (ids: string[]) => void;
  label?: string;
  hint?: string;
  error?: string;
  /** Single choice (radio-like) rather than multiple. */
  single?: boolean;
  /** Show only these kinds (e.g. adverts for comparables). */
  kinds?: Evidence['kind'][];
  max?: number;
}

/** Attach existing evidence by ticking it. Evidence itself is write-once; this only references it. */
export function EvidencePicker({ evidence, value, onChange, label = 'Attach evidence', hint, error, single = false, kinds, max = 8 }: EvidencePickerProps) {
  const items = sortEvidence(kinds ? evidence.filter((e) => kinds.includes(e.kind)) : evidence).slice(0, 200);
  const toggle = (id: string) => {
    if (single) return onChange(value.includes(id) ? [] : [id]);
    if (value.includes(id)) return onChange(value.filter((v) => v !== id));
    if (value.length >= max) return;
    onChange([...value, id]);
  };
  return (
    <Field label={label} hint={hint ?? (items.length === 0 ? 'No evidence on the file yet — upload it on the Evidence tab first.' : single ? 'Pick one item.' : `Tick up to ${max}.`)} error={error}>
      <div className="stack-sm" style={{ maxHeight: 180, overflow: 'auto', border: '1px solid var(--line-2)', borderRadius: 'var(--r-md)', padding: 8 }} role={single ? 'radiogroup' : 'group'}>
        {items.length === 0 && <span className="xs muted">Nothing to attach.</span>}
        {items.map((e) => (
          <label key={e.id} className="check" style={{ fontSize: 'var(--fs-xs)' }}>
            <input type={single ? 'radio' : 'checkbox'} checked={value.includes(e.id)} onChange={() => toggle(e.id)} />
            <span>
              <strong>{evidenceKindLabel(e.kind)}</strong> · {e.filename} · <span className="hash" title={e.sha256}>{shortHash(e.sha256, 8)}</span>
              {e.description ? <span className="muted"> — {e.description}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </Field>
  );
}
