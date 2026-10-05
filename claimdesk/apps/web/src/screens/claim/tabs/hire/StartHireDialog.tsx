/**
 * Start hire (docs/V03-MANAGER-MODE-HIRE-PRICING.md E10, §B.1, §C.1): fleet car → class of use → hire started (any
 * past date; an end too when the hire is already over) → pricing guide → agreed daily rate with one-click chips.
 * Handover and paperwork sit in closed sections. In manager mode on-hire and off-road cars can be chosen and an end
 * before the start is a warning; the server records each override.
 */
import { useState } from 'react';
import { useStableCallback } from './useStableCallback';
import type { FleetUse, HireEndTrigger } from '@ccguk/domain';
import { withRelaxed } from '../../../../api/client';
import { useFleet } from '../../../../api/hooks';
import { useCreateHire, useHirePricingGuide } from '../../../../api/hireApi';
import { useManagerMode } from '../../../../app/managerMode';
import { ApiErrorNotice } from '../../../../components/ApiErrorNotice';
import { Button } from '../../../../components/Button';
import { Checkbox, DateTimeInput, MoneyInput, Select, TextArea, TextInput } from '../../../../components/Form';
import { Modal } from '../../../../components/Modal';
import { useToast } from '../../../../components/Toast';
import type { ClaimView } from '../../claimFile';
import { EvidencePicker } from '../../components/EvidencePicker';
import { emptyStartHireForm, HIRE_TRIGGERS, paperworkSignedNow, pickFleetUnit, startHireBodyFrom, USE_OPTIONS, type StartHireForm } from '../../lib/hire';
import { fleetOptions, pricingChips, unitRegistration } from '../../lib/hirePricing';
import { PricingGuidePanel } from './PricingGuidePanel';

const HANDOVER_KEYS = ['excessPence', 'excessWaiverDailyPence', 'deliveredAt', 'odometerOut'];
const PAPERWORK_KEYS = ['signedAt', 'cancellationInfoProvidedAt', 'schedule3FormProvidedAt', 'expressRequestToStartAt', 'needStatementEvidenceId'];

