import { useEffect, useState } from 'react';
import { isApiError } from '../../api/client';
import { useCreateFleetUnit } from '../../api/hooks';
import { Button } from '../../components/Button';
import { Checkbox, DateInput, Field, MoneyInput, Select, TextInput } from '../../components/Form';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { buildUnitBody, emptyUnitForm, FLEET_USES, FLEET_USE_LABEL, unitToForm, UNIT_STATUSES, UNIT_STATUS_LABEL, validateUnitForm, type FleetUnitView, type UnitForm, type UnitFormErrors } from './fleet';
import { useUpdateFleetUnit } from './fleetApi';
import type { FleetUnit } from '@ccguk/domain';

/** Add / edit a fleet unit. Pounds in the rate box, pence over the wire. */
export function UnitDialog({ open, unit, onClose }: { open: boolean; unit: FleetUnitView | null; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateFleetUnit();
  const update = useUpdateFleetUnit();
  const isNew = !unit;
  const [form, setForm] = useState<UnitForm>(() => (unit ? unitToForm(unit) : emptyUnitForm()));
  const [errors, setErrors] = useState<UnitFormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(unit ? unitToForm(unit) : emptyUnitForm());
      setErrors({});
      setServerError(null);
    }
  }, [open, unit]);

  const set = <K extends keyof UnitForm>(k: K) => (v: UnitForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggleUse = (use: UnitForm['declaredUses'][number]) => (on: boolean) =>
    setForm((f) => ({ ...f, declaredUses: on ? [...new Set([...f.declaredUses, use])] : f.declaredUses.filter((u) => u !== use) }));

  const submit = async () => {
    const e = validateUnitForm(form, isNew);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setServerError(null);
    const body = buildUnitBody(form, isNew);
    try {
      if (unit) await update.mutateAsync({ id: unit.id, body });
      else await create.mutateAsync(body);
      toast.success(unit ? 'Unit updated' : 'Unit added to the fleet register');
      onClose();
    } catch (err) {
      setServerError(isApiError(err) ? `${err.code}: ${err.message}` : (err as Error).message);
    }
  };

  const busy = create.isPending || update.isPending;
  const bothUses = form.declaredUses.includes('credit_hire') && form.declaredUses.includes('self_drive');

  return (
    <Modal open={open} onClose={onClose} title={unit ? `Edit unit ${form.registration}` : 'Add fleet unit'} size="lg" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} loading={busy}>{unit ? 'Save changes' : 'Add unit'}</Button></>}>
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
          <TextInput label="Registration" value={form.registration} onChange={set('registration')} inputClassName="input-reg" placeholder="AB12 CDE" required={isNew} disabled={!isNew} error={errors.registration} hint={isNew ? 'A fleet registration can never be a client vehicle on a claim (lessons f, h).' : 'Registration is fixed once the unit exists.'} autoCapitalize="characters" autoFocus={isNew} />
          <TextInput label="GTA group" value={form.gtaGroup} onChange={set('gtaGroup')} placeholder="S1, M, M1, CP1…" required error={errors.gtaGroup} hint="Industry benchmark group (CCGUK is not a GTA subscriber)." autoCapitalize="characters" />
          <TextInput label="Make" value={form.make} onChange={set('make')} placeholder="Volkswagen" />
          <TextInput label="Model" value={form.model} onChange={set('model')} placeholder="Golf" />
          <MoneyInput label="Daily rate (ex VAT)" value={form.dailyRatePence} onChange={set('dailyRatePence')} required error={errors.dailyRatePence} hint="e.g. 49.80 for a Golf; the ledger holds pence." />
          <Select<FleetUnit['status']> label="Status" value={form.status} onChange={(v) => v && set('status')(v)} options={UNIT_STATUSES.map((s) => ({ value: s, label: UNIT_STATUS_LABEL[s] }))} />
          <div className="span-2">
            <Field label="Declared class of use" required error={errors.declaredUses} hint="Each unit's declared use must sit inside its policy cover. Collingwood will not cover credit hire and self-drive together (BLUEPRINT §3.12).">
              <div className="check-grid">
                {FLEET_USES.map((u) => (
                  <Checkbox key={u} label={FLEET_USE_LABEL[u]} checked={form.declaredUses.includes(u)} onChange={toggleUse(u)} />
                ))}
              </div>
            </Field>
          </div>
          <TextInput label="Policy id / reference" value={form.policyId} onChange={set('policyId')} error={errors.policyId} hint={bothUses ? 'Two uses declared: the policy must cover both.' : 'Fleet policy covering the declared uses.'} />
          <Checkbox label="PHV / PCO licensed" checked={form.phvLicensed} onChange={set('phvLicensed')} hint="Required for PCO use (TfL PHV licence)." />
          <DateInput label="MOT expiry" value={form.motExpiryDate} onChange={set('motExpiryDate')} />
          <DateInput label="Tax due" value={form.taxDueDate} onChange={set('taxDueDate')} />
          <DateInput label="Service due" value={form.serviceDueDate} onChange={set('serviceDueDate')} />
        </div>
        <fieldset className="fieldset">
          <legend>Keeper address on the V5C</legend>
          <p className="basis">PCNs and NIPs go to the V5C address. RENTX's CCJs arose from tickets posted to an old address (lesson l) — keep this current and tick the box only when the V5C shows the live address.</p>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <TextInput label="Address line 1" value={form.keeperLine1} onChange={set('keeperLine1')} />
            <TextInput label="Address line 2" value={form.keeperLine2} onChange={set('keeperLine2')} />
            <TextInput label="Town" value={form.keeperTown} onChange={set('keeperTown')} />
            <TextInput label="Postcode" value={form.keeperPostcode} onChange={set('keeperPostcode')} error={errors.keeperPostcode} autoCapitalize="characters" />
            <div className="span-2">
              <Checkbox label="The V5C shows the current registered-keeper address" checked={form.keeperAddressCurrent} onChange={set('keeperAddressCurrent')} hint="Untick to raise a KEEPER_ADDRESS_STALE alert until the V5C is updated with DVLA." />
            </div>
          </div>
        </fieldset>
        <button type="submit" className="sr-only" tabIndex={-1}>
          Save
        </button>
      </form>
    </Modal>
  );
}
