import { useCallback, useRef, useState } from 'react';
import type { ClaimStatus } from '@ccguk/domain';
import { useSetClaimStatus } from '../../../api/hooks';
import { withRelaxed } from '../../../api/client';
import { useManagerMode } from '../../../app/managerMode';
import { MANAGER_WARNING_PREFIX } from '../../../lib/managerMode';
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
  const managerOn = useManagerMode().on;
  const needsReason = target ? STATUS_REASON_REQUIRED.has(target) : false;
  const reasonMissing = needsReason && reason.trim().length < 3;
  // Manager mode: the server uses the override reason as the status reason (0.3 §A.6 B15).
  const reasonRelaxed = managerOn && reasonMissing;
  const valid = Boolean(target) && (!reasonMissing || reasonRelaxed);
  // Stable identity: the dialog never re-takes focus while the reason is typed (docs/V03 §D.1).
  const resetRef = useRef(set.reset);
  resetRef.current = set.reset;
  const close = useCallback(() => {
    setTarget('');
    setReason('');
    setTouched(false);
    resetRef.current();
  }, []);
  const submit = () => {
    setTouched(true);
    if (!valid || !target) return;
    const body = { status: target, reason: reason.trim() || undefined };
    set.mutate(
      reasonRelaxed ? withRelaxed(body, ['status.reason']) : body,
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
          {hardStop && target && !['declined', 'closed'].includes(target) &&
            (managerOn ? (
              <div className="manager-note" role="status">
                Manager mode will override the hard stop; the flag stays on the file.
              </div>
            ) : (
              <div className="notice notice-danger">
                <strong>Hard stop open.</strong> The API refuses to progress a claim with an uncleared block flag. Clear it (with a reason) first.
              </div>
            ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <TextArea label={needsReason ? 'Reason (required)' : 'Reason (optional, goes on the file note)'} required={needsReason} value={reason} onChange={setReason} rows={3} autoFocus error={touched && reasonMissing && !reasonRelaxed ? 'A reason is required for this status' : undefined} />
            {reasonRelaxed && <div className="xs" style={{ color: 'var(--amber)', marginTop: 4 }}>{MANAGER_WARNING_PREFIX}no reason given — the manager-mode reason is recorded instead.</div>}
          </form>
          <ApiErrorNotice error={set.error} what="change the status" />
        </div>
      </Modal>
    </span>
  );
}
