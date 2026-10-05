/**
 * Form fields. Every field is controlled and takes `value` / `onChange` with the domain type:
 *  - MoneyInput: people type pounds, the value is integer pence (or null when empty).
 *  - DateInput: ISODate (YYYY-MM-DD). DateTimeInput: ISODateTime (UTC ISO string).
 *  - Select: string union values.
 * Every field also takes `warning` (amber, role=status): shown when there is no `error`; error > warning > hint.
 * Manager mode turns relaxed validation errors into warnings (docs/V03-MANAGER-MODE-HIRE-PRICING.md §A.5, §D.2).
 */
import { useEffect, useId, useRef, useState, type ReactNode, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes } from 'react';
import type { ISODate, ISODateTime, Pence } from '@ccguk/domain';
import { isMoneyText, penceToPoundsText, poundsTextToPence } from '../lib/money';
import { fromDateTimeLocalValue, isISODate, toDateTimeLocalValue } from '../lib/dates';

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  /** Amber "you may carry on" message (e.g. a check relaxed in manager mode). Hidden while there is an error. */
  warning?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
  htmlFor?: string;
}

/** Message under a field: error > warning > hint. */
function FieldMessage({ error, warning, hint }: { error?: string; warning?: ReactNode; hint?: ReactNode }) {
  if (error) return <div className="field-error" role="alert">{error}</div>;
  if (warning)
    return (
      <div className="field-warning" role="status">
        <span className="field-warning-icon" aria-hidden="true">
          ⚠
        </span>{' '}
        {warning}
      </div>
    );
  if (hint) return <div className="field-hint">{hint}</div>;
  return null;
}

export function Field({ label, hint, error, warning, required, className = '', children, htmlFor }: FieldProps) {
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
      <FieldMessage error={error} warning={warning} hint={hint} />
    </div>
  );
}

type BaseInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  warning?: ReactNode;
  className?: string;
};

export interface TextInputProps extends BaseInputProps {
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'email' | 'tel' | 'search' | 'url' | 'password' | 'number';
  inputClassName?: string;
}

export function TextInput({ label, hint, error, warning, required, className, value, onChange, type = 'text', inputClassName = '', id, ...rest }: TextInputProps) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} warning={warning} required={required} className={className} htmlFor={inputId}>
      <input id={inputId} type={type} className={`input ${inputClassName}`.trim()} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined} required={required} {...rest} />
    </Field>
  );
}

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  warning?: ReactNode;
  className?: string;
  value: string;
  onChange: (value: string) => void;
}

export function TextArea({ label, hint, error, warning, required, className, value, onChange, id, ...rest }: TextAreaProps) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} warning={warning} required={required} className={className} htmlFor={inputId}>
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
  warning?: ReactNode;
  className?: string;
  value: V | '';
  onChange: (value: V | '') => void;
  options: SelectOption<V>[];
  placeholder?: string;
}

export function Select<V extends string>({ label, hint, error, warning, required, className, value, onChange, options, placeholder, id, ...rest }: SelectProps<V>) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} warning={warning} required={required} className={className} htmlFor={inputId}>
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
export function MoneyInput({ label, hint, error, warning, required, className, value, onChange, placeholder = '0.00', allowNegative = false, id, ...rest }: MoneyInputProps) {
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
    <Field label={label} hint={hint} error={error ?? localError} warning={warning} required={required} className={className} htmlFor={inputId}>
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

/**
 * Local draft for date / date-time inputs (§D.2). While a value is half typed the browser reports '' — pushing that to
 * the model (and back) lets a parent re-render wipe the half-typed segments. So the box keeps its own draft, the model
 * only ever receives a complete value, an emptied box is pushed ('') on blur, and a model change from outside (a reset)
 * resyncs the draft only when it differs from the draft and the box is not focused.
 */
function useDraftValue<M extends string>(value: M | '', toDraft: (v: M | '') => string, fromDraft: (d: string) => M | '') {
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(() => toDraft(value));
  useEffect(() => {
    if (ref.current && ref.current === document.activeElement) return;
    setDraft((d) => ((fromDraft(d) || '') === (value || '') ? d : toDraft(value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return { ref, draft, setDraft };
}

const dateDraft = (v: ISODate | ''): string => v;
const dateFromDraft = (d: string): ISODate | '' => (isISODate(d) ? d : '');

export function DateInput({ label, hint, error, warning, required, className, value, onChange, id, onBlur, ...rest }: DateInputProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const { ref, draft, setDraft } = useDraftValue<ISODate>(value, dateDraft, dateFromDraft);
  return (
    <Field label={label} hint={hint} error={error} warning={warning} required={required} className={className} htmlFor={inputId}>
      <input
        ref={ref}
        id={inputId}
        type="date"
        className="input"
        value={draft}
        onChange={(e) => {
          const d = e.target.value;
          setDraft(d);
          const parsed = dateFromDraft(d);
          if (parsed !== '' && parsed !== value) onChange(parsed);
        }}
        onBlur={(e) => {
          if (dateFromDraft(draft) === '' && value !== '') onChange('');
          onBlur?.(e);
        }}
        aria-invalid={error ? true : undefined}
        required={required}
        {...rest}
      />
    </Field>
  );
}

export interface DateTimeInputProps extends BaseInputProps {
  value: ISODateTime | '';
  onChange: (value: ISODateTime | '') => void;
}

/** datetime-local in the browser's zone; the model holds a UTC ISO string. Keeps a local draft while typing (§D.2). */
export function DateTimeInput({ label, hint, error, warning, required, className, value, onChange, id, onBlur, ...rest }: DateTimeInputProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const { ref, draft, setDraft } = useDraftValue<ISODateTime>(value, toDateTimeLocalValue, fromDateTimeLocalValue);
  return (
    <Field label={label} hint={hint} error={error} warning={warning} required={required} className={className} htmlFor={inputId}>
      <input
        ref={ref}
        id={inputId}
        type="datetime-local"
        className="input"
        value={draft}
        onChange={(e) => {
          const d = e.target.value;
          setDraft(d);
          const parsed = fromDateTimeLocalValue(d);
          if (parsed !== '' && parsed !== value) onChange(parsed);
        }}
        onBlur={(e) => {
          if (fromDateTimeLocalValue(draft) === '' && value !== '') onChange('');
          onBlur?.(e);
        }}
        aria-invalid={error ? true : undefined}
        required={required}
        {...rest}
      />
    </Field>
  );
}

export function Checkbox({ label, checked, onChange, hint, warning, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode; warning?: ReactNode; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        <FieldMessage warning={warning} hint={hint} />
      </span>
    </label>
  );
}

/** Tri-state yes/no (undefined = not answered). */
export function YesNo({ label, value, onChange, hint, error, warning, required }: { label: ReactNode; value: boolean | undefined; onChange: (v: boolean) => void; hint?: ReactNode; error?: string; warning?: ReactNode; required?: boolean }) {
  return (
    <Field label={label} hint={hint} error={error} warning={warning} required={required}>
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
