/**
 * End hire. A future end (a booked return) is only a warning; an end before the start is an error that manager mode
 * turns into a warning (the server records the override and flags the claim until the dates are corrected).
 */
import { useState } from 'react';
import { useStableCallback } from './useStableCallback';
import type { HireAgreement, HireEndTrigger } from '@ccguk/domain';
import { withRelaxed } from '../../../../api/client';
import { useEndHireV2 } from '../../../../api/hireApi';
import { useManagerMode } from '../../../../app/managerMode';
import { ApiErrorNotice } from '../../../../components/ApiErrorNotice';
import { Button } from '../../../../components/Button';
import { DateTimeInput, Select, TextArea, TextInput } from '../../../../components/Form';
import { Modal } from '../../../../components/Modal';
import { useToast } from '../../../../components/Toast';
import { endHireBodyFrom, HIRE_TRIGGERS, triggerLabel, type EndHireForm } from '../../lib/hire';

const emptyEnd = (nowIso: string): EndHireForm => ({ endTrigger: '', endAt: nowIso, collectedAt: '', odometerIn: '', reason: '' });

export function EndHireDialog({ claimId, hire, nowIso, onClose }: { claimId: string; hire: HireAgreement | null; nowIso: string; onClose: () => void }) {
  const [form, setForm] = useState<EndHireForm>(() => emptyEnd(nowIso));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const end = useEndHireV2(claimId);
  const toast = useToast();
  const manager = useManagerMode();
  const trigger = HIRE_TRIGGERS.find((t) => t.value === form.endTrigger);
  const set = <K extends keyof EndHireForm>(key: K, value: EndHireForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const close = useStableCallback(() => {
    setForm(emptyEnd(new Date().toISOString()));
    setErrors({});
    end.reset();
    onClose();
  });
  const warnings = hire ? (endHireBodyFrom(form, hire, new Date().toISOString(), { managerOn: manager.on }).warnings ?? {}) : {};
  const submit = () => {
    if (!hire) return;
    const r = endHireBodyFrom(form, hire, new Date().toISOString(), { managerOn: manager.on });
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    end.mutate(
      { hireId: hire.id, body: r.relaxed ? withRelaxed(r.body, r.relaxed) : r.body },
      {
        onSuccess: (res) => {
          const days = res.calculation ? ` — ${res.calculation.days} day${res.calculation.days === 1 ? '' : 's'}` : '';
          toast.success(`Hire ${hire.agreementNumber} ended${days} (${triggerLabel(HIRE_TRIGGERS, r.body.endTrigger)})`);
          close();
        }
      }
    );
  };
  return (
    <Modal
      open={hire !== null}
      title={`End hire ${hire?.agreementNumber ?? ''}`}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={end.isPending} onClick={submit}>
            End hire
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Select<HireEndTrigger> label="What ended the hire" required value={form.endTrigger} onChange={(v) => set('endTrigger', v)} options={HIRE_TRIGGERS.map((t) => ({ value: t.value, label: t.label }))} placeholder="Choose the trigger…" error={errors.endTrigger} autoFocus />
        {trigger && <div className="notice notice-info xs">{trigger.basis}</div>}
        <DateTimeInput label="Hire ended at" required value={form.endAt} onChange={(v) => set('endAt', v)} error={errors.endAt} warning={warnings.endAt} hint="Past dates are fine — late entries are recorded as such." />
        <div className="form-grid">
          <DateTimeInput label="Vehicle collected at" value={form.collectedAt} onChange={(v) => set('collectedAt', v)} />
          <TextInput label="Odometer in (miles)" value={form.odometerIn} onChange={(v) => set('odometerIn', v)} inputMode="numeric" error={errors.odometerIn} hint="Photograph it: delivery and collection readings both count" />
        </div>
        <TextArea label={form.endTrigger === 'manual' ? 'Reason (required)' : 'Note for the chronology'} value={form.reason} onChange={(v) => set('reason', v)} rows={2} error={errors.reason} required={form.endTrigger === 'manual'} />
        <ApiErrorNotice error={end.error} what="end the hire" />
      </form>
    </Modal>
  );
}
