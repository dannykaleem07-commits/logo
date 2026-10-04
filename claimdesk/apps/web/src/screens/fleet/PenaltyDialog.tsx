import { useEffect, useState } from 'react';
import type { PenaltyNotice } from '@ccguk/domain';
import { formatRegistration } from '@ccguk/domain';
import { isApiError } from '../../api/client';
import { useCreatePenalty } from '../../api/hooks';
import { Button } from '../../components/Button';
import { DateInput, DateTimeInput, MoneyInput, Select, TextArea, TextInput } from '../../components/Form';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { buildPenaltyBody, emptyPenaltyForm, penaltyBasis, PENALTY_KINDS, PENALTY_KIND_LABEL, unitRegistration, validatePenaltyForm, type FleetUnitView, type PenaltyForm, type PenaltyFormErrors } from './fleet';

/** Log a PCN / NIP / charge notice on receipt (BLUEPRINT §3.12). Deadlines are typed from the notice itself. */
export function PenaltyDialog({ open, units, initialUnitId, onClose }: { open: boolean; units: FleetUnitView[]; initialUnitId?: string; onClose: () => void }) {
  const toast = useToast();
  const create = useCreatePenalty();
  const [form, setForm] = useState<PenaltyForm>(() => emptyPenaltyForm(initialUnitId));
  const [errors, setErrors] = useState<PenaltyFormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(emptyPenaltyForm(initialUnitId));
      setErrors({});
      setServerError(null);
    }
  }, [open, initialUnitId]);

  const set = <K extends keyof PenaltyForm>(k: K) => (v: PenaltyForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    const e = validatePenaltyForm(form, new Date());
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    try {
      await create.mutateAsync(buildPenaltyBody(form));
      toast.success('Notice logged — the response clock is running');
      onClose();
    } catch (err) {
      setServerError(isApiError(err) ? `${err.code}: ${err.message}` : (err as Error).message);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Log a penalty notice" size="lg" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} loading={create.isPending}>Log notice</Button></>}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {serverError && (
          <div className="notice notice-danger" role="alert">
            {serverError}
          </div>
        )}
        <div className="form-grid">
          <Select label="Fleet unit" value={form.fleetUnitId} onChange={set('fleetUnitId')} placeholder="Registration on the notice" required error={errors.fleetUnitId} options={units.map((u) => ({ value: u.id, label: `${formatRegistration(unitRegistration(u))} · ${u.vehicle?.make ?? ''} ${u.vehicle?.model ?? ''}`.replace(/\s+/g, ' ').trim() }))} autoFocus />
          <Select<PenaltyNotice['kind']> label="Notice type" value={form.kind} onChange={set('kind')} placeholder="Choose" required error={errors.kind} options={PENALTY_KINDS.map((k) => ({ value: k, label: PENALTY_KIND_LABEL[k] }))} />
          <TextInput label="Issuer" value={form.issuer} onChange={set('issuer')} placeholder="LB Camden · Met Police · TfL" required error={errors.issuer} />
          <TextInput label="Notice number" value={form.noticeNumber} onChange={set('noticeNumber')} required error={errors.noticeNumber} />
          <DateTimeInput label="Contravention at" value={form.contraventionAt} onChange={set('contraventionAt')} required error={errors.contraventionAt} />
          <DateTimeInput label="Notice received at" value={form.receivedAt} onChange={set('receivedAt')} required error={errors.receivedAt} hint="Date of service for the clocks." />
          <MoneyInput label="Amount on the notice" value={form.amountPence} onChange={set('amountPence')} required error={errors.amountPence} />
          <TextInput label="Hire agreement id (if known)" value={form.hireAgreementId} onChange={set('hireAgreementId')} hint="Who had the car at the time. Can be added later with 'Identify hirer'." />
          <DateInput label="Discount deadline" value={form.discountDeadline} onChange={set('discountDeadline')} error={errors.discountDeadline} hint="As printed on the notice (usually 14 days)." />
          <DateInput label="Response deadline" value={form.responseDeadline} onChange={set('responseDeadline')} required error={errors.responseDeadline} hint="As printed on the notice (28 days for s.172 and representations)." />
          <div className="span-2">
            <TextArea label="Notes" value={form.notes} onChange={set('notes')} rows={2} />
          </div>
        </div>
        {form.kind && <p className="basis">{penaltyBasis(form.kind)}</p>}
        <button type="submit" className="sr-only" tabIndex={-1}>
          Save
        </button>
      </form>
    </Modal>
  );
}
