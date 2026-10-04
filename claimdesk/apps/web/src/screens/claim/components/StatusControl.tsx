import { useState } from 'react';
import type { ClaimStatus } from '@ccguk/domain';
import { useSetClaimStatus } from '../../../api/hooks';
import { Button } from '../../../components/Button';
import { Modal } from '../../../components/Modal';
import { TextArea } from '../../../components/Form';
import { StatusBadge } from '../../../components/Badge';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { CLAIM_STATUSES, claimStatusLabel } from '../../../lib/status';
import { STATUS_REASON_REQUIRED, statusChangeNote } from '../claimFile';

/** Status badge + picker. Changing status posts to /claims/:id/status; a reason is asked for where the API wants one. */
export function StatusControl({ claimId, status, hardStop }: { claimId: string; status: ClaimStatus; hardStop: boolean }) {
  const [target, setTarget] = useState<ClaimStatus | ''>('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const set = useSetClaimStatus(claimId);
  const toast = useToast();
  const needsReason = target ? STATUS_REASON_REQUIRED.has(target) : false;
  const valid = Boolean(target) && (!needsReason || reason.trim().length >= 3);
  const close = () => {
    setTarget('');
    setReason('');
    setTouched(false);
    set.reset();
  };
  const submit = () => {
    setTouched(true);
    if (!valid || !target) return;
    set.mutate(
      { status: target, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(`Status changed to ${claimStatusLabel(target)}`);
          close();
        }
      }
    );
  };
  return (
    <span className="header-status">
      <StatusBadge status={status} />
      <select className="select" aria-label="Change status" value="" onChange={(e) => setTarget(e.target.value as ClaimStatus)}>
        <option value="">Change status…</option>
        {CLAIM_STATUSES.filter((s) => s !== status).map((s) => (
          <option key={s} value={s}>
            {claimStatusLabel(s)}
          </option>
        ))}
      </select>
      <Modal
        open={target !== ''}
        title={target ? `Move to ${claimStatusLabel(target)}` : ''}
        onClose={close}
        footer={
          <>
            <Button onClick={close} disabled={set.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={set.isPending} onClick={submit}>
              Change status
            </Button>
          </>
        }
      >
        <div className="stack">
          <div className="row">
            <StatusBadge status={status} /> <span aria-hidden="true">→</span> {target && <StatusBadge status={target} />}
          </div>
          {target && statusChangeNote(target) && <div className="notice notice-info">{statusChangeNote(target)}</div>}
          {hardStop && target && !['declined', 'closed'].includes(target) && (
            <div className="notice notice-danger">
              <strong>Hard stop open.</strong> The API refuses to progress a claim with an uncleared block flag. Clear it (with a reason) first.
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <TextArea label={needsReason ? 'Reason (required)' : 'Reason (optional, goes on the file note)'} required={needsReason} value={reason} onChange={setReason} rows={3} autoFocus error={touched && needsReason && reason.trim().length < 3 ? 'A reason is required for this status' : undefined} />
          </form>
          <ApiErrorNotice error={set.error} what="change the status" />
        </div>
      </Modal>
    </span>
  );
}
