import { useEffect, useState } from 'react';
import type { PenaltyNotice } from '@ccguk/domain';
import { isApiError } from '../../api/client';
import { useTransitionPenalty } from '../../api/hooks';
import { Button } from '../../components/Button';
import { TextArea, TextInput } from '../../components/Form';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { PENALTY_STAGE_LABEL, transitionNeedsHire, type PenaltyView } from './fleet';

/** Move a notice to its next stage via POST /fleet/penalties/:id/transition. The API may refuse; its message is shown. */
export function TransitionDialog({ notice, stage, onClose }: { notice: PenaltyView | null; stage: PenaltyNotice['stage'] | null; onClose: () => void }) {
  const toast = useToast();
  const transition = useTransitionPenalty();
  const [hireAgreementId, setHireAgreementId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const open = Boolean(notice && stage);

  useEffect(() => {
    if (open) {
      setHireAgreementId(notice?.hireAgreementId ?? '');
      setNote('');
      setError(null);
    }
  }, [open, notice]);

  if (!notice || !stage) return null;
  const needsHire = transitionNeedsHire(stage);
  const canSubmit = !needsHire || hireAgreementId.trim().length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    try {
      await transition.mutateAsync({ id: notice.id, body: { stage, note: note.trim() || undefined, hireAgreementId: needsHire ? hireAgreementId.trim() : undefined } });
      toast.success(`Notice ${notice.noticeNumber} → ${PENALTY_STAGE_LABEL[stage]}`);
      onClose();
    } catch (e) {
      setError(isApiError(e) ? `${e.code}: ${e.message}` : (e as Error).message);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`${notice.noticeNumber}: mark as ${PENALTY_STAGE_LABEL[stage].toLowerCase()}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} disabled={!canSubmit} loading={transition.isPending}>Confirm</Button></>}>
      <div className="stack">
        <p className="basis">{stageBasis(stage)}</p>
        {needsHire && <TextInput label="Hire agreement id" value={hireAgreementId} onChange={setHireAgreementId} required hint="The signed agreement that puts a named hirer in the vehicle at the contravention time. Its claim file receives the liability-transfer notice." autoFocus />}
        <TextArea label="Note (logged with the transition)" value={note} onChange={setNote} rows={3} />
        {error && (
          <div className="notice notice-danger" role="alert">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

function stageBasis(stage: PenaltyNotice['stage']): string {
  switch (stage) {
    case 'hirer_identified':
      return 'Identify who had the vehicle from the hire agreement and the handover/collection times. This unlocks the liability transfer (Road Traffic (Owner Liability) Regs 2000 Sch 2 particulars) or the s.172 response naming the driver.';
    case 'liability_transferred':
      return 'Record that the transfer notice / s.172 response has been sent (generate and approve the document first — nothing is sent automatically). The deadline clock stops on the sent date, not today.';
    case 'representations':
      return 'Formal representations to the issuer within 28 days of service. Keep the grounds factual; attach the hire agreement where the hirer is liable.';
    case 'appeal':
      return 'Representations rejected: appeal to the tribunal (London Tribunals / Traffic Penalty Tribunal) or POPLA / IAS within 28 days of the notice of rejection.';
    case 'paid':
      return 'Record payment. If the hirer was liable, raise the recharge against the hire agreement on the claim ledger (append-only).';
    case 'cancelled':
      return 'The issuer has cancelled the notice. Keep the correspondence as evidence on the unit.';
    case 'escalated':
      return 'Charge certificate / order for recovery stage. Check the V5C address history: an order served to a stale address can be challenged (lesson l).';
    case 'received':
      return 'Notice logged; the response clock runs from the date of service.';
  }
}
