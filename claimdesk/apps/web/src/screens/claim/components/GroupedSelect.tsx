import { useId, type ReactNode } from 'react';
import { Field } from '../../../components/Form';

export interface OptionGroup<V extends string> {
  label: string;
  options: Array<{ value: V; label: string; disabled?: boolean }>;
}

export interface GroupedSelectProps<V extends string> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
  value: V | '';
  onChange: (value: V | '') => void;
  groups: OptionGroup<V>[];
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  id?: string;
}

/** A `<select>` with `<optgroup>`s (the shared Select is flat). Same Field chrome as components/Form. */
export function GroupedSelect<V extends string>({ label, hint, error, required, className, value, onChange, groups, placeholder, autoFocus, disabled, id }: GroupedSelectProps<V>) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className} htmlFor={inputId}>
      <select id={inputId} className="select" value={value} onChange={(e) => onChange(e.target.value as V | '')} aria-invalid={error ? true : undefined} required={required} autoFocus={autoFocus} disabled={disabled}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </Field>
  );
}
