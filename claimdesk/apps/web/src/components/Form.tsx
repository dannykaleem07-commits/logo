/**
 * Form fields. Every field is controlled and takes `value` / `onChange` with the domain type:
 *  - MoneyInput: people type pounds, the value is integer pence (or null when empty).
 *  - DateInput: ISODate (YYYY-MM-DD). DateTimeInput: ISODateTime (UTC ISO string).
 *  - Select: string union values.
 */
import { useEffect, useId, useState, type ReactNode, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes } from 'react';
import type { ISODate, ISODateTime, Pence } from '@ccguk/domain';
import { isMoneyText, penceToPoundsText, poundsTextToPence } from '../lib/money';
import { fromDateTimeLocalValue, toDateTimeLocalValue } from '../lib/dates';

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
  children: ReactNode;
  htmlFor?: string;
}

export function Field({ label, hint, error, required, className = '', children, htmlFor }: FieldProps) {
  return (
    <div className={`field ${className}`.trim()}>
      {label && (
        <label className="field-label" htmlFor={htmlFor}>
          {label}
          {required && (
            <span className="req" aria-hidden="true">
              *
            </span>
          )}
        </label>
      )}
      {children}
      {error ? <div className="field-error" role="alert">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

type BaseInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  className?: string;
};

export interface TextInputProps extends BaseInputProps {
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'email' | 'tel' | 'search' | 'url' | 'password' | 'number';
  inputClassName?: string;
}

export function TextInput({ label, hint, error, required, className, value, onChange, type = 'text', inputClassName = '', id, ...rest }: TextInputProps) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className} htmlFor={inputId}>
      <input id={inputId} type={type} className={`input ${inputClassName}`.trim()} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined} required={required} {...rest} />
    </Field>
  );
}

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  className?: string;
  value: string;
  onChange: (value: string) => void;
}

export function TextArea({ label, hint, error, required, className, value, onChange, id, ...rest }: TextAreaProps) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className} htmlFor={inputId}>
      <textarea id={inputId} className="textarea" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined} required={required} {...rest} />
    </Field>
  );
}

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<V extends string> extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  className?: string;
  value: V | '';
  onChange: (value: V | '') => void;
  options: SelectOption<V>[];
  placeholder?: string;
}

export function Select<V extends string>({ label, hint, error, required, className, value, onChange, options, placeholder, id, ...rest }: SelectProps<V>) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className} htmlFor={inputId}>
      <select id={inputId} className="select" value={value} onChange={(e) => onChange(e.target.value as V | '')} aria-invalid={error ? true : undefined} required={required} {...rest}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export interface MoneyInputProps extends Omit<BaseInputProps, 'placeholder'> {
  value: Pence | null;
  onChange: (pence: Pence | null) => void;
  placeholder?: string;
  allowNegative?: boolean;
}

/** Pounds in the box, pence in the model. Text state is local so "12." can be typed; commits on each valid keystroke. */
export function MoneyInput({ label, hint, error, required, className, value, onChange, placeholder = '0.00', allowNegative = false, id, ...rest }: MoneyInputProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const [text, setText] = useState(() => penceToPoundsText(value));
  const [localError, setLocalError] = useState<string | undefined>();
  // resync when the model changes from outside (e.g. form reset) and it no longer matches the text
  useEffect(() => {
    const parsed = poundsTextToPence(text);
    if ((value ?? null) !== (parsed ?? null)) setText(penceToPoundsText(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Field label={label} hint={hint} error={error ?? localError} required={required} className={className} htmlFor={inputId}>
      <div className="input-group">
        <span className="input-prefix" aria-hidden="true">
          £
        </span>
        <input
          id={inputId}
          type="text"
          inputMode="decimal"
          className="input"
          placeholder={placeholder}
          value={text}
          aria-invalid={error || localError ? true : undefined}
          required={required}
          onChange={(e) => {
            const t = e.target.value;
            setText(t);
            if (t.trim() === '') {
              setLocalError(undefined);
              onChange(null);
              return;
            }
            if (!isMoneyText(t) || (!allowNegative && t.trim().startsWith('-'))) {
              setLocalError('Enter an amount in pounds, e.g. 1287.50');
              return;
            }
            setLocalError(undefined);
            onChange(poundsTextToPence(t));
          }}
          onBlur={() => {
            const parsed = poundsTextToPence(text);
            if (parsed !== null) setText(penceToPoundsText(parsed));
          }}
          {...rest}
        />
      </div>
    </Field>
  );
}

export interface DateInputProps extends BaseInputProps {
  value: ISODate | '';
  onChange: (value: ISODate | '') => void;
}

export function DateInput({ label, hint, error, required, className, value, onChange, id, ...rest }: DateInputProps) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className} htmlFor={inputId}>
      <input id={inputId} type="date" className="input" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined} required={required} {...rest} />
    </Field>
  );
}

export interface DateTimeInputProps extends BaseInputProps {
  value: ISODateTime | '';
  onChange: (value: ISODateTime | '') => void;
}

/** datetime-local in the browser's zone; the model holds a UTC ISO string. */
export function DateTimeInput({ label, hint, error, required, className, value, onChange, id, ...rest }: DateTimeInputProps) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className} htmlFor={inputId}>
      <input
        id={inputId}
        type="datetime-local"
        className="input"
        value={toDateTimeLocalValue(value)}
        onChange={(e) => onChange(fromDateTimeLocalValue(e.target.value))}
        aria-invalid={error ? true : undefined}
        required={required}
        {...rest}
      />
    </Field>
  );
}

export function Checkbox({ label, checked, onChange, hint, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <div className="field-hint">{hint}</div>}
      </span>
    </label>
  );
}

/** Tri-state yes/no (undefined = not answered). */
export function YesNo({ label, value, onChange, hint, error, required }: { label: ReactNode; value: boolean | undefined; onChange: (v: boolean) => void; hint?: ReactNode; error?: string; required?: boolean }) {
  return (
    <Field label={label} hint={hint} error={error} required={required}>
      <div className="yesno" role="group">
        <button type="button" aria-pressed={value === true} onClick={() => onChange(true)}>
          Yes
        </button>
        <button type="button" aria-pressed={value === false} onClick={() => onChange(false)}>
          No
        </button>
      </div>
    </Field>
  );
}
