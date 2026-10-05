/**
 * Edit dates & rate (docs/V03-MANAGER-MODE-HIRE-PRICING.md §C.1). Any hire, running or ended: start, end (blank = still
 * running), what ended it, agreed daily rate and both GTA groups, with a required reason. Nothing is overwritten in
 * the history: the server appends correcting chronology entries, corrects the claimed amount on the ledger with a new
 * row when asked, and records the change in the audit trail. Overlaps and other refusals reach the global
 * "override as manager" prompt automatically.
 */
import { useMemo, useState } from 'react';
import { useStableCallback } from './useStableCallback';
import type { GtaRate, HireEndTrigger } from '@ccguk/domain';
import { formatGBP } from '@ccguk/domain';
import { withRelaxed } from '../../../../api/client';
import { useGtaRates } from '../../../../api/hooks';
import { londonDay, useCorrectHire, type HireListItem } from '../../../../api/hireApi';
import { useManagerMode } from '../../../../app/managerMode';
import { ApiErrorNotice } from '../../../../components/ApiErrorNotice';
import { Button } from '../../../../components/Button';
import { Checkbox, DateTimeInput, MoneyInput, Select, TextArea } from '../../../../components/Form';
import { Modal } from '../../../../components/Modal';
import { useToast } from '../../../../components/Toast';
import { correctHireBodyFrom, correctionPreview, correctionToast, editHireFormFrom, HIRE_TRIGGERS, type EditHireForm } from '../../lib/hire';

/** "S1 · £42.32/day guide" options from the rates in force on the start date, plus the current values. */
function groupOptions(rates: GtaRate[] | undefined, current: string[]): Array<{ value: string; label: string }> {
  const byGroup = new Map<string, GtaRate | undefined>();
  for (const r of rates ?? []) {
    const g = r.group.toUpperCase();
    if (!byGroup.has(g)) byGroup.set(g, r);
  }
  for (const c of current) if (c && !byGroup.has(c.toUpperCase())) byGroup.set(c.toUpperCase(), undefined);
  return [...byGroup.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([g, r]) => ({ value: g, label: r ? `${g} · ${formatGBP(r.dailyRatePence)}/day guide` : `${g} · no guide rate` }));
}

export interface EditHireDialogProps {
  claimId: string;
  hire: HireListItem;
  accidentAt?: string;
  onClose: () => void;
}

/** Mount with `key={hire.id}` while editing; unmount (or render nothing) when closed. */
export function EditHireDialog({ claimId, hire, accidentAt, onClose: onCloseProp }: EditHireDialogProps) {
  const onClose = useStableCallback(onCloseProp);
  const [form, setForm] = useState<EditHireForm>(() => editHireFormFrom(hire, hire.pricing?.clientGtaGroup));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const correct = useCorrectHire(claimId);
  const toast = useToast();
  const manager = useManagerMode();
  const rates = useGtaRates(londonDay(form.startAt) || undefined);
  const set = <K extends keyof EditHireForm>(key: K, value: EditHireForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const nowIso = new Date().toISOString();
  const preview = correctionPreview(hire, form, nowIso);
  const groups = useMemo(() => groupOptions(rates.data, [form.gtaGroup, form.clientGtaGroup, hire.gtaGroup]), [rates.data, form.gtaGroup, form.clientGtaGroup, hire.gtaGroup]);
  // Warnings show while typing (never blocking); errors appear on save.
  const shown = correctHireBodyFrom(form, hire, nowIso, { managerOn: manager.on, accidentAt }).warnings ?? {};

  const submit = () => {
    const r = correctHireBodyFrom(form, hire, new Date().toISOString(), { managerOn: manager.on, accidentAt });
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    correct.mutate(
      { hireId: hire.id, body: r.relaxed ? withRelaxed(r.body, r.relaxed) : r.body },
      {
        onSuccess: (res) => {
          const ledgerWarn = res.ledger.action === 'invoiced' || res.ledger.action === 'review';
          toast.success(!ledgerWarn && res.changed ? `${correctionToast(hire.agreementNumber, res)} ${res.ledger.message}.` : correctionToast(hire.agreementNumber, res));
          if (ledgerWarn) toast.warn(res.ledger.message);
          if (res.warnings?.length) toast.warn(res.warnings.join(' '));
          onClose();
        }
      }
    );
  };

  return (
    <Modal
      open
      title={`Edit dates & rate — ${hire.agreementNumber}`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={correct.isPending} onClick={submit}>
            Save changes
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
        <div className="form-grid">
          <DateTimeInput label="Hire started" required value={form.startAt} onChange={(v) => set('startAt', v)} error={errors.startAt} warning={shown.startAt} hint="Back-dating is fine — the change is recorded with your reason." />
          <div>
            <DateTimeInput label="Hire ended" value={form.endAt} onChange={(v) => set('endAt', v)} error={errors.endAt} warning={shown.endAt} hint="Blank = still running." />
            {form.endAt && (
              <Button size="sm" variant="ghost" onClick={() => setForm((f) => ({ ...f, endAt: '', endTrigger: '' }))}>
                Still running (clear the end)
              </Button>
            )}
          </div>
          {form.endAt && (
            <Select<HireEndTrigger>
              label="What ended it"
              required
              className="span-2"
              value={form.endTrigger}
              onChange={(v) => set('endTrigger', v)}
              options={HIRE_TRIGGERS.map((t) => ({ value: t.value, label: t.label }))}
              placeholder="Choose what ended the hire…"
              error={errors.endTrigger}
            />
          )}
          <MoneyInput label="Agreed daily rate (£, ex VAT)" required value={form.dailyRatePence} onChange={(v) => set('dailyRatePence', v)} error={errors.dailyRatePence} />
          <div />
          <Select label="Car we give — GTA group" required value={form.gtaGroup} onChange={(v) => set('gtaGroup', v)} options={groups} error={errors.gtaGroup} />
          <Select label="Client's car — GTA group" value={form.clientGtaGroup} onChange={(v) => set('clientGtaGroup', v)} options={groups} placeholder="No group" error={errors.clientGtaGroup} hint="Like-for-like guide on the card and the charges" />
        </div>
        <TextArea label="Reason (required)" required value={form.reason} onChange={(v) => set('reason', v)} rows={2} error={errors.reason} placeholder="e.g. agent forgot to upload the hire on time" />
        <Checkbox label="Update the claimed hire amount on the ledger" checked={form.updateLedger} onChange={(v) => set('updateLedger', v)} hint="A new ledger row replaces the claimed amount; invoiced or paid rows are never changed." />
        <div className="notice notice-info hire-preview" aria-live="polite">
          {preview.text}
        </div>
        {errors.form && (
          <div className="notice notice-warn" role="alert">
            {errors.form}
          </div>
        )}
        <ApiErrorNotice error={correct.error} what="save the hire changes" />
      </form>
    </Modal>
  );
}