export function StartHireDialog({ claimId, view, open, nowIso, onClose }: { claimId: string; view: ClaimView; open: boolean; nowIso: string; onClose: () => void }) {
  const fleet = useFleet();
  const create = useCreateHire(claimId);
  const toast = useToast();
  const manager = useManagerMode();
  const [form, setForm] = useState<StartHireForm>(() => emptyStartHireForm(nowIso));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [paperworkOpen, setPaperworkOpen] = useState(false);
  const units = fleet.data ?? [];
  const unit = units.find((u) => u.id === form.fleetUnitId);
  const guide = useHirePricingGuide(claimId, { fleetUnitId: form.fleetUnitId || undefined, startAt: form.startAt || undefined, clientGroup: form.clientGtaGroup || undefined });
  const chips = form.fleetUnitId ? pricingChips(guide.data?.fleetUnit.id === form.fleetUnitId ? guide.data.suggestions : unit ? [{ id: 'fleet', label: 'Fleet rate', dailyRatePence: unit.dailyRatePence }] : []) : [];
  const set = <K extends keyof StartHireForm>(key: K, value: StartHireForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const trigger = HIRE_TRIGGERS.find((t) => t.value === form.endTrigger);

  const close = useStableCallback(() => {
    setForm(emptyStartHireForm(new Date().toISOString()));
    setErrors({});
    setHandoverOpen(false);
    setPaperworkOpen(false);
    create.reset();
    onClose();
  });

  const checkOpts = { managerOn: manager.on, accidentAt: view.claim.accident?.occurredAt };
  // Amber warnings show while filling in (never blocking); red errors appear on Start hire.
  const warnings = startHireBodyFrom(form, unit, new Date().toISOString(), checkOpts).warnings ?? {};

  const submit = () => {
    const r = startHireBodyFrom(form, unit, new Date().toISOString(), checkOpts);
    if (!r.ok) {
      setErrors(r.errors);
      if (HANDOVER_KEYS.some((k) => r.errors[k])) setHandoverOpen(true);
      if (PAPERWORK_KEYS.some((k) => r.errors[k])) setPaperworkOpen(true);
      return;
    }
    setErrors({});
    create.mutate(r.relaxed ? withRelaxed(r.body, r.relaxed) : r.body, {
      onSuccess: (res) => {
        const reg = unit ? unitRegistration(unit) : 'the car';
        toast.success(`Hire ${res.hire.agreementNumber} started on ${reg}${res.hire.endAt ? ' and ended' : ''}. Clocks recalculated.`);
        if (res.warnings?.length) toast.warn(res.warnings.join(' '));
        close();
      }
    });
  };

  return (
    <Modal
      open={open}
      title="Start hire"
      size="lg"
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} onClick={submit}>
            Start hire
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
        <ApiErrorNotice error={fleet.error} what="load the fleet" />
        <div className="form-grid">
          <Select
            label="Fleet car"
            required
            className="span-2"
            value={form.fleetUnitId}
            onChange={(id) => setForm((f) => pickFleetUnit(f, units.find((u) => u.id === id)))}
            options={fleetOptions(units, manager.on)}
            placeholder={fleet.isLoading ? 'Loading fleet…' : 'Choose a car'}
            error={errors.fleetUnitId}
            warning={warnings.fleetUnitId}
            hint={manager.on ? 'Manager mode: cars off road can be chosen.' : 'Cars off road are greyed out. A car on hire now can take an earlier hire; the dates are checked when you save.'}
            autoFocus
          />
          <Select<FleetUse>
            label="Class of use"
            required
            className="span-2"
            value={form.use}
            onChange={(v) => v && set('use', v)}
            options={USE_OPTIONS}
            hint={unit && !unit.declaredUses.includes(form.use) ? 'This car is not declared for that use — the policy may not cover it.' : 'Must match the car’s declared use and policy cover'}
          />
          <DateTimeInput label="Hire started" required value={form.startAt} onChange={(v) => set('startAt', v)} error={errors.startAt} warning={warnings.startAt} hint="Past dates are fine — late entries are recorded as such." />
          <DateTimeInput label="Hire ended (only if it has already ended)" value={form.endAt} onChange={(v) => set('endAt', v)} error={errors.endAt} warning={warnings.endAt} hint="Leave blank while the hire is running." />
          {form.endAt && (
            <>
              <Select<HireEndTrigger>
                label="What ended it"
                required
                value={form.endTrigger}
                onChange={(v) => set('endTrigger', v)}
                options={HIRE_TRIGGERS.map((t) => ({ value: t.value, label: t.label }))}
                placeholder="Choose what ended the hire…"
                error={errors.endTrigger}
                hint={trigger?.basis}
              />
              <TextInput label={form.endTrigger === 'manual' ? 'Reason (required)' : 'Note (optional)'} value={form.endReason} onChange={(v) => set('endReason', v)} error={errors.endReason} required={form.endTrigger === 'manual'} />
            </>
          )}
        </div>

        {form.fleetUnitId && <PricingGuidePanel claimId={claimId} guide={guide} onClientGroup={(g) => set('clientGtaGroup', g)} />}

        <div>
          <MoneyInput label="Agreed daily rate (£, ex VAT)" required value={form.dailyRatePence} onChange={(v) => set('dailyRatePence', v)} error={errors.dailyRatePence} hint={form.fleetUnitId ? undefined : 'Choose a car first: the fleet rate is filled in for you.'} />
          {chips.length > 0 && (
            <div className="rate-chips" role="group" aria-label="Fill the agreed rate">
              {chips.map((c) => (
                <button key={c.id} type="button" className="rate-chip" aria-pressed={form.dailyRatePence === c.dailyRatePence} onClick={() => set('dailyRatePence', c.dailyRatePence)}>
                  {c.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <details className="hire-section" open={handoverOpen} onToggle={(e) => setHandoverOpen(e.currentTarget.open)}>
          <summary>Handover (optional)</summary>
          <div className="form-grid">
            <MoneyInput label="Excess (£)" value={form.excessPence} onChange={(v) => set('excessPence', v)} />
            <MoneyInput label="Excess waiver (£/day)" value={form.excessWaiverDailyPence} onChange={(v) => set('excessWaiverDailyPence', v)} />
            <DateTimeInput label="Delivered at" value={form.deliveredAt} onChange={(v) => set('deliveredAt', v)} />
            <TextInput label="Odometer out (miles)" value={form.odometerOut} onChange={(v) => set('odometerOut', v)} inputMode="numeric" error={errors.odometerOut} />
          </div>
        </details>

        <details className="hire-section" open={paperworkOpen} onToggle={(e) => setPaperworkOpen(e.currentTarget.open)}>
          <summary>Paperwork — can be added later</summary>
          <div className="stack">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Button size="sm" onClick={() => setForm((f) => paperworkSignedNow(f, new Date().toISOString()))}>
                Paperwork signed now
              </Button>
              <span className="xs muted">Stamps the cancellation information, cancellation form, request to start and signature with the hire start.</span>
            </div>
            <div className="form-grid">
              <DateTimeInput label="Cancellation information given" value={form.cancellationInfoProvidedAt} onChange={(v) => set('cancellationInfoProvidedAt', v)} />
              <DateTimeInput label="Cancellation form given" value={form.schedule3FormProvidedAt} onChange={(v) => set('schedule3FormProvidedAt', v)} />
              <DateTimeInput label="Client asked to start straight away" value={form.expressRequestToStartAt} onChange={(v) => set('expressRequestToStartAt', v)} />
              <DateTimeInput label="Agreement signed at" value={form.signedAt} onChange={(v) => set('signedAt', v)} />
              <div className="span-2">
                <Checkbox label="Exempt credit: 12 or fewer payments within 12 months, no interest or charges" checked={form.cca60fCompliant} onChange={(v) => set('cca60fCompliant', v)} />
              </div>
            </div>
            <EvidencePicker label="Statement of need (signed)" single evidence={view.evidence} value={form.needStatementEvidenceId ? [form.needStatementEvidenceId] : []} onChange={(ids) => set('needStatementEvidenceId', ids[0] ?? '')} />
            <p className="xs muted" style={{ margin: 0 }} title="Consumer Contracts Regulations 2013 Sch 2, Sch 3 and reg 36; CCA 1974 / RAO art 60F (W v Veolia; Dimond v Lovell)">
              Anything missing is flagged on the claim so it can be added later. <span aria-hidden="true">ⓘ</span>
            </p>
          </div>
        </details>

        <ApiErrorNotice error={create.error} what="start the hire" />
      </form>
    </Modal>
  );
}
