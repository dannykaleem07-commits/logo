import { useCallback, useRef, useState } from 'react';
import type { ApiError } from '../api/client';
import { describeErrorDetails } from '../lib/errorDetails';
import { Button } from './Button';
import { TextInput } from './Form';
import { Modal } from './Modal';

export const OVERRIDE_PROMPT_TITLE = 'This is blocked — override as manager?';
const DEFAULT_REASON = 'Manager override';
const REASON_MAX = 500;

export interface OverridePromptProps {
  /** The refusal to offer an override for; null = closed. */
  error: ApiError | null;
  /** Pre-filled reason (the banner's reason, default "Manager override"). */
  defaultReason?: string;
  busy?: boolean;
  onCancel: () => void;
  onOverride: (reason: string) => void;
}

/**
 * The global "Override as manager" dialog (docs/V03-MANAGER-MODE-HIRE-PRICING.md §A.1 point 5): the plain-English rule,
 * the server's message, the details, any extra warning in red and a reason box. Rendered by the ManagerModeProvider.
 */
export function OverridePrompt({ error, defaultReason = DEFAULT_REASON, busy = false, onCancel, onOverride }: OverridePromptProps) {
  if (!error) return null;
  // Keyed on the error so the reason box starts fresh for each refusal.
  return <OverridePromptBody key={`${error.code}:${error.url}:${error.message}`} error={error} defaultReason={defaultReason} busy={busy} onCancel={onCancel} onOverride={onOverride} />;
}

function OverridePromptBody({ error, defaultReason, busy, onCancel, onOverride }: Required<Omit<OverridePromptProps, 'error'>> & { error: ApiError }) {
  const [reason, setReason] = useState(defaultReason || DEFAULT_REASON);
  // A stable onClose: the dialog must never re-take focus while the reason is typed (docs/V03 §D.1).
  const latest = useRef({ busy, onCancel });
  latest.current = { busy, onCancel };
  const close = useCallback(() => {
    if (!latest.current.busy) latest.current.onCancel();
  }, []);
  const lines = describeErrorDetails(error.code, error.details);
  const label = error.override?.label ?? error.code;
  const warning = error.override?.warning;
  const submit = () => onOverride(reason.trim() || DEFAULT_REASON);
  return (
    <Modal
      open
      title={OVERRIDE_PROMPT_TITLE}
      onClose={close}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={submit} loading={busy}>
            Override as manager
          </Button>
        </>
      }
    >
      <form
        className="override-prompt"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) submit();
        }}
      >
        <p className="override-rule">
          <strong>{label}</strong>
        </p>
        <p className="override-message">{error.message}</p>
        {lines.length > 0 && (
          <ul className="error-details">
            {lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
        {warning && (
          <p className="override-warning" role="alert">
            {warning}
          </p>
        )}
        <TextInput label="Reason" value={reason} onChange={setReason} maxLength={REASON_MAX} hint="Recorded in the audit log with this override." autoFocus />
        <p className="muted small">Override turns manager mode on and sends the same request again.</p>
      </form>
    </Modal>
  );
}
