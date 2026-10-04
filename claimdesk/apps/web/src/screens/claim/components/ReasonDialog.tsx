import { useState, type ReactNode } from 'react';
import { Modal } from '../../../components/Modal';
import { Button } from '../../../components/Button';
import { TextArea } from '../../../components/Form';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';

export interface ReasonDialogProps {
  open: boolean;
  title: ReactNode;
  /** What is being cleared / confirmed, shown above the reason box. */
  children?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  minLength?: number;
  busy?: boolean;
  error?: unknown;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}

/** "Clear with a reason": the reason is logged by the API, so it must be a real sentence. */
export function ReasonDialog({ open, title, children, confirmLabel = 'Clear with this reason', danger = false, minLength = 3, busy = false, error, onClose, onConfirm }: ReasonDialogProps) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const valid = reason.trim().length >= minLength;
  const close = () => {
    setReason('');
    setTouched(false);
    onClose();
  };
  return (
    <Modal
      open={open}
      title={title}
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            onClick={() => {
              setTouched(true);
              if (valid) onConfirm(reason.trim());
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="stack">
        {children}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (valid) onConfirm(reason.trim());
          }}
        >
          <TextArea label="Reason (logged with your name and the time)" required value={reason} onChange={setReason} rows={3} autoFocus error={touched && !valid ? `Give a reason of at least ${minLength} characters` : undefined} />
        </form>
        <ApiErrorNotice error={error} what="save the reason" />
      </div>
    </Modal>
  );
}
